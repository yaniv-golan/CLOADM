// The harness installs our own firmware under the file names the MAME in use asks for. MAME has repartitioned
// ROM sets since 0.264, and getting the names or the split wrong means MAME refuses to boot the system - which
// is how the CoCo lost its BASIC while this was being built.
//
// The version is passed in, not read from the installed MAME, so BOTH sides are exercised on any machine: the
// 0.264 naming and the 0.289 naming are each checked, and the Dragon 32 image uses different bytes in each half
// so a wrong split cannot pass.
const fw = require('../tools/mame-diff/lib/firmware');
const Emu = require('./load')();

let fail = 0;
const check = (name, cond, detail = '') => { if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name} ${detail}`); };

const V264 = { major: 0, minor: 264, text: '0.264' };
const V289 = { major: 0, minor: 289, text: '0.289' };
const running = fw.mameVersion();
check('the installed MAME version is detected from `mame -version`', Number.isInteger(running.major) && Number.isInteger(running.minor), JSON.stringify(running));

// a slot whose names are ALTERNATIVES gets the whole image under every name (coco's four BASIC revisions) -
// the same on both versions, since 0.289 did not rename any of them
for (const [label, v] of [['0.264', V264], ['0.289', V289]]) {
  const profile = Emu.profiles.coco;
  const slot = profile.roms.find((s) => s.id === 'bas');
  const image = new Uint8Array(0x2000).fill(0x5A);
  let files = [];
  try { files = fw.romFilesFor(profile, { bas: image }, v); }
  catch (e) { check(`romFilesFor does not throw on coco's BASIC slot (${label})`, false, e.message); }
  const seen = files.filter((f) => slot.files.includes(f.name));
  check(`alternative names are written whole under each of them (${label})`,
    slot.files.length > 1 && seen.length === slot.files.length && seen.every((f) => f.bytes.length === image.length),
    seen.map((f) => `${f.name}=${f.bytes.length}`).join(' '));
}

// the Dragon 32's three names, per version: 0.264 is one 16K file, 0.289 is a PARTITION into two 8K halves.
// The image's two halves hold different bytes, so a split that puts the wrong half first, or drops a byte,
// changes what this compares.
{
  const profile = Emu.profiles.dragon32;
  const image = new Uint8Array(0x4000);
  for (let i = 0; i < 0x2000; i++) image[i] = 0x10 + (i & 0x0F);        // low half: 0x10..0x1F
  for (let i = 0x2000; i < 0x4000; i++) image[i] = 0xA0 + (i & 0x0F);   // high half: 0xA0..0xAF
  const halves = (files, names) => names.map((n) => files.find((f) => f.name === n));

  const f264 = fw.romFilesFor(profile, { basic: image }, V264);
  const one = f264.find((f) => f.name === 'd32.rom');
  check('0.264 writes the Dragon 32 image whole as d32.rom', !!one && one.bytes.length === 0x4000 && one.bytes[0] === 0x10 && one.bytes[0x3FFF] === 0xAF,
    one ? `${one.name} ${one.bytes.length} bytes` : 'd32.rom missing');
  check('0.264 does not write the 0.289 names', !f264.some((f) => /dragon_data_ltd/.test(f.name)));

  const f289 = fw.romFilesFor(profile, { basic: image }, V289);
  const [lo, hi] = halves(f289, ['dragon_data_ltd_1-0.ic18', 'dragon_data_ltd_1-1.ic17']);
  check('0.289 writes the Dragon 32 image as two 8K halves', !!lo && !!hi && lo.bytes.length === 0x2000 && hi.bytes.length === 0x2000,
    [lo, hi].map((f) => (f ? `${f.name}=${f.bytes.length}` : 'missing')).join(' '));
  check('0.289 puts the LOW half in _1-0 and the HIGH half in _1-1, byte for byte',
    !!lo && !!hi && lo.bytes.every((b, i) => b === image[i]) && hi.bytes.every((b, i) => b === image[0x2000 + i]),
    lo && hi ? `lo ${lo.bytes[0].toString(16)}..${lo.bytes[0x1FFF].toString(16)}, hi ${hi.bytes[0].toString(16)}..${hi.bytes[0x1FFF].toString(16)}` : 'missing');
  check('0.289 does not also write the 0.264 name into romFilesFor', !f289.some((f) => f.name === 'd32.rom'),
    f289.map((f) => f.name).join());
}

// the Tano Dragon 64: 0.264 keeps its two names, 0.289 renames both banks, nothing is split either way
{
  const profile = Emu.profiles.tanodr64;
  const image = new Uint8Array(0x4000).fill(0x33);
  const f264 = fw.romFilesFor(profile, { basic: image, basic64: image }, V264);
  const f289 = fw.romFilesFor(profile, { basic: image, basic64: image }, V289);
  check('0.264 keeps the Tano names', f264.some((f) => f.name === 'd64_1.rom') && f264.some((f) => f.name === 'd64_2.rom'),
    f264.map((f) => f.name).join(' '));
  check('0.289 renames both Tano banks, whole images, no split',
    f289.filter((f) => f.name === 'tano_1.ic18' || f.name === 'tano_2.ic17').every((f) => f.bytes.length === 0x4000)
    && f289.some((f) => f.name === 'tano_1.ic18') && f289.some((f) => f.name === 'tano_2.ic17'),
    f289.map((f) => `${f.name}=${f.bytes.length}`).join(' '));
}

// a system neither version renamed keeps its names
for (const [label, v] of [['0.264', V264], ['0.289', V289]]) {
  const profile = Emu.profiles.mc10;
  const files = fw.romFilesFor(profile, { basic: new Uint8Array(0x2000) }, v);
  check(`an unrenamed system keeps its 0.264 name (${label})`, files.length === 1 && files[0].name === profile.roms[0].files[0], files.map((f) => f.name).join());
}

// writeProfileRoms writes the version's names AND the 0.264 name, so one work folder serves either MAME
{
  const fs = require('fs'), os = require('os'), path = require('path');
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'romnames-'));
  const profile = Emu.profiles.dragon32;
  fw.writeProfileRoms(work, profile, { basic: new Uint8Array(0x4000) });
  const dir = path.join(work, 'roms', profile.mame);
  const names = fs.readdirSync(dir).sort();
  // host-independent by construction: writeProfileRoms writes every known version's names, so this holds
  // whether the installed MAME is 0.264 or 0.289 (or absent). The per-version behaviour is what romFilesFor()
  // is tested for above; this checks the folder is usable by either.
  check('writeProfileRoms writes both name sets, whichever MAME is installed',
    names.includes('d32.rom') && names.some((n) => /dragon_data_ltd/.test(n)), `${names.join(' ')} (installed: ${running.major}.${running.minor})`);
  for (const n of names) check(`  ${n} is not empty`, fs.statSync(path.join(dir, n)).size > 0, `${fs.statSync(path.join(dir, n)).size} bytes`);
  check('  d32.rom holds the whole image', fs.statSync(path.join(dir, 'd32.rom')).size === 0x4000);
  check('  the two split halves hold 8K each', fs.statSync(path.join(dir, 'dragon_data_ltd_1-0.ic18')).size === 0x2000
    && fs.statSync(path.join(dir, 'dragon_data_ltd_1-1.ic17')).size === 0x2000);
  fs.rmSync(work, { recursive: true, force: true });
}

console.log(fail ? `${fail} FAILED` : 'all passed');
process.exitCode = fail ? 1 : 0;
