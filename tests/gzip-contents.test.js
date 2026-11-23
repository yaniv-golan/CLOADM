// Run: node tests/gzip-contents.test.js
//
// tests/gzip-contents.js: two gzip files are the same when their contents are, whatever machine wrote them. The
// snapshot fixtures of tests/session-drives.test.js and tests/session-library.test.js are gzip files whose header
// "operating system" byte (RFC 1952 section 2.3.1, byte 9) is 3 where they were made (Linux) and 19 where zlib runs on
// macOS, so comparing their bytes failed there for a reason that is no change at all. These checks show the comparison
// takes that byte (and only that kind of difference) in its stride, and still refuses different contents.
const fs = require('fs'), path = require('path'), zlib = require('zlib');
const { sameGzipContents } = require('./gzip-contents');

let fail = 0;
const check = (name, cond, detail = '') => { if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name} ${detail}`); };

const text = (s) => zlib.gzipSync(Buffer.from(s));
const withOs = (gz, os) => { const c = Buffer.from(gz); c[9] = os; return c; };

{
  const a = text('the same snapshot, a few hundred bytes of it'.repeat(20));
  check('the operating system byte is where RFC 1952 puts it: byte 9, the last of the ten header bytes', a[0] === 0x1f && a[1] === 0x8b && a[2] === 8 && (a[9] === 3 || a[9] === 19 || a[9] === 255), `byte 9 = ${a[9]}`);
  for (const os of [3, 19, 0, 255]) {
    const r = sameGzipContents(withOs(a, 3), withOs(a, os));
    check(`the same contents with the operating system byte ${os} against 3 are the same`, r.same && r.why === '', JSON.stringify(r));
  }
  check('... and the raw bytes do differ (so the check above is not an identity)', Buffer.compare(withOs(a, 3), withOs(a, 19)) !== 0);
  check('the very same bytes are the same', sameGzipContents(a, a).same);
}

{
  const a = text('abcdefghij'.repeat(50)), b = text('abcdefghij'.repeat(49) + 'abcdefghiX');
  const r = sameGzipContents(a, b);
  check('a different last byte inside is not the same, and says where', !r.same && /differ at byte 499/.test(r.why), JSON.stringify(r));
  const c = text('abcdefghij'.repeat(51));
  const l = sameGzipContents(a, c);
  check('a different length inside is not the same, and says both lengths', !l.same && /500 bytes inside against 510/.test(l.why), JSON.stringify(l));
  // a difference in the contents hidden behind a different operating system byte is still found
  const h = sameGzipContents(withOs(a, 3), withOs(b, 19));
  check('different contents with different operating system bytes are not the same', !h.same);
}

{
  const a = text('abcdefghij'.repeat(50));
  for (const [what, bad] of [['a truncated file', a.subarray(0, a.length - 6)], ['plain text', Buffer.from('not gzip at all')], ['an empty file', Buffer.alloc(0)]]) {
    const r1 = sameGzipContents(a, bad), r2 = sameGzipContents(bad, a);
    check(`${what} is not the same as a good file, in either order, and is reported, not thrown`, !r1.same && !r2.same && /not a whole gzip file/.test(r1.why) && /not a whole gzip file/.test(r2.why), JSON.stringify([r1, r2]));
  }
}

// the fixture the two session tests compare: it is gzip, and its contents are what `sameGzipContents` reads
{
  const f = fs.readFileSync(path.join(__dirname, 'fixtures/session-split/drives-moment.cloadm'));
  check('the drives fixture is a gzip file written with the Unix operating system byte (3)', f[0] === 0x1f && f[1] === 0x8b && f[9] === 3, `byte 9 = ${f[9]}`);
  check('... and the same file written by macOS (byte 19) is the same', sameGzipContents(f, withOs(f, 19)).same);
  const tampered = Buffer.from(zlib.gunzipSync(f)); tampered[tampered.length >> 1] ^= 1;
  check('... but the file with one bit of its contents changed is not', !sameGzipContents(f, zlib.gzipSync(tampered)).same);
}

console.log(fail ? `${fail} FAILED` : 'all passed');
process.exitCode = fail ? 1 : 0;
