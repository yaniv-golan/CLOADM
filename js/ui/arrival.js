/*
 * The arrival card: someone opened a shared moment (a long link, #z=, or a short link, #l=; js/ui/snapshot-panel.js
 * opens it with its `link`). While the Session says the person has just arrived (Session.arrivedFromLink), a card
 * docked at the foot of the screen says, in these exact words:
 *   "Someone sent you this <machine>, exactly as they left it. It's running now. It's your copy: nothing you do
 *    changes theirs."
 * with [Start from the beginning] (startOver: the bundled program the moment is of, from its beginning; else a power
 * cycle into the same machine) and [Send it back] (the Share screen on the recipient's moment as it is now, exactly as
 * Share opens it: nothing is uploaded until they tap Copy). A short link's card ends with a small "Report this link"
 * (reportUrl: the short-link Worker's report page, GET /api/report/<id>, in a new tab; no key in it). The card never takes the focus: the machine keeps running and the first key goes to it, which ends the
 * arrival (Session.touch), as a load, a switch, a Reset or a power cycle do; the card goes with it ('arrival').
 * A program page (?start=) opens no moment, so it never shows the card.
 *
 * A shared BASIC program ("Share your program", js/ui/share.js) arrives on the same card (openProgram: a program link,
 * #z= whose payload is the program link, or a short link holding one; Session.openSharedProgram loads it on a fresh
 * machine of the sender's model and types LIST). It is docked at the top then, the listing below it:
 *   "Someone sent you a BASIC program (N lines). It's listed below; type RUN to start it."
 * and, like a moment's card, it goes at the first key (typing RUN). Without the machine's BASIC ROM in this browser it
 * shows the listing as text, with "To run it, this <machine> needs its BASIC ROM. [Add ROMs] [Copy the listing]", and
 * stays (Session.settleArrival) until the ROMs are added, when the program loads and is listed, or the person leaves.
 * A short link's program card ends with Report this link too. Start from the beginning and Send it back are a
 * moment's: a program's card has neither.
 *
 * A LIZA postcard (js/postcard.js: a #z= whose payload is the postcard link, or a short link holding one) starts LIZA
 * afresh on the sender's model and waits, the card docked at the top:
 *   "A postcard from LIZA · N lines" [Replay] [Skip to the end]
 * Replay types the lines at about 25 characters a second, each once LIZA asks for it; a key on the machine (or Skip
 * to the end) types the rest at once. Then the card says "Your turn: type to LIZA." and goes at their first key.
 *
 * A program shared with its source (js/source-share.js: a #z= whose payload is the source link, or a short link holding
 * one) opens a fresh machine of the sender's model, puts the source in the Assembler and runs NOTHING:
 *   "Someone sent you a program with its source: <name>, N lines. It's open in the Assembler; press Run to build and
 *    start it." [Run] [Show source]
 * Run builds it (INCLUDE from examples/ only) and starts it, only when it builds to the link's crc; otherwise the card
 * says "This source builds differently in this CLOADM, so it won't run here. The code is in the Assembler to read."
 * with Show source alone.
 */
import { SessionError } from '../session.js';
import { profiles } from '../machines/profiles.js';
import { $ } from './page.js';
import { POSTCARD_TEXT } from '../postcard.js';
import { SOURCE_TEXT } from '../source-share.js';

export const arrivalText = (machine) => `Someone sent you this ${machine}, exactly as they left it. It's running now. It's your copy: nothing you do changes theirs.`;
export const programArrivalText = (lines, listed) => `Someone sent you a BASIC program (${lines} line${lines === 1 ? '' : 's'}).${listed ? ' It\'s listed below; type RUN to start it.' : ''}`;

// openShare: the Share screen's open (js/ui/share.js); startOver(program): as the snapshot toast's Start over;
// reportUrl(id): the address "Report this link" opens for a short link, or null for none; openRoms: Add ROMs
export function setupArrival(page, { openShare, startOver, reportUrl, openRoms, confirmSwitch }) {
  const { session } = page;
  const card = $('arrival'), report = $('arrivalReport');
  function show() {
    const a = session.arrivedFromLink;
    card.hidden = !a;
    if (!a) return;
    const b = a.basic || null, needs = !!b && !b.listed, pc = a.postcard || null, src = a.source || null;
    card.classList.toggle('basic', !!b);
    card.classList.toggle('needs', needs);
    card.classList.toggle('postcard', !!pc);
    $('arrivalText').textContent = src ? (src.state === 'mismatch' ? SOURCE_TEXT.mismatch : SOURCE_TEXT.arrival(src.name, src.lines))
      : pc ? (pc.state === 'done' ? POSTCARD_TEXT.yourTurn : POSTCARD_TEXT.arrival(pc.lines)) : b ? programArrivalText(b.lines, b.listed) : arrivalText(a.machine);
    $('arrivalMoment').hidden = !!b || !!pc || !!src;
    $('arrivalSource').hidden = !src;
    $('btnSourceRun').hidden = !src || src.state === 'mismatch';
    $('arrivalPostcard').hidden = !pc || pc.state === 'done';
    $('btnPostcardReplay').hidden = !pc || pc.state !== 'ready';
    $('arrivalListing').textContent = needs ? b.text : '';
    $('arrivalListing').hidden = !needs;
    $('arrivalRoms').hidden = !needs;
    $('arrivalNeed').textContent = needs ? `To run it, this ${b.name} needs its BASIC ROM.` : '';
    const href = a.kind === 'short' && a.id ? reportUrl(a.id) : null;
    report.hidden = !href;
    if (href) report.href = href; else report.removeAttribute('href');
  }
  $('btnArrivalStart').onclick = () => { const a = session.arrivedFromLink; startOver(a ? a.program : null); };
  $('btnArrivalBack').onclick = () => openShare();

  // ---------------- the switch question a link's machine change asks ----------------
  // A link's program, postcard or source opens on a fresh machine of the sender's model. On a page that holds
  // nothing of the person's (a first visit's welcome menu, a fresh BASIC: Session.switchLoses) it opens without
  // asking; with something to lose - a key typed while the link's payload was in flight, work on a machine the person
  // switched to meanwhile, a BASIC session beside the chat, a disk or tape in - it asks first, as
  // js/ui/snapshot-panel.js does for a moment. And when a question is already open (their own switch from the menu,
  // asked while the link was fetched), the link's question replaces it rather than opening behind it: the same
  // `$('switchConfirm').hidden` test a moment's open makes.
  // to: { name, id, config } for confirmSwitch. open(): what the link does, which does the switch itself, so the
  // question's message and the switch cannot disagree. It runs only when the link may open - now, or when the person
  // answers Switch - and only it shows the card and gives the machine the focus: an unanswered question holds it.
  // The question is asked of the machine on screen NOW, not of the one the link was fetched for: a person who
  // switched meanwhile and typed on the new machine has work there too (Session.switchLoses asks about that one).
  // the fragment a link arrived in, while its question waits: Cancel puts it back (the readers strip it before the
  // question, and it is read once, at startup, so nothing re-reads it in this visit - a reload offers the link again,
  // which is what the person had). One slot, like the question itself: a second link's question replaces the first's,
  // so its fragment replaces that one too, and Cancel gives back the link being asked about. Cleared when answered
  // either way (Switch by each opener, Cancel by relink).
  let heldHash = null;
  const relink = () => { if (heldHash) history.replaceState(null, '', location.pathname + location.search + heldHash); heldHash = null; };
  function openOrAsk(to, open, onCancel = null) {
    if (!to || (!session.switchLoses(to.id, to.config) && $('switchConfirm').hidden)) { open(); return; }
    confirmSwitch(to, open, onCancel);
  }
  // What a link does once it may open, with its SessionError said as a status: the question's Switch runs it from the
  // machine panel's click, where a throw would be an uncaught page error. After it, the card and the focus, as a
  // moment's arrival leaves them.
  function thenOpen(open) {
    return () => {
      try { open(); }
      catch (e) { page.status(e.message, true); if (!(e instanceof SessionError)) console.error(e); return; }
      show();
      page.focus();
    };
  }

  // the switch each link makes, as the opener itself does it: the machine, and the config the Session will use
  // (prog/config from the link, merged over the saved config only when the link names any: Session.openSharedProgram).
  // A target equal to the machine in use would switch to nothing (Session.switchLoses is asked for it all the same:
  // it is the same question the menu asks).
  // (null for a machine this build does not have: openOrAsk then opens directly, and the opener's own check -
  // Session.checkedProgram - says it as a SessionError, which is what a person sees; without this, profiles[id].name
  // would throw a TypeError out of the click)
  function programSwitch(prog) {
    if (!Object.hasOwn(profiles, prog.machine)) return null;
    const config = Object.keys(prog.config).length ? Object.assign(session.savedConfig(prog.machine), prog.config) : session.savedConfig(prog.machine);
    return { name: profiles[prog.machine].name, id: prog.machine, config };
  }
  function postcardSwitch(pc) {
    if (!Object.hasOwn(profiles, pc.machine)) return null;
    return { name: profiles[pc.machine].name, id: pc.machine, config: session.postcards.lizaConfig(pc.machine) };
  }
  function sourceSwitch(card) {
    if (!Object.hasOwn(profiles, card.machine)) return null;
    const config = Object.keys(card.config).length ? Object.assign(session.savedConfig(card.machine), card.config) : session.savedConfig(card.machine);
    return { name: profiles[card.machine].name, id: card.machine, config };
  }
  // ---------------- a shared BASIC program ----------------
  let waiting = null;    // { prog, link }: a program waiting for its machine's BASIC ROM
  let opening = false;   // (the switch inside it emits 'roms', 'machine' and 'arrival': not a second arrival)
  // the program, opened on a fresh machine of its model (Session.openSharedProgram: it records the arrival the card
  // shows); an error is said as a status. link: { kind: 'long' | 'short', id }
  function openProgram(prog, link = { kind: 'long' }) {
    openOrAsk(programSwitch(prog), thenOpen(() => { heldHash = null; doProgram(prog, link); }), relink);
  }
  function doProgram(prog, link) {
    let r;
    waiting = null; opening = true;
    try { r = session.openSharedProgram(prog, link); }
    finally { opening = false; }
    waiting = r.state === 'needs-roms' ? { prog, link } : null;
  }
  // a #z= fragment that holds a program: opened, the fragment removed -> true; false when it holds none (a moment's)
  async function takeProgramLink(hash) {
    let prog;
    try { prog = await session.readProgramLink(hash); }
    catch (e) { if (!(e instanceof SessionError)) throw e; page.status(e.message, true); history.replaceState(null, '', location.pathname + location.search); return true; }
    if (!prog) return false;
    heldHash = hash;
    history.replaceState(null, '', location.pathname + location.search);
    openProgram(prog, { kind: 'long' });
    return true;
  }
  // ---------------- a LIZA postcard ----------------
  // the postcard, opened: LIZA (this model's build, fetched as the welcome menu fetches it) started afresh, waiting for
  // Replay or Skip. link: { kind: 'long' | 'short', id }
  async function openPostcard(pc, link = { kind: 'long' }) {
    let bytes;
    try { bytes = await page.fetchBytes(`examples/${session.postcards.fileFor(pc.machine)}`); }
    catch (e) { page.status(e.message, true); if (!(e instanceof SessionError)) console.error(e); return; }
    // (the question is asked after the fetch, as a moment's is after its payload arrives: nothing may switch while
    // the person is answering, and a key typed during that fetch is seen - the case the brief names)
    openOrAsk(postcardSwitch(pc), thenOpen(() => { heldHash = null; session.postcards.open(pc, link, bytes); }), relink);
  }
  // a #z= fragment that holds a postcard: opened, the fragment removed -> true; false when it holds none
  async function takePostcardLink(hash) {
    let pc;
    try { pc = await session.postcards.read(hash); }
    catch (e) { if (!(e instanceof SessionError)) throw e; page.status(e.message, true); history.replaceState(null, '', location.pathname + location.search); return true; }
    if (!pc) return false;
    heldHash = hash;
    history.replaceState(null, '', location.pathname + location.search);
    await openPostcard(pc, { kind: 'long' });
    return true;
  }
  $('btnPostcardReplay').onclick = () => { session.postcards.play(); page.focus(); };
  $('btnPostcardSkip').onclick = () => { session.postcards.skip(); page.focus(); };
  // while the postcard still has lines to type, a key on the machine is not typed into LIZA: it skips to the end
  // (the window's capture phase, ahead of js/ui/screen.js's keyboard)
  addEventListener('keydown', (e) => {
    if (!session.postcards.pending || !page.toMachine(e) || e.ctrlKey || e.metaKey || e.altKey || ['Shift', 'Control', 'Alt', 'Meta', 'CapsLock'].includes(e.key)) return;
    e.preventDefault(); e.stopImmediatePropagation();
    if (!e.repeat) session.postcards.skip();
  }, true);
  addEventListener('keyup', (e) => { if (session.postcards.pending && page.toMachine(e)) e.stopImmediatePropagation(); }, true);

  // ---------------- a program with its source ----------------
  let sourceCard = null;   // the source that arrived (Run builds it again)
  // opened: a fresh machine of its model, the source in the Assembler, nothing run. link: { kind: 'long' | 'short', id }
  async function openSource(card, link = { kind: 'long' }) {
    let include;
    try { include = await page.assembler.includesFor(card.source); }
    catch (e) { page.status(e.message, true); if (!(e instanceof SessionError)) console.error(e); return; }
    openOrAsk(sourceSwitch(card), thenOpen(() => {
      heldHash = null;
      session.sources.open(card, link, include);
      page.assembler.setSource(card.source, card.name);
      sourceCard = card;
    }), relink);
  }
  async function takeSourceLink(hash) {
    let card;
    try { card = await session.sources.read(hash); }
    catch (e) { if (!(e instanceof SessionError)) throw e; page.status(e.message, true); history.replaceState(null, '', location.pathname + location.search); return true; }
    if (!card) return false;
    heldHash = hash;
    history.replaceState(null, '', location.pathname + location.search);
    await openSource(card, { kind: 'long' });
    return true;
  }
  $('btnSourceRun').onclick = async () => {
    if (!sourceCard) return;
    const card = sourceCard;
    try { page.status(session.sources.run(card, await page.assembler.includesFor(card.source))); }
    catch (e) { page.status(e.message, true); if (!(e instanceof SessionError)) console.error(e); show(); return; }
    page.focus();
  };
  $('btnSourceShow').onclick = () => { page.openView('#debugger'); $('asmSource').focus(); };

  $('btnArrivalRoms').onclick = () => openRoms();
  $('btnArrivalCopy').onclick = async () => {
    const text = $('arrivalListing').textContent;
    try { await navigator.clipboard.writeText(text); page.toast('Listing copied'); }
    catch (e) { getSelection().selectAllChildren($('arrivalListing')); page.toast('Press Ctrl+C to copy the listing'); }
  };
  session.on((ev) => {
    if (ev === 'arrival') show();
    if (opening || !waiting) return;
    // ROMs added while the program waits: it loads and is listed now, on a fresh machine of its model. The wait ends
    // here, before the question (a declined switch must not leave it armed for the next ROMs to ask again; the old
    // doProgram cleared it on entry, and the question now comes before any doProgram).
    if (ev === 'roms' && session.machineRoms(waiting.prog.machine).bootable) {
      const w = waiting; waiting = null;
      openProgram(w.prog, w.link);
    }
    // another model (the person switched away): it no longer waits there
    else if (ev === 'machine' && session.shownMachine.id !== waiting.prog.machine) waiting = null;
  });
  show();
  return { show, openProgram, takeProgramLink, openPostcard, takePostcardLink, openSource, takeSourceLink };
}
