// DriveWire to a real CoCo over Web Serial (js/host/web-serial.js), against a MOCKED serial port:
// a fake navigator.serial whose port is a pair of web streams. This shows the link's plumbing (the port opened
// 8N1 at the chosen rate, bytes to the server, its answers back once the store has them, close and unplug); it
// cannot show that a real cable and CoCo work, which is a manual test (docs/verification.md, Web Serial).
const Emu = require('./load')();
const { SerialDriveWireLink, SERIAL_DW_BAUDS } = require('../js/host/web-serial.js');

let fail = 0;
const check = (name, cond, detail = '') => { if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name} ${detail}`); };
const eq = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
const tick = () => new Promise((r) => setTimeout(r, 5));
const sector = (seed) => Array.from({ length: 256 }, (_, i) => (seed + i * 5) & 0xFF);

// a mock Web Serial: requestPort gives one port; the test pushes bytes "from the CoCo" and reads what was written
function mockSerial({ refuse = false } = {}) {
  const written = [];
  let feed = null;
  const port = {
    opened: null, closed: false,
    readable: new ReadableStream({ start(c) { feed = c; } }),
    writable: new WritableStream({ write(chunk) { written.push(...chunk); } }),
    async open(opts) { this.opened = opts; },
    async close() { this.closed = true; },
  };
  return {
    serial: { async requestPort() { if (refuse) { const e = new Error('No port selected by the user.'); e.name = 'NotFoundError'; throw e; } return port; } },
    port, written, send: (bytes) => feed.enqueue(Uint8Array.from(bytes)), unplug: () => feed.close(),
  };
}

(async () => {
  const s = new Emu.Session();
  s.switchMachine('coco', { becker: true });
  await s.importDriveWireImage('boot.dsk', Uint8Array.from([...sector(1), ...sector(2)]));
  await s.mountDriveWire(0, 'boot.dsk');

  const none = new Emu.Session();
  none.webSerial = undefined;
  let msg = '';
  try { await none.serveRealCoco(57600); } catch (e) { msg = e.message; }
  check('no Web Serial in this browser: a clear refusal', !none.webSerialAvailable && /no Web Serial/.test(msg), msg);

  const refused = mockSerial({ refuse: true });
  s.webSerial = refused.serial;
  try { await s.serveRealCoco(57600); msg = ''; } catch (e) { msg = e.message; }
  check('the user picks no port: "No serial port chosen."', msg === 'No serial port chosen.', msg);
  try { await s.serveRealCoco(9600); msg = ''; } catch (e) { msg = e.message; }
  check('a rate the link does not offer is refused', /not offered/.test(msg) && !SERIAL_DW_BAUDS.includes(9600), msg);

  const m = mockSerial();
  s.webSerial = m.serial;
  await s.serveRealCoco(115200);
  check('the port opens 8N1 at the chosen rate, no flow control', JSON.stringify(m.port.opened) === JSON.stringify({ baudRate: 115200, dataBits: 8, stopBits: 1, parity: 'none', flowControl: 'none' }));
  check('the Session shows the real CoCo served', s.realCoco.state === 'open');
  // the CoCo reads drive 0 LSN 1 (sent in two pieces, as a UART delivers them)
  m.send([0x52, 0, 0]); await tick(); m.send([0, 1]);
  for (let i = 0; i < 50 && m.written.length < 259; i++) await tick();
  const want = sector(2), ck = want.reduce((a, v) => a + v, 0) & 0xFFFF;
  check('a Read from the CoCo is answered from the same drives the emulated machine has', eq(m.written.splice(0), [0, ck >> 8, ck & 0xFF, ...want]));
  // the emulated machine's Becker port at the same time: its own link, the same drive
  const em = s.shownMachine;
  for (const b of [0x23]) em.write(0xFF42, b);
  const t = []; while (em.read(0xFF41) & 2) t.push(em.read(0xFF42));
  check('the emulated machine\'s link is separate (its TIME answer is not on the cable)', t.length === 6 && m.written.length === 0);
  // a Write from the CoCo reaches the image the emulated machine reads
  const data = sector(0x80), dck = data.reduce((a, v) => a + v, 0) & 0xFFFF;
  m.send([0x57, 0, 0, 0, 0, ...data, dck >> 8, dck & 0xFF]);
  for (let i = 0; i < 50 && !m.written.length; i++) await tick();
  check('a Write from the CoCo: result 0', eq(m.written.splice(0), [0]));
  for (const b of [0x52, 0, 0, 0, 0]) em.write(0xFF42, b);
  await em.stall;
  const got = []; while (em.read(0xFF41) & 2) got.push(em.read(0xFF42));
  check('... and the emulated machine reads what the real one wrote', eq(got.slice(3), data));
  await s.stopRealCoco();
  check('stop: the port is closed', m.port.closed && s.realCoco === null);

  const u = mockSerial();
  s.webSerial = u.serial;
  await s.serveRealCoco(57600);
  u.unplug();
  for (let i = 0; i < 50 && s.realCoco.state === 'open'; i++) await tick();
  check('the cable unplugged (the stream ends): the link shows closed', s.realCoco.state === 'closed');

  console.log(fail ? `${fail} FAILED` : 'all passed');
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.log('FAIL', e.stack); process.exitCode = 1; });
