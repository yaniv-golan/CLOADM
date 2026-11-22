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
  // from a copy elsewhere, with CLOADM_DIR (the example's own comment says so)
  const copy = path.join(TMP, 'copy');
  fs.mkdirSync(copy);
  fs.copyFileSync(example, path.join(copy, 'headless-frame.mjs'));
  fs.copyFileSync(path.join(exampleDir, 'framecount.asm'), path.join(copy, 'framecount.asm'));
  const out3 = path.join(TMP, 'three.png'), r3 = runExample(path.join(copy, 'headless-frame.mjs'), out3, { CLOADM_DIR: ROOT });
  check('a copy of the example outside the repository runs with CLOADM_DIR and draws the same picture', r3.status === 0 && fs.readFileSync(out3).equals(png1), r3.stderr);
  // mutants of the guest: the example must fail on each
  const mutant = (name, edit) => {
    const dir = path.join(TMP, name);
    fs.mkdirSync(dir);
    fs.copyFileSync(example, path.join(dir, 'headless-frame.mjs'));
    const asm = fs.readFileSync(path.join(exampleDir, 'framecount.asm'), 'utf8'), mutated = edit(asm);
    if (mutated === asm) throw new Error(`mutant ${name} changed nothing`);
    fs.writeFileSync(path.join(dir, 'framecount.asm'), mutated);
    return runExample(path.join(dir, 'headless-frame.mjs'), path.join(TMP, `${name}.png`), { CLOADM_DIR: ROOT });
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
  // the cycles the text quotes for a frame
  {
    const per = {};
    for (const id of ['dragon64', 'coco']) {
      const s = new Emu.Session({ welcomeMenu: false });
      s.switchMachine(id, {}, { menu: false });
      s.runFrames(10);
      const c0 = s.machine.now(); s.runFrames(50);
      per[id] = [(s.machine.now() - c0) / 50, s.machine.tickHz, +(s.machine.fps).toFixed(2)];
    }
    check('"17,784 CPU cycles a frame at 888,625 Hz, 49.97 fields a second" (Dragon 64) and "14,934 at 894,886 Hz, 59.92" (CoCo) are what the machines do',
      per.dragon64[0] === 17784 && per.dragon64[1] === 888625 && per.dragon64[2] === 49.97 && per.coco[0] === 14934 && Math.round(per.coco[1]) === 894886 && per.coco[2] === 59.92
      && doc.includes('17,784 CPU cycles a frame at 888,625 Hz, 49.97 fields a second') && doc.includes('14,934 cycles at 894,886 Hz, 59.92 a second'), JSON.stringify(per));
  }

  // ---------------- the serial peer note ----------------
  // the Dragon 64's 6551 port takes the same calls and keeps its terminal in a snapshot, as the note says
  {
    const s = new Emu.Session({ welcomeMenu: false });
    s.switchMachine('dragon64', {}, { menu: false });
    s.attachSerial('terminal', { baud: 1200 });
    s.serialSend('OK');
    s.runFrames(1);
    const port = s.machine.serialPort;
    check('the Dragon 64\'s serialPort (the 6551\'s) is the object the note describes: send, onReceive, flush, a queue', typeof port.send === 'function' && typeof port.flush === 'function' && 'onReceive' in port && port === s.machine.acia.port && port.queue.length > 0);
    const t = new Emu.Session({ welcomeMenu: false });
    t.openSnapshot(await t.readSnapshot((await s.snapshotFile()).bytes));
    check('a snapshot of the Dragon 64 keeps the terminal, its baud and the bytes on their way; the Session re-plugs only its own log',
      t.machine.serialPort.kind === 'terminal' && t.machine.serialPort.baud === 1200 && t.machine.serialPort.queue.length === port.queue.length && t.terminalBytes.length === 0, `${t.machine.serialPort.queue.length} vs ${port.queue.length}`);
  }
  check('the serial note names the tests it rests on, and they exist', /The serial terminal: a byte on its way to the machine is part of the/.test(read('tests/state.test.js')) && /The Dragon 64's 6551 ACIA with a loopback plug/.test(read('tests/state.test.js')));

  // ---------------- links ----------------
  const anchor = '#which-storage-and-serial-paths-each-model-has';
  check('the options row, the machine notes and the game guide link to the table, and the table\'s anchor is its heading',
    doc.includes(`(${anchor})`) && read('docs/machines.md').includes(`automation.md${anchor}`) && read('docs/game-development.md').includes(`automation.md${anchor}`) && doc.includes(heading));
  check('the table links to the serial note, and the note\'s anchor is its heading', doc.includes('(#a-snapshot-with-a-serial-peer-outside-the-machine)') && doc.includes('### A snapshot with a serial peer outside the machine'));

  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(fail ? `${fail} FAILED` : `${n}/${n} headless-docs checks passed`);
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.error('test crashed:', e); process.exitCode = 1; });
