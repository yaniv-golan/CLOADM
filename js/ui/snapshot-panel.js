/*
 * Opening snapshots: a .cloadm file dropped on the screen or picked with Insert…, or the
 * snapshot a share link carries (#s=, js/ui/share.js writes such links). If it needs ROMs this browser doesn't
 * have, a card ("This moment needs Dragon 64 BASIC") offers Add ROMs
 * (and the moment opens as soon as they are added) or a look around that machine without them; if it is of
 * another model or config, the usual switch confirmation asks first.
 */
import { SessionError, SnapshotRomsError } from '../session.js';
import { looksLikeSnapshot } from '../media/snapshot.js';
import { $, ESC } from './page.js';

export function setupSnapshotPanel(page, { confirmSwitch, openRoms }) {
  const { session } = page;
  let waiting = null;    // a snapshot waiting for its ROMs

  // ---------------- opening a snapshot ----------------
  const card = $('snapNeeds');
  function needsRoms(snap, e) {
    waiting = snap;
    $('snapNeedsText').textContent = e.message;
    $('btnSnapLook').textContent = `Look around the ${e.machineName} without them`;
    card.hidden = false;
    $('btnSnapRoms').focus();
  }
  function open(snap) {
    card.hidden = true; waiting = null;
    try { session.snapshotRoms(snap); }
    catch (e) { if (e instanceof SnapshotRomsError) { needsRoms(snap, e); return; } throw e; }
    const sw = session.snapshotSwitch(snap);
    // (its message says what the switch took out, as a switch from the menu does)
    if (sw) confirmSwitch({ name: sw.text, id: sw.machine, config: sw.config }, (taken, said) => page.attempt(() => session.openSnapshot(snap) + (said ? `.${said}` : '')));
    else { page.attempt(() => session.openSnapshot(snap)); page.focus(); }
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
  session.on((ev) => { if ((ev === 'roms' || ev === 'loaded') && waiting) { const snap = waiting; try { session.snapshotRoms(snap); open(snap); } catch (e) { /* still missing */ } } });

  // a share link's snapshot (the #s= fragment): opened as a dropped file would be; the fragment is then removed
  async function takeLink(hash) {
    let snap;
    try { snap = await session.readLongLink(hash); }
    catch (e) { if (!(e instanceof SessionError)) throw e; page.status(e.message, true); history.replaceState(null, '', location.pathname + location.search); return true; }
    if (!snap) return false;
    history.replaceState(null, '', location.pathname + location.search);
    open(snap);
    return true;
  }

  return { take, open, takeLink };
}
