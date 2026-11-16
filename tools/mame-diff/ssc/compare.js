// The Speech/Sound Pak's interrupt case, compared against MAME 0.264 on both sides (case c).
//
// The case is the PIC with IOCNT0 = $30 (INT3 enabled) and the 6809 with an unbounded wait, so every command is
// serviced through the ISR. The two CPUs genuinely overlap, and MAME interleaves them on its scheduler, so an
// instruction lockstep cannot be the oracle (the poll counts between a command and its service differ). The
// outcome can: the ordered sequence of SP0256 allophone loads and AY-3-8913 address/data writes (value and
// order), the firmware's work RAM at $0400-$0405, and HALT on both sides.
//
// Both sides are captured at the same point - where the board's decode ends. MAME's rows come from tapping the
// PIC's peripheral writes (P8 port C at >0108, P10 port D at >010A) and applying MAME's own coco_ssc.cpp decode
// in Lua; our rows come from writes.js, which wraps the three calls this emulator's decode ends in (AY address,
// AY data, SP0256 address load).
//
//   node tools/mame-diff/ssc/compare.js            # the CoCo 1/2
//   node tools/mame-diff/ssc/compare.js coco3      # or SSC_PROFILE=coco3; one run per model
//
// Every model the page offers the Pak on needs its own run: the CoCo 2B and the CoCo 3 each have their own cart
// port and sound mux, and the CoCo 3 adds the GIME. tests/regress.test.js keys the INT3 outcome per model for the
// same reason.
//
// Exits 0 only when both sides' write sequences and work RAM agree and both reach HALT.
const path = require('path'), cp = require('child_process');
const { baseArgs, env, MAME } = require('../lib/mame.js');
const spec = require('./spec.js');
const { mameWritesLua } = require('./writes.js');
const { runInt3 } = require('./outcome.js');

// MAME's side of the case, in one run. The Lua records the same rows writes.js does (mameWritesLua), plus the
// firmware's work RAM and whether the 6809 ever sat on its HALT loop. HALT is `BRA HALT`, so its two bytes are
// fetched on every pass; sampling the PC once a frame catches it as long as the loop runs for a frame, which it
// does (the firmware stops there for the rest of the run).
function mameInt3({ seconds = 12, profileId = 'coco' } = {}) {
  const t = spec.trace(profileId, 'int3');
  t.install();
  const fs = require('fs');
  const lua = mameWritesLua() + `
local m = manager.machine
local cpu9 = m.devices[":maincpu"]
local s9 = cpu9.spaces["program"]
local sawHalt, lastPc = false, -1
local HALT = ${t.haltPc}
emu.register_frame_done(function()
  local pc = cpu9.state["PC"].value
  -- HALT is a BRA to itself. MAME samples the PC at a frame boundary, which can fall on the opcode byte or
  -- the operand byte, so both count; the address comes from the firmware assembled for this run, never a
  -- constant here, because any change before HALT moves it.
  if pc == HALT or pc == HALT + 1 then sawHalt = true end
  lastPc = pc
end)
emu.register_stop(function()
  print(string.format("HALTED %s lastPc=%04X", tostring(sawHalt), lastPc))
  print(string.format("RAM %02X %02X %02X %02X %02X %02X",
    s9:read_u8(0x400), s9:read_u8(0x401), s9:read_u8(0x402),
    s9:read_u8(0x403), s9:read_u8(0x404), s9:read_u8(0x405)))
end)
`;
  const luaFile = path.join(t.work, 'compare.lua');
  fs.writeFileSync(luaFile, lua);
  const r = cp.spawnSync(MAME, [...baseArgs(t.work, t.system, luaFile, seconds, false), ...t.args],
    { encoding: 'utf8', timeout: 600000, killSignal: 'SIGKILL', env: env(t.work, false) });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  const rows = out.split('\n').filter((l) => /^WSEQ /.test(l)).map((l) => l.slice(5));
  const ramLine = out.split('\n').find((l) => /^RAM /.test(l));
  const haltLine = out.split('\n').find((l) => /^HALTED /.test(l));
  const halted = !!haltLine && /^HALTED true/.test(haltLine);
  const ram = ramLine ? ramLine.slice(4).trim().split(/\s+/).map((h) => parseInt(h, 16)) : [];
  return { rows, ram, halted };
}

// the same two things from our side, in the flat row shape MAME prints ("<command> <device>:<op>=<value>")
function oursFlat(r) {
  const rows = [];
  for (const line of r.lines) {
    const [n, ...rest] = line.split(' ');
    for (const e of rest) rows.push(`${n} ${e}`);
  }
  return rows;
}

function compareInt3({ seconds = 12, profileId = 'coco' } = {}) {
  const mame = mameInt3({ seconds, profileId });
  const ours = runInt3({ profileId });
  const ourRows = oursFlat(ours);
  // A run that produced no rows or no RAM (MAME died, the Lua never reached register_stop, the taps missed)
  // must fail rather than compare two empty lists and call them equal.
  const missing = [];
  if (!mame.rows.length) missing.push('MAME wrote no device rows');
  if (mame.ram.length !== 6) missing.push(`MAME reported ${mame.ram.length} work-RAM bytes, expected 6`);
  if (ours.ram.length !== 6) missing.push(`this emulator reported ${ours.ram.length} work-RAM bytes, expected 6`);
  if (!ourRows.length) missing.push('this emulator wrote no device rows');
  const writeDiffs = [];
  for (let i = 0; i < Math.max(mame.rows.length, ourRows.length); i++) {
    if (mame.rows[i] !== ourRows[i]) writeDiffs.push({ row: i, mame: mame.rows[i] ?? null, ours: ourRows[i] ?? null });
  }
  const ramDiffs = [];
  for (let i = 0; i < Math.max(mame.ram.length, ours.ram.length); i++) {
    if (mame.ram[i] !== ours.ram[i]) ramDiffs.push({ addr: 0x400 + i, mame: mame.ram[i] ?? null, ours: ours.ram[i] ?? null });
  }
  // No time-out check: this build has no time-out path (gen-roms.js substitutes `INC TIMEOUTS` out), so $0410
  // cannot vary. Reaching HALT IS the proof that every command was answered, because the unbounded poll would
  // otherwise never return.
  const ok = !missing.length && !writeDiffs.length && !ramDiffs.length && mame.halted && ours.halted;
  return { ok, seconds, mame, ours, ourRows, writeDiffs, ramDiffs, missing };
}

if (require.main === module) {
  // SSC_PROFILE selects the machine. Every model the page offers the Pak on must be compared on its own, because
  // each has its own cart-port decode, sound mux and (on the CoCo 3) GIME.
  const profileId = process.env.SSC_PROFILE || process.argv[2] || 'coco';
  const r = compareInt3({ seconds: Number(process.env.SSC_SECONDS || 12), profileId });
  const hex = (v) => (v == null ? '--' : v.toString(16).toUpperCase().padStart(2, '0'));
  console.log(`[${profileId} ssc int3] MAME 0.264 vs this emulator, ${r.seconds} emulated seconds`);
  if (r.missing.length) for (const m of r.missing) console.log(`  MISSING: ${m}`);
  console.log(`  MAME: HALT ${r.mame.halted ? 'reached' : 'NOT reached'}, ${r.mame.rows.length} device writes, ` +
    `work RAM $0400-$0405 ${r.mame.ram.map(hex).join(' ')}`);
  console.log(`  ours: HALT ${r.ours.halted ? 'reached' : 'NOT reached'} after ${r.ours.steps} instructions, ` +
    `${r.ourRows.length} device writes, work RAM $0400-$0405 ${r.ours.ram.map(hex).join(' ')}`);
  if (r.writeDiffs.length) {
    console.log(`  device writes DIFFER at ${r.writeDiffs.length} row(s):`);
    for (const d of r.writeDiffs.slice(0, 8)) console.log(`    row ${d.row}: mame ${d.mame ?? '--'} | ours ${d.ours ?? '--'}`);
  } else console.log(`  device writes identical: ${r.ourRows.length} rows`);
  if (r.ramDiffs.length) {
    console.log(`  work RAM DIFFERS at ${r.ramDiffs.length} byte(s):`);
    for (const d of r.ramDiffs) console.log(`    $${d.addr.toString(16).toUpperCase()}: mame ${hex(d.mame)} | ours ${hex(d.ours)}`);
  } else console.log('  work RAM identical');
  console.log(r.ok ? '  RESULT: identical' : '  RESULT: differs');
  process.exitCode = r.ok ? 0 : 1;
}

module.exports = { compareInt3, mameInt3 };
