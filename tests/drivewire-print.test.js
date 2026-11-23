// DriveWire printing: whose printout is it? The server's Print ($50) / Print Flush ($46) transactions (the
// DriveWire 4 specification, "Printing") deliver bytes to the printout, and the printout belongs to the
// machine that printed (a machine's `printed`, js/machines/machine.js), whichever machine is on screen.
// Two machines run at once while a Claude chat is open in full screen (startChat: the BASIC session beside
// the chat machine), and each has its own DriveWire server (the BASIC session the Session's, the chat
// machine chatServer), so a print over either must land on the machine whose port sent it - and the BASIC
// session's printout must survive the chat ending (endChat).
// (A stub CoCo's start prints nothing to its own serial printer: the stub puts PA1 at mark before it makes it an
// output, tests/stub-printer.test.js. So every byte in a printout here is one a print sent.)
// Run: node tests/drivewire-print.test.js
const fs = require('fs'), path = require('path');
const Emu = require('./load')();

let fail = 0, n = 0;
const check = (name, cond, detail = '') => { n++; if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name} ${detail}`); };

const FIRMWARE = new Uint8Array(fs.readFileSync(path.join(__dirname, '../examples/chat.bin')));
const KEY = 'sk-ant-DW-PRINT-TEST-KEY-0123456789';
// a print transaction through the Becker port ($FF42): PRINT ($50) each byte, then PRINT Flush ($46)
const dwPrint = (m, bytes) => { for (const b of bytes) { m.write(0xFF42, 0x50); m.write(0xFF42, b); } m.write(0xFF42, 0x46); };
// what the machine's own port printed (the stub's start adds nothing: see the note above)
const dwPrinted = (m) => m.printed.slice();

// a chat over DriveWire on a CoCo with the Becker port: the BASIC session and the chat machine, both live,
// the chat machine on screen. No frames run, so the chat firmware never touches its port: only the print
// transactions below cross either server.
function openChat() {
  const s = new Emu.Session({ store: Emu.memoryStore() });
  s.switchMachine('coco', { becker: true });
  const basic = s.shownMachine;
  check('the BASIC session has the Session\'s DriveWire server', !!basic.becker && basic.becker.server === s.drivewire);
  s.setClaudeKey(KEY);
  const backend = new Emu.ClaudeBackend({ fetch: async () => null, apiKey: KEY });
  s.startChat({ backend, firmware: FIRMWARE, drivewire: true });
  return { s, basic, chat: s.shownMachine };
}

(async () => {
  // ---- the BASIC session prints while the chat machine is shown ----
  {
    const { s, basic, chat } = openChat();
    check('the chat machine is shown, with its own server', chat !== basic && chat.becker.server === s.chatServer && s.chatServer !== s.drivewire);
    dwPrint(basic, [0x41, 0x0D]);   // 'A', CR
    check('the BASIC session\'s DriveWire print is in ITS printout',
      dwPrinted(basic).length === 2 && dwPrinted(basic)[0] === 0x41 && dwPrinted(basic)[1] === 0x0D, JSON.stringify([...basic.printed]));
    check('the chat machine (the one shown) received nothing new', dwPrinted(chat).length === 0, JSON.stringify([...chat.printed]));
    s.endChat();
    check('endChat: the BASIC session is back on screen', s.shownMachine === basic);
    check('the printout survives the chat ending', s.printoutText() === 'A\n', JSON.stringify(s.printoutText()));
  }
  // ---- the chat machine prints over its own server, whichever machine is shown ----
  {
    const { s, basic, chat } = openChat();
    dwPrint(chat, [0x42]);          // 'B'
    check('the chat machine\'s DriveWire print is in ITS printout',
      dwPrinted(chat).length === 1 && dwPrinted(chat)[0] === 0x42, JSON.stringify([...chat.printed]));
    check('the BASIC session received nothing', dwPrinted(basic).length === 0, JSON.stringify([...basic.printed]));
    s.showChat('basic');            // the BASIC session on screen, the chat machine off it
    dwPrint(chat, [0x43]);          // 'C'
    check('off screen, the chat machine\'s print still goes to ITS printout',
      dwPrinted(chat).length === 2 && dwPrinted(chat)[1] === 0x43, JSON.stringify([...chat.printed]));
    s.endChat();
  }
  // ---- the machine in use prints to its own printout, as before ----
  {
    const s = new Emu.Session({ store: Emu.memoryStore() });
    s.switchMachine('coco', { becker: true });
    dwPrint(s.shownMachine, [0x44, 0x0D]);   // 'D', CR
    check('the shown machine\'s own print is in its printout', s.printoutText() === 'D\n', JSON.stringify(s.printoutText()));
  }
  // ---- a stray $00 after the printed bytes is a real byte and shows ----
  {
    const { s, basic, chat } = openChat();
    dwPrint(chat, [0x42]);          // 'B'
    chat.printed.push(0);           // (a bug that dropped a byte to the serial printer instead of DriveWire)
    check('a stray $00 after the DriveWire bytes shows in the chat machine\'s printout',
      dwPrinted(chat).length === 2 && dwPrinted(chat)[0] === 0x42 && dwPrinted(chat)[1] === 0, JSON.stringify([...chat.printed]));
    s.endChat();
  }
  // ---- the Session's server keeps no machine the Session has let go of (a leak: its handler held the BASIC
  // machine after a switch away from a chat; dropChat had cleared chatMachines, so install saw only the chat
  // machine, whose server is the chat's own) ----
  {
    const { s, basic, chat } = openChat();
    check('while the chat is up, the Session server prints to the BASIC session', s.drivewire.onPrint !== null);
    s.switchMachine('dragon64');
    check('after switching away, the Session server holds no print handler',
      s.drivewire.onPrint === null, s.drivewire.onPrint && 'still bound');
    s.drivewire.receive(0x50); s.drivewire.receive(0x41); s.drivewire.receive(0x46);   // 'A', flushed
    check('a print through the server reaches no machine the Session has let go of',
      basic.printed.length === 0 && !s.shownMachine.printed.includes(0x41) && chat.printed.length === 0,
      JSON.stringify({ gone: [...basic.printed], shown: [...s.shownMachine.printed], chat: [...chat.printed] }));
    // and a machine with the port that comes back takes the server and its prints again
    s.switchMachine('coco', { becker: true });
    dwPrint(s.shownMachine, [0x45]);      // 'E'
    check('a Becker machine switched to prints to its own printout', s.printoutText() === 'E', JSON.stringify(s.printoutText()));
  }
  // ---- an off-screen print fires the 'printer' event, exactly once (checkPrinter watches the chat machines
  // too, not only the one shown). The chat machine's stub start printed nothing, so the first flush reports only
  // the off-screen print.
  {
    const { s, basic, chat } = openChat();
    let events = 0;
    s.on((ev) => { if (ev === 'printer') events++; });
    dwPrint(basic, [0x46]);         // 'F': this flush reports it
    const settled = events;
    check('the first flush reports what changed (the off-screen print; the chat machine\'s stub start printed nothing)', settled === 1, `${settled} events`);
    dwPrint(chat, [0x47]);           // 'G', the chat machine shown
    check('a print of the shown machine fires it once', events === settled + 1, `${events - settled} events`);
    dwPrint(basic, [0x48]);         // 'H' off screen
    check('an off-screen print fires it once, not zero and not two', events === settled + 2, `${events - settled} events`);
    s.endChat();
  }
  // ---- showing the other chat machine neither fires a spurious printer event nor misses one: the baseline
  // follows the machine (install re-baselines it), so only a CHANGE after the show is reported. checkPrinter
  // runs here on purpose: a baseline that ignored the machine's prints would report them again as a change.
  {
    const { s, basic, chat } = openChat();
    dwPrint(basic, [0x49]);         // 'I' while the chat machine is shown (fires one event, swallowed here)
    let events = 0;
    s.on((ev) => { if (ev === 'printer') events++; });
    s.showChat('basic');             // the machine with the off-screen print comes on screen
    s.checkPrinter();
    check('showing a machine with unreported prints fires no event for them again', events === 0, `${events} events`);
    dwPrint(basic, [0x4A]);         // 'J'
    check('a print after the show is reported once', events === 1, `${events} events`);
    check('the printout is the whole printout, off-screen print included', s.printoutText() === 'IJ', JSON.stringify(s.printoutText()));
    s.endChat();
  }

  // ---- a chat without DriveWire on a machine that has the Becker port: the chat machine must not carry a
  // port it does not use. The mailbox carries its bytes; a becker there would attach the Session's server,
  // and the BASIC session's prints would land in the chat machine's printout (they share one server).
  {
    const s = new Emu.Session({ store: Emu.memoryStore() });
    s.switchMachine('coco', { becker: true });
    const basic = s.shownMachine;
    s.setClaudeKey(KEY);
    s.startChat({ backend: new Emu.ClaudeBackend({ fetch: async () => null, apiKey: KEY }), firmware: FIRMWARE,
      channel: new Emu.MemoryChannel(), drivewire: false });
    const chat = s.shownMachine;
    check('a chat without DriveWire runs on a machine with no Becker port', chat.becker === null, chat.becker && 'a Becker port');
    dwPrint(basic, [0x4B]);         // 'K': the BASIC session prints over its own port
    check('the BASIC session\'s print is in ITS printout', dwPrinted(basic).length === 1 && dwPrinted(basic)[0] === 0x4B,
      JSON.stringify([...basic.printed]));
    check('the chat machine received nothing', dwPrinted(chat).length === 0, JSON.stringify([...chat.printed]));
    s.endChat();
    check('after the chat, the BASIC session prints as before', (() => { dwPrint(basic, [0x4C]); return s.printoutText() === 'KL'; })(),
      JSON.stringify(s.printoutText()));
  }

  console.log(fail ? `${fail} FAILED (of ${n})` : `${n}/${n} DriveWire print checks passed`);
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.log('FAIL', e.stack); process.exitCode = 1; });
