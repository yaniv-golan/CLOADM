// The SAM's page bit P1 and memory-size bits M1/M0, on the machine.
// The expected values are MAME 0.289's rule, read from its source rather than from our implementation:
//   6883sam.cpp:166  bool mode_64k = (state & SAM_STATE_M1) == SAM_STATE_M1;
//   6883sam.cpp:167  RAM window $0000-$7FFF (TY=0) or $0000-$FEFF (TY=1)
//   6883sam.cpp:171  if (mode_64k && (state & (TY|P1)) == P1) offset |= 0x8000;
//   6883sam.cpp:206  the same test on the write path
//   6883sam.cpp:313-327  M1/M0 -> m_counter_mask (4K/16K/64K/64K), applied to the VIDEO counter only
// and the MC6883 data sheet p.16 for which address sets or clears each bit ($FFC0 + 2*bit, even = clear).
// The authority for a machine is node tools/mame-diff/run.js <profile> --memsize (lockstep with MAME).
// Run: node tests/sammem.test.js
const Emu = require('./load')();

let fail = 0;
const check = (name, cond, detail = '') => { if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name} ${detail}`); };
const hex = (v) => '$' + v.toString(16).toUpperCase().padStart(4, '0');

// A machine with no ROMs: the SAM bits are driven directly through its registers, as firmware would.
function machine(id = 'dragon64', config = {}) {
  const m = Emu.createMachine(id, config);
  m.reset(true);
  return m;
}
// set or clear one SAM bit through the CPU bus, the way firmware does ($FFC0 + 2*bit, odd = set)
const bit = (m, b, on) => m.write(0xFFC0 + 2 * b + (on ? 1 : 0), 0);
const P1 = 10, M0 = 13, M1 = 14, TY = 15;

// ---------------- the bit addresses themselves ----------------
{
  const m = machine();
  bit(m, P1, true);
  check('P1 is set at $FFD5 and reads back', m.sam.page1 === 1, hex(0xFFD5));
  bit(m, P1, false);
  check('P1 is cleared at $FFD4', m.sam.page1 === 0, hex(0xFFD4));
  bit(m, M1, true);
  check('M1 is set at $FFDD (memSize bit 1)', (m.sam.memSize & 2) !== 0, hex(0xFFDD));
  bit(m, M1, false);
  check('M1 is cleared at $FFDC', (m.sam.memSize & 2) === 0, hex(0xFFDC));
  bit(m, TY, true);
  check('TY is set at $FFDF', m.sam.mapType === 1, hex(0xFFDF));
}

// ---------------- the video counter mask is what M1/M0 drive (MAME's m_counter_mask) ----------------
{
  const m = machine();
  const mask = () => m.sam.counterMask;
  bit(m, M1, false); bit(m, M0, false);
  check('M1=0 M0=0: the video counter mask is 4K', mask() === 0x0FFF, hex(mask()));
  bit(m, M0, true);
  check('M1=0 M0=1: 16K', mask() === 0x3FFF, hex(mask()));
  bit(m, M1, true); bit(m, M0, false);
  check('M1=1 M0=0: 64K dynamic', mask() === 0xFFFF, hex(mask()));
  bit(m, M0, true);
  check('M1=1 M0=1: 64K static', mask() === 0xFFFF, hex(mask()));
}

// ---------------- the SAM state survives a snapshot ----------------
{
  const m = machine();
  bit(m, M1, true); bit(m, TY, false); bit(m, P1, true);
  m.write(0x1000, 0x22);
  const s = JSON.parse(Emu.state.toJSON(m.saveState()));
  const r = Emu.createMachine('dragon64', {});
  r.setRoms({});
  r.loadState(Emu.state.fromJSON(JSON.stringify(s)));
  check('a snapshot keeps P1 set', r.sam.page1 === 1);
  check('a snapshot keeps M1 set', (r.sam.memSize & 2) !== 0);
  check('a restored machine redirects the same way', r.read(0x1000) === 0x22);
}

// ---------------- tool writes and reads follow the map (the Claude chat's poke/peek, the welcome program, the debugger) ----------------
// Session.pokeBytes goes through Machine.poke and Session.readByte through Machine.peek; on the SAM family they must
// reach the RAM cell the CPU reaches. Project firmware in the BASIC socket sets M1 and P1, then copies $1000 to $1001
// for ever: with P1 set the CPU's $1000 is RAM $9000 (6883sam.cpp:171), so a poke to $1000 is seen by the CPU only if
// it lands there too.
{
  const src = ` ORG $8000
START   ORCC    #$50
        STA     $FFDD           ; M1: 64K mode
        STA     $FFD5           ; P1: $0000-$7FFF is RAM $8000-$FFFF
LOOP    LDA     $1000
        STA     $1001
        BRA     LOOP
        ORG     $BFFE
        FDB     START
`;
  const r = Emu.assemble(src, '6809');
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  const rom = new Uint8Array(0x4000);
  for (const seg of r.segments) rom.set(seg.data, seg.addr - 0x8000);
  const make = (id) => {
    const s = new Emu.Session();
    s.switchMachine(id);
    s.shownMachine.setRoms(id === 'dragon64' ? { basic: rom, basic64: rom } : { basic: rom }); s.shownMachine.reset(true);
    for (let f = 0; f < 3; f++) s.shownMachine.runFrame();
    return s;
  };
  const s = make('dragon64'), m = s.shownMachine;
  check('firmware set M1 and P1: $1000 is RAM $9000 to the CPU', m.sam.page1 === 1 && m.ramAddr(0x1000, m.sam.reg) === 0x9000);
  s.pokeBytes(0x1000, [0x33], m);
  for (let f = 0; f < 2; f++) m.runFrame();
  check('a poke to $1000 is what the CPU reads there (it copies it to $1001)', s.readByte(0x1001) === 0x33 && m.ram[0x9001] === 0x33, hex(s.readByte(0x1001)));
  check('...and the peek tool reads it back where it was poked', s.readByte(0x1000) === 0x33 && m.ram[0x9000] === 0x33 && m.ram[0x1000] !== 0x33);
  const rom0 = m.read(0x9000);
  s.pokeBytes(0x9000, [rom0 ^ 0xFF], m);
  check('map type 0: a poke into the ROM area changes nothing the CPU can see', m.read(0x9000) === rom0 && s.readByte(0x9000) === rom0);
  check('peek: the vectors come from the ROM, the I/O page reads $FF', s.readByte(0xBFFE) === 0x80 && s.readByte(0xFFFE) === 0x80 && s.readByte(0xFF00) === 0xFF);
  // the debugger writes through the bus, so its writes follow the same map
  s.debug;
  s.debugger.write(0x1000, [0x44]);
  for (let f = 0; f < 2; f++) m.runFrame();
  check('the debugger\'s memory write lands where the CPU reads it too', s.readByte(0x1001) === 0x44 && s.debugger.read(0x1000) === 0x44);
  // a 32K Dragon: P1 points the low half at RAM that is not fitted, so a poke there lands nowhere (as the CPU's own write)
  const d = make('dragon32'), dm = d.shownMachine, before = dm.ram.slice();
  d.pokeBytes(0x1000, [0x55], dm);
  check('32K: with P1 a poke to $1000 is lost (no RAM at $9000), as the CPU\'s write is', dm.ram.every((v, i) => v === before[i]) && d.readByte(0x1000) === 0x00);
}

// The debugger's memory view on the MC-10 must not touch the keyboard latch at $BFFF. peek() answers $BFFF
// as a keyboard with no keys down; read() would clear the cassette counter and its value would depend on the
// strobed columns. Read across $BFFF through the debugger and check the counter is untouched.
{
  const s = new Emu.Session(); s.switchMachine('mc10');
  for (let i = 0; i < 40; i++) s.advance(1000 / s.shownMachine.fps + 0.01);
  const m = s.shownMachine, dbg = s.debug;               // creates the debugger on first use
  m.casReads = 7;                                   // a nonzero counter a bus latch read would reset
  const seen = [];
  for (let a = 0xBFFC; a <= 0xC002; a++) seen.push(dbg.peek(a));
  check('mc10: the debugger can read across $BFFF', seen.length === 7, String(seen.length));
  check('mc10: and that did not clear the cassette counter', m.casReads === 7, `${m.casReads}`);
  check('mc10: $BFFF through the debugger reads as a keyboard with no keys down', dbg.peek(0xBFFF) === 0xFF,
    `$${dbg.peek(0xBFFF).toString(16)}`);
  // a bus read of $BFFF DOES clear it - which is what makes the check above meaningful, not vacuous
  m.casReads = 7; m.read(0xBFFF);
  check('mc10: a bus read of $BFFF does clear the counter (so the check above is not vacuous)', m.casReads === 0, `${m.casReads}`);
}

console.log(fail ? `${fail} FAILED` : 'all passed');
process.exitCode = fail ? 1 : 0;
