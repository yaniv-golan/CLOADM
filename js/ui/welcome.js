/*
 * First visit and returning visitors.
 *  - First visit with no ROMs: the page opens on the welcome program (examples/welcome.asm) running on the
 *    stub, never an empty screen, with a strip of programs that run without ROMs (our own only) and the machine
 *    question, asked once and then remembered. The ROM requirement is said once, by the menu's key 3 ("3 ADD YOUR
 *    ROMS FOR BASIC"); the header's "Add ROMs…" (a phone: Menu's "Add ROMs…") is a plain way to the same screen. The welcome program's
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
import { $, ESC, touchPanel } from './page.js';
import { profiles } from '../machines/profiles.js';
import { cpuFamily } from '../cpu/cpus.js';
import { gameKey, WELCOME } from '../session.js';
import { buildUrl } from '../config.js';
import { WYRM_TEXT } from './wyrmfire.js';
const WYRMFIRE_ROW = { name: WYRM_TEXT.name, subtitle: WYRM_TEXT.subtitle, credit: WYRM_TEXT.credit };

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
  { name: 'Minesweeper', game: 'minesweeper', cpu: '6809', title: 'Minesweeper: find the ten mines (arrows or joystick; SPACE or fire opens, F or hold fire flags; BREAK leaves)' },
];
const gameItem = (key) => SHELF.find((x) => x.game === key);
// the welcome menu's key for LIZA ("1 TALK TO LIZA": the number whose event is 'liza', both builds)
export const LIZA_KEY = WELCOME.events.indexOf('liza') + 1;
// how long a program's "how to play" toast stays at most (howTo, below)
export const HINT_MS = 4000;
// the machine question: one button per family people are likely to have had
const ASK = [['dragon64', 'Dragon 32 / 64'], ['coco', 'CoCo 1 / 2'], ['coco3', 'CoCo 3'], ['mc10', 'MC-10']];
const el = (tag, text, cls) => { const e = document.createElement(tag); if (text != null) e.textContent = text; if (cls) e.className = cls; return e; };

export function setupWelcome(page, { showRoms, openClaude }) {
  const { session, audio } = page;
  const box = $('welcome');
  const back = $('btnWelcomeBack');   // shown while the colour demo started from the menu runs
  const showBack = (on) => { back.hidden = !on; };
  back.onclick = () => { showBack(false); runWelcome({}, { reason: 'return' }); };

  // greeting: 'first', 'back' or 'bye'; on a returning visit the menu offers what ran last as option 5
  // ifIdle: only if nothing else started while the menu's bytes were fetched (the Session asked for it, then a
  // program was loaded or a snapshot opened: that wins). `running` is the stub program that was there when the
  // fetch began: anything that started or stopped one since (a Power cycle, a Reset, a program, a snapshot,
  // `stubPrompt` in the browser check) changes `stubRun`, and the start is dropped. `welcomeRunning` alone is not
  // enough: it is FALSE both before the menu starts and after something cleared it, so a fetch that lands after
  // the page wiped the menu (stubPrompt does) would put the menu back over what the page started.
  // byMachine: the program on the machine asked for it (the 'welcome:*' events, 'menu' after LIZA's BYE or the
  // demo): the start itself runs in Session.asMachine, so keys Claude typed that asked for it do not stop Claude
  // (the fetch before it is outside: what the person does meanwhile still stops Claude)
  // (byMachine: the ticket the Session gave when the program asked, Session.machineTicket; null: the person asked)
  const startAs = (byMachine, fn) => (byMachine ? session.asMachine(fn, byMachine) : fn());
  // A program's "how to play" toast (a game, the colour demo): it says what the first key does, so that key ends it, or
  // HINT_MS, whichever comes first; it does not wait out a hover as other toasts do (on a touch panel the tap on a key
  // is a press on the page, which ends any toast already)
  let endHowTo = () => {};
  const howTo = (text) => {
    endHowTo();
    const t = page.toast(text);
    const key = (e) => { if (page.toMachine(e)) end(); };
    const timer = setTimeout(() => end(), HINT_MS);
    const end = () => { removeEventListener('keydown', key, true); clearTimeout(timer); page.feedback.dismiss(t); };
    addEventListener('keydown', key, true);
    endHowTo = end;
  };
  // A key on the welcome menu that is not one of its numbers (a first-time visitor typing PRINT, or LIST, as on the
  // real machine): the menu takes only numbers, and BASIC needs its ROM. Said once a visit. The menu's numbers, BREAK
  // (Esc: the games menu's way back), Tab (it moves the focus) and keys held with Ctrl, Alt or Cmd are not such keys,
  // and only while the menu is the screen the keys go to (not the chat, full screen in front of it).
  let menuToldOnce = false;
  const OTHER = new Set(['Enter', 'Backspace', 'Delete', 'Home', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']);
  addEventListener('keydown', (e) => {
    if (menuToldOnce || e.repeat || e.ctrlKey || e.altKey || e.metaKey || !session.welcomeRunning || !session.welcomeRunningOn || !page.toMachine(e)) return;
    if (!(e.key.length === 1 ? !/[0-9]/.test(e.key) : OTHER.has(e.key))) return;
    menuToldOnce = true;
    page.toast(`This is CLOADM's welcome menu: press a number to choose. Typing BASIC needs your BASIC ROM: {action}. Or press ${LIZA_KEY} for LIZA, a program you can type to.`,
      { action: { label: 'Add ROMs', run: showRoms } });
  });
  // reason: why it starts (Session WELCOME_REASONS: the tune plays only for 'visit' and 'shelf'); the menu the Session
  // offered (a switch, a Reset, a return: the 'menu' event) comes without one and the Session knows why
  async function runWelcome({ greeting = 'first', carryOn = null } = {}, { ifIdle = false, byMachine = null, reason = undefined } = {}) {
    const m = session.personMachine, running = session.stubRun, gen = session.welcomeGenNow();
    try {
      const bytes = await page.fetchBytes(`examples/${session.welcomeFile}`);   // this machine's build (6809, or its own 6803 one)
      if (ifIdle && (session.personMachine !== m || session.stubRun !== running || session.welcomeRunning)) return;
      // gen: a start whose fetch was overtaken (the menu cleared, a program loaded, a machine switch) is refused
      // in the Session itself, for every caller, so a late start cannot take the screen from what was started then
      startAs(byMachine, () => session.startWelcome(bytes, { greeting, carryOn: carryOn && carryOn.name, gen, reason }));   // (the menu says "PRESS 1 TO 4" itself: not repeated)
    } catch (e) { page.status(`Welcome: ${e.message}`, true); }
    page.focus();
    shelf();
    lastTime();
  }
  session.on(async (ev, arg) => {
    if (ev === 'machine' || ev === 'loaded') { showBack(false); lastTime(); return; }
    if (ev === 'lastrun') { lastTime(); return; }   // (recorded after 'loaded': the card names what Run again runs)
    // another tab loaded a program: the recent list changes but not this tab's lastRun. The drawer redraws its list on
    // 'recent'; the "Last time" card must follow too, or its NAME lags the list it sits above (naming the previous file).
    if (ev === 'recent') { lastTime(); return; }
    // (what the menu or a program asks for: byMachine, so a key Claude typed does not stop Claude)
    const asked = session.machineTicket();   // (taken now, when the program asks: whose keys they were)
    if (ev === 'welcome:liza') await run(SHELF[0], { byMachine: asked });
    else if (ev === 'welcome:demo') {
      await run(SHELF[1], { byMachine: asked });
      showBack(true);
      howTo(touchPanel() ? 'Colour demo: tap a key to start it; another tap goes back to the menu'
        : 'Colour demo: press a key to start it; another key goes back to the menu');
    } else if (ev === 'welcome:roms') showRoms();   // option 3, in both its readings: add them, or use the ones it has
    else if (ev === 'welcome:claude') await openClaude();
    else if (ev === 'welcome:carryon') await runAgain({ byMachine: asked });
    else if (ev === 'welcome:2048' || ev === 'welcome:minesweeper') await run(gameItem(ev.slice(8)), { byMachine: asked });
    // back from a program ('bye'), or the machine turned on, or reset with nothing to restart, without ROMs ('back')
    else if (ev === 'menu') {
      showBack(false);
      // 'none': the machine question's switch, which starts the menu without a carry-on -- the person chose the
      // machine, not what ran on the old one. The question is asked on a FIRST visit only, so the menu greets a
      // first-time visitor: greeting 'first' (the title screen), as main's handler did with runWelcome's default.
      // 'back'/'bye' as before.
      // the greeting is the Session's decision (Session.greetingFor), so the page and the Node tests share it
      const greeting = arg === 'none' || arg === 'back' ? session.greetingFor(arg) : 'bye';
      // the ticket, by what asked for the menu, in ONE place (Session.menuTicketFor): a machine question is always
      // the person's own act and never takes a ticket left over from an earlier LIZA BYE.
      await runWelcome({ greeting, carryOn: arg === 'back' ? session.carryOn : null },
        { ifIdle: true, byMachine: session.menuTicketFor(arg, asked) });
    }
  });
  // what ran last, again: LIZA, the demo, or the file (from the recent list)
  async function runAgain({ byMachine = null } = {}) {
    const last = session.lastRun;
    if (!last) return;
    if (last.kind === 'liza') await run(SHELF[0], { byMachine });
    else if (last.kind === 'demo') await run(SHELF[1], { byMachine });
    else if (last.kind === 'game') await run(gameItem(gameKey(last.name)), { byMachine });
    else { page.attempt(() => startAs(byMachine, () => session.library.loadRecent(0))); page.focus(); }
  }
  // the Media tab's "Last time": the name (and the machine, for a file) and "Run again"
  function lastTime() {
    const last = session.lastRun, recent = session.library.recentMedia()[0];
    const file = last && last.kind === 'recent' ? recent : null;
    // (no "Run again" for what is running now: it is marked in its list instead)
    const shown = !!last && (last.kind !== 'recent' || (!!file && file.stored)) && !page.runningNow();
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
        startAs(byMachine, () => session.runLiza(bytes));
        page.status('LIZA loaded');   // (our own program: no addresses; those are for files the visitor brings)
      } else if (item.game) {
        session.checkGame(item.game);   // (another CPU, or under 32K: says so before fetching anything)
        const bytes = await page.fetchBytes(`examples/${session.gameFile(item.game)}`);
        startAs(byMachine, () => session.runGame(item.game, bytes));
        howTo(touchPanel() ? `${item.name}: tap a key to play; tap BREAK for the menu`
          : `${item.name}: press a key to start; BREAK (Esc) goes back to the menu`);
      } else {
        const bytes = await page.fetchBytes(item.url);
        startAs(byMachine, () => session.load(item.url.split('/').pop(), bytes, { remember: false, ours: true }));
        page.status(`${item.name} loaded`);
        session.setLastRun('demo', item.name);
        // the demo runs on the person's machine (the load above goes there, behind the chat): watch THAT machine,
        // not whichever one is on screen, or a watch opened with the chat full screen would name the chat's machine
        session.watchForMenu('demo', session.personMachine);
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
  // runs and is drawn: onScreen below), the programs for this machine's CPU, and the Claude chat. Each one a link can start (the welcome menu,
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
    // the shelf is rebuilt whenever its marks change ("on screen now", what runs), and a rebuild drops
    // the node that had the focus - to the body, losing the keyboard with it (openPrograms had put it
    // there). The item that had focus gets it back - BY IDENTITY (its dataset.shelf key), not by place:
    // a redraw happens because the contents changed, and the item at the same place can be a different
    // one, which would move the keyboard to it silently. An item that is gone (a program the machine's
    // CPU does not run, after a switch) leaves the focus where the browser put it, on the body: the
    // keyboard was on something that no longer exists, and no silent jump to a neighbour is made.
    const had = document.activeElement && row.contains(document.activeElement) ? document.activeElement.dataset.shelf : null;
    row.replaceChildren();
    const running = page.runningNow();
    // every machine gets the welcome menu and LIZA (the 6809 or 6803 builds); the colour demo is a 6809 program
    // (the 6309 runs it too: it is in the 6809 instruction-set family)
    const cpu = session.personMachine.config.cpu, family = cpuFamily(cpu), need = session.lizaNeeds();
    {
      const w = entry('Welcome menu', { start: 'welcome' }, () => runWelcome({ greeting: session.greetingFor('back'), carryOn: session.carryOn }, { reason: 'shelf' })); w.dataset.shelf = 'welcome';   // the focus key: the redraw restores by it
      w.title = 'The Welcome menu: LIZA, colour and sound, adding ROMs, Claude, games';
      tagged = onScreen();
      shownRun = running ? `${running.kind}:${running.name}` : '';
      if (tagged) { w.append(' ', el('span', 'on screen now', 'tag now')); w.setAttribute('aria-current', 'true'); }
      row.append(w);
    }
    for (const item of SHELF.filter((x) => !x.cpu || x.cpu === family)) {
      const b = entry(item.name, item.liza ? { start: 'liza' } : item.game ? { start: item.game } : null, () => run(item));
      b.dataset.shelf = item.name;   // the focus key: the redraw restores by it
      // the LIZA title names the build the machine actually runs (the 6309 runs the 6809 build)
      b.title = item.liza ? `${item.title} (the ${family} build${need ? `; needs the ${need.ram}K RAM option` : ''})` : item.title;
      if (item.liza && need) { const t = el('span', `needs ${need.ram}K`, 'tag'); b.append(' ', t); b.dataset.needs = String(need.ram); }
      if (running && running.kind !== 'recent' && running.name === item.name) { b.append(' ', el('span', 'on screen now', 'tag now')); b.setAttribute('aria-current', 'true'); }
      row.append(b);
    }
    // WYRMFIRE: on every machine (it switches to the Dragon 64, asking first: js/ui/wyrmfire.js); its link is
    // ?start=wyrmfire alone, which names its machine itself
    {
      const a = el('a'); a.href = buildUrl(location.href, { start: 'wyrmfire' }); a.dataset.shelf = 'wyrmfire';
      a.onclick = (e) => { if (e.button || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return; e.preventDefault(); page.wyrmfire.start(); };
      const sub = el('span', null, 'sub');
      sub.append(el('span', WYRMFIRE_ROW.subtitle), el('span', WYRMFIRE_ROW.credit, 'credit'));
      a.append(el('span', WYRMFIRE_ROW.name, 'name'), sub);
      a.title = `${WYRMFIRE_ROW.name}: ${WYRMFIRE_ROW.subtitle}`;
      row.append(a);
    }
    const c = entry('Chat with Claude', { app: 'claude' }, () => openClaude()); c.dataset.shelf = 'claude';
    row.append(c);
    const back = had !== null && row.querySelector(`[data-shelf="${CSS.escape(had)}"]`);
    if (back) back.focus({ preventScroll: true });
    lastTime();   // (the "Last time" card hides while its program runs: it follows what the shelf marks)
  }
  // the card says what the machine is NOW, so a ROM drop, "Run without ROMs", Remove ROMs and a machine switch all
  // reach it: 'roms' after every change to the sockets, 'firmware' when the machine starts running its ROMs (or the
  // stub) again, 'machine' on a switch. (firstVisit above draws the first visit's, with the machine question.)
  session.on((ev) => { if (['roms', 'firmware', 'machine', 'reset'].includes(ev)) refreshCard(); });
  // the shelf follows the machine, every load, a Reset, a firmware change and what last ran ('lastrun': its card
  // names it); the 20K offer belongs to the machine that was on
  session.on((ev) => { if (ev === 'machine') offer.hidden = true; if (['machine', 'loaded', 'reset', 'firmware', 'lastrun'].includes(ev)) shelf(); });
  // "on screen now" is what the screen shows, not what was loaded: the welcome program executing and drawn
  // (Session.welcomeOnScreen) while the page's Pause is off. That changes without an event (the menu's first frame,
  // a Debugger stop or step, Pause), so the frame loop compares it with the tag shown and redraws the shelf only
  // when they differ: one getter read per animation frame.
  // The same for the program last run (Session.lastRunOnScreen): marked on the shelf and in the Recent list, and its
  // "Last time" card is hidden while it runs; shownRun is what the shelf drew.
  let tagged = false, shownRun = '';
  const onScreen = () => session.welcomeOnScreen && !page.paused;
  // What the side card says follows the machine, in three states that used to read the same:
  //   no ROMs at all            -> the machine question once (the first visit), else no card: the welcome menu's
  //                                "3 ADD YOUR ROMS FOR BASIC" and the header's Add ROMs… say the rest
  //   ROMs in, running the stub -> "Running without your ROMs." (nothing is missing; the way back is what the person
  //                                needs), and no machine question (they told us the machine by adding them)
  //   the ROMs running          -> no card at all: BASIC is on screen and there is nothing to explain
  // The first visit draws it once; `refreshCard` keeps it true as ROMs arrive, the stub is chosen and a machine
  // switch changes what is in the sockets. It never takes over the box while a machine question waits unanswered.
  //
  // The 'empty' state ("no ROMs at all") is the FIRST VISIT's card, and only the first visit draws it: a returning
  // visitor who chose the stub has the menu and the header pill, and a card over their page would be new. So
  // refreshCard never DRAWS 'empty' -- but it must also never take a 'first' card away, because a machine picked in
  // the question, or a Reset, fires the events this listens to while the first visit's card is what should stay.
  let dismissed = false;   // the person dismissed THIS card; a later state that needs one shows it again
  const cardState = () => {
    const m = session.personMachine;
    if (!m) return 'none';
    if (!m.useStub) return 'none';                              // the ROMs run: nothing to say
    return session.romsReadyButOff(m) ? 'off' : 'empty';        // stub by choice with the ROMs in, or nothing to run
  };
  function refreshCard() {
    const wasAsking = !!box.querySelector('#askMachine');
    const state = cardState();
    // the first visit's own card stands until the machine's state actually changes: a machine picked in the question
    // or a Reset must not wipe it ('empty' is what it is already showing)
    if (box.dataset.kind === 'first' && state === 'empty') return;
    if (state === 'none') { dismissed = false; box.hidden = true; box.replaceChildren(); return; }
    if (wasAsking && state === 'empty') return;                 // the question still waits: leave it up as it is
    if (!box.hidden && box.dataset.kind === state && box.childElementCount && !wasAsking) return;   // already right
    if (dismissed && state === 'off' && box.dataset.kind === 'off') return;   // dismissed: stays dismissed
    box.dataset.kind = state;
    box.replaceChildren();
    if (state === 'empty') { box.hidden = true; box.replaceChildren(); return; }   // never DRAWN after a first visit
    box.append(el('div', 'Running without your ROMs.', 'lead'),
      el('div', `The ${session.personMachine.profile.name}'s ROMs are in the sockets. Use them to get BASIC, or keep running programs that need none.`, 'muted'));
    box.appendChild(switchOnButton());
    box.appendChild(dismiss());
    box.hidden = false;
  }
  // the way back from "Run without ROMs": the same thing the ROM page's button does, from the card that explains it
  function switchOnButton() {
    const b = el('button', 'Use my ROMs', 'primary');
    b.dataset.cardSwitch = '1';
    b.onclick = () => {
      const m = session.personMachine;
      session.stubChosen.delete(m.id);
      session.switchMachine(m.id);
      page.status(`${m.profile.name}: switched on with its ROMs`);
      box.hidden = true;
    };
    return b;
  }
  const runKey = () => { const r = page.runningNow(); return r ? `${r.kind}:${r.name}` : ''; };
  page.onFrame(() => { if (onScreen() !== tagged || runKey() !== shownRun) shelf(); });
  // The first visit's card is the machine question alone (the welcome menu's "3 ADD YOUR ROMS FOR BASIC" says what
  // ROMs are for; the card does not repeat it): no question to ask, no card; once answered or dismissed, none either
  function firstVisit(askMachine) {
    box.replaceChildren();
    box.dataset.kind = 'first';
    if (!askMachine) { box.hidden = true; return; }
    const ask = el('div', null, 'ask'); ask.id = 'askMachine';
    ask.append(el('span', 'Which computer did you have? '));
    for (const [id, label] of ASK) {
      const b = el('button', label); b.dataset.machine = id;
      // the welcome menu on every machine: 6809 models run the 6809 build, the MC-10 and Alice their own.
      // The switch starts the menu itself, ONCE, without a carry-on (Session.chooseMachine passes offer 'none'):
      // the page starts nothing here, because two starts in one turn only worked while the later overwrote the
      // earlier, and after the generation ticket that depended on which one arrived first.
      b.onclick = () => { answered(); session.chooseMachine(id, { offer: 'none' }); page.focus(); };
      ask.append(b);
    }
    box.append(ask, dismiss());
    box.hidden = false;
  }
  // the question answered (here or in the header's machine menu): the first visit's card goes with it
  function answered() { const a = $('askMachine'); if (!a) return; a.remove(); if (box.dataset.kind === 'first') box.hidden = true; }
  // (the header menu's pick of the machine already on: an answer too, though nothing switches -- js/ui/machine-panel.js)
  page.machineAnswered = () => { session.store.set('machineChosen', '1'); answered(); };
  function dismiss() { const b = el('button', 'Dismiss', 'close'); b.onclick = () => { dismissed = true; box.hidden = true; }; return b; }
  // arriving on a shared moment that runs without ROMs (Session.sharedMoment), the card stands back: the person came
  // to see that moment. It comes back (unless dismissed) once they leave it: Reset, Switch off and on, a switch.
  const quiet = () => box.classList.toggle('quiet', session.sharedMoment);
  session.on((ev) => { if (ev === 'machine' || ev === 'arrival') quiet(); });

  // sound: unlock on the first user activation anywhere (a tap on Menu or Open… included, not only the screen); the hint
  // (a pointer) and the chip (a touch screen) show until then. The events are the ones a browser counts as an activation:
  // pointerup and touchend (a touch's pointerdown is not one on iOS, where the file picker's change is none either),
  // keydown.
  const hint = $('soundHint'), chip = $('soundChip'), touch = matchMedia('(pointer: coarse)');
  let unlocked = false;   // sound has been running: the chip does not come back
  const showHint = () => {
    if (audio.running) unlocked = true;
    hint.hidden = audio.running || !audio.enabled;
    chip.hidden = unlocked || !touch.matches || !audio.enabled;
  };
  // Unlocking is a one-time job, so the listeners remove themselves once the audio context is running rather
  // than sitting in the capture phase of every pointer and key event for the life of the page.
  const UNLOCK_EVENTS = ['pointerup', 'touchend', 'keydown'];
  const stopUnlock = () => { for (const e of UNLOCK_EVENTS) document.removeEventListener(e, unlock, { capture: true }); };
  const unlock = () => {
    audio.unlock();
    if (audio.enabled) session.welcomeSound();
    setTimeout(showHint, 100);
    // start() may leave the context suspended until the browser allows it (it resumes on the next gesture,
    // which this listener still catches); once it is running, let it go
    if (audio.running) stopUnlock(); else setTimeout(() => { if (audio.running) stopUnlock(); }, 250);
  };
  for (const e of UNLOCK_EVENTS) document.addEventListener(e, unlock, { capture: true });
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
    session.on((ev) => { if (ev === 'machine' && session.store.get('machineChosen')) answered(); });
    // the carry-on line only for what runs on the machine in use (Session.carryOn: another machine's file is not offered)
    const menu = v.first ? {} : { greeting: session.greetingFor('back'), carryOn: session.carryOn };
    if (program) {
      if (v.first && !session.hasAnyRoms) firstVisit(!v.machineChosen);
      // LIZA and the welcome program run on every machine (the 20K question comes first on a 4K MC-10 or
      // Alice); the Session picks the build for the machine's CPU. The games are 6809 programs: on an MC-10 or
      // Alice the Session refuses and the status line says why.
      if (program === 'liza') await run(SHELF[0]);
      else if (program === 'wyrmfire') await page.wyrmfire.start({ fromLink: true });   // (js/ui/wyrmfire.js: no question from a link)
      else if (gameItem(program)) await run(gameItem(program));
      else await runWelcome(menu, { reason: 'visit' });
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
      await runWelcome(menu, { reason: 'visit' });
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
  // a bundled program ('liza' or a game) started from its beginning, as its program page starts it (the arrival card's
  // and the snapshot toast's Start over) -> false when there is no such program (the caller power cycles instead)
  function runProgram(id) {
    const item = id === 'liza' ? SHELF[0] : gameItem(id);
    if (!item) return false;
    run(item);
    return true;
  }
  return { start, runShelf, runProgram };
}
