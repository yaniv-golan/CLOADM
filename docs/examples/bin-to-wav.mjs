// bin-to-wav.mjs - turn a program into a .CAS tape and into a WAV a real tape player can play into a Dragon or a CoCo, from Node, with
// the public modules only (js/emu.js): no leaders or silences to put in by hand.
//
//   node docs/examples/bin-to-wav.mjs [outdir]        (writes GAME.cas and GAME.wav there; default: the current directory)
//
// It runs from any directory (it finds the repository from its own path; set CLOADM_DIR=/path/to/cloadm to use it from a copy
// elsewhere). What it does, each step checked:
//   1. assembles docs/examples/framecount.asm (read from the repository) with the bundled assembler
//   2. buildCas: the program as a tape file: a namefile block with the name, the load and exec addresses, the data blocks and the
//      end-of-file block, each with its 128-byte leader and checksum, as BASIC's CSAVEM writes them
//   3. casToWav: the signal a tape player plays: 1200 Hz cycles for a 0 and 2400 Hz for a 1, with the silences and leaders a player
//      puts around the blocks (2 s at the start, 1 s around the namefile; the same layout the emulated deck plays)
//   4. reads both back (parseCas of the .CAS, wavToCas of the WAV): the same bytes, the same file with its name, addresses and data
//   5. prints what it wrote as one JSON line
// docs/automation.md ("A tape for a real Dragon or CoCo") explains it; tests/bin-to-tape.test.js runs it.
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.env.CLOADM_DIR ? pathToFileURL(resolve(process.env.CLOADM_DIR) + '/') : new URL('../../', import.meta.url);
const { assemble, buildCas, casToWav, wavToCas, parseWav, formats } = await import(new URL('js/emu.js', root));
const outdir = process.argv[2] || '.';
const fail = (what) => { throw new Error(`bin-to-wav: ${what}`); };

// 1. the program
const res = assemble(readFileSync(new URL('docs/examples/framecount.asm', root), 'utf8'), '6809');
if (!res.ok) fail(res.errors.map((e) => e.message).join('; '));
if (res.segments.length !== 1) fail('a tape file holds one contiguous range; this program has several');
const { addr: load, data } = res.segments[0];

// 2. the tape: one file, a Dragon's family (a CoCo's tape is the same bytes; the MC-10's is a .c10 and is not padded)
const cas = buildCas([{ name: 'GAME', type: 'binary', load, exec: res.exec, data }], { family: 'dragon' });

// 3. the signal: a sine wave at 44100 Hz (wave: 'square' is the other choice, for a player that wants a hard edge)
const wav = casToWav(cas, { family: 'dragon', gaps: 'player', wave: 'sine', sampleRate: 44100 });

// 4. read back: the bytes the WAV decodes to, and the file in them
const back = wavToCas(wav);
if (back.bytes.length !== cas.length || back.bytes.some((b, i) => b !== cas[i])) fail('the WAV does not decode to the .CAS bytes');
const [file] = formats.parseCas(cas);
if (!file || file.name !== 'GAME' || file.load !== load || file.exec !== res.exec || file.data.length !== data.length || file.data.some((b, i) => b !== data[i])) fail('the .CAS does not hold the program');
// the silences in the signal: runs of exactly zero samples of at least half a second
const { samples, sampleRate } = parseWav(wav);
const silences = [];
for (let i = 0, run = 0; i <= samples.length; i++) {
  if (i < samples.length && samples[i] === 0) { run++; continue; }
  if (run >= sampleRate / 2) silences.push({ at: Math.round((i - run) / sampleRate * 100) / 100, seconds: Math.round(run / sampleRate * 100) / 100 });
  run = 0;
}

// 5. the files, and what is in them
writeFileSync(join(outdir, 'GAME.cas'), cas);
writeFileSync(join(outdir, 'GAME.wav'), wav);
console.log(JSON.stringify({ cas: cas.length, wav: wav.length, seconds: Math.round(samples.length / sampleRate * 100) / 100, blocks: back.blocks,
  file: { name: file.name, load: file.load, exec: file.exec, bytes: file.data.length }, silences }));
