* screen80.asm - a CoCo 3 program (no ROMs needed) that shows a message on the GIME's 80-column text screen with
* attribute bytes. The screen is in physical RAM at $60000 (block $30). The program writes it through CPU $4000
* (slot 2 mapped to block $30), then maps slot 2 back, so the CPU cannot see the screen any more.
        ORG     $3000
START   ORCC    #$50
        LDA     #$40            ; GIME mode, MMU on, task 0
        STA     $FF90
        LDX     #$FFA0          ; task 0: slot n = block $38 + n
        LDA     #$38
MMU     STA     ,X+
        INCA
        CMPX    #$FFA8
        BNE     MMU
        LDA     #$30            ; slot 2 ($4000-$5FFF) -> block $30 (physical $60000)
        STA     $FFA2
        LDX     #$4000          ; clear 24 rows of 80 characters: space, white on black
        LDD     #$2008
CLR     STD     ,X++
        CMPX    #$4000+160*24
        BLO     CLR
        LDX     #$4000+160*3+2*10
        LDU     #MSG1
        LDA     #$08            ; plain
        BSR     PUT
        LDX     #$4000+160*5+2*10
        LDU     #MSG2
        LDA     #$48            ; underlined
        BSR     PUT
        LDX     #$4000+160*5+2*16
        LDU     #MSG3
        LDA     #$08
        BSR     PUT
        LDA     #$03            ; text, 8 lines a row
        STA     $FF98
        LDA     #$15            ; 80 columns with attributes
        STA     $FF99
        CLR     $FF9C
        LDA     #$C0            ; video start $60000
        STA     $FF9D
        CLR     $FF9E
        CLR     $FF9F
        LDA     #$3A            ; slot 2 back to its own block
        STA     $FFA2
        CLR     $4000+160*3+2*10   ; this lands in block $3A, not on the screen
DONE    BRA     DONE
* write the string at U (ending in 0) to X, each character followed by attribute A
PUT     LDB     ,U+
        BEQ     PUTX
        STB     ,X+
        STA     ,X+
        BRA     PUT
PUTX    RTS
MSG1    FCC     /THE ORCHARD GATE OPENS AT 7:45/
        FCB     0
MSG2    FCC     /BRING/
        FCB     0
MSG3    FCC     /THE BRASS KEY/
        FCB     0
        END     START
