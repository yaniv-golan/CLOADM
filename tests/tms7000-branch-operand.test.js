// The TMS7000 assembler's relative branches: the target is a plain label or address ("JMP THERE", "DJNZ R0,LOOP"),
// encoded as the offset (target - the address of the next instruction); "@" is the prefix of an ADDRESS operand
// (CALL @LABEL, BR @LABEL, LDA @LABEL) and a relative jump has none, so a jump written with it is an error, not a
// silent offset of 0. (The bug: "DJNZ R0,@LOOP" encoded DA 00 00, a jump to the next instruction, with no message.)
// Every relative form in the instruction table is covered: the 15 jumps, DJNZ A/B/Rn, BTJO/BTJZ in their seven
// forms and BTJOP/BTJZP in their three. The expected offsets are computed here from the manual's rule (Section
// 6.2.5, Table 6-1: offset = target - next instruction), not read back from the assembler.
const fs = require('fs'), path = require('path');
const Emu = require('./load')();
const isa = require('../js/asm/isa7000.js');

let fail = 0;
const check = (name, cond, detail = '') => { if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name} ${detail}`); };
const hex = (a) => a.map((x) => x.toString(16).padStart(2, '0')).join(' ');
const asm = (src) => Emu.assemble(`         ORG $4000\n${src}\n`, '7000');
const bytesOf = (r) => (r.segments && r.segments.length ? [...r.segments[0].data] : []);
// n bytes at an address (RMB reserves without emitting, so a later instruction sits in a segment of its own)
const bytesAt = (r, addr, n) => { const sg = (r.segments || []).find((x) => addr >= x.addr && addr < x.addr + x.data.length); return sg ? [...sg.data.slice(addr - sg.addr, addr - sg.addr + n)] : []; };

// every relative mode in the table, with the operand text before the target and the bytes it encodes to
const OPERANDS = {
  'rel': ['', []],
  'A,rel': ['A,', []], 'B,rel': ['B,', []], 'Rn,rel': ['R5,', [5]],
  'B,A': ['B,A,', []], 'Rn,A': ['R5,A,', [5]], 'Rn,B': ['R5,B,', [5]], 'Rn,Rn': ['R5,R6,', [5, 6]],
  'imm,A': ['%$12,A,', [0x12]], 'imm,B': ['%$12,B,', [0x12]], 'imm,Rn': ['%$12,R7,', [0x12, 7]],
  'A,Pn': ['A,P5,', [5]], 'B,Pn': ['B,P5,', [5]], 'imm,Pn': ['%$12,P5,', [0x12, 5]],
};
const FORMS = [];
for (const o of isa.OPS) for (const m of o.modes) if (m.rel || /rel/.test(m.form)) FORMS.push({ mn: o.mn, code: m.op, form: m.form, bytes: m.bytes });
check('the table has 38 relative forms: 15 jumps (and their aliases), 3 DJNZ, 14 BTJO/BTJZ, 6 BTJOP/BTJZP', FORMS.length === 38, String(FORMS.length));
check('every relative form has an operand template here', FORMS.every((f) => OPERANDS[f.form]), FORMS.filter((f) => !OPERANDS[f.form]).map((f) => f.form).join());

// ---- the label form encodes the offset, forward and backward ----
let wrongBack = 0, wrongFwd = 0, rejected = 0, accepted = [];
for (const f of FORMS) {
  const [pre, mid] = OPERANDS[f.form];
  // backward: the target is the first instruction, this one sits 0x10 on (so its next address is 0x4010 + bytes)
  const back = asm(`BACK    NOP\n         RMB 15\n         ${f.mn} ${pre}BACK`);
  const at = 0x4010, offBack = (0x4000 - (at + f.bytes)) & 0xFF;
  const gotBack = bytesAt(back, at, f.bytes);
  if (!back.ok || hex(gotBack) !== hex([f.code, ...mid, offBack])) { wrongBack++; console.log(`  back ${f.mn} ${f.form}: ${back.ok} got ${hex(gotBack)} want ${hex([f.code, ...mid, offBack])}`); }
  // forward: the target is 0x20 on from the instruction's own address
  const fwd = asm(`         ${f.mn} ${pre}FWD\n         RMB ${0x20 - f.bytes}\nFWD     NOP`);
  const offFwd = (0x4020 - (0x4000 + f.bytes)) & 0xFF;
  const gotFwd = bytesAt(fwd, 0x4000, f.bytes);
  if (!fwd.ok || hex(gotFwd) !== hex([f.code, ...mid, offFwd])) { wrongFwd++; console.log(`  fwd ${f.mn} ${f.form}: ${fwd.ok} got ${hex(gotFwd)} want ${hex([f.code, ...mid, offFwd])}`); }
  // "@" before the target: refused, with a message that names the @, and nothing assembled
  const at1 = asm(`L1      ${f.mn} ${pre}@L1`);
  if (!at1.ok && at1.errors.length === 1 && /not with @/.test(at1.errors[0].message) && at1.errors[0].line === 2) rejected++; else accepted.push(`${f.mn} ${f.form}`);
}
check('every relative form encodes a backward label as the offset (target - next instruction)', wrongBack === 0, `${wrongBack} wrong of ${FORMS.length}`);
check('every relative form encodes a forward label as the offset', wrongFwd === 0, `${wrongFwd} wrong of ${FORMS.length}`);
check('every relative form refuses an @ before its target, naming it, on the line it is on (none encodes offset 0)', rejected === FORMS.length, accepted.join(', '));

// ---- the cases the bug report named, with the bytes written out by hand ----
{
  const g = asm('PLOOP   DJNZ    R0,PLOOP');
  check('DJNZ R0,PLOOP on itself: DA 00 FD (target - next = -3)', g.ok && hex(bytesOf(g)) === 'da 00 fd', hex(bytesOf(g)));
  const b = asm('PLOOP   DJNZ    R0,@PLOOP');
  check('DJNZ R0,@PLOOP: refused (it used to be DA 00 00, falling through)', !b.ok && /not with @/.test(b.errors[0].message) && bytesOf(b).length === 0, JSON.stringify(b.errors));
  const j = asm('HERE    JMP     HERE');
  check('JMP HERE: E0 FE (a jump to itself, -2)', j.ok && hex(bytesOf(j)) === 'e0 fe', hex(bytesOf(j)));
  const jb = asm('HERE    JMP     @HERE');
  check('JMP @HERE: refused', !jb.ok && /not with @/.test(jb.errors[0].message));
  const e = asm('HERE    JNZ     @HERE+2');
  check('an @ before an expression is refused too (JNZ @HERE+2)', !e.ok && /"HERE\+2"/.test(e.errors[0].message), JSON.stringify(e.errors));
  const sp = asm('HERE    JMP     @ HERE');
  check('... and an @ with a space after it', !sp.ok && /"HERE"/.test(sp.errors[0].message), JSON.stringify(sp.errors));
  // the address operands keep their @: CALL @LABEL and BR @LABEL are unchanged
  const c = asm('TARGET  NOP\n         CALL    @TARGET\n         BR      @TARGET');
  check('CALL @TARGET and BR @TARGET still assemble (their @ is the address mode): 8E 40 00 8C 40 00', c.ok && hex(bytesOf(c).slice(1)) === '8e 40 00 8c 40 00', hex(bytesOf(c)));
}

// ---- the diagnostic firmware that wrote it: its pause loop now jumps ----
{
  const src = fs.readFileSync(path.join(__dirname, '../tools/mame-diff/ssc/ssc-tone.asm'), 'utf8');
  check('tools/mame-diff/ssc/ssc-tone.asm has no @ on a relative jump', !/^\s*(\w+\s+)?(DJNZ|J[A-Z]+|BTJ[OZ]P?)\s[^;]*@/m.test(src.replace(/\*.*$/gm, '')));
  const r = Emu.assemble(src, '7000');
  const at = r.symbols.get('PLOOP');
  const img = r.segments.find((s) => at >= s.addr && at < s.addr + s.data.length);
  const got = img ? [...img.data.slice(at - img.addr, at - img.addr + 6)] : [];
  check('... it assembles, and PLOOP is DJNZ R0,PLOOP (DA 00 FD) then DJNZ R1,PLOOP (DA 01 FA): the delay loops', r.ok && hex(got) === 'da 00 fd da 01 fa', `${r.ok} ${hex(got)} ${JSON.stringify(r.errors)}`);
}

console.log(fail ? `${fail} FAILED` : 'all passed');
process.exitCode = fail ? 1 : 0;
