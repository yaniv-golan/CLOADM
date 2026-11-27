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
import { $ } from './page.js';
import { POSTCARD_TEXT } from '../postcard.js';
import { SOURCE_TEXT } from '../source-share.js';

export const arrivalText = (machine) => `Someone sent you this ${machine}, exactly as they left it. It's running now. It's your copy: nothing you do changes theirs.`;
export const programArrivalText = (lines, listed) => `Someone sent you a BASIC program (${lines} line${lines === 1 ? '' : 's'}).${listed ? ' It\'s listed below; type RUN to start it.' : ''}`;

// openShare: the Share screen's open (js/ui/share.js); startOver(program): as the snapshot toast's Start over;
// reportUrl(id): the address "Report this link" opens for a short link, or null for none; openRoms: Add ROMs
export function setupArrival(page, { openShare, startOver, reportUrl, openRoms }) {
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

  // ---------------- a shared BASIC program ----------------
  let waiting = null;    // { prog, link }: a program waiting for its machine's BASIC ROM
  let opening = false;   // (the switch inside it emits 'roms', 'machine' and 'arrival': not a second arrival)
  // the program, opened on a fresh machine of its model (Session.openSharedProgram: it records the arrival the card
  // shows); an error is said as a status. link: { kind: 'long' | 'short', id }
  function openProgram(prog, link = { kind: 'long' }) {
    let r;
    waiting = null; opening = true;
    try { r = session.openSharedProgram(prog, link); }
    catch (e) { if (!(e instanceof SessionError)) throw e; page.status(e.message, true); return; }
    finally { opening = false; }
    waiting = r.state === 'needs-roms' ? { prog, link } : null;
    show();
    // the screen has the focus either way, as a moment's arrival leaves it: listed, the first key (RUN) goes to BASIC;
    // waiting for ROMs, the card's buttons are a Tab away and the machine is the one the program came for
    page.focus();
  }
  // a #z= fragment that holds a program: opened, the fragment removed -> true; false when it holds none (a moment's)
  async function takeProgramLink(hash) {
    let prog;
    try { prog = await session.readProgramLink(hash); }
    catch (e) { if (!(e instanceof SessionError)) throw e; page.status(e.message, true); history.replaceState(null, '', location.pathname + location.search); return true; }
    if (!prog) return false;
    history.replaceState(null, '', location.pathname + location.search);
    openProgram(prog, { kind: 'long' });
    return true;
  }
  // ---------------- a LIZA postcard ----------------
  // the postcard, opened: LIZA (this model's build, fetched as the welcome menu fetches it) started afresh, waiting for
  // Replay or Skip. link: { kind: 'long' | 'short', id }
  async function openPostcard(pc, link = { kind: 'long' }) {
    try {
      const bytes = await page.fetchBytes(`examples/${session.postcards.fileFor(pc.machine)}`);
      session.postcards.open(pc, link, bytes);
    } catch (e) { page.status(e.message, true); if (!(e instanceof SessionError)) console.error(e); return; }
    show();
    page.focus();
  }
  // a #z= fragment that holds a postcard: opened, the fragment removed -> true; false when it holds none
  async function takePostcardLink(hash) {
    let pc;
    try { pc = await session.postcards.read(hash); }
    catch (e) { if (!(e instanceof SessionError)) throw e; page.status(e.message, true); history.replaceState(null, '', location.pathname + location.search); return true; }
    if (!pc) return false;
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
    try {
      const include = await page.assembler.includesFor(card.source);
      session.sources.open(card, link, include);
      page.assembler.setSource(card.source, card.name);
      sourceCard = card;
    } catch (e) { page.status(e.message, true); if (!(e instanceof SessionError)) console.error(e); return; }
    show();
    page.focus();
  }
  async function takeSourceLink(hash) {
    let card;
    try { card = await session.sources.read(hash); }
    catch (e) { if (!(e instanceof SessionError)) throw e; page.status(e.message, true); history.replaceState(null, '', location.pathname + location.search); return true; }
    if (!card) return false;
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
    // ROMs added while the program waits: it loads and is listed now, on a fresh machine of its model
    if (ev === 'roms' && session.machineRoms(waiting.prog.machine).bootable) openProgram(waiting.prog, waiting.link);
    // another model (the person switched away): it no longer waits there
    else if (ev === 'machine' && session.shownMachine.id !== waiting.prog.machine) waiting = null;
  });
  show();
  return { show, openProgram, takeProgramLink, openPostcard, takePostcardLink, openSource, takeSourceLink };
}
