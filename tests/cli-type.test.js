// node cli/cloadm.js --type on a machine with ROMs types paced by what the machine consumes (the typing Claude's type_text does).
// Unpaced, a busy line editor lost keys: typing a listing back to back, line 200 became line 0 (the first digit of the number, pressed
// as the machine was storing the line before it, was never read). The oracle is the scanning firmware tests/typing-firmware.js, which
// logs every new key press (column*8 + row, from the machine's own matrix layout, not from the code under test) and is busy after each
// ENTER and every fourth pass over the keyboard. It is installed as the Dragon 64's BASIC ROM files (with a reset vector) and the tool
// runs as a child process: the log is read back with --peek.
const fs = require('fs'), os = require('os'), path = require('path');
const { spawnSync } = require('child_process');
const Emu = require('./load')();
const firmware = require('./typing-firmware');

let fail = 0;
const check = (name, cond, detail = '') => { if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name}`); };
const CLI = path.join(__dirname, '..', 'cli', 'cloadm.js');
const m0 = Emu.createMachine('dragon64');
const code = (key) => { if (!m0.keyPos[key]) throw new Error(`no key ${key}`); return m0.keyPos[key][1] * 8 + m0.keyPos[key][0]; };
const ENTER = code('ENTER');
const made = [];   // the temporary directories, removed when the test ends
// the ROM files: the firmware at $8000 with the reset vector, in both of the Dragon 64's 16K banks
function roms(busy) {
  const asm = Emu.assemble(firmware('6809', ENTER, busy) + '\n        ORG     $BFFE\n        FDB     START\n', '6809');
  if (!asm.ok) throw new Error(asm.errors.map((e) => `line ${e.line}: ${e.message}`).join('; '));
  const rom = new Uint8Array(0x4000).fill(0xFF);
  for (const seg of asm.segments) rom.set(seg.data, seg.addr - 0x8000);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cloadm-cli-type-'));
  made.push(dir);
  fs.writeFileSync(path.join(dir, 'd64_1.rom'), rom); fs.writeFileSync(path.join(dir, 'd64_2.rom'), rom);
  return dir;
}
function run(dir, text, extra = []) {
  const r = spawnSync(process.execPath, [CLI, '--json', '--machine', 'dragon64', '--roms', dir, '--frames', '10', '--type', text, '--frames', '30', '--peek', '0x300:1', '--peek', '0x340:48', ...extra], { encoding: 'utf8' });
  let json; try { json = JSON.parse(r.stdout); } catch (e) { json = { unparsable: r.stdout.slice(0, 200) }; }
  const peek = (json.steps || []).filter((s) => s.step === 'peek');
  return { code: r.status, json, count: peek[0] && peek[0].bytes[0], log: peek[1] ? peek[1].bytes.slice(0, peek[0].bytes[0]) : [] };
}
// what the keyboard should have seen for text: one code per character, the way a person's fingers press it
const keysFor = (text) => [...text].map((c) => code(c === '\n' ? 'ENTER' : c === ' ' ? 'SPACE' : c.toUpperCase()));

const busy = roms('busy');
{
  const text = '1\n2\n3\n4\n5\n', r = run(busy, text);
  check('five one-digit lines back to back: every key reaches the busy machine, in order', r.code === 0 && JSON.stringify(r.log) === JSON.stringify(keysFor(text)), `code ${r.code} saw ${r.log.join()} want ${keysFor(text).join()}`);
}
{
  const text = '10 A\n20 B\n200 C\n300 D\n', r = run(busy, text);
  check('a listing typed back to back: line 200 and 300 keep their first digit', r.code === 0 && JSON.stringify(r.log) === JSON.stringify(keysFor(text)), `code ${r.code} saw ${r.log.join()} want ${keysFor(text).join()}`);
}
{
  const r = run(roms('hang'), 'AB\nCD\n');
  const err = r.json && r.json.error;
  check('firmware that stops reading the keyboard after an ENTER: the step fails keys-not-taken, saying how many keys the machine took',
    r.code === 1 && err && err.code === 'keys-not-taken' && /took \d+ of the 6 typed keys/.test(err.message), JSON.stringify(err || r.json).slice(0, 240));
}
{
  // the built-in firmware (no ROMs) takes key codes from its own queue, as it did: a line typed to it still arrives whole
  const r = spawnSync(process.execPath, [CLI, '--json', '--machine', 'dragon64', '--program', 'liza', '--type', 'HELLO\n', '--frames', '30', '--screen'], { encoding: 'utf8' });
  check('no ROMs: --type still works on the built-in firmware (a line typed to LIZA is on the screen)', r.status === 0 && /HELLO/.test(r.stdout), r.stderr.slice(0, 200));
}
for (const d of made) fs.rmSync(d, { recursive: true, force: true });
console.log(fail ? `${fail} FAILED` : 'all passed');
process.exitCode = fail ? 1 : 0;
