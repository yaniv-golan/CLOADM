/*
 * DriveWire, in the Machine tab (a minimal control), shown when the machine has the
 * Becker port on or the browser has Web Serial: drives 0-3, each an image from the store or nothing, with write
 * protect; adding an image (a file of 256-byte sectors) or a blank one; saving an image; one virtual serial channel
 * connected to a WebSocket (with the Becker port); serving a real CoCo on a serial cable (Web Serial).
 * The state lives in the Session (driveWireImages, importDriveWireImage, mountDriveWire, ejectDriveWire,
 * driveWireFile, connectDriveWireChannel, driveWireChannels).
 */
import { $ } from './page.js';
import { SERIAL_DW_BAUDS } from '../host/web-serial.js';
import { SessionError } from '../session.js';

const DRIVES = 4;

export function setupDriveWirePanel(page) {
  const { session } = page;
  const box = $('dwDrives');
  const fail = (e) => page.status(e.message, true);
  for (const b of SERIAL_DW_BAUDS) { const o = document.createElement('option'); o.value = b; o.textContent = `${b} baud`; $('dwSerialBaud').append(o); }
  $('dwSerialBaud').value = '115200';
  for (let c = 0; c < 15; c++) { const o = document.createElement('option'); o.value = c; o.textContent = `Channel ${c}`; $('dwChan').append(o); }
  async function show() {
    const m = session.shownMachine;
    $('dwSection').hidden = !m.becker && !session.webSerialAvailable;
    if ($('dwSection').hidden) return;
    for (const id of ['dwChan', 'dwUrl', 'btnDwConnect', 'dwChanState']) $(id).hidden = !m.becker;
    $('dwSerialRow').hidden = !session.webSerialAvailable;
    const real = session.realCoco;
    $('btnDwSerial').textContent = real && real.state === 'open' ? 'Stop serving' : 'Serve a real CoCo…';
    $('dwSerialState').textContent = real ? `${real.state}, ${real.bytesIn} in / ${real.bytesOut} out` : '';
    // the listing can be refused (a folder's permission gone, a store that won't answer): say so on the status
    // line, as the Library does, and show no images rather than leave a promise nothing waits for
    let images;
    try { images = await session.driveWireImages(); }
    catch (e) { images = []; fail(session.mediaError(e, 'the DriveWire images')); }
    const mounts = new Map(session.driveWireMounts.map((d) => [d.drive, d]));
    box.replaceChildren();
    for (let d = 0; d < DRIVES; d++) {
      const row = document.createElement('div'); row.className = 'bar';
      const label = document.createElement('span'); label.textContent = `Drive ${d}`; label.style.minWidth = '4.5em';
      const sel = document.createElement('select'); sel.id = `dwDrive${d}`; sel.setAttribute('aria-label', `DriveWire drive ${d}`);
      const none = document.createElement('option'); none.value = ''; none.textContent = '(empty)'; sel.append(none);
      for (const im of images) { const o = document.createElement('option'); o.value = im.name; o.textContent = `${im.name} (${Math.round(im.size / 1024)}K)`; sel.append(o); }
      const cur = mounts.get(d);
      sel.value = cur ? cur.name : '';
      // An image another DriveWire drive holds is not offered: picking it there would be refused, so the list does
      // not invite it. The drive's own image stays (re-mounting it is allowed), and ejecting one puts it back.
      const heldBy = new Map(session.driveWireMounts.map((m) => [m.name, m.drive]));
      for (const o of [...sel.options]) {
        if (!o.value || o.value === (cur && cur.name)) continue;
        if (heldBy.has(o.value) && heldBy.get(o.value) !== d) o.remove();
      }
      const wp = document.createElement('label');
      const chk = document.createElement('input'); chk.type = 'checkbox'; chk.id = `dwWp${d}`; chk.checked = !!(cur && cur.writeProtected);
      wp.append(chk, ' WP'); wp.title = 'Write protect'; wp.style.whiteSpace = 'nowrap';
      const mount = () => {
        if (!sel.value) { session.ejectDriveWire(d); return; }
        session.mountDriveWire(d, sel.value, { writeProtected: chk.checked }).then(() => page.status(`DriveWire drive ${d}: ${sel.value}`), fail);
      };
      sel.onchange = mount;
      chk.onchange = () => { if (sel.value) mount(); };
      row.append(label, sel, wp);
      box.append(row);
    }
    $('btnDwSave').disabled = !images.length;
    const ch = session.driveWireChannels[0];
    $('dwChanState').textContent = ch ? `channel ${ch.channel}: ${ch.state}${ch.open ? ', open on the machine' : ''}` : 'not connected';
    $('btnDwConnect').textContent = ch && ch.state !== 'closed' ? 'Disconnect' : 'Connect';
  }
  $('btnDwAdd').onclick = () => $('dwImport').click();
  $('dwImport').onchange = async (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    try { const name = await session.importDriveWireImage(f.name, await page.readFile(f)); page.status(`Added ${name} for DriveWire`); } catch (err) { fail(err); }
  };
  $('btnDwNew').onclick = async () => {
    try { const name = await session.newDriveWireImage(`blank-${Date.now().toString(36)}.dsk`); page.status(`Added ${name} (157K, blank)`); } catch (err) { fail(err); }
  };
  $('btnDwSave').onclick = async () => {
    try {
      // no drive chosen: the first image; with none at all (a store that refused the listing), say so rather
      // than read a name off an empty list
      const chosen = $('dwDrive0').value;
      // (a refused listing is said as the box says it: session.mediaError, not the store's raw error)
      let first = null;
      if (!chosen) {
        try { first = (await session.driveWireImages())[0]; } catch (e) { throw session.mediaError(e, 'the DriveWire images'); }
      }
      if (!chosen && !first) throw new SessionError('No DriveWire image to save: add one first.');
      const f = await session.driveWireFile(chosen || first.name); page.download(f.name, f.bytes);
    } catch (err) { fail(err); }
  };
  $('btnDwConnect').onclick = () => page.attempt(() => {
    const ch = session.driveWireChannels[0];
    if (ch && ch.state !== 'closed') { session.connectDriveWireChannel(ch.channel, null); return 'DriveWire channel disconnected'; }
    session.connectDriveWireChannel(Number($('dwChan').value), $('dwUrl').value.trim());
    return `DriveWire channel ${$('dwChan').value}: connecting`;
  });
  $('btnDwSerial').onclick = async () => {
    try {
      if (session.realCoco && session.realCoco.state === 'open') { await session.stopRealCoco(); page.status('Stopped serving the real CoCo'); return; }
      await session.serveRealCoco(Number($('dwSerialBaud').value));
      page.status(`Serving DriveWire on the serial port at ${$('dwSerialBaud').value} baud`);
    } catch (err) { fail(err); }
  };
  session.on((ev) => { if (ev === 'machine' || ev === 'drivewire') show().catch(fail); });
}
