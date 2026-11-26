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
        FCB     $8C             ; (CMPX #: skips the next LDB)
CLOM    LDB     #ERR_OM
        FCB     $8C             ; (CMPX #: skips the next LDB)
CLDS    LDB     #ERR_DS
        FCB     $8C             ; (CMPX #: skips the next LDB)
CLIO    LDB     #ERR_IO
CASERR  JSR     CASOFF
        TST     <CLDBAS         ; (1 or 2: a program loading; $FF, $FE: a data file, kept)
        BLE     CE1
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
* the second row. With CLDBAS negative (OPEN "I") none of this: the screen is left as it is [BB bb4 cas-files: no
* clear, nothing written in the top row].
CFIND   TST     <CLDBAS
        BMI     CF1
        JSR     CLS
        LDA     #'S'
        STA     SCREEN
        BSR     CFN2
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
        BMI     CF5             ; (quiet)
        LDA     #'F'
        STA     SCREEN
CF5     RTS
CF4     BSR     CFNAME
        BSR     CSKIP           ; the file passed over, then a clear screen
        BRA     CFIND
CFNAME  TST     <CLDBAS         ; N set: quiet (OPEN "I")
        BMI     CF5
        LDX     #SCREEN+2
        STX     <CURPOS
        LDX     #LINBUF
        LDB     #8
CFN1    LDA     ,X+
        JSR     <ZCHROUT
        DECB
        BNE     CFN1
CFN2    LDX     #SCREEN+32      ; the cursor on the second row
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
        JSR     RELNKE
CLDONE  CLR     <CLDBAS
        JSR     CASOFF
        JMP     RNEND           ; (program.inc: CLRVAR, then READY)
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
        JSR     CPYXU
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
        BSR     CWCLR           ; a BASIC program; exec and load addresses 0 [OWN]
        JSR     <ZCHRGOT
        BEQ     CS2
        JSR     COMMA
        CMPA    #'A'
        LBNE    SNERR
        JSR     <ZCHRGET
        BSR     CWASC
        LDA     #$FF            ; LIST, to the tape
        STA     <DEVNUM
        LDX     <TXTTAB
CS1     LDD     ,X
        BEQ     CS1E
        JSR     LSTLIN
        LDX     ,X
        BRA     CS1
CS1E    BSR     CFLUSH
        CLR     <DEVNUM
        STX     <CEND           ; no more data: the end-of-file block
CS2J    BRA     CWDATA
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
        BRA     CS2J

* CWCLR: the namefile's fields after the name to 0 (file type 0, not ASCII, no gaps, addresses 0)
CWCLR   LDX     #CFTYP
        LDB     #7
CWC1    CLR     ,X+
        DECB
        BNE     CWC1
        RTS
* CWASC: a text file's namefile (ASCII and gaps $FF) onto the tape, the motor stopped after it, and the block
* buffer empty
CWASC   LDD     #$FFFF
        STD     CFASC           ; and CFGAP
        JSR     CWHEAD
        CLR     <CBIDX
        JMP     CASOFF

* CHRTAP: CHROUT to the tape (CSAVE ,A, PRINT #-1): the character goes into the block at CASBUF, and a full
* block goes onto the tape. Keeps every register.
CHRTAP  LDB     <CBIDX           ; (from CHROUT, D and X pushed)
        LDX     #CASBUF
        ABX
        STA     ,X
        INCB
        STB     <CBIDX
        CMPB    #255
        BNE     CT1
        BSR     CFLUSH
CT1     PULS    D,X,PC
* CFLUSH: the block at CASBUF (CBIDX bytes, if any) onto the tape, the motor stopped after it
CFLUSH  LDB     <CBIDX
        BEQ     CFL1
        LDA     #1
        STD     <CBTYP
        LDX     #CASBUF
        JSR     CWBLK
        CLR     <CBIDX
        JMP     CASOFF
CFL1    RTS

* ---------------- data files ----------------
* OPEN "O",#-1,"NAME" and OPEN "I",#-1,"NAME" (also without the #, and with no name or "" for the next file on the
* tape), PRINT #-1 (print.inc), INPUT #-1 and LINE INPUT #-1 (io.inc), EOF(-1), CLOSE #-1 [UM; the forms without #
* from a magazine listing]. One file at a time, open while CLDBAS is $FF (for input; also a file left open by
* ?IO ERROR) or $FE (for output): a cassette statement or a second OPEN is then ?AO ERROR, which closes it (GETNAM).
* A file written: a namefile of type 1, ASCII and gaps $FF, exec and load 0, the motor stopped after it; then the
* records PRINT #-1 writes, gathered in blocks of 255 at CASBUF, each written (the motor started and stopped) when
* full, the rest and an end-of-file block at CLOSE [BB bb4 cas-files: the blocks and the motor's three runs]. A file
* read: found as CLOAD finds one, but with nothing shown (the screen untouched [BB bb4 cas-files]), then a block at a
* time into CASBUF as the records are read, the motor stopped after each. The buffer is graphics page 1's first 256
* bytes, as for CLOAD of a text file: a picture there gets the block's bytes [OWN]. A file of any type is read [OWN].

* OPEN "mode",[#]device,"name": the mode I or O (?FM ERROR otherwise [OWN]), the device -1 (?DN ERROR), a name
* ("" for the next file)
OPEN    JSR     EVSTR
        JSR     FRESTR
        LDA     ,X              ; (the mode's first letter)
        PSHS    A
        JSR     COMMA
        BSR     DEVARG
        JSR     COMMA
        JSR     GETNAM
        PULS    A
        CMPA    #'O'
        BEQ     OPOUT
        CMPA    #'I'
        LBNE    FMERR
        DEC     <CLDBAS         ; ($FF: open for input, CFIND quiet)
        LDU     #CFIND
        BSR     QUIET
        CLR     <CBLEN          ; no data in hand (CBTYP is 0, the namefile's: no end of file yet)
        JMP     CASOFF
OPOUT   JSR     CWCLR
        INC     CFTYP           ; a data file
        JSR     CWASC
        LDA     #$FE
        STA     <CLDBAS
        RTS

* QUIET: the routine at U with the top-left cell put back after it (CRBLK's blink: a data file is read with nothing
* on the screen changing [BB bb4 cas-files]). Keeps the routine's flags.
QUIET   LDA     SCREEN
        PSHS    A
        JSR     ,U
        PSHS    CC
        LDA     1,S
        STA     SCREEN
        PULS    CC,A,PC

* CLOSE [[#]device]: the file closed (with no device, whatever is open); one open for output gets its last block and
* the end-of-file block. Nothing open: no error [OWN].
CLOSE   BEQ     CLO1
        BSR     DEVARG
CLO1    LDA     <CLDBAS
        CLR     <CLDBAS
        CMPA    #$FE
        BNE     DVC1
        JSR     CFLUSH
        JMP     CWDA2

* EOF(device): -1 when the file open for input has no more data, 0 otherwise [UM, BB bb4 cas-files]; this may read
* the next block. Nothing open for input: ?NO ERROR, or ?FM ERROR for a file open for output [OWN].
FNEOF   JSR     <ZFNARGN
        BSR     DEVCHK
        LDA     #$FF
        BSR     FILCHK
        BSR     CFILL
        TFR     CC,B            ; C set (data): 0; clear (the end): -1
        ANDB    #1
        DECB
        SEX
        JMP     GIVNUM

* CDEV: at the # of PRINT #, INPUT #: the device number for a file open in mode B ($FF input, $FE output), A = the
* mode on return. The device -1, or ?DN ERROR [OWN: the only device]; no file open in that mode: ?NO ERROR [BB bb4
* cas-files: PRINT #-1 with none], or ?FM ERROR when the file is open the other way [OWN].
CDEV    PSHS    B
        BSR     DEVARG
        PULS    A
FILCHK  CMPA    <CLDBAS
        BEQ     DVC1
        LDB     #ERR_NO
        TST     <CLDBAS
        BPL     DVC0
        LDB     #ERR_FM
DVC0    JMP     ERROR
* DEVARG: [#]device (EVDEV: the device), which must be -1 (?DN ERROR)
DEVARG  CMPA    #'#'
        BNE     EVDEV
        JSR     <ZCHRGET
EVDEV   JSR     <ZEVNUM
DEVCHK  JSR     INTCNV
        ADDD    #1
        LBNE    DNERR
DVC1    RTS

* CFILL: C set when the input file has a byte to read (B = its place in CASBUF), clear at its end: the next block
* read when the last is used up (its blink undone, the motor stopped after it); a bad block, or a namefile, ?IO
* ERROR [as CLOAD]; a block of another type is taken as data [OWN].
CFILL   LDB     <CBIDX
        CMPB    <CBLEN
        BLO     CFI2            ; (C set)
        LDA     <CBTYP
        INCA
        BEQ     CFI2            ; the end-of-file block was read (C clear, from the CMPB)
        PSHS    U               ; (CRDLN's)
        LDX     #CASBUF
        LDU     #CRBLK
        BSR     QUIET
        PULS    U
        BNE     CFI3
        JSR     CASOFF
        CLR     <CBIDX
        LDA     <CBTYP          ; (data, or the end of file; a namefile: the file had no end)
        BNE     CFILL
CFI3    JMP     CLIO
CFI2    RTS

* CGETC: the input file's next byte in A, C set; C clear at the end of the file
CGETC   BSR     CFILL
        BCC     CFI2
        LDX     #CASBUF
        ABX                     ; (B unsigned: up to 254)
        LDA     ,X
        INC     <CBIDX
        RTS

* CRDLN: a record from the input file into LINBUF, 0-terminated, for INPUT #-1 (io.inc, INLINE): the bytes up to a
* carriage return (or the file's end), a longer one cut at LINMAX [OWN]; none left: ?IE ERROR [BB bb4 cas-files]
CRDLN   BSR     CGETC
        LBCC    IEERR
        LDU     #LINBUF
CRD1    CMPA    #13
        BEQ     CRD3
        CMPU    #LINBUF+LINMAX
        BHS     CRD2
        STA     ,U+
CRD2    BSR     CGETC
        BCS     CRD1
CRD3    CLR     ,U
        RTS
