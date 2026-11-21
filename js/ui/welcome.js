/*
 * First visit and returning visitors.
 *  - First visit with no ROMs: the page opens on the welcome program (examples/welcome.asm) running on the
 *    stub, never an empty screen, with a strip of programs that run without ROMs (our own only) and the machine
 *    question, asked once and then remembered. Adding ROMs is the header's "No BASIC · Add ROMs" and the menu's
 *    key 3. The welcome program's
 *    keys arrive as Session events: 1 runs LIZA, 2 the colour demo, 3 shows the ROM
 *    sockets, 4 the Claude chat, 5 PLAY A GAME, a games menu (NEW GAMES FOR AN OLD
 *    MACHINE: 2048, Minesweeper; 6809 machines). From the demo, "Back to
 *    the menu" returns; BREAK leaves a game. No DOM keys are read here: the machine gets every key (Esc is its BREAK).
 *  - Returning: without ROMs every visit boots the welcome menu, which
 *    says "WELCOME BACK" and, when something ran last time, offers it as its last option ("CARRY ON WITH LIZA"); with
 *    ROMs the machine boots BASIC as before. Either way the Media tab's "Last time" offers "Run again", and the
 *    welcome menu is the first of "Runs without ROMs". No separate welcome-back card.
 *  - Leaving a program goes back to the menu ("BYE FOR NOW. PICK ANOTHER?"): BYE in LIZA, BREAK in a game, a key
 *    once the colour demo is drawing (the Session watches and emits 'menu').
 *  - Without ROMs the machine is never left on the stub's bare screen: Switch off
 *    and on, "Run without ROMs" and "Remove ROMs" turn it on into the welcome menu ("WELCOME BACK", the Session
 *    emits ('menu', 'back')); Reset restarts what was running (the menu, LIZA, a binary), or the menu.
 *  - Sound: browsers only allow it after a click or key press, so a hint shows until then; the welcome
 *    program's tune plays once it is unlocked.
 */
import { $, ESC } from './page.js';
import { profiles } from '../machines/profiles.js';
import { cpuFamily } from '../cpu/cpus.js';
import { gameKey } from '../session.js';
import { buildUrl } from '../config.js';

// Programs that run without ROMs: our own only. Third-party homebrew is not bundled: the stub provides only
// POLCAT and CHROUT, so most homebrew (which calls other ROM routines) wouldn't run, and anything listed here
// is redistributed by the project, wherever CLOADM is hosted. A title
// could join only with its author's written permission, recorded in CREDITS.md, and only if it runs on the
// stub. The Claude chat terminal joins when it lands.
// LIZA is one entry for every machine: the Session picks the 6809 or 6803 build by CPU and, on a 4K
// MC-10 or Alice, offers the 20K switch the 6803 build needs. `cpu` is an instruction-set family: the 6309
// runs the 6809 build, so the demo is offered on it too.
export const SHELF = [
  { name: 'LIZA', liza: true, title: 'An ELIZA-style conversation program' },
  { name: 'Colour demo', url: 'examples/demo.bin', cpu: '6809', title: 'Graphics and colour demo' },
  { name: '2048', game: '2048', cpu: '6809', title: '2048: slide and join the tiles (arrows; BREAK leaves)' },
  { name: 'Minesweeper', game: 'minesweeper', cpu: '6809', title: 'Minesweeper: find the ten mines (arrows, SPACE, F; BREAK leaves)' },
];
const gameItem = (key) => SHELF.find((x) => x.game === key);
// the machine question: one button per family people are likely to have had
const ASK = [['dragon64', 'Dragon 32 / 64'], ['coco', 'CoCo 1 / 2'], ['coco3', 'CoCo 3'], ['mc10', 'MC-10']];
const el = (tag, text, cls) => { const e = document.createElement(tag); if (text != null) e.textContent = text; if (cls) e.className = cls; return e; };

export function setupWelcome(page, { showRoms, openClaude }) {
  const { session, audio } = page;
  const box = $('welcome');
  const back = $('btnWelcomeBack');   // shown while the colour demo started from the menu runs
  const showBack = (on) => { back.hidden = !on; };
  back.onclick = () => { showBack(false); runWelcome(); };

  // greeting: 'first', 'back' or 'bye'; on a returning visit the menu offers what ran last as option 5
  // ifIdle: only if nothing else started while the menu's bytes were fetched (the Session asked for it, then a
  // program was loaded or a snapshot opened: that wins)
  // byMachine: the program on the machine asked for it (the 'welcome:*' events, 'menu' after LIZA's BYE or the
  // demo): the start itself runs in Session.asMachine, so keys Claude typed that asked for it do not stop Claude
  // (the fetch before it is outside: what the person does meanwhile still stops Claude)
  // (byMachine: the ticket the Session gave when the program asked, Session.machineTicket; null: the person asked)
  const startAs = (byMachine, fn) => (byMachine ? session.asMachine(fn, byMachine) : fn());
  async function runWelcome({ greeting = 'first', carryOn = null } = {}, { ifIdle = false, byMachine = null } = {}) {
    const m = session.personMachine, running = session.stubRun;
    try {
      const bytes = await page.fetchBytes(`examples/${session.welcomeFile}`);   // this machine's build (6809, or its own 6803 one)
      if (ifIdle && (session.personMachine !== m || !m.useStub || session.stubRun !== running || session.welcomeRunning)) return;
      startAs(byMachine, () => session.startWelcome(bytes, { greeting, carryOn: carryOn && carryOn.name }));   // (the menu says "PRESS 1 TO 4" itself: not repeated)
    } catch (e) { page.status(`Welcome: ${e.message}`, true); }
    page.focus();
    shelf();
    lastTime();
  }
  session.on(async (ev, arg) => {
    if (ev === 'machine' || ev === 'loaded') { showBack(false); lastTime(); return; }
    // (what the menu or a program asks for: byMachine, so a key Claude typed does not stop Claude)
    const asked = session.machineTicket();   // (taken now, when the program asks: whose keys they were)
    if (ev === 'welcome:liza') await run(SHELF[0], { byMachine: asked });
    else if (ev === 'welcome:demo') {
      await run(SHELF[1], { byMachine: asked });
      showBack(true);
      page.status('Colour demo: press a key to start it; another key goes back to the menu');
    } else if (ev === 'welcome:roms') showRoms();
    else if (ev === 'welcome:claude') await openClaude();
    else if (ev === 'welcome:carryon') await runAgain({ byMachine: asked });
    else if (ev === 'welcome:2048' || ev === 'welcome:minesweeper') await run(gameItem(ev.slice(8)), { byMachine: asked });
    // back from a program ('bye'), or the machine turned on, or reset with nothing to restart, without ROMs ('back')
    else if (ev === 'menu') { showBack(false); await runWelcome(arg === 'back' ? { greeting: 'back', carryOn: session.carryOn } : { greeting: 'bye' }, { ifIdle: true, byMachine: arg !== 'back' ? session.menuTicket || asked : null }); }
  });
  // what ran last, again: LIZA, the demo, or the file (from the recent list)
  async function runAgain({ byMachine = null } = {}) {
    const last = session.lastRun;
    if (!last) return;
    if (last.kind === 'liza') await run(SHELF[0], { byMachine });
    else if (last.kind === 'demo') await run(SHELF[1], { byMachine });
    else if (last.kind === 'game') await run(gameItem(gameKey(last.name)), { byMachine });
    else { page.attempt(() => startAs(byMachine, () => session.loadRecent(0))); page.focus(); }
  }
  // the Media tab's "Last time": the name (and the machine, for a file) and "Run again"
  function lastTime() {
    const last = session.lastRun, recent = session.recentMedia()[0];
    const file = last && last.kind === 'recent' ? recent : null;
    const shown = !!last && (last.kind !== 'recent' || (!!file && file.stored));
    $('lastTime').hidden = !shown;
    if (!shown) return;
    $('lastName').textContent = file ? `${file.name}${profiles[file.machine] ? ` · ${profiles[file.machine].name.replace(/^Tandy /, '')}` : ''}` : last.name;
  }
  $('btnRunAgain').onclick = () => runAgain();

  async function run(item, { byMachine = null } = {}) {
    // LIZA has a build per CPU; the Session chooses it and checks the RAM the 6803 build needs
    if (item.liza && session.lizaNeeds()) return offerLizaRam(item);
    try {
      // (the bytes first, then LIZA at once: the start is synchronous, so byMachine covers only it)
      if (item.liza) {
        session.checkLiza();
        const bytes = await page.fetchBytes(`examples/${session.lizaFile}`);
        page.status(startAs(byMachine, () => session.runLiza(bytes)));
      } else if (item.game) {
        session.checkGame(item.game);   // (another CPU, or under 32K: says so before fetching anything)
        const bytes = await page.fetchBytes(`examples/${session.gameFile(item.game)}`);
        startAs(byMachine, () => session.runGame(item.game, bytes));
        page.status(`${item.name}: press a key to start; BREAK (Esc) goes back to the menu`);
      } else {
        const bytes = await page.fetchBytes(item.url);
        page.status(startAs(byMachine, () => session.load(item.url.split('/').pop(), bytes, { remember: false })));
        session.setLastRun('demo', item.name);
        session.watchForMenu('demo');
      }
    } catch (e) { page.status(`${item.name}: ${e.message}`, true); }
    page.focus();
  }
  // the one-click switch: a card above the screen (the pattern of the other offers there), shown only
  // when the RAM option is what stands between a 4K MC-10 or Alice and LIZA. Taking it switches to 20K (the
  // machine restarts, as any RAM change does) and starts LIZA; "Not now" leaves the machine as it is.
  const offer = $('lizaOffer');
  function offerLizaRam(item) {
    const need = session.lizaNeeds(), name = session.personMachine.profile.name;
    $('lizaOfferText').textContent = `LIZA needs the ${need.ram}K RAM option. This ${name} has ${need.have}K.`;
    $('btnLizaRam').textContent = `Switch to ${need.ram}K and run LIZA`;
    $('btnLizaRam').onclick = async () => { offer.hidden = true; session.switchLiza(); await run(item); };
    offer.hidden = false;
    $('btnLizaRam').focus();
  }
  $('btnLizaRamCancel').onclick = () => { offer.hidden = true; page.focus(); };
  page.onEscape(ESC.card, () => !offer.hidden, () => $('btnLizaRamCancel').click());
  // "Runs without ROMs" in the drawer's Media tab: the welcome menu ("on screen now" while it
  // runs), the programs for this machine's CPU, and the Claude chat. Each one a link can start (the welcome menu,
  // LIZA, the games: ?start=; the chat: ?app=claude) is a real link to it on this machine, so "Copy link" gives the
  // direct link; a plain click runs it here, as a button would (a click with a modifier is left to the browser).
  const linkTo = (params) => buildUrl(location.href, Object.assign({ machine: session.personMachine.id, config: session.personMachine.config }, params));
  const entry = (text, params, onclick) => {
    if (!params) { const b = el('button', text); b.onclick = onclick; return b; }
    const a = el('a', text); a.href = linkTo(params);
    a.onclick = (e) => { if (e.button || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return; e.preventDefault(); onclick(); };
    return a;
  };
  function shelf() {
    const row = $('shelf');
    row.replaceChildren();
    // every machine gets the welcome menu and LIZA (the 6809 or 6803 builds); the colour demo is a 6809 program
    // (the 6309 runs it too: it is in the 6809 instruction-set family)
    const cpu = session.personMachine.config.cpu, family = cpuFamily(cpu), need = session.lizaNeeds();
    {
      const w = entry('Welcome menu', { start: 'welcome' }, () => runWelcome({ greeting: 'back', carryOn: session.carryOn })); w.dataset.shelf = 'welcome';
      w.title = 'The Welcome menu: LIZA, colour and sound, adding ROMs, Claude, games';
      if (session.welcomeRunning) { w.append(' ', el('span', 'on screen now', 'tag now')); w.setAttribute('aria-current', 'true'); }
      row.append(w);
    }
    for (const item of SHELF.filter((x) => !x.cpu || x.cpu === family)) {
      const b = entry(item.name, item.liza ? { start: 'liza' } : item.game ? { start: item.game } : null, () => run(item));
      // the LIZA title names the build the machine actually runs (the 6309 runs the 6809 build)
      b.title = item.liza ? `${item.title} (the ${family} build${need ? `; needs the ${need.ram}K RAM option` : ''})` : item.title;
      if (item.liza && need) { const t = el('span', `needs ${need.ram}K`, 'tag'); b.append(' ', t); b.dataset.needs = String(need.ram); }
      row.append(b);
    }
    const c = entry('Chat with Claude', { app: 'claude' }, () => openClaude()); c.dataset.shelf = 'claude';
    row.append(c);
  }
  // the 20K offer belongs to the machine that was on; the welcome menu's "on screen now" follows what runs
  session.on((ev) => { if (ev === 'machine') offer.hidden = true; if (['machine', 'loaded', 'reset', 'firmware'].includes(ev)) shelf(); });
  function firstVisit(askMachine) {
    box.replaceChildren();
    box.dataset.kind = 'first';
    box.append(el('div', 'Running with no ROMs.', 'lead'), el('div', 'Programs that run without them are in the Media tab below.', 'muted'));
    if (askMachine) {
      const ask = el('div', null, 'ask'); ask.id = 'askMachine';
      ask.append(el('span', 'Which computer did you have? '));
      for (const [id, label] of ASK) {
        const b = el('button', label); b.dataset.machine = id;
        // the welcome menu on every machine: 6809 models run the 6809 build, the MC-10 and Alice their own
        b.onclick = async () => { session.chooseMachine(id); ask.remove(); await runWelcome(); };
        ask.append(b);
      }
      box.append(ask);
    }
    box.append(dismiss());
    box.hidden = false;
  }
  function dismiss() { const b = el('button', 'Dismiss', 'close'); b.onclick = () => { box.hidden = true; }; return b; }

  // sound: unlock on the first pointer or key event anywhere; the hint shows until then
  const hint = $('soundHint');
  const showHint = () => { hint.hidden = audio.running || !audio.enabled; };
  // Unlocking is a one-time job, so the listeners remove themselves once the audio context is running rather
  // than sitting in the capture phase of every pointer and key event for the life of the page.
  const stopUnlock = () => {
    window.removeEventListener('pointerdown', unlock, { capture: true });
    window.removeEventListener('keydown', unlock, { capture: true });
  };
  const unlock = () => {
    audio.start();
    if (audio.enabled) session.welcomeSound();
    setTimeout(showHint, 100);
    // start() may leave the context suspended until the browser allows it (it resumes on the next gesture,
    // which this listener still catches); once it is running, let it go
    if (audio.running) stopUnlock(); else setTimeout(() => { if (audio.running) stopUnlock(); }, 250);
  };
  window.addEventListener('pointerdown', unlock, { capture: true });
  window.addEventListener('keydown', unlock, { capture: true });
  showHint();
  // The hint hides when sound starts, which happens on the first pointer or key press: unlock() calls
  // showHint() 100 ms later, and again 250 ms later if the context was still suspended. The one thing that can
  // change with no event at all is the browser's own audio state settling on its own, which is why a 1 s check
  // remains rather than nothing: it is cheap, it stops mattering once sound is running, and it is the only
  // correct way to notice a state the page is not told about. It is NOT a per-frame watcher.
  setInterval(showHint, 1000);

  // start: v = session.visit() before anything else is stored
  // program: 'welcome', 'liza', '2048' or 'minesweeper' from the URL (?start=, as the landing page links), run
  // whatever the visit.
  // Resolves once the program it starts (if any) is running.
  // fromLink: the URL names a machine, ROMs or media; withMedia: ROMs or media (they decide what runs, not the menu)
  async function start(v, { fromLink, withMedia = false, program = null }) {
    // a machine picked in the header menu (Session.chooseMachine) counts as the answer to the question
    session.on((ev) => { if (ev === 'machine' && session.store.get('machineChosen')) { const a = $('askMachine'); if (a) a.remove(); } });
    // the carry-on line only for what runs on the machine in use (Session.carryOn: another machine's file is not offered)
    const menu = v.first ? {} : { greeting: 'back', carryOn: session.carryOn };
    if (program) {
      if (v.first && !session.hasAnyRoms) firstVisit(!v.machineChosen);
      // LIZA and the welcome program run on every machine (the 20K question comes first on a 4K MC-10 or
      // Alice); the Session picks the build for the machine's CPU. The games are 6809 programs: on an MC-10 or
      // Alice the Session refuses and the status line says why.
      if (program === 'liza') await run(SHELF[0]);
      else if (gameItem(program)) await run(gameItem(program));
      else await runWelcome(menu);
      // As ?app=claude is the address while the chat is open (js/ui/page.js), ?start= is while the program it
      // started runs: a reload starts it again. Once something else takes the machine (the program is left for the
      // menu, a switch, a load, the menu or another program started) the address drops it, so a reload or Back to
      // this entry opens what a plain visit would, not the program left behind.
      const drop = (ev) => {
        if (!['menu', 'machine', 'loaded', 'welcome', 'firmware'].includes(ev)) return;
        const u = new URL(location.href);
        if (u.searchParams.has('start')) { u.searchParams.delete('start'); history.replaceState(history.state, '', u.href); }
      };
      session.on(drop);
    } else if (!withMedia && session.personMachine.useStub && session.welcomeMenu) {
      // Without this machine's ROMs the visit opens on the welcome menu, never the stub's bare screen: the
      // first visit's, or greeting a returning visitor back. A link that only names the machine (the landing page's
      // machine cards) does the same; the machine question is not asked then, the link answered it.
      if (v.first && !session.hasAnyRoms) firstVisit(!v.machineChosen && !fromLink);
      await runWelcome(menu);
    }
    shelf();
    lastTime();
  }
  // a program of the no-ROM shelf by name (the Library's empty state)
  function runShelf(name) {
    const item = SHELF.find((x) => x.name === name);
    if (item.cpu && cpuFamily(session.personMachine.config.cpu) !== item.cpu) { page.status(`${name} needs a Dragon or a CoCo; pick one from the machine menu.`, true); return; }
    run(item);
  }
  return { start, runShelf };
}
