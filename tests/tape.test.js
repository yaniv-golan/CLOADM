// Cassette media (js/media/cassette.js): WAV files read and written, the signal of a .CAS
// image, decoding real-world recordings (noise, speed drift, inverted phase, DC offset, writers off the nominal
// frequencies), and capturing what a machine writes through its cassette port. The firmware that writes is
// ours (tools/mame-diff/tape/csave.asm, written as BASIC's writer works); the bytes it must produce are built
// here from the tape format, independently of the firmware and of the decoder. tools/mame-diff/tape/run-tape.js
// does the same with MAME.
const fs = require('fs'), path = require('path');
const Emu = require('./load')();
const { firmware, csaveStream } = require('../tools/mame-diff/tape/spec.js');

let fail = 0;
const check = (name, cond, detail = '') => { if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name} ${detail}`); };
const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
const throws = (fn, re) => { try { fn(); return false; } catch (e) { return re.test(e.message); } };

// ---------------- WAV files, built by hand ----------------
function wav({ format = 1, channels = 1, rate = 8000, bits = 16, frames, extra = null, extensible = false }) {
  const bytesPer = bits / 8, data = Buffer.alloc(frames.length * channels * bytesPer);
  frames.forEach((f, i) => f.forEach((v, c) => {
    const o = (i * channels + c) * bytesPer;
    if (format === 3) data.writeFloatLE(v, o);
    else if (bits === 8) data[o] = v;
    else if (bits === 16) data.writeInt16LE(v, o);
    else if (bits === 24) data.writeIntLE(v, o, 3);
    else data.writeInt32LE(v, o);
  }));
  const fmt = Buffer.alloc(extensible ? 40 : 16);
  fmt.writeUInt16LE(extensible ? 0xFFFE : format, 0); fmt.writeUInt16LE(channels, 2); fmt.writeUInt32LE(rate, 4);
  fmt.writeUInt32LE(rate * channels * bytesPer, 8); fmt.writeUInt16LE(channels * bytesPer, 12); fmt.writeUInt16LE(bits, 14);
  if (extensible) { fmt.writeUInt16LE(22, 16); fmt.writeUInt16LE(format, 24); }
  const chunk = (id, body) => Buffer.concat([Buffer.from(id), Buffer.from(Uint32Array.of(body.length).buffer), body, body.length & 1 ? Buffer.alloc(1) : Buffer.alloc(0)]);
  const body = Buffer.concat([Buffer.from('WAVE'), chunk('fmt ', fmt), ...(extra ? [chunk('LIST', extra)] : []), chunk('data', data)]);
  return new Uint8Array(Buffer.concat([Buffer.from('RIFF'), Buffer.from(Uint32Array.of(body.length).buffer), body]));
}
const close = (a, b, eps = 1e-6) => a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) < eps);
{
  let w = Emu.parseWav(wav({ frames: [[0], [16384], [-32768], [32767]] }));
  check('WAV: 16-bit mono', w.sampleRate === 8000 && w.channels === 1 && close(w.samples, [0, 0.5, -1, 32767 / 32768]));
  w = Emu.parseWav(wav({ bits: 8, channels: 2, rate: 11025, frames: [[128, 128], [255, 1], [0, 64]], extra: Buffer.from('odd') }));
  check('WAV: 8-bit unsigned stereo mixed to mono, an odd-sized chunk before the data', w.sampleRate === 11025 && close(w.samples, [0, (127 / 128 - 127 / 128) / 2, (-1 - 0.5) / 2]));
  w = Emu.parseWav(wav({ bits: 24, frames: [[4194304], [-8388608]] }));
  check('WAV: 24-bit', close(w.samples, [0.5, -1]));
  w = Emu.parseWav(wav({ format: 3, bits: 32, frames: [[0.25], [-0.75]] }));
  check('WAV: 32-bit float', close(w.samples, [0.25, -0.75]));
  w = Emu.parseWav(wav({ extensible: true, frames: [[8192]] }));
  check('WAV: WAVE_FORMAT_EXTENSIBLE header', close(w.samples, [0.25]));
  check('WAV: not a WAV file is refused', throws(() => Emu.parseWav(new Uint8Array(64)), /not a WAV file/));
  check('WAV: ADPCM is refused with the reason', throws(() => Emu.parseWav(wav({ format: 2, bits: 16, frames: [[0]] })), /unsupported WAV encoding \(format 2/));
  const noData = wav({ frames: [[0]] }).slice(0, 36);
  noData.set([0, 0, 0, 0], 4);
  check('WAV: no data chunk is refused', throws(() => Emu.parseWav(noData), /no data/));
  const x = Float32Array.from({ length: 1000 }, (_, i) => Math.sin(i / 7) * 0.9);
  const back = Emu.parseWav(Emu.writeWav(x, 22050));
  check('WAV: written and read back (16-bit quantisation)', back.sampleRate === 22050 && close(back.samples, x, 2 / 32767));
}

// ---------------- .CAS -> signal -> .CAS ----------------
const stream = csaveStream();
const dataSum = [...Array(255).keys()].reduce((s, i) => (s + ((11 + 37 * i) & 0xFF)) & 0xFFFF, 0);
// a second image: two files, the second with a short leader and BASIC data, arbitrary bytes
const block = (type, data) => { let s = (type + data.length) & 255; for (const d of data) s = (s + d) & 255; return [0x3C, type, data.length, ...data, s, 0x55]; };
let seed = 7;
const rnd = () => { seed = (seed * 1103515245 + 12345) >>> 0; return seed / 2 ** 32; };
const second = Uint8Array.from([...new Array(128).fill(0x55), ...block(0, [...'GAME    '].map((c) => c.charCodeAt(0)).concat([0, 0xFF, 0xFF, 0, 0, 0, 0])),
  ...new Array(20).fill(0x55), ...block(1, Array.from({ length: 200 }, () => Math.floor(rnd() * 256))), ...new Array(20).fill(0x55), ...block(0xFF, [])]);
check('the test images parse as tapes', Emu.formats.parseCas(stream).length === 1 && Emu.formats.parseCas(second).length === 1);
for (const [name, cas] of [['csave stream', stream], ['second image', second]]) {
  const r = Emu.wavToCas(Emu.casToWav(cas));
  check(`${name}: our WAV export decodes back to identical bytes`, same(r.bytes, cas) && r.blocks === 3 && r.badBlocks === 0);
}
// real-world impairments on the exported signal
const x = Emu.casToSamples(stream);
const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
const map = (f) => Float32Array.from(x, f);
const resample = (base, wow) => { const out = []; let t = 0; while (t < x.length - 1) { const i = Math.floor(t), f = t - i; out.push(x[i] * (1 - f) + x[i + 1] * f); t += base * (1 + wow * Math.sin(2 * Math.PI * out.length / 44100 * 0.7)); } return Float32Array.from(out); };
const cases = [
  ['inverted phase', map((v) => -v)],
  ['DC offset', map((v) => v * 0.5 + 0.4)],
  ['noise (SNR about 11 dB)', map((v) => v + 0.15 * gauss())],
  ['8% slow', resample(0.92, 0)],
  ['10% fast', resample(1.1, 0)],
  ['wow: speed wandering by 8%', resample(1, 0.08)],
  ['all at once', (() => { const y = resample(0.95, 0.05); return y.map((v) => -0.6 * v + 0.2 + 0.08 * gauss()); })()],
];
for (const [name, y] of cases) {
  const r = Emu.samplesToCas(y, 44100);
  check(`decodes a recording with ${name}`, same(r.bytes, stream) && r.badBlocks === 0, `(${r.blocks} blocks, polarity ${r.polarity})`);
}
{
  const y = Emu.casToSamples(stream, { zeroHz: 1060, oneHz: 1900 });
  check('decodes a writer off the nominal frequencies (1060/1900 Hz)', same(Emu.samplesToCas(y, 44100).bytes, stream));
  const low = Emu.casToSamples(stream, { sampleRate: 11025 });
  check('decodes a recording at 11025 Hz', same(Emu.samplesToCas(low, 11025).bytes, stream));
  check('silence decodes to nothing', Emu.samplesToCas(new Float32Array(44100), 44100).bytes.length === 0);
}

// ---------------- what the machine writes ----------------
function capture(m, haltPc) {
  m.deck.startRecording();
  for (let f = 0; f < 50 * 20 && m.cpu.pc !== haltPc; f++) m.runFrame();
  return { reached: m.cpu.pc === haltPc, samples: Emu.recordingToSamples(m.deck.stopRecording(), m.tickHz, 44100) };
}
for (const id of ['dragon32', 'dragon64', 'tanodr64', 'coco', 'coco2b', 'coco3']) {
  const w = firmware(id, 'csave.asm');
  const { reached, samples } = capture(w.machine(), w.haltPc);
  const r = Emu.samplesToCas(samples, 44100);
  check(`${id}: csave.asm's output, captured, decodes to exactly the bytes written`, reached && same(r.bytes, stream), `(${r.bytes.length} bytes, ${r.blocks} blocks)`);
  check(`${id}: the capture as WAV decodes to the same bytes`, same(Emu.wavToCas(Emu.writeWav(samples, 44100)).bytes, stream));
  // our reader firmware reads the tape, and the WAV export of it, back
  const rd = firmware(id, 'cload.asm');
  for (const [what, bytes] of [['the .CAS', stream], ['our WAV export', Emu.casToWav(stream)]]) {
    const m = rd.machine(), d = Emu.formats.identify(what === 'the .CAS' ? 't.cas' : 't.wav', bytes);
    m.deck.insert(new Emu.Tape(d.bytes, m.tickHz, 't', m.profile.tape));
    for (let f = 0; f < 50 * 20 && m.cpu.pc !== rd.haltPc; f++) m.runFrame();
    const sum = [...Array(255).keys()].reduce((s, i) => (s + ((11 + 37 * i) & 255)) & 0xFFFF, 0);
    check(`${id}: cload.asm reads ${what}: 3 blocks, 255 bytes, their sum, no bad checksum`, m.cpu.pc === rd.haltPc && m.cpu.x === 255 && m.cpu.y === sum && m.cpu.u === 3 && m.cpu.b === 0);
  }
}
// MC-10 / Alice: the 6803 pair (tools/mame-diff/tape/csave6803.asm, cload6803.asm), which the comparison with
// MAME runs. The writer has no motor relay and toggles P20 only; the reader reports the block count and bad
// checksums in its 6803 internal RAM, high byte first, because the 6803 has a single 16-bit register.
for (const id of ['mc10', 'alice']) {
  // the base 4K the MC-10 always has (MAME's default fitting): the firmware must fit that, not the 20K default
  const w = firmware(id, 'csave6803.asm');
  const { reached, samples } = capture(w.machine({ ram: 4 }), w.haltPc);
  const r = Emu.samplesToCas(samples, 44100);
  check(`${id}: csave6803.asm's output, captured, decodes to exactly the bytes written`, reached && same(r.bytes, stream), `(${r.bytes.length} bytes, ${r.blocks} blocks)`);
  const rd = firmware(id, 'cload6803.asm');
  for (const [what, bytes] of [['the .CAS', stream], ['our WAV export', Emu.casToWav(stream)]]) {
    const m = rd.machine({ ram: 4 }), d = Emu.formats.identify(what === 'the .CAS' ? 't.cas' : 't.wav', bytes);
    m.deck.insert(new Emu.Tape(d.bytes, m.tickHz, 't', m.profile.tape));
    for (let f = 0; f < 50 * 40 && m.cpu.pc !== rd.haltPc; f++) m.runFrame();
    const ir = m.cpu.iram, word = (a) => (ir[a - 0x80] << 8) | ir[a - 0x80 + 1], sum = dataSum;
    check(`${id}: cload6803.asm reads ${what}: 3 blocks, 255 bytes, their sum, no bad checksum`,
      m.cpu.pc === rd.haltPc && m.cpu.x === 255 && (m.cpu.a | (m.cpu.b << 8)) === sum && word(0x88) === 3 && word(0x8A) === 0,
      `(X=${m.cpu.x} A:B=${m.cpu.a | (m.cpu.b << 8)} NBLK=${word(0x88)} NBAD=${word(0x8A)})`);
  }
}
// the same 6803 firmware with the machine's default fitting, so the firmware does not depend on 4K exactly
{
  const w = firmware('mc10', 'csave6803.asm');
  const { reached, samples } = capture(w.machine(), w.haltPc);
  check('mc10: csave6803.asm also runs with the default 20K fitting', reached && same(Emu.samplesToCas(samples, 44100).bytes, stream));
}
// the recorder only takes what is written while the motor runs
{
  const w = firmware('dragon64', 'csave.asm'), m = w.machine();
  m.deck.startRecording();
  for (let f = 0; f < 50 * 20 && m.cpu.pc !== w.haltPc; f++) m.runFrame();
  const ev = m.deck.stopRecording();
  check('the recording marks the motor stops (namefile pause, end)', ev.filter((e) => e[1] === null).length === 2 && ev[ev.length - 1][1] === null);
  check('nothing is recorded when not armed', m.deck.recording === null && m.deck.stopRecording().length === 0);
}
// MC-10: a 6803 writer toggling P20 (port 2 bit 0) a full square cycle per bit; no motor relay
{
  const src = `
        ORG     $5000
START   LDX     #DATA
NEXT    LDAA    0,X
        LDAB    #8
BIT     PSHB
        LSRA
        PSHA
        LDAB    #24             ; 1: 2400 Hz (24 passes a half cycle)
        BCS     HALF
        LDAB    #48             ; 0: 1200 Hz
HALF    PSHB                    ; the delay, once for each half
        PSHB
        LDAA    #1              ; P20 high
        STAA    $0003
D1      DECB
        BNE     D1
        PULB
        CLRA                    ; P20 low
        STAA    $0003
D2      DECB
        BNE     D2
        PULB
        PULA
        PULB
        DECB
        BNE     BIT
        INX
        CPX     #DATAE
        BNE     NEXT
HALT    BRA     HALT
DATA    FCB     ${Array.from(stream).join(',')}
DATAE
        END     START`;
  const asm = Emu.assemble(src, '6803');
  const m = Emu.createMachine('mc10');
  m.reset(true);
  for (let f = 0; f < 3; f++) m.runFrame();
  m.injectAndRun(asm.segments, asm.exec);   // (resets the machine; the stub's own port writes come before)
  m.deck.startRecording();
  const halt = asm.symbols.get('HALT');
  for (let f = 0; f < 50 * 20 && m.cpu.pc !== halt; f++) m.runFrame();
  const r = Emu.samplesToCas(Emu.recordingToSamples(m.deck.stopRecording(), m.tickHz, 44100), 44100);
  check('MC-10: a square-wave writer on P20, captured without a motor relay, decodes to the bytes written', asm.ok && m.cpu.pc === halt && same(r.bytes, stream), `(${r.bytes.length} bytes)`);
}

// ---------------- the Session ----------------
{
  const s = new Emu.Session();
  s.switchMachine('dragon64');
  const w = firmware('dragon64', 'csave.asm');
  s.machine.setRoms(w.slots); s.machine.reset(true);
  check('Session: not recording at first', !s.tapeRecording);
  s.startTapeRecording();
  check('Session: recording armed', s.tapeRecording);
  let t = 0;
  for (let i = 0; i < 300 && s.machine.cpu.pc !== w.haltPc; i++) s.advance(20, { now: () => t });
  const rec = s.stopTapeRecording();
  check('Session: stopTapeRecording gives the .CAS bytes written, and their WAV', same(rec.cas, stream) && rec.blocks === 3 && same(Emu.wavToCas(rec.wav).bytes, stream) && !s.tapeRecording,
    `(${rec.seconds.toFixed(1)} s)`);
  // a WAV recording loads like a .CAS
  s.switchMachine('coco');
  const msg = s.insertTape('mytape.wav', Emu.casToWav(second));
  check('Session: insertTape takes a WAV recording, decoded', /decoded from the recording: 3 blocks/.test(msg) && same(s.machine.deck.tape.bytes, second), msg);
  const out = s.tapeWav();
  check('Session: tapeWav exports the tape in the deck, which decodes back', out.name === 'mytape.wav' && same(Emu.wavToCas(out.bytes).bytes, second));
  s.machine.deck.eject();
  check('Session: tapeWav with no tape says so', throws(() => s.tapeWav(), /no tape in the deck/));
  const loaded = s.load('game.wav', Emu.casToWav(stream), { remember: false });
  check('Session: load() of a WAV with a machine-code file injects it, as a .CAS', /CLOADM fast-loaded/.test(loaded), loaded);
  check('Session: a WAV with no tape in it is refused with the reason', throws(() => s.load('quiet.wav', Emu.writeWav(new Float32Array(4410), 44100)), /no tape blocks found/));
  check('Session: a broken WAV is refused with the reason', throws(() => s.load('bad.wav', Uint8Array.from(Buffer.from('RIFF....WAVEjunk'))), /bad\.wav: WAV file has no format chunk/));
  // a format chunk that claims 16 bytes but the file ends inside it: a WavError, not a RangeError
  {
    const cut = Uint8Array.from([...Buffer.from('RIFF'), 0, 0, 0, 0, ...Buffer.from('WAVEfmt '), 16, 0, 0, 0, 1, 0, 1, 0]);
    let e = null; try { Emu.parseWav(cut); } catch (x) { e = x; }
    check('WAV: a format chunk cut short is a WavError', e instanceof Emu.WavError && /format chunk/.test(e.message), e && `${e.constructor.name}: ${e.message}`);
    check('Session: ...refused with the reason', throws(() => s.load('cut.wav', cut), /cut\.wav: .*format chunk/));
  }
  check('formats.identify: a WAV recording is a tape', Emu.formats.identify('x.wav', Emu.casToWav(stream)).kind === 'cas'
    && Emu.formats.identify('noext', Emu.casToWav(stream)).kind === 'cas');
}

// A recording still running when its machine goes (a machine switch, a snapshot opened) is finished and kept, not
// dropped (it warns and offers to download it first): the Session holds it as
// unsavedRecording and emits 'recording' before the machine changes, so the page can offer it.
{
  const record = () => {
    const s = new Emu.Session();
    s.switchMachine('dragon64');
    const w = firmware('dragon64', 'csave.asm');
    s.machine.setRoms(w.slots); s.machine.reset(true);
    s.startTapeRecording();
    let t = 0;
    for (let i = 0; i < 300 && s.machine.cpu.pc !== w.haltPc; i++) s.advance(20, { now: () => t });
    return s;
  };
  const s = record();
  const seen = [];
  s.on((ev) => seen.push(`${ev}:${s.machine.id}`));
  s.switchMachine('coco');
  const r = s.unsavedRecording;
  check('switch while recording: the recording is kept, with what was written', r && same(r.cas, stream) && r.blocks === 3 && r.machine === 'Dragon 64', r ? `${r.blocks} blocks from ${r.machine}` : 'none');
  check('...announced before the switch (recording, then machine)', seen.indexOf('recording:dragon64') >= 0 && seen.indexOf('recording:dragon64') < seen.indexOf('machine:coco'), seen.join(' '));
  check('...and the new machine is not recording', !s.tapeRecording);
  const s2 = record();
  s2.switchMachine('dragon64');                     // (a switch to the same model: also a new machine) -> kept
  check('switch to the same model while recording: kept too', !!s2.unsavedRecording);
  const s3 = record();
  const stub = new Emu.Session(); stub.switchMachine('dragon64');
  s3.openSnapshot(Emu.state.fromJSON(Emu.state.toJSON(stub.machine.snapshot())));   // same model: restored in place
  check('a snapshot opened while recording (no switch): the recording is kept', !!s3.unsavedRecording && same(s3.unsavedRecording.cas, stream));
  const s4 = new Emu.Session();
  s4.switchMachine('dragon64');
  s4.startTapeRecording();
  s4.switchMachine('coco');
  check('a recording with nothing written: nothing to keep', s4.unsavedRecording === null);
}

// Fast loading (the stub, or Session.fastCas) puts a file straight into memory, which is right only for a
// machine-code file (type 2) and a tokenised BASIC program (type 0). A DATA file (type 1) is read by a program
// with OPEN/INPUT#-1, and an ASCII BASIC listing must be tokenised by BASIC's CLOAD: neither may be poked into
// memory and run. Namefile block (type $00), as js/media/formats.js parseCas reads it: name (8),
// file type, ASCII flag, gap flag, exec (2), load (2).
{
  const block = (type, bytes) => { let sum = (type + bytes.length) & 0xFF; bytes.forEach((b) => { sum = (sum + b) & 0xFF; }); return [...Array(128).fill(0x55), 0x3C, type, bytes.length, ...bytes, sum, 0x55]; };
  const tape = (name, fileType, ascii, data, exec = 0, load = 0) => Uint8Array.from([
    ...block(0x00, [...Buffer.from(name.padEnd(8)), fileType, ascii ? 0xFF : 0, 0, exec >> 8, exec & 0xFF, load >> 8, load & 0xFF]),
    ...block(0x01, [...data]), ...block(0xFF, [])]);
  const dataTape = tape('SCORES', 1, true, Buffer.from('10,20,30\r'));
  const asciiTape = tape('LISTING', 0, true, Buffer.from('10 PRINT "HI"\r20 GOTO 10\r'));
  // on the stub (no ROMs)
  const s = new Emu.Session();
  s.switchMachine('coco');
  const ram0 = s.machine.ram.slice(0, 16);
  let msg = null, err = null;
  try { msg = s.load('scores.cas', dataTape, { remember: false }); } catch (e) { err = e; }
  check('fast load, DATA file: not poked into memory and run', !err && s.machine.ram.slice(0, 16).every((v, i) => v === ram0[i]) && s.machine.cpu.pc !== 0,
    err ? err.message : `pc $${s.machine.cpu.pc.toString(16)}`);
  check('...it is put in the deck, and the message says why it was not loaded', !err && !!s.machine.deck.tape && /SCORES is a DATA file/.test(msg) && /in the deck/.test(msg), msg || (err && err.message));
  check('fast load, ASCII BASIC on the stub: refused, it needs BASIC to read it', throws(() => s.load('listing.cas', asciiTape, { remember: false }), /BASIC ROM/));
  // with ROMs and fastCas (a stand-in ROM: only what the Session decides is looked at)
  const r = new Emu.Session();
  r.switchMachine('coco');
  r.machine.setRoms({ bas: new Uint8Array(0x2000).fill(0x12) });
  r.fastCas = true;
  msg = r.load('listing.cas', asciiTape, { remember: false });
  check('fastCas, ASCII BASIC: loaded through BASIC (CLOAD, RUN), not fast-loaded', /loading via BASIC/.test(msg) && r.machine.typist.queue.join('').startsWith('CLOAD\r'), msg);
  r.machine.typist.clear();
  msg = r.load('scores.cas', dataTape, { remember: false });
  check('fastCas, DATA file: in the deck, nothing typed', /SCORES is a DATA file/.test(msg) && !r.machine.typist.busy && !!r.machine.deck.tape, msg);
  // and without fastCas (through BASIC): a DATA file is not CLOADed (BASIC would say ?FM ERROR)
  r.fastCas = false;
  r.machine.typist.clear();
  msg = r.load('scores.cas', dataTape, { remember: false });
  check('through BASIC, DATA file: in the deck, nothing typed', /SCORES is a DATA file/.test(msg) && !r.machine.typist.busy, msg);
}

console.log(fail ? `${fail} FAILED` : 'all tape checks passed');
process.exitCode = fail ? 1 : 0;
