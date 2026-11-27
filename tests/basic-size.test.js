// Run: node tests/basic-size.test.js
//
// tools/basic-size.js, which ranks the clean-room BASIC's routines and gives its budget (docs/clean-room-basic.md,
// section 2): a routine ends at the next label or at its module's end, a label that emits no bytes (on a line of its
// own, or RMB 0) still starts one, an EQU does not; and the budget counts as free only the gap between the code's
// end and the vectors, with $8000-$80FF reserved. Checked on hand-built listings whose sizes are counted by hand,
// and on the real build against a count made from the listing line by line.
const { routines, budget } = require('../tools/basic-size.js');
const { buildBasic } = require('../tools/build-basic.js');
let n = 0, fail = 0;
const check = (name, cond, detail = '') => { n++; if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name} ${detail}`); };
const size = (rs, name) => (rs.find((r) => r.name === name) || {}).size;

// a hand-built listing: module a.inc (CODE 3 bytes + 2 bytes, then LAST 1 byte), then b.inc (a bare label TABLE
// over 4 bytes of data, an EQU between, then MARK RMB 0 and 2 bytes; END at the same address as MARK's last + 1)
const L = (file, addr, src, bytes = []) => ({ file, addr, src, bytes });
const hand = [
  L('a.inc', 0x8100, 'CODE    LDX     #1', [0x8E, 0, 1]),
  L('a.inc', 0x8103, '        BRA     CODE', [0x20, 0xFB]),
  L('a.inc', 0x8105, '* a comment'),
  L('a.inc', 0x8105, 'LAST    RTS', [0x39]),
  L('b.inc', 0x0010, 'NAMED   EQU     $10'),
  L('b.inc', 0x8106, 'TABLE'),
  L('b.inc', 0x8106, '        FCB     1,2', [1, 2]),
  L('b.inc', 0x8106, 'ALIAS   EQU     TABLE'),
  L('b.inc', 0x8108, '        FCB     3,4', [3, 4]),
  L('b.inc', 0x810A, 'MARK    RMB     0'),
  L('b.inc', 0x810A, '        FDB     TABLE', [0x81, 0x06]),
  L(null, 0x810C, 'ROMEND  RMB     0'),
];
const hr = routines(hand);
check('a routine runs to the next label', size(hr, 'CODE') === 5, `CODE ${size(hr, 'CODE')}`);
check('a module\'s last routine ends with its module (not the next module\'s tables)', size(hr, 'LAST') === 1, `LAST ${size(hr, 'LAST')}`);
check('a label on a line of its own starts a routine', size(hr, 'TABLE') === 4, `TABLE ${size(hr, 'TABLE')}`);
check('an RMB 0 label starts a routine', size(hr, 'MARK') === 2, `MARK ${size(hr, 'MARK')}`);
check('an EQU is not a routine', !hr.some((r) => r.name === 'NAMED' || r.name === 'ALIAS'), hr.map((r) => r.name).join(' '));
check('every byte is counted once', hr.reduce((s, r) => s + r.size, 0) === 12, String(hr.reduce((s, r) => s + r.size, 0)));

// the two rules each hold on their own: in one module the bare label TABLE still ends LAST; across modules, with no
// label at TABLE, the module's end does (without either, LAST took TABLE's 4, as PLD5 took tokens.inc's 611)
const noModule = hand.map((l) => ({ ...l, file: 'one.inc' }));
const noBare = hand.filter((l) => l.src !== 'TABLE');
check('one module: the bare label ends LAST', size(routines(noModule), 'LAST') === 1, String(size(routines(noModule), 'LAST')));
check('no bare label: the module\'s end ends LAST', size(routines(noBare), 'LAST') === 1, String(size(routines(noBare), 'LAST')));
check('neither: LAST runs on (what the rules prevent)', size(routines(noModule.filter((l) => l.src !== 'TABLE')), 'LAST') === 5);

// the real build
const b = buildBasic();
const rs = routines(b.listing);
const pl = b.listing.filter((l) => l.file === 'play.inc');
const at = pl.findIndex((l) => /^PLD5\b/.test(l.src));
const byHand = pl.slice(at).reduce((s, l) => s + (l.bytes ? l.bytes.length : 0), 0);
check('PLD5, play.inc\'s last routine, holds play.inc\'s last bytes only', at >= 0 && size(rs, 'PLD5') === byHand && byHand < 16, `${size(rs, 'PLD5')} (by the listing ${byHand})`);
for (const t of ['KWSTMT', 'KWFUNC', 'STMTDS', 'FUNCDS']) check(`tokens.inc's ${t} is a routine of its own`, rs.some((r) => r.name === t && r.file === 'tokens.inc' && r.size > 0));
// no routine crosses a module: its bytes are its module's lines from its label to the next label
const inRom = b.listing.filter((l) => l.bytes && l.bytes.length && l.addr >= 0x8000 && l.addr < 0xC000);
const romBytes = inRom.reduce((s, l) => s + l.bytes.length, 0);
const counted = rs.reduce((s, r) => s + r.size, 0);
check('the routines count no byte twice and miss none but the vectors\' and unlabelled lines', counted <= romBytes && romBytes - counted <= 14 + 16, `${counted} of ${romBytes}`);

const g = budget(b);
check('the budget: occupied is the bytes the build lays down', g.occupied === b.used && g.occupied === romBytes, `${g.occupied}`);
check('the budget: $8000-$80FF reserved, never counted free', g.reserved === 256);
check('the budget: free is the gap from the code\'s end to the vectors', g.free === 0xBFF0 - b.symbols.get('ROMEND') && g.free >= 0, `${g.free}`);
let hole = 0;
for (let a = 0x8000; a < 0x8100; a++) if (b.rom[a - 0x8000] !== 0xFF) hole++;
check('nothing is placed in the reserved $8000-$80FF', hole === 0);

console.log(`\n${n - fail}/${n} passed`);
process.exitCode = fail ? 1 : 0;
