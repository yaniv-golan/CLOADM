/*
 * Adding ROMs, at /play/#add-roms instead of the emulator. It opens from the header's "Add ROMs…" (a phone: Menu's
 * "Add ROMs…"), the Machine tab's "Add ROMs →", the Welcome menu's key 3 (the one place that says why ROMs are
 * needed), the boot help's "Add ROMs", and anything else that needs ROMs. It shows:
 *  - the disk ROM's card where the machine takes a disk cartridge (a drive's Add ROMs… lands on it);
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
import { $, showView } from './page.js';
import { wadOf } from './files.js';
import { SSC_TEXT } from '../session.js';

const kb = (n) => `${n / 1024} KB`;
// what an optional socket gives you, by socket id (what you miss without it)
const OPTIONAL_WHY = {
  extbas: 'Optional: without it you have Color BASIC only, with no PMODE graphics, PLAY or DRAW.',
  basic64: 'Optional: without it, EXEC stays in 32K mode.',
};
const el = (tag, text, cls) => { const e = document.createElement(tag); if (text != null) e.textContent = text; if (cls) e.className = cls; return e; };
const button = (text, fn, primary = false) => { const b = el('button', text, primary ? 'primary' : ''); b.onclick = fn; return b; };

// confirmSwitch: the machine menu's confirmation (js/ui/machine-panel.js), which an offer's switch goes through too
export function setupRomSockets(page, romInput, { confirmSwitch }) {
  const { session } = page;
  const view = $('romCard');
  let offers = [];      // [{ machine, name, files }] from the last drop, until this screen closes or the machine restarts
  let found = null;     // the last drop's per-file results
  // 'machine:socket' rows another tab changed while this screen was open: they say so, quietly, until it closes (a
  // socket changing under the person's eyes, unexplained, looks like a bug)
  const elsewhere = new Set();

  // ---------------- open and close (#add-roms) ----------------
  const isOpen = () => location.hash === '#add-roms';
  function show() {
    const open = isOpen();
    document.body.classList.toggle('roms-open', open);
    showView(view, open);
    if (!open) { offers = []; elsewhere.clear(); }   // shown once, with the drop they came from: never again from a later visit to this screen
    if (open) { render(); $('romHeading').focus(); }
  }
  page.onView(show);
  const close = () => page.closeView();
  $('btnRomBack').onclick = (e) => { e.preventDefault(); close(); };
  $('btnRomJustLooking').onclick = close;

  // ---------------- the sockets ----------------
  // what the running machine still has of a socket's ROM: one this page removed from storage (RomLibrary.remove,
  // Session.romsStillRunning), or one another tab removed or replaced (Session.romElsewhere). The machine is not
  // touched, so the row says what it runs
  const RUNNING = {
    removed: 'Removed · still in the running machine',
    replaced: 'Replaced · the running machine keeps the old one until you switch off and on',
  };
  function socketState(s, machine, left) {
    if (left) return RUNNING.removed;
    const kept = session.romElsewhere(machine, s.id);
    if (kept) return RUNNING[kept];
    if (s.status === 'verified') return `✓ ${s.file || 'loaded'} · Recognised`;
    if (s.status === 'loaded-unrecognised') return `◆ ${s.file || 'loaded'} · loaded, not recognised`;
    if (s.status === 'missing-required') return 'Waiting for a file. Without it there is no BASIC: the machine runs without ROMs, machine-code programs only.';
    return OPTIONAL_WHY[s.id] || 'Optional.';
  }
  // The disk ROM: one card for a machine whose cartridge port takes a disk cartridge, from
  // DiskDrives.dosChoices() ("Disk drives (optional): DragonDOS or Delta DOS"); none for a machine with its own disk
  // interface (the Dragon Alpha) or with no cartridge port (the MC-10). Like the Pak's, it carries its own attribute
  // (data-disk), not data-status: it is not one of the machine's sockets, and the socket counts read [data-status].
  function diskCard() {
    const c = session.drives.dosChoices().filter((x) => !x.builtin);
    if (!c.length) return [];
    const card = el('div', null, 'socket'), ready = c.filter((x) => x.ready);
    card.id = 'romDiskCard'; card.tabIndex = -1;
    card.dataset.socket = 'disk';
    card.dataset.disk = ready.length ? 'loaded' : 'missing-optional';
    const body = el('div', null, 'body'), top = el('div', null, 'top');
    const names = c.map((x) => x.name.replace(/ cartridge$/, ''));
    top.append(el('strong', `Disk drives: ${names.join(' or ')}`), el('span', 'optional', 'tag'));
    const state = ready.length ? `✓ ${ready.map((x) => `${x.name.replace(/ cartridge$/, '')} disk ROM`).join(', ')} · ${session.drives.romWaiting ? 'goes in at the next reset or power cycle (the disk controller in use has none yet)' : 'ready for disks'}`
      : 'Without it, disks still go in, for programs that read them directly. CLOADM doesn\'t include one; add your own copy.';
    body.append(top, el('div', `8 KB · usually ${c.map((x) => x.rom).join(' or ')}`, 'expect'), el('div', state, 'state'));
    card.append(el('span', null, 'dot'), body);
    return [card];
  }
  // drawn only while the screen is open (show() draws it on opening)
  function render() {
    if (!isOpen() || !session.personMachine) return;
    const m = session.personMachine, info = session.machineRoms(m.id), name = m.profile.name;   // the person's machine
    // a socket whose ROM was removed from storage while the machine runs it (it keeps it until switched off and on)
    const still = session.romsStillRunning(m), running = m.romCrcs();
    const left = (s) => !s.crc && still.has(running[s.id]);
    $('romMachine').textContent = name.toUpperCase();
    $('romSockets').replaceChildren(...info.sockets.map((s) => {
      const card = el('div', null, 'socket');
      card.dataset.socket = s.id; card.dataset.status = s.status;
      if (left(s)) card.dataset.left = 'running';
      const body = el('div', null, 'body'), top = el('div', null, 'top');
      top.append(el('strong', s.label), el('span', s.required ? 'required' : 'optional', s.required ? 'tag req' : 'tag'));
      body.append(top, el('div', `${kb(s.size)} · usually ${s.files.concat(s.aliases).join(' or ')}`, 'expect'), el('div', socketState(s, m.id, left(s)), 'state'));
      if (elsewhere.has(`${m.id}:${s.id}`)) body.append(el('div', 'Changed in another tab', 'elsewhere muted'));
      card.append(el('span', null, 'dot'), body);
      return card;
    }), ...diskCard(), ...(session.offersSsc ? session.sscRoms().map((s) => {
      // The Speech/Sound Pak's own sockets: a cartridge board with its own ROM, not part of the machine's. They
      // carry data-ssc rather than data-status so they are a separate list from the machine's sockets (the page's
      // browser check reads the machine's sockets by [data-status]). The Pak itself is an optional cartridge, so its
      // cards carry the optional tag beside their titles (the words are not repeated in them), like the disk card, and come last: a ROM the Pak needs (data-ssc
      // "missing-required") is still not one the machine needs, and a red "required" beside BASIC's read as if it were.
      const card = el('div', null, 'socket');
      card.dataset.socket = `ssc-${s.id}`;
      card.dataset.ssc = s.status === 'loaded' ? 'loaded' : s.required ? 'missing-required' : 'missing-optional';
      const body = el('div', null, 'body'), top = el('div', null, 'top');
      top.append(el('strong', `Speech/Sound Pak: ${s.label}`), el('span', 'optional', 'tag'));
      // the speech ROM's two lines are SSC_TEXT's (js/session.js), the words the page uses for it everywhere
      const state = s.id === 'sp0256' ? (s.status === 'loaded' ? SSC_TEXT.romLoaded : SSC_TEXT.romMissing)
        : s.status === 'loaded' ? '✓ loaded'
          : 'Only for the Speech/Sound Pak: without it the Pak cannot be inserted.';
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
      bar.append(button(`Switch to ${o.name}`, () => {
        close();   // (back on the emulator, where the confirmation shows)
        confirmSwitch({ name: o.name, id: o.machine }, (taken, said) => { session.chooseMachine(o.machine); page.status(`Switched to ${o.name}.${said || ''}`); });
      }, true),
        button(`Stay on ${m.profile.name}`, () => { offers = offers.filter((x) => x !== o); render(); }));
      d.append(bar);
      return d;
    }));
    box.hidden = !offers.length;
    // the other machines that are ready: every REQUIRED socket holds a verified dump, never a file that is merely
    // loaded. A "loaded, not a known dump" image may boot (that is the machine's own trial) but it is not something
    // to tell a person is ready to run BASIC. The line sits under the sockets (play/index.html), not in the
    // "What you dropped" block further down, which is below the fold on a phone.
    const verified = new Set(session.machinesVerified());
    const ready = session.machinesWithRoms().filter((x) => verified.has(x.id) && x.id !== m.id);
    const line = ready.length ? `Also ready to run BASIC: ${ready.map((x) => x.name).join(', ')}.` : '';
    $('romReady').textContent = line;
    // BASIC can boot here: after a drop, or while the machine runs the stub, one click switches it on
    const on = $('btnRomSwitchOn');
    on.hidden = !(info.bootable && (m.useStub || (found && found.length)));
    on.textContent = `Switch on the ${name}`;
  }
  $('btnRomSwitchOn').onclick = () => {
    const m = session.personMachine;
    if (m.useStub) { session.stubChosen.delete(m.id); session.switchMachine(m.id); }
    page.status(`${m.profile.name}: switched on with its ROMs`);
    close();
  };

  // a drop on this screen takes the files as ROMs (a folder or ZIP is opened)
  const zone = $('romDrop');
  view.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('drop'); });
  view.addEventListener('dragleave', () => zone.classList.remove('drop'));
  view.addEventListener('drop', async (e) => {
    e.preventDefault(); zone.classList.remove('drop');
    const list = await romInput.droppedFiles(e.dataTransfer), wad = wadOf(list);
    // a .wad here is for "Your game files" (WYRMFIRE), not a ROM
    if (wad && page.takeWad) { await page.takeWad(wad); return; }
    await romInput.take(list, { all: true });
  });

  romInput.onChange((report) => {
    if (report && report.offers) offers = report.offers;
    if (report && report.files) found = report.files;
    // a drop that needs explaining (a ROM that could not be used) opens this screen to say why; one that loaded,
    // even if not a known dump, doesn't (the boot watchdog points here if it then fails to start)
    if (report && report.files && !isOpen() && report.files.some((f) => f.result === 'rejected')) page.openView('#add-roms');
    if (!isOpen()) offers = [];   // a drop elsewhere says what it set up in its toast; no offer waits for a later visit
    render();
  });
  // a drop's offers are about that moment: a new machine, a power-on or a reset ends them
  session.on((ev, arg) => {
    if (ev === 'roms' && arg && arg.elsewhere && isOpen()) for (const x of arg.elsewhere) elsewhere.add(`${x.machine}:${x.socket}`);
    if (ev === 'machine' || ev === 'firmware' || ev === 'reset') offers = [];
    if (ev === 'machine' || ev === 'roms' || ev === 'firmware' || ev === 'reset') render();
  });
  $('btnRunStub').onclick = () => runWithoutRoms();
  function runWithoutRoms() { session.runWithoutRoms(); render(); page.status(`${session.personMachine.profile.name}: running without ROMs`); }
  // open this screen (the header's pill, the Machine tab, the boot help, the Welcome menu's key 3); to: 'disk' lands
  // on the disk ROM's card (a drive's Add ROMs…): scrolled into view, with the focus
  function reveal({ to = null } = {}) {
    if (isOpen()) render(); else page.openView('#add-roms');
    const card = to === 'disk' && $('romDiskCard');
    if (card) { card.scrollIntoView({ block: 'center' }); card.focus({ preventScroll: true }); }
  }
  show();
  return { render, runWithoutRoms, reveal };
}
