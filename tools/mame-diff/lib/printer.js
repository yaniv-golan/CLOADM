// Printer output against MAME, byte for byte: run.js <profile> --printer.
//
// The family's printer firmware prints every byte value and a line of text. Both emulators run it:
//   1. in lockstep, instruction by instruction, to HALT (so both send every byte at the same cycle);
//   2. MAME with its printer writing to a file (-prin), until the firmware's done flag is set and the last
//      character has had time to arrive; ours until the same point. The two byte streams must be identical,
//      and must be what the firmware sent (every value 0-255, then its text), so an empty or partial output
//      cannot pass.
// Exit code 0 only if the trace is identical, the firmware reaches HALT and the bytes match.
const fs = require('fs'), path = require('path');
const { lockstep } = require('./lockstep');
const { runMame } = require('./mame');

// t: { label, system, work, args, regs, waitOps, haltPc, install(), machine(), doneAddr, text, seconds,
//      atReset: bytes the printer receives when the machine is reset, before the firmware runs,
//      glitched: bytes a glitch firmware's glitch prints before its own (printer-glitch.asm: [$FF]) }
async function runPrinter(t, { trace = true } = {}) {
  let ok = true;
  t.install();
  if (trace) {
    const code = await lockstep(Object.assign({}, t, { label: `${t.label} printer`, machine: t.machine() }));
    if (code) ok = false;
  }
  const prn = path.join(t.work, 'printer.prn');
  try { fs.unlinkSync(prn); } catch (e) { /* none */ }
  // MAME: until the done flag, then 30 more frames (the last character's stop bit is long received by then)
  runMame({
    work: t.work, system: t.system, seconds: t.seconds, args: [...t.args, '-prin', prn],
    lua: `local space = manager.machine.devices[":maincpu"].spaces["program"]
local after = -1
emu.register_frame_done(function()
  if after < 0 and space:read_u8(${t.doneAddr}) == 255 then after = 30 end
  if after > 0 then after = after - 1 elseif after == 0 then manager.machine:exit() end
end)
`,
  });
  const mame = fs.existsSync(prn) ? [...fs.readFileSync(prn)] : null;
  // ours: the same rule
  const m = t.machine();
  let after = -1;
  for (let f = 0; f < 60 * 60 && after !== 0; f++) {
    m.runFrame();
    if (after < 0 && m.read(t.doneAddr) === 0xFF) after = 30;
    else if (after > 0) after--;
  }
  const ours = m.printed.slice();
  const expected = [...(t.atReset || []), ...(t.glitched || []), ...Array(256).keys(), ...Buffer.from(t.text, 'latin1')];
  const same = (a, b) => a && b && a.length === b.length && a.every((v, i) => v === b[i]);
  const firstDiff = (a, b) => { for (let i = 0; i < Math.max(a.length, b.length); i++) if (a[i] !== b[i]) return i; return -1; };
  if (!mame) { console.log(`[${t.label}] MAME wrote no printer file`); ok = false; }
  else if (!same(mame, ours)) {
    const i = firstDiff(mame, ours);
    console.log(`[${t.label}] printer output differs: MAME ${mame.length} bytes, ours ${ours.length}; first difference at byte ${i} (MAME ${mame[i]}, ours ${ours[i]})`);
    ok = false;
  } else if (!same(ours, expected)) {
    const i = firstDiff(expected, ours);
    console.log(`[${t.label}] both printed the same ${ours.length} bytes, but not what the firmware sent: first difference at byte ${i}`);
    ok = false;
  } else console.log(`[${t.label}] printer output identical: ${ours.length} bytes (${t.atReset && t.atReset.length ? `${t.atReset.length} at reset, ` : ''}${t.glitched && t.glitched.length ? `${t.glitched.length} from the glitch, ` : ''}every value 0-255 and the text), MAME and ours`);
  if (ok) fs.rmSync(t.work, { recursive: true, force: true });
  return ok ? 0 : 1;
}

module.exports = { runPrinter };
