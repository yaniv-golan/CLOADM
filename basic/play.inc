* ---------------- PLAY ----------------
* docs/clean-room-basic-p2.md section 6. PLAY s$: the music commands [UM]: A-G a note, # or + after it sharp, - flat;
* N n (or n alone) note 1-12 of the octave; O n octave 1-5, O+ up one, O- down one; L n length 1/n, with dots; T n
* tempo 1-255; V n volume 0-31; P n a pause of length 1/n; X var$; a substring; =var; for any number. Dots after a
* length make it half as long again, a second dot a quarter, and so on [UM; OWN]; a dot anywhere else, and > or <, is
* ?FC ERROR after what came before it has played [BB bb2 snd-play-length dot-note, dot-both, pause-dot;
* snd-play-persist octave-modifiers]. The settings last from one PLAY to the next until CLRVAR (RUN, NEW, CLEAR, cold
* start) sets the defaults again: O3, L4, T2 and the default volume [UM; BB bb2 snd-play-persist; the octave BB
* snd-play-pitch default-a: the first PLAY's A is octave 3's, though the manual says O2]. Out of range or an unknown
* command: ?FC ERROR, sound off [BB]. BREAK is not checked [BB bb2 snd-timer break-play].

* the constants the black-box measures fix [BB bb2 snd-play-pitch, snd-play-length, snd-play-volume]
NOTEA   EQU     44000           ; octave 3's A in 1/100 Hz, for a CPU clock of 894,886 Hz (the NTSC machines'): the
*                                 45 measured periods fit 894886/NOTEA from 2033.53 to 2033.89 cycles
NOTEP   EQU     894886*1600/NOTEA ; octave 3's A, 16 x its period in cycles (32,541; 435.0 Hz on the Dragon)
PRND    EQU     40              ; in quarter cycles: the period is rounded down on its grid from 10 cycles above it
NGR3    EQU     20              ; octaves 3-5: the grid, 20 cycles; the period NAD3 more
NAD3    EQU     3
NGR1    EQU     32              ; octaves 1-2: the grid 32 cycles, NAD1 more
NAD1    EQU     11
PLAYW   EQU     256             ; a whole note at tempo 1, in fields: a note lasts PLAYW / (L x T) fields, rounded down
*                                 [BB bb2 snd-play-length: L1-L64 at T2, T1-T255 at L4, each n - 1 to n fields]
PVDEF   EQU     58              ; the default volume: the levels 46 and 17 (V15 gives 46 and 16) [BB snd-play-volume]
PPER    EQU     3460            ; a pause's period: four writes of the middle level, the sound left on [BB bb2 snd-play-length
*                                 pause4, pause8, pause16: a write every 865 cycles or so through the pause]

PLAY    JSR     MSSTR
        JSR     SNDDAC
PY0     JSR     MSCMD           ; (X var$; is run there; nothing of ours stays on the stack between commands)
        BCC     PY2
        JMP     PYEND
PY2     LDX     #PYTAB-3
PY3     LEAX    3,X
        LDB     ,X
        BEQ     PY4
        CMPA    ,X
        BNE     PY3
PY4     JSR     [1,X]
        BRA     PY0
* the commands: a character and its routine; the last, for any other character, a note
PYTAB   FCB     'O'
        FDB     PYO
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

* O n, O+, O-: the octave 1-5
PYO     JSR     MSGET
        BCS     PYO1
        CMPA    #'+'
        BEQ     PYUP
        CMPA    #'-'
        BEQ     PYDN
        JSR     MSBACK
PYO1    BSR     PBYTE
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
        CLRB                    ; the dots that follow
PDT1    JSR     MSGET           ; (keeps B)
        BCS     PDT3
        CMPA    #'.'
        BNE     PDT2
        INCB
        BRA     PDT1
PDT2    JSR     MSBACK
PDT3    STB     PLDOT
        RTS
PYT     BSR     PBYTE
        BEQ     PFC
        STB     PLTMP
        RTS
PYV     BSR     PBYTE           ; V 0-31: the levels 31 + V and 31 - V; V0 silent [UM 1-31; BB bb2 snd-play-volume]
        CMPB    #31
        BHI     PFC
        ASLB
        ASLB
        STB     PLVOL
        RTS

* P n: a pause of length 1/n [UM], without the length's dots [OWN]: a tone of period PPER with both halves at the
* volume's low level, the level a note ends on, so nothing is heard and the sound stays on [BB bb2 snd-play-length
* pause4: a pause and the note after it are one run]
PYP     BSR     PBYTE
        BEQ     PFC
        CLRA
        LBSR    PLDUR
        LDU     #VMID*256+VMID
        LDD     #PPER
        JMP     TONE
* PBYTE: a number 0-255 into B, Z set for 0 (?FC ERROR if there is none, or for a value out of range)
PBYTE   JSR     MSNUM
        BCS     PFC
        TSTB
        RTS
PFC     LBSR    PYEND
        JMP     <ZFCERR

* a letter A-G, or a number alone (a note number; anything else gives ?FC ERROR from PBYTE)
PYLN    SUBA    #'A'
        CMPA    #'G'-'A'
        BLS     PYLET
        JSR     MSBACK
* N n: note 1-12
PYN     BSR     PBYTE
        DECB
        CMPB    #11
        BHI     PFC
        INCB
        BRA     PYNOTE
PYLET   LDX     #NTLET
        LDB     A,X
        JSR     MSGET
        BCS     PYNOTE
        CMPA    #'-'
        BEQ     PYFL
        CMPA    #'#'
        BEQ     PYSH
        CMPA    #'+'
        BEQ     PYSH
        JSR     MSBACK
        BRA     PYNOTE
PYFL    DECB
        DECB
PYSH    INCB
* PYNOTE: note B (0-13: C- of the octave is 0, B+ 13) of the current octave: its period (NTPER above), its length,
* its levels, high first: the note ends low, and the period the last field interrupt lengthened is never completed
PYNOTE  PSHS    B
        LDA     PLOCT
        LDB     #12
        MUL
        ADDB    ,S+
        SUBB    #13             ; the semitone from octave 1's C: 0-59
        CMPB    #59
        BHI     PFC
        CLRA
PYN1    INCA
        SUBB    #12
        BCC     PYN1
        ADDB    #12             ; A = the octave 1-5, B = the note in it, 0-11
        PSHS    A
        ASLB
        LDX     #NTPER
        LDX     B,X
        CMPA    #3              ; (C set below octave 3; the loads keep it)
        LDD     #NGR3*256+NAD3
        BCC     PYN2
        LDD     #NGR1*256+NAD1
PYN2    PSHS    D               ; the grid, PC, the octave
        TFR     X,D
PYN3    DEC     2,S
        BEQ     PYN4
        LSRA
        RORB
        BRA     PYN3
PYN4    ADDD    #PRND
        LSRA
        RORB
        LSRA
        RORB                    ; y, in cycles
        PSHS    D
PYN5    SUBB    2,S             ; y's remainder on the grid
        SBCA    #0
        BCC     PYN5
        ADDB    2,S
        SUBB    3,S
        NEGB
        SEX
        ADDD    ,S++            ; y rounded down to the grid, plus NAD
        LEAS    3,S
        PSHS    D               ; the period
        LDB     PLLEN
        LDA     PLDOT
        BSR     PLDUR
        BSR     PLEVS
        TFR     D,U
        PULS    D
        JMP     TONE

* PYEND: sound off, then the volume's high level on the DAC, unheard: where the next sound starts from [BB bb2
* snd-audio: sound off after PLAY; snd-play-volume v1, v0: the next PLAY starts from the last one's high level]
PYEND   JSR     SNDOFF
        BSR     PLEVS
        STA     PIA1A
        RTS
* PLEVS: the volume's levels, A high (126 + v) and B low (126 - v), bits 0-1 clear [OWN; BB the levels]
PLEVS   LDA     #VMID+2
        ADDA    PLVOL
        ANDA    #$FC
        LDB     #VMID+2
        SUBB    PLVOL
        ANDB    #$FC
        RTS

* PLDUR: X = the length, in fields, of 1/B of a note with A dots: PLAYW / (B x T) by restoring division, then each
* dot adds half the last part [OWN], at most 255
PLDUR   PSHS    D
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
PLD4    TSTA                    ; at most 255 fields [BB bb2 snd-timer break-play: T1 L1 lasts 255]
        BEQ     PLD5
        LDD     #255
PLD5    TFR     D,X
        LEAS    4,S
        RTS
