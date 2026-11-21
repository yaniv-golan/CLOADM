// bin/cloadm.js beyond the basics: --describe (the interface as data, and every step and error code in the guide), the
// debugger steps (registers, set-register, disasm, step) against the Session's own debugger and disassembler, reset
// and power-cycle, DriveWire stalls, the special keys on both input paths, script quoting and the Dragon 64 Plus's
// second screen, each run as a child process. Only the project's own programs and firmware.
// Run: node tests/cli-agent.test.js
const fs = require('fs'), os = require('os'), path = require('path');
const { spawnSync } = require('child_process');
const Emu = require('./load')();

let fail = 0, n = 0;
const check = (name, cond, detail = '') => { n++; if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name}`); };
const ROOT = path.join(__dirname, '..');
const CLI = path.join(ROOT, 'bin', 'cloadm.js');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cloadm-agent-'));
const tmp = (name) => path.join(TMP, name);
const ENV = Object.assign({}, process.env, { SOURCE_DATE_EPOCH: '1700000000' });
const cli = (args) => {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd: ROOT, env: ENV, encoding: 'utf8', maxBuffer: 64 << 20 });
  return { code: r.status, out: r.stdout, err: r.stderr };
};
const json = (args) => { const r = cli(['--json', ...args]); return Object.assign(r, { json: JSON.parse(r.out) }); };
// the counting program from tests/cli.test.js: DONE is at $3017 (counted by hand there)
const COUNT = ['        ORG $3000', 'START   CLR $3100', 'OUTER   LDX #0', 'INNER   LEAX 1,X', '        CMPX #2000', '        BNE INNER',
  '        INC $3100', '        LDA $3100', '        CMPA #5', '        BNE OUTER', 'DONE    BRA DONE', '        END START', ''].join('\n');
fs.writeFileSync(tmp('count.asm'), COUNT);

// ---------------- --describe ----------------
const { STEPS, ERROR_CODES } = require(CLI);
{
  const r = cli(['--describe']), d = JSON.parse(r.out);
  check('--describe: JSON with the schema version, modes, exit codes, error codes and keys', r.code === 0 && d.schemaVersion === 1 && d.exitCodes[3] === 'media or ROM error'
    && ['command line', 'script'].every((k) => d.modes[k]) && d.errorCodes.timeout.exit === 1 && d.errorCodes['missing-roms'].exit === 3 && d.keys.includes('BREAK'), r.err);
  check('--describe: every step, with its command-line form, help and an example', d.steps.map((s) => s.name).join() === Object.keys(STEPS).join()
    && d.steps.every((s) => s.cli.startsWith(`--${s.name}`) && s.help && s.example) && d.steps.find((s) => s.name === 'wait-for').cli === '--wait-for COND'
    && d.steps.find((s) => s.name === 'disasm').cli === '--disasm [[ADDR][:COUNT]]' && d.steps.find((s) => s.name === 'machine').setup, JSON.stringify(d.steps.slice(0, 2)));
  // every example on the command line parses as written (a shell would take the quotes off)
  const { parseArgs } = require(CLI);
  const bad = d.steps.filter((s) => s.example).filter((s) => {
    const args = [...s.example.matchAll(/'([^']*)'|(\S+)/g)].map((m) => (m[1] != null ? m[1] : m[2]));
    try { parseArgs(args); return false; } catch (e) { return true; }
  });
  check('--describe: every step\'s example parses', !bad.length, bad.map((s) => s.example).join(' | '));
  // the codes the tool raises are the codes it describes: every usage(...,'x'), media(...,'x') and CliError('x' in the source
  const src = fs.readFileSync(CLI, 'utf8');
  const used = new Set([...src.matchAll(/(?:usage|media)\([^;]*?, '([a-z-]+)'\)/g), ...src.matchAll(/new CliError\('([a-z-]+)'/g), ...src.matchAll(/this\.failed\('([a-z-]+)'/g)].map((m) => m[1]));
  check('every error code the tool raises is a described code', used.size >= 12 && [...used].every((c) => c in ERROR_CODES), [...used].filter((c) => !(c in ERROR_CODES)).join());
  // the guide names every step, mode and error code, so the guide and the tool cannot drift apart
  const doc = fs.readFileSync(path.join(ROOT, 'docs/automation.md'), 'utf8');
  const missing = [...Object.keys(STEPS).map((s) => `\`--${s}`), ...Object.keys(ERROR_CODES).map((c) => `\`${c}\``), '--describe'].filter((t) => !doc.includes(t));
  check('docs/automation.md names every step and error code', !missing.length, missing.join(' '));
}

// ---------------- the debugger steps ----------------
{
  // the CLI's registers, disasm and step, against the Session's debugger and disassembler on the same machine state
  // (restored from the snapshot the CLI saved at that moment)
  const snap = tmp('dbg.cloadm-state');
  const r = json(['-m', 'dragon32', '--asm', tmp('count.asm'), '--wait-for', 'mem:$3100=2', '--save-snapshot', snap, '--registers', '--disasm', '--disasm', '$3000:5', '--step', '7', '--registers']);
  const s = new Emu.Session({ welcomeMenu: false });
  s.switchMachine('dragon64', {}, { menu: false });
  (async () => {
    s.openSnapshot(await s.readSnapshot(new Uint8Array(fs.readFileSync(snap))));
    const regs0 = s.debug.registers();
    const st = r.json.steps;
    check('registers: the debugger\'s registers, with the CPU', r.code === 0 && st[3].cpu === '6809' && JSON.stringify(st[3].registers) === JSON.stringify(regs0), JSON.stringify(st[3]) + r.err);
    check('disasm with no address: at the PC, 8 instructions, as disassembleTool gives them', JSON.stringify(Object.assign({ step: 'disasm' }, Emu.disassembleTool(s, { address: regs0.pc, count: 8 }))) === JSON.stringify(st[4]), JSON.stringify(st[4]).slice(0, 200));
    check('disasm $3000:5: the program as assembled (CLR, LDX, LEAX, CMPX, BNE)', st[5].instructions.map((i) => i.text.split(' ')[0]).join() === 'CLR,LDX,LEAX,CMPX,BNE' && st[5].instructions[4].address === 0x300B, JSON.stringify(st[5].instructions.map((i) => i.text)));
    let cycles = 0;
    for (let i = 0; i < 7; i++) cycles += s.debug.step();
    check('step 7: exactly the debugger\'s 7 steps (registers and cycles)', st[6].instructions === 7 && st[6].cycles === cycles && JSON.stringify(st[6].registers) === JSON.stringify(s.debug.registers())
      && JSON.stringify(st[7].registers) === JSON.stringify(s.debug.registers()), JSON.stringify(st[6]));
    finishAsync();
  })().catch((e) => { check('debugger steps against the Session', false, e.stack); finishAsync(); });
  const h = cli(['-m', 'dragon32', '--asm', tmp('count.asm'), '--set-register', 'pc=$3017', '--registers', '--disasm', '--step', '3', '--expect-mem', '$3100=0']);
  check('set-register pc, then the human registers and disasm lines', h.code === 0 && /PC=\$3017 /.test(h.out.split('\n')[0]) && h.out.split('\n')[1] === '$3017  20 FE           BRA $3017'
    && /PC=\$3017/.test(h.out.trim().split('\n').pop()), h.out + h.err);
  const bad = cli(['--set-register', 'zz=1']);
  check('set-register with a register the CPU does not have: exit 3 (refused), names it', bad.code === 3 && /unknown register "zz"/.test(bad.err), bad.err);
  const far = cli(['--disasm', '$1000:65']);
  check('disasm of more than 64 instructions: usage error', far.code === 2 && /count is 1 to 64, not 65/.test(far.err), far.err);
  // malformed or out-of-range arguments are usage errors (exit 2), never a crash (4) nor a refusal (3)
  for (const [arg, re] of [[':', /disasm is \[ADDRESS\]\[:COUNT\], not ":"/], ['$3000:', /not "\$3000:"/], ['$3000:0', /count is 1 to 64, not 0/], ['$3000:65', /count is 1 to 64, not 65/]]) {
    const r = cli(['--disasm', arg]);
    check(`--disasm ${arg}: usage error, exit 2`, r.code === 2 && re.test(r.err), `${r.code} ${r.err}`);
  }
  // a value wider than its register is refused, not cut down: A is 8 bits, PC 16
  for (const [arg, re] of [['a=$1FF', /a's value "\$1FF" is not a number from 0 to 255/], ['pc=$12345', /pc's value "\$12345" is not a number from 0 to 65535/], ['cc=256', /cc's value "256"/]]) {
    const r = cli(['--set-register', arg, '--registers']);
    check(`--set-register ${arg}: usage error, exit 2, nothing set`, r.code === 2 && re.test(r.err) && r.out === '', `${r.code} ${r.err}`);
  }
  const fits = cli(['--set-register', 'a=$FF', '--set-register', 'pc=$FFFF', '--registers']);
  check('--set-register: values that fit are set whole', fits.code === 0 && /A=\$FF /.test(fits.out) && /PC=\$FFFF/.test(fits.out), fits.out + fits.err);
  const big = cli(['--step', '100001']);
  check('step of more than 100000 instructions: usage error', big.code === 2 && /at most 100000/.test(big.err), big.err);
  // On the built-in firmware, reset starts again the program it ran (as the page's Reset does); power-cycle clears RAM
  // to its power-on contents and leaves the bare firmware
  const rp = json(['-m', 'dragon32', '--asm', tmp('count.asm'), '--wait-for', 'pc:$3017', '--poke', '$3200=$AA', '--reset', '--expect-mem', '$3100=0',
    '--wait-for', 'pc:$3017', '--expect-mem', '$3100=5', '--power-cycle', '--frames', '5', '--peek', '$3200', '--info']);
  const fresh = new Emu.Session({ welcomeMenu: false });
  fresh.switchMachine('dragon32', {}, { menu: false });
  const st = rp.json.steps, pc = rp.json.machine.pc;
  check('reset on the built-in firmware: the program starts again (its counter back at 0, then it runs to DONE)', rp.code === 0 && st[3].step === 'reset' && st[5].met && st[6].met, rp.err + JSON.stringify(st.map((x) => x.step)));
  check('power-cycle: RAM at its power-on contents, the program gone', st[9].bytes[0] === fresh.readByte(0x3200) && st[9].bytes[0] !== 0xAA && !(pc >= 0x3000 && pc <= 0x3017), JSON.stringify(st[9]) + ` pc ${pc}`);
}

// ---------------- review fixes: DriveWire stalls, keys, script quoting, the Dragon 64 Plus's second screen ----------------
{
  // A DriveWire read on the Becker port makes the machine wait for the media store (m.stall). The frames still run:
  // the tool waits for the store. LOOP is at $3012 (LDX # 3, LDB # 2, LDA ,X+ 2, STA ext 3, DECB 1, BNE 2, LDA # 2,
  // STA ext 3 bytes from $3000).
  fs.writeFileSync(tmp('dw.asm'), ['        ORG $3000', 'START   LDX #CMD', '        LDB #5', 'SEND    LDA ,X+', '        STA $FF42', '        DECB',
    '        BNE SEND', '        LDA #1', '        STA $0502', 'LOOP    INC $0500', '        BRA LOOP', 'CMD     FCB $D2,0,0,0,0', '        END START', ''].join('\n'));
  const f = json(['-m', 'coco', '-o', 'becker=true', '--asm', tmp('dw.asm'), '--frames', '10', '--peek', '$0502', '--info']);
  check('a DriveWire read that stalls the machine: --frames still runs every frame, and the program goes on', f.code === 0 && f.json.steps[1].frames === 10 && f.json.steps[2].bytes[0] === 1, JSON.stringify(f.json.steps) + f.err);
  const w = json(['-m', 'coco', '-o', 'becker=true', '--asm', tmp('dw.asm'), '--timeout', '1', '--wait-for', 'mem:$0502=1', '--wait-for', 'pc:$3012']);
  check('a DriveWire stall: --wait-for mem and pc are met (no spinning to the timeout)', w.code === 0 && w.json.steps[2].met && w.json.steps[3].met && w.json.machine.pc === 0x3012, JSON.stringify(w.json.error || w.json.steps));

  const pk = cli(['--peek', ':5']);
  check('--peek :5 is a usage error (exit 2), not a crash', pk.code === 2 && /peek is ADDRESS\[:LENGTH\], not ":5"/.test(pk.err), pk.err);

  // The built-in firmware takes key codes through POLCAT ([$A000]); this program stores each code it is given from
  // $3100. The codes are Color BASIC's KEYIN codes (Color BASIC Unravelled II): BREAK $03, CLEAR $0C, LEFT $08,
  // RIGHT $09, DOWN $0A, UP $5E, ENTER $0D.
  fs.writeFileSync(tmp('echo.asm'), ['        ORG $3000', 'START   LDX #$3100', 'POLL    JSR [$A000]', '        BEQ POLL', '        STA ,X+', '        BRA POLL', '        END START', ''].join('\n'));
  const sk = json(['-m', 'coco', '--asm', tmp('echo.asm'), '--type', '{BREAK}{CLEAR}{LEFT}{RIGHT}{DOWN}{UP}a\\n', '--peek', '$3100:9']);
  check('the built-in firmware: each special key reaches POLCAT as its Color BASIC code', sk.code === 0 && sk.json.steps[2].bytes.join() === [3, 12, 8, 9, 10, 0x5E, 0x41, 13, 0].join(), JSON.stringify(sk.json.steps[2]) + sk.err);

  // With a ROM the keys go through the keyboard matrix. Our own firmware, in the Dragon 64's BASIC socket, scans the
  // matrix for six keys (their positions from js/machines/keyboards.js, which tests/input.test.js and the MAME
  // comparisons check) and sets a byte from $3100 for each key seen down.
  const KEYS = ['LEFT', 'RIGHT', 'DOWN', 'UP', 'CLEAR', 'BREAK'], pos = Emu.keyboards[Emu.profiles.dragon64.keyboard];
  const src = ['        ORG $8000', 'RESET   LDS #$7F00', '        CLR $FF03', '        LDA #$FF', '        STA $FF02', '        LDA #$04', '        STA $FF03',
    '        CLR $FF01', '        CLR $FF00', '        LDA #$04', '        STA $FF01', '        LDX #$3100', 'ZERO    CLR ,X+', '        CMPX #$3106', '        BNE ZERO', 'SCAN'];
  KEYS.forEach((k, i) => {
    const [row, col] = pos[k];
    src.push(`        LDA #$${((~(1 << col)) & 0xFF).toString(16)}`, '        STA $FF02', '        LDA $FF00', `        ANDA #$${(1 << row).toString(16)}`, `        BNE N${i}`, '        LDA #1', `        STA $${(0x3100 + i).toString(16)}`, `N${i}`);
  });
  src.push('        BRA SCAN', '');
  const res = Emu.assemble(src.join('\n'), '6809');
  const rom = new Uint8Array(0x4000);
  rom.set(res.segments[0].data, 0);
  rom[0x3FFE] = 0x80; rom[0x3FFF] = 0x00;
  fs.mkdirSync(tmp('scanrom'));
  fs.writeFileSync(tmp('scanrom/d64_1.rom'), rom);
  const one = json(['-m', 'dragon64', '--roms', tmp('scanrom'), '--frames', '5', '--peek', '$3100:6', '--type', '{LEFT}', '--frames', '5', '--peek', '$3100:6']);
  const all = json(['-m', 'dragon64', '--roms', tmp('scanrom'), '--frames', '5', '--type', '{RIGHT}{DOWN}{UP}{CLEAR}{BREAK}', '--frames', '5', '--peek', '$3100:6']);
  check('with a ROM: {LEFT} presses LEFT on the matrix, and only it', res.ok && one.code === 0 && one.json.machine.roms && one.json.steps[1].bytes.join() === '0,0,0,0,0,0' && one.json.steps[4].bytes.join() === '1,0,0,0,0,0', JSON.stringify(one.json.steps) + one.err);
  check('with a ROM: {RIGHT} {DOWN} {UP} {CLEAR} {BREAK} each press their key', all.code === 0 && all.json.steps[3].bytes.join() === '0,1,1,1,1,1', JSON.stringify(all.json.steps[3]) + all.err);

  // Script quoting: an argument that starts and ends with a double quote loses that one pair, nothing else; so
  // ""A"" types "A" with its quotes, and " B " keeps its spaces. A flag's argument is taken as it is.
  fs.writeFileSync(tmp('quotes.cloadm'), ['machine coco', `asm ${tmp('echo.asm')}`, 'type ""A""', 'type " B "', 'type "C', 'peek $3100:9'].join('\n'));
  const q = json(['--script', tmp('quotes.cloadm')]);
  check('script quoting: one surrounding pair of quotes is taken off, the rest kept', q.code === 0 && String.fromCharCode(...q.json.steps[4].bytes) === '"A" B "C\0', JSON.stringify(q.json.steps[4]) + q.err);
  const fl = json(['-m', 'coco', '--asm', tmp('echo.asm'), '--type', '"A"', '--peek', '$3100:4']);
  check('a flag\'s argument keeps its quotes', fl.code === 0 && String.fromCharCode(...fl.json.steps[2].bytes) === '"A"\0', JSON.stringify(fl.json.steps[2]));

  // The Dragon 64 Plus's 80-column screen, reached with --view plus (the page's Display tab). This program sets up the
  // HD6845S as plus.asm does (80 columns, 22 rows of 12 lines, from $0000), maps the 2K video RAM over $0000 ($FFE2 = 1),
  // fills it with spaces, writes a line and maps the standard bank back.
  const R = [113, 80, 96, 0x0F, 25, 4, 22, 24, 0, 11, 0x20, 11, 0, 0];
  const plus = ['        ORG $3000', 'START   ORCC #$50'];
  R.forEach((v, i) => plus.push(`        LDA #${i}`, '        STA $FFE0', `        LDA #${v}`, '        STA $FFE1'));
  plus.push('        LDA #1', '        STA $FFE2', '        LDU #$0000', '        LDA #$20', 'BLANK   STA ,U+', '        CMPU #$0800', '        BNE BLANK', '        LDX #MSG', '        LDU #$0000', 'COPY    LDA ,X+', '        BEQ DONE', '        STA ,U+', '        BRA COPY',
    'DONE    CLR $FFE2', 'HOLD    BRA HOLD', 'MSG     FCC "HELLO FROM THE PLUS"', '        FCB 0', '        END START', '');
  fs.writeFileSync(tmp('plus.asm'), plus.join('\n'));
  const v = json(['-m', 'd64plus', '--asm', tmp('plus.asm'), '--frames', '3', '--view', 'plus', '--screen', '--view', 'main', '--screen']);
  check('--view plus: screen reads the 80-column HD6845S screen; --view main the VDG again', v.code === 0 && v.json.steps[3].text && v.json.steps[3].cols === 80
    && v.json.steps[3].lines[0] === 'HELLO FROM THE PLUS' && v.json.steps[5].cols === 32 && v.json.steps[5].mode !== v.json.steps[3].mode, JSON.stringify(v.json.steps.slice(3)).slice(0, 400) + v.err);
  const one1 = cli(['-m', 'coco', '--view', 'plus']);
  check('--view on a machine with one screen: refused, exit 3', one1.code === 3 && /has one screen/.test(one1.err), one1.err);
}

let pending = 1;
function finishAsync() {
  if (--pending) return;
  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(fail ? `${fail} FAILED` : `${n}/${n} CLI agent checks passed`);
  process.exitCode = fail ? 1 : 0;
}
