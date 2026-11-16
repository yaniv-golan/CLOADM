// Run: node tests/disasm.test.js
//
// The 6809 and 6803 disassemblers, proved against the instruction set as documented, not against the
// disassembler's own table:
//  * the maps below are written out from Motorola's instruction set summaries (MC6809E data sheet, and the
//    MC6801/MC6803 data sheet for the 6803): every documented opcode decodes to the documented mnemonic,
//    addressing mode and length;
//  * every byte a map leaves out is reported as data (FCB) of exactly the length the CPU core consumes for
//    it, so a disassembly always keeps step with the CPU;
//  * for every documented opcode the assembler emits that very opcode for its mnemonic and mode, and
//    assembling, disassembling and reassembling gives the same bytes;
//  * the 6809 opcode postbyte (indexed addressing) is checked against the data sheet's postbyte table;
//  * symbols from the assembler appear in the operand and are reassembled to the same bytes.
const Emu = require('./load')();

let fail = 0, n = 0;
const check = (name, cond, detail = '') => { n++; if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } };
const hex2 = (v) => '$' + v.toString(16).toUpperCase().padStart(2, '0');
const hex4 = (v) => '$' + v.toString(16).toUpperCase().padStart(4, '0');

// ---- the documented instruction sets (opcode byte -> mnemonic and mode), from Motorola's instruction set
// summaries (MC6809E data sheet; MC6801/MC6803 data sheet). Bytes a map leaves out are not instructions:
// they are shown as data, and must consume exactly the bytes the CPU core consumes for them (the test
// measures that by running the core, not by trusting a table here).
// Modes: inh no operand; imm8/imm16 immediate; dir direct; idx indexed; ext extended; rel8/rel16 relative;
// cc an 8-bit condition-code mask; post a TFR/EXG register pair; stack a PSHS/PULS/PSHU/PULU register list.
function parseMap(text) {
  const map = new Map();
  for (const line of text.trim().split('\n')) {
    const [codeHex, name, mode] = line.trim().split(/\s+/);
    if (name.startsWith('-')) continue;   // not an instruction on this part
    map.set(parseInt(codeHex, 16), { mn: name, mode });
  }
  return map;
}

const PAGE1_6809 = parseMap(`
00 NEG dir
03 COM dir
04 LSR dir
06 ROR dir
07 ASR dir
08 ASL dir
09 ROL dir
0A DEC dir
0C INC dir
0D TST dir
0E JMP dir
0F CLR dir
12 NOP inh
13 SYNC inh
16 LBRA rel16
17 LBSR rel16
19 DAA inh
1A ORCC cc
1C ANDCC cc
1D SEX inh
1E EXG post
1F TFR post
20 BRA rel8
21 BRN rel8
22 BHI rel8
23 BLS rel8
24 BCC rel8
25 BCS rel8
26 BNE rel8
27 BEQ rel8
28 BVC rel8
29 BVS rel8
2A BPL rel8
2B BMI rel8
2C BGE rel8
2D BLT rel8
2E BGT rel8
2F BLE rel8
30 LEAX idx
31 LEAY idx
32 LEAS idx
33 LEAU idx
34 PSHS stack
35 PULS stack
36 PSHU stack
37 PULU stack
39 RTS inh
3A ABX inh
3B RTI inh
3C CWAI cc
3D MUL inh
3F SWI inh
40 NEGA inh
43 COMA inh
44 LSRA inh
46 RORA inh
47 ASRA inh
48 ASLA inh
49 ROLA inh
4A DECA inh
4C INCA inh
4D TSTA inh
4F CLRA inh
50 NEGB inh
53 COMB inh
54 LSRB inh
56 RORB inh
57 ASRB inh
58 ASLB inh
59 ROLB inh
5A DECB inh
5C INCB inh
5D TSTB inh
5F CLRB inh
60 NEG idx
63 COM idx
64 LSR idx
66 ROR idx
67 ASR idx
68 ASL idx
69 ROL idx
6A DEC idx
6C INC idx
6D TST idx
6E JMP idx
6F CLR idx
70 NEG ext
73 COM ext
74 LSR ext
76 ROR ext
77 ASR ext
78 ASL ext
79 ROL ext
7A DEC ext
7C INC ext
7D TST ext
7E JMP ext
7F CLR ext
80 SUBA imm8
81 CMPA imm8
82 SBCA imm8
83 SUBD imm16
84 ANDA imm8
85 BITA imm8
86 LDA imm8
87 -2
88 EORA imm8
89 ADCA imm8
8A ORA imm8
8B ADDA imm8
8C CMPX imm16
8D BSR rel8
8E LDX imm16
8F -2
90 SUBA dir
91 CMPA dir
92 SBCA dir
93 SUBD dir
94 ANDA dir
95 BITA dir
96 LDA dir
97 STA dir
98 EORA dir
99 ADCA dir
9A ORA dir
9B ADDA dir
9C CMPX dir
9D JSR dir
9E LDX dir
9F STX dir
A0 SUBA idx
A1 CMPA idx
A2 SBCA idx
A3 SUBD idx
A4 ANDA idx
A5 BITA idx
A6 LDA idx
A7 STA idx
A8 EORA idx
A9 ADCA idx
AA ORA idx
AB ADDA idx
AC CMPX idx
AD JSR idx
AE LDX idx
AF STX idx
B0 SUBA ext
B1 CMPA ext
B2 SBCA ext
B3 SUBD ext
B4 ANDA ext
B5 BITA ext
B6 LDA ext
B7 STA ext
B8 EORA ext
B9 ADCA ext
BA ORA ext
BB ADDA ext
BC CMPX ext
BD JSR ext
BE LDX ext
BF STX ext
C0 SUBB imm8
C1 CMPB imm8
C2 SBCB imm8
C3 ADDD imm16
C4 ANDB imm8
C5 BITB imm8
C6 LDB imm8
C7 -2
C8 EORB imm8
C9 ADCB imm8
CA ORB imm8
CB ADDB imm8
CC LDD imm16
CD -2
CE LDU imm16
CF -2
D0 SUBB dir
D1 CMPB dir
D2 SBCB dir
D3 ADDD dir
D4 ANDB dir
D5 BITB dir
D6 LDB dir
D7 STB dir
D8 EORB dir
D9 ADCB dir
DA ORB dir
DB ADDB dir
DC LDD dir
DD STD dir
DE LDU dir
DF STU dir
E0 SUBB idx
E1 CMPB idx
E2 SBCB idx
E3 ADDD idx
E4 ANDB idx
E5 BITB idx
E6 LDB idx
E7 STB idx
E8 EORB idx
E9 ADCB idx
EA ORB idx
EB ADDB idx
EC LDD idx
ED STD idx
EE LDU idx
EF STU idx
F0 SUBB ext
F1 CMPB ext
F2 SBCB ext
F3 ADDD ext
F4 ANDB ext
F5 BITB ext
F6 LDB ext
F7 STB ext
F8 EORB ext
F9 ADCB ext
FA ORB ext
FB ADDB ext
FC LDD ext
FD STD ext
FE LDU ext
FF STU ext
`);

const PAGE2_6809 = parseMap(`
20 LBRA rel16
21 LBRN rel16
22 LBHI rel16
23 LBLS rel16
24 LBCC rel16
25 LBCS rel16
26 LBNE rel16
27 LBEQ rel16
28 LBVC rel16
29 LBVS rel16
2A LBPL rel16
2B LBMI rel16
2C LBGE rel16
2D LBLT rel16
2E LBGT rel16
2F LBLE rel16
3F SWI2 inh
83 CMPD imm16
8C CMPY imm16
8E LDY imm16
8F -0
93 CMPD dir
9C CMPY dir
9E LDY dir
9F STY dir
A3 CMPD idx
AC CMPY idx
AE LDY idx
AF STY idx
B3 CMPD ext
BC CMPY ext
BE LDY ext
BF STY ext
CE LDS imm16
CF -0
DE LDS dir
DF STS dir
EE LDS idx
EF STS idx
FE LDS ext
FF STS ext
`);

const PAGE3_6809 = parseMap(`
3F SWI3 inh
83 CMPU imm16
8C CMPS imm16
93 CMPU dir
9C CMPS dir
A3 CMPU idx
AC CMPS idx
B3 CMPU ext
BC CMPS ext
`);

const MAP6803 = parseMap(`
00 -1
01 NOP inh
02 -1
03 -1
04 LSRD inh
05 ASLD inh
06 TAP inh
07 TPA inh
08 INX inh
09 DEX inh
0A CLV inh
0B SEV inh
0C CLC inh
0D SEC inh
0E CLI inh
0F SEI inh
10 SBA inh
11 CBA inh
12 -1
13 -1
14 -1
15 -1
16 TAB inh
17 TBA inh
18 -1
19 DAA inh
1A -1
1B ABA inh
1C -1
1D -1
1E -1
1F -1
20 BRA rel8
21 BRN rel8
22 BHI rel8
23 BLS rel8
24 BCC rel8
25 BCS rel8
26 BNE rel8
27 BEQ rel8
28 BVC rel8
29 BVS rel8
2A BPL rel8
2B BMI rel8
2C BGE rel8
2D BLT rel8
2E BGT rel8
2F BLE rel8
30 TSX inh
31 INS inh
32 PULA inh
33 PULB inh
34 DES inh
35 TXS inh
36 PSHA inh
37 PSHB inh
38 PULX inh
39 RTS inh
3A ABX inh
3B RTI inh
3C PSHX inh
3D MUL inh
3E WAI inh
3F SWI inh
40 NEGA inh
41 -1
42 -1
43 COMA inh
44 LSRA inh
45 -1
46 RORA inh
47 ASRA inh
48 ASLA inh
49 ROLA inh
4A DECA inh
4B -1
4C INCA inh
4D TSTA inh
4E -1
4F CLRA inh
50 NEGB inh
51 -1
52 -1
53 COMB inh
54 LSRB inh
55 -1
56 RORB inh
57 ASRB inh
58 ASLB inh
59 ROLB inh
5A DECB inh
5B -1
5C INCB inh
5D TSTB inh
5E -1
5F CLRB inh
60 NEG idx
61 -1
62 -1
63 COM idx
64 LSR idx
65 -1
66 ROR idx
67 ASR idx
68 ASL idx
69 ROL idx
6A DEC idx
6B -1
6C INC idx
6D TST idx
6E JMP idx
6F CLR idx
70 NEG ext
71 -1
72 -1
73 COM ext
74 LSR ext
75 -1
76 ROR ext
77 ASR ext
78 ASL ext
79 ROL ext
7A DEC ext
7B -1
7C INC ext
7D TST ext
7E JMP ext
7F CLR ext
80 SUBA imm8
81 CMPA imm8
82 SBCA imm8
83 SUBD imm16
84 ANDA imm8
85 BITA imm8
86 LDAA imm8
87 -2
88 EORA imm8
89 ADCA imm8
8A ORAA imm8
8B ADDA imm8
8C CPX imm16
8D BSR rel8
8E LDS imm16
8F -3
90 SUBA dir
91 CMPA dir
92 SBCA dir
93 SUBD dir
94 ANDA dir
95 BITA dir
96 LDAA dir
97 STAA dir
98 EORA dir
99 ADCA dir
9A ORAA dir
9B ADDA dir
9C CPX dir
9D JSR dir
9E LDS dir
9F STS dir
A0 SUBA idx
A1 CMPA idx
A2 SBCA idx
A3 SUBD idx
A4 ANDA idx
A5 BITA idx
A6 LDAA idx
A7 STAA idx
A8 EORA idx
A9 ADCA idx
AA ORAA idx
AB ADDA idx
AC CPX idx
AD JSR idx
AE LDS idx
AF STS idx
B0 SUBA ext
B1 CMPA ext
B2 SBCA ext
B3 SUBD ext
B4 ANDA ext
B5 BITA ext
B6 LDAA ext
B7 STAA ext
B8 EORA ext
B9 ADCA ext
BA ORAA ext
BB ADDA ext
BC CPX ext
BD JSR ext
BE LDS ext
BF STS ext
C0 SUBB imm8
C1 CMPB imm8
C2 SBCB imm8
C3 ADDD imm16
C4 ANDB imm8
C5 BITB imm8
C6 LDAB imm8
C7 -2
C8 EORB imm8
C9 ADCB imm8
CA ORAB imm8
CB ADDB imm8
CC LDD imm16
CD -3
CE LDX imm16
CF -3
D0 SUBB dir
D1 CMPB dir
D2 SBCB dir
D3 ADDD dir
D4 ANDB dir
D5 BITB dir
D6 LDAB dir
D7 STAB dir
D8 EORB dir
D9 ADCB dir
DA ORAB dir
DB ADDB dir
DC LDD dir
DD STD dir
DE LDX dir
DF STX dir
E0 SUBB idx
E1 CMPB idx
E2 SBCB idx
E3 ADDD idx
E4 ANDB idx
E5 BITB idx
E6 LDAB idx
E7 STAB idx
E8 EORB idx
E9 ADCB idx
EA ORAB idx
EB ADDB idx
EC LDD idx
ED STD idx
EE LDX idx
EF STX idx
F0 SUBB ext
F1 CMPB ext
F2 SBCB ext
F3 ADDD ext
F4 ANDB ext
F5 BITB ext
F6 LDAB ext
F7 STAB ext
F8 EORB ext
F9 ADCB ext
FA ORAB ext
FB ADDB ext
FC LDD ext
FD STD ext
FE LDX ext
FF STX ext
`);

// ---- the 6309 instruction set ----------------------------------------------------------------
// Written out from the HD6309 hardware descriptions: the HD63B09EP Technical Reference Guide's opcode
// table (printed pp. 11-18), Atkinson's opcode map (printed p. 152) and its per-instruction pages, and
// the 6809 modes the two parts share (./dis6809.js). The opcode is the *whole* encoding: page 2 entries
// carry the 10 prefix, page 3 the 11 prefix, so one map covers the three pages.
//
// Where the three sources disagree the hardware description wins, and the row carries a note here:
//   * 1056 RORW is present (Atkinson printed p. 118); the guide marks it with a '?', which the third
//     source settles.
//   * 1050 NEGW, 1057 ASRW and 1058 ASLW are absent because the part has no such instructions
//     (Atkinson printed pp. 16, 18, 101 and the blank cells in its map, printed p. 152). Our core and
//     MAME execute them, which is a tracked core deviation in behaviour, not in length: both read the
//     same two bytes, so the disassembly-vs-core comparison below covers them like any other opcode and
//     skips nothing (see the note above section 2, and README "Verification against MAME").
//   * 1020 is absent (Atkinson printed p. 153, note 4: a 6809 LBRA alias, illegal on a 6309).
//   * The guide's printed lengths for TIM direct (0B), LDMD (113D) and DIVD immediate (118D) are wrong;
//     the modes here follow its own structure and Atkinson (printed pp. 58, 92).
// Modes are the engine's own (see ./disassembler.js): imm8dir/imm8idx/imm8ext are AIM/OIM/EIM/TIM's
// mask byte then an operand, bitmem is the bit operations' postbyte, tfm is TFM's postbyte.
const PAGE1_6309 = parseMap(`
00 NEG dir
01 OIM imm8dir
02 AIM imm8dir
03 COM dir
04 LSR dir
05 EIM imm8dir
06 ROR dir
07 ASR dir
08 ASL dir
09 ROL dir
0A DEC dir
0B TIM imm8dir
0C INC dir
0D TST dir
0E JMP dir
0F CLR dir
12 NOP inh
13 SYNC inh
14 SEXW inh
16 LBRA rel16
17 LBSR rel16
19 DAA inh
1A ORCC cc
1C ANDCC cc
1D SEX inh
1E EXG post
1F TFR post
20 BRA rel8
21 BRN rel8
22 BHI rel8
23 BLS rel8
24 BCC rel8
25 BCS rel8
26 BNE rel8
27 BEQ rel8
28 BVC rel8
29 BVS rel8
2A BPL rel8
2B BMI rel8
2C BGE rel8
2D BLT rel8
2E BGT rel8
2F BLE rel8
30 LEAX idx
31 LEAY idx
32 LEAS idx
33 LEAU idx
34 PSHS stack
35 PULS stack
36 PSHU stack
37 PULU stack
39 RTS inh
3A ABX inh
3B RTI inh
3C CWAI cc
3D MUL inh
3F SWI inh
40 NEGA inh
43 COMA inh
44 LSRA inh
46 RORA inh
47 ASRA inh
48 ASLA inh
49 ROLA inh
4A DECA inh
4C INCA inh
4D TSTA inh
4F CLRA inh
50 NEGB inh
53 COMB inh
54 LSRB inh
56 RORB inh
57 ASRB inh
58 ASLB inh
59 ROLB inh
5A DECB inh
5C INCB inh
5D TSTB inh
5F CLRB inh
60 NEG idx
61 OIM imm8idx
62 AIM imm8idx
63 COM idx
64 LSR idx
65 EIM imm8idx
66 ROR idx
67 ASR idx
68 ASL idx
69 ROL idx
6A DEC idx
6B TIM imm8idx
6C INC idx
6D TST idx
6E JMP idx
6F CLR idx
70 NEG ext
71 OIM imm8ext
72 AIM imm8ext
73 COM ext
74 LSR ext
75 EIM imm8ext
76 ROR ext
77 ASR ext
78 ASL ext
79 ROL ext
7A DEC ext
7B TIM imm8ext
7C INC ext
7D TST ext
7E JMP ext
7F CLR ext
80 SUBA imm8
81 CMPA imm8
82 SBCA imm8
83 SUBD imm16
84 ANDA imm8
85 BITA imm8
86 LDA imm8
88 EORA imm8
89 ADCA imm8
8A ORA imm8
8B ADDA imm8
8C CMPX imm16
8D BSR rel8
8E LDX imm16
90 SUBA dir
91 CMPA dir
92 SBCA dir
93 SUBD dir
94 ANDA dir
95 BITA dir
96 LDA dir
97 STA dir
98 EORA dir
99 ADCA dir
9A ORA dir
9B ADDA dir
9C CMPX dir
9D JSR dir
9E LDX dir
9F STX dir
A0 SUBA idx
A1 CMPA idx
A2 SBCA idx
A3 SUBD idx
A4 ANDA idx
A5 BITA idx
A6 LDA idx
A7 STA idx
A8 EORA idx
A9 ADCA idx
AA ORA idx
AB ADDA idx
AC CMPX idx
AD JSR idx
AE LDX idx
AF STX idx
B0 SUBA ext
B1 CMPA ext
B2 SBCA ext
B3 SUBD ext
B4 ANDA ext
B5 BITA ext
B6 LDA ext
B7 STA ext
B8 EORA ext
B9 ADCA ext
BA ORA ext
BB ADDA ext
BC CMPX ext
BD JSR ext
BE LDX ext
BF STX ext
C0 SUBB imm8
C1 CMPB imm8
C2 SBCB imm8
C3 ADDD imm16
C4 ANDB imm8
C5 BITB imm8
C6 LDB imm8
C8 EORB imm8
C9 ADCB imm8
CA ORB imm8
CB ADDB imm8
CC LDD imm16
CD LDQ imm32
CE LDU imm16
D0 SUBB dir
D1 CMPB dir
D2 SBCB dir
D3 ADDD dir
D4 ANDB dir
D5 BITB dir
D6 LDB dir
D7 STB dir
D8 EORB dir
D9 ADCB dir
DA ORB dir
DB ADDB dir
DC LDD dir
DD STD dir
DE LDU dir
DF STU dir
E0 SUBB idx
E1 CMPB idx
E2 SBCB idx
E3 ADDD idx
E4 ANDB idx
E5 BITB idx
E6 LDB idx
E7 STB idx
E8 EORB idx
E9 ADCB idx
EA ORB idx
EB ADDB idx
EC LDD idx
ED STD idx
EE LDU idx
EF STU idx
F0 SUBB ext
F1 CMPB ext
F2 SBCB ext
F3 ADDD ext
F4 ANDB ext
F5 BITB ext
F6 LDB ext
F7 STB ext
F8 EORB ext
F9 ADCB ext
FA ORB ext
FB ADDB ext
FC LDD ext
FD STD ext
FE LDU ext
FF STU ext
`);
const PAGE2_6309 = parseMap(`
21 LBRN rel16
22 LBHI rel16
23 LBLS rel16
24 LBCC rel16
25 LBCS rel16
26 LBNE rel16
27 LBEQ rel16
28 LBVC rel16
29 LBVS rel16
2A LBPL rel16
2B LBMI rel16
2C LBGE rel16
2D LBLT rel16
2E LBGT rel16
2F LBLE rel16
30 ADDR post
31 ADCR post
32 SUBR post
33 SBCR post
34 ANDR post
35 ORR post
36 EORR post
37 CMPR post
38 PSHSW inh
39 PULSW inh
3A PSHUW inh
3B PULUW inh
3F SWI2 inh
40 NEGD inh
43 COMD inh
44 LSRD inh
46 RORD inh
47 ASRD inh
48 ASLD inh
49 ROLD inh
4A DECD inh
4C INCD inh
4D TSTD inh
4F CLRD inh
53 COMW inh
54 LSRW inh
56 RORW inh
59 ROLW inh
5A DECW inh
5C INCW inh
5D TSTW inh
5F CLRW inh
80 SUBW imm16
81 CMPW imm16
82 SBCD imm16
83 CMPD imm16
84 ANDD imm16
85 BITD imm16
86 LDW imm16
88 EORD imm16
89 ADCD imm16
8A ORD imm16
8B ADDW imm16
8C CMPY imm16
8E LDY imm16
90 SUBW dir
91 CMPW dir
92 SBCD dir
93 CMPD dir
94 ANDD dir
95 BITD dir
96 LDW dir
97 STW dir
98 EORD dir
99 ADCD dir
9A ORD dir
9B ADDW dir
9C CMPY dir
9E LDY dir
9F STY dir
A0 SUBW idx
A1 CMPW idx
A2 SBCD idx
A3 CMPD idx
A4 ANDD idx
A5 BITD idx
A6 LDW idx
A7 STW idx
A8 EORD idx
A9 ADCD idx
AA ORD idx
AB ADDW idx
AC CMPY idx
AE LDY idx
AF STY idx
B0 SUBW ext
B1 CMPW ext
B2 SBCD ext
B3 CMPD ext
B4 ANDD ext
B5 BITD ext
B6 LDW ext
B7 STW ext
B8 EORD ext
B9 ADCD ext
BA ORD ext
BB ADDW ext
BC CMPY ext
BE LDY ext
BF STY ext
CE LDS imm16
DC LDQ dir
DD STQ dir
DE LDS dir
DF STS dir
EC LDQ idx
ED STQ idx
EE LDS idx
EF STS idx
FC LDQ ext
FD STQ ext
FE LDS ext
FF STS ext
`);
const PAGE3_6309 = parseMap(`
30 BAND bitmem
31 BIAND bitmem
32 BOR bitmem
33 BIOR bitmem
34 BEOR bitmem
35 BIEOR bitmem
36 LDBT bitmem
37 STBT bitmem
38 TFM tfm
39 TFM tfm
3A TFM tfm
3B TFM tfm
3C BITMD imm8
3D LDMD imm8
3F SWI3 inh
43 COME inh
4A DECE inh
4C INCE inh
4D TSTE inh
4F CLRE inh
53 COMF inh
5A DECF inh
5C INCF inh
5D TSTF inh
5F CLRF inh
80 SUBE imm8
81 CMPE imm8
83 CMPU imm16
86 LDE imm8
8B ADDE imm8
8C CMPS imm16
8D DIVD imm8
8E DIVQ imm16
8F MULD imm16
90 SUBE dir
91 CMPE dir
93 CMPU dir
96 LDE dir
97 STE dir
9B ADDE dir
9C CMPS dir
9D DIVD dir
9E DIVQ dir
9F MULD dir
A0 SUBE idx
A1 CMPE idx
A3 CMPU idx
A6 LDE idx
A7 STE idx
AB ADDE idx
AC CMPS idx
AD DIVD idx
AE DIVQ idx
AF MULD idx
B0 SUBE ext
B1 CMPE ext
B3 CMPU ext
B6 LDE ext
B7 STE ext
BB ADDE ext
BC CMPS ext
BD DIVD ext
BE DIVQ ext
BF MULD ext
C0 SUBF imm8
C1 CMPF imm8
C6 LDF imm8
CB ADDF imm8
D0 SUBF dir
D1 CMPF dir
D6 LDF dir
D7 STF dir
DB ADDF dir
E0 SUBF idx
E1 CMPF idx
E6 LDF idx
E7 STF idx
EB ADDF idx
F0 SUBF ext
F1 CMPF ext
F6 LDF ext
F7 STF ext
FB ADDF ext
`);

const CPUS = [
  { cpu: '6809', pages: [PAGE1_6809, PAGE2_6809, PAGE3_6809] },
  { cpu: '6803', pages: [MAP6803] },
  { cpu: '6309', pages: [PAGE1_6309, PAGE2_6309, PAGE3_6309] },
];
// expected instruction length for a mode, at its minimum (indexed adds the postbyte's own operand bytes,
// which have their own tests below; both parts' shortest indexed form is the opcode and one offset byte)
const MODE_SIZE = { inh: 1, cc: 2, imm8: 2, imm16: 3, dir: 2, idx: 2, ext: 3, rel8: 2, rel16: 3, post: 2, stack: 2 };
// The 6309 adds modes of its own, and one wider immediate. Each length below is structural - the opcode
// and the operand bytes the mode is defined to carry - not a number copied from a table. Like the 6809's
// entries, they exclude the $10/$11 page prefix, which the test adds separately.
//   imm32    LDQ's four-byte immediate                                   5 bytes
//   imm8dir  AIM/OIM/EIM/TIM: a mask byte, then a direct address          3 bytes
//   imm8ext  the same with a 16-bit address                               4 bytes
//   imm8idx  the same, indexed: mask, postbyte, the postbyte's operand    3+ bytes
//   bitmem   BAND..STBT: a postbyte, then one direct address             3 bytes
//   tfm      TFM: one postbyte                                           2 bytes
// Indexed forms carry the postbyte's own operand bytes, so only their minimum is fixed here.
const MODE_SIZE_6309 = { ...MODE_SIZE, imm32: 5, imm8dir: 3, imm8idx: 3, imm8ext: 4, bitmem: 3, tfm: 2 };
const MODE_SIZE_FOR = { '6809': MODE_SIZE, '6803': MODE_SIZE, '6309': MODE_SIZE_6309 };

// The bytes the CPU core consumes for the instruction at $1000, measured by running the core against a bus
// that records every read, and looking at where the program counter lands. A normal instruction reads its
// own bytes, so the leading run of consecutive PC addresses is its length. A few undocumented opcodes on the
// 6809/6803 take the immediate-store path: the core steps PC over an operand byte it never reads, so the
// advance past the instruction is the length there. Control transfers move PC elsewhere; their operand bytes
// are all read, so the read count is right for them.
function coreLength(cpuName, bytes) {
  const mem = new Uint8Array(0x10000);
  mem.set(bytes.slice(0, 12), 0x1000);
  const reads = [];
  const Core = Emu.cpus[cpuName];
  const cpu = new Core({ read: (a) => { reads.push(a & 0xFFFF); return mem[a & 0xFFFF]; }, write: (a, v) => { mem[a & 0xFFFF] = v; } });
  cpu.pc = 0x1000;
  cpu.cc |= 0x50;          // interrupts masked: step() runs the instruction at pc
  cpu.c = 0;
  cpu.step();
  let p = 0x1000, len = 0;
  for (const a of reads) if (a === (p & 0xFFFF)) { len++; p++; }
  const advance = (cpu.pc - 0x1000) & 0xFFFF;
  return { reads: len || 1, advance };
}

const peekOf = (bytes, at = 0) => { const m = new Uint8Array(0x10000); m.set(bytes, at); return (a) => m[a & 0xFFFF]; };
const dis = (cpu, addr, bytes, opts = {}) => Emu.disassemble(cpu, addr, Object.assign({ peek: peekOf(bytes, addr) }, opts));

// ---- 1. every documented opcode decodes to its documented mnemonic, mode and length ----
for (const { cpu, pages } of CPUS) {
  pages.forEach((map, p) => {
    const pre = p === 0 ? [] : [[0x10, 0x11][p - 1]];
    for (const [code, e] of map) {
      const bytes = [...pre, code, 0x12, 0x34, 0x56];
      const ins = dis(cpu, 0x1000, bytes);
      const wantSize = pre.length + MODE_SIZE_FOR[cpu][e.mode];
      check(`${cpu} ${pre.map(hex2).join(' ')} ${hex2(code)} decodes to ${e.mn} ${e.mode}`,
        !ins.illegal && ins.mnemonic === e.mn && ins.mode === e.mode && ins.size === wantSize,
        `got ${ins.mnemonic} ${ins.mode} size ${ins.size} (${JSON.stringify(ins.text)})`);
      check(`${cpu} ${pre.map(hex2).join(' ')} ${hex2(code)} names the mnemonic first`, ins.text.startsWith(e.mn) && (e.mode === 'inh' || e.mode === 'tfm' ? ins.text === e.mn || ins.text.startsWith(e.mn + ' ') : ins.text.startsWith(e.mn + ' ')), ins.text);
      check(`${cpu} ${pre.map(hex2).join(' ')} ${hex2(code)} is as long as the CPU core reads it`, ins.size === coreLength(cpu, bytes).reads, `${ins.size} vs ${coreLength(cpu, bytes).reads}`);
    }
  });
}

// ---- 2. every byte that is not an instruction is data, of the length the part actually takes ----
// On the 6809 and 6803 an undefined opcode is not an error: the core runs something for it, so the
// data listing has to occupy exactly the bytes the core consumes, and that is measured by running it.
// On the 6309 an undefined opcode traps instead (Atkinson printed pp. 151-153): the core reads no
// operand before jumping through $FFF0, so the rule there is structural - one byte on page 1, two
// behind a prefix - and the check below compares the listing with that, not with a PC advance the trap
// destroys.
//
// NEGW, ASRW and ASLW ($1050/$1057/$1058) need no exclusion here, and it is worth saying why, because
// they are a known core deviation. The hardware has no such instructions (Atkinson printed pp. 16, 18,
// 101 and the blank cells of its opcode map printed p. 152) and the listing prints them as one two-byte
// data item. The core, like MAME, reads the same two bytes and runs a W-register instruction instead of
// trapping - so it consumes the same length, and this length comparison holds for them as it does for
// every other undefined opcode. What differs is the behaviour (a trap that should vector through $FFF0
// versus a NEG16), which a byte-count test cannot see; that is the tracked core item, recorded in
// js/asm/dis6309.js and README ("Verification against MAME"), and its own tests will cover it when the
// core changes.
for (const { cpu, pages } of CPUS) {
  pages.forEach((map, p) => {
    const pre = p === 0 ? [] : [[0x10, 0x11][p - 1]];
    for (let code = 0; code < 256; code++) {
      if (map.has(code)) continue;
      const bytes = [...pre, code, 0x12, 0x34, 0x56, 0x78, 0x9A, 0xBC];
      const ins = dis(cpu, 0x1000, bytes);
      const where = `${cpu} ${pre.map(hex2).join(' ')} ${hex2(code)}`;
      // The 6309 traps on an undefined opcode having read no operand of its own. $10 and $11 are always
      // page selectors, never page-1 instructions, so a byte there still costs the selector plus the
      // undefined opcode behind it - two bytes - while an undefined page-1 byte costs one and a
      // prefixed one costs two.
      const wantSize = cpu === '6309' ? (pre.length === 0 && code !== 0x10 && code !== 0x11 ? 1 : 2)
        : coreLength(cpu, bytes).advance;
      const why = cpu === '6309' ? 'as the trap takes it' : 'as the core consumes it';
      check(`${where} is data (${wantSize} bytes, ${why})`,
        ins.illegal && ins.size === wantSize && /^FCB /.test(ins.text) && ins.text.split(',').length === ins.size,
        `got size ${ins.size} ${JSON.stringify(ins.text)}, want ${wantSize}`);
      // the length the core takes for it
      {
        const core = coreLength(cpu, bytes);
        // the 6803's immediate stores step PC over a byte they never read, so the advance is the length
        check(`${where} is as long as the CPU core consumes it`, ins.size === (cpu === '6803' ? core.advance : core.reads),
          `${ins.size} vs ${cpu === '6803' ? core.advance : core.reads}`);
      }
    }
  });
}

// ---- 3. every documented opcode: the assembler emits it, and assemble -> disassemble -> reassemble gives
//         the same bytes ----
// One concrete source line per mode, written the way the assembler takes it. The 6309 modes are its
// own: AIM/OIM/EIM/TIM want a mask then an operand, the bit operations a register, the two bit numbers
// and a direct address, TFM two pointers with their direction.
const operandText = (mn, mode, code) => ({
  inh: mn, cc: `${mn} #$12`, imm8: `${mn} #$12`, imm16: `${mn} #$1234`, imm32: `${mn} #$11223344`,
  dir: `${mn} <$12`, ext: `${mn} >$1234`,
  rel8: `${mn} $1010`, rel16: `${mn} $1100`, idx: `${mn} 5,X`, post: `${mn} X,Y`, stack: `${mn} A`,
  bitmem: `${mn} A,1,2,<$10`,
  imm8dir: `${mn} #$80,<$10`, imm8idx: `${mn} #$80,5,X`, imm8ext: `${mn} #$80,>$1234`,
  // TFM's four opcodes are its four direction pairs: 38 both post-increment, 39 both pre-decrement,
  // 3A source only, 3B destination only [guide printed p. 17; Atkinson printed p. 152]
  tfm: `${mn} ${{ 0x38: 'X+,Y+', 0x39: 'X-,Y-', 0x3A: 'X+,Y', 0x3B: 'X,Y+' }[code]}`,
})[mode];
for (const { cpu, pages } of CPUS) {
  pages.forEach((map, p) => {
    for (const [code, e] of map) {
      if (e.bad !== undefined) continue;
      const src = ` ORG $1000\n ${operandText(e.mn, e.mode, code)}\n`;
      const r = Emu.assemble(src, cpu);
      const bytes = r.ok ? r.segments[0].data : null;
      const got = bytes ? [...bytes].map((b) => b.toString(16).padStart(2, '0')).join(' ') : JSON.stringify(r.errors);
      const wantOp = p === 0 ? [code] : [[0x10, 0x11][p - 1], code];
      // LBRA has two documented encodings ($16 and $10 $20); the assembler chooses one, and either is right
      const okOp = e.mn === 'LBRA' ? (bytes[0] === 0x16 || (bytes[0] === 0x10 && bytes[1] === 0x20)) : wantOp.every((b, i) => bytes[i] === b);
      check(`${cpu} ${e.mn} ${e.mode} assembles to its opcode`, r.ok && okOp, `${got} want ${wantOp.map((b) => b.toString(16)).join(' ')}`);
      if (!r.ok) continue;
      const ins = dis(cpu, 0x1000, bytes);
      check(`${cpu} ${e.mn} ${e.mode} disassembles to one instruction of the same length`, ins.size === bytes.length && !ins.illegal, `${ins.size} vs ${bytes.length}`);
      const back = Emu.assemble(` ORG $1000\n ${ins.text}\n`, cpu);
      const same = back.ok && back.segments[0].data.length === bytes.length && bytes.every((b, i) => back.segments[0].data[i] === b);
      check(`${cpu} ${e.mn} ${e.mode} round-trips through ${JSON.stringify(ins.text)}`, same,
        back.ok ? [...back.segments[0].data].map(hex2).join(' ') : JSON.stringify(back.errors));
    }
  });
}

// ---- 4. the 6809 indexed postbyte, against the data sheet's postbyte table ----
{
  const cases = [];
  // 5-bit signed offsets, no indirect
  // (0 in the 5-bit form is shown <<0,X: plain 0,X assembles to the shorter ,X; see 4b)
  for (let o = -16; o < 16; o++) cases.push([o & 0x1F, o === 0 ? '<<0,X' : `${o},X`]);
  // the remaining documented postbytes for register X; operands are the bytes that follow
  const special = {
    0x80: ',X+', 0x81: ',X++', 0x82: ',-X', 0x83: ',--X', 0x84: ',X', 0x85: 'B,X', 0x86: 'A,X',
    0x88: '18,X', 0x89: '4660,X', 0x8B: 'D,X', 0x91: '[,X++]', 0x93: '[,--X]', 0x94: '[,X]', 0x95: '[B,X]',
    0x96: '[A,X]', 0x98: '[18,X]', 0x99: '[4660,X]', 0x9B: '[D,X]', 0x9F: '[$1234]',
  };
  for (const [pb, text] of Object.entries(special)) cases.push([Number(pb), text]);
  // operand bytes after the postbyte: none, one (8-bit offset), two (16-bit offset / extended indirect)
  const idxExtra = (pb) => (pb === 0x88 || pb === 0x98 || pb === 0x8C || pb === 0x9C ? 1 : pb === 0x89 || pb === 0x99 || pb === 0x8D || pb === 0x9D || pb === 0x9F ? 2 : 0);
  for (const [pb, text] of cases) {
    const bytes = [0xA6, pb, 0x12, 0x34, 0x56];   // LDA indexed
    const ins = dis('6809', 0x1000, bytes);
    const wantSize = 2 + idxExtra(pb);
    check(`6809 postbyte ${hex2(pb)} is ${text}`, !ins.illegal && ins.text === `LDA ${text}` && ins.size === wantSize,
      `${JSON.stringify(ins.text)} size ${ins.size} (want ${wantSize})`);
  }
  // PCR shows where the offset lands: from the end of the instruction
  check('6809 PCR 8-bit', dis('6809', 0x1000, [0xA6, 0x8C, 0x12, 0, 0]).text === `LDA $1015,PCR`);
  check('6809 PCR 16-bit', dis('6809', 0x1000, [0xA6, 0x8D, 0x01, 0x00, 0]).text === `LDA $1104,PCR`);
  check('6809 PCR indirect 8-bit', dis('6809', 0x1000, [0xA6, 0x9C, 0x12, 0, 0]).text === `LDA [$1015,PCR]`);
  check('6809 PCR indirect 16-bit', dis('6809', 0x1000, [0xA6, 0x9D, 0x01, 0x00, 0]).text === `LDA [$1104,PCR]`);
  // the postbytes with no mode: 0x87, 0x8A, 0x8E, their indirect forms, single auto inc/dec inside [], and
  // 0x8F without the indirect bit
  for (const pb of [0x87, 0x8A, 0x8E, 0x90, 0x92, 0x97, 0x9A, 0x9E, 0x8F, 0xA7, 0xAA, 0xAE, 0xB0]) {
    const ins = dis('6809', 0x1000, [0xA6, pb, 0x12, 0x34]);
    check(`6809 postbyte ${hex2(pb)} is data`, ins.illegal && /^FCB /.test(ins.text), ins.text);
  }
  // every postbyte with each index register: the register bits select X/Y/U/S
  for (const [rc, reg] of [[0, 'X'], [1, 'Y'], [2, 'U'], [3, 'S']]) {
    const ins = dis('6809', 0x1000, [0xA6, 0x84 | (rc << 5), 0x12]);
    check(`6809 postbyte register bits ${rc} are ${reg}`, ins.text === `LDA ,${reg}`, ins.text);
    const inc = dis('6809', 0x1000, [0xA6, 0x80 | (rc << 5), 0x12]);
    check(`6809 postbyte auto-increment ${reg}`, inc.text === `LDA ,${reg}+`, inc.text);
  }
  // sizes: postbytes with operands consume them
  check('6809 8-bit offset postbyte is 3 bytes', dis('6809', 0x1000, [0xA6, 0x88, 0x7F, 0, 0]).size === 3);
  check('6809 16-bit offset postbyte is 4 bytes', dis('6809', 0x1000, [0xA6, 0x89, 0x12, 0x34, 0]).size === 4);
  check('6809 extended indirect is 4 bytes', dis('6809', 0x1000, [0xA6, 0x9F, 0x12, 0x34, 0]).size === 4);
  check('6809 page 2 indexed is 5 bytes', dis('6809', 0x1000, [0x10, 0xAE, 0x89, 0x12, 0x34]).size === 5);
  // negative 16-bit offsets are signed (and -2 in the 16-bit form carries its size prefix; see 4b)
  check('6809 16-bit offset is signed', dis('6809', 0x1000, [0xA6, 0x89, 0xFF, 0xFE, 0]).text === 'LDA >-2,X');
}

// ---- 5. direct operands use the direct page for their address; symbols appear in the disassembly ----
{
  const ins = dis('6809', 0x1000, [0xB6, 0x12, 0x34]);
  check('6809 extended operand', ins.text === 'LDA >$1234' && ins.target === 0x1234, ins.text);
  const dir = dis('6809', 0x1000, [0x96, 0x34], { dp: 0x10 });
  check('6809 direct operand address is the direct page plus the byte', dir.text === 'LDA <$34' && dir.target === 0x1034, dir.text);
  const dir0 = dis('6809', 0x1000, [0x96, 0x34]);
  check('6809 direct operand with the direct page at 0', dir0.target === 0x0034, String(dir0.target));
  const m6803 = dis('6803', 0x1000, [0x96, 0x34]);
  check('6803 direct operands are absolute', m6803.target === 0x0034 && m6803.text === 'LDAA <$34', m6803.text);

  const labels = new Map([[0x1234, 'MESSAGE'], [0x0034, 'ZP']]);
  const labelOf = (a) => labels.get(a) || null;
  check('6809 extended operand shows the symbol', dis('6809', 0x1000, [0xB6, 0x12, 0x34], { labelOf }).text === 'LDA >MESSAGE');
  check('6809 direct operand shows the symbol', dis('6809', 0x1000, [0x96, 0x34], { labelOf }).text === 'LDA <ZP');
  check('6809 branch target shows the symbol', dis('6809', 0x1000, [0x16, 0x02, 0x31], { labelOf }).text === 'LBRA MESSAGE');
  check('6809 extended indirect shows the symbol', dis('6809', 0x1000, [0xA6, 0x9F, 0x12, 0x34], { labelOf }).text === 'LDA [MESSAGE]');
  // the symbol form reassembles to the same bytes
  for (const [src, bytes] of [['LDA >MESSAGE', [0xB6, 0x12, 0x34]], ['LDA <ZP', [0x96, 0x34]], ['LBRA MESSAGE', [0x16, 0x02, 0x31]], ['LDA [MESSAGE]', [0xA6, 0x9F, 0x12, 0x34]]]) {
    const r = Emu.assemble(` ORG $1000\nMESSAGE EQU $1234\nZP EQU $34\n ${src}\n`, '6809');
    const got = r.ok ? [...r.segments[0].data] : [];
    check(`symbolic form ${src} assembles to the instruction's bytes`, r.ok && got.length === bytes.length && bytes.every((b, i) => got[i] === b),
      got.map(hex2).join(' '));
    check(`symbolic form ${src} comes back from the disassembler`, dis('6809', 0x1000, bytes, { labelOf }).text === src);
  }
}

// ---- 6. TFR/EXG register pairs, and pairs with no register (data) ----
{
  check('6809 TFR D,X', dis('6809', 0x1000, [0x1F, 0x01, 0, 0]).text === 'TFR D,X');
  check('6809 EXG A,B', dis('6809', 0x1000, [0x1E, 0x89, 0, 0]).text === 'EXG A,B');
  for (const pb of [0x12, 0x1A, 0x5B, 0xAB, 0x4A]) {
    const ins = dis('6809', 0x1000, [0x1F, pb, 0, 0]);
    check(`6809 TFR ${hex2(pb)} round-trips`, !ins.illegal && Emu.assemble(` ORG $1000\n ${ins.text}\n`, '6809').segments[0].data[1] === pb, ins.text);
  }
  for (const pb of [0x1C, 0x6D, 0xC1, 0xFA]) {
    const ins = dis('6809', 0x1000, [0x1F, pb, 0, 0]);
    // the CPU core reads a pair byte whatever it says, so the instruction is 2 bytes, but with no register
    // it is not something the assembler can express: it is data
    check(`6809 TFR with an undefined register ${hex2(pb)} is data`, ins.illegal && ins.size === 2, ins.text);
  }
  // an empty stack list stacks nothing, and reassembles
  const empty = dis('6809', 0x1000, [0x34, 0x00]);
  check('6809 PSHS with an empty list', empty.text === 'PSHS' && Emu.assemble(' ORG $1000\n PSHS\n', '6809').segments[0].data[1] === 0, empty.text);
  check('6809 PSHS a single register', dis('6809', 0x1000, [0x34, 0x02]).text === 'PSHS A');
}

// ---- 7. stack lists and condition-code masks ----
{
  check('6809 PSHS every register', dis('6809', 0x1000, [0x34, 0xFF]).text === 'PSHS CC,A,B,DP,X,Y,U,PC');
  check('6809 PSHU bit 6 is S', dis('6809', 0x1000, [0x36, 0x41]).text === 'PSHU CC,S');
  check('6809 PULS A,B', dis('6809', 0x1000, [0x35, 0x06]).text === 'PULS A,B');
  check('6809 ANDCC', dis('6809', 0x1000, [0x1C, 0xFE]).text === 'ANDCC #$FE');
  check('6809 CWAI', dis('6809', 0x1000, [0x3C, 0xEF]).text === 'CWAI #$EF');
}

// ---- 8. blocks, and reading past the end of memory wraps like the CPU ----
{
  const m = new Uint8Array(0x10000);
  m.set([0x86, 0x01, 0x8B, 0x02], 0x1000);
  m.set([0x7E, 0x12, 0x34], 0xFFFC);   // JMP $1234, its operand running past $FFFF into $0000
  const block = Emu.disassembleBlock('6809', 0x1000, 2, { peek: (a) => m[a & 0xFFFF] });
  check('blocks carry the address of each instruction', block.length === 2 && block[0].addr === 0x1000 && block[1].addr === 0x1002
    && block[0].text === 'LDA #$01' && block[1].text === 'ADDA #$02', JSON.stringify(block.map((i) => i.text)));
  const wrapped = Emu.disassembleBlock('6809', 0xFFFC, 1, { peek: (a) => m[a & 0xFFFF] });
  check('an instruction at the top of memory wraps', wrapped[0].text === 'JMP >$1234' && wrapped[0].size === 3, wrapped[0].text);
}

// ---- 9. the CPUs are separate: an opcode means different things ----
{
  check('6803 and 6809 share an opcode but not a meaning', dis('6803', 0x1000, [0x86, 0x12]).text === 'LDAA #$12'
    && dis('6809', 0x1000, [0x86, 0x12]).text === 'LDA #$12');
  // 6309-only opcodes mean nothing to the 6809, and the 6309 keeps every 6809 one
  check('the 6309 decodes SEXW, the 6809 does not', dis('6309', 0x1000, [0x14]).text === 'SEXW'
    && dis('6809', 0x1000, [0x14]).illegal);
  check('the 6309 runs the 6809 set unchanged', dis('6309', 0x1000, [0x86, 0x12]).text === 'LDA #$12');
  // a CPU with no disassembler is refused by name
  let threw = false;
  try { Emu.disassemble('6800', 0x1000, { peek: () => 0 }); } catch (e) { threw = /6800/.test(e.message); }
  check('a CPU without a disassembler is refused by name', threw);
}

// ---- 9b. the 6309 listing stays in step with the core for EVERY byte on every page ----
// AGENTS.md section 5 (Debugger) asks for the disassembler round-trip and for a single step to equal one
// traced instruction; a listing that disagreed with the core on length would break both, since a debugger
// listing built from it would walk the program off the instruction boundaries.
// This measures the core rather than trusting either table: run one instruction of each of the 766
// opcode/prefix combinations and count the consecutive addresses the core reads from the program counter.
// A trapping opcode (the illegal-instruction exception, MD bit 6, or a divide by zero, bit 7) has read its
// own bytes before it vectors, so the same count is its length. The listing's size must equal it.
{
  const hex = (n) => hex2(n);
  const step6309 = (bytes) => {
    const mem = new Uint8Array(0x10000);
    mem.set(bytes, 0x1000); mem[0xFFF0] = 0x30; mem[0xFFF1] = 0x00;
    const reads = [];
    const cpu = new Emu.cpus['6309']({ read: (a) => { reads.push(a & 0xFFFF); return mem[a & 0xFFFF]; }, write: (a, v) => { mem[a & 0xFFFF] = v; } });
    cpu.pc = 0x1000; cpu.cc = 0x50; cpu.step();
    let p = 0x1000, lead = 0;
    for (const a of reads) if (a === (p & 0xFFFF)) { lead++; p++; }
    return { lead, mem, trapped: cpu.pc === 0x3000, md: cpu.md };
  };
  let checked = 0;
  const bad = [];
  for (const pre of [[], [0x10], [0x11]]) {
    for (let code = 0; code < 256; code++) {
      // $10 and $11 are page selectors, never page-1 instructions; their listings are covered above
      if (pre.length === 0 && (code === 0x10 || code === 0x11)) continue;
      const bytes = [...pre, code, 0x88, 0x12, 0x34, 0x56];   // one ordinary operand, then filler
      const { lead, mem } = step6309(bytes);
      const ins = Emu.disassemble('6309', 0x1000, { peek: (a) => mem[a & 0xFFFF] });
      checked++;
      if (ins.size !== lead) bad.push(`${pre.map(hex).join(' ')} ${hex(code)}: listing ${ins.size} ${JSON.stringify(ins.text)}, core reads ${lead}`);
    }
  }
  check(`6309: all ${checked} opcode/prefix combinations list exactly the bytes the core reads`, checked === 766 && bad.length === 0,
    bad.slice(0, 8).join(' | '));
}

// ---- 4b. every indexed postbyte, bytes -> text -> bytes ----
// An offset stored in a longer form than its value needs (8 bits for 5, 16 for 8, 5 bits for 0) is shown with
// the size prefix the assembler takes (<< 5-bit, < 8-bit, > 16-bit), so the text reassembles to the same bytes.
// Operands: offsets of every size class, both signs, and 0.
{
  const operands = [[0x00, 0x00], [0x00, 0x05], [0x05, 0x00], [0xFB, 0x00], [0x7F, 0x00], [0x80, 0x00], [0xFF, 0xF0], [0x00, 0x7F], [0x12, 0x34], [0xFF, 0x80]];
  let tried = 0, bad = [];
  for (let pb = 0; pb < 256; pb++) {
    for (const [b1, b2] of operands) {
      const bytes = [0xA6, pb, b1, b2, 0x12];
      const ins = dis('6809', 0x1000, bytes);
      if (ins.illegal) continue;
      // PCR and extended indirect ignore the register bits: the canonical encoding (bits 00) is the one to compare
      if (((pb & 0x8E) === 0x8C || (pb & 0x9F) === 0x9F) && (pb & 0x60)) continue;
      tried++;
      const r = Emu.assemble(` ORG $1000\n ${ins.text}\n`, '6809');
      const out = r.ok ? [...r.segments[0].data] : null;
      if (!out || out.length !== ins.size || out.some((v, i) => v !== bytes[i])) bad.push(`${bytes.slice(0, ins.size).map(hex2).join(' ')} -> ${ins.text} -> ${out ? out.map(hex2).join(' ') : JSON.stringify(r.errors)}`);
    }
  }
  check(`6809 indexed: all ${tried} postbyte/operand cases reassemble to the same bytes`, tried > 2000 && bad.length === 0, bad.slice(0, 6).join(' | '));
  // the prefixes the assembler takes, and their range checks
  const asm = (t) => { const r = Emu.assemble(` ORG $1000\n ${t}\n`, '6809'); return r.ok ? [...r.segments[0].data].map((v) => v.toString(16).toUpperCase().padStart(2, '0')).join(' ') : 'ERR ' + r.errors[0].message; };
  check('assembler: <<0,X is the 5-bit form', asm('LDA <<0,X') === 'A6 00', asm('LDA <<0,X'));
  check('assembler: <5,X is the 8-bit form', asm('LDA <5,X') === 'A6 88 05', asm('LDA <5,X'));
  check('assembler: >5,X is the 16-bit form', asm('LDA >5,X') === 'A6 89 00 05', asm('LDA >5,X'));
  check('assembler: >$1006,PCR is the 16-bit PCR form', asm('LEAX >$1006,PCR') === '30 8D 00 02', asm('LEAX >$1006,PCR'));
  check('assembler: <<16,X is out of range', /range/.test(asm('LDA <<16,X')), asm('LDA <<16,X'));
  check('assembler: <200,X is out of range', /range/.test(asm('LDA <200,X')), asm('LDA <200,X'));
  check('assembler: [<<0,X] is refused (no 5-bit indirect)', /ERR/.test(asm('LDA [<<0,X]')), asm('LDA [<<0,X]'));
}

console.log(`${n - fail}/${n} disassembler checks passed`);
process.exitCode = fail ? 1 : 0;
