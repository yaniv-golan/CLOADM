/*
 * Arriving on a shared BASIC program ("Share your program" on the Share screen, js/ui/share.js): a long link (#z= whose
 * payload is the program link, js/media/snapshot.js encodeProgramLink) or a short link whose sealed bytes are one.
 * Session.openSharedProgram switches to a fresh machine of the sender's model, loads the program as load_basic does
 * (no typing) and types LIST, never RUN. A card docked at the top of the screen says so:
 *   "Someone sent you a BASIC program (N lines). It's listed below; type RUN to start it."
 * Without a BASIC ROM for that machine in this browser, the card shows the listing as text, with
 *   "To run it, this <machine> needs its BASIC ROM. [Add ROMs] [Copy the listing]"
 * and once ROMs are added that make the machine bootable, the program loads and is listed then.
 * (This is the simplest docked card, standing in for the shared-moment arrival card of js/ui/arrival.js, which this
 * branch does not have yet; the two are to become one when they meet.)
 */
import { SessionError } from '../session.js';
import { $ } from './page.js';

export function setupProgramArrival(page, { openRoms }) {
  const { session } = page;
  const card = $('progArrival');
  let waiting = null;   // a program waiting for its machine's BASIC ROM

  const hide = () => { card.hidden = true; card.classList.remove('needs'); waiting = null; };
  function said(prog, r) {
    $('progArrivalText').textContent = r.state === 'listed'
      ? `Someone sent you a BASIC program (${r.lines} line${r.lines === 1 ? '' : 's'}). It's listed below; type RUN to start it.`
      : `Someone sent you a BASIC program (${r.lines} line${r.lines === 1 ? '' : 's'}).`;
    const needs = r.state === 'needs-roms';
    card.classList.toggle('needs', needs);
    $('progArrivalListing').textContent = needs ? prog.text : '';
    $('progArrivalListing').hidden = !needs;
    $('progArrivalRoms').hidden = !needs;
    $('progArrivalNeed').textContent = needs ? `To run it, this ${r.name} needs its BASIC ROM.` : '';
    card.hidden = false;
  }
  // the program, opened: listed, or waiting for ROMs (the card says which); an error is said as a status
  let opening = false;   // (the switch inside it emits 'roms' and 'machine': not a second arrival)
  function open(prog) {
    let r;
    waiting = null; opening = true;
    try { r = session.openSharedProgram(prog); }
    catch (e) { if (!(e instanceof SessionError)) throw e; hide(); page.status(e.message, true); return; }
    finally { opening = false; }
    waiting = r.state === 'needs-roms' ? prog : null;
    said(prog, r);
    if (r.state === 'listed') page.focus();
  }
  // a #z= fragment that holds a program: opened, the fragment removed -> true; false when it holds none (a moment's)
  async function takeLink(hash) {
    let prog;
    try { prog = await session.readProgramLink(hash); }
    catch (e) { if (!(e instanceof SessionError)) throw e; page.status(e.message, true); history.replaceState(null, '', location.pathname + location.search); return true; }
    if (!prog) return false;
    history.replaceState(null, '', location.pathname + location.search);
    open(prog);
    return true;
  }

  $('btnProgArrivalRoms').onclick = () => openRoms();
  $('btnProgArrivalCopy').onclick = async () => {
    const text = $('progArrivalListing').textContent;
    try { await navigator.clipboard.writeText(text); page.toast('Listing copied'); }
    catch (e) { getSelection().selectAllChildren($('progArrivalListing')); page.toast('Press Ctrl+C to copy the listing'); }
  };
  $('btnProgArrivalDismiss').onclick = () => { hide(); page.focus(); };
  session.on((ev) => {
    if (opening) return;
    // ROMs added while the program waits: it loads and is listed now, on a fresh machine of its model
    if (ev === 'roms' && waiting && session.machineRoms(waiting.machine).bootable) open(waiting);
    // another machine (a switch the person made): the card was about the one the program came on
    else if (ev === 'machine' && !card.hidden && !waiting) hide();
  });
  return { takeLink, open };
}
