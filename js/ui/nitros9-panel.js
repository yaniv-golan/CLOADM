/*
 * NitrOS-9, under the screen on the CoCo 3: boot the user's own NitrOS-9 DriveWire image without a ROM
 * (Session.bootNitros9: the image in DriveWire drive 0 on the Becker port, our loader in place of the internal ROM).
 * Pick one of the bootable images in the library or add one (it boots at once); "Back to BASIC" puts the ROMs
 * back. A dropped NitrOS-9 image comes here too (bootFile), and a link's nitros9= (fromLink).
 */
import { $ } from './page.js';
import { NITROS9_RELEASES } from '../media/os9.js';

export function setupNitros9Panel(page) {
  const { session } = page;
  const fail = (e) => { page.status(e.message, true); return false; };
  async function show() {
    const m = session.machine, on = !!m && session.constructor.NITROS9_MACHINES.includes(m.id);   // (no machine before the page starts)
    $('nitros9Slot').hidden = !on;
    if (!on) return;
    const running = session.nitros9Running;
    const images = (await session.nitros9Images()).filter((x) => !x.reason);
    const sel = $('n9Image'), keep = sel.value;
    sel.replaceChildren();
    for (const im of images) {
      const o = document.createElement('option');
      o.value = im.name; o.textContent = `${im.name}${im.cpu ? ` (${im.cpu})` : ''}`;
      sel.append(o);
    }
    if (!images.length) { const o = document.createElement('option'); o.value = ''; o.textContent = '(no NitrOS-9 image yet)'; sel.append(o); }
    const d0 = session.driveWireMounts.find((d) => d.drive === 0);
    sel.value = images.some((x) => x.name === keep) ? keep : d0 && images.some((x) => x.name === d0.name) ? d0.name : sel.options[0].value;
    sel.disabled = !images.length;
    $('btnN9Boot').disabled = !images.length;
    $('btnN9Boot').textContent = running ? 'Boot again' : 'Boot NitrOS-9';
    $('btnN9Leave').hidden = !running;
    $('n9State').textContent = running ? `running from ${d0 ? d0.name : 'DriveWire drive 0'}` : 'over DriveWire, no ROM needed';
  }
  const boot = (p) => p.then((msg) => { page.status(msg); page.focus(); return true; }, fail);
  // a file the user picked or dropped: into the library (DriveWire images), then booted; on another machine
  // the CoCo 3 first
  async function bootFile(name, bytes) {
    page.audio.start();
    if (!session.constructor.NITROS9_MACHINES.includes(session.machine.id)) session.switchMachine(session.constructor.NITROS9_MACHINES[0], undefined, { menu: false });
    return boot(session.addAndBootNitros9(name, bytes));
  }
  // a link's nitros9=1 (the image the user has) or nitros9=NAME
  async function fromLink(which) {
    const cpu = session.machine.config.cpu;
    const name = which === true ? (await session.pickNitros9Image(cpu) || {}).name : which;
    if (!name) return fail(new Error(`This link boots NitrOS-9 from your own DriveWire image, and your library has none yet. Get a NitrOS-9 release (${NITROS9_RELEASES}) and add its _becker.dsk under the screen (NitrOS-9 · Add image…); the link then boots it.`));
    return boot(session.bootNitros9(name));
  }
  $('btnN9Boot').onclick = () => { page.audio.start(); boot(session.bootNitros9($('n9Image').value)); };
  $('btnN9Add').onclick = () => $('n9File').click();
  $('n9File').onchange = async (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (f) bootFile(f.name, await page.readFile(f));
  };
  $('btnN9Leave').onclick = () => { session.leaveNitros9(); page.status('Back to BASIC'); page.focus(); };
  session.on((ev) => { if (ev === 'machine' || ev === 'drivewire' || ev === 'nitros9' || ev === 'roms') show().catch(fail); });
  return { bootFile, fromLink, show };
}
