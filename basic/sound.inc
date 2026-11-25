* ---------------- sound: the tone loop, SOUND, AUDIO, JOYSTK ----------------
* docs/clean-room-basic-p2.md sections 6 and 7. The hardware [HW: js/machines/cocopia.js]: the 6-bit DAC is PIA 1
* port A bits 2-7; the speaker hears it when the multiplexer selects it (PIA 0 CA2 and CB2 low) and sound is on
* (PIA 1 CB2 high). The multiplexer also picks what the joystick comparator (PIA 0 PA7) sees: CB2 the joystick (low
* the right one), CA2 the axis (low x). The wave is our own square wave [OWN, decision 3]; its pitch, length and
* loudness are what must match the original, and each is one equate here (the PLAY ones in play.inc).

VMID    EQU     32              ; the DAC level the wave swings around [OWN]
VSND    EQU     31              ; SOUND's swing: full volume [UM; the level OWN, BB pending]
SNDU    EQU     208             ; SOUND's unit, in 256 cycles: 53,248 cycles, 0.06 s [UM about 0.06 s; OWN, BB pending]
SNDP0   EQU     150             ; SOUND t's period: SNDP0 + SNDPK x (256 - t) cycles [OWN, BB pending]
SNDPK   EQU     20
SNDMSK  EQU     $10             ; ORCC'd during a tone: $10 masks the field interrupt, so a note's every period is
*                                 exact and TIMER stops while it plays; 0 would let TIMER count, each field then
*                                 adding the interrupt's cycles to one period [OWN, BB pending: decision 4]
TOVH    EQU     72              ; the tone loop's cycles a period outside its delay loops (counted below)

* AUDIO ON: the cassette input to the speaker (the multiplexer: CA2 high, CB2 low), sound on; AUDIO OFF: the
* multiplexer back to the DAC [UM; HW]
AUDIO   LDB     #$3C            ; PIA 0 control A: CA2 output high
        CMPA    #T_ON
        BEQ     AU1
        LDB     #$34            ; CA2 low
        CMPA    #T_OFF
        LBNE    SNERR
AU1     BSR     SNDSEL
        JMP     <ZCHRGET
* SNDDAC: the multiplexer to the DAC and sound on; SNDSEL: the same with B as PIA 0's control A (CB2, the other
* half of the multiplexer, is always low outside JOYSTK). Keep A, X, Y, U.
SNDDAC  LDB     #$34
SNDSEL  STB     PIA0CA
        LDB     #$3C            ; PIA 1 CB2 high: sound on
        STB     PIA1CB
        RTS

* SOUND t,d: tone t (1-255, higher is higher) for d (1-255) units [UM]
SOUND   JSR     GETBYT
        TSTB
        BEQ     SNFC
        PSHS    B
        JSR     COMBYT
        TSTB
        BEQ     SNFC
        LDA     #SNDU
        MUL
        TFR     D,X
        BSR     SNDDAC
        PULS    B
        NEGB                    ; 256 - t
        LDA     #SNDPK
        MUL
        ADDD    #SNDP0
        LDU     #(VMID+VSND)*1024+(VMID-VSND)*4
        LDY     #PIA1A
        BSR     TONE
* SNDMID: the DAC back to its middle
SNDMID  LDA     #VMID*4
        STA     PIA1A
        RTS
SNFC    JMP     FCERR

* JOYSTK(n): axis n (0 right x, 1 right y, 2 left x, 3 left y), 0-63 [UM]. JOYSTK(0) reads all four and keeps them;
* 1-3 give what it kept [UM; BB]. Each axis by successive approximation on the DAC, from bit 5 down: a bit stays if
* the comparator says the axis is at or above the value tried [HW]. Sound is off while it reads, and the multiplexer
* goes back to the DAC after [OWN].
JOYSTK  JSR     <ZFNARGN
        JSR     CNVBYT
        CMPB    #3
        BHI     SNFC
        TSTB
        BNE     JY4
        LDA     PIA1CB
        PSHS    A               ; the sound switch
        LDA     #$34
        STA     PIA1CB
        LDX     #JOYV
        LDD     #$3435          ; PIA 0 control A and B: axis 0
JY1     STA     PIA0CA
        STB     PIA0CB
        PSHS    D
        CLRB
        LDA     #$80
JY2     PSHS    A
        ORB     ,S
        STB     PIA1A
        TST     PIA0A
        BMI     JY3
        EORB    ,S
JY3     PULS    A
        LSRA
        CMPA    #2
        BHI     JY2
        LSRB
        LSRB
        STB     ,X+
        PULS    D
        EORA    #8              ; the other axis
        BITA    #8
        BNE     JY1
        EORB    #8              ; the other joystick
        BITB    #8
        BNE     JY1
        STA     PIA0CA
        STB     PIA0CB          ; the multiplexer back to the DAC
        PULS    A
        STA     PIA1CB
        CLRB
JY4     LDX     #JOYV
        LDB     B,X
        CLRA
        JMP     GIVNUM

* TONE: a square wave of period D cycles (163 or more) for X x 256 cycles, rounded down to whole periods: the high
* port value (U's high byte) then the low one (U's low byte), each written to Y (PIA1A; a pause writes RAM instead,
* so it is not heard). A period is TOVH + 16 k + 5 (j + 1) cycles: each half k 8-cycle passes, and j 0-15 5-cycle
* passes in the high half, so every period is exact to the cycle [OWN]: with n = D - TOVH, j = 13n AND 15 (so that
* n - 5j is a multiple of 16; 13 x 5 = 65 = 1 modulo 16) and k = (n - 5j) / 16. The length is counted in cycles: each
* period takes D from the 24-bit count, and the wave stops, low, when the count runs out [OWN, decision 4].
* The frame on the stack, at U: k (0-1), the levels (2-3), j (4), the period (5-6), the count (7-9).
TONE    ORCC    #SNDMSK
        CLR     ,-S             ; the count's low byte
        PSHS    X,D
        SUBD    #TOVH
        TFR     D,X             ; n
        LDA     #13
        MUL
        ANDB    #15             ; j
        PSHS    B
        LDA     #5
        MUL
        PSHS    D
        TFR     X,D
        SUBD    ,S++            ; 16k
        LSRA
        RORB
        LSRA
        RORB
        LSRA
        RORB
        LSRA
        RORB
        PSHS    U,D             ; the levels, k
        TFR     S,U
        BRA     TN3
* one period: 14 + 5 + 14 + 34 = 67 cycles; the delay loops' passes, and the 5 of j's last pass, make TOVH
TN1     LDA     2,U             ; 5  the high half
        STA     ,Y              ; 4
        LDX     ,U              ; 5
TN1A    LEAX    -1,X            ; 5
        BNE     TN1A            ; 3
        LDB     4,U             ; 5
TN1B    DECB                    ; 2  (j + 1 passes)
        BPL     TN1B            ; 3
        LDA     3,U             ; 5  the low half
        STA     ,Y              ; 4
        LDX     ,U              ; 5
TN2     LEAX    -1,X            ; 5
        BNE     TN2             ; 3
TN3     LDD     8,U             ; 6  the count less a period
        SUBD    5,U             ; 7
        STD     8,U             ; 6
        LDA     7,U             ; 5
        SBCA    #0              ; 2
        STA     7,U             ; 5
        BCC     TN1             ; 3
        LEAS    10,S
        ANDCC   #$EF
        RTS
