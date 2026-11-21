// The ROM store behind add_roms (cli/rom-store.js), without the MCP server: what index.json keeps as "from", and
// several processes adding at once. Stand-in bytes only.
//  * a URL carrying ?token=... and #frag is kept as origin + path, nothing else (a media path is kept as it is);
//  * two child processes, each adding its own ROMs many times: no entry is lost, the index stays valid JSON, no
//    lock or temporary file is left; a lock left by a dead process is broken after the stale timeout.
// Run: node tests/rom-store.test.js
const fs = require('fs'), os = require('os'), path = require('path');
const { spawn } = require('child_process');
const { romStore } = require('../cli/rom-store.js');

if (process.argv[2] === 'worker') {
  const [, , , dir, tag, count] = process.argv, store = romStore(dir);
  for (let i = 0; i < +count; i++) store.add([{ name: `${tag}${i}.rom`, bytes: Uint8Array.from([tag.charCodeAt(0), i & 255, i >> 8, 7]) }], { source: 'data', from: 'stand-in' });
} else (async () => {
  let fail = 0, n = 0;
  const check = (name, cond, detail = '') => { n++; if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name}`); };
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cloadm-store-'));
  const bytes = (...b) => Uint8Array.from(b);

  // ---- the URL ----
  {
    const dir = path.join(TMP, 'url'), store = romStore(dir);
    const secret = 'https://user.example/roms/bas.rom?token=SECRET123&x=1#frag-SECRET';
    store.add([{ name: 'bas.rom', bytes: bytes(1, 2, 3) }], { source: 'url', from: secret });
    store.add([{ name: 'm.rom', bytes: bytes(4, 5, 6) }], { source: 'media', from: 'dumps/m.rom?a=b#c' });
    const text = fs.readFileSync(path.join(dir, 'index.json'), 'utf8'), l = store.list();
    check('url: from is origin + path', l[0].from === 'https://user.example/roms/bas.rom', l[0].from);
    check('url: no query, token or fragment anywhere in index.json', !/SECRET|token|frag|\?/.test(text.replace('m.rom?a=b#c', '')), text);
    check('a media path is kept as it is', l[1].from === 'dumps/m.rom?a=b#c', l[1].from);
    store.add([{ name: 'bas.rom', bytes: bytes(1, 2, 3) }], { source: 'url', from: 'http://h.example:8080/p?q=1' });
    check('url: a port is kept, the query dropped', store.list()[0].from === 'http://h.example:8080/p');
  }

  // ---- two processes ----
  const run = (dir, tag, count) => new Promise((res) => {
    const c = spawn(process.execPath, [__filename, 'worker', dir, tag, String(count)], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    c.stderr.on('data', (d) => { err += d; });
    c.on('close', (code) => res({ code, err }));
  });
  for (const round of [0, 1, 2]) {
    const dir = path.join(TMP, `race${round}`), COUNT = 40;
    const rs = await Promise.all([run(dir, 'A', COUNT), run(dir, 'B', COUNT)]);
    let names = [], valid = true;
    try { names = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8')).roms.map((r) => r.name); } catch (e) { valid = false; }
    const want = ['A', 'B'].flatMap((t) => Array.from({ length: COUNT }, (_, i) => `${t}${i}.rom`));
    const missing = want.filter((w) => !names.includes(w));
    check(`race ${round}: both processes exit 0`, rs.every((r) => r.code === 0), rs.map((r) => r.err.slice(0, 200)).join('|'));
    check(`race ${round}: index.json is valid and holds all ${want.length} entries`, valid && !missing.length && names.length === want.length, `${names.length} entries, missing ${missing.slice(0, 5)}`);
    const left = fs.readdirSync(dir).filter((f) => /\.lock$|\.tmp$/.test(f));
    check(`race ${round}: no lock or temporary file left`, !left.length, left.join());
    check(`race ${round}: every stored image is there`, romStore(dir).files().length === want.length);
  }

  // ---- a lock left behind ----
  {
    const dir = path.join(TMP, 'stale'), store = romStore(dir);
    fs.mkdirSync(dir, { recursive: true });
    const lock = path.join(dir, 'index.lock');
    fs.writeFileSync(lock, '');
    const old = new Date(Date.now() - 60000);
    fs.utimesSync(lock, old, old);
    store.add([{ name: 'a.rom', bytes: bytes(9) }], { source: 'data', from: 'x' });
    check('a stale lock (a dead holder) is broken, the add goes through', store.list().length === 1 && !fs.existsSync(lock));
  }

  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(`\n${n - fail}/${n} passed`);
  process.exitCode = fail ? 1 : 0;
})();
