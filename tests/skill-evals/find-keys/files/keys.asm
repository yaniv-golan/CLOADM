        ORG     $3000
START   LDS     #$3F00
        CLR     $3100
        LDA     #16
        STA     $3100
        LDA     #$6A
        STA     $3101
        CLR     $3102
LOOP    LDX     #$0500
        LDA     #$60
CLR1    STA     ,X+
        CMPX    #$0520
        BNE     CLR1
        LDX     #$0500
        LDB     $3100
        ABX
        LDA     $3101
        STA     ,X
        LDA     #$FD
        STA     $FF02
        LDA     $FF00
        BITA    #$10
        BNE     K2
        LDA     $3100
        BEQ     K2
        DEC     $3100
K2      LDA     #$FE
        STA     $FF02
        LDA     $FF00
        BITA    #$10
        BNE     K3
        LDA     $3100
        CMPA    #31
        BEQ     K3
        INC     $3100
K3      LDA     #$7F
        STA     $FF02
        LDA     $FF00
        BITA    #$20
        BNE     WAIT
        INC     $3102
        LDA     #$63
        STA     $3101
WAIT    LDA     #$FF
        STA     $FF02
        LDY     #3000
DLY     LEAY    -1,Y
        BNE     DLY
        BRA     LOOP
        END     START
