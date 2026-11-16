/* Programs, tapes and the examples menu; snapshot files go to the snapshot panel. */
import { $, ESC } from './page.js';

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
export function setupMediaPanel(page, { snapshots, disks, keep }) {
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
    if (media.kind === 'disk' && !mm) { audio.start(); await disks.insert(name, bytes); return; }
    if (!mm) { doLoad(name, bytes); return; }
    const m = session.machine;
    $('mediaOfferText').textContent = `${name} is a ${media.format} for a ${mm.familyName}` + (media.reason ? ` (${media.reason})` : '') +
      `. Your ${m.profile.name} may not run it.`;
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

  // recording what the machine writes (CSAVE, CSAVEM): Record arms the deck, a second click saves the .CAS
  const download = (name, bytes, type) => page.download(name, bytes, type);
  let lastRecording = null;
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
    download('recording.cas', r.cas, 'application/octet-stream');
    page.status(`Recorded ${r.blocks} block(s) in ${r.seconds.toFixed(1)} s${r.badBlocks ? `, ${r.badBlocks} damaged` : ''}: saved recording.cas (Save .WAV for the sound).`);
    page.focus();
  };
  // the tape in the deck as WAV; with no tape, the last recording as it was written
  $('btnTapeWav').onclick = () => {
    if (!session.machine.deck.tape && lastRecording) { download('recording.wav', lastRecording.wav, 'audio/wav'); page.status('Saved recording.wav'); return; }
    page.attempt(() => { const w = session.tapeWav(); download(w.name, w.bytes, 'audio/wav'); return `Saved ${w.name}`; });
  };
  session.on((ev) => { if (ev === 'machine') { lastRecording = null; showRecording(); } });
  // a recording still running when its machine goes (a switch, a snapshot opened): offer it before it is gone
  session.on((ev) => {
    if (ev !== 'recording' || !session.unsavedRecording) return;
    const r = session.unsavedRecording;
    session.unsavedRecording = null;
    if (window.confirm(`The tape recording on the ${r.machine} was not saved (${r.blocks} blocks). Save recording.cas before it is gone?`)) {
      download('recording.cas', r.cas, 'application/octet-stream');
      page.status(`Saved recording.cas (${r.blocks} blocks recorded on the ${r.machine})`);
    }
  });

  return { loadProgram, loadPrograms };
}
