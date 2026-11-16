// tools/mame-diff/lib/mame.js runMame: a MAME that fails (a missing ROM set exits 2, a bad slot option 3, no MAME
// at all) must stop the comparison, not let it go on to compare whatever an earlier run left behind.
// MAME itself is stood in for by small scripts (the MAME environment variable), so this runs without it.
const fs = require('fs'), os = require('os'), path = require('path'), cp = require('child_process');

let fail = 0;
const check = (name, cond, detail = '') => { if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name}`); };
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cloadm-mame-lib-'));
const script = (name, body) => { const f = path.join(dir, name); fs.writeFileSync(f, `#!/bin/sh\n${body}\n`); fs.chmodSync(f, 0o755); return f; };
// runMame in a child process with MAME set, so the module reads it at load
const run = (mame) => cp.spawnSync(process.execPath, ['-e', `
  const { runMame } = require(${JSON.stringify(path.join(__dirname, '../tools/mame-diff/lib/mame.js'))});
  try { runMame({ work: ${JSON.stringify(path.join(dir, 'work'))}, system: 'coco', lua: '', seconds: 1 }); console.log('RETURNED'); }
  catch (e) { console.log('THREW ' + e.message); }
`], { env: Object.assign({}, process.env, { MAME: mame }), encoding: 'utf8' }).stdout.trim();

check('MAME exiting 0: runMame returns', run(script('ok.sh', 'exit 0')) === 'RETURNED');
let out = run(script('bad.sh', 'exit 3'));
check('MAME exiting 3 (a bad slot option): runMame throws, naming the exit status', /^THREW .*exit status 3/.test(out), out);
out = run(script('roms.sh', 'exit 2'));
check('MAME exiting 2 (missing ROMs): runMame throws', /^THREW .*exit status 2/.test(out), out);
out = run(path.join(dir, 'no-such-mame'));
check('no MAME at all: runMame throws', /^THREW /.test(out), out);
out = run(script('killed.sh', 'kill -KILL $$'));
check('MAME stopped by a signal (the timeout): reported, not thrown', out === 'RETURNED', out);

fs.rmSync(dir, { recursive: true, force: true });
console.log(fail ? `${fail} FAILED` : 'all passed');
process.exitCode = fail ? 1 : 0;
