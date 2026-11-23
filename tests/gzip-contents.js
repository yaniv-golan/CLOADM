// Compare two gzip files by what they hold, not by their bytes. A gzip header carries an "operating system" byte
// (RFC 1952, section 2.3.1: byte 9, 3 for Unix, 19 for Macintosh/Darwin as zlib writes it) that depends on the machine
// that wrote the file, so the same snapshot is 3 on Linux and 19 on macOS: the bytes differ and the contents do not.
// -> { same, why }: same is true when both decompress to the same bytes; why says what differed (or that one is not
// a gzip file at all), for a failing check's detail.
const zlib = require('zlib');

function gunzip(bytes, which) {
  try { return { data: zlib.gunzipSync(Buffer.from(bytes)) }; } catch (e) { return { why: `${which} is not a whole gzip file (${e.message})` }; }
}

function sameGzipContents(a, b) {
  const x = gunzip(a, 'the first'), y = gunzip(b, 'the second');
  if (x.why || y.why) return { same: false, why: x.why || y.why };
  if (x.data.length !== y.data.length) return { same: false, why: `${x.data.length} bytes inside against ${y.data.length}` };
  const i = x.data.findIndex((v, k) => v !== y.data[k]);
  return i < 0 ? { same: true, why: '' } : { same: false, why: `the contents differ at byte ${i}` };
}

module.exports = { sameGzipContents };
