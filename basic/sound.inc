* ---------------- sound: the tone loop, SOUND, AUDIO, JOYSTK ----------------
* docs/clean-room-basic-p2.md sections 6 and 7. The hardware [HW: js/machines/cocopia.js]: the 6-bit DAC is PIA 1
* port A bits 2-7; the speaker hears it when the multiplexer selects it (PIA 0 CA2 and CB2 low) and sound is on
* (PIA 1 CB2 high). The multiplexer also picks what the joystick comparator (PIA 0 PA7) sees: CB2 the joystick (low
* the right one), CA2 the axis (low x). The wave is our own square wave [OWN, decision 3]; its pitch, length and
* loudness are what must match the original, and each is one equate here (the PLAY ones in play.inc).

VMID    EQU     124             ; the DAC byte at the wave's middle: level 31, a pause's level [OWN]
SNDH    EQU     252             ; SOUND's levels: 63 and 0, full scale [BB bb2 snd-sound, snd-audio, snd-timer]
SNDL    EQU     0
SNDU    EQU     4               ; SOUND's unit: 4 fields (0.08 s) [BB bb2 snd-sound d1-d20: 4d-1 to 4d fields]
SNDP0   EQU     100             ; SOUND t's period: SNDP0 + SNDPK x (256 - t) cycles [BB bb2 snd-sound: 5,200 at t = 1,
SNDPK   EQU     20              ;   4,220, 3,220, 2,220, 1,220, 120 at 50, 100, 150, 200, 255; exact]
TOVH    EQU     55              ; the tone loop's cycles a period outside its delay loops (counted below)

* AUDIO ON: the cassette input to the speaker (the multiplexer: CA2 high, CB2 low), sound on [UM; HW]; AUDIO OFF:
* sound off, the multiplexer as it is [BB bb2 snd-audio: off with the multiplexer still on the cassette]
AUDIO   CMPA    #T_ON
        BEQ     AU1
        CMPA    #T_OFF
        LBNE    SNERR
        BSR     SNDOFF
        BRA     AU2
AU1     LDB     #$3C            ; PIA 0 control A: CA2 output high
        BSR     SNDSEL
AU2     JMP     <ZCHRGET
* SNDDAC: the multiplexer to the DAC and sound on; SNDSEL: the same with B as PIA 0's control A (CB2, the other
* half of the multiplexer, is always low outside JOYSTK); SNDOFF: sound off. Keep A, X, Y, U.
SNDDAC  LDB     #$34
SNDSEL  STB     PIA0CA
        LDB     #$3C            ; PIA 1 CB2 high: sound on
        FCB     $8C             ; (CMPX #: skips the LDB)
SNDOFF  LDB     #$34            ; PIA 1 CB2 low: sound off
        STB     PIA1CB
        RTS

* SOUND t,d: tone t (1-255, higher is higher) for d (1-255) units [UM]; it ends with the DAC low and sound off, the
* multiplexer on the DAC [BB bb2 snd-audio, snd-timer: the next sound starts from level 0]
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
        LDU     #SNDH*256+SNDL
        BSR     TONE
        BRA     SNDOFF
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

* TONE: a square wave of period D cycles (111 or more) for X fields: the first level (U's high byte), then the
* second (U's low byte), each written to the DAC. A period is TOVH + 8 (k1 + k2) + 5 (j + 1) cycles: the first
* half k1 passes of an 8-cycle loop and j + 1 of a 5-cycle one, the second half k2 passes; with n = D - TOVH,
* j = (5n - 1) AND 7 (so that n - 5 (j + 1) is a multiple of 8; 5 x 5 = 25 = 1 modulo 8), k1 + k2 = (n - 5 (j + 1)) / 8,
* k2 half of that rounded down, so every period is exact to the cycle; the field interrupt, which TIMER counts,
* lengthens the period it falls in [OWN]. The length is counted in fields, as the original's is [BB bb2 snd-sound,
* snd-play-length: each length falls between X - 1 and X fields; snd-timer: TIMER counts during a note]: the wave
* stops at the end of the first period in which TIMER reached its value at the start plus X, so the period the
* interrupt lengthened is never completed [OWN], and a note of 0 fields plays 3 periods (it still has a pitch) [OWN;
* BB snd-play-length t255]. The wave ends on its second level.
* The frame on the stack, at U: k1 (0-1), k2 (2-3), the levels (4-5), j (6), the periods still to play once TIMER is
* reached (7), TIMER's value to stop at (8-9), the period (10-11).
TONE    PSHS    D
        TFR     X,D
        ADDD    <TIMER
        PSHS    D               ; the end
        CLRA
        LEAX    ,X
        BNE     TN0
        LDD     2,S             ; a note of 0 fields: its first two periods each end 10 cycles later (DEC, BPL)
        SUBD    #10
        STD     2,S
        LDA     #2
TN0     PSHS    A
        LDD     3,S
        SUBD    #TOVH
        TFR     D,X             ; n
        LDA     #5
        MUL
        DECB
        ANDB    #7              ; j
        PSHS    B
        INCB
        LDA     #5
        MUL
        PSHS    D               ; 5 (j + 1)
        TFR     X,D
        SUBD    ,S++
        LSRA
        RORB
        LSRA
        RORB
        LSRA
        RORB                    ; k1 + k2
        PSHS    U               ; the levels
        TFR     D,X
        LSRA
        RORB                    ; k2
        PSHS    D
        TFR     X,D
        SUBD    ,S              ; k1
        PSHS    D
        TFR     S,U
        LDY     #PIA1A
* one period: 17 + 5 + 15 + 18 = 55 cycles, TOVH, besides the delay loops' passes. The interrupt is held off from
* reading TIMER to the first level's write, so a field that ends the note never lengthens a period that is completed.
TN1     LDA     4,U             ; 5  the first level
        STA     ,Y              ; 4
        ANDCC   #$EF            ; 3
        LDX     ,U              ; 5
TN1A    LEAX    -1,X            ; 5
        BNE     TN1A            ; 3
        LDB     6,U             ; 5
TN1B    DECB                    ; 2  (j + 1 passes)
        BPL     TN1B            ; 3
        LDA     5,U             ; 5  the second level
        STA     ,Y              ; 4
        LDX     2,U             ; 6
TN2     LEAX    -1,X            ; 5
        BNE     TN2             ; 3
        ORCC    #$10            ; 3
        LDD     <TIMER          ; 5
        SUBD    8,U             ; 7
        BMI     TN1             ; 3
        DEC     7,U             ; (only once TIMER is reached)
        BPL     TN1
        LEAS    12,S
        ANDCC   #$EF
        RTS
