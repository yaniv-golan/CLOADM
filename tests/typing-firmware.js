// The scanning firmware tests/claude-typing.test.js and tests/cli-type.test.js type into (written for CLOADM; no ROM code): it reads the
// keyboard matrix column by column, logs every NEW press as column*8+row (at $0340 on, count at $0300; the MC-10's at $4350 on, count at
// $4300), and is busy where a line editor or a scroll is busy, reading no keys: after each ENTER, and every fourth pass over the keyboard.
// busy: 'busy' = ten frames without reading the keyboard after ENTER; 'hang' = never read it again after ENTER.
module.exports = function firmware(six, enterCode, busy) {
  const after = busy === 'hang' ? 'HANG    BRA     HANG' : six === '6809'
    ? `        LDX     #18750\nBUSY    LEAX    -1,X\n        BNE     BUSY`
    : `        LDX     #25000\nBUSY    DEX\n        BNE     BUSY`;
  // also busy every 4 passes over the keyboard, whatever is pressed (as BASIC is while it scrolls or prints): a
  // key held for a fixed time can come and go inside such a stretch, and two presses of one key can merge into one
  const every = busy === 'hang' ? '' : six === '6809'
    ? `        INC     $0336\n        LDA     $0336\n        CMPA    #4\n        BNE     SCAN\n        CLR     $0336\n        LDX     #18750\nIDLE    LEAX    -1,X\n        BNE     IDLE\nSCAN    EQU     *`
    : `        INC     $4336\n        LDA     $4336\n        CMPA    #4\n        BNE     SCAN\n        CLR     $4336\n        LDX     #25000\nIDLE    DEX\n        BNE     IDLE\nSCAN    EQU     *`;
  if (six === '6809') return `
        ORG     $8000
START   LDS     #$3F00
        LDA     #$5A
        STA     $0301
        CLR     $FF03
        LDA     #$FF
        STA     $FF02
        LDA     #$04
        STA     $FF03
        CLR     $FF01
        CLR     $FF00
        LDA     #$04
        STA     $FF01
        LDA     #$FF
        STA     $FF02
        CLR     $0300
        CLR     $0335
        LDU     #$0340
        LDX     #$0320
        LDB     #8
INIT    LDA     #$FF
        STA     ,X+
        DECB
        BNE     INIT
LOOP    EQU     *
${every}
        CLRB
COL     STB     $0331
        LDX     #STB
        LDA     B,X
        STA     $FF02
        LDA     $FF00
        ORA     #$80
        STA     $0330
        LDX     #$0320
        LDB     $0331
        LDA     B,X
        STA     $0334
        LDA     $0330
        COMA
        ANDA    $0334
        STA     $0333
        LDA     $0330
        STA     B,X
        LDA     $0333
        BEQ     NEXT
        CLR     $0332
BIT     LSRA
        BCC     NOB
        PSHS    A
        LDA     $0331
        LSLA
        LSLA
        LSLA
        ORA     $0332
        STA     ,U+
        INC     $0300
        CMPA    #${enterCode}
        BNE     NOBUSY
${after}
NOBUSY  PULS    A
NOB     INC     $0332
        TSTA
        BNE     BIT
NEXT    LDB     $0331
        INCB
        CMPB    #8
        BNE     COL
        BRA     LOOP
STB     FCB     $FE,$FD,$FB,$F7,$EF,$DF,$BF,$7F
`;
  return `
        ORG     $E000
START   LDS     #$01FF
        LDA     #$5A
        STA     $4301
        LDA     #$FF
        STA     $00
        CLR     $4300
        LDX     #$4350
        STX     $4340
        LDX     #$4320
        LDB     #8
INIT    LDA     #$FF
        STA     0,X
        INX
        DECB
        BNE     INIT
LOOP    EQU     *
${every}
        CLRB
COL     STB     $4331
        LDX     #STB
        ABX
        LDA     0,X
        STA     $02
        LDA     $BFFF
        ORA     #$80
        STA     $4330
        LDX     #$4320
        LDB     $4331
        ABX
        LDA     0,X
        STA     $4334
        LDA     $4330
        COMA
        ANDA    $4334
        STA     $4333
        LDA     $4330
        STA     0,X
        LDA     $4333
        BEQ     NEXT
        CLR     $4332
BIT     LSRA
        BCC     NOB
        PSHA
        LDX     $4340
        LDA     $4331
        ASLA
        ASLA
        ASLA
        ORA     $4332
        STA     0,X
        INX
        STX     $4340
        INC     $4300
        CMPA    #${enterCode}
        BNE     NOBUSY
${after}
NOBUSY  PULA
NOB     INC     $4332
        TSTA
        BNE     BIT
NEXT    LDB     $4331
        INCB
        CMPB    #8
        BNE     COL
        BRA     LOOP
STB     FCB     $FE,$FD,$FB,$F7,$EF,$DF,$BF,$7F
`;
};
