        ORG     $3000
START   LDX     #$0400
        LDA     #$80
CLS     STA     ,X+
        CMPX    #$0600
        BNE     CLS
        LDX     #MSG
        LDY     #$04E6
PR      LDA     ,X+
        BEQ     SPIN
        STA     ,Y+
        BRA     PR
SPIN    INC     $3100
        BRA     SPIN
MSG     FCC     /STUCK/
        FCB     0
        END     START
