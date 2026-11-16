/*
 * Adding ROMs, at /play/#add-roms instead of the emulator. It opens from
 * "No BASIC · Add ROMs", the Machine tab's "Add ROMs →", the Welcome menu's key 3, the boot help's "Add
 * ROMs", and anything else that needs ROMs. It shows:
 *  - the machine's sockets, each with what it takes (size, usual file names), whether it is required, and what
 *    it holds or what is missing and why it matters (a required socket: no BASIC without it; an optional one:
 *    what you lose);
 *  - a file that was loaded but is not a known dump, with what to do about it;
 *  - what each dropped file turned out to be (which machine and socket, verified or not, or why it was not
 *    used), the other machines a drop set up (with an offer to switch), and the ones already ready;
 *  - "Switch on the <machine>" once BASIC can boot: after a drop that made it ready, or while the machine runs
 *    the stub by choice (it then boots the ROMs); either way it goes back to the emulator;
 *  - "Run without ROMs", the ROM self-test, the ROM pack and "Remove ROMs".
 * Dropping files anywhere on the screen works as before; dropping on this screen takes them as ROMs. A ROM dropped
 * anywhere that could not be used (wrong size for its name, a socket already filled) opens this screen to say why.
 */
import { $ } from './page.js';

const kb = (n) => `${n / 1024} KB`;
// what an optional socket gives you, by socket id (what you miss without it)
const OPTIONAL_WHY = {
  extbas: 'Optional: without it you have Color BASIC only, with no PMODE graphics, PLAY or DRAW.',
  basic64: 'Optional: without it, EXEC stays in 32K mode.',
};
const el = (tag, text, cls) => { const e = document.createElement(tag); if (text != null) e.textContent = text; if (cls) e.className = cls; return e; };
const button = (text, fn, primary = false) => { const b = el('button', text, primary ? 'primary' : ''); b.onclick = fn; return b; };

export function setupRomSockets(page, romInput) {
  const { session } = page;
  const view = $('romCard');
  let offers = [];      // [{ machine, name, files }] from the last drop
  let found = null;     // the last drop's per-file results

  // ---------------- open and close (#add-roms) ----------------
  const isOpen = () => location.hash === '#add-roms';
  function show() {
    const open = isOpen();
    document.body.classList.toggle('roms-open', open);
    view.hidden = !open;
    if (open) { render(); $('romHeading').focus(); }
  }
  addEventListener('hashchange', show);
  const close = () => page.closeView();
  $('btnRomBack').onclick = (e) => { e.preventDefault(); close(); };
  $('btnRomJustLooking').onclick = close;

  // ---------------- the sockets ----------------
  function socketState(s) {
    if (s.status === 'verified') return `✓ ${s.file || 'loaded'} · Recognised`;
    if (s.status === 'loaded-unrecognised') return `◆ ${s.file || 'loaded'} · loaded, not recognised`;
    if (s.status === 'missing-required') return 'Waiting for a file. Without it there is no BASIC: the machine runs without ROMs, machine-code programs only.';
    return OPTIONAL_WHY[s.id] || 'Optional.';
  }
  // drawn only while the screen is open (show() draws it on opening)
  function render() {
    if (!isOpen() || !session.machine) return;
    const m = session.machine, info = session.machineRoms(), name = m.profile.name;
    $('romMachine').textContent = name.toUpperCase();
    $('romSockets').replaceChildren(...info.sockets.map((s) => {
      const card = el('div', null, 'socket');
      card.dataset.socket = s.id; card.dataset.status = s.status;
      const body = el('div', null, 'body'), top = el('div', null, 'top');
      top.append(el('strong', s.label), el('span', s.required ? 'required' : 'optional', s.required ? 'tag req' : 'tag'));
      body.append(top, el('div', `${kb(s.size)} · usually ${s.files.concat(s.aliases).join(' or ')}`, 'expect'), el('div', socketState(s), 'state'));
      card.append(el('span', null, 'dot'), body);
      return card;
    }), ...(session.offersSsc ? session.sscRoms().map((s) => {
      // The Speech/Sound Pak's own sockets: a cartridge board with its own ROM, not part of the machine's. They
      // carry data-ssc rather than data-status so they are a separate list from the machine's sockets (the page's
      // browser check reads the machine's sockets by [data-status]).
      const card = el('div', null, 'socket');
      card.dataset.socket = `ssc-${s.id}`;
      card.dataset.ssc = s.status === 'loaded' ? 'loaded' : s.required ? 'missing-required' : 'missing-optional';
      const body = el('div', null, 'body'), top = el('div', null, 'top');
      top.append(el('strong', `Speech/Sound Pak: ${s.label}`), el('span', s.required ? 'required' : 'optional', s.required ? 'tag req' : 'tag'));
      const state = s.status === 'loaded' ? '✓ loaded'
        : s.required ? 'Waiting for a file. Without it the Pak cannot be inserted; it plays its music side from this ROM.'
          : 'Optional: speech is not implemented yet, so the Pak plays music without it.';
      body.append(top, el('div', `${kb(s.size)} · usually ${s.files[0]}`, 'expect'), el('div', state, 'state'));
      card.append(el('span', null, 'dot'), body);
      return card;
    }) : []));
    // a loaded file that is not a known dump: what it means and what to do
    $('romOdd').replaceChildren(...info.sockets.filter((s) => s.status === 'loaded-unrecognised').map((s) => {
      const d = el('div', null, 'odd');
      d.append(el('strong', `${s.file || 'The file'}: ${kb(s.size)}, not recognised.`),
        ` It is the size of the ${s.label}, so it's in use as that. If BASIC doesn't start, it may be a different revision or a damaged copy: run the ROM self-test below, or compare its CRC32 (${s.crc.toString(16).toUpperCase().padStart(8, '0')}) with the recognised ROMs listed on `);
      const a = el('a', 'the ROMs page'); a.href = 'roms/';
      d.append(a, '.');
      return d;
    }));
    // a required socket is empty: say what is needed; the stub stays the default
    const missing = info.sockets.filter((s) => s.status === 'missing-required');
    const stub = session.stubChosen.has(m.id);
    $('romNeeds').hidden = !missing.length || stub;
    $('romNeedsText').textContent = `The ${m.profile.name} needs ${missing.map((s) => `${s.label} (${kb(s.size)}, usually ${s.files[0]})`).join(' and ')} to run BASIC. ` +
      'Until then it runs without ROMs: machine-code programs only.';
    $('romStub').hidden = !stub;
    // what the last drop turned out to be, file by file
    $('romDrop').classList.toggle('good', !!found && found.some((f) => f.result === 'verified' || f.result === 'loaded-unrecognised'));
    if (found && found.length) {
      const ul = el('ul');
      for (const f of found) {
        const cls = f.result === 'verified' ? 'ok' : f.result === 'loaded-unrecognised' ? 'warn' : 'no';
        const mark = f.result === 'verified' ? '✓' : f.result === 'loaded-unrecognised' ? '◆' : '✗';
        ul.append(el('li', `${mark} ${f.message}`, cls));
      }
      $('romFound').replaceChildren(ul);
      $('romFound').classList.remove('muted');
    }
    // offers to switch to machines the last drop set up (never an error)
    const box = $('romOffers');
    offers = offers.filter((o) => o.machine !== m.id);
    box.replaceChildren(...offers.map((o) => {
      const d = el('div', null, 'offer');
      d.dataset.machine = o.machine;
      d.append(el('div', `${o.files.join(', ')} ${o.files.length > 1 ? 'are' : 'is'} for the ${o.name}. The ${o.name} is now ready too.`));
      const bar = el('div', null, 'bar');
      bar.append(button(`Switch to ${o.name}`, () => { offers = []; session.switchMachine(o.machine); page.status(`Switched to ${o.name}`); close(); }, true),
        button(`Stay on ${m.profile.name}`, () => { offers = offers.filter((x) => x !== o); render(); }));
      d.append(bar);
      return d;
    }));
    box.hidden = !offers.length;
    // the other machines that are ready
    const ready = session.machinesWithRoms().filter((x) => x.bootable && x.id !== m.id);
    $('romReady').textContent = ready.length ? `Also ready to run BASIC: ${ready.map((x) => x.name).join(', ')}.` : '';
    // BASIC can boot here: after a drop, or while the machine runs the stub, one click switches it on
    const on = $('btnRomSwitchOn');
    on.hidden = !(info.bootable && (m.useStub || (found && found.length)));
    on.textContent = `Switch on the ${name}`;
  }
  $('btnRomSwitchOn').onclick = () => {
    const m = session.machine;
    if (m.useStub) { session.stubChosen.delete(m.id); session.switchMachine(m.id); }
    page.status(`${m.profile.name}: switched on with its ROMs`);
    close();
  };

  // a drop on this screen takes the files as ROMs (a folder or ZIP is opened)
  const zone = $('romDrop');
  view.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('drop'); });
  view.addEventListener('dragleave', () => zone.classList.remove('drop'));
  view.addEventListener('drop', async (e) => { e.preventDefault(); zone.classList.remove('drop'); await romInput.take(await romInput.droppedFiles(e.dataTransfer), { all: true }); });

  romInput.onChange((report) => {
    if (report && report.offers) offers = report.offers;
    if (report && report.files) found = report.files;
    // a drop that needs explaining (a ROM that could not be used) opens this screen to say why; one that loaded,
    // even if not a known dump, doesn't (the boot watchdog points here if it then fails to start)
    if (report && report.files && !isOpen() && report.files.some((f) => f.result === 'rejected')) page.openView('#add-roms');
    render();
  });
  session.on((ev) => { if (ev === 'machine' || ev === 'roms' || ev === 'firmware') render(); });
  $('btnRunStub').onclick = () => runWithoutRoms();
  function runWithoutRoms() { session.runWithoutRoms(); render(); page.status(`${session.machine.profile.name}: running without ROMs`); }
  // open this screen (the header's pill, the Machine tab, the boot help, the Welcome menu's key 3)
  function reveal() { if (isOpen()) render(); else page.openView('#add-roms'); }
  show();
  return { render, runWithoutRoms, reveal };
}
