// Run: node tests/embed-person-machine.test.js
//
// The embed API acts on the PERSON's machine, never the one on screen, and the ROM guard is asked about that same
// machine.
//
// Why it matters: with the Claude chat full screen the shown machine is the chat machine, and the embed API used to
// reach it. The hotfix removed the chat from embeds, so this is now the second lock rather than the first - but the two
// machines still exist on a page that has a chat (the side panel), and a method that names `shownMachine` is one step
// from acting on the wrong machine whenever a chat is open.
//
// RED-FIRST against the merged tree before the fix: every method below reads `shownMachine`, and `romCodeIn` asks the
// shown machine, so each row fails.
const path = require('path');
let fail = 0, n = 0;
const check = (name, cond, detail = '') => { n++; if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log('ok   ', name, detail); };

const ROOT = path.join(__dirname, '..');
const { EmbedApi } = require(path.join(ROOT, 'js/embed-api.js'));

// a Session stand-in with two machines, the way it has them with a chat open; each records what is done to it
function machine(label, opts = {}) {
  const log = [];
  return {
    label, log, frameCount: 0, id: label, profile: { name: label, options: {} }, config: {}, hasRom: false,
    romCrcs() { return opts.roms ? { a: 1 } : {}; },
    get cartPort() { return opts.cart ? {} : null; },
    peek(a) { log.push(['peek', a]); return 7; },
    poke(a, v) { log.push(['poke', a, v]); },
    typist: { typePaced(t) { log.push(['type', t]); }, holdPaced(k) { log.push(['key', k]); } },
  };
}
function sessionWith({ chatOpen = true, personRoms = false, shownRoms = false, personCart = false } = {}) {
  const person = machine('person', { roms: personRoms, cart: personCart });
  const shown = machine('shown', { roms: shownRoms });
  const s = {
    on() { return () => {}; },
    get shownMachine() { return chatOpen ? shown : person; },
    get personMachine() { return person; },
    chatMachines: chatOpen ? { chat: shown, basic: person } : null,
    nitros9On: () => false,
    // the real one asks the machine given, or the shown machine when given none
    romCodeIn(m) { const t = m || this.shownMachine; return Object.keys(t.romCrcs()).length ? 'roms' : (t.cartPort ? 'cartridge' : null); },
    personInput() {},
    typeText(text, m) { (m || this.shownMachine).typist.typePaced(text); },
    peek(addr, m) { return (m || this.shownMachine).peek(addr); },
    poke(addr, b, m) { (m || this.shownMachine).poke(addr, b); },
    screenText(m) { const t = m || this.shownMachine; t.log.push(['screenText']); return [t.label]; },
    reset() { this.shownMachine.log.push(['reset']); },   // Session.reset() is the shown machine by design
    powerCycle({ on = null } = {}) { (on || this.personMachine).log.push(['powerCycle']); },
    switchMachine() {}, savedConfig() { return {}; }, load() { return 'x'; }, insertTape() { return 'x'; }, loadBasic() { return {}; },
    setDisplay() { return {}; },
  };
  return { s, person, shown };
}

(async () => {
  const rows = [];
  const both = (label, run) => {
    const { s, person, shown } = sessionWith({ chatOpen: true });
    const api = new EmbedApi(s, () => {});
    run(api);
    const onPerson = person.log.length > 0, onShown = shown.log.length > 0;
    check(`${label}: acts on the person's machine`, onPerson, JSON.stringify({ person: person.log, shown: shown.log }));
    check(`${label}: never touches the chat machine on screen`, !onShown, JSON.stringify(shown.log));
  };

  both('peek', (api) => api.peek(0x1000, 2));
  both('poke', (api) => api.poke(0x2000, [1]));
  both('type', (api) => api.type('hi\n'));
  both('screenText', (api) => api.screenText());
  both('powerCycle', (api) => api.powerCycle());

  // (c) the ROM guard asks the PERSON's machine
  {
    const { s, person, shown } = sessionWith({ chatOpen: true, personRoms: true, shownRoms: false });
    const api = new EmbedApi(s, () => {});
    let threw = null;
    try { api.peek(0x1000, 2); } catch (e) { threw = e.message; }
    check('peek refuses when the PERSON\'S machine runs ROMs, though the chat machine on screen has none',
      !!threw && /not available while/.test(threw), `threw=${JSON.stringify(threw)}`);
    check('and it refused without reading the chat machine', shown.log.length === 0, JSON.stringify(shown.log));
  }
  {
    const { s, person, shown } = sessionWith({ chatOpen: true, personRoms: false, shownRoms: true });
    const api = new EmbedApi(s, () => {});
    let threw = null;
    try { api.peek(0x1000, 2); } catch (e) { threw = e.message; }
    check('peek is NOT refused for the chat machine\'s ROMs (the guard asks the person\'s only)', threw === null, String(threw));
    check('and it read the person\'s machine', person.log.length > 0 && shown.log.length === 0,
      JSON.stringify({ person: person.log, shown: shown.log }));
  }

  console.log(fail ? `\n${fail} FAILED` : '\nall embed-person-machine checks passed');
  process.exitCode = fail ? 1 : 0;
})();
