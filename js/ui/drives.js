/* The disk drives card under the screen ("Drives · {dos} · click a drive to insert", a 2 x 2
 * grid; a loaded drive shows its activity light and the image's name, an empty one "n · Insert…"). Clicking a
 * drive opens its menu under the grid: an empty drive takes a file, a disk stored in the browser (the
 * Library's disks, under disks/) or a new blank disk (Session.newDisk: a size the disk system uses, VDK, JVC or
 * DMK), with write-protect; a loaded one has write-protect, Download and Eject.
 * The menu and the disk error states follow the slots (the cassette's buttons, the
 * orange the design keeps for warnings, the status line every slot reports on) and say what to do next:
 *   no disk ROM yet      the header says so; an empty drive's menu names the ROM it needs and has "Add ROMs…"
 *   an insert refused    the reason on the status line and in the drive's menu, which stays open
 *   a write refused      the drive is marked "not saved" in orange (its changes are only in the drive); its menu
 *                        says why and offers Download to keep them; the mark goes when a write succeeds
 *   a snapshot's disk    marked "snapshot": it is the snapshot's own copy, not the image in the library */
import { $, ESC } from './page.js';
import { SessionError } from '../session.js';

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
// the card's short label for the disk system
const dosLabel = (name) => name.replace(/ cartridge$/, '');
// a loaded drive's label: "n · file", the file split so the page can shorten the middle of a long name and keep its end
const TAIL = 15, LONG = 14;   // a name longer than LONG does not fit a half-width tile: the card goes one drive to a row
const driveLabel = (n, file) => file.length > TAIL + 4
  ? `<span class="dh">${n} · ${esc(file.slice(0, -TAIL))}</span><span class="dt">${esc(file.slice(-TAIL))}</span>`
  : `<span class="dh">${n} · ${esc(file)}</span>`;

export function setupDrives(page, { openRoms = null } = {}) {
  const { session } = page;
  let open = null;            // the drive whose menu is open
  let menuError = null;       // why the last action in the open menu failed

  const run = async (fn) => {
    menuError = null;
    try { const msg = await fn(); if (msg) page.status(msg); }
    catch (e) { page.status(e.message, true); if (open !== null) menuError = e.message; if (!(e instanceof SessionError)) console.error(e); }
    render();
  };

  function render() {
    const choices = session.diskDosChoices();
    $('driveSlot').hidden = !choices.length;
    if (!choices.length) { open = null; $('driveMenu').hidden = true; return; }
    const st = session.diskStatus();
    const dos = st.dos || session.preferredDiskDos();
    $('driveDos').textContent = !dos ? 'no disk ROM yet' : dos.id === 'builtin' || dos.builtin ? 'built-in' : dosLabel(dos.name);
    const act = session.diskActivity();
    // the drive whose button has the focus keeps it across the rebuild below
    const a = document.activeElement, had = a && $('drives').contains(a) && a.dataset.drive !== undefined ? a.dataset.drive : null;
    const html = [];
    for (let n = 0; n < st.count; n++) {
      const d = st.drives.find((x) => x.drive === n);
      html.push(d
        ? `<button class="drive loaded${d.unsaved ? ' unsaved' : ''}${open === n ? ' open' : ''}" data-drive="${n}" aria-expanded="${open === n}" aria-controls="driveMenu" title="${esc(d.name)}"><span class="led${act[n] ? ' on' : ''}" aria-hidden="true"></span><span class="dn">${driveLabel(n, d.file)}</span>` +
          `${d.unsaved || !d.stored || d.writeProtected ? `<span class="meta">${[d.unsaved ? '<span class="flag">not saved</span>' : '', !d.stored ? '<span class="tag">snapshot</span>' : '', d.writeProtected ? '<span class="wp">write-protected</span>' : ''].filter(Boolean).join(' · ')}</span>` : ''}</button>`
        : `<button class="drive${open === n ? ' open' : ''}" data-drive="${n}" aria-expanded="${open === n}" aria-controls="driveMenu">${n} · Insert disk…</button>`);
    }
    $('drives').innerHTML = html.join('');
    if (had !== null) { const b = $('drives').querySelector(`[data-drive="${had}"]`); if (b) b.focus(); }
    $('drives').classList.toggle('long', st.drives.some((d) => d.file.length > LONG));
    menu(st, choices);
  }
  async function menu(st, choices) {
    const box = $('driveMenu');
    if (open === null || open >= st.count) { open = null; box.hidden = true; return; }
    const d = st.drives.find((x) => x.drive === open);
    const err = menuError ? `<p class="error">${esc(menuError)}</p>` : '';
    if (d) {
      box.innerHTML = `<div class="title">Drive ${open} · ${esc(d.file)}${d.stored ? '' : ' (from the snapshot)'}</div>
        ${d.unsaved ? `<p class="error">${esc(d.unsaved)} The changes are only in the drive: Download keeps them.</p>` : ''}
        ${!d.stored ? '<p class="note">This is the snapshot\'s own copy of the disk, not the one in your library. Download keeps it.</p>' : ''}
        ${err}
        <label><input type="checkbox" id="driveWp"${d.writeProtected ? ' checked' : ''}> Write-protect</label>
        <div class="bar"><button id="driveDownload">Download</button><button id="driveEject">Eject</button><button id="driveClose">Close</button></div>`;
    } else if (!st.dos && !choices.some((c) => c.ready)) {
      // no disk system can go in yet: say which ROM it takes
      const roms = choices.map((c) => `${esc(dosLabel(c.name))} (<code>${esc(c.rom)}</code>)`).join(' or ');
      box.innerHTML = `<div class="title">Drive ${open} · no disk ROM yet</div>
        <p class="note">Disks need a disk cartridge ROM: ${roms}. CLOADM doesn't include it; add your own, then click the drive again.</p>
        <div class="bar">${openRoms ? '<button id="driveRoms" class="primary">Add ROMs…</button>' : ''}<button id="driveClose">Close</button></div>`;
    } else {
      const pick = !st.dos && choices.filter((c) => !c.builtin).length > 1;
      // a new, empty disk: the sizes the disk system usually uses, each in its usual format (changeable)
      const blanks = session.blankDiskChoices();
      box.innerHTML = `<div class="title">Drive ${open} · insert a disk</div>
        ${err}
        ${pick ? `<label class="row"><span>Cartridge</span><select id="driveDos">${choices.map((c) => `<option value="${c.id}"${c.ready ? '' : ' disabled'}>${esc(c.name)}${c.ready ? '' : ' (ROM needed)'}</option>`).join('')}</select></label>` : ''}
        <div class="bar"><button id="driveFile" class="primary">From a file…</button></div>
        <div class="bar" id="driveStoredRow" hidden><select id="driveStored" aria-label="Disks in your library"></select><button id="driveMount">Insert</button></div>
        ${blanks.length ? `<div class="bar" id="driveNewRow"><select id="driveNewSize" aria-label="Size of the new disk">${blanks.map((b, i) => `<option value="${i}">${esc(b.label)}</option>`).join('')}</select>
          <select id="driveNewFormat" aria-label="Image format of the new disk"><option value="vdk">VDK</option><option value="jvc">JVC (.dsk)</option><option value="dmk">DMK</option></select>
          <button id="driveNew">New blank disk</button></div>` : ''}
        <label><input type="checkbox" id="driveNewWp"> Write-protect</label>
        <div class="bar"><button id="driveClose">Close</button></div>`;
      if (pick) { const p = session.preferredDiskDos(); if (p) $('driveDos').value = p.id; }
      if (blanks.length) newSize(0);
      let disks = [];
      try { disks = await session.listDisks(); } catch (e) { /* the store says nothing: no list */ }
      const held = new Set(st.drives.map((x) => x.name));
      // a store that does not tell upper from lower case has one entry for both spellings, so the list must too
      const isHeld = (n) => held.has(n) || (session.caseInsensitive && [...held].some((h) => h.toLowerCase() === n.toLowerCase()));
      const free = disks.filter((x) => !isHeld(x.name));
      if ($('driveStored')) {
        $('driveStored').innerHTML = free.map((x) => `<option value="${esc(x.name)}">${esc(x.name.split('/').pop())} (${Math.round(x.size / 1024)}K)</option>`).join('');
        $('driveStoredRow').hidden = !free.length;
      }
    }
    box.hidden = false;
  }
  // a size picked for the new disk: its usual format; DMK only for a double-sided one (js/media/disk.js blankDisk)
  const newSize = (i) => {
    const b = session.blankDiskChoices()[i], dmk = $('driveNewFormat').querySelector('option[value="dmk"]');
    dmk.disabled = b.heads !== 2;
    dmk.title = dmk.disabled ? 'A DMK blank is double-sided' : '';
    $('driveNewFormat').value = b.format;
  };
  const chooseDos = () => {
    const sel = $('driveDos');
    if (sel && !session.diskStatus().dos && sel.value !== (session.preferredDiskDos() || {}).id) session.insertDiskDos(sel.value);
  };

  $('drives').onclick = (e) => {
    const b = e.target.closest('[data-drive]');
    if (!b) return;
    const n = Number(b.dataset.drive);
    open = open === n ? null : n;
    menuError = null;
    render();
  };
  $('driveMenu').onclick = (e) => {
    const id = e.target.id, n = open;
    if (id === 'driveClose') closeMenu();
    else if (id === 'driveRoms') openRoms();
    else if (id === 'driveDownload') run(async () => { const d = await session.downloadDisk(n); page.download(d.name, d.bytes); return `Saved ${d.name}`; });
    else if (id === 'driveEject') run(async () => { await session.ejectDisk(n); open = null; return `Drive ${n} ejected`; });
    else if (id === 'driveFile') { $('fileDisk').dataset.drive = String(n); $('fileDisk').click(); }
    else if (id === 'driveNew') {
      const b = session.blankDiskChoices()[Number($('driveNewSize').value)];
      run(async () => { chooseDos(); const msg = await session.newDisk(n, { format: $('driveNewFormat').value, tracks: b.tracks, heads: b.heads }, { writeProtected: $('driveNewWp').checked }); open = null; return msg; });
    } else if (id === 'driveMount') run(async () => { chooseDos(); const msg = await session.mountDisk(n, $('driveStored').value, { writeProtected: $('driveNewWp').checked }); open = null; return msg; });
  };
  // closed, with the focus back on the drive's own button (refocus), or left where an outside press put it
  function closeMenu(refocus = true) {
    const n = open;
    open = null; menuError = null; render();
    const b = n === null ? null : $('drives').querySelector(`[data-drive="${n}"]`);
    if (refocus) { if (b) b.focus(); else page.focus(); }
  }
  // open only while it shows (a view in the emulator's place hides it with the rest of the page)
  const menuOpen = () => !$('driveMenu').hidden && $('driveMenu').checkVisibility();
  page.onEscape(ESC.menu, menuOpen, () => closeMenu());
  page.outsidePress(menuOpen, (t) => $('driveMenu').contains(t) || $('drives').contains(t), closeMenu);
  $('driveMenu').onchange = (e) => {
    if (e.target.id === 'driveNewSize') newSize(Number(e.target.value));
    if (e.target.id === 'driveWp') { const n = open; run(() => { session.setDiskWriteProtect(n, e.target.checked); return `Drive ${n} ${e.target.checked ? 'write-protected' : 'writable'}`; }); }
  };
  $('fileDisk').onchange = async (e) => {
    const f = e.target.files[0]; e.target.value = '';
    if (!f) return;
    const n = Number(e.target.dataset.drive || 0), wp = !!($('driveNewWp') && $('driveNewWp').checked);
    const bytes = await page.readFile(f);
    run(async () => { chooseDos(); const msg = await session.importDisk(f.name, bytes, n, { writeProtected: wp }); open = null; return msg; });
  };

  session.on((ev) => {
    if (ev === 'machine') open = null;
    if (ev === 'machine' || ev === 'disks' || ev === 'roms' || ev === 'firmware') render();
    if (ev === 'diskerror') session.diskWritesDone().catch((err) => page.status(err.message, true));
  });
  // the activity lights follow the controller, sampled every displayed frame; a light stays on at least
  // LIT_MS so a short command (a seek, a refused write) is still seen, as a real drive's LED is
  const LIT_MS = 150, litUntil = [0, 0, 0, 0];
  const lights = (now) => {
    if (!$('driveSlot').hidden) {
      const act = session.diskActivity();
      for (const b of $('drives').querySelectorAll('[data-drive]')) {
        const n = Number(b.dataset.drive), led = b.querySelector('.led');
        if (act[n]) litUntil[n] = now + LIT_MS;
        if (led) led.classList.toggle('on', now < litUntil[n]);
      }
    }
    requestAnimationFrame(lights);
  };
  requestAnimationFrame(lights);
  render();
  // a disk image dropped or loaded as a program: into the first empty drive
  return {
    insert: (name, bytes) => run(() => {
      const st = session.diskStatus();
      let n = 0;
      while (n < st.count - 1 && st.drives.some((d) => d.drive === n)) n++;
      return session.importDisk(name, bytes, n);
    }),
  };
}
