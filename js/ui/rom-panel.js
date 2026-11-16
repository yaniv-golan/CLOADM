/*
 * ROM input: files, folders and ZIPs (dropped on the screen or picked), ROM packs in and out. ROMs are
 * identified across every machine by the Session (js/roms.js); this module gathers the files and reports.
 */
import { Session } from '../session.js';
import { keepStorage } from '../host/storage.js';
import { readZip } from '../media/zip.js';
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
    if (onRoms) { if (unrowed.length) page.status(unrowed.join(' · '), true); return; }
    const n = report.restored || loaded.length;
    const what = report.restored ? `${n} ${n === 1 ? 'ROM' : 'ROMs'} restored from your ROM pack` : n ? `${n === 1 ? 'ROM' : `${n} ROMs`} added` : '';
    const text = [what, ready.length && `${ready.join(', ')} ready`].filter(Boolean).join(' · ');
    const extra = [report.ignored.length && `Not ROMs: ${report.ignored.join(', ')}`, ...problems].filter(Boolean);
    if (!text) { page.status(extra.length ? `No ROMs could be used. ${extra.join(' · ')}` : 'No ROMs found', true); return; }
    page.toast(text, extra.length ? { details: extra.join(' · '), error: problems.length > 0 } : {});
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
      const res = session.addRoms(roms);
      report.files = res.files; report.machines.push(...res.machines); report.offers = res.offers;
      report.ignored.push(...res.files.filter((f) => f.result === 'ignored').map((f) => f.name));
    }
    report.ignored.push(...other.filter((f) => f.from).map((f) => f.from + f.name));
    const loose = other.filter((f) => !f.from);
    if (roms.length || report.restored || report.ignored.length || report.errors.length || report.skipped.length) { summarise(report); changed(report); }
    // the first ROMs stored: ask the browser to keep them (it may otherwise clear site storage when space runs
    // low), and say which it is
    if ((roms.length || report.restored) && session.hasAnyRoms && !keepAsked) {
      keepAsked = true;
      const said = { kept: 'Your ROMs are kept in this browser.', 'may-clear': 'This browser may clear them when space runs low: Save ROM pack… keeps a copy.' }[await keepStorage()];
      // said with what the drop reported, in the same toast
      if (said) { const cur = page.feedback.current; page.status(cur ? `${cur.text}. ${said}` : said, !!(cur && cur.error)); }
    }
    if (loose.length && onPrograms) await onPrograms(loose);
    page.focus();
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
  $('btnRomClear').onclick = () => { session.clearRoms(); page.status(`${session.machine.profile.name}: ROMs removed – running without ROMs`); changed(null); };

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
    const res = session.addRoms(named);
    const report = { files: res.files, machines: res.machines, offers: res.offers, ignored: [], errors: [], skipped: [], restored: 0 };
    summarise(report); changed(report);
  }
  return { take, droppedFiles, loadRomUrls, saveRomPack, onChange: (fn) => listeners.add(fn) };
}
