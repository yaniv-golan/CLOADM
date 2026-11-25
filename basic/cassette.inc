* ---------------- the cassette ----------------
* CSAVE, CLOAD, CSAVEM, CLOADM, SKIPF, MOTOR [UM]. The tape format [FMT] (docs/clean-room-basic.md section 11):
* every bit is one full cycle, 1200 Hz for 0 and 2400 Hz for 1, least significant bit first; a block is a leader
* of $55 bytes, the sync byte $3C, the block type ($00 the namefile, $01 data, $FF end of file), the length, the
* data and a checksum (the sum of the type, the length and the data). A file is a namefile block (the name padded
* with spaces to 8, the file type: 0 BASIC, 2 machine code, the ASCII flag, the gap flag, the exec address and the
* load address), its data in blocks of up to 255 bytes, and an end-of-file block.
* The hardware [HW]: the DAC on PIA 1 port A bits 2-7 drives the cassette output, PA0 reads the input, CA2 runs
* the motor. Interrupts are off while the tape is timed.

CTHR    EQU     42              ; CRBIT: fewer loop passes than this make a short cycle, a 1 [OWN]
CTHRH   EQU     23              ; the same for a high half alone (its loop is the first, 12 cycles a pass) [OWN]
CH0     EQU     66              ; CWBYTE: delay passes for a 1200 Hz cycle and a 2400 Hz one [OWN, from the
CH1     EQU     29              ; CPU's 888625 Hz clock and the loops' cycle counts]
CLEADN  EQU     128             ; leader bytes before every block written [FMT]
CDELAY  EQU     55000           ; about half a second after the motor starts, before writing [OWN]
MOTONV  EQU     $3C             ; PIA 1 control register A: CA2 output high (motor on), or low
MOTOFV  EQU     $34
CASBUF  EQU     $0600           ; a text file's block while its lines go in (graphics page 1) [OWN]

* MOTOR ON / MOTOR OFF [UM]
MOTOR   LDB     #MOTONV
        CMPA    #T_ON
        BEQ     MOT1
        LDB     #MOTOFV
        CMPA    #T_OFF
        LBNE    SNERR
MOT1    STB     PIA1CA
        JMP     <ZCHRGET

* ---------------- reading ----------------
* CRBIT: one bit: the time from this rising edge of the input to the next, in loop passes; C set for a short
* cycle (a 1). BREAK is not looked at: a search on a tape with no such file goes on until a reset [BB bb5 cas-errors].
* A quiet input after a bit's high half (a tape that ends with its last bit, with no $55 after the block) decides the
* bit by that half alone [OWN]. Uses A, B.
CRBIT   CLRB
CRB1    INCB
        LDA     PIA1A
        LSRA
        BCS     CRB1
        PSHS    B               ; the high half's passes
CRB2    INCB
        BEQ     CRQ
        LDA     PIA1A
        LSRA
        BCC     CRB2
        LEAS    1,S
        CMPB    #CTHR
        RTS
CRQ     PULS    B
        CMPB    #CTHRH
        RTS

* CRBYTE: a byte, least significant bit first, into A (and CBYTE)
CRBYTE  LDA     #8
        STA     <CCNT
CRBY1   BSR     CRBIT
        ROR     <CBYTE
        DEC     <CCNT
        BNE     CRBY1
        LDA     <CBYTE
        RTS

* CRBLK: the next block: wait for a leader and the sync byte after it, then CBTYP, CBLEN and the data to X on
* (X ends past it). Z set when the checksum is right. The motor is left running. When the block's leader is first
* heard, the letter at the top left of the screen (S or F, CFIND) changes between normal and inverse [BB bb4, bb5:
* one change a block, a little after its leader starts].
CRBLK   JSR     CASON
CRS0    CLR     <CLEAD
CRS1    BSR     CRBIT
        ROR     <CBYTE
        LDA     <CBYTE
        CMPA    #$55            ; in the leader: $55 or, a bit out, $AA
        BEQ     CRS2
        CMPA    #$AA
        BEQ     CRS2
        CMPA    #$3C
        BNE     CRS1
        TST     <CLEAD          ; the sync byte counts only after a leader
        BEQ     CRS1
        BSR     CRBYTE
        STA     <CBTYP
        STA     <CSUM
        BSR     CRBYTE
        STA     <CBLEN
        STA     <CBCNT
        ADDA    <CSUM
        STA     <CSUM
CRS3    TST     <CBCNT
        BEQ     CRS4
        BSR     CRBYTE
        STA     ,X+
        ADDA    <CSUM
        STA     <CSUM
        DEC     <CBCNT
        BRA     CRS3
CRS4    BSR     CRBYTE
        CMPA    <CSUM
        RTS
CRS2    TST     <CLEAD
        BNE     CRS2A
        LDB     SCREEN          ; (the first leader byte: the letter blinks)
        EORB    #$40
        STB     SCREEN
CRS2A   STA     <CLEAD
        BRA     CRS1

* the cassette's errors: the motor stops; a program half loaded is cleared. B = the error. ?IO ERROR leaves the
* file open (CLDBAS $FF): the next cassette statement is ?AO ERROR, which closes it [BB bb5 cas-errors: SKIPF after
* a CLOAD that met a bad block]
CLFM    LDB     #ERR_FM
        BRA     CASERR
CLOM    LDB     #ERR_OM
        BRA     CASERR
CLDS    LDB     #ERR_DS
        BRA     CASERR
CLIO    LDB     #ERR_IO
CASERR  JSR     CASOFF
        TST     <CLDBAS
        BEQ     CE1
        JSR     NEWPRG
CE1     CLR     <CLDBAS
        CMPB    #ERR_IO
        BNE     CE2
        DEC     <CLDBAS
CE2     JMP     ERROR

* CFIND: read namefile blocks until one has the name in CNAME (any, when CNLEN is 0); its block stays at LINBUF.
* The display [BB bb4, bb5 cas-display, cas-errors]: the screen cleared and S at the top left (blinking, CRBLK);
* a namefile met puts its name on the top row from the third cell; the file wanted F (normal) at the top left;
* another file is passed over to its end-of-file block, then the screen is cleared again, S (a search that starts in
* the middle of a file does not clear at that file's end [BB bb5 cas-errors]). The prompt or an error then prints on
* the second row.
CFIND   JSR     CLS
        LDA     #'S'
        STA     SCREEN
        LDX     #SCREEN+32
        STX     <CURPOS
CF1     LDX     #LINBUF
        JSR     CRBLK
        BNE     CF1             ; a bad block: not what we look for
        LDA     <CBTYP
        BNE     CF1             ; another file's data
        LDX     #LINBUF
        LDU     #CNAME
        LDB     <CNLEN
        BEQ     CF3
        LDB     #8
CF2     LDA     ,X+
        CMPA    ,U+
        BNE     CF4
        DECB
        BNE     CF2
CF3     BSR     CFNAME          ; (the name first, then F [BB: the flags' order])
        LDA     #'F'
        STA     SCREEN
        RTS
CF4     BSR     CFNAME
        BSR     CSKIP           ; the file passed over, then a clear screen
        BRA     CFIND
CFNAME  LDX     #SCREEN+2
        STX     <CURPOS
        LDX     #LINBUF
        LDB     #8
CFN1    LDA     ,X+
        JSR     <ZCHROUT
        DECB
        BNE     CFN1
        LDX     #SCREEN+32
        STX     <CURPOS
        RTS
* CSKIP: blocks read up to an end-of-file block
CSKIP   LDX     #LINBUF
        JSR     CRBLK
        LDA     <CBTYP
        INCA
        BNE     CSKIP
        RTS

* CLDATA: the data blocks of the file found, to X on, up to its end-of-file block. For a program (CLDBAS set)
* there must be room for a whole block below the stack [OWN]. ?IO ERROR on a bad checksum or a block out of place.
CLDATA  TST     <CLDBAS
        BEQ     CLD1
        TFR     S,D
        SUBD    #320
        PSHS    X
        CMPD    ,S++
        LBLO    CLOM
CLD1    JSR     CRBLK
        LBNE    CLIO
        LDA     <CBTYP
        INCA
        BEQ     CLD2
        CMPA    #2
        LBNE    CLIO
        BRA     CLDATA
CLD2    RTS

* CLOAD ["NAME"]: a program [UM]; CLOADM: machine code. After it, the OK prompt.
CLOAD   CMPA    #'M'
        LBEQ    CLOADM
        JSR     GETNAM
        JSR     CFIND
        LDA     LINBUF+8        ; a BASIC program, or a data file [BB bb5 cas-errors: ?DS ERROR]
        CMPA    #2
        LBHS    CLFM
        INC     <CLDBAS
        ORA     LINBUF+9        ; a data file, or a program saved as text
        BNE     CLASC
        LDX     <TXTTAB
        BSR     CLDATA
        STX     <VARTAB
        JSR     RELINK
CLDONE  CLR     <CLDBAS
        JSR     CASOFF
        JSR     CLRVAR
        JMP     READY
* a program saved as text, or a data file: the motor stops after each block, and its lines go in one by one as if
* typed; a line without a number is ?DS ERROR [UM's error list] once the whole file is read (CLDBAS 2) [BB bb5
* cas-errors: the data file's end-of-file block is read first]; a line over 250 characters is cut [OWN]
CLASC   JSR     NEWPRG
        LDU     #LINBUF
CLA1    LDX     #CASBUF
        JSR     CRBLK
        LBNE    CLIO
        JSR     CASOFF
        LDA     <CBTYP
        INCA
        BEQ     CLA4
        CMPA    #2
        LBNE    CLIO
        LDX     #CASBUF
        LDB     <CBLEN
        BEQ     CLA1
CLA2    LDA     ,X+
        CMPA    #13
        BNE     CLA3
        BSR     CLLINE
        BRA     CLA3A
CLA3    CMPU    #LINBUF+LINMAX
        BHS     CLA3A
        STA     ,U+
CLA3A   DECB
        BNE     CLA2
        BRA     CLA1
CLA4    BSR     CLLINE          ; a last line with no carriage return
        DEC     <CLDBAS
        LBNE    CLDS
        BRA     CLDONE
CLLINE  CLR     ,U
        PSHS    B,X
        JSR     CRUNCH
        LDX     #CRNBUF-1
        STX     <TXTPTR
        JSR     <ZCHRGET
        BEQ     CLL1
        BCS     CLL0
        LDA     #2              ; no number: ?DS ERROR at the end
        STA     <CLDBAS
        BRA     CLL1
CLL0    JSR     <ZLINGET
        JSR     EDLINE
CLL1    LDU     #LINBUF
        PULS    B,X,PC

* CLOADM ["NAME"][,offset]: a machine-code file to its load address plus the offset; EXEC with no address then
* runs it from its exec address, plus the offset too [UM; the offset on the exec address: OWN]
CLOADM  JSR     <ZCHRGET
        BSR     GETNAM
        CLRA
        CLRB
        STD     <CEND
        JSR     <ZCHRGOT
        BEQ     CLM1
        BSR     CADDR
        STD     <CEND
CLM1    JSR     CFIND
        LDA     LINBUF+8
        CMPA    #2
        LBNE    CLFM
        LDD     LINBUF+11
        ADDD    <CEND
        STD     <EXECAD
        LDD     LINBUF+13
        ADDD    <CEND
        TFR     D,X
        JSR     CLDATA
        BRA     CASOFF
* SKIPF ["NAME"]: past the file (the next one, without a name) [UM]
SKIPF   BSR     GETNAM
        JSR     CFIND
        JSR     CSKIP
        BRA     CASOFF

* CASON: interrupts off, the motor on. CASOFF: the motor off, interrupts on. Both keep B, X, U.
CASON   ORCC    #$50
        LDA     #MOTONV
        BRA     CSO1
CASOFF  ANDCC   #$AF
        LDA     #MOTOFV
CSO1    STA     PIA1CA
        RTS

* GETNAM: an optional file name (a string expression) into CNAME, padded with spaces to 8 (a longer one is cut
* [OWN]); CNLEN its length, 0 when there is none (any file will do)
GETNAM  TST     <CLDBAS
        BPL     GN0
        LDB     #ERR_AO         ; a file left open by ?IO ERROR (CASERR)
        LBRA    CE1
GN0     CLR     <CLDBAS
        LDX     #CNAME
        LDD     #$2008
GN1     STA     ,X+
        DECB
        BNE     GN1
        CLR     <CNLEN
        JSR     <ZCHRGOT
        BEQ     GN3
        CMPA    #','
        BEQ     GN3
        JSR     EVSTR
        JSR     FRESTR
        CMPB    #8
        BLS     GN2
        LDB     #8
GN2     STB     <CNLEN
        BEQ     GN3
        LDU     #CNAME
GN2A    LDA     ,X+
        STA     ,U+
        DECB
        BNE     GN2A
GN3     RTS

CADDR   JSR     COMMA
        JSR     <ZEVNUM
        JMP     GETADR


* ---------------- writing ----------------
* CWBYTE: A onto the tape, least significant bit first: each bit one cycle of a square wave on the DAC, high
* then low. Keeps B, X.
CWSUM   PSHS    A               ; (CWSUM: A added to the checksum first)
        ADDA    <CSUM
        STA     <CSUM
        PULS    A
CWBYTE  PSHS    D
        LDB     #8
        PSHS    B
CWB1    LSR     1,S
        LDB     #CH0
        BCC     CWB2
        LDB     #CH1
CWB2    LDA     #$FC
        STA     PIA1A
        BSR     CWDLY
        CLRA
        STA     PIA1A
        BSR     CWDLY
        DEC     ,S
        BNE     CWB1
        PULS    B
        PULS    D,PC
CWDLY   PSHS    B
CWDL1   DECB
        BNE     CWDL1
        PULS    B,PC

* CWBLK: a block: the leader, $3C, CBTYP, CBLEN, the CBLEN bytes at X (X ends past them), the checksum and a $55
* [FMT]. A motor that was off is started, and the tape given time to get up to speed.
CWBLK   ORCC    #$50
        LDA     PIA1CA
        BITA    #8
        BNE     CW1
        JSR     CASON
        PSHS    X
        LDX     #CDELAY
CW0     LEAX    -1,X
        BNE     CW0
        PULS    X
CW1     LDB     #CLEADN
CW2     LDA     #$55
        BSR     CWBYTE
        DECB
        BNE     CW2
        LDA     #$3C
        BSR     CWBYTE
        CLR     <CSUM
        LDA     <CBTYP
        BSR     CWSUM
        LDA     <CBLEN
        BSR     CWSUM
        LDB     <CBLEN
        BEQ     CW4
CW3     LDA     ,X+
        BSR     CWSUM
        DECB
        BNE     CW3
CW4     LDA     <CSUM
        BSR     CWBYTE
        LDA     #$55
        BRA     CWBYTE

* CWHEAD: the namefile block: CNAME and the fields after it
CWHEAD  LDX     #CNAME
        LDD     #15
        STD     <CBTYP
        BRA     CWBLK

* CWDATA: the bytes from X up to CEND in data blocks of up to 255, the end-of-file block, and the motor off
CWDATA  LDD     <CEND
        PSHS    X
        SUBD    ,S++
        BEQ     CWDA2
        TSTA
        BEQ     CWDA1
        LDB     #255
CWDA1   LDA     #1
        STD     <CBTYP
        BSR     CWBLK
        BRA     CWDATA
CWDA2   LDD     #$FF00
        STD     <CBTYP
        BSR     CWBLK
        JMP     CASOFF

* CSAVE ["NAME"][,A]: the program, tokenised, or as text with ,A, in blocks with the motor stopped between them
* (a gapped file) [UM]; CSAVEM "NAME",start,end,exec: memory from start to end [UM]
CSAVE   CMPA    #'M'
        BEQ     CSAVEM
        JSR     GETNAM
        LDX     #CFTYP          ; a BASIC program; exec and load addresses 0 [OWN]
        LDB     #7
CS0     CLR     ,X+
        DECB
        BNE     CS0
        JSR     <ZCHRGOT
        BEQ     CS2
        JSR     COMMA
        CMPA    #'A'
        LBNE    SNERR
        JSR     <ZCHRGET
        LDD     #$FFFF
        STD     CFASC           ; and CFGAP
        BSR     CWHEAD
        JSR     CASOFF
        INC     <CASOUT         ; LIST, to the tape
        CLR     <CBIDX
        LDX     <TXTTAB
CS1     LDD     ,X
        BEQ     CS1E
        JSR     LSTLIN
        LDX     ,X
        BRA     CS1
CS1E    BSR     CFLUSH
        CLR     <CASOUT
        STX     <CEND           ; no more data: the end-of-file block
        BRA     CWDATA
CS2     BSR     CWHEAD
        LDX     <VARTAB
        STX     <CEND
        LDX     <TXTTAB
        BRA     CWDATA
CSAVEM  JSR     <ZCHRGET
        JSR     GETNAM
        JSR     CADDR
        PSHS    D
        JSR     CADDR
        ADDD    #1
        STD     <CEND
        JSR     CADDR
        STD     CFEXEC
        PULS    D
        STD     CFLOAD
        CMPD    <CEND
        LBHS    FCERR           ; the end before the start
        LDD     #$0200          ; machine code, not ASCII, no gaps
        STD     CFTYP
        CLR     CFGAP
        JSR     CWHEAD
        LDX     CFLOAD
        JMP     CWDATA

* CHRTAP: CHROUT while CSAVE ,A lists the program: the character goes into the block at LINBUF, and a full
* block goes onto the tape. Keeps every register.
CHRTAP  PSHS    D,X
        LDB     <CBIDX
        LDX     #LINBUF
        ABX
        STA     ,X
        INCB
        STB     <CBIDX
        CMPB    #255
        BNE     CT1
        BSR     CFLUSH
CT1     PULS    D,X,PC
* CFLUSH: the block at LINBUF (CBIDX bytes, if any) onto the tape, the motor stopped after it
CFLUSH  LDB     <CBIDX
        BEQ     CFL1
        LDA     #1
        STD     <CBTYP
        LDX     #LINBUF
        JSR     CWBLK
        CLR     <CBIDX
        JMP     CASOFF
CFL1    RTS
