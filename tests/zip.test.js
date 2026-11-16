// ZIP reader and inflate: archives built by hand here (headers written byte by byte), DEFLATE data from
// Node's zlib (the test oracle only; js/media/zip.js has its own inflate).
const zlib = require('zlib');
const Emu = require('./load')();
const { readZip, inflate, isZip, ZipError } = require('../js/media/zip.js');

let fail = 0;
const check = (name, cond, detail = '') => { if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name} ${detail}`); };
const throwsZip = (fn, re) => { try { fn(); return false; } catch (e) { return e instanceof ZipError && re.test(e.message) ? true : (console.log('   threw:', e.message), false); } };
const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

const rnd = (n, seed) => { const b = new Uint8Array(n); let x = seed; for (let i = 0; i < n; i++) { x = (x * 1103515245 + 12345) >>> 0; b[i] = x >>> 24; } return b; };
const text = (n) => new TextEncoder().encode('10 PRINT "HELLO, WORLD"\r20 GOTO 10\r'.repeat(Math.ceil(n / 33)).slice(0, n));

// ---- zip writer for the tests: [{ name, data, method (0|8), level, flags, raw (override compressed data) }] ----
function makeZip(entries, { zip64 = false, comment = '' } = {}) {
  const u16 = (v) => [v & 0xFF, (v >> 8) & 0xFF], u32 = (v) => [v & 0xFF, (v >>> 8) & 0xFF, (v >>> 16) & 0xFF, (v >>> 24) & 0xFF];
  const local = [], central = [];
  let off = 0;
  for (const e of entries) {
    const name = [...new TextEncoder().encode(e.name)];
    const comp = e.raw || (e.method === 8 ? new Uint8Array(zlib.deflateRawSync(e.data, { level: e.level ?? 9 })) : e.data);
    const crc = parseInt(Emu.crc32(e.data), 16);
    const hdr = [...u32(0x04034B50), ...u16(20), ...u16(e.flags || 0), ...u16(e.method), ...u16(0), ...u16(0), ...u32(crc), ...u32(comp.length), ...u32(e.data.length), ...u16(name.length), ...u16(0), ...name];
    local.push(...hdr, ...comp);
    const csz = zip64 ? 0xFFFFFFFF : comp.length;
    central.push(...u32(0x02014B50), ...u16(20), ...u16(20), ...u16(e.flags || 0), ...u16(e.method), ...u16(0), ...u16(0), ...u32(crc), ...u32(csz), ...u32(e.data.length),
      ...u16(name.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(off), ...name);
    off += hdr.length + comp.length;
  }
  const c = [...new TextEncoder().encode(comment)];
  const eocd = [...u32(0x06054B50), ...u16(0), ...u16(0), ...u16(entries.length), ...u16(entries.length), ...u32(central.length), ...u32(local.length), ...u16(c.length), ...c];
  return Uint8Array.from([...local, ...central, ...eocd]);
}

// ---- inflate against zlib ----
{
  const cases = [['empty', new Uint8Array(0)], ['one byte', Uint8Array.of(42)], ['random 16K', rnd(16384, 1)], ['text 32K', text(32768)],
    ['zeros 40K', new Uint8Array(40000)], ['random 70K (long-distance copies)', (() => { const r = rnd(20000, 2); const b = new Uint8Array(70000); for (let i = 0; i < b.length; i++) b[i] = r[i % 20000]; return b; })()]];
  for (const [name, data] of cases) {
    for (const level of [0, 1, 9]) {
      const z = new Uint8Array(zlib.deflateRawSync(data, { level }));
      let out; try { out = inflate(z, data.length); } catch (e) { out = null; console.log('   ', e.message); }
      check(`inflate ${name} (level ${level})`, out && same(out, data));
    }
  }
  const fixed = new Uint8Array(zlib.deflateRawSync(text(2000), { strategy: zlib.constants.Z_FIXED }));
  check('inflate fixed-Huffman blocks', same(inflate(fixed, 2000), text(2000)));
  check('inflate rejects a reserved block type', throwsZip(() => inflate(Uint8Array.of(0x07), 10), /reserved block type/));
  check('inflate rejects truncated data', throwsZip(() => inflate(new Uint8Array(zlib.deflateRawSync(rnd(5000, 3))).subarray(0, 100), 5000), /truncated/));
  check('inflate rejects a size mismatch', throwsZip(() => inflate(new Uint8Array(zlib.deflateRawSync(text(500))), 400), /longer than the stated size/));

  // The two copies inflate makes in one go. A stored block is a byte range copied as-is;
  // a match may overlap what it writes and is copied by doubling, so the cases that matter are the short
  // distances (where almost every byte is an overlap), a run long enough to need several doublings, a distance
  // near the 32K window, and stored blocks that end exactly on the output's last byte.
  const repeat = (pat, n) => { const b = new Uint8Array(n); for (let i = 0; i < n; i++) b[i] = pat[i % pat.length]; return b; };
  const windowWrap = (() => {                        // a match 32,768 back: copies the window's own start
    const noise = rnd(32768, 21), b = new Uint8Array(32768 + 20000);
    b.set(noise, 0);
    for (let i = 0; i < 20000; i++) b[32768 + i] = noise[i];
    return b;
  })();
  const inflateCases = [
    ['distance 1 (every byte an overlap)', new Uint8Array(32000).fill(0x41), 9],
    ['distance 2', repeat(Uint8Array.of(0x41, 0x42), 32000), 9],
    ['distance 3, a 258-byte run over it', repeat(Uint8Array.of(0x41, 0x42, 0x43), 32000), 9],
    ['many doublings (one run of 32K)', new Uint8Array(32000).fill(0x5A), 9],
    ['a match 32,768 back (the window wrap)', windowWrap, 9],
    ['a match whose source starts at the output\'s first byte', repeat(rnd(1000, 7), 40000), 9],
    ['stored block ending exactly at the output', rnd(65535, 9), 0],
    ['two full stored blocks ending exactly', rnd(131070, 11), 0],
  ];
  for (const [name, data, level] of inflateCases) {
    const comp = new Uint8Array(zlib.deflateRawSync(data, { level }));
    let out = null; try { out = inflate(comp, data.length); } catch (e) { console.log('   ', e.message); }
    check(`inflate matches zlib: ${name}`, out && same(out, data), `${data.length} bytes from ${comp.length}`);
  }
}

// ---- archives ----
const romA = rnd(16384, 10), romB = rnd(8192, 11), note = new TextEncoder().encode('Dumped from my own Dragon 64.\n');
{
  const z = makeZip([{ name: 'roms/', data: new Uint8Array(0), method: 0 }, { name: 'roms/d64_1.rom', data: romA, method: 8 },
    { name: 'roms/BAS13.ROM', data: romB, method: 0 }, { name: 'readme.txt', data: note, method: 8 }], { comment: 'my roms' });
  check('isZip', isZip(z) && !isZip(romA));
  const files = readZip(z);
  check('reads stored and deflated entries, skips directories, keeps paths', files.length === 3 && files[0].name === 'roms/d64_1.rom'
    && same(files[0].data, romA) && same(files[1].data, romB) && same(files[2].data, note));
}
{
  // an archive made by zlib's own container-less API can't be a zip; check a real-world shape: data descriptor flag (bit 3)
  const z = makeZip([{ name: 'a.rom', data: romB, method: 8, flags: 0x08 }]);
  check('entries with a data descriptor flag (sizes from the central directory)', same(readZip(z)[0].data, romB));
}
check('rejects a non-ZIP', throwsZip(() => readZip(romA), /not a ZIP/));
check('rejects a truncated archive (end record cut)', throwsZip(() => readZip(makeZip([{ name: 'a', data: romA, method: 8 }]).subarray(0, 5000)), /not a ZIP|truncated/));
{
  const z = makeZip([{ name: 'a', data: romA, method: 0 }]);
  const cut = new Uint8Array(z.length - 9000); cut.set(z.subarray(0, 100)); cut.set(z.subarray(z.length - (cut.length - 100)), 100);
  check('rejects an archive whose data is cut short', throwsZip(() => readZip(cut), /truncated|corrupt/));
}
check('rejects encrypted entries', throwsZip(() => readZip(makeZip([{ name: 'secret.rom', data: romB, method: 0, flags: 0x01 }])), /encrypted/));
check('rejects zip64 archives', throwsZip(() => readZip(makeZip([{ name: 'big.rom', data: romB, method: 0 }], { zip64: true })), /zip64/));
check('rejects other compression methods', throwsZip(() => readZip(makeZip([{ name: 'x.rom', data: romB, method: 12, raw: romB }])), /method 12/));
{
  const bad = makeZip([{ name: 'x.rom', data: romB, method: 0 }]);
  bad[30 + 5 + 100] ^= 0xFF;   // flip a data byte
  check('rejects corrupt data (CRC mismatch)', throwsZip(() => readZip(bad), /CRC mismatch/));
}

// ---- decompression limits: a small archive must not make the page allocate gigabytes ----
// An entry may be at most `maxEntry` bytes and the archive `maxTotal` in all (ZIP_LIMITS by default); the sizes
// come from the central directory, so the check is made before anything is inflated or allocated. DEFLATE
// expands at most 1032:1 (RFC 1951: a 258-byte match costs at least 2 bits), so a stated size beyond that is a lie.
{
  const { ZIP_LIMITS } = require('../js/media/zip.js');
  check('default limits: 32 MiB an entry, 64 MiB an archive', ZIP_LIMITS.maxEntry === 32 << 20 && ZIP_LIMITS.maxTotal === 64 << 20, JSON.stringify(ZIP_LIMITS));
  const zeros = new Uint8Array(200000);
  const z = makeZip([{ name: 'a.dsk', data: zeros, method: 8 }, { name: 'b.dsk', data: zeros, method: 8 }]);
  check('within the limits: read', readZip(z, { maxEntry: 200000, maxTotal: 400000 }).length === 2);
  check('an entry over maxEntry: refused, naming it and the limit', throwsZip(() => readZip(z, { maxEntry: 199999 }), /a\.dsk: 200000 bytes unpacked, more than this page takes \(199999\)/));
  check('the archive over maxTotal: refused', throwsZip(() => readZip(z, { maxTotal: 399999 }), /more than 399999 bytes unpacked in all/));
  // a central directory claiming 3 GB for a few bytes of DEFLATE data: refused before any allocation
  const lie = makeZip([{ name: 'x.bin', data: Uint8Array.of(1, 2, 3), method: 8 }]);
  const cd = lie.length - 22 - 46 - 5;   // the central directory entry (one entry, 5-byte name, no comment)
  new DataView(lie.buffer).setUint32(cd + 24, 3e9, true);
  check('a stated size DEFLATE cannot reach from the data: refused as corrupt', throwsZip(() => readZip(lie, { maxEntry: 4e9, maxTotal: 4e9 }), /x\.bin: corrupt ZIP \(stated size 3000000000 bytes from \d+ compressed\)/));
  check('...and over the default limit it says so first', throwsZip(() => readZip(lie), /x\.bin: 3000000000 bytes unpacked, more than this page takes/));
}

console.log(fail ? `${fail} FAILED` : 'all passed');
process.exitCode = fail ? 1 : 0;
