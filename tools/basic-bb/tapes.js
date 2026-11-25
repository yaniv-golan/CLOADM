// Tape fixtures for the black-box cases (docs/clean-room-basic.md section 7): tests/basic/tapes/NAME.json describes
// the files of a tape, written by us (our own BASIC programs as ASCII text, our own data files, a few bytes of our own
// machine code), never anything taken from a ROM. `#tape NAME` in a case plays the tape they make.
//   { "provenance": "who wrote it and what it is",
//     "files": [ { "name": "PROG", "type": "basic", "ascii": true, "lines": ["10 PRINT 1"] },
//                { "name": "F", "type": "data", "lines": ["HELLO", " 42"] },
//                { "name": "MC", "type": "binary", "load": 28672, "exec": 28672, "data": [134, 42, 57] } ],
//     "corrupt": [ { "block": 1, "byte": 3, "xor": 1 } ] }
// A file's contents are `lines` (each ended by a carriage return, as BASIC writes text to tape) or `data` (a string,
// one byte a character, or a list of bytes). A BASIC program is ASCII text only (no tokens on a fixture). `corrupt`
// flips bits in the built tape: block N (0 the first, as js/media/cassette.js casBlocks counts them), data byte B,
// XOR X, with its checksum left as it was.
// For a real Dragon (the typing sheet's "put in the tape NAME"), the fixture as a tape image or a recording to play:
//   node tools/basic-bb/tapes.js NAME [--cas FILE] [--wav FILE]
const fs = require('fs'), path = require('path');

const TAPES = path.join(__dirname, '../../tests/basic/tapes');
const NAME = /^[a-z0-9][a-z0-9-]*$/;

// -> { files: [buildCas file], corrupt: [] } or throws an Error saying what is wrong
function readFixture(name, dir = TAPES) {
  if (!NAME.test(name || '')) throw new Error(`a tape fixture's name is lower-case letters, digits and -, not ${JSON.stringify(name)}`);
  const file = path.join(dir, `${name}.json`);
  if (!fs.existsSync(file)) throw new Error(`no tape fixture ${name} (${path.relative(process.cwd(), file)})`);
  let fx;
  try { fx = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { throw new Error(`tape fixture ${name}: ${e.message}`); }
  if (typeof fx.provenance !== 'string' || !fx.provenance.trim()) throw new Error(`tape fixture ${name}: no provenance (who wrote it, and that it is our own)`);
  if (!Array.isArray(fx.files) || !fx.files.length) throw new Error(`tape fixture ${name}: no files`);
  const byte = (v) => Number.isInteger(v) && v >= 0 && v <= 255;
  const files = fx.files.map((f, i) => {
    const at = `tape fixture ${name} file ${i + 1}`;
    if (typeof f.name !== 'string' || f.name.length > 8 || !/^[ -~]*$/.test(f.name)) throw new Error(`${at}: a name of up to 8 printable characters`);
    if (!['basic', 'data', 'binary'].includes(f.type)) throw new Error(`${at}: type basic, data or binary`);
    if (f.type === 'basic' && f.ascii !== true) throw new Error(`${at}: a BASIC program on a fixture is ASCII text ("ascii": true)`);
    let data;
    if (Array.isArray(f.lines) && f.data === undefined) {
      if (!f.lines.every((l) => typeof l === 'string' && /^[ -~]*$/.test(l))) throw new Error(`${at}: lines are printable text`);
      data = [...f.lines.map((l) => l + '\r').join('')].map((c) => c.charCodeAt(0));
    } else if (typeof f.data === 'string' && f.lines === undefined) {
      data = [...f.data].map((c) => c.charCodeAt(0));
      if (!data.every(byte)) throw new Error(`${at}: data as a string is one byte a character`);
    } else if (Array.isArray(f.data) && f.lines === undefined) {
      if (!f.data.every(byte)) throw new Error(`${at}: data bytes 0-255`);
      data = f.data.slice();
    } else throw new Error(`${at}: either lines or data`);
    const out = { name: f.name, type: f.type, data };
    if (f.type === 'basic') out.ascii = true;
    if (f.type === 'binary') {
      const addr = (v) => Number.isInteger(v) && v >= 0 && v <= 0xFFFF;
      if (!addr(f.load) || !addr(f.exec)) throw new Error(`${at}: machine code needs load and exec addresses`);
      out.load = f.load; out.exec = f.exec;
    }
    return out;
  });
  const corrupt = fx.corrupt || [];
  if (!Array.isArray(corrupt) || !corrupt.every((c) => c && Number.isInteger(c.block) && c.block >= 0 && Number.isInteger(c.byte) && c.byte >= 0 && byte(c.xor) && c.xor)) throw new Error(`tape fixture ${name}: corrupt is a list of { block, byte, xor }`);
  return { files, corrupt };
}

// the .CAS bytes of a fixture (Emu: the emulator library, for buildCas and casBlocks)
function fixtureCas(fx, Emu) {
  const cas = Uint8Array.from(Emu.buildCas(fx.files));
  const blocks = [...Emu.casBlocks(cas)];
  for (const c of fx.corrupt) {
    const b = blocks[c.block];
    if (!b || c.byte >= b.data.length) throw new Error(`corrupt: block ${c.block} has no data byte ${c.byte}`);
    cas[b.start + 3 + c.byte] ^= c.xor;
  }
  return cas;
}

module.exports = { TAPES, readFixture, fixtureCas };

if (require.main === module) {
  const args = process.argv.slice(2), opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
  const name = args[0];
  if (!name || name.startsWith('--') || (!opt('--cas') && !opt('--wav'))) {
    console.error('usage: node tools/basic-bb/tapes.js NAME [--cas FILE] [--wav FILE]');
    process.exitCode = 2;
  } else {
    const Emu = require('../../tests/load.js')();
    const cas = fixtureCas(readFixture(name), Emu);
    if (opt('--cas')) fs.writeFileSync(opt('--cas'), cas);
    if (opt('--wav')) fs.writeFileSync(opt('--wav'), Emu.casToWav(cas, { gaps: 'player' }));
  }
}
