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
 */
import { SessionError } from '../session.js';
import { $ } from './page.js';

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
    const b = a.basic || null, needs = !!b && !b.listed;
    card.classList.toggle('basic', !!b);
    card.classList.toggle('needs', needs);
    $('arrivalText').textContent = b ? programArrivalText(b.lines, b.listed) : arrivalText(a.machine);
    $('arrivalMoment').hidden = !!b;
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
    if (r.state === 'listed') page.focus();
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
  return { show, openProgram, takeProgramLink };
}
