* ---------------- PLAY ----------------
* docs/clean-room-basic-p2.md section 6. PLAY s$: the music commands [UM]: A-G a note, # or + after it sharp, - flat;
* N n (or n alone) note 1-12 of the octave; O n octave 1-5, O+ and > up one, O- and < down one; L n length 1/n, with
* dots; T n tempo 1-255; V n volume; P n a pause of length 1/n; X var$; a substring; =var; for any number. Dots after a
* note or a length make it half as long again, a second dot a quarter, and so on [UM; OWN: a length's dots and the
* note's add up]. The settings last from one PLAY to the next until CLRVAR (RUN, NEW, CLEAR, cold start) sets the
* defaults again: O2, L4, T2, V15 [UM; whether they last, BB].
* Out of range or an unknown command: ?FC ERROR [OWN; BB]. BREAK is checked between commands.

* the constants the black-box measures fix, each one equate [OWN, BB pending]
NOTEA   EQU     44000           ; the A of octave 2, in 1/100 Hz
PLAYW   EQU     13885           ; a whole note at tempo 1, in 256 cycles (4 s): a note lasts PLAYW / (L x T)
PPER    EQU     1000            ; the period a pause is counted in (nothing is heard): its length is exact to it

* NTPER: the periods of octave 5's twelve notes, C first, in cycles (CPU 888,625 Hz [HW]); octave o's are 2^(5-o)
* times as long. Equal temperament [OWN]: each is 888625 / (NOTEA / 100 x 8 x 2^((k-9)/12)), k = 0 for C, written as
* 888625 x 100 x R / (NOTEA x 8 x 65536) rounded, R = 2^((9-k)/12) x 65536 rounded.
NTPER   FDB     (888625*200*110218/(NOTEA*8*65536)+1)/2         ; C
        FDB     (888625*200*104032/(NOTEA*8*65536)+1)/2         ; C#
        FDB     (888625*200*98193/(NOTEA*8*65536)+1)/2          ; D
        FDB     (888625*200*92682/(NOTEA*8*65536)+1)/2          ; D#
        FDB     (888625*200*87480/(NOTEA*8*65536)+1)/2          ; E
        FDB     (888625*200*82570/(NOTEA*8*65536)+1)/2          ; F
        FDB     (888625*200*77936/(NOTEA*8*65536)+1)/2          ; F#
        FDB     (888625*200*73562/(NOTEA*8*65536)+1)/2          ; G
        FDB     (888625*200*69433/(NOTEA*8*65536)+1)/2          ; G#
        FDB     (888625*200*65536/(NOTEA*8*65536)+1)/2          ; A
        FDB     (888625*200*61858/(NOTEA*8*65536)+1)/2          ; A#
        FDB     (888625*200*58386/(NOTEA*8*65536)+1)/2          ; B
* NTLET: the note number (1-12, C = 1) of the letters A-G
NTLET   FCB     10,12,1,3,5,6,8

* PLINIT: PLAY's defaults [UM], then the temporary strings freed (CLRVAR's last step, which calls it)
PLINIT  LDD     #2*256+4
        STD     PLOCT           ; O2, L4
        LDD     #2*256+15*4
        STD     PLTMP           ; T2, V15 (kept x 4)
        CLR     PLDOT
        JMP     RSTTMP

PLAY    JSR     CSTART
        JSR     SNDDAC
PY0     JSR     BRKCHK
PY1     JSR     CSGET
        BNE     PY2
        JSR     CSPOP
        BNE     PY1
        JMP     SNDMID
PY2     LDX     #PYTAB-3
PY3     LEAX    3,X
        LDB     ,X
        BEQ     PY4
        CMPA    ,X
        BNE     PY3
PY4     JSR     [1,X]
        BRA     PY0
* the commands: a character and its routine; the last, for any other character, a note
* (CSSUB, called from here, puts its frame at the loop's own stack level, as cmdstr.inc requires)
PYTAB   FCB     'X'
        FDB     CSSUB
        FCB     'O'
        FDB     PYO
        FCB     '>'
        FDB     PYUP
        FCB     '<'
        FDB     PYDN
        FCB     'L'
        FDB     PYL
        FCB     'T'
        FDB     PYT
        FCB     'V'
        FDB     PYV
        FCB     'P'
        FDB     PYP
        FCB     'N'
        FDB     PYN
        FCB     0
        FDB     PYLN

* O n, O+, O-, >, <: the octave 1-5
PYO     JSR     CSGET
        CMPA    #'+'
        BEQ     PYUP
        CMPA    #'-'
        BEQ     PYDN
        JSR     CSUNG
        BSR     PBYTE
        BRA     PYO2
PYUP    LDB     PLOCT
        INCB
        BRA     PYO2
PYDN    LDB     PLOCT
        DECB
PYO2    DECB
        CMPB    #4
        BHI     PFC
        INCB
        STB     PLOCT
        RTS
* L n (1-255) and its dots; T n (1-255); V n
PYL     BSR     PBYTE
        BEQ     PFC
        STB     PLLEN
        JSR     PDOTS
        STB     PLDOT
        RTS
PYT     BSR     PBYTE
        BEQ     PFC
        STB     PLTMP
        RTS
PYV     BSR     PBYTE           ; V 0-31 [UM 1-31; OWN: 0 is silent; BB]
        CMPB    #31
        BHI     PFC
        ASLB
        ASLB
        STB     PLVOL
        RTS

* P n: a pause of length 1/n, with its own dots [UM; the dots OWN]: a note of period PPER whose levels are written to
* RAM, so nothing is heard
PYP     BSR     PBYTE
        BEQ     PFC
        LDX     #PPER
        PSHS    X
        CLRA
        LDY     #FBUFFR
        LBRA    PYT2

* PBYTE: a number 0-255 into B, Z set for 0 (?FC ERROR if there is none, or for a value out of range)
PBYTE   JSR     CSNUM
        BCC     PFC
        TSTA
        BNE     PFC
        TSTB
        RTS
PFC     JMP     FCERR

* a letter A-G, or a number alone (a note number; anything else gives ?FC ERROR from PBYTE)
PYLN    SUBA    #'A'
        CMPA    #'G'-'A'
        BLS     PYLET
        ADDA    #'A'
        JSR     CSUNG
* N n: note 1-12
PYN     BSR     PBYTE
        DECB
        CMPB    #11
        BHI     PFC
        INCB
        BRA     PYNOTE
PYLET   LDX     #NTLET
        LDB     A,X
        JSR     CSGET
        CMPA    #'-'
        BEQ     PYFL
        CMPA    #'#'
        BEQ     PYSH
        CMPA    #'+'
        BEQ     PYSH
        JSR     CSUNG
        BRA     PYNOTE
PYFL    DECB
        DECB
PYSH    INCB
* PYNOTE: note B (0-13: C- of the octave is 0, B+ 13) of the current octave: its period, then its length
PYNOTE  PSHS    B
        LDA     PLOCT
        LDB     #12
        MUL
        ADDB    ,S+
        SUBB    #13             ; the semitone from octave 1's C: 0-59
        CMPB    #59
        BHI     PFC
        LDA     #5
PYN1    DECA
        SUBB    #12
        BCC     PYN1
        ADDB    #12             ; the note in its octave; A = 5 - the octave
        PSHS    A
        ASLB
        LDX     #NTPER
        LDD     B,X
PYN2    DEC     ,S
        BMI     PYN3
        ASLB
        ROLA
        BRA     PYN2
PYN3    LEAS    1,S
        PSHS    D               ; the period
        LDB     PLLEN
        LDA     PLDOT
        LDY     #PIA1A
PYT2    BSR     PLDUR
        LDA     #VMID*4         ; the levels: the middle + and - the volume [OWN; BB]
        ADDA    PLVOL
        LDB     #VMID*4
        SUBB    PLVOL
        TFR     D,U
        PULS    D
        JMP     TONE

* PDOTS: B = the dots that follow
PDOTS   CLRB
PDT1    JSR     CSGET
        CMPA    #'.'
        BNE     PDT2
        INCB
        BRA     PDT1
PDT2    JMP     CSUNG

* PLDUR: X = the length, in 256 cycles, of 1/B of a note with A dots and those that follow:
* PLAYW / (B x T) by restoring division, then each dot adds half the last part [OWN]. Keeps Y.
PLDUR   PSHS    D
        BSR     PDOTS
        ADDB    ,S
        STB     ,S              ; the dots; the length at 1,S
        LDB     1,S
        LDA     PLTMP
        MUL
        PSHS    D               ; the divisor
        LDD     #PLAYW
        PSHS    D               ; the dividend, then the quotient
        LDX     #16
        CLRA
        CLRB                    ; the remainder (below 2^15 even shifted, as PLAYW is)
PLD1    ASL     1,S
        ROL     ,S
        ROLB
        ROLA
        CMPD    2,S
        BLO     PLD2
        SUBD    2,S
        INC     1,S
PLD2    LEAX    -1,X
        BNE     PLD1
        PULS    D
        STD     ,S              ; the part a dot halves
PLD3    DEC     2,S
        BMI     PLD4
        LSR     ,S
        ROR     1,S
        ADDD    ,S
        BRA     PLD3
PLD4    TFR     D,X
        LEAS    4,S
        RTS

