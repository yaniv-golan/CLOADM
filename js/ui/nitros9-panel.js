/*
 * NitrOS-9, under the screen on the CoCo 3: boot the user's own NitrOS-9 image without a ROM (Session.bootNitros9:
 * a DriveWire image in DriveWire drive 0 on the Becker port, or a floppy image in floppy drive 0, with one of our
 * loaders in place of the internal ROM).
 * Pick one of the bootable images in the library or add one (it boots at once); "Back to BASIC" puts the ROMs
 * back. A dropped NitrOS-9 image comes here too (bootFile), and a link's nitros9= (fromLink).
 */
import { $ } from './page.js';
import { NITROS9_IMAGES_URL } from '../media/os9.js';

export function setupNitros9Panel(page) {
  const { session } = page;
  const fail = (e) => { page.status(e.message, true); return false; };
  // Session events come in bursts and each one starts a show(); its reads of the library are asynchronous, so
  // an earlier show() can finish after a later one. Only the latest writes the panel (an older one, finishing late,
  // would put back the state it read: "DriveWire or floppy" after the boot). shown() settles when the latest has.
  let latest = 0, pending = Promise.resolve();
  function show() {
    const p = render(++latest);
    pending = p.catch(() => {});
    return p;
  }
  // the closed list can clip a long name: the whole name is its title
  const nameTitle = () => { const sel = $('n9Image'); sel.title = sel.selectedOptions[0] ? sel.selectedOptions[0].textContent : ''; };
  async function shown() { let p; do { p = pending; await p; } while (p !== pending); }
  async function render(seq) {
    const m = session.machine, on = !!m && session.constructor.NITROS9_MACHINES.includes(m.id);   // (no machine before the page starts)
    $('nitros9Slot').hidden = !on;
    if (!on) return;
    const running = session.nitros9Running;
    const images = (await session.nitros9Images()).filter((x) => !x.reason);
    const now = running ? await session.pickNitros9Image() : null;   // (drive 0's image first: the one running)
    if (seq !== latest) return;                                     // a later show() has the newer state
    const sel = $('n9Image'), keep = sel.value;
    sel.replaceChildren();
    for (const im of images) {
      const o = document.createElement('option');
      o.value = `${im.store}:${im.name}`;
      o.textContent = `${im.name} (${[im.cpu, im.boot === 'floppy' ? 'floppy' : 'DriveWire'].filter(Boolean).join(', ')})`;
      sel.append(o);
    }
    if (!images.length) { const o = document.createElement('option'); o.value = ''; o.textContent = '(no NitrOS-9 image yet)'; sel.append(o); }
    const values = images.map((x) => `${x.store}:${x.name}`);
    const nowValue = now ? `${now.store}:${now.name}` : null;
    sel.value = values.includes(keep) ? keep : nowValue && values.includes(nowValue) ? nowValue : sel.options[0].value;
    sel.disabled = !images.length;
    nameTitle();
    $('btnN9Boot').disabled = !images.length;
    $('btnN9Boot').textContent = running ? 'Boot again' : 'Boot NitrOS-9';
    $('btnN9Leave').hidden = !running;
    $('n9State').textContent = running ? `running from ${now ? now.name : session.nitros9Loader() === 'floppy' ? 'floppy drive 0' : 'DriveWire drive 0'}` : 'DriveWire or floppy, no ROM needed';
  }
  const boot = (p) => p.then((msg) => { page.status(msg); page.focus(); return true; }, fail);
  // a file the user picked or dropped: into the library (with the DriveWire images or the disks), then booted; on another machine
  // the CoCo 3 first
  async function bootFile(name, bytes) {
    page.audio.start();
    if (!session.constructor.NITROS9_MACHINES.includes(session.machine.id)) session.switchMachine(session.constructor.NITROS9_MACHINES[0], undefined, { menu: false });
    return boot(session.addAndBootNitros9(name, bytes));
  }
  // a link's nitros9=1 (the image the user has) or nitros9=NAME
  async function fromLink(which) {
    const cpu = session.machine.config.cpu;
    const pick = which === true ? await session.pickNitros9Image(cpu) : { name: which, store: null };
    if (!pick || !pick.name) return fail(new Error(`This link boots NitrOS-9 from your own image, and your library has none yet. Download the NitrOS-9 v3.3.0 CoCo 3 archive (${NITROS9_IMAGES_URL}), unzip it, and add its _becker.dsk or _40d_1.dsk under the screen (NitrOS-9 · Add image…); the link then boots it.`));
    return boot(session.bootNitros9(pick.name, pick.store));
  }
  $('n9Image').onchange = nameTitle;
  $('btnN9Boot').onclick = () => {
    page.audio.start();
    const v = $('n9Image').value, i = v.indexOf(':');
    boot(session.bootNitros9(v.slice(i + 1), v.slice(0, i)));
  };
  $('btnN9Add').onclick = () => $('n9File').click();
  $('n9File').onchange = async (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (f) bootFile(f.name, await page.readFile(f));
  };
  $('btnN9Leave').onclick = () => { session.leaveNitros9(); page.status('Back to BASIC'); page.focus(); };
  session.on((ev) => { if (ev === 'machine' || ev === 'drivewire' || ev === 'nitros9' || ev === 'roms' || ev === 'disks') show().catch(fail); });
  return { bootFile, fromLink, show, shown };
}
