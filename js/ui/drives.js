/* The disk drives card under the screen ("Drives · {dos} · click a drive to insert", a 2 x 2
 * grid; a loaded drive shows its activity light and the image's name, an empty one "n · Insert…"). Clicking a
 * drive opens its menu under the grid: an empty drive takes a file, a disk stored in the browser (the
 * Library's disks, under disks/) or a new blank disk (Session.newDisk: a size the disk system uses, VDK, JVC or
 * DMK), with write-protect; a loaded one has write-protect, Download and Eject.
 * The menu and the disk error states follow the slots (the cassette's buttons, the
 * orange the design keeps for warnings, the status line every slot reports on) and say what to do next:
 *   no disk ROM          the header says so ("disks work for programs that read them directly"): a disk still goes
 *                        in, on the disk controller alone (Session.mountDisk plugs it in with no ROM), and the menu
 *                        offers Insert disk…, New blank disk and From Library… (and Eject), with a note naming the
 *                        disk ROM that DIR and the other disk commands need and "Add disk ROM…"; a mount says the
 *                        same in its toast, with the same button. A disk ROM added meanwhile goes in at the next
 *                        reset or power cycle: the header says so (the drop's toast and the disk ROM card too)
 *   an insert refused    the reason on the status line and in the drive's menu, which stays open
 *   a write refused      the drive is marked "not saved" in orange (its changes are only in the drive); its menu
 *                        says why and offers Download to keep them; the mark goes when a write succeeds
 *   a snapshot's disk    marked "snapshot": it is the snapshot's own copy, not the image in the library */
import { $, ESC } from './page.js';
import { SessionError, BARE_NOTE } from '../session.js';

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
// the card's short label for the disk system
const dosLabel = (name) => name.replace(/ cartridge$/, '');
// the disk systems a note names: "DragonDOS or Delta DOS", "Disk BASIC"
const dosNames = (choices) => choices.filter((c) => !c.builtin).map((c) => dosLabel(c.name).replace(/ \(RS-DOS\)$/, '')).join(' or ');
// a loaded drive's label: "n · file", the file split so the page can shorten the middle of a long name and keep its end
const TAIL = 15, LONG = 14;   // a name longer than LONG does not fit a half-width tile: the card goes one drive to a row
const driveLabel = (n, file) => file.length > TAIL + 4
  ? `<span class="dh">${n} · ${esc(file.slice(0, -TAIL))}</span><span class="dt">${esc(file.slice(-TAIL))}</span>`
  : `<span class="dh">${n} · ${esc(file)}</span>`;

// The card's header, "Drives · {dos} · {hint}": the disk system in use or the one a mount would plug in; with none,
// "no disk ROM" (a disk still goes in, on the controller alone). A controller with no ROM says its disk ROM goes in at
// the next reset only when one is stored for it and a reset would put it in (Session.diskRomWaiting: not while NitrOS-9
// runs on that controller, whose reset restarts NitrOS-9). -> { dos, hint }
export function driveHeader(session, st = session.diskStatus()) {
  const direct = 'disks work for programs that read them directly';
  if (st.dos && st.dos.bare) {
    return session.diskRomWaiting ? { dos: `${dosLabel(session.preferredDiskDos().name)} at the next reset`, hint: `${direct} until then` } : { dos: 'no disk ROM', hint: direct };
  }
  const dos = st.dos || session.preferredDiskDos();
  if (!dos) return { dos: 'no disk ROM', hint: direct };
  return { dos: dos.id === 'builtin' || dos.builtin ? 'built-in' : dosLabel(dos.name), hint: 'click a drive to insert' };
}

export function setupDrives(page, { openRoms = null } = {}) {
  const { session } = page;
  let open = null;            // the drive whose menu is open
  let menuError = null;       // why the last action in the open menu failed
  let library = false;        // the no-disk-ROM menu's "From Library…" row is showing

  // what a mount said: a disk on the controller alone (no disk ROM) has the toast's "Add disk ROM…"
  const said = (msg) => {
    if (msg && msg.endsWith(BARE_NOTE) && openRoms) page.toast(msg, { action: { label: 'Add disk ROM…', run: openRoms } });
    else if (msg) page.status(msg);
  };
  // no disk ROM in use or stored: disks go in on the controller alone
  const noDiskRom = (st, choices) => (!st.dos || st.dos.bare) && !choices.some((c) => c.ready && !c.builtin);
  const run = async (fn) => {
    menuError = null;
    try { said(await fn()); }
    catch (e) { page.status(e.message, true); if (open !== null) menuError = e.message; if (!(e instanceof SessionError)) console.error(e); }
    render();
  };

  function render() {
    const choices = session.diskDosChoices();
    $('driveSlot').hidden = !choices.length;
    if (!choices.length) { open = null; $('driveMenu').hidden = true; return; }
    const st = session.diskStatus();
    const head = driveHeader(session, st);
    $('driveDos').textContent = head.dos;
    $('driveHint').textContent = head.hint;
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
    if (noDiskRom(st, choices)) {
      // no disk ROM: the disk goes in on the controller alone; the note says what that leaves out
      box.innerHTML = `<div class="title">Drive ${open} · ${d ? esc(d.file) : 'empty'}${d && !d.stored ? ' (from the snapshot)' : ''}</div>
        ${d && d.unsaved ? `<p class="error">${esc(d.unsaved)} The changes are only in the drive: Download keeps them.</p>` : ''}
        ${err}
        <div class="bar"><button id="driveFile" class="primary">Insert disk…</button><button id="driveNew">New blank disk</button>
          <button id="driveLib" aria-expanded="${library}" aria-controls="driveStoredRow">From Library…</button>${d ? '<button id="driveDownload">Download</button><button id="driveEject">Eject</button>' : ''}</div>
        <div class="bar" id="driveStoredRow" hidden><select id="driveStored" aria-label="Disks in your library"></select><button id="driveMount">Insert</button></div>
        <label><input type="checkbox" id="${d ? 'driveWp' : 'driveNewWp'}"${d && d.writeProtected ? ' checked' : ''}> Write-protect</label>
        <p class="note muted" id="driveNoRom">No disk ROM: DIR and other disk commands need ${esc(dosNames(choices))} (your own file).
          ${openRoms ? '<button id="driveRoms" class="link">Add disk ROM…</button>' : ''}</p>
        <div class="bar"><button id="driveClose">Close</button></div>`;
      await storedDisks(st, () => library);
    } else if (d) {
      box.innerHTML = `<div class="title">Drive ${open} · ${esc(d.file)}${d.stored ? '' : ' (from the snapshot)'}</div>
        ${d.unsaved ? `<p class="error">${esc(d.unsaved)} The changes are only in the drive: Download keeps them.</p>` : ''}
        ${!d.stored ? '<p class="note">This is the snapshot\'s own copy of the disk, not the one in your library. Download keeps it.</p>' : ''}
        ${err}
        <label><input type="checkbox" id="driveWp"${d.writeProtected ? ' checked' : ''}> Write-protect</label>
        <div class="bar"><button id="driveDownload">Download</button><button id="driveEject">Eject</button><button id="driveClose">Close</button></div>`;
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
      await storedDisks(st, () => true);
    }
    box.hidden = false;
  }
  // the Library's disks no drive holds, in the menu's list; its row shows when shown() says so and there are some.
  // Without any, the no-disk-ROM menu's "From Library…" is disabled and says why
  async function storedDisks(st, shown) {
    let disks = [];
    try { disks = await session.listDisks(); } catch (e) { /* the store says nothing: no list */ }
    const held = new Set(st.drives.map((x) => x.name));
    // a store that does not tell upper from lower case has one entry for both spellings, so the list must too
    const isHeld = (n) => held.has(n) || (session.caseInsensitive && [...held].some((h) => h.toLowerCase() === n.toLowerCase()));
    const free = disks.filter((x) => !isHeld(x.name));
    if ($('driveStored')) {
      $('driveStored').innerHTML = free.map((x) => `<option value="${esc(x.name)}">${esc(x.name.split('/').pop())} (${Math.round(x.size / 1024)}K)</option>`).join('');
      $('driveStoredRow').hidden = !free.length || !shown();
    }
    if ($('driveLib')) {
      $('driveLib').disabled = !free.length;
      $('driveLib').title = free.length ? '' : 'No other disks in your Library';
    }
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
    menuError = null; library = false;
    render();
  };
  $('driveMenu').onclick = (e) => {
    const id = e.target.id, n = open;
    if (id === 'driveClose') closeMenu();
    else if (id === 'driveRoms') openRoms();
    else if (id === 'driveLib') { library = !library; $('driveStoredRow').hidden = !library; e.target.setAttribute('aria-expanded', String(library)); if (library) $('driveStored').focus(); }
    else if (id === 'driveDownload') run(async () => { const d = await session.downloadDisk(n); page.download(d.name, d.bytes); return `Saved ${d.name}`; });
    else if (id === 'driveEject') run(async () => { await session.ejectDisk(n); open = null; return `Drive ${n} ejected`; });
    else if (id === 'driveFile') { $('fileDisk').dataset.drive = String(n); $('fileDisk').click(); }
    else if (id === 'driveNew') {
      // the size and format chosen, or (the no-disk-ROM menu has no choice) the disk system's first size
      const b = session.blankDiskChoices()[$('driveNewSize') ? Number($('driveNewSize').value) : 0];
      const format = $('driveNewFormat') ? $('driveNewFormat').value : b.format, wp = !!($('driveNewWp') && $('driveNewWp').checked);
      run(async () => { chooseDos(); if (session.diskStatus().drives.some((x) => x.drive === n)) await session.ejectDisk(n); const msg = await session.newDisk(n, { format, tracks: b.tracks, heads: b.heads }, { writeProtected: wp }); open = null; return msg; });
    } else if (id === 'driveMount') run(async () => { chooseDos(); const msg = await session.mountDisk(n, $('driveStored').value, { writeProtected: !!($('driveNewWp') && $('driveNewWp').checked) }); open = null; return msg; });
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
    if (ev === 'machine') { open = null; library = false; }
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
  // the first empty drive (the last one when every drive holds a disk), as a dropped disk goes
  const freeDrive = () => {
    const st = session.diskStatus();
    let n = 0;
    while (n < st.count - 1 && st.drives.some((d) => d.drive === n)) n++;
    return n;
  };
  // none of this machine's drives can take a disk: say so, as a mount would
  const noDrives = () => { if (session.diskDosChoices().length) return false; page.status(`The ${session.personMachine.profile.name} has no disk drives in CLOADM. Disks go in on the Dragons and the CoCos.`, true); return true; };
  // said: what a mount elsewhere (the Library) reports, with the same toast. pick, blank and eject: the command box's
  // "Insert a disk…", "New blank disk" and "Eject disk", on the first free drive (eject: the last drive with a disk)
  const api = {
    said,
    insert: (name, bytes) => run(() => session.importDisk(name, bytes, freeDrive())),
    pick: () => { if (noDrives()) return; $('fileDisk').dataset.drive = String(freeDrive()); $('fileDisk').click(); },
    blank: () => {
      if (noDrives()) return;
      const n = freeDrive(), b = session.blankDiskChoices()[0];
      return run(async () => { if (session.diskStatus().drives.some((d) => d.drive === n)) await session.ejectDisk(n); return session.newDisk(n, b); });
    },
    eject: () => run(async () => {
      const held = session.diskStatus().drives;
      if (!held.length) throw new SessionError('There is no disk in a drive.');
      const n = held[held.length - 1].drive;
      await session.ejectDisk(n);
      return `Drive ${n} ejected`;
    }),
  };
  page.drives = api;
  return api;
}
