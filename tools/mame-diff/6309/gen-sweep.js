// Generates sweep.asm: a 6309 diagnostic firmware that exercises every 6309-only instruction in every
// addressing mode, in both emulation and native mode, plus the TFM variants and the trap. It is our
// own code, installed in place of the BASIC ROM, so the same program runs in MAME (`dragon64h` and the
// other HD6309 machines) and in our emulator, and the two instruction traces must be identical.
//
// Layout: the program clears the direct page, then runs the same block of instructions twice -- once in
// emulation mode and once with LDMD #$01 (native mode) -- each block writing its results to its own fixed
// addresses, so a wrong result shows up in memory as well as in the registers, and a cycle count that
// differs between the modes shows up too. It ends in the usual HALT loop, which is what the lockstep
// check requires.
//
//   node tools/mame-diff/6309/gen-sweep.js
const fs = require('fs');
const { writeAtomic } = require('../lib/firmware');
const path = require('path');

// The vector base: $BFF0 for a 16K ROM window (Dragon/CoCo), $FFF0 for the CoCo 3's 32K one.
const VECTORS = process.env.SWEEP_VECTORS || '$BFF0';
// the output file: sweep.asm for the 16K window, sweep32.asm for the CoCo 3's 32K one (both are generated)
const OUT = process.env.SWEEP_OUT || 'sweep.asm';
const L = [];
const e = (s = '') => L.push(s);
const hex = (n) => n.toString(16).toUpperCase();

// The instruction block, run once per CPU mode. `off` is where the block writes its results: the
// emulation block at BUF+$000, the native one at BUF+$300 (both inside the 16K the machine maps at
// $8000, clear of the vectors at $BFF0).
function block(off) {
  const b = (n) => `>BUF+$${hex(off + n).padStart(3, '0')}`;
  // Fold the 16-byte destination window into D and store it, so a byte written to the WRONG ADDRESS becomes
  // a different register value. The lockstep compares registers and cycles but never memory, so without this
  // a TFM that walks the wrong pointer while ending with the right register is invisible to it -- which is
  // exactly what the 3A/3B bug was. X is reloaded from #DST rather than reused, because only two of the four
  // forms leave X pointing at the destination. D is overwritten by the first LDD rather than read, so nothing
  // here depends on what D held; the byte count lives in W.
  // 16 bytes as eight big-endian words, so a byte landing one address off changes the sum's byte order too.
  const dstSum = (base, n) => [`        LDX     #${base}`, '        LDD     ,X',
    ...[2, 4, 6, 8, 10, 12, 14].map((i) => `        ADDD    ${i},X`), `        STD     ${b(n)}`];
  // Seed SRC with 20 distinct bytes, $10..$23, so an off-by-one read is visible.
  const seedSrc = () => ['        LDX     #SRC', '        LDD     #$1011', '        STD     ,X',
    '        LDD     #$1213', '        STD     2,X', '        LDD     #$1415', '        STD     4,X',
    '        LDD     #$1617', '        STD     6,X', '        LDD     #$1819', '        STD     8,X',
    '        LDD     #$1A1B', '        STD     10,X', '        LDD     #$1C1D', '        STD     12,X',
    '        LDD     #$1E1F', '        STD     14,X', '        LDD     #$2021', '        STD     16,X',
    '        LDD     #$2223', '        STD     18,X'];
  // Clear the destination window, so a sum is the moved bytes and nothing left over.
  const clearDst = () => ['        LDX     #DST', '        LDD     #$0000',
    ...[0, 2, 4, 6, 8, 10, 12, 14].map((i) => `        STD     ${i},X`)];
  // indexed forms of the 6309-only instructions, so the post-byte costs are compared as well: ,X (0),
  // ,X+ (1), n,X (5) and [,X] (0x94) as the last form.
  e(`; ---- ${off ? 'native' : 'emulation'} mode block ----`);
  e('        LDQ     #$11223344');
  e(`        STQ     ${b(0x00)}`);
  e('        LDQ     #$55667788');
  e('        STQ     <R1');
  e('        LDQ     <R1');
  e(`        STQ     ${b(0x04)}`);
  e('        LDX     #SRC');
  e('        LDQ     #$AABBCCDD');
  e('        STQ     ,X');
  e('        LDQ     ,X');
  e(`        STQ     ${b(0x08)}`);
  e('        LDQ     >SRC');
  e(`        STQ     ${b(0x0C)}`);
  e('        STQ     ,X');
  e('        LDQ     ,X');
  e(`        STQ     ${b(0x10)}`);
  e('        STQ     ,X+');
  e('        LDQ     ,X+');
  e(`        STQ     ${b(0x14)}`);
  // an indirect form reads its pointer word from memory, so store a known one first: an uninitialised
  // pointer would make the address depend on what each machine leaves in RAM. X is reseeded here and at
  // every indirect form, because the ,X+ and ,X++ forms above leave it pointing past the pointer.
  e('        LDX     #PTR');
  e('        LDD     #SRC');
  e('        STD     ,X');
  e('        LDQ     #$AABBCCDD');
  e('        STQ     [,X]');
  e('        LDQ     [,X]');
  e(`        STQ     ${b(0x18)}`);
  e('');
  // W / E / F in every mode
  e('        LDW     #$1234');
  e(`        STW     ${b(0x1C)}`);
  e('        STW     <R1');
  e('        LDW     <R1');
  e(`        STW     ${b(0x1E)}`);
  e('        STW     ,X');
  e('        LDW     ,X');
  e(`        STW     ${b(0x20)}`);
  e('        LDW     >SRC');
  e(`        STW     ${b(0x22)}`);
  e('        LDE     #$5A');
  e(`        STE     ${b(0x24)}`);
  e('        STE     <R1');
  e('        LDE     <R1');
  e('        STE     ,X');
  e('        LDE     ,X');
  e(`        STE     ${b(0x25)}`);
  e('        LDF     #$A5');
  e(`        STF     ${b(0x26)}`);
  e('        STF     <R1');
  e('        LDF     <R1');
  e('        STF     ,X');
  e('        LDF     ,X');
  e(`        STF     ${b(0x27)}`);
  e('');
  // arithmetic on W / E / F / D and the new math, in every addressing mode the family has
  e('        LDW     #$0100');
  e('        ADDW    #$0010');
  e('        SUBW    #$0004');
  e('        CMPW    #$010C');
  e('        ANDD    #$0F0F');
  e('        ORD     #$F0F0');
  e('        EORD    #$FFFF');
  e(`        STW     ${b(0x28)}`);
  e('        LDD     #$1234');
  e('        STD     <R0');
  e('        STD     >BUF+$200');
  e('        ANDD    <R0');
  e('        ORD     >BUF+$200');
  e('        EORD    ,X');
  e('        STD     <R0');
  e('        ANDD    ,X');
  e(`        STD     ${b(0x2C)}`);
  e('        LDE     #$10');
  e('        ADDE    #$05');
  e('        SUBE    #$01');
  e('        CMPE    #$14');
  e('        ADDE    <R1');
  e('        SUBE    <R1');
  e('        CMPE    <R1');
  e('        LDF     #$20');
  e('        ADDF    #$02');
  e('        SUBF    #$01');
  e('        CMPF    #$21');
  e('        ADDF    <R1');
  e('        SUBF    <R1');
  e('        CMPF    <R1');
  // The direct/extended/indexed forms read the divisor from memory. Set it explicitly before every use:
  // R0 is a scratch register here and a previous store may have left it zero, which would divide by zero
  // and send the block to the trap before it ever reaches the native section.
  e('        LDD     #$0064');
  e('        DIVD    #$07');
  e('        STD     <R0');
  e('        LDD     #$0064');
  e('        DIVD    <R0');
  e('        LDD     #$0064');
  e('        LDA     #$07');
  e('        STA     >DIVISOR');
  e('        LDD     #$0064');
  e('        DIVD    >DIVISOR');
  e('        LDD     #$0064');
  e('        DIVD    ,X');
  e(`        STD     ${b(0x2E)}`);
  e('        LDQ     #$00000100');
  e('        DIVQ    #$0003');
  e('        STD     <R0');
  e(`        STW     ${b(0x30)}`);
  e('        LDD     #$0007');
  e('        STD     <R0');
  e('        LDQ     #$00000100');
  e('        DIVQ    <R0');
  e('        LDQ     #$00000100');
  e('        DIVQ    >DIVISOR');
  e('        LDQ     #$00000100');
  e('        DIVQ    ,X');
  e(`        STD     ${b(0x32)}`);
  e(`        STW     ${b(0x34)}`);
  e('        LDD     #$0210');
  e('        MULD    #$0010');
  e('        LDD     #$0010');
  e('        MULD    <R0');
  e('        LDD     #$0010');
  e('        MULD    >BUF+$200');
  // the indexed forms of the new math, one post byte per form: MAME charges the MULD/DIVD/DIVQ internal
  // time on top of whatever its INDEXED handler charged for the post byte, so the total depends on the
  // form. Every form the sweep can reach is measured, so the compat table needs no extrapolation.
  // Each indexed form gets X on the same word (SRC) so the operand is identical in every one; the ,X+ and
  // ,X++ forms advance X, so it is reseeded for each.
  e('        LDX     #SRC');
  e('        LDD     #$0010');
  e('        MULD    ,X');
  e('        LDX     #SRC');
  e('        LDD     #$0010');
  e('        MULD    ,X+');
  e('        LDX     #SRC');
  e('        LDD     #$0010');
  e('        MULD    ,X++');
  e('        LDD     #$0010');
  e('        MULD    <R0');
  e('        LDX     #PTR');
  e('        LDD     #$0010');
  e('        MULD    [,X]');
  // [R0] reads the pointer from the direct page, which the block has used as scratch: store one there
  e('        LDY     #SRC');
  e('        STY     <R0');
  e('        LDD     #$0010');
  e('        MULD    [R0]');
  // ,X+ reads the operand at [X] and leaves X two higher; reseed X and the divisor for each use so a
  // later read never lands on a zero byte and traps. LDD #$0064 loads D and would clobber X's target if it
  // were stored, so the divisor is written as a byte and D is loaded afterwards.
  e('        LDX     #DIVISOR');
  e('        LDA     #$07');
  e('        STA     ,X');
  e('        LDA     #$00');
  e('        STA     1,X');
  e('        LDX     #DIVISOR');
  e('        LDD     #$0064');
  e('        DIVD    ,X+');
  e('        LDX     #DIVISOR');
  e('        LDQ     #$00000100');
  e('        DIVQ    ,X+');
  e(`        STQ     ${b(0x36)}`);
  e('        LDA     #$FF');
  e('        LDB     #$80');
  e('        SEXW');
  e(`        STD     ${b(0x3A)}`);
  e('');
  // inter-register, the unary families and the stack
  e('        LDD     #$0102');
  e('        LDX     #$0304');
  e('        ADDR    D,X');
  e(`        STX     ${b(0x3C)}`);
  e('        SUBR    X,Y');
  e('        STY     >BUF+$200');
  e('        ANDR    D,Y');
  e('        ORR     D,Y');
  e('        EORR    D,Y');
  e('        CMPR    D,Y');
  e('        LDW     #$8001');
  e('        ADDR    D,W');
  e(`        STW     ${b(0x3E)}`);
  e('        LDW     #$0009');
  e('        SUBR    D,W');
  e('        LDW     #$0009');
  e('        CMPR    D,W');
  e('        LDW     #$0009');
  e('        ANDR    D,W');
  e('        LDW     #$0009');
  e('        EORR    D,W');
  e('        LDW     #$0009');
  e('        ORR     D,W');
  e(`        STW     ${b(0x40)}`);
  e('        LDQ     #$0F0F0F0F');
  e('        CLRD');
  e('        COMW');
  e(`        STW     ${b(0x42)}`);
  e('        LDW     #$0001');
  e('        DECW');
  e('        INCW');
  e('        LSRW');
  e('        RORW');
  e('        ROLW');
  e('        TSTW');
  e(`        STW     ${b(0x44)}`);
  e('        LDW     #$8001');
  e('        LSRW                    ; a set bit shifted out: both set C (MAME\'s LSR16 does too)');
  e(`        STW     ${b(0x46)}`);
  e('        LDW     #$0000');
  e('        TSTW                    ; zero word: N and Z from the word, V cleared (both agree)');
  e(`        STW     ${b(0x48)}`);
  e('        LDW     #$0000');
  e('        DECW                    ; hardware leaves C, MAME clears it');
  e(`        STW     ${b(0x4A)}`);
  e('        LDW     #$FFFF');
  e('        INCW');
  e(`        STW     ${b(0x4C)}`);
  // The flag rules that MAME and the hardware disagree on, at the boundaries where they show: C on a
  // borrow/carry, V on a signed overflow, and the bit the shift discards. Each is run twice -- with the
  // flag's own condition present and absent -- so a compat table entry cannot pass by coincidence.
  e('        LDW     #$0000');
  e('        ORCC    #$01            ; C set');
  e('        DECW                    ; $0000 - 1 borrows: hardware C stays as it was');
  e(`        STW     ${b(0x80)}`);
  e('        LDW     #$0001');
  e('        ANDCC   #$FE            ; C clear');
  e('        DECW                    ; no borrow: hardware leaves C clear');
  e(`        STW     ${b(0x82)}`);
  e('        LDW     #$FFFF');
  e('        ORCC    #$01            ; C set');
  e('        INCW                    ; $FFFF + 1 carries: hardware C stays as it was');
  e(`        STW     ${b(0x84)}`);
  e('        LDW     #$0001');
  e('        ORCC    #$01            ; C set');
  e('        LSRW                    ; the bit shifted out is 1: hardware sets C (it was already set)');
  e(`        STW     ${b(0x86)}`);
  e('        LDW     #$8000');
  e('        ANDCC   #$FE            ; C clear');
  e('        LSRW                    ; the bit shifted out is 0: both leave C clear');
  e(`        STW     ${b(0x88)}`);
  // TSTW clears V on both: Atkinson's aid prints V as "0" for TSTD/TSTW, and MAME's set_flags(mask, r)
  // expands to set_flags(mask, 0, r, r), whose V term is (0 ^ r ^ r ^ (r >> 1)) & 0x8000 = (r >> 1) & 0x8000,
  // which is 0 for every r. So V must be set beforehand for this to prove anything: the case below enters
  // with V set and a non-zero word, and both must come out with V clear.
  e('        LDW     #$FFFF');
  e('        ORCC    #$02            ; V set, so clearing it is visible');
  e('        TSTW                    ; a non-zero word: V cleared (Atkinson and MAME agree)');
  e(`        STW     ${b(0x8A)}`);
  e('        LDW     #$7FFF');
  e('        INCW                    ; +$8000 overflows: both set V');
  e(`        STW     ${b(0x8C)}`);
  e('        LDW     #$8000');
  e('        DECW                    ; -$8001 overflows: both set V');
  e(`        STW     ${b(0x8E)}`);
  e('        LDW     #$0000');
  e('        ROLW                    ; C into bit 0, bit 15 out');
  e(`        STW     ${b(0x90)}`);
  e('        LDW     #$8000');
  e('        ROLW');
  e(`        STW     ${b(0x92)}`);
  // LDMD changes no condition code flags [Atkinson p.144]; MAME runs it through LD8, which sets N, Z and V
  // from the MD byte. Set a known condition code first, then load an MD value whose low bits are non-zero,
  // so a flag that MAME wrongly changes shows up and a correctly-preserved one does not.
  // Only bits 0-1 are used here: bit 0 would switch the mode and the rest of the block runs as native.
  e('        LDA     #$01');
  e('        SUBA    #$02            ; C set (the borrow)');
  e('        ANDCC   #$B1            ; C set, Z clear, V clear, N clear, H clear');
  e('        LDMD    #$02            ; bit 1 only: no mode change, no flag change on hardware');
  e(`        STA     ${b(0x94)}`);
  e('        LDA     #$55            ; a marker byte, so a stale A shows up too');
  e(`        STA     ${b(0x96)}`);
  e('        LDQ     #$80000001');
  e('        LSRD');
  e(`        STQ     ${b(0x4E)}`);
  e('        NEGD');
  e(`        STQ     ${b(0x52)}`);
  e('        COMD');
  e('        ASLD');
  e('        ASRD');
  e('        RORD');
  e('        ROLD');
  e('        INCD');
  e('        DECD');
  e('        TSTD');
  e(`        STQ     ${b(0x56)}`);
  e('        LDW     #$ABCD');
  e('        PSHSW');
  e('        PULSW');
  e(`        STW     ${b(0x5A)}`);
  e('        PSHUW');
  e('        PULUW');
  e(`        STW     ${b(0x5C)}`);
  e('        LDE     #$01');
  e('        COME');
  e('        DECE');
  e('        INCE');
  e('        TSTE');
  e(`        STE     ${b(0x5E)}`);
  e('        LDF     #$02');
  e('        COMF');
  e('        DECF');
  e('        INCF');
  e('        TSTF');
  e(`        STF     ${b(0x5F)}`);
  e('        LDE     #$03');
  e('        CLRE');
  e('        LDF     #$04');
  e('        CLRF');
  e(`        STE     ${b(0x60)}`);
  e(`        STF     ${b(0x61)}`);
  e('');
  // bit operations on memory, and the bit transfers: direct, extended and indexed, all four opcodes
  e('        LDA     #%10101010');
  e('        STA     <R1          ; the byte the bit ops work on');
  e('        AIM     #$0F,<R1');
  e('        OIM     #$C0,<R1');
  e('        EIM     #$FF,<R1');
  e('        TIM     #$01,<R1');
  e('        LDA     <R1');
  e(`        STA     ${b(0x62)}`);
  e('        LDA     #%11110000');
  e('        STA     <R1');
  e('        AIM     #$3C,>BUF+$200  ; extended and indexed forms too');
  e('        LDX     #R1');
  e('        OIM     #$03,,X');
  e('        EIM     #$01,0,X');
  e('        TIM     #$02,-1,X');
  e('        LDX     #PTR');
  e('        AIM     #$81,[,X]');
  e('        LDA     <R1');
  e(`        STA     ${b(0x63)}`);
  e('        LDA     #%10000001');
  e('        BAND    A,0,7,<R1');
  e('        BOR     A,1,6,<R1');
  e('        BEOR    A,2,5,<R1');
  e('        BIAND   A,3,4,<R1');
  e('        BIOR    A,4,3,<R1');
  e('        BIEOR   A,5,2,<R1');
  e('        LDBT    A,6,1,<R1');
  e('        STBT    A,7,0,<R1');
  e('        LDA     <R1');
  e(`        STA     ${b(0x64)}`);
  e('        BITMD   #$C0');
  e('');
  // Every case copies from the seeded SRC window into the cleared DST window, so the folded sum is the moved
  // bytes and nothing else -- copying cleared memory would sum to zero whatever the addresses were. The
  // decrementing form starts both pointers at the top of its window and walks down, so it writes the same 16
  // bytes in the reverse order; because the fold adds them, its sum is therefore EQUAL to the incrementing
  // one (measured: both b8c0), and what it proves is that the addresses were right, not the order. A byte
  // landing one address off still changes the sum's value or its byte order.
  //
  // The instruction is emitted as raw bytes (FCB [11][op][postbyte]) rather than as a mnemonic, so that this
  // firmware tests opcodes directly and never depends on what the assembler does with a TFM spelling. That was
  // not hypothetical: the encoder used to map both TFM X+,Y and TFM X,Y+ onto 3A, so the mnemonic form ran the
  // 3A case twice and left 3B unexecuted -- a firmware silently testing the wrong instruction while still
  // reaching HALT. The encoder now rejects every spelling outside the four forms, but
  // raw bytes remain the right choice for a firmware whose job is to exercise the core. The postbyte $12 is
  // source X (1) and destination Y (2) [Atkinson printed p.136 ("the same format as TFR and EXG")].
  for (const [op, srcReg, dstReg, count, slot] of [
    [0x38, 'SRC', 'DST', 0x10, 0x66],
    [0x39, 'SRC+$0F', 'DST+$0F', 0x10, 0x68],
    [0x3A, 'SRC', 'DST', 0x04, 0x6A],
    [0x3B, 'SRC', 'DST', 0x04, 0x6C],
  ]) {
    seedSrc().forEach(e);
    clearDst().forEach(e);
    e(`        LDW     #$${hex(count).padStart(4, '0')}`);
    e(`        LDX     #${srcReg}`);
    e(`        LDY     #${dstReg}`);
    e(`        FCB     $11,$${hex(op)},$12     ; TFM with source X, destination Y`);
    e('        STX     <R0');
    e('        STY     <R1');
    e(`        STW     ${b(slot)}`);
    dstSum('DST', slot + 0x0A).forEach(e);
  }
  e('        LDX     #SRC          ; put the $5A back for the blocks that follow');
  e('        LDA     #$5A');
  e('        STA     ,X');
  e('        STA     R1-1');
  e('');
}

e('; GENERATED by gen-sweep.js: do not edit by hand.');
e('; 6309 diagnostic firmware: every 6309-only instruction, all its addressing modes, in both modes,');
e('; the TFM variants and the error trap. Ends in HALT.');
e('');
e('R0      EQU     $00         ; scratch window in the direct page');
e('R1      EQU     $10');
// Results and scratch live in RAM at $6000-$6FFF, which is RAM on every 6309 machine and clear of the
// ROM image: the CoCo 3's ROM is 32K at $8000, so $2000 (fine on the others) would be inside it there, and
// writes meant for the results would be lost.
e('BUF     EQU     $6000       ; where results are stored');
e('SRC     EQU     $6100');
e('DST     EQU     $6200');
e('DIVISOR EQU     $6300       ; the divisor the memory forms read (in the SRC window)');
e('PTR     EQU     $6310       ; the pointer word the indirect forms read');
// interrupt counters and the CC each handler saw on the stack, in the direct page (the blocks clear it
// before running, so both emulators start at zero)
e('IRQN    EQU     $20');
e('FIRQN   EQU     $21');
e('NMIN    EQU     $22');
e('IRQCC   EQU     $23');
e('FIRQCC  EQU     $24');
e('NMICC   EQU     $25');
e('');
e('        ORG     $8000');
e('RESET   ORCC    #$50');
e('        LDS     #$7F00');
e('        LDU     #$5800   ; below the $6000-$63FF results and scratch the blocks write');
e('        LDA     #$00');
e('        TFR     A,DP        ; direct page 0, so <$xx is $00xx');
e('');
// Clear the direct page and the source/destination buffer before either block runs. Both machines must
// start from the same bytes -- MAME leaves RAM at $FF and we leave it at $00, and an instruction that
// reads a byte neither block wrote would then differ for a reason that has nothing to do with the CPU.
e('        LDX     #$0000');
e('        LDB     #$00');
e('CLR1    STB     ,X+            ; $0000-$00FF (the direct page)');
e('        CMPX    #$0100');
e('        BNE     CLR1');
e('        LDX     #SRC');
e('CLR2    STB     ,X+            ; SRC and DST');
e('        CMPX    #DST+$0100');
e('        BNE     CLR2');
e('        LDX     #SRC');
e('        LDA     #$5A');
e('        STA     ,X          ; a known byte the indexed forms read');
e('        STA     R1-1        ; the byte -1,X addresses from R1');
e('');

block(0x000);                 // emulation mode: no LDMD, so MD bit 0 stays clear
// ---- the ordinary 6809 instructions, in native mode ----
// The 6309 runs every 6809 instruction faster in native mode by a fixed per-opcode saving (NATIVE_SAVE in
// js/cpu/cpu6309.js). Before this block nothing exercised that table: the sweep ran only the 6309-only
// instructions in native mode, so a wrong saving on an ordinary one would have passed every comparison.
//
// Every figure this block relies on is Atkinson's, and the printed page is named so it can be re-checked:
//   RTS 5/4, JSR 7/6 (direct), 7+/6+ (indexed), 8/7 (extended)   -- "RTS", "JSR"
//   PSHS/PULS 5+/4+ (the "+" is one more cycle per byte)          -- "PSHS", "PULS"
//   COM (memory) 6/5 direct, 6+ indexed, 7/6 extended            -- "COM (memory)", printed p. 54
//   MUL 11/10, SWI 19/21, SWI2/SWI3 20/22 (native is LONGER)     -- their own pages
// A '/' pair is emulation/native throughout.
e('; ---------------- ordinary 6809 instructions, native mode ----------------');
e('        LDMD    #$01            ; native mode for this block');
e('        LDS     #$7F00          ; a stack for PSHS/PULS/JSR/RTS');
e('        LDX     #$2000');
e('        LDY     #$2000');
e('        LDU     #$2200          ; a stack for PSHU/PULU');
e('        LDD     #$1234');
e('        JSR     >LSUB           ; JSR 7/6 direct: pushes a return address, LSUB returns');
e('        NOP');
e('        PSHS    A,B,X           ; PSHS 5+/4+ with three registers: 5 + 4 pushed bytes');
e('        PULS    A,B,X');
e('        PSHS    D');
e('        PULS    D');
e('        PSHU    D               ; PSHU/PULU use the U stack, a different page of the same rule');
e('        PULU    D');
e('        LDA     #$01');
e('        STA     <$10');
e('        LDA     <$10');
e('        STA     $2000');
e('        LDA     $2000');
e('        LDA     ,X');
e('        STA     ,X');
e('        ADDD    #$0001');
e('        SUBD    #$0001');
e('        CMPX    #$2000');
e('        CMPA    #$01');
e('        INCA');
e('        DECA');
e('        LSRA');
e('        ASLA');
e('        RORA');
e('        ROLA');
e('        NEGA');
e('        COMA');
e('        TSTA');
e('        CLRA');
e('        LDB     #$02');
e('        MUL                     ; MUL 11/10: the only 6809 instruction native mode makes SLOWER');
e('        ABX');
// The 8-bit read-modify-write family on memory, in ALL THREE memory modes. Atkinson gives each of these
// 6/5 direct, 6+ indexed and 7/6 extended, on its own page: NEG p.103, COM p.54, LSR p.98, ROR p.118,
// ASR p.18, ASL p.16, ROL p.116, DEC p.58, INC p.68, CLR p.49, and TST is 6/4 direct / 6+ indexed / 7/5
// extended (p.141). MAME charges one cycle less in native mode for NEG, COM, LSR, ROR, ASR, ASL and ROL in
// every mode, and agrees with the table on DEC, INC, CLR and TST -- so only the first seven carry a
// MAME_DELTA entry, and only under config.mameCompat. Running all three modes is what makes that checkable:
// a delta on an agreeing instruction, or a missing one on a differing mode, fails the lockstep here.
// X points at a scratch byte for the indexed forms; the extended forms use $2000.
e('        LDA     #$5A');
e('        STA     <$10           ; the direct operand');
e('        STA     ,X             ; the indexed operand');
e('        STA     $2000          ; the extended operand');
for (const [mn, name] of [['NEG', 'NEG'], ['COM', 'COM'], ['LSR', 'LSR'], ['ROR', 'ROR'],
  ['ASR', 'ASR'], ['ASL', 'ASL'], ['ROL', 'ROL'], ['DEC', 'DEC'], ['INC', 'INC'],
  ['TST', 'TST'], ['CLR', 'CLR']]) {
  e(`        ${mn}     <$10           ; ${name} direct`);
  e(`        ${mn}     ,X             ; ${name} indexed`);
  e(`        ${mn}     $2000          ; ${name} extended`);
}
e('        LDMD    #$00            ; back to emulation before the tail');
e('');

e('; ---------------- native mode ----------------');
e('        LDMD    #$01');
e('');
block(0x300);
e('        LDMD    #$00            ; back to emulation for the tail');
// LDMD affects no condition code flags [Atkinson p.144], but MAME's leaves Z set; step CC to a known
// value right after it so the comparison does not depend on MAME's stale flag. ANDCC #$D0 keeps E, F and
// I and clears H, N, Z, V and C, which is the state the trap test wants.
e('        ANDCC   #$D0            ; a known condition code before the trap section');
e('');

// ---- interrupts: IRQ, FIRQ, FIRQ-as-IRQ, CWAI and SYNC, in each mode ----
// MAME 0.289's Lua exposes no way to assert an interrupt line (set_input_line, pulse_input_line and nmi are
// all absent from the debugger's cpu object; only ioport is there), so every interrupt here comes from a
// device that both emulators drive identically:
//
//   IRQ    PIA0 CB1, the VDG field sync (js/machines/sam.js hsFall -> p0.setC1('b', ...)). Field sync rather
//          than the line-rate CA1: a line-rate interrupt re-fires within a few hundred cycles of the RTI, and
//          whether it lands before or after the instruction that re-masks is a race the first attempt at this
//          block lost. A field is long enough that the firmware always re-masks first.
//   FIRQ   PIA1 CB1, which is CART. Under config.mameCompat (which the lockstep sets) a write to PIA1 twiddles
//          the cartridge slot's Q line, and a Program Pak ties CART to Q (MAME coco_pak.cpp: "normal CoCo PAKs
//          tie their CART line to Q"), so each PIA1 write toggles CB1.
//
// NMI is left out: it is reachable only through a cartridge device (the FDC's INTRQ, MAME coco_fdc.cpp), and
// mounting one is a separate comparison. Its vector is already checked; what is not is an NMI frame.
//
// PIA0's port B is made an output register holding 0 before the interrupts are enabled, because clearing a
// PIA flag takes a read of the PORT, and the port's pins are not connected the same way in both emulators
// (MAME reads 00 on the Dragon, this core reads FF): the read has to return the same byte on both sides.
//
// The frame differs by mode, which is what the run proves: an IRQ in emulation mode stacks CC, A, B, DP, X, Y,
// U and PC (CC.E clear, 8 bytes), in native mode E and F as well (CC.E set, 10 bytes). A plain FIRQ stacks
// only CC and PC, so its handler saves the registers it uses. FIRQ-as-IRQ (MD bit 1) stacks the whole state.
// The handler stores the CC it found on the stack, so the frame shape is checked, not just the count.
function interrupts(off) {
  const b = (n) => `>BUF+$${hex(off + n).padStart(3, '0')}`;
  // IRQ: enable PIA0 CA1's interrupt and park in CWAI until the video's HS pulse raises it. A free-running
  // loop cannot lockstep: which instruction the interrupt lands on then depends on the line's exact assert
  // time, so the two emulators diverge by a few cycles for a reason that is not the CPU (measured on the
  // first attempt at this block). Parking fixes the entry and exit points, which is what the SAM and CoCo 3
  // diagnostics already do. The handler clears the PIA flag by reading the port and RTIs past the CWAI.
  e('        CLR     <IRQN');
  e('        CLR     $FF03           ; CRB = 0: a $FF02 write now goes to DDRB');
  e('        LDA     #$FF');
  e('        STA     $FF02           ; DDRB = $FF: every port B line an output');
  e('        LDA     #$04');
  e('        STA     $FF03           ; CRB bit 2: a $FF02 write now goes to ORB');
  e('        CLR     $FF02           ; ORB = 0, so a read of port B returns 0 in both emulators');
  e('        LDA     #$05            ; CRB: data-register select + CB1 interrupt enable (field sync)');
  e('        STA     $FF03');
  e('        CWAI    #$EF            ; AND CC with $EF (unmask IRQ), stack the state, wait for FS');
  e('        ORCC    #$50            ; back with I and F set (CWAI sets both)');
  e('        LDA     <IRQN');
  e(`        STA     ${b(0x00)}`);
  e('        LDA     <IRQCC');
  e(`        STA     ${b(0x01)}      ; CC as stacked: bit 7 (E) says whether E and F were stacked`);
  e('        CLR     $FF03');
  // FIRQ: CB1's interrupt, then two PIA1 writes. The first toggles Q high, a rising edge on CB1 -> FIRQ.
  e('        CLR     <FIRQN');
  e('        CLR     $FF23');
  e('        LDA     #$05            ; CRB: data-register select + CB1 interrupt enable (rising edge)');
  e('        STA     $FF23');
  e('        ANDCC   #$AF            ; unmask FIRQ (clear F and I)');
  e('        CLR     $FF20           ; a PIA1 write: twiddles Q -> CART -> CB1');
  e('        NOP');
  e('        ORCC    #$50');
  e('        LDA     <FIRQN');
  e(`        STA     ${b(0x02)}`);
  e('        LDA     <FIRQCC');
  e(`        STA     ${b(0x03)}      ; CC as stacked by the plain FIRQ`);
  e('        CLR     $FF23');
  // FIRQ as IRQ: MD bit 1, then the same two writes. The frame and the cycles become IRQ's.
  e('        CLR     <FIRQN');
  e('        LDMD    #$02            ; FM: FIRQ stacks the whole state (mode stays emulation)');
  e('        CLR     $FF23');
  e('        LDA     #$05');
  e('        STA     $FF23');
  e('        ANDCC   #$AF');
  e('        CLR     $FF20');
  e('        NOP');
  e('        ORCC    #$50');
  e('        LDA     <FIRQCC');
  e(`        STA     ${b(0x04)}      ; CC.E set: FIRQ-as-IRQ stacked the whole state`);
  e('        LDA     <FIRQN');
  e(`        STA     ${b(0x05)}`);
  e('        LDMD    #$00');
  e('        CLR     $FF23');
  // CWAI: stack the state and set I and F, then wait; the HS IRQ releases it and the handler's RTI returns
  // past the CWAI. Measured against MAME, which takes the interrupt at the next instruction boundary.
  e('        CLR     <IRQN');
  e('        CLR     $FF03');
  e('        LDA     #$FF');
  e('        STA     $FF02');
  e('        LDA     #$04');
  e('        STA     $FF03');
  e('        CLR     $FF02');
  e('        LDA     #$05');
  e('        STA     $FF03');
  e('        CWAI    #$EF            ; AND CC with $EF (unmask IRQ), stack, wait for the field sync');
  e('        ORCC    #$50');
  e('        LDA     <IRQN');
  e(`        STA     ${b(0x06)}`);
  e('        CLR     $FF03');
  // SYNC: stop until an unmasked interrupt, take it, and continue after the SYNC (nothing is stacked by
  // the SYNC itself; the interrupt stacks its own frame).
  e('        CLR     <IRQN');
  e('        CLR     $FF03');
  e('        LDA     #$FF');
  e('        STA     $FF02');
  e('        LDA     #$04');
  e('        STA     $FF03');
  e('        CLR     $FF02');
  e('        LDA     #$05');
  e('        STA     $FF03');
  e('        ANDCC   #$EF');
  e('        SYNC                    ; waits for the field sync, then takes its IRQ and returns here');
  e('        ORCC    #$50');
  e('        LDA     <IRQN');
  e(`        STA     ${b(0x07)}`);
  e('        CLR     $FF03');
  e('');
}
// clear of the instruction blocks' own results (0x000-0x096 emulating, 0x300-0x396 native)
interrupts(0x200);
e('        LDMD    #$01            ; native mode: the same block, with the wider frames');
e('');
interrupts(0x500);
e('        LDMD    #$00');
e('        ANDCC   #$D0            ; a known condition code going into the trap and HALT');
e('');

// ---- error trap: divide by zero ----
// The opcodes the hardware does not have but MAME executes, and one that is undefined in both: the only
// cases where this core's default and mameCompat differ in *behaviour*, not just in cycles. The sweep runs
// with mameCompat, so these compare our compat path against MAME. Before this block they appeared nowhere
// in the firmware, which is why the comparison could not see them.
e('; ---------------- opcodes MAME has and the hardware does not ----------------');
e('        LDMD    #$00            ; emulation mode, as the rest of the trap section');
// $098/$09A/$09C: just past the instruction blocks' own results (0x000-0x096 emulating, 0x300-0x396
// native, see the section header above). The first version of this block stored to $33C/$33E/$340, which
// the native block already writes (ADDR D,X / ADDR D,W / ORR D,W) -- so it silently destroyed three of its
// results. The lockstep could not see that (both emulators were equally clobbered) but the stored values
// were not what the block claimed to record.
e('        LDW     #$1234');
e('        FCB     $10,$50         ; NEGW: runs as NEG16 under mameCompat');
e('        STW     >BUF+$098');
e('        LDW     #$1234');
e('        FCB     $10,$57         ; ASRW');
e('        STW     >BUF+$09A');
e('        LDW     #$8001');
e('        FCB     $10,$58         ; ASLW');
e('        STW     >BUF+$09C');
e('        FCB     $10,$20         ; $1020: illegal on the 6309 (Atkinson note 4, p. 153)');
e('RESIL   NOP                      ; the illegal trap returns here');
e('');
e('; ---------------- divide-by-zero trap ----------------');
e('        LDD     #$0010');
e('        DIVD    #$00            ; must vector through $FFF0');
e('RESDIV  NOP                      ; the divide trap returns here');
e('');

// ---- HALT: the lockstep check requires the firmware to stop here ----
e('HALT    BRA     HALT');
e('');
// A subroutine for the native block's JSR, placed after HALT so the fall-through never reaches it (only the
// JSR does, and its RTS returns to the NOP after the call).
e('LSUB    RTS');
e('');
// The vectors must sit at the top of the ROM window the machine maps, and that window is 16K on the
// Dragon/CoCo and 32K on the CoCo 3: the CPU reads $FFF0-$FFFF from the last 32 bytes of the internal ROM
// (js/machines/sam.js and js/machines/coco3.js both map them there), so the image offset is $3FF0 for a 16K
// image and $7FF0 for a 32K one. VECTOR_BASE is set by --vectors; trace() assembles the image with the
// offset its profile needs, and both the vectors and the trap marker follow it.
// ---- the trap handler ----
// Both exceptions vector here ($FFF0), and both stack a PC that already points PAST the faulting
// instruction, so there is no fix-up: the handler records what it can see and returns with a bare RTI, and
// the firmware carries on to the next case. Measured on MAME 0.289, both traps placed at $1000: the 2-byte
// illegal $10,$20 stacks $1002, the 3-byte DIVD #$00 stacks $1003, each leaving its own MD bit set (6 = IL,
// 7 = /0). Atkinson p.59 (DIVD) and p.153 note 4 (undefined opcodes) say the state is stacked and the vector
// taken; neither says where the stacked PC points, so those figures are measured, not quoted.
//
// The two status bits are read with BITMD (Atkinson printed p.33), which ANDs MD bit 7 (/0) or bit 6 (IL)
// with the immediate and sets Z when the tested bit is clear. It does NOT clear the bit on MAME 0.289
// (measured: MD stays $40 after BITMD #$40), so the bits ACCUMULATE across exceptions: by the second trap
// here both are set. That is why the handler composes the two test results into B instead of taking the
// first hit as "the kind" -- Atkinson's "at most one of these flags will be set" presumes a clear that MAME
// does not perform. B therefore ends up holding MD's two status bits, which is the useful record.
//
// The stacked PC goes to BUF for the final RAM contents and is also left in X and W, because the lockstep
// compares registers instruction by instruction and never RAM: without that a wrong stacked PC would be
// invisible to the comparison.
//
// The frame is the EMULATION one -- 12 bytes, PC at S+10 (measured: S falls by $0C) -- because the trap
// section runs in emulation mode (the native frame is 14 bytes and puts PC at S+12), and --
// the block is preceded by LDMD #$00. The handler cannot choose between the two frames at run time: a trap
// sets CC.E in BOTH modes, so the stacked CC does not say which, and BITMD cannot read NM (Atkinson p.33
// says so explicitly, p.143 repeats it). A trap taken in native mode would need a second handler; none is
// taken here, and tests/cpu6309.test.js covers the native frame at CPU level.
e('TRAP    PSHS    A,B,X           ; leave the interrupted registers as they were found');
e('        CLRB');
e('        BITMD   #$40            ; IL (MD bit 6): Z set when it is clear');
e('        BNE     TRIL');
e('        BRA     TRDIV');
e('TRIL    ORB     #$40');
e('TRDIV   BITMD   #$80            ; /0 (MD bit 7): Z set when it is CLEAR, so BEQ skips the set');
e('        BEQ     TRMARK');
e('        ORB     #$80');
e('TRMARK  STB     >BUF+$7FE       ; the exception status bits at this trap');
e('        LDX     14,S            ; the stacked PC: CC,A,B,DP,X,Y,U,PC from the frame top, at S+4 here');
e('        STX     >BUF+$7F0       ; where the trap resumes');
e('        TFR     X,W             ; and in a register, which is what the lockstep compares');
e('        PULS    A,B,X');
e('        RTI');
e('');
// Interrupt handlers. Each counts, records the CC it found stacked (the frame shape), clears the PIA flag
// that raised it (a read of the port) and returns through RTI. An IRQ/CWAI frame is the whole state, so RTI
// restores everything; a plain FIRQ frame is only CC and PC, so the handler saves and restores the registers
// it touches, and its RTI restores CC and PC.
e('IRQH    INC     <IRQN');
e('        LDA     ,S              ; the stacked CC (top of the whole-state frame)');
e('        STA     <IRQCC');
// The flag is cleared by reading the PIA's PORT, not its control register (MAME 6821pia.cpp: control_b_r
// only reports the flags; port_b_r clears them, and this core's mc6821.js does the same). That read also
// loads A with the port's pins, which are unconnected on the Dragon, so A is saved and restored around it.
e('        PSHS    A');
e('        LDA     $FF02           ; read PIA0 port B: clears the CB1 (field sync) flag');
e('        PULS    A');
e('        RTI');
e('');
e('FIRQH   PSHS    A               ; CC and PC only are stacked, so the handler must save what it uses');
e('        INC     <FIRQN');
e('        LDA     1,S             ; the stacked CC (just above the saved A)');
e('        STA     <FIRQCC');
e('        LDA     $FF22           ; read PIA1 port B: clears the CB1 (CART) flag');
e('        PULS    A');
e('        RTI');
e('');
e('NMIH    INC     <NMIN');
e('        LDA     ,S');
e('        STA     <NMICC');
e('        RTI');
e('');
e(`        ORG     ${VECTORS}          ; the vectors at the top of the ROM window`);
e('        FDB     TRAP            ; $FFF0: illegal instruction / divide by zero');
e('        FDB     HALT            ; $FFF2: SWI3');
e('        FDB     HALT            ; $FFF4: SWI2');
e('        FDB     FIRQH           ; $FFF6: FIRQ');
e('        FDB     IRQH            ; $FFF8: IRQ');
e('        FDB     HALT            ; $FFFA: SWI');
e('        FDB     NMIH            ; $FFFC: NMI');
e('        FDB     RESET           ; $FFFE: reset');
e('');
e('        END');

const out = path.join(__dirname, OUT);
// writeAtomic, as main's tools/mame-diff/lib/firmware.js does: the spec regenerates this file and then
// assembles it in the same run, and a plain write lets the assembler read a half-written file.
writeAtomic(out, L.join('\n') + '\n');
console.log(`wrote ${path.relative(path.join(__dirname, '../../..'), out)} (${L.length} lines)`);
