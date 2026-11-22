// The cloadm command-line tool (cli/cloadm.js), run as a child process the way CI and agents run it: exit codes,
// the --json shape, wait-for conditions (met and timed out), typing (the stub's key codes and the keyboard matrix,
// special keys), screen text exactly as Claude's screen_text reader returns it, a PNG decoded back to the pixels of
// machine.render(), snapshots that continue identically, script mode, bad arguments, missing ROMs and wrong media,
// and the examples in docs/automation.md (run here, so the guide cannot rot).
// Only the project's own programs and firmware: the welcome program, LIZA, the demo, programs assembled with the
// bundled assembler, and the key-echo firmware (tools/keyecho) wrapped by this test into a 16K image that stands
// in for a BASIC ROM. No ROM image is used.
// Run: node tests/cli.test.js
const fs = require('fs'), os = require('os'), path = require('path'), zlib = require('zlib');
const { spawnSync } = require('child_process');
const Emu = require('./load')();
const { keyechoBinary } = require('../tools/keyecho/gen-keyecho.js');

let fail = 0, n = 0;
const check = (name, cond, detail = '') => { n++; if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name}`); };
const ROOT = path.join(__dirname, '..');
const CLI = path.join(ROOT, 'cli', 'cloadm.js');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cloadm-cli-'));
const tmp = (name) => path.join(TMP, name);
const ENV = Object.assign({}, process.env, { SOURCE_DATE_EPOCH: '1700000000' });

// the tool as a child process -> { code, out, err, json (when --json) }
function cli(args, { cwd = ROOT, input } = {}) {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd, env: ENV, encoding: 'utf8', input, maxBuffer: 64 << 20 });
  let json = null;
  if (args.includes('--json')) { try { json = JSON.parse(r.stdout); } catch (e) { json = { unparsable: r.stdout }; } }
  return { code: r.status, out: r.stdout, err: r.stderr, json };
}
const stepOf = (json, name, i = 0) => json.steps.filter((s) => s.step === name)[i];

// ---- an independent PNG decoder: chunks with their CRCs, IDAT inflated, every filter type undone ----
function decodePng(buf) {
  const sig = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
  if (!sig.every((b, i) => buf[i] === b)) throw new Error('no PNG signature');
  let at = 8, ihdr = null, crcOk = true;
  const idat = [];
  while (at < buf.length) {
    const len = buf.readUInt32BE(at), type = buf.toString('latin1', at + 4, at + 8), data = buf.subarray(at + 8, at + 8 + len);
    if ((zlib.crc32(buf.subarray(at + 4, at + 8 + len)) >>> 0) !== buf.readUInt32BE(at + 8 + len)) crcOk = false;
    if (type === 'IHDR') ihdr = { w: data.readUInt32BE(0), h: data.readUInt32BE(4), depth: data[8], colour: data[9] };
    if (type === 'IDAT') idat.push(data);
    at += 12 + len;
    if (type === 'IEND') break;
  }
  if (ihdr.depth !== 8 || ihdr.colour !== 6) throw new Error(`not 8-bit RGBA: ${JSON.stringify(ihdr)}`);
  const raw = zlib.inflateSync(Buffer.concat(idat)), stride = ihdr.w * 4, px = Buffer.alloc(stride * ihdr.h);
  for (let y = 0; y < ihdr.h; y++) {
    const f = raw[y * (stride + 1)], line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= 4 ? px[y * stride + x - 4] : 0, b = y ? px[(y - 1) * stride + x] : 0, c = x >= 4 && y ? px[(y - 1) * stride + x - 4] : 0;
      const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
      const pred = [0, a, b, (a + b) >> 1, pa <= pb && pa <= pc ? a : pb <= pc ? b : c][f];
      px[y * stride + x] = (line[x] + pred) & 0xFF;
    }
  }
  return { width: ihdr.w, height: ihdr.h, pixels: px, crcOk };
}

// the same machine in this process, run frame by frame with machine.runFrame() (not through the tool)
function welcomeHere(id, frames) {
  const s = new Emu.Session({ welcomeMenu: false });
  s.switchMachine(id, {}, { menu: false });
  s.startWelcome(new Uint8Array(fs.readFileSync(path.join(ROOT, 'examples', s.welcomeFile))));
  for (let i = 0; i < frames; i++) s.shownMachine.runFrame();
  return s;
}
const target = (s) => ({ machine: s.shownMachine, screenText: () => s.screenText(), readByte: (a) => s.readByte(a) });

// ---------------- Session.runFrames, which the tool runs on ----------------
{
  // n frames through runFrames are the frames machine.runFrame() runs, and no clock is read
  const a = welcomeHere('dragon64', 0), b = welcomeHere('dragon64', 30);
  const realNow = Date.now;
  let clockRead = false;
  Date.now = () => { clockRead = true; return realNow(); };
  const ran = a.runFrames(30);
  Date.now = realNow;
  check('runFrames(30) runs 30 frames, reading no clock', ran === 30 && a.shownMachine.frameCount === b.shownMachine.frameCount && !clockRead, `${ran} ${clockRead}`);
  check('runFrames gives the frames machine.runFrame() gives', Buffer.from(Emu.frameToRGBA(a.shownMachine.render()).buffer).equals(Buffer.from(Emu.frameToRGBA(b.shownMachine.render()).buffer)));
  // fast tape and turbo are about wall-clock time: runFrames ignores them (advance() would run up to 60 frames)
  a.turbo = true;
  check('runFrames ignores turbo', a.runFrames(2) === 2 && a.shownMachine.frameCount === b.shownMachine.frameCount + 2);
  a.turbo = false;
  // a breakpoint stops it part way: fewer frames, the machine paused at the address
  const pc = a.shownMachine.cpu.pc;
  a.debug.addBreakpoint(pc);
  const before = a.shownMachine.frameCount, got = a.runFrames(50);
  check('runFrames stops at a breakpoint: fewer frames, paused at the address', got < 50 && a.paused && a.shownMachine.cpu.pc === pc && a.runFrames(5) === 0, `${got} ${a.paused} ${before}`);
}

// ---------------- usage: exit 2 ----------------
{
  const h = cli(['--help']);
  check('--help exits 0 and lists the steps and the exit codes', h.code === 0 && /--wait-for COND/.test(h.out) && /Exit codes: 0 success, 1 a condition failed, 2 usage error, 3 media or ROM error/.test(h.out), h.err);
  const l = cli(['--list-machines', '--json']);
  check('--list-machines --json lists every profile with its options', l.code === 0 && JSON.parse(l.out).map((p) => p.id).join() === Object.keys(Emu.profiles).join()
    && JSON.parse(l.out).find((p) => p.id === 'mc10').options.ram.values.join() === Emu.profiles.mc10.options.ram.values.join(), l.err);
  const bad = [
    [[], /nothing to do/],
    [['--frobnicate'], /unknown option --frobnicate/],
    [['stray'], /unexpected argument "stray"/],
    [['--machine', 'zx81'], /no machine "zx81"/],
    [['--machine'], /--machine needs ID/],
    [['-m', 'coco', '--option', 'ram=48', '--frames', '1'], /ram on the CoCo 1\/2 is 4 or 16 or 32 or 64, not 48/],
    [['-m', 'mc10', '--option', 'cpu=6309', '--frames', '1'], /cpu on the MC-10 is 6803, not 6309/],
    [['-m', 'mc10', '--option', 'hires=none', '--frames', '1'], /the MC-10 has no option "hires"/],
    [['--peek', '$10000'], /address "\$10000" is not a number from 0 to 65535/],
    [['--peek', '$FFFF:2'], /runs past \$FFFF/],
    [['--wait-for', 'screen:OK'], /a wait-for condition is text:REGEX, mem:ADDRESS=VALUE or pc:ADDRESS/],
    [['--expect-screen', '(unclosed'], /not a regular expression/],
    [['--expect-mem', '$400'], /expected ADDRESS=VALUE/],
    [['--frames', '0'], /frames must be a positive whole number/],
    [['--type', '{F1}'], /unknown key \{F1\}/],
    [['--type', 'a\\q'], /unknown escape \\q/],
    [['--frames', '1', '--machine', 'coco'], /machine sets up the machine, so it must come before every other step/],
    [['--program', 'pacman'], /program is welcome, liza, demo, 2048 or minesweeper/],
    [['--screen', 'now'], /unexpected argument "now"/],
  ];
  for (const [args, re] of bad) {
    const r = cli(args);
    check(`usage error exits 2: ${args.join(' ') || '(nothing)'}`, r.code === 2 && re.test(r.err) && r.out === '', `code ${r.code} ${r.err}`);
  }
  const j = cli(['--json', '--frames', 'x']);
  check('a usage error under --json is the JSON object, with error.kind usage and exit 2', j.code === 2 && j.json.ok === false && j.json.exit === 2
    && j.json.error.kind === 'usage' && /frames must be/.test(j.json.error.message) && j.json.machine === null && j.err === '', JSON.stringify(j.json));
  // typing a character the keyboard cannot produce is the caller's mistake
  const t = cli(['-m', 'coco', '--program', 'liza', '--type', 'café']);
  check('a character with no key is a usage error', t.code === 2 && /no key for "é"/.test(t.err), t.err);
}

// ---------------- media and ROMs: exit 3 ----------------
{
  fs.writeFileSync(tmp('junk.xyz'), Buffer.from('this is no program at all'));
  fs.writeFileSync(tmp('junk.dsk'), Buffer.alloc(1000, 0xE5));
  fs.writeFileSync(tmp('prog.bas'), '10 PRINT "HI"\n20 GOTO 10\n');
  fs.writeFileSync(tmp('bad.asm'), '        ORG $3000\n        LDA #$1234X\n        FROB\n');
  fs.mkdirSync(tmp('roms-junk'));
  fs.writeFileSync(tmp('roms-junk/notes.txt'), 'not a ROM');
  const bad = [
    [['--load', tmp('missing.bin')], /cannot read the file .*missing\.bin: ENOENT/],
    [['--script', tmp('none.txt')], /cannot read the script .*none\.txt: ENOENT/],
    [['--load', tmp('junk.xyz')], /junk\.xyz: unknown format \(25 bytes\)/],
    [['-m', 'coco', '--load', tmp('prog.bas')], /BASIC listing/],
    [['--cart', path.join(ROOT, 'examples/demo.bin')], /not a cartridge ROM image/],
    [['--disk', tmp('junk.dsk')], /not a disk image CLOADM can read/],
    [['-m', 'mc10', '--disk', path.join(ROOT, 'tests/fixtures/disks/dragondos.vdk')], /has no disk drives/],
    [['-m', 'coco', '--disk', '4=' + tmp('junk.dsk')], /cannot read the disk image 4=/],
    [['--tape', tmp('junk.xyz')], /junk\.xyz: not a tape/],
    [['--asm', tmp('bad.asm')], /bad\.asm: /],
    [['--load-snapshot', tmp('junk.xyz')], /./],
    [['--roms', tmp('no-such-dir'), '--frames', '1'], /cannot read the ROMs/],
    [['--roms', tmp('roms-junk'), '--frames', '1'], /missing ROMs: the Dragon 64 needs 32K-mode BASIC/],
    [['-m', 'mc10', '--program', 'demo'], /the demo is 6809 code/],
    [['-m', 'mc10', '--option', 'ram=4', '--program', 'liza'], /LIZA needs 20K RAM/],
    [['--screenshot', path.join(TMP, 'no-dir', 'x.png')], /cannot write/],
  ];
  for (const [args, re] of bad) {
    const r = cli(args);
    check(`media/ROM error exits 3: ${args.map((a) => a.replace(TMP, '$TMP').replace(ROOT, '.')).join(' ')}`, r.code === 3 && re.test(r.err), `code ${r.code} ${r.err}`);
  }
  const j = cli(['--json', '--roms', tmp('roms-junk')]);
  check('missing ROMs under --json: exit 3, error.kind media, the rejected file reported', j.code === 3 && j.json.error.kind === 'media'
    && j.json.roms.length === 1 && j.json.roms[0].name === 'notes.txt' && j.json.roms[0].machines.length === 0, JSON.stringify(j.json));
  // without --roms there is nothing missing: the machine runs the built-in firmware
  const ok = cli(['--json', '--frames', '1']);
  check('no --roms: the built-in firmware, exit 0', ok.code === 0 && ok.json.machine.roms === false && ok.json.machine.machine === 'dragon64', ok.err);
}

// ---------------- the --json shape ----------------
{
  const r = cli(['--json', '-m', 'coco', '-o', 'ram=32', '--program', 'liza', '--seconds', '1', '--info', '--peek', '$0400:4']);
  // the frames the start itself runs (the firmware's power-on and the program's load), from a run that only starts
  const startFrame = cli(['--json', '-m', 'coco', '-o', 'ram=32', '--program', 'liza']).json.machine.frame;
  const j = r.json;
  check('--json: one object, ok/exit/machine/steps', r.code === 0 && j.ok === true && j.exit === 0 && Array.isArray(j.steps) && !('error' in j)
    && Object.keys(j).join() === 'ok,exit,machine,steps', r.out.slice(0, 200));
  check('--json machine: id, name, the options given, ROMs, frame, PC', j.machine.machine === 'coco' && j.machine.name === 'CoCo 1/2' && j.machine.config.ram === 32
    && j.machine.roms === false && j.machine.frame === startFrame + 60 && Number.isInteger(j.machine.pc), JSON.stringify(j.machine));
  check('--json steps in order, each named', j.steps.map((s) => s.step).join() === 'program,seconds,info,peek', JSON.stringify(j.steps.map((s) => s.step)));
  check('--json seconds: 1 s of a 60 Hz machine is 60 frames', stepOf(j, 'seconds').frames === 60, JSON.stringify(stepOf(j, 'seconds')));
  // LIZA's title in VDG codes, as LIZA wrote it (L I Z A)
  check('--json peek: address, length, bytes', stepOf(j, 'peek').address === 0x400 && stepOf(j, 'peek').bytes.join() === [0x4C, 0x49, 0x5A, 0x41].join(), JSON.stringify(stepOf(j, 'peek')));
  const human = cli(['-m', 'coco', '-o', 'ram=32', '--program', 'liza', '--seconds', '1', '--peek', '$0400:20']);
  check('human peek: 16 bytes a line, $address first', human.code === 0 && human.out === '$0400: 4C 49 5A 41 60 6D 60 41 60 44 52 41 47 4F 4E 60\n$0410: 76 74 60 54\n', JSON.stringify(human.out));
}

// ---------------- screen text and PNG against the machine in this process ----------------
for (const [id, frames] of [['coco', 50], ['mc10', 50], ['coco3', 40]]) {
  const png = tmp(`welcome-${id}.png`);
  const r = cli(['--json', '-m', id, '--program', 'welcome', '--frames', String(frames), '--screen', '--screenshot', png]);
  const here = welcomeHere(id, frames);
  const want = Emu.screenTextTool(target(here));
  check(`${id}: screen text is screen_text's answer for the same frames`, r.code === 0 && JSON.stringify(Object.assign({ step: 'screen' }, want)) === JSON.stringify(stepOf(r.json, 'screen'))
    && want.text && want.lines.length > 5, `${JSON.stringify(stepOf(r.json, 'screen'))} vs ${JSON.stringify(want)}`);
  check(`${id}: the frame count is the frames run`, r.json.machine.frame === here.shownMachine.frameCount, `${r.json.machine.frame} vs ${here.shownMachine.frameCount}`);
  const dec = decodePng(fs.readFileSync(png)), frame = here.shownMachine.render();
  const rgba = Buffer.from(Emu.frameToRGBA(frame).buffer);
  check(`${id}: the PNG decodes (CRCs right) to machine.render()'s pixels, ${frame.width}x${frame.height}`, dec.crcOk && dec.width === frame.width && dec.height === frame.height
    && dec.pixels.equals(rgba) && stepOf(r.json, 'screenshot').width === frame.width, `${dec.width}x${dec.height} crc ${dec.crcOk}`);
  const colours = new Set();
  for (let i = 0; i < dec.pixels.length; i += 4) colours.add(dec.pixels.readUInt32LE(i));
  check(`${id}: the picture is not blank (the welcome stripe's colours)`, colours.size >= 8, `${colours.size} colours`);
  if (id === 'coco') {
    const h = cli(['-m', id, '--program', 'welcome', '--frames', String(frames), '--screen']);
    check('human --screen: the same rows, one a line', h.code === 0 && h.out === want.lines.join('\n') + '\n', JSON.stringify(h.out));
    check('human --screen: the welcome menu', /TALK TO LIZA/.test(h.out), h.out);
  }
}
{
  // a graphics screen has no text: screen says so, expect-screen fails (exit 1)
  const r = cli(['--json', '-m', 'coco', '--program', 'demo', '--seconds', '1', '--type', 'x', '--seconds', '1', '--screen', '--expect-screen', 'DEMO']);
  const sc = stepOf(r.json, 'screen');
  check('a graphics mode: screen answers text:false with the mode and a reason', sc && sc.text === false && /has no character cells/.test(sc.reason), JSON.stringify(sc));
  check('expect-screen on a graphics mode: exit 1, kind condition', r.code === 1 && r.json.error.kind === 'condition' && /no text on the screen/.test(r.json.error.message), JSON.stringify(r.json.error));
}

// ---------------- typing and wait-for ----------------
{
  // LIZA on the stub firmware: the stub's key codes
  const args = ['-m', 'coco', '--program', 'liza', '--wait-for', 'text:/^> ?$/m', '--type', 'I need a holiday\\n', '--wait-for', 'text:WHY DO YOU NEED A HOLIDAY\\?'];
  const r = cli(['--json', ...args, '--screen']);
  const w = r.json.steps.filter((s) => s.step === 'wait-for');
  check('wait-for text: met, with the frames it took', r.code === 0 && w.length === 2 && w.every((s) => s.met === true && s.frames >= 0) && w[1].frames > 0, JSON.stringify(w));
  check('type: the keys were taken (frames counted) and LIZA answered', stepOf(r.json, 'type').frames > 0
    && stepOf(r.json, 'screen').lines.includes('> I NEED A HOLIDAY') && stepOf(r.json, 'screen').lines.includes('WHY DO YOU NEED A HOLIDAY?'), JSON.stringify(stepOf(r.json, 'screen')));
  // a wait for what never comes: exit 1 at the timeout, the screen in the error for context
  const t = cli(['--json', ...args.slice(0, 8), '--timeout', '0.5', '--wait-for', 'text:GOODBYE\\.']);
  check('wait-for timeout: exit 1, error.kind condition, names the condition, carries the screen', t.code === 1 && t.json.ok === false && t.json.error.kind === 'condition'
    && /wait-for text:GOODBYE\\\. timed out after 0\.5 s/.test(t.json.error.message) && t.json.error.screen.lines.includes('> I NEED A HOLIDAY'), JSON.stringify(t.json.error));
  const th = cli([...args.slice(0, 8), '--timeout', '0.05', '--wait-for', 'text:NEVER']);
  check('wait-for timeout, human: exit 1, message and the screen on stderr, nothing on stdout', th.code === 1 && th.out === '' && /timed out/.test(th.err) && /\|> I NEED A HOLIDAY/.test(th.err), th.err);
  // the keys are taken only while LIZA reads them: a program that reads no keys leaves them, which is exit 1
  const nk = cli(['-m', 'coco', '--program', 'demo', '--seconds', '1', '--type', 'x', '--seconds', '1', '--timeout', '1', '--type', 'abc']);
  check('type into a program that reads no keys: exit 1 at the timeout', nk.code === 1 && /did not take the typed keys within 1 s/.test(nk.err), nk.err);
  // special keys through the stub: {ENTER} is \n
  const e = cli(['--json', '-m', 'mc10', '--program', 'liza', '--wait-for', 'text:/^> ?$/m', '--type', 'I need a holiday{ENTER}', '--wait-for', 'text:HOLIDAY\\?', '--screen']);
  check('mc10 LIZA (6803, screen at $4000): {ENTER} ends the line', e.code === 0 && stepOf(e.json, 'screen').lines.includes('WHY DO YOU NEED A HOLIDAY?'), e.err + JSON.stringify(stepOf(e.json, 'screen')));
}
{
  // an assembled program: mem and pc conditions. DONE is at $3017 (counted by hand: CLR ext 3, LDX # 3, LEAX 2,
  // CMPX # 3, BNE 2, INC ext 3, LDA ext 3, CMPA # 2, BNE 2 bytes from $3000)
  fs.writeFileSync(tmp('count.asm'), [
    '        ORG $3000', 'START   CLR $3100', 'OUTER   LDX #0', 'INNER   LEAX 1,X', '        CMPX #2000', '        BNE INNER',
    '        INC $3100', '        LDA $3100', '        CMPA #5', '        BNE OUTER', 'DONE    BRA DONE', '        END START', ''].join('\n'));
  const r = cli(['--json', '-m', 'dragon32', '--asm', tmp('count.asm'), '--wait-for', 'mem:$3100=3', '--peek', '$3100', '--wait-for', 'pc:$3017', '--expect-mem', '$3100=5']);
  const w = r.json.steps.filter((s) => s.step === 'wait-for');
  check('wait-for mem: met when the byte holds the value', r.code === 0 && w[0].met && w[0].frames > 0 && stepOf(r.json, 'peek').bytes[0] === 3, r.err + JSON.stringify(r.json.steps));
  check('wait-for pc: the machine stops exactly at the address', w[1] && w[1].met && r.json.machine.pc === 0x3017 && w[1].condition === 'pc:$3017', JSON.stringify(r.json.machine));
  check('expect-mem: holds, exit 0', stepOf(r.json, 'expect-mem').met === true);
  const t = cli(['-m', 'dragon32', '--asm', tmp('count.asm'), '--timeout', '0.02', '--wait-for', 'pc:$3017']);
  check('wait-for pc timeout: exit 1, names the PC', t.code === 1 && /wait-for pc:\$3017 timed out after 0\.02 s \(the PC is \$30/.test(t.err), t.err);
  const m = cli(['-m', 'dragon32', '--asm', tmp('count.asm'), '--wait-for', 'pc:$3017', '--expect-mem', '$3100=$06']);
  check('expect-mem mismatch: exit 1, both values named', m.code === 1 && /\$3100 holds \$05, not \$06/.test(m.err), m.err);
  // the breakpoint is gone after the wait, and the run goes on exactly as a free run: the frames after it match
  const a = cli(['-m', 'dragon32', '--asm', tmp('count.asm'), '--wait-for', 'pc:$300B', '--frames', '20', '--info']);
  const b = cli(['-m', 'dragon32', '--asm', tmp('count.asm'), '--wait-for', 'pc:$300B', '--frames', '20', '--info']);
  check('wait-for pc stops on its first arrival, repeatably', a.code === 0 && a.out === b.out && /PC \$3017/.test(a.out), a.out + a.err);
  const p = cli(['--json', '-m', 'dragon32', '--asm', tmp('count.asm'), '--poke', '$3100=1,2,3', '--peek', '$3100:3', '--poke', '$C000=$12', '--peek', '$C000']);
  check('poke: lands in RAM, reported; ROM takes nothing', p.code === 0 && stepOf(p.json, 'poke').landed === 3 && stepOf(p.json, 'peek').bytes.join() === '1,2,3'
    && stepOf(p.json, 'poke', 1).landed === 0, JSON.stringify(p.json.steps));
}

// ---------------- the keyboard matrix with a ROM: the key-echo firmware as the Dragon 64's BASIC ROM ----------------
{
  // The ROM: copy key-echo to $3000 and jump there, after pointing the SAM's display at $0400 (F1 set: $FFC9) and
  // putting the VDG in its text mode (PIA1 port B bits 3-7 outputs, all low: A/G, GM0-2 and CSS 0).
  // Built with the bundled assembler, padded to the socket's 16K, the reset vector at $BFFE.
  const echo = keyechoBinary(Emu, 'dragon64');
  const d = Emu.formats.identify('keyecho.bin', echo), seg = d.segments[0];
  const fcb = Array.from(seg.data, (b) => `$${b.toString(16)}`);
  const lines = ['        ORG $8000', 'RESET   LDS #$7F00', '        STA $FFC9', '        CLR $FF23', '        LDA #$F8', '        STA $FF22', '        LDA #$04', '        STA $FF23', '        CLR $FF22', '        LDX #PAY', `        LDU #$${seg.addr.toString(16)}`,
    'COPY    LDA ,X+', '        STA ,U+', '        CMPX #PEND', '        BNE COPY', `        JMP $${d.exec.toString(16)}`, 'PAY'];
  for (let i = 0; i < fcb.length; i += 16) lines.push(`        FCB ${fcb.slice(i, i + 16).join(',')}`);
  lines.push('PEND', '');
  const res = Emu.assemble(lines.join('\n'), '6809');
  const rom = new Uint8Array(0x4000);
  rom.set(res.segments[0].data, 0);
  rom[0x3FFE] = 0x80; rom[0x3FFF] = 0x00;
  fs.mkdirSync(tmp('roms'));
  fs.writeFileSync(tmp('roms/d64_1.rom'), rom);
  fs.writeFileSync(tmp('roms/readme.txt'), 'not a ROM');
  const r = cli(['--json', '-m', 'dragon64', '--roms', tmp('roms'), '--frames', '10', '--type', 'AB{UP}C\\nD', '--frames', '5', '--screen', '--info']);
  const sc = stepOf(r.json, 'screen');
  check('--roms DIR: the machine runs that ROM (roms: true), the other file reported', r.code === 0 && r.json.machine.roms === true
    && r.json.roms.find((f) => f.name === 'd64_1.rom').machines.includes('dragon64') && r.json.roms.find((f) => f.name === 'readme.txt').machines.length === 0, r.err + JSON.stringify(r.json.roms));
  check('typing with a ROM goes through the keyboard matrix: AB{UP}C\\nD echoes AB^C, then D on the next line', sc && sc.lines[0] === 'AB^C' && sc.lines[1] === 'D', JSON.stringify(sc));
  const f = cli(['--json', '-m', 'dragon64', '--roms', tmp('roms/d64_1.rom'), '--frames', '10', '--type', '{BREAK}{CLEAR}x', '--screen']);
  check('--roms FILE: {BREAK} and {CLEAR} are pressed (they write nothing), then X', f.code === 0 && stepOf(f.json, 'screen').lines[0] === 'X', f.err + JSON.stringify(stepOf(f.json, 'screen')));
  const nr = cli(['--json', '-m', 'dragon64', '--roms', tmp('roms'), '--no-roms', '--program', 'liza', '--seconds', '1', '--expect-screen', 'LIZA']);
  check('--no-roms: the built-in firmware even with ROMs given', nr.code === 0 && nr.json.machine.roms === false, nr.err);
  const other = cli(['-m', 'coco', '--roms', tmp('roms'), '--frames', '1']);
  check('ROMs for another machine only: missing ROMs for this one, exit 3', other.code === 3 && /missing ROMs: the CoCo 1\/2 needs Color BASIC/.test(other.err), other.err);
}

// ---------------- snapshots ----------------
{
  const s1 = tmp('mid.cloadm-state'), s2 = tmp('mid2.cloadm-state');
  const head = ['-m', 'coco', '--program', 'liza', '--seconds', '1', '--type', 'I need a holiday\\n'];
  const tail = ['--type', 'my boss says I work too much\\n', '--frames', '30', '--screen', '--screenshot'];
  const whole = cli(['--json', ...head, '--save-snapshot', s1, ...tail, tmp('whole.png')]);
  const first = cli(['--json', ...head, '--save-snapshot', s2]);
  const rest = cli(['--json', '--load-snapshot', s2, ...tail, tmp('rest.png')]);
  check('save-snapshot writes the file; the same run writes the same bytes (SOURCE_DATE_EPOCH)', whole.code === 0 && first.code === 0
    && fs.readFileSync(s1).equals(fs.readFileSync(s2)) && stepOf(first.json, 'save-snapshot').size === fs.statSync(s2).size, whole.err + first.err);
  check('load-snapshot switches to the snapshot\'s machine', rest.code === 0 && rest.json.machine.machine === 'coco' && /Snapshot opened: CoCo 1\/2, without ROMs/.test(stepOf(rest.json, 'load-snapshot').message), rest.err + JSON.stringify(rest.json.steps[0]));
  check('restored: the screen goes on exactly as the uninterrupted run', JSON.stringify(stepOf(rest.json, 'screen')) === JSON.stringify(stepOf(whole.json, 'screen'))
    && stepOf(whole.json, 'screen').lines.includes('WHY DO YOU SAY YOUR BOSS SAYS'), JSON.stringify(stepOf(rest.json, 'screen')));
  check('restored: the same frame count and PC, and the same PNG bytes', rest.json.machine.frame === whole.json.machine.frame && rest.json.machine.pc === whole.json.machine.pc
    && fs.readFileSync(tmp('rest.png')).equals(fs.readFileSync(tmp('whole.png'))), `${rest.json.machine.frame} ${whole.json.machine.frame}`);
  const s = new Emu.Session({ welcomeMenu: false });
  s.switchMachine('dragon64', {}, { menu: false });
  (async () => {
    const opened = await s.readSnapshot(new Uint8Array(fs.readFileSync(s1)));
    check('the snapshot file is one the page opens: format, machine, no ROMs', opened.machine === 'coco' && Object.keys(opened.roms).length === 0 && opened.taken === new Date(1700000000 * 1000).toISOString(), JSON.stringify({ m: opened.machine, t: opened.taken }));
    finishAsync();
  })().catch((e) => { check('the snapshot file is one the page opens', false, e.stack); finishAsync(); });
}

// ---------------- determinism ----------------
{
  const args = ['--json', '-m', 'coco3', '--program', 'liza', '--seconds', '2', '--type', 'hello\\n', '--seconds', '1', '--screenshot'];
  const a = cli([...args, tmp('d1.png')]), b = cli([...args, tmp('d2.png')]);
  check('the same inputs give the same frames: identical PNG bytes and JSON', a.code === 0 && fs.readFileSync(tmp('d1.png')).equals(fs.readFileSync(tmp('d2.png')))
    && a.out.replace(/d1\.png/g, '') === b.out.replace(/d2\.png/g, ''), a.err);
}

// ---------------- script mode ----------------
{
  fs.writeFileSync(tmp('liza.cloadm'), [
    '# LIZA on the CoCo, as a CI test',
    'machine coco',
    'option ram=32',
    'program liza',
    'wait-for text:/^> ?$/m',
    'type "I need a holiday\\n"',
    'wait-for text:WHY DO YOU NEED',
    '',
    'expect-screen HOLIDAY',
    'peek $0400:4',
    'screenshot ' + tmp('script.png'),
    'screen',
  ].join('\n'));
  const r = cli(['--json', '--script', tmp('liza.cloadm')]);
  const f = cli(['--json', '-m', 'coco', '-o', 'ram=32', '--program', 'liza', '--wait-for', 'text:/^> ?$/m', '--type', 'I need a holiday\\n', '--wait-for', 'text:WHY DO YOU NEED',
    '--expect-screen', 'HOLIDAY', '--peek', '$0400:4', '--screenshot', tmp('flags.png'), '--screen']);
  const strip = (j) => JSON.stringify(j).replace(/(script|flags)\.png/g, '').replace(/"where":"[^"]*",?/g, '');
  check('a script runs the same steps as the same flags: same JSON, same picture', r.code === 0 && strip(r.json) === strip(f.json)
    && fs.readFileSync(tmp('script.png')).equals(fs.readFileSync(tmp('flags.png'))), r.err + strip(r.json).slice(0, 300));
  fs.writeFileSync(tmp('bad.cloadm'), 'machine coco\n\n# fine so far\nwait-for screen:OK\n');
  const b = cli(['--script', tmp('bad.cloadm')]);
  check('a script error names the file and line, exit 2', b.code === 2 && b.err.includes('bad.cloadm:4: ') && /a wait-for condition is/.test(b.err), b.err);
  fs.writeFileSync(tmp('fail.cloadm'), 'machine coco\nprogram liza\nseconds 1\nexpect-screen GOODBYE\n');
  const c = cli(['--script', tmp('fail.cloadm')]);
  check('a failing expect in a script: exit 1, names the line', c.code === 1 && c.err.includes('fail.cloadm:4: the screen does not match /GOODBYE/'), c.err);
  fs.writeFileSync(tmp('nest.cloadm'), 'script other.cloadm\n');
  const d = cli(['--script', tmp('nest.cloadm')]);
  check('a script cannot include a script', d.code === 2 && /cannot include another script/.test(d.err), d.err);
}

// ---------------- docs/automation.md: its examples run ----------------
// Blocks that start with `// example: NAME` (Node, ES modules) or `# example: NAME` (a cloadm script) are run here,
// from the repository root as the guide says. A Node example checks its own results and throws when one is wrong.
{
  const doc = fs.readFileSync(path.join(ROOT, 'docs/automation.md'), 'utf8');
  const blocks = [...doc.matchAll(/```(\w+)\n((?:\/\/|#) example: ([\w-]+)\n[\s\S]*?)```/g)].map((m) => ({ lang: m[1], code: m[2], name: m[3] }));
  check('the guide has a Node example and a script example', blocks.some((b) => b.lang === 'js') && blocks.some((b) => b.lang === 'text'), blocks.map((b) => b.name).join());
  for (const b of blocks) {
    if (b.lang === 'js') {
      const r = spawnSync(process.execPath, ['--input-type=module', '-'], { cwd: ROOT, input: b.code, encoding: 'utf8', env: ENV });
      check(`docs example ${b.name} runs and its checks pass`, r.status === 0 && /^example passed$/m.test(r.stdout), r.stderr + r.stdout);
    } else {
      const file = tmp(`${b.name}.cloadm`);
      fs.writeFileSync(file, b.code);
      const r = cli(['--script', file], { cwd: TMP });
      check(`docs script example ${b.name} exits 0`, r.code === 0, r.err + r.out);
    }
  }
  // the command lines in the guide's shell blocks that start with `node cli/cloadm.js` and need no files: they run
  const lines = [...doc.matchAll(/```sh\n([\s\S]*?)```/g)].flatMap((m) => m[1].replace(/\\\n\s*/g, ' ').split('\n')).filter((l) => /^node cli\/cloadm\.js /.test(l) && !/--roms|--disk|--load |--cart|--tape|\.png|--script|--assemble|state/.test(l));
  check('the guide has runnable command lines', lines.length >= 2, lines.join(' | '));
  for (const l of lines) {
    const args = [...l.slice('node cli/cloadm.js '.length).matchAll(/'([^']*)'|(\S+)/g)].map((m) => (m[1] != null ? m[1] : m[2]));
    const r = cli(args);
    check(`docs command line runs: ${l.slice(0, 90)}`, r.code === 0, r.err);
  }
}

let pending = 1;
function finishAsync() {
  if (--pending) return;
  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(fail ? `${fail} FAILED` : `${n}/${n} CLI checks passed`);
  process.exitCode = fail ? 1 : 0;
}
