/*
 * ROM input: files, folders and ZIPs (dropped on the screen or picked), ROM packs in and out. ROMs are
 * identified across every machine by the Session (js/roms.js); this module gathers the files and reports.
 */
import { Session } from '../session.js';
import { keepStorage } from '../host/storage.js';
import { readZip } from '../media/zip.js';
import { looksLikeSnapshot } from '../media/snapshot.js';
import { detectMedia } from '../media/detect.js';
import { $ } from './page.js';
import { currentView } from './feedback.js';
import { droppedFiles, expand, pickedFiles } from './files.js';

// never fetch from the ROM archive: it is only ever an outbound link
const ARCHIVE_HOST = /(^|\.)colorcomputerarchive\.com$/i;

export function setupRomPanel(page) {
  let keepAsked = false;   // navigator.storage.persist() asked once a visit, after the first ROMs are stored
  const { session } = page;
  const listeners = new Set();
  // after each ROM change: { files, machines, offers, ignored, errors, skipped }
  const changed = (report) => { for (const fn of listeners) fn(report); };

  function summarise(report) {
    const loaded = report.files.filter((f) => f.result === 'verified' || f.result === 'loaded-unrecognised');
    const problems = report.files.filter((f) => f.result === 'rejected').map((f) => f.message).concat(report.errors, report.skipped);
    const ready = report.machines.filter((x) => x.bootable).map((x) => x.name);
    // on Your ROMs each file's result shows on its row (inline): only what has no row is said there. From any
    // other page: a toast, "BASIC added · Dragon 64 ready" (with Details for what could not be used)
    const onRoms = currentView() === 'roms';
    const unrowed = report.errors.concat(report.skipped);
    // On Your ROMs the note goes NEXT TO the socket list, not in a toast: a toast at the bottom of the window was
    // the only place this said anything, and on a phone (and a 900px desktop) the list it is about can be scrolled
    // past while the note sits below the fold. It stays until the next ROM change.
    if (onRoms) {
      notRoms(report.files.filter((f) => f.notRom).map((f) => f.name));
      const box = $('romProblems');
      // (files that weren't ROM images are said beside the drop zone instead: notRoms)
      const lines = report.files.filter((f) => f.result === 'rejected' && !f.notRom).map((f) => f.message).concat(unrowed);
      box.textContent = lines.join(' · ');
      box.hidden = !lines.length;
      return;
    }
    const n = report.restored || loaded.length;
    const what = report.restored ? `${n} ${n === 1 ? 'ROM' : 'ROMs'} restored from your ROM pack` : n ? `${n === 1 ? 'ROM' : `${n} ROMs`} added` : '';
    // a disk ROM for the disk controller in use, which went in without one: it goes in at the next reset or power cycle
    const disk = session.drives.romWaiting && session.drives.preferredDos();
    const waiting = disk && `your ${disk.name.replace(/ cartridge$/, '')} disk ROM goes in at the next reset or power cycle`;
    const text = [what, ready.length && `${ready.join(', ')} ready`, waiting].filter(Boolean).join(' · ');
    const extra = [report.ignored.length && `Not ROMs: ${report.ignored.join(', ')}`, ...problems].filter(Boolean);
    if (!text) { page.status(extra.length ? `No ROMs could be used. ${extra.join(' · ')}` : 'No ROMs found', true); return; }
    page.toast(text, extra.length ? { details: extra.join(' · '), error: problems.length > 0 } : {});
  }

  // Files that weren't ROM images at all, dropped on Add ROMs: an error toast and a line beside the drop zone (the
  // "What you dropped" card, further down, keeps the record of every file). One file is named; several are counted,
  // and the line and the toast lead to the card.
  function notRoms(names) {
    const note = $('romDropNote');
    if (!names.length) { note.hidden = true; note.replaceChildren(); return; }
    const one = names.length === 1;
    const text = one ? `${names[0]} isn't a ROM image, so it wasn't added.` : `${names.length} files weren't ROM images, so they weren't added.`;
    const toCard = () => { const card = document.querySelector('#romCard .found'); card.scrollIntoView({ block: 'center' }); card.focus({ preventScroll: true }); };
    note.replaceChildren(document.createTextNode(text));
    if (!one) {
      const b = document.createElement('button');
      b.className = 'link'; b.type = 'button'; b.textContent = 'See What you dropped.';
      b.onclick = toCard;
      note.append(' ', b);
    }
    note.hidden = false;
    page.toast(text, { error: true, details: null, ...(one ? {} : { action: { label: 'See What you dropped.', run: toCard } }) });
  }

  // gathered files -> ROMs (and loose non-ROM files back to the caller). `all` takes every loose file as a
  // ROM candidate (the ROM file picker); files from a folder or ZIP are taken only when recognised.
  async function take(list, { all = false, onPrograms = null } = {}) {
    const report = { files: [], machines: [], offers: [], ignored: [], errors: [], skipped: [], restored: 0 };
    // ROM packs are restored as they are; other ZIPs are opened
    const rest = [];
    for (const item of list) {
      if (/\.zip$/i.test(item.file.name)) {
        try {
          const entries = readZip(new Uint8Array(await item.file.arrayBuffer()));
          if (Session.isRomPack(entries)) {
            const r = session.importRomPack(entries);
            report.machines.push(...r.machines); report.skipped.push(...r.skipped);
            report.restored += r.machines.reduce((t, m) => t + m.sockets.filter((s) => s.crc).length, 0);
            continue;
          }
        } catch (e) { report.errors.push(`${item.file.name}: ${e.message}`); continue; }
      }
      rest.push(item);
    }
    const { files, errors } = await expand(rest);
    report.errors.push(...errors);
    const roms = [], other = [];
    for (const f of files) ((all && !f.from) || Session.isRom(f.name, f.bytes) ? roms : other).push(f);
    if (roms.length) {
      // the Session refuses a drop while the library moves (it writes the library's index): say so as a report, so
      // the drop's other files are still handled and nothing is left as a rejection nothing waits for
      let res;
      try { res = session.addRoms(roms); }
      catch (e) { report.errors.push(e.message); }
      if (res) { report.files = res.files; report.machines.push(...res.machines); report.offers = res.offers;
        report.ignored.push(...res.files.filter((f) => f.result === 'ignored').map((f) => f.name)); }
    }
    // The files the drop is not putting in a socket go to the program loader when there is one (Open…, a drop on the
    // page): loose files, and the openable ones out of a folder or ZIP — a ZIP of programs is opened, not judged as a
    // bad drop of ROMs (OPENS_TEXT names "ZIPs of these"). What CLOADM cannot open at all (a readme, a photo: a raw
    // kind that is not a snapshot) is not the loader's to refuse one by one: from an archive it stays what it always
    // was, "Not ROMs:", the report a drop of ROMs makes. Without a loader (the Add ROMs screen) nothing else is
    // claimed for it either: an archive's non-ROM entries are what that screen refuses, said the same way.
    // A cartridge out of a folder or archive is openable (that is what OPENS_TEXT promises: carts load), with one
    // exception: a `.rom` that is not a ROM image is a cartridge only by its extension, and `.rom` is also what a
    // ROM dump usually carries — an unrecognised one (no known CRC, no usual name: Session.isRom's bar) is a dump
    // this drop cannot place, not a program to run. Loose it would go to the Add ROMs reading and by size alone
    // (all: true, which asks nothing of the name or the CRC); from an archive it is reported as before ("Not
    // ROMs"), the same trap the open-rom fix closed: a machine's BASIC must not end up in the cartridge slot.
    // `.ccc` and `.dgn` are not touched: those extensions name cartridge images and nothing else, so an archive
    // entry carrying one is a cartridge by its own declaration.
    const romShaped = (f) => /\.rom$/i.test(f.name);
    const openable = (f) => !romShaped(f) && (detectMedia(f.name, f.bytes).kind !== 'raw' || looksLikeSnapshot(f.name, f.bytes));
    const loose = other.filter((f) => !f.from || (onPrograms && openable(f)));
    report.ignored.push(...other.filter((f) => f.from && !(onPrograms && openable(f))).map((f) => f.from + f.name));
    if (roms.length || report.restored || report.ignored.length || report.errors.length || report.skipped.length) { summarise(report); changed(report); }
    // the first ROMs stored: ask the browser to keep them (it may otherwise clear site storage when space runs
    // low), and say which it is
    if ((roms.length || report.restored) && session.hasAnyRoms && !keepAsked) {
      keepAsked = true;
      const said = { kept: 'Your ROMs are kept in this browser.', 'may-clear': 'This browser may clear them when space runs low: Save ROM pack… keeps a copy.' }[await keepStorage()];
      // said with what the drop reported, in the same toast
      if (said) { const cur = page.feedback.current; page.status(cur ? `${cur.text}. ${said}` : said, !!(cur && cur.error)); }
    }
    // (the program loader settles the focus itself: an offer it shows keeps it)
    if (loose.length && onPrograms) await onPrograms(loose);
    else page.focus();
  }

  function saveRomPack() {
    if (!session.roms.sockets().length) { page.status('No ROMs stored in this browser yet', true); return; }
    const pack = session.exportRomPack();
    page.download(pack.name, pack.bytes, 'application/zip');
    page.status(`Saved ${pack.name}: your ROMs as one file. Drop it on CLOADM in another browser to restore them.`);
  }

  $('btnRomFiles').onclick = () => $('fileRom').click();
  $('fileRom').onchange = async (e) => { const l = pickedFiles(e.target); e.target.value = ''; await take(l, { all: true }); };
  $('folderRom').onchange = async (e) => { const l = pickedFiles(e.target); e.target.value = ''; await take(l); };
  $('btnRomFolder').onclick = () => $('folderRom').click();
  $('btnRomPack').onclick = saveRomPack;
  $('btnRomClear').onclick = () => page.attempt(() => { session.clearRoms(); changed(null); return `${session.personMachine.profile.name}: ROMs removed – running without ROMs`; });

  // ?rom=URL: ROMs the user hosts (CORS required). The ROM archive is never requested.
  async function loadRomUrls(urls) {
    const named = [];
    for (const url of urls) {
      if (ARCHIVE_HOST.test(new URL(url, location.href).hostname)) throw new Error('CLOADM never downloads ROMs from the Color Computer Archive; download them yourself and drop them on the page');
      // a redirect is not followed: it could lead to the archive the check above refuses
      let bytes;
      try { bytes = await page.fetchBytes(url, { redirect: 'error' }); }
      catch (e) { throw new Error(`${url}: could not be fetched (a ROM URL that redirects is not followed: give its final address)`); }
      named.push({ name: decodeURIComponent(url.split('/').pop().split('?')[0]), bytes });
    }
    // an addRoms refusal (the library is being moved) reaches the link's caller, which says so on the status line
    const res = session.addRoms(named);
    const report = { files: res.files, machines: res.machines, offers: res.offers, ignored: [], errors: [], skipped: [], restored: 0 };
    summarise(report); changed(report);
  }
  return { take, droppedFiles, loadRomUrls, saveRomPack, onChange: (fn) => listeners.add(fn) };
}
