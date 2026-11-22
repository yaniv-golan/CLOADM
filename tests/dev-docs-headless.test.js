// The headless developer's docs (docs/automation.md) and the example they stand on, run so they cannot rot:
//  * the per-model table of storage and serial paths is rebuilt from js/machines/profiles.js and the machines themselves
//    (options, tape deck, disk controllers, 6551, bit-banger, Becker port) and must match the document, cell for cell, for
//    every model once;
//  * docs/examples/headless-frame.mjs runs from a temporary directory outside the repository (it finds the repository from its
//    own path), and from a copy of itself with CLOADM_DIR, and draws the same picture each time; mutants of its guest program
//    (a frame counter that never counts, a key that is never read) make it fail;
//  * the command lines and the two Node blocks of "A graphics program has no text to wait on" and the serial-peer note give the
//    numbers the text quotes (tests/cli.test.js runs the blocks too);
//  * the option error the document quotes is the one the command line gives, and the guide's links resolve.
// Only the project's own firmware and programs. Run: node tests/dev-docs-headless.test.js
'use strict';
const fs = require('fs'), os = require('os'), path = require('path'), zlib = require('zlib');
const { spawnSync } = require('child_process');
const { pathToFileURL } = require('url');

const ROOT = path.join(__dirname, '..');
let fail = 0, n = 0;
const check = (name, cond, detail = '') => { n++; if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name}`); };
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cloadm-devdocs-'));
const node = (args, opts = {}) => spawnSync(process.execPath, args, Object.assign({ encoding: 'utf8', cwd: TMP }, opts));
const cli = (args, opts = {}) => node([path.join(ROOT, 'cli/cloadm.js'), ...args], opts);

(async () => {
  const Emu = await import(pathToFileURL(path.join(ROOT, 'js/emu.js')).href);
  const doc = read('docs/automation.md');

  // ---------------- the capability table ----------------
  const heading = '### Which storage and serial paths each model has';
  const at = doc.indexOf(heading);
  check('the guide has the per-model table of storage and serial paths', at > 0);
  const after = doc.slice(at).split('\n'), first = after.findIndex((l) => /^\| /.test(l));
  const table = [];
  for (let i = first + 2; i < after.length && /^\| /.test(after[i]); i++) table.push(after[i]);     // (header and rule dropped)
  const cells = (row) => row.split('|').slice(1, -1).map((c) => c.trim().replace(/\s*\[\^\w+\]/g, ''));
  const ids = (cell) => [...cell.matchAll(/`([a-z0-9]+)`/g)].map((m) => m[1]);
  const code = (cell) => [...cell.matchAll(/`([A-Za-z]+)`/g)].map((m) => m[1]);
  // what the code says about one model
  const facts = (id) => {
    const s = new Emu.Session({ welcomeMenu: false });
    s.switchMachine(id, {}, { menu: false });
    const m = s.machine, p = Emu.profiles[id], disk = s.diskDosChoices().map((c) => c.id);
    return {
      options: Object.keys(p.options),
      tape: m.deck ? 'cassette' : 'none',
      disk: !m.hasCartridgePort ? 'none (no cartridge port)' : disk.join() === 'dragondos,deltados' ? 'DragonDOS or Delta DOS' : disk.join() === 'rsdos' ? 'Disk BASIC (RS-DOS)'
        : disk.join() === 'builtin' ? 'its own, built in (2 drives)' : `?${disk.join()}`,
      acia: m.acia ? (p.rs232 ? 'yes, with its port' : 'chip only, no port') : 'no',
      bitBanger: m.bitBanger ? 'yes' : 'no',
      becker: 'becker' in p.options ? 'yes' : 'no',
    };
  };
  const seen = [];
  for (const row of table) {
    const c = cells(row), group = ids(c[0]);
    for (const id of group) {
      seen.push(id);
      const f = facts(id);
      const got = { options: code(c[1]), tape: c[2], disk: c[3], acia: c[4], bitBanger: c[5], becker: c[6] };
      check(`the table row for ${id} is what the machine has`, JSON.stringify(got) === JSON.stringify(f), `${JSON.stringify(got)} vs ${JSON.stringify(f)}`);
    }
  }
  const all = Object.keys(Emu.profiles);
  check('every model is in the table exactly once', seen.length === all.length && all.every((id) => seen.filter((x) => x === id).length === 1), all.filter((id) => !seen.includes(id)).join());
  check('the Dragon 64 row says what the page and the command line say: no becker, with ssc', facts('dragon64').options.join() === 'cpu,ram,hires,ssc' && facts('coco').options.includes('becker'));

  // the option error the guide quotes is the command line's, and the generic examples in the options row are valid
  const bad = cli(['--machine', 'dragon64', '-o', 'becker=true', '--info']);
  check('"-o becker=true" on the Dragon 64 is bad-option, exit 2, with the message the guide quotes', bad.status === 2 && /the Dragon 64 has no option "becker" \(it has cpu, ram, hires, ssc\)/.test(bad.stderr)
    && doc.includes('the Dragon 64 has no option "becker" (it has cpu, ram, hires, ssc)'), bad.stderr);
  const good = [['coco', 'ram=16'], ['dragon64', 'cpu=6309'], ['coco', 'hires=max3-right'], ['coco', 'becker=true']].map(([m, o]) => cli(['--machine', m, '-o', o, '--info']));
  check('the guide\'s example options are valid on the models they name', good.every((r) => r.status === 0), good.map((r) => r.stderr).join());

  // ---------------- the example outside the repository ----------------
  const exampleDir = path.join(ROOT, 'docs/examples');
  const example = path.join(exampleDir, 'headless-frame.mjs');
  const src = fs.readFileSync(example, 'utf8');
  check('the example imports only js/emu.js and cli/cloadm.js (no test helper, no require)', !/tests\//.test(src.replace(/\/\/.*$/gm, '')) && !/\brequire\(/.test(src) && /js\/emu\.js/.test(src) && /cli\/cloadm\.js/.test(src));
  const runExample = (file, out, env = {}) => node([file, out], { env: Object.assign({}, process.env, env) });
  const parse = (r) => { try { return JSON.parse(r.stdout.trim().split('\n').pop()); } catch (e) { return null; } };
  const out1 = path.join(TMP, 'one.png'), r1 = runExample(example, out1);
  const j1 = parse(r1);
  check('the example runs from a directory outside the repository and checks its own results', r1.status === 0 && !!j1 && path.relative(ROOT, TMP).startsWith('..'), r1.stderr + r1.stdout);
  check('it reports the frame, the picture, the elapsed frames and cycles, the counter and the tick that saw the key',
    !!j1 && j1.frame.join('x') === '320x240' && j1.picture.width === 256 && j1.litOnRow96 === 16 && j1.frames === 8 && j1.counter === 6 && j1.keySeenAtTick === 5 && j1.cycles > 8 * 17000 && j1.cycles < 8 * 18500, JSON.stringify(j1));
  const png1 = fs.readFileSync(out1);
  check('the PNG file is a 320x240 RGBA image', png1.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && png1.readUInt32BE(16) === 320 && png1.readUInt32BE(20) === 240 && png1[25] === 6);
  // the picture itself: the one-line mark the held key drew on row 96, found in the decoded PNG
  {
    const idat = []; let o = 8;
    while (o < png1.length) { const len = png1.readUInt32BE(o), type = png1.toString('latin1', o + 4, o + 8); if (type === 'IDAT') idat.push(png1.subarray(o + 8, o + 8 + len)); o += 12 + len; }
    const raw = zlib.inflateSync(Buffer.concat(idat)), stride = 1 + 320 * 4;
    const px = (x, y) => raw.readUInt32LE(y * stride + 1 + x * 4);              // (filter type 0 on every row)
    const bg = px(40, 24 + 10), litAt = (y) => { let c = 0; for (let x = 32; x < 288; x++) if (px(x, y) !== bg) c++; return c; };
    check('the PNG holds the line the key drew: 16 pixels on picture row 96 and none beside it', raw.length === 240 * stride && litAt(24 + 96) === 16 && litAt(24 + 95) === 0 && litAt(24 + 97) === 0, `${litAt(24 + 96)} ${litAt(24 + 95)}`);
  }
  const out2 = path.join(TMP, 'two.png'), r2 = runExample(example, out2);
  check('a second run draws the same picture and reports the same numbers (emulated time only)', r2.status === 0 && fs.readFileSync(out2).equals(png1) && r2.stdout.replace(out2, 'X') === r1.stdout.replace(out1, 'X'), r2.stderr);
  // the JSON line the guide quotes is what the example prints (the PNG path aside)
  {
    const quoted = [...doc.matchAll(/```json\n(\{"png":[^\n]*\})\n```/g)].map((m) => JSON.parse(m[1]));
    const actual = j1 && Object.assign({}, j1, { png: 'out.png' });
    check('the guide\'s quoted output of headless-frame.mjs is exactly what it prints (every field)', quoted.length === 1 && !!actual && JSON.stringify(quoted[0]) === JSON.stringify(actual), `${JSON.stringify(quoted[0])} vs ${JSON.stringify(actual)}`);
  }
  // from a copy elsewhere, with CLOADM_DIR (the example's own comment says so)
  const copy = path.join(TMP, 'copy');
  fs.mkdirSync(copy);
  fs.copyFileSync(example, path.join(copy, 'headless-frame.mjs'));      // (the .mjs alone: the guest source is read from CLOADM_DIR)
  const out3 = path.join(TMP, 'three.png'), r3 = runExample(path.join(copy, 'headless-frame.mjs'), out3, { CLOADM_DIR: ROOT });
  check('a copy of the .mjs alone, outside the repository, runs with CLOADM_DIR and draws the same picture', r3.status === 0 && fs.readFileSync(out3).equals(png1), r3.stderr);
  // mutants of the guest: the example must fail on each
  const mutant = (name, edit) => {
    const root = path.join(TMP, name), dir = path.join(root, 'docs/examples');
    fs.mkdirSync(dir, { recursive: true });
    fs.symlinkSync(path.join(ROOT, 'js'), path.join(root, 'js'), 'dir');
    fs.symlinkSync(path.join(ROOT, 'cli'), path.join(root, 'cli'), 'dir');
    const asm = fs.readFileSync(path.join(exampleDir, 'framecount.asm'), 'utf8'), mutated = edit(asm);
    if (mutated === asm) throw new Error(`mutant ${name} changed nothing`);
    fs.writeFileSync(path.join(dir, 'framecount.asm'), mutated);
    fs.copyFileSync(example, path.join(dir, 'headless-frame.mjs'));
    return runExample(path.join(dir, 'headless-frame.mjs'), path.join(TMP, `${name}.png`));
  };
  const noCount = mutant('nocount', (a) => a.replace('        INC     FRAME           ; one tick', '        NOP'));
  check('a guest whose counter never counts makes the example fail (it never reaches 3)', noCount.status !== 0 && /never reached 3/.test(noCount.stderr), noCount.stderr.split('\n')[0]);
  const noKey = mutant('nokey', (a) => a.replace('        BEQ     NOKEY', '        BRA     NOKEY'));
  check('a guest that never reads SPACE makes the example fail (the key is never seen)', noKey.status !== 0 && /never saw SPACE/.test(noKey.stderr), noKey.stderr.split('\n')[0]);
  const noDraw = mutant('nodraw', (a) => a.replace('        COM     A,X             ; invert that byte (8 pixels)', '        NOP'));
  check('a guest that sees the key but draws nothing makes the example fail (row 96 stays empty)', noDraw.status !== 0 && /row 96/.test(noDraw.stderr), noDraw.stderr.split('\n')[0]);

  // ---------------- the recipe: the command lines and what they print ----------------
  check('the guide has the Node blocks of the recipe and the serial peer (tests/cli.test.js runs them from the repository root)', /```js\n\/\/ example: frame-counter\n/.test(doc) && /```js\n\/\/ example: serial-peer\n/.test(doc));
  const recipe = [...doc.matchAll(/```sh\n([\s\S]*?)```/g)].flatMap((m) => m[1].split('\n')).filter((l) => /--asm docs\/examples\/framecount\.asm/.test(l));
  check('the guide has the two command lines of the recipe', recipe.length === 2, recipe.join(' | '));
  const argv = (line) => [...line.slice('node cli/cloadm.js '.length).matchAll(/'([^']*)'|(\S+)/g)].map((m) => (m[1] != null ? m[1] : m[2]));
  const run1 = cli(argv(recipe[0]), { cwd: ROOT }), steps = run1.status === 0 ? JSON.parse(run1.stdout).steps.slice(1) : [];
  const want = [['wait-for', 'frames', 5], ['hold', 'frames', 2], ['wait-for', 'frames', 2], ['expect-mem', 'met', true], ['step', 'cycles', 800]];
  check('the first command line gives the steps the guide prints (5, 2 and 2 frames; the key seen at tick 5; 800 cycles for 200 instructions)',
    run1.status === 0 && want.every(([step, field, value], i) => steps[i] && steps[i].step === step && steps[i][field] === value), run1.stderr + JSON.stringify(steps).slice(0, 300));
  check('the guide\'s JSON lines are those steps', want.every(([step], i) => doc.includes(`"step": "${step}"`)) && doc.includes('"frames": 5, "met": true') && doc.includes('"cycles": 800'));
  const keyPng = path.join(TMP, 'key.png');
  const run2 = cli(argv(recipe[1]).map((a) => (a === 'key.png' ? keyPng : a)), { cwd: ROOT });   // (from the repository root, as the guide says; the picture goes to TMP)
  check('the second command line writes the picture (a 320x240 PNG)', run2.status === 0 && fs.existsSync(keyPng) && fs.readFileSync(keyPng).readUInt32BE(16) === 320, run2.stderr);
  // the field rate is the video standard's: every model's CPU cycles and fields a second, against what the text says
  {
    const PAL = Object.keys(Emu.profiles).filter((id) => Emu.profiles[id].video === 'pal');   // (the text's lists are checked against the profiles below)
    const bad = [];
    for (const id of Object.keys(Emu.profiles)) {
      const s = new Emu.Session({ welcomeMenu: false });
      s.switchMachine(id, {}, { menu: false });
      const m = s.machine;
      s.runFrames(5);
      const c0 = m.cpu.totalCycles; s.runFrames(20);
      const cycles = Math.round((m.cpu.totalCycles - c0) / 20), fps = +m.fps.toFixed(2), pal = Emu.profiles[id].video === 'pal';
      if (pal !== PAL.includes(id)) bad.push(`${id}: video ${Emu.profiles[id].video}`);
      if (pal ? !(cycles === 17784 && (fps === 49.97 || fps === 50.04)) : !(cycles === 14934 && fps === 59.92)) bad.push(`${id}: ${cycles} cycles, ${fps} Hz`);
      if (id === 'dragon64' && Math.round(m.tickHz) !== 888625) bad.push('dragon64 clock');
      if (id === 'coco' && Math.round(m.tickHz) !== 894886) bad.push('coco clock');
      if (id === 'coco3p' && (fps !== 50.04 || Math.round(m.tickHz / 4) !== 889844)) bad.push('coco3p clock');
    }
    check('every model runs the cycles and fields a second its video standard gives (PAL 17,784; NTSC 14,934), the Tano Dragon 64 NTSC and the CoCo 3 (PAL) PAL', !bad.length, bad.join('; '));
    const para = doc.slice(doc.indexOf('**A video field is the frame.**'), doc.indexOf('**What "cycles" counts.**'));
    // the two lists of model ids in the text are exactly the models whose profiles say PAL and NTSC
    const ids = (m) => (m ? [...m[1].matchAll(/`([a-z0-9]+)`/g)].map((x) => x[1]).sort() : null);
    const palText = ids(/\*\*PAL\*\* machines \(([\s\S]*?)\) run 17,784/.exec(para)), ntscText = ids(/\*\*NTSC\*\* machines \(([\s\S]*?)\) run\s+14,934/.exec(para));
    const byVideo = (v) => Object.keys(Emu.profiles).filter((id) => Emu.profiles[id].video === v).sort();
    check('the PAL and NTSC lists in the text are exactly the models whose profiles have video pal and ntsc, each model once',
      !!palText && !!ntscText && JSON.stringify(palText) === JSON.stringify(byVideo('pal')) && JSON.stringify(ntscText) === JSON.stringify(byVideo('ntsc'))
      && palText.length + ntscText.length === Object.keys(Emu.profiles).length, `${palText} | ${ntscText}`);
    check('the text says so by video standard and names the exceptions with their numbers', /\*\*PAL\*\* machines/.test(para) && /\*\*NTSC\*\* machines/.test(para) && /`coco3p`/.test(para) && /`tanodr64`, the Tano Dragon 64, which is NTSC/.test(para)
      && /17,784 CPU cycles a frame, 49\.97 fields a second on the\s+Dragons\s+\(888,625 Hz\) and 50\.04 on the CoCo 3 \(PAL\) \(889,844 Hz\)/.test(para) && /14,934 cycles a frame, 59\.92 a second \(894,886 Hz\)/.test(para)
      && !/50 times a second on the Dragons/.test(para));
    // the CoCo 3 counts machine ticks in four times the CPU cycle, as the text says (machine.now() vs machine.cpu.totalCycles)
    const s3 = new Emu.Session({ welcomeMenu: false });
    s3.switchMachine('coco3', {}, { menu: false });
    s3.runFrames(5);
    const n0 = s3.machine.now(), c0 = s3.machine.cpu.totalCycles; s3.runFrames(20);
    check('on the CoCo 3 machine.now() runs 59,736 ticks a frame while the CPU runs 14,934 cycles (the text\'s "what cycles counts")', (s3.machine.now() - n0) / 20 === 59736 && (s3.machine.cpu.totalCycles - c0) / 20 === 14934 && /59,736 a frame NTSC, 71,136 PAL/.test(doc));
  }

  // ---------------- the serial peer note ----------------
  // the Dragon 64's 6551 port takes the same calls and keeps its terminal in a snapshot, as the note says
  {
    const s = new Emu.Session({ welcomeMenu: false });
    s.switchMachine('dragon64', {}, { menu: false });
    s.serial.attach('terminal', { baud: 1200 });
    const arrived = [];
    s.serial.subscribe({ rx: (b) => arrived.push(...b) });
    s.serial.send('OKAY', { text: true });
    s.runFrames(1);
    s.serial.flush();
    const port = s.machine.serialPort;
    check('the Dragon 64\'s 6551 takes the same calls: after a frame at 1200 baud part of what was sent has crossed, the rest is queued',
      s.serial.device.chip === '6551' && arrived.length > 0 && arrived.length < 4 && port.queue.length === 4 - arrived.length, `${arrived.length} across, ${port.queue.length} queued`);
    const t = new Emu.Session({ welcomeMenu: false });
    t.openSnapshot(await t.readSnapshot((await s.snapshotFile()).bytes));
    check('a snapshot of the Dragon 64 keeps the terminal, its baud and the bytes on their way; a new Session has no subscriber',
      t.serial.device.kind === 'terminal' && t.serial.device.baud === 1200 && t.machine.serialPort.queue.length === port.queue.length && t.serial.subs.length === 0, `${t.machine.serialPort.queue.length} vs ${port.queue.length}`);
  }
  check('the serial note names the tests it rests on, and they exist', /The serial terminal: a byte on its way to the machine is part of the/.test(read('tests/state.test.js')) && /The Dragon 64's 6551 ACIA with a loopback plug/.test(read('tests/state.test.js')));

  // ---------------- links ----------------
  const anchor = '#which-storage-and-serial-paths-each-model-has';
  check('the options row, the machine notes and the game guide link to the table, and the table\'s anchor is its heading',
    doc.includes(`(${anchor})`) && read('docs/machines.md').includes(`automation.md${anchor}`) && read('docs/game-development.md').includes(`automation.md${anchor}`) && doc.includes(heading));
  const recipeA = '#a-graphics-program-has-no-text-to-wait-on', exampleA = '#a-complete-example-that-runs-from-outside-the-repository';
  const gd = read('docs/game-development.md'), mc = read('docs/machines.md');
  check('the recipe and the complete example are linked from the game guide\'s "Wait, don\'t sleep" bullet and its Dragon 64 sentence, and from the Dragon 64 row of the machine notes; their anchors are their headings',
    gd.split(`automation.md${recipeA}`).length === 3 && gd.split(`automation.md${exampleA}`).length === 3 && mc.includes(`automation.md${recipeA}`) && mc.includes(`automation.md${exampleA}`)
    && /Wait, don't sleep:\*\*[^\n]*\n[^\n]*\n[^\n]*\[wait on a frame counter in RAM\]/.test(gd) && /Dragon 64 adds a 6551[^\n]*driving a graphics program/.test(gd)
    && doc.includes('### A graphics program has no text to wait on') && doc.includes('### A complete example that runs from outside the repository'));
  check('the table links to the serial port\'s section, and its anchor is its heading; the peer note follows it', doc.includes('(#the-serial-port-from-node)') && doc.includes('### The serial port from Node') && doc.indexOf('### A snapshot with a serial peer outside the machine') > doc.indexOf('### The serial port from Node'));

  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(fail ? `${fail} FAILED` : `${n}/${n} headless-docs checks passed`);
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.error('test crashed:', e); process.exitCode = 1; });
