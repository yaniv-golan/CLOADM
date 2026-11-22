// The ROM store behind add_roms (cli/rom-store.js), without the MCP server: what index.json keeps as "from", and
// several processes adding at once. Stand-in bytes only.
//  * a URL carrying ?token=... and #frag is kept as origin + path, nothing else (a media path is kept as it is);
//  * two child processes, each adding its own ROMs many times: no entry is lost, the index stays valid JSON, no
//    lock or temporary file is left; a third process adding and removing its own ROMs meanwhile loses none of theirs;
//    a reader polling index.json during all of it never sees invalid JSON; a lock left by a dead process is broken
//    after the stale timeout, a lock that stays is an McpToolError (cannot-write) with the remedy;
//  * an index that is not valid is moved aside (index.json.corrupt-<time>) by a change, not silently dropped, and one
//    that cannot be read stops the change; old entries with a query in "from" are scrubbed on the next write.
// Run: node tests/rom-store.test.js
const fs = require('fs'), os = require('os'), path = require('path');
const { spawn } = require('child_process');
const { romStore } = require('../cli/rom-store.js');

if (process.argv[2] === 'worker') {
  const [, , , dir, tag, count] = process.argv, store = romStore(dir);
  // tag C adds a ROM of its own and removes it again, while the others add
  if (tag === 'C') for (let i = 0; i < +count; i++) { store.add([{ name: `C${i}.rom`, bytes: Uint8Array.from([67, i & 255, 9, 9]) }], { source: 'data', from: 'stand-in' }); store.remove([`C${i}.rom`]); }
  else for (let i = 0; i < +count; i++) store.add([{ name: `${tag}${i}.rom`, bytes: Uint8Array.from([tag.charCodeAt(0), i & 255, i >> 8, 7]) }], { source: 'data', from: 'stand-in' });
} else (async () => {
  let fail = 0, n = 0;
  const check = (name, cond, detail = '') => { n++; if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name}`); };
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cloadm-store-'));
  const J = JSON.stringify;
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
    // a reader: index.json is opened over and over while the three write; it is whole or not there, never half
    let reads = 0, bad = 0, why = '';
    const reader = setInterval(() => {
      let t; try { t = fs.readFileSync(path.join(dir, 'index.json'), 'utf8'); } catch (e) { return; }
      reads++;
      try { if (!Array.isArray(JSON.parse(t).roms)) throw new Error('no roms'); } catch (e) { bad++; why = `${e.message} in ${t.length} bytes`; }
    }, 0);
    const rs = await Promise.all([run(dir, 'A', COUNT), run(dir, 'B', COUNT), run(dir, 'C', COUNT)]);
    clearInterval(reader);
    check(`race ${round}: a reader polling index.json saw ${reads} reads, none invalid`, reads > 20 && bad === 0, `${bad} invalid (${why}) of ${reads}`);
    let names = [], valid = true;
    try { names = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8')).roms.map((r) => r.name); } catch (e) { valid = false; }
    const want = ['A', 'B'].flatMap((t) => Array.from({ length: COUNT }, (_, i) => `${t}${i}.rom`));
    const missing = want.filter((w) => !names.includes(w));
    check(`race ${round}: all three processes exit 0`, rs.every((r) => r.code === 0), rs.map((r) => r.err.slice(0, 200)).join('|'));
    check(`race ${round}: index.json is valid and holds all ${want.length} entries of A and B, none of C's (added and removed)`, valid && !missing.length && names.length === want.length, `${names.length} entries, missing ${missing.slice(0, 5)}`);
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

  // ---- a lock that stays ----
  {
    const dir = path.join(TMP, 'held'), store = romStore(dir, { lockWaitMs: 300 });
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'index.lock'), '');
    let e = null;
    try { store.add([{ name: 'a.rom', bytes: bytes(9) }], { source: 'data', from: 'x' }); } catch (x) { e = x; }
    check('a fresh lock that stays: add throws McpToolError cannot-write with the remedy', e && e.code === 'cannot-write' && e.name !== undefined && /remove index\.lock if no CLOADM server is running/.test(e.message) && e.tool && e.tool.code === 'cannot-write', e && e.message);
    let r = null;
    try { store.remove(null); } catch (x) { r = x; }
    check('... and so does remove', r && r.code === 'cannot-write');
    check('... nothing was stored, the lock is not ours to remove', !fs.existsSync(path.join(dir, 'index.json')) && fs.existsSync(path.join(dir, 'index.lock')));
  }

  // ---- Windows: the open refused (EACCES) with no lock file there ----
  {
    const dir = path.join(TMP, 'win'), store = romStore(dir, { lockWaitMs: 300 });
    const platform = Object.getOwnPropertyDescriptor(process, 'platform'), open = fs.openSync;
    Object.defineProperty(process, 'platform', { value: 'win32' });
    fs.openSync = (f, ...a) => { if (String(f).endsWith('index.lock')) throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }); return open(f, ...a); };
    const t0 = Date.now();
    let e = null;
    try { store.add([{ name: 'a.rom', bytes: bytes(9) }], { source: 'data', from: 'x' }); } catch (x) { e = x; }
    const took = Date.now() - t0;
    Object.defineProperty(process, 'platform', platform);
    fs.openSync = open;
    check('win32, EACCES and no lock file: add throws cannot-write at once naming EACCES, not a spin', e && e.code === 'cannot-write' && /cannot lock .*EACCES/.test(e.message) && took < 1000, `${took} ms ${e && e.message}`);
    check('... and a lock file there while EACCES lasts waits, then gives the timeout error', (() => {
      fs.writeFileSync(path.join(dir, 'index.lock'), '');
      Object.defineProperty(process, 'platform', { value: 'win32' });
      fs.openSync = (f, ...a) => { if (String(f).endsWith('index.lock')) throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); return open(f, ...a); };
      let x = null; const t = Date.now();
      try { store.add([{ name: 'a.rom', bytes: bytes(9) }], { source: 'data', from: 'x' }); } catch (y) { x = y; }
      const dt = Date.now() - t;
      Object.defineProperty(process, 'platform', platform); fs.openSync = open; fs.unlinkSync(path.join(dir, 'index.lock'));
      return x && x.code === 'cannot-write' && /remove index\.lock/.test(x.message) && dt < 2000;
    })());
  }

  // ---- an index that is not valid, or cannot be read ----
  {
    const dir = path.join(TMP, 'corrupt'), warns = [], store = romStore(dir, { warn: (t) => warns.push(t) });
    store.add([{ name: 'old.rom', bytes: bytes(1, 1, 1) }], { source: 'data', from: 'x' });
    const index = path.join(dir, 'index.json'), good = fs.readFileSync(index, 'utf8');
    fs.writeFileSync(index, good.slice(0, good.length >> 1));   // cut in half
    check('reading a corrupt index: [] and a warning, the file left alone', store.list().length === 0 && warns.length === 1 && fs.readFileSync(index, 'utf8').length === good.length >> 1);
    store.add([{ name: 'new.rom', bytes: bytes(2, 2, 2) }], { source: 'data', from: 'x' });
    const aside = fs.readdirSync(dir).filter((f) => /^index\.json\.corrupt-\d+(-\d+)?$/.test(f));
    check('a change moves a corrupt index aside, with its bytes, and warns naming it', aside.length === 1 && fs.readFileSync(path.join(dir, aside[0]), 'utf8').length === good.length >> 1 && warns.some((w) => w.includes(aside[0])), J(warns));
    check('... and goes on with the new entry', store.list().map((r) => r.name).join() === 'new.rom');
    // valid JSON of the wrong shape counts as corrupt too
    fs.writeFileSync(index, '{"roms": 5}');
    store.add([{ name: 'again.rom', bytes: bytes(3) }], { source: 'data', from: 'x' });
    check('JSON without a roms list is moved aside as well', fs.readdirSync(dir).filter((f) => /\.corrupt-/.test(f)).length === 2 && store.list().length === 1, J(fs.readdirSync(dir)));
    // unreadable (a directory where the file should be): the change stops, nothing is orphaned
    const dir2 = path.join(TMP, 'unreadable'), s2 = romStore(dir2);
    fs.mkdirSync(path.join(dir2, 'index.json'), { recursive: true });
    let e = null;
    try { s2.add([{ name: 'a.rom', bytes: bytes(9) }], { source: 'data', from: 'x' }); } catch (x) { e = x; }
    check('an index that cannot be read: add throws McpToolError cannot-write naming it, nothing changed', e && e.code === 'cannot-write' && e.message.includes('index.json') && fs.statSync(path.join(dir2, 'index.json')).isDirectory() && !fs.existsSync(path.join(dir2, 'index.lock')), e && e.message);
  }

  // ---- old entries are scrubbed; stale temporary files swept ----
  {
    const dir = path.join(TMP, 'scrub'), store = romStore(dir);
    fs.mkdirSync(dir, { recursive: true });
    const crc = 'AAAAAAAA';
    fs.writeFileSync(path.join(dir, 'index.json'), J({ roms: [{ file: `${crc}.rom`, name: 'old.rom', crc, size: 1, source: 'url', from: 'https://h.example/p.rom?token=OLD#f', added: 'x' }] }));
    const stale = path.join(dir, 'x.rom.1.2.tmp'), fresh = path.join(dir, 'y.rom.1.3.tmp');
    fs.writeFileSync(stale, ''); fs.writeFileSync(fresh, '');
    const old = new Date(Date.now() - 60000);
    fs.utimesSync(stale, old, old);
    store.add([{ name: 'n.rom', bytes: bytes(5) }], { source: 'data', from: 'x' });
    const text = fs.readFileSync(path.join(dir, 'index.json'), 'utf8');
    check('an older entry with a query in "from" is scrubbed by the next write', !/OLD|token/.test(text) && store.list().find((r) => r.name === 'old.rom').from === 'https://h.example/p.rom', text);
    check('a stale .tmp file is swept, a fresh one left', !fs.existsSync(stale) && fs.existsSync(fresh));
  }

  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(`\n${n - fail}/${n} passed`);
  process.exitCode = fail ? 1 : 0;
})();
