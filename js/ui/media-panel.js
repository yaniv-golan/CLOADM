/* Programs, tapes and the examples menu; snapshot files go to the snapshot panel. */
import { $, ESC } from './page.js';
import { inspectOs9Disk } from '../media/os9.js';

const parseHex = (s) => {
  if (s == null) return null;
  const v = parseInt(s.trim().replace(/^(\$|&h|0x)/i, ''), 16);
  return isNaN(v) ? null : v & 0xFFFF;
};
// raw data of unknown format: ask where it goes
const askAddresses = (name, size) => {
  const load = parseHex(prompt(`${name}: unknown format (${size} bytes).\nLoad address (hex):`, '0E00'));
  if (load == null) return null;
  return { load, exec: parseHex(prompt('Execution address (hex), blank for none:', load.toString(16).toUpperCase())) };
};

// snapshots: the snapshot panel (snapshot files open there); disks: the disk panel (disk images go into a drive);
// keep(name, bytes): a file the user loaded, to keep in the Library
export function setupMediaPanel(page, { snapshots, disks, nitros9, keep }) {
  const { session, audio } = page;
  session.fastCas = $('chkFastCas').checked;
  $('chkFastCas').onchange = (e) => { session.fastCas = e.target.checked; };

  const doLoad = (name, bytes) => { audio.start(); if (page.attempt(() => session.load(name, bytes, { askAddresses }))) keep(name, bytes); };
  // media for another machine: offer to open it there or load it anyway; disk images go into a drive
  const offer = $('mediaOffer');
  async function loadProgram(name, bytes) {
    if (await snapshots.take(name, bytes)) return;
    const media = session.inspect(name, bytes), mm = media.mismatch;
    offer.hidden = true;
    // a NitrOS-9 boot disk (DriveWire or floppy): boot it (on the CoCo 3), or put it in a floppy drive all the same
    const n9 = media.kind === 'disk' ? inspectOs9Disk(bytes) : null;
    if (n9 && !n9.reason) {
      $('mediaOfferText').textContent = `${name} is a NitrOS-9${n9.cpu ? '/' + n9.cpu : ''} ${n9.boot === 'floppy' ? 'floppy' : 'DriveWire'} boot disk.` +
        (session.constructor.NITROS9_MACHINES.includes(session.personMachine.id) ? '' : ' It boots on the CoCo 3.');
      $('btnMediaSwitch').textContent = 'Boot NitrOS-9';
      $('btnMediaSwitch').onclick = () => { offer.hidden = true; nitros9.bootFile(name, bytes); };
      $('btnMediaAnyway').onclick = () => { offer.hidden = true; disks.insert(name, bytes); page.focus(); };
      $('btnMediaAnyway').dataset.label = $('btnMediaAnyway').textContent;
      $('btnMediaAnyway').textContent = 'Put it in a floppy drive';
      offer.hidden = false;
      $('btnMediaSwitch').focus();
      return;
    }
    if ($('btnMediaAnyway').dataset.label) $('btnMediaAnyway').textContent = $('btnMediaAnyway').dataset.label;
    if (media.kind === 'disk' && !mm) { audio.start(); await disks.insert(name, bytes); return; }
    if (!mm) { doLoad(name, bytes); return; }
    const m = session.personMachine;
    // said once: "dgame.dgn is a Dragon cartridge; the CoCo 1/2 may not run it." The family is named only where
    // the format doesn't name it, and the reason only where it adds something
    const what = media.format.includes(mm.familyName) ? media.format : `${media.format} for a ${mm.familyName}`;
    const why = media.reason && !media.reason.toLowerCase().includes(media.format.toLowerCase()) ? ` (${media.reason})` : '';
    $('mediaOfferText').textContent = `${name} is a ${what}${why}; the ${m.profile.name} may not run it.`;
    $('btnMediaSwitch').textContent = `Open on ${mm.suggestName}`;
    $('btnMediaSwitch').onclick = () => { offer.hidden = true; session.switchMachine(mm.suggest); if (media.kind === 'disk') disks.insert(name, bytes); else doLoad(name, bytes); page.focus(); };
    $('btnMediaAnyway').onclick = () => { offer.hidden = true; if (media.kind === 'disk') disks.insert(name, bytes); else doLoad(name, bytes); page.focus(); };
    offer.hidden = false;
    $('btnMediaSwitch').focus();   // the offer has the keyboard (Esc dismisses it), as the other cards above the screen
  }
  // Esc dismisses the offer: nothing is loaded
  page.onEscape(ESC.card, () => !offer.hidden, () => { offer.hidden = true; page.focus(); });
  // items: [{ name, bytes }]
  async function loadPrograms(items) {
    for (const f of items) await loadProgram(f.name, f.bytes);
    if (offer.hidden) page.focus();
  }

  $('btnLoad').onclick = () => $('fileProgram').click();
  $('fileProgram').onchange = async (e) => {
    const files = [...e.target.files]; e.target.value = '';
    loadPrograms(await Promise.all(files.map(async (f) => ({ name: f.name, bytes: await page.readFile(f) }))));
  };
  $('btnTape').onclick = () => $('fileTape').click();
  $('fileTape').onchange = async (e) => {
    const f = e.target.files[0]; e.target.value = '';
    if (!f) return;
    const bytes = await page.readFile(f);
    if (page.attempt(() => session.insertTape(f.name, bytes))) keep(f.name, bytes);
    page.focus();
  };
  // the deck shows the position: no message (and Rewind is disabled while the deck is empty)
  $('btnRewind').onclick = () => { session.rewindTape(); page.focus(); };
  // Eject: the deck under the screen hides with the tape, so the focus goes to the slot's deck button (insert a tape)
  $('btnEjectTape').onclick = () => {
    if (!session.ejectTape()) return;
    $('btnTape').focus();
    page.status('Tape ejected.');
  };

  // recording what the machine writes (CSAVE, CSAVEM): Record arms the deck, a second click saves the .CAS
  const download = (name, bytes, type) => page.download(name, bytes, type);
  let lastRecording = null;
  // (the command box asks whether there is a recording to save as WAV when no tape is in)
  page.tape = { recorded: () => !!lastRecording };
  const showRecording = () => {
    const on = session.tapeRecording;
    $('btnRecord').setAttribute('aria-pressed', String(on));
    $('btnRecord').textContent = on ? 'Stop and save .CAS' : 'Record';
  };
  $('btnRecord').onclick = () => {
    if (!session.tapeRecording) { page.status(session.startTapeRecording()); showRecording(); page.focus(); return; }
    const r = session.stopTapeRecording();
    showRecording();
    lastRecording = r;
    if (!r.cas.length) { page.status('Nothing was written to tape (no blocks found in the recording).', true); return; }
    saveRecording(r);
    page.focus();
  };
  // A recording goes into the Library, named after the first file on it (Session.recordingName; a name already taken
  // gets " (2)"), with Download in its toast; where the browser keeps nothing ("Download and open files") it is
  // downloaded under that name instead
  async function saveRecording(r) {
    const named = session.constructor.recordingName(r.cas), wanted = named.name;
    const count = named.files > 1 ? ` (${named.files} files)` : '';
    if (session.media.kind === 'fallback') {
      download(wanted, r.cas, 'application/octet-stream');
      page.status(`Saved ${wanted}${count}.`);
      return;
    }
    let name = wanted;
    try {
      name = await session.library.uniqueName(wanted);
      await session.library.importMedia(name, r.cas);
    } catch (e) { page.status(`${name} wasn't saved to your Library: ${e.message}`, true); return; }
    page.toast(`Saved ${name} to your Library${count}.`, { action: { label: 'Download', run: () => download(name, r.cas, 'application/octet-stream') } });
  }
  // the tape in the deck as WAV; with no tape, the last recording as it was written
  $('btnTapeWav').onclick = () => {
    if (!session.personMachine.deck.tape && lastRecording) { download('recording.wav', lastRecording.wav, 'audio/wav'); page.status('Saved recording.wav'); return; }
    page.attempt(() => { const w = session.tapeWav(); download(w.name, w.bytes, 'audio/wav'); return `Saved ${w.name}`; });
  };
  session.on((ev) => { if (ev === 'machine') { lastRecording = null; showRecording(); } });
  // a recording still running when its machine goes (a switch, a snapshot opened): offer it before it is gone
  session.on((ev) => {
    if (ev !== 'recording' || !session.unsavedRecording) return;
    const r = session.unsavedRecording;
    session.unsavedRecording = null;
    const name = session.constructor.recordingName(r.cas).name;
    if (window.confirm(`The tape recording on the ${r.machine} was not saved (${r.blocks} blocks). Save ${name} before it is gone?`)) saveRecording(r);
  });

  return { loadProgram, loadPrograms };
}
