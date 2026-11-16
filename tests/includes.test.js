// Run: node tests/includes.test.js
// The assembler panel's INCLUDE resolution (js/media/includes.js): every file a source names, including
// the ones the included files name in turn, is fetched once and handed to the synchronous assembler.
const Emu = require('./load')();
let fail = 0;
const check = (n, c, d = '') => { if (!c) { fail++; console.log('FAIL', n, d); } else console.log('ok  ', n, d); };

// a fake file system: { name: text }, recording every fetch
function fsOf(files) {
  const fetched = [];
  return { fetched, fetch: async (name) => { fetched.push(name); return Object.prototype.hasOwnProperty.call(files, name) ? files[name] : null; } };
}
const names = (read) => ['a.inc', 'b.inc', 'c.inc', 'missing.inc'].filter((n) => read(n) != null);

(async () => {
  // nested includes: the panel must fetch what an included file includes too
  {
    const f = fsOf({ 'a.inc': ' FCB 1\n INCLUDE "b.inc"\n', 'b.inc': ' FCB 2\n INCLUDE "c.inc"\n', 'c.inc': ' FCB 3\n' });
    const read = await Emu.loadIncludes(' INCLUDE "a.inc"\n', f.fetch);
    check('nested INCLUDE files are fetched', names(read).join() === 'a.inc,b.inc,c.inc', names(read).join());
    check('each nested file was fetched once', f.fetched.length === 3 && new Set(f.fetched).size === 3, f.fetched.join());
    const r = Emu.assemble(' ORG $1000\n INCLUDE "a.inc"\n', '6809', { include: read });
    check('the nested include assembles', r.ok && [...r.segments[0].data].join() === '1,2,3', r.ok ? [...r.segments[0].data].join() : JSON.stringify(r.errors));
  }
  // a cycle: a includes b, b includes a. Both are fetched once; the assembler reports the cycle.
  {
    const f = fsOf({ 'a.inc': ' INCLUDE "b.inc"\n', 'b.inc': ' INCLUDE "a.inc"\n' });
    const read = await Emu.loadIncludes(' INCLUDE "a.inc"\n', f.fetch);
    check('a cycle stops the descent, fetching each file once', f.fetched.length === 2 && new Set(f.fetched).size === 2, f.fetched.join());
    const r = Emu.assemble(' ORG $1000\n INCLUDE "a.inc"\n', '6809', { include: read });
    check('the assembler is left to reject the cycle', !r.ok && /itself/.test(r.errors[0].message), r.errors[0] && r.errors[0].message);
  }
  // a file that includes itself
  {
    const f = fsOf({ 'self.inc': ' FCB 0\n INCLUDE "self.inc"\n' });
    const read = await Emu.loadIncludes(' INCLUDE "self.inc"\n', f.fetch);
    check('a self-include is fetched once', f.fetched.length === 1, f.fetched.join());
    const r = Emu.assemble(' ORG $1000\n INCLUDE "self.inc"\n', '6809', { include: read });
    check('the assembler rejects a self-include', !r.ok && /itself/.test(r.errors[0].message), r.errors[0] && r.errors[0].message);
  }
  // a missing file: fetched once, reported by the assembler at the INCLUDE line
  {
    const f = fsOf({});
    const read = await Emu.loadIncludes(' INCLUDE "missing.inc"\n INCLUDE "missing.inc"\n', f.fetch);
    check('a missing file is fetched once', f.fetched.length === 1, f.fetched.join());
    const r = Emu.assemble(' ORG $1000\n INCLUDE "missing.inc"\n', '6809', { include: read });
    check('the assembler names the missing file', !r.ok && /INCLUDE missing\.inc/.test(r.errors[0].message), r.errors[0] && r.errors[0].message);
  }
  // describeError: a readable location, with the file when the error came from one
  check('error locations read plainly', Emu.describeError({ file: null, line: 3, message: 'unknown mnemonic BADOP' }) === 'line 3: unknown mnemonic BADOP'
    && Emu.describeError({ file: 'liza-data.inc', line: 12, message: 'bad hex' }) === 'liza-data.inc line 12: bad hex');

  console.log(fail ? `${fail} FAILED` : 'all passed');
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.log('FAIL', e.stack); process.exitCode = 1; });
