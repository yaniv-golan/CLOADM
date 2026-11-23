// The Speech/Sound Pak's SP0256 TIMING against MAME 0.264 (`<system> -ext ssc`), on our own speech image and
// firmware (gen-speak.js). The PIC loads allophones 1..N as the speech chip asks for them, so each load's time is the
// moment the chip took the one before it; the 6809 reads $FF7E over and over, so SBY (bit 6) is sampled at the same
// instants on both sides.
//
//   node tools/mame-diff/ssc/speech.js [profile]     # coco (default), coco2b, coco3, dragon64; or SSC_PROFILE
//
// Two checks, both required:
//   1. ADDRESS LOADS: the time of every ALD falling edge (a Lua tap on the PIC's port C, with port D's allophone
//      number) against ours: the same numbers in the same order, each within half a card cycle (the two Pak clocks
//      differ by 0.25 Hz in 894,886).
//   2. STATUS: every change in the value the 6809 reads at $FF7E (a Lua read tap): the same values in the same order,
//      each on the same read, counted from the first (the two 6809s run the same program in lockstep, so a read's
//      number is its time; a Lua tap and our ioTime() place a read at slightly different points of its instruction).
// Our machine runs under config.mameCompat: the speech chip on MAME's 9,285 Hz grid (docs/verification.md).
const fs = require('fs');
const { loadEmu, romImage, writeRoms } = require('../lib/firmware.js');
const { runMame } = require('../lib/mame.js');
const { speechImage, speakPic, speakHost, cases } = require('./gen-speak.js');

const SECONDS = 4;
const PROFILES = ['coco', 'coco2b', 'coco3', 'dragon64'];

function machineRoms(profile) {
  const host = speakHost(profile.id);
  return Object.fromEntries(profile.roms.map((r) => [r.id, romImage(host, r.at, r.size, 0x12)]));
}

function ourMachine(profileId = 'coco') {
  const Emu = loadEmu();
  const profile = Emu.profiles[profileId];
  const m = Emu.createMachine(profileId, { mameCompat: true });
  m.setRoms(machineRoms(profile));
  m.insertCartridge(new Emu.SpeechSoundPak({ tms7040Rom: speakPic(), sp0256Rom: speechImage() }));
  m.reset(true);
  return m;
}

// our side: ALD times and $FF7E value changes, in seconds from the power-on origin (MAME's time 0)
function ours(profileId, seconds = SECONDS) {
  const m = ourMachine(profileId);
  const pak = m.cartPort, origin = BigInt(Math.round(m.powerOnTick()));
  const secs = (tick) => Number(BigInt(Math.floor(Number(tick))) - origin) / m.tickHz;
  const loads = [], status = [];
  const load = pak.sp0256.loadAddress;
  pak.sp0256.loadAddress = function (n) { loads.push({ t: secs(pak.cardPos), n }); return load.call(this, n); };
  const readIO = pak.readIO.bind(pak);
  let last = -1, reads = 0;
  pak.readIO = (a) => {
    const v = readIO(a);
    if (a === 0xFF7E) { reads++; if (v !== last) { status.push({ read: reads, v }); last = v; } }
    return v;
  };
  const frames = Math.ceil(seconds * m.fps);
  for (let f = 0; f < frames; f++) m.runFrame();
  return { loads, status, cartClockHz: m.cartClockHz };
}

function mame(profileId, seconds = SECONDS) {
  const Emu = loadEmu();
  const profile = Emu.profiles[profileId];
  const work = `/tmp/mame-diff/${profileId}-ssc-speech`;
  fs.rmSync(work, { recursive: true, force: true });
  const roms = machineRoms(profile);
  writeRoms(work, profile.mame, Object.fromEntries(profile.roms.map((r) => [r.files[0], roms[r.id]])));
  writeRoms(work, 'coco_ssc', { 'pic-7040-510.bin': speakPic(), 'sp0256-al2.bin': speechImage() });
  const lua = `
local m = manager.machine
local pic = m.devices[":ext:ssc:pic7040"].spaces["program"]
local cpu = m.devices[":maincpu"].spaces["program"]
-- the taps are kept in a global: MAME removes a tap whose handle is collected
TAPS = {}
local rows, portd, prevc, last, reads = {}, 0, 0, -1, 0
TAPS[1] = pic:install_write_tap(0x010A, 0x010A, "portd", function(off, data, mask) portd = data & 0xff end)
TAPS[2] = pic:install_write_tap(0x0108, 0x0108, "portc", function(off, data, mask)
  local d = data & 0xff
  if (prevc & 0x20) ~= 0 and (d & 0x20) == 0 and portd < 64 then rows[#rows + 1] = string.format("ALD %.15f %d", m.time:as_double(), portd) end
  prevc = d
end)
TAPS[3] = cpu:install_read_tap(0xFF7E, 0xFF7E, "status", function(off, data, mask)
  local v = data & 0xff
  reads = reads + 1
  if v ~= last then rows[#rows + 1] = string.format("ST %d %d", reads, v); last = v end
end)
emu.register_stop(function() for _, r in ipairs(rows) do print(r) end end)`;
  const run = runMame({ work, system: profile.mame, lua, seconds, args: ['-ext', 'ssc'] });
  const lines = run.output.split('\n');
  const loads = lines.filter((l) => l.startsWith('ALD ')).map((l) => { const [, t, n] = l.split(' '); return { t: Number(t), n: Number(n) }; });
  const status = lines.filter((l) => l.startsWith('ST ')).map((l) => { const [, read, v] = l.split(' '); return { read: Number(read), v: Number(v) }; });
  return { run, loads, status };
}

function compareLists(a, b, key, hz) {
  let worst = 0, firstBad = -1;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const dt = hz ? Math.abs(a[i].t - b[i].t) * hz : Math.abs(a[i].read - b[i].read);
    if (a[i][key] !== b[i][key] || (hz ? dt >= 0.5 : dt !== 0)) { if (firstBad < 0) firstBad = i; }
    worst = Math.max(worst, dt);
  }
  return { ok: a.length === b.length && firstBad < 0, worst, firstBad };
}

function compare({ profileId = 'coco', seconds = SECONDS } = {}) {
  if (!PROFILES.includes(profileId)) throw new Error(`the speech timing comparison covers ${PROFILES.join(', ')}, not ${profileId}`);
  const tag = `[${profileId} ssc speech]`;
  const M = mame(profileId, seconds), O = ours(profileId, seconds);
  const hz = O.cartClockHz;
  const L = compareLists(O.loads, M.loads, 'n', hz), S = compareLists(O.status, M.status, 'v', 0);
  const expected = cases().length;
  const loadsOk = L.ok && O.loads.length === expected;
  // the run must end with SBY high (bit 6) after the last allophone: the image played to its end on both sides
  const endsIdle = O.status.length > 0 && (O.status[O.status.length - 1].v & 0x40) !== 0;
  // ... and the 6809 saw SBY go from low to high, so the rise's timing is compared, not just the end state
  const sawRise = O.status.some((x, i) => i > 0 && (x.v & 0x40) && !(O.status[i - 1].v & 0x40));
  console.log(`${tag} address loads: ${O.loads.length} ours, ${M.loads.length} MAME's (${expected} allophones), ` +
    `largest time difference ${L.worst.toFixed(3)} card cycles (limit 0.5)` +
    `${L.firstBad >= 0 ? `; first difference at load ${L.firstBad}: ours ${JSON.stringify(O.loads[L.firstBad])}, MAME's ${JSON.stringify(M.loads[L.firstBad])}` : ''}`);
  console.log(`${tag} $FF7E changes: ${O.status.length} ours, ${M.status.length} MAME's, each at the same 6809 read ` +
    `(largest difference ${S.worst} reads)` +
    `${S.firstBad >= 0 ? `; first difference at change ${S.firstBad}: ours ${JSON.stringify(O.status[S.firstBad])}, MAME's ${JSON.stringify(M.status[S.firstBad])}` : ''}` +
    `; ends in standby: ${endsIdle}, SBY's rise seen: ${sawRise}`);
  const ok = loadsOk && S.ok && endsIdle && sawRise;
  console.log(`${tag} RESULT: ${ok ? 'identical' : 'differs'}`);
  return ok ? 0 : 1;
}

module.exports = { ourMachine, ours, mame, compare, PROFILES, SECONDS };

if (require.main === module) {
  const profileId = process.env.SSC_PROFILE || process.argv.slice(2).find((a) => !a.startsWith('--')) || 'coco';
  try { process.exitCode = compare({ profileId }); } catch (e) { console.error(e.stack); process.exitCode = 1; }
}
