/*
 * Quick-save slots in the drawer's Media tab: three slots in the media store (Session.saveSlot /
 * readSlot / listSlots, under library/snapshots/, so the Library lists them with the other snapshots). Each row
 * says what the slot holds and offers Save and Load; loading goes through the snapshot panel, so another machine
 * asks first and missing ROMs show the same card as a snapshot file. No separate design: built
 * after the drawer's recent list. Hidden while the welcome program is still what runs and no slot holds anything
 *; running anything else, a reset or a switch shows them. The heading never shows without its list: hidden until the
 * slots are listed, and with every slot empty the line "No snapshots yet. Take one from Menu → Take snapshot." is
 * under it. A phone's Menu has "Take snapshot" (take) and "Restore snapshot…" (reveal: the list, whatever runs).
 */
import { $ } from './page.js';
import { WYRMFIRE_TEXT } from '../session.js';

const el = (tag, text, cls) => { const e = document.createElement(tag); if (text != null) e.textContent = text; if (cls) e.className = cls; return e; };
const time = (iso) => new Date(iso).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

export function setupSlotsPanel(page, { snapshots }) {
  const { session } = page;
  const box = $('slotList');
  let asked = false;   // Menu's "Restore snapshot…" asked for the list: it shows whatever runs (until a launch)
  async function render() {
    // the slots stay hidden until the listing answers (the store can take a while: shown meanwhile, the heading stood
    // alone, and on a first visit they flashed up), and while the welcome program runs with nothing in them
    if (!box.children.length || session.welcomeRunning) $('quickSave').hidden = true;
    let slots;
    try { slots = await session.listSlots(); } catch (e) { $('quickSave').hidden = true; page.status(session.library.mediaError(e, 'the snapshots').message, true); return; }
    const none = slots.every((s) => s.empty);
    $('quickSave').hidden = session.welcomeRunning && none && !asked;
    $('slotEmpty').hidden = !none;
    // WYRMFIRE: no snapshots (Session.snapshotFile refuses), said in the slots' own muted line
    const off = session.wyrmfireRunning || session.romCodeIn(session.personMachine) === 'userdata';
    $('slotNote').textContent = off ? WYRMFIRE_TEXT.snapshots : 'A snapshot reopens on the same machine, RAM and ROMs.';
    // the panel is rebuilt on the session's events, and a rebuild drops the node that had the focus -
    // to the body, losing the keyboard. The button that had focus gets it back on the new node of the
    // SAME slot and the same role (save or restore: the slots are a fixed list, the slot number and
    // which button is the stable identity), as the shelf and the Recent list do (js/ui/welcome.js,
    // js/ui/drawer.js): a redraw must not move the keyboard.
    const active = document.activeElement;
    const had = active && box.contains(active) ? { slot: active.closest('.slot-row') && active.closest('.slot-row').dataset.slot, role: active.getAttribute('aria-label') && active.getAttribute('aria-label').startsWith('Restore') ? 'restore' : 'save' } : null;
    box.replaceChildren(...slots.map((s) => {
      const row = el('div', null, 'row slot-row'); row.dataset.slot = s.n;
      const what = el('span', s.empty ? `Snapshot ${s.n} · empty` : s.error ? `Snapshot ${s.n} · unreadable` : `Snapshot ${s.n} · ${s.name} · ${time(s.taken)}`);
      if (s.error) what.title = s.error;
      const save = el('button', 'Take snapshot'), load = el('button', 'Restore');
      save.setAttribute('aria-label', `Take snapshot ${s.n}`); load.setAttribute('aria-label', `Restore snapshot ${s.n}`);
      load.disabled = !!(s.empty || s.error);
      save.disabled = off;
      save.onclick = () => saveTo(s.n);
      load.onclick = async () => {
        try { snapshots.open(await session.readSlot(s.n)); } catch (e) { page.status(e.message, true); }
      };
      const bar = el('span', null, 'bar'); bar.append(save, load);
      row.append(what, bar);
      return row;
    }));
    if (had && had.slot) {
      const row = box.querySelector(`.slot-row[data-slot="${had.slot}"]`);
      const back = row && (had.role === 'restore' ? row.querySelector('button[aria-label^="Restore"]') : row.querySelector('button[aria-label^="Take"]'));
      if (back) back.focus({ preventScroll: true });
    }
  }
  // the welcome program starts ('welcome': its file is fetched first, so it can start after the first render has
  // already listed the slots) and ends on a load, a reset or a switch
  // the row shows the new time; a toast says so, with Undo (what the slot held before goes back)
  async function saveTo(n) {
    let before;
    try { before = await session.slotBytes(n); await session.saveSlot(n); }
    catch (e) { page.status(e.message, true); return; }
    await render(); page.focus();
    page.toast(`Snapshot ${n} taken`, { action: { label: 'Undo', run: async () => {
      try { await session.restoreSlot(n, before); } catch (e) { page.status(e.message, true); }
      render();
    } } });
  }
  // Menu's "Take snapshot": the first empty slot, else the one taken longest ago (Undo puts it back)
  async function take() {
    let slots;
    try { slots = await session.listSlots(); } catch (e) { page.status(session.library.mediaError(e, 'the snapshots').message, true); return; }
    const free = slots.find((s) => s.empty) || slots.find((s) => s.error)
      || slots.slice().sort((a, b) => new Date(a.taken) - new Date(b.taken))[0];
    await saveTo(free.n);
  }
  // Menu's "Restore snapshot…": the slots list (the Programs sheet on a phone), brought into view with the focus on the
  // first slot that can be restored, else on the list's first button
  async function reveal(from = null) {
    asked = true;
    await render();
    page.openPrograms(from);
    $('quickSave').scrollIntoView({ block: 'nearest' });
    const first = box.querySelector('button[aria-label^="Restore"]:not(:disabled)') || box.querySelector('button');
    if (first) first.focus({ preventScroll: true });
  }
  session.on((ev) => {
    if (ev === 'launch') asked = false;
    if (['welcome', 'machine', 'loaded', 'reset', 'firmware', 'roms', 'wyrmfire', 'disks'].includes(ev)) render();
  });
  render();
  return { refresh: render, take, reveal };
}
