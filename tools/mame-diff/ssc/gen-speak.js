// The Speech/Sound Pak's SP0256 timing case: our own speech image (sp0256-asm.js) and our own firmware for both CPUs.
//
// THE SPEECH IMAGE holds one test per allophone number, 1 to N. Each starts with SETMODE, runs one instruction under
// test with distinct field values, and ends with a LOAD_E "marker" (its own amplitude and pitch) and a RTS. Every
// load instruction in all four modes is covered, and PAUSE, repeat counts with SETMODE's high bits, a repeat of 0
// (which reads no fields), interpolation, delta loads, unvoiced (pitch 0) periods, JSR/RTS and PAGE. The timing is
// what the comparison measures: how long each test plays depends on its repeat count and pitch, and a field read
// with the wrong width misframes everything after it, the marker included, which changes the timing.
//
// THE PIC PROGRAM (TMS7040), from its own reset, loads allophones 1 to N in turn: it waits until the SP0256's LRQ
// says it is ready (its INT1 flag; interrupts stay disabled), loads the next number with an ALD pulse, and clears the
// flag. The wait-load-clear order works whether INT1's flag follows the line (MAME's tms7000.cpp) or latches it (TI's
// manual and js/cpu/cpu7000.js): the flag is cleared after LRQ has gone low.
//
// THE 6809 PROGRAM waits (about 1.12 million cycles: to 1.25 s on the CoCos, 1.26 on the Dragon; after the PIC's last
// load at 1.238 s and before the chip goes to standby at 1.271 s; speakHost), then reads $FF7E over and over, so both emulators
// sample SBY (bit 6) at the same instants. It does not read the status while the PIC is still loading: a status read
// brings the speech chip up to the read's time (MAME's sby_r updates its stream), so an LRQ change could come from a
// 6809 read, and MAME passes that to the PIC's INT1 across two CPUs it interleaves on its scheduler, which moved
// single loads by one pass of the PIC's polling loop (23 card cycles) when the 6809 polled throughout.
const { loadEmu, romImage } = require('../lib/firmware.js');
const { assemble } = require('./sp0256-asm.js');
const { FIELDS, OP } = require('../../../js/chips/sp0256.js');

// a deterministic spread of field values that fit each field's width (no randomness: the image is the same every run)
function values(op, mode, seed) {
  const fields = FIELDS[op][mode].filter((x) => x.length === 4);
  return fields.map(([reg, bits], i) => {
    if (reg === 1) return bits === 8 ? 24 + ((seed * 7 + i) % 40) : (seed + i) % (1 << bits);   // pitch: 24-63
    if (reg === 14 || reg === 15) return (seed + 3 * i + 1) % (1 << bits);                        // interpolation
    return (seed * 13 + i * 29 + 5) % (1 << bits);
  });
}

const LOADS = ['LOADALL', 'LOAD_4', 'LOAD_C', 'LOAD_2', 'SETMSB_6', 'SETMSB_A', 'DELTA_9', 'DELTA_D', 'LOAD_E', 'SETMSB_5', 'SETMSB_3'];

function cases() {
  const out = [];
  let seed = 1;
  const marker = (k) => ({ op: 'LOAD_E', repeat: 2, fields: [20 + (k % 30), 30 + (k % 20)] });
  // every load in every mode, with a repeat of 1-4 and a pitch where it has one
  for (const name of LOADS) {
    for (let mode = 0; mode < 4; mode++) {
      const k = out.length;
      const body = [{ op: 'SETMODE', mode }];
      // a delta needs something to add to: a pitch first (the registers are cleared when an allophone starts)
      if (name.startsWith('DELTA')) body.push({ op: 'LOAD_E', repeat: 1, fields: [12, 40] }, { op: 'SETMODE', mode });
      body.push({ op: name, repeat: 1 + (k % 4), fields: values(OP[name], mode, seed++) });
      body.push(marker(k), { op: 'RTS' });
      out.push({ name: `${name} mode ${mode}`, body });
    }
  }
  const add = (name, body) => out.push({ name, body });
  add('PAUSE, repeat 3', [{ op: 'SETMODE', mode: 0 }, { op: 'PAUSE', repeat: 3 }, marker(1), { op: 'RTS' }]);
  add('repeat high bits from SETMODE (repeat 16 + 2)', [{ op: 'SETMODE', mode: 0, msb: 1 },
    { op: 'LOAD_E', repeat: 2, fields: [10, 25] }, marker(2), { op: 'RTS' }]);
  add('a repeat of 0 reads no fields', [{ op: 'SETMODE', mode: 0 }, { op: 'LOAD_E', repeat: 0 }, marker(3), { op: 'RTS' }]);
  add('unvoiced: pitch 0, 64 samples a repeat', [{ op: 'SETMODE', mode: 0 }, { op: 'LOAD_E', repeat: 3, fields: [16, 0] },
    marker(4), { op: 'RTS' }]);
  add('JSR and RTS', [{ op: 'SETMODE', mode: 0 }, { op: 'JSR', to: 'sub' }, marker(5), { op: 'RTS' }]);
  add('PAGE then JMP', [{ op: 'PAGE', page: 1 }, { op: 'JMP', to: 'paged' }]);
  return out;
}

function speechProgram() {
  const list = cases();
  const prog = [];
  list.forEach((c, i) => prog.push({ entry: i + 1, to: `case${i + 1}` }));
  list.forEach((c, i) => { prog.push({ align: true }, { label: `case${i + 1}` }, ...c.body); });
  // the subroutine and the paged target the last two cases use
  prog.push({ align: true }, { label: 'sub' }, { op: 'LOAD_E', repeat: 3, fields: [33, 45] }, { op: 'RTS' });
  prog.push({ align: true }, { label: 'paged' }, { op: 'SETMODE', mode: 0 }, { op: 'LOAD_E', repeat: 2, fields: [40, 50] },
    { op: 'RTS' });
  return { list, prog };
}

function speechImage() { return assemble(speechProgram().prog).image; }

const hex = (v) => `$${v.toString(16).toUpperCase().padStart(2, '0')}`;
function picSource(count) {
  const lines = [
    '* generated by tools/mame-diff/ssc/gen-speak.js: loads allophones 1..N as the SP0256 asks for them',
    '        ORG     $F000',
    'RESET   DINT',
    '        MOVP    %$00,P0 ; IOCNT0: no interrupt enabled',
    '        MOVP    %$FF,P9 ; port C: outputs (the control bus)',
    '        MOVP    %$FF,P11 ; port D: outputs (the data bus)',
    '        MOVP    %$40,P8 ; port C: AY deselected, ALD low',
  ];
  for (let n = 1; n <= count; n++) {
    lines.push(`W${n}      MOVP    P0,A`, '        AND     %$02,A ; INT1 flag: the SP0256 is ready for an address', `        JZ      W${n}`,
      `        MOVP    %${hex(n)},P10 ; port D = allophone ${n}`,
      '        MOVP    %$60,P8 ; ALD high', '        MOVP    %$40,P8 ; ALD low: the falling edge loads it',
      '        MOVP    %$02,P0 ; clear the INT1 flag (LRQ is low now)');
  }
  lines.push('IDLE    JMP     IDLE', '        ORG     $FFFE', '        FDB     RESET', '        END     RESET');
  return lines.join('\n') + '\n';
}

const hostSource = (inner) => `* generated by tools/mame-diff/ssc/gen-speak.js: waits, then reads the Pak's status over and over
        ORG     $A000
RESET   ORCC    #$50
        LDS     #$7F00
        LDB     #4              ; 4 x ${inner} passes of 8 cycles
OUTER   LDX     #${inner}
INNER   LEAX    -1,X
        BNE     INNER
        DECB
        BNE     OUTER
POLL    LDA     $FF7E
        BRA     POLL
        ORG     $BFF2
        FDB     IRQH,IRQH,IRQH,IRQH,IRQH,IRQH,RESET
IRQH    RTI
        END     RESET
`;

function assembleOrThrow(src, cpu, what) {
  const res = loadEmu().assemble(src, cpu);
  if (!res.ok) throw new Error(`${what}: ${res.errors.map((e) => `line ${e.line}: ${e.message}`).join('; ')}`);
  return res;
}
function speakPic() { return romImage(assembleOrThrow(picSource(cases().length), '7000', 'gen-speak PIC'), 0xF000, 0x1000, 0xFF); }
// The delay, per model, so the 6809 starts reading at about 1.245 s: 4 x 35,000 passes on the CoCo 1/2, 2B and Dragon
// 64; the CoCo 3 starts its program 81 ms later (its reset runs longer before our code; measured, 1.3328 s against
// 1.2516 s with the same delay), so 4 x 32,730 there.
const DELAY = { coco: 35000, coco2b: 35000, dragon64: 35000, coco3: 32730 };
function speakHost(profileId = 'coco') {
  if (!DELAY[profileId]) throw new Error(`gen-speak: no delay for ${profileId}`);
  return assembleOrThrow(hostSource(DELAY[profileId]), '6809', 'gen-speak host');
}

module.exports = { cases, speechProgram, speechImage, speakPic, speakHost, picSource };
