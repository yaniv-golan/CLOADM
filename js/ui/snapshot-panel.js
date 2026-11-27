/*
 * Opening snapshots: a .cloadm file dropped on the screen or picked with Insert…, or the
 * snapshot a long link carries (#z=; js/ui/share.js writes them) or a short link's moment
 * (#l=<id>.<key>, fetched from s.cloadm.dev and opened with its key here; a short link that holds a BASIC program
 * instead goes to openProgram, a LIZA postcard to openPostcard, a program's source to openSource: js/ui/arrival.js). If it needs ROMs this browser doesn't
 * have, a card ("This moment needs Dragon 64 BASIC") offers Add ROMs
 * (and the moment opens as soon as they are added) or a look around that machine without them; if it is of
 * another model or config, the usual switch confirmation asks first (a link's moment only when the page holds something
 * of the person's to lose: Session.switchLoses). The toast that says a snapshot opened offers
 * "Start over" (startOver: the program the moment is of from its beginning, else a power cycle; js/ui/main.js).
 */
import { Session, SessionError, SnapshotRomsError } from '../session.js';
import { looksLikeSnapshot } from '../media/snapshot.js';
import { $, ESC } from './page.js';

export function setupSnapshotPanel(page, { confirmSwitch, openRoms, startOver, openProgram, openPostcard, openSource }) {
  const { session } = page;
  let waiting = null;    // a snapshot waiting for its ROMs
  let waitingOpts = {};  // and how it came (open's options: a link's moment is still one when its ROMs arrive)

  // ---------------- opening a snapshot ----------------
  const card = $('snapNeeds');
  function needsRoms(snap, e, opts) {
    waiting = snap; waitingOpts = opts;
    $('snapNeedsText').textContent = e.message;
    $('btnSnapLook').textContent = `Look around the ${e.machineName} without them`;
    card.hidden = false;
    $('btnSnapRoms').focus();
  }
  // the snapshot opened, said on a toast with "Start over" (the moment's own program from its beginning, or a power
  // cycle); an error is said as page.attempt says one. -> whether it opened
  function opened(snap, opts, said = '') {
    let msg;
    try { msg = session.openSnapshot(snap, opts) + said; }
    catch (e) { page.status(e.message, true); if (!(e instanceof SessionError)) console.error(e); return false; }
    const program = Session.momentProgramId(snap.program);
    page.toast(msg, { action: { label: 'Start over', run: () => startOver(program) } });
    return true;
  }
  // shared: from a share link (takeLink): one that runs without ROMs arrives quietly (Session.sharedMoment)
  // link: { kind: 'long' | 'short', id } for a link's moment (Session.arrivedFromLink: the page's arrival card)
  function open(snap, opts = {}) {
    const { shared = false, link = null } = opts;
    card.hidden = true; waiting = null; waitingOpts = {};
    try { session.snapshotRoms(snap); }
    catch (e) { if (e instanceof SnapshotRomsError) { needsRoms(snap, e, opts); return; } throw e; }
    const sw = session.snapshotSwitch(snap);
    // (its message says what the switch took out, as a switch from the menu does). A link's moment on a page that holds
    // nothing of the person's (a first visit's welcome menu, a fresh BASIC: Session.switchLoses) opens without asking:
    // the question is there to protect their work, and there is none to lose. (A question already open, the person's
    // own switch from the menu asked while the link was fetched, is answered by the link's question instead.)
    if (sw && link && !session.switchLoses(sw.machine, sw.config) && $('switchConfirm').hidden) { opened(snap, { shared, link }); page.focus(); }
    else if (sw) confirmSwitch({ name: sw.text, id: sw.machine, config: sw.config }, (taken, said) => opened(snap, { shared, link }, said ? `.${said}` : ''));
    else { opened(snap, { shared, link }); page.focus(); }
  }
  // a file that may be a snapshot: opened (true), or false to load it as anything else
  async function take(name, bytes) {
    if (!looksLikeSnapshot(name, bytes)) return false;
    let snap;
    try { snap = await session.readSnapshot(bytes); }
    catch (e) {
      if (!(e instanceof SessionError)) throw e;
      // a gzip or JSON file that isn't a snapshot after all loads as whatever else it is
      if (!name.toLowerCase().endsWith('.cloadm') && /not a CLOADM snapshot/.test(e.message)) return false;
      page.status(`${name}: ${e.message}`, true);
      return true;
    }
    open(snap);
    return true;
  }
  $('btnSnapRoms').onclick = () => openRoms();
  $('btnSnapLook').onclick = () => {
    const snap = waiting;
    card.hidden = true; waiting = null;
    if (snap.machine !== session.shownMachine.id) session.switchMachine(snap.machine, snap.config);
    page.focus();
  };
  $('btnSnapDismiss').onclick = () => { card.hidden = true; waiting = null; page.focus(); };
  page.onEscape(ESC.card, () => !card.hidden, () => $('btnSnapDismiss').click());
  // ROMs added while a snapshot waits for them: it opens now
  // (and a cartridge it names, dropped and loaded: it is then among the recent programs)
  session.on((ev) => { if ((ev === 'roms' || ev === 'loaded') && waiting) { const snap = waiting, opts = waitingOpts; try { session.snapshotRoms(snap); open(snap, opts); } catch (e) { /* still missing */ } } });

  // a share link's snapshot (the #z= fragment): opened as a dropped file would be; the fragment is then removed
  async function takeLink(hash) {
    let snap;
    try { snap = await session.readSnapshotLink(hash); }
    catch (e) { if (!(e instanceof SessionError)) throw e; page.status(e.message, true); history.replaceState(null, '', location.pathname + location.search); return true; }
    if (!snap) return false;
    history.replaceState(null, '', location.pathname + location.search);
    open(snap, { shared: true, link: { kind: 'long' } });
    return true;
  }

  // a short link's moment (#l=<id>.<key>): fetched from the store and opened with the key, which never leaves the page;
  // the fragment is removed either way. Shared, as a long link's is: a moment without ROMs arrives quietly
  // (Session.sharedMoment: no side card or "Add ROMs…" beside the arrival card)
  async function takeShortLink(hash, store) {
    let got;
    try { got = await session.readShortLink(hash, store); }
    catch (e) { if (!(e instanceof SessionError)) throw e; page.status(e.message, true); history.replaceState(null, '', location.pathname + location.search); return true; }
    if (!got) return false;
    history.replaceState(null, '', location.pathname + location.search);
    // a program's short link (Share your program): its program arrives as a program link's does
    if (got.program) { openProgram(got.program, { kind: 'short', id: got.id }); return true; }
    // a LIZA postcard's short link: LIZA starts afresh and the card offers its replay (js/ui/arrival.js)
    if (got.postcard) { await openPostcard(got.postcard, { kind: 'short', id: got.id }); return true; }
    // a program's source: the Assembler holds it, nothing runs (js/ui/arrival.js)
    if (got.source) { await openSource(got.source, { kind: 'short', id: got.id }); return true; }
    open(got.snap, { shared: true, link: { kind: 'short', id: got.id } });
    return true;
  }

  return { take, open, takeLink, takeShortLink };
}
