* Bus-cycle diagnostic for the SAM's address-dependent rate (tools/mame-diff, written for CLOADM).
*
* At rate 01, a cycle is slow when its address is RAM ($0000-$7FFF) or $FF00-$FF1F and fast otherwise
* (MC6883 data sheet, p. 11), so an instruction's time shows which addresses it presents on each cycle.
* This runs one of every 6809 instruction class and addressing mode at that rate, first from ROM, then
* copied to RAM (where dummy reads of the byte at PC are slow and $FFFF cycles fast), with operands in RAM
* and ROM. run-xroar.js compares every instruction's time with XRoar's. Ends in HALT.
RAMB    EQU     $3000
        ORG     $8000
RESET   ORCC    #$50
        STA     $FFDD           ; 64K
        LDS     #$7F00
        LDU     #$6F00
        CLRA
        TFR     A,DP
        LDX     #$0000          ; clear $0000-$2FFF (MAME and we fill uninitialised RAM differently)
CL      CLR     ,X+
        CMPX    #$3000
        BNE     CL
        LDX     #BLK            ; copy the block to RAM
        LDY     #RAMB
CP      LDA     ,X+
        STA     ,Y+
        CMPX    #BLKEND
        BNE     CP
        STA     $FFD7           ; R0: address-dependent rate
        JSR     BLK             ; from ROM
        JSR     RAMB            ; from RAM
        STA     $FFD9           ; R1: fast
        JSR     BLK
        JSR     RAMB
        STA     $FFD8           ; back to address dependent
        JSR     RAMB
        STA     $FFD6           ; slow
        JSR     BLK
        LDA     #$01
HALT    BRA     HALT

SUBR    RTS                     ; in ROM
SWIH    RTI

* the block (position independent; operands at $0040 (direct page), $1234 and $2000 (RAM), $9000 and $A000 (ROM))
BLK     LDX     #$2000
        LDY     #$A000
        LDD     #$0102
        NOP
        LDA     #$12
        LDA     <$40
        LDA     $1234
        LDA     $9000
        STA     <$41
        STA     $1235
        LDD     <$42
        LDD     $9002
        STD     <$44
        STD     $1236
        CMPX    #$1234
        CMPX    <$46
        CMPX    $9004
        ADDD    #$0001
        ADDD    $1238
        LDY     #$A000
        LDY     <$48
        CMPY    $9006
        CMPU    #$6F00
        LDX     #$2000
        LDY     #$A000
* read-modify-write, register and memory
        NEGA
        TSTB
        CLRA
        COM     <$50
        INC     $1240
        DEC     $1241
        TST     <$51
        TST     $1242
        CLR     <$52
        CLR     $1243
        NEG     ,X
        TST     ,X
        CLR     1,X
* indexed modes (X in RAM, Y in ROM)
        LDA     ,X
        LDA     ,Y
        LDA     ,X+
        LDA     ,X++
        LDA     ,-X
        LDA     ,--X
        LDA     5,X
        LDA     -3,Y
        LDA     B,X
        LDA     A,Y
        LDA     $40,X
        LDA     $40,Y
        LDA     $1000,X
        LDA     D,X
        LDA     BLK,PCR
        LDA     $1000,PCR
        LDA     [,X]
        LDA     [$4,Y]
        LDA     [$1234]
        LDA     [,X++]
        LEAX    1,X
        LEAY    -1,Y
        LEAX    ,X
        LEAU    2,U
        LEAU    -2,U
* branches and subroutines
        BRA     B1
B1      BEQ     B2
B2      BNE     B3
B3      LBRA    B4
B4      LBEQ    B5
B5      LBNE    B6
B6      BSR     B7
        BRA     B8
B7      RTS
B8      LBSR    B9
        BRA     B10
B9      RTS
B10     JSR     SUBR
        JSR     [SUBP,PCR]
* stack, transfers, arithmetic
        PSHS    A
        PULS    A
        PSHS    D,X,Y,U
        PULS    D,X,Y,U
        PSHS    PC
        PULS    X
        PSHU    A,B
        PULU    A,B
        TFR     X,Y
        EXG     A,B
        EXG     X,Y
        ABX
        MUL
        DAA
        SEX
        ORCC    #$00
        ANDCC   #$FF
* software interrupts (handler in ROM)
        SWI
        SWI2
        SWI3
        RTS
SUBP    FDB     SUBR
BLKEND  EQU     *

        ORG     $9000
        FCB     $11,$22,$33,$44,$55,$66,$77,$88
        ORG     $A000
        FCB     $00,$90,$12,$34,$12,$40      ; pointers into cleared RAM
        ORG     $BF00
        FCB     $11
        ORG     $BFF2
        FDB     SWIH,SWIH,SWIH,SWIH,SWIH,SWIH,RESET
        END     RESET
