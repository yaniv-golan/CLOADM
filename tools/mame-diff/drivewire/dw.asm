* DriveWire client firmware for the Becker port (tools/mame-diff/drivewire, written for CLOADM; run-dw.js).
*
* Runs a script of DriveWire 4 transactions against the server (tools/mame-diff/drivewire/spec.js sets it up:
* the drives, the named object, the clock, and what the host does on channel 3) and logs every byte the server
* sends back, from $6000 on. The same firmware runs in MAME (coco_dwsock, a TCP link to our server) and on our
* machine (the Becker port, the same server in-process); the logs and the server's disks, printout and channel
* output must be identical, and run-dw.js --lockstep compares the two runs instruction by instruction: before
* each status poll GETB writes SYNC, where MAME's Lua tap holds the CPU until our server has answered every byte
* written to it (as our in-process server always has), so the polls see the same thing in both.
*
* Script commands (SCRIPT below):
*   CS n bytes   send n bytes
*   CR n         receive n bytes into the log (0 = 256); a byte that does not come within the timeout logs $EE
*   CW d         send the 256-byte sector buffer and its checksum plus d (high byte first; d <> 0: wrong)
*   CK d         send the checksum of the last 256 bytes logged, plus d (d <> 0: a wrong checksum)
*   CC           log our own checksum of the last 256 bytes logged (to compare with the server's)
*   CF v         fill the sector buffer: byte i = v + 7i
*   CE           end: the log's end address goes to $5FF0, $FF to $5FF2
DATA    EQU     $FF42
STAT    EQU     $FF41
LOG     EQU     $6000
LOGEND  EQU     $5FF0
DONE    EQU     $5FF2
SYNC    EQU     $5FF4           ; written before each status poll (the lockstep's hold point; nothing reads it)
SECBUF  EQU     $5E00
CE      EQU     0
CS      EQU     1
CR      EQU     2
CW      EQU     3
CK      EQU     4
CC      EQU     5
CF      EQU     6
        ORG     $8000
RESET   ORCC    #$50
        LDA     #$04            ; CoCo 3: the GIME's spare chip select on ($FF90 bit 2); the ROM map and MMU
        STA     $FF90           ; stay as at reset. (On the CoCo 1/2 nothing answers at $FF90.)
        LDS     #$5D00
        CLR     DONE
        LDU     #LOG
        LDY     #SCRIPT
NEXT    LDA     ,Y+
        BEQ     DOE
        DECA
        BEQ     DOS
        DECA
        BEQ     DOR
        DECA
        BEQ     DOW
        DECA
        BEQ     DOK
        DECA
        BEQ     DOC
        DECA
        BEQ     DOF
        LDA     #$BD            ; a bad script command: stop with a marker
        STA     ,U+
DOE     STU     LOGEND
        LDA     #$FF
        STA     DONE
HALT    BRA     HALT

DOS     LDB     ,Y+
DOS1    LDA     ,Y+
        STA     DATA
        DECB
        BNE     DOS1
        LBRA    NEXT
DOR     LDB     ,Y+
DOR1    BSR     GETB
        STA     ,U+
        DECB
        BNE     DOR1
        LBRA    NEXT
DOW     LDB     ,Y+
        PSHS    B
        LDX     #SECBUF
        CLRB
DOW1    LDA     ,X+
        STA     DATA
        DECB
        BNE     DOW1
        LDX     #SECBUF
        BSR     CKSUM
        ADDB    ,S+
        ADCA    #0
        STA     DATA
        STB     DATA
        LBRA    NEXT
DOK     LDB     ,Y+
        PSHS    B
        LEAX    -256,U
        BSR     CKSUM
        ADDB    ,S+
        ADCA    #0
        STA     DATA
        STB     DATA
        LBRA    NEXT
DOC     LEAX    -256,U
        BSR     CKSUM
        STD     ,U++
        LBRA    NEXT
DOF     LDA     ,Y+
        LDX     #SECBUF
        CLRB
DOF1    STA     ,X+
        ADDA    #7
        DECB
        BNE     DOF1
        LBRA    NEXT

* the next byte from the server in A, or $EE after about four seconds of nothing (B, X and Y kept)
GETB    PSHS    B,X
        LDB     #4
GB1     LDX     #0
GB2     STA     SYNC
        LDA     STAT
        BITA    #$02
        BNE     GB3
        LEAX    -1,X
        BNE     GB2
        DECB
        BNE     GB1
        LDA     #$EE
        PULS    B,X,PC
GB3     LDA     DATA
        PULS    B,X,PC
* the 16-bit sum of the 256 bytes at X, in D (Y kept)
CKSUM   PSHS    Y
        LDY     #256
        CLRA
        CLRB
CK1     ADDB    ,X+
        ADCA    #0
        LEAY    -1,Y
        BNE     CK1
        PULS    Y,PC

SCRIPT
* System Transactions: RESET, INIT, NOP; DWINIT (one byte back); TIME (six bytes)
        FCB     CS,3,$FF,$49,$00
        FCB     CS,2,$5A,$01,CR,1
        FCB     CS,1,$23,CR,6
* Read: drive 0, LSN 1 (error, checksum, sector), and our own checksum of it
        FCB     CS,5,$52,0,0,0,1,CR,3,CR,0,CC
* Read: an LSN above 65535 (sector 0 of drive 0 at LSN 0 + $010000: past the end, zeroes)
        FCB     CS,5,$52,0,1,0,0,CR,3,CR,0
* Read: drive 9 is not mounted (one byte: the error)
        FCB     CS,5,$52,9,0,0,0,CR,1
* Read Extended: drive 0 LSN 2, the right checksum (sector, then the result)
        FCB     CS,5,$D2,0,0,0,2,CR,0,CK,0,CR,1
* Read Extended: drive 0 LSN 3, a wrong checksum
        FCB     CS,5,$D2,0,0,0,3,CR,0,CK,1,CR,1
* Read Extended: drive 9 (256 zeroes, then the error)
        FCB     CS,5,$D2,9,0,0,0,CR,0,CK,0,CR,1
* Read Extended: past the end of drive 0 (LSN 100)
        FCB     CS,5,$D2,0,0,0,100,CR,0,CK,0,CR,1
* Write: drive 0 LSN 4
        FCB     CF,$31,CS,5,$57,0,0,0,4,CW,0,CR,1
* Write: a wrong checksum
        FCB     CS,5,$57,0,0,0,5,CW,1,CR,1
* Write: drive 1 is write protected; drive 9 is not mounted
        FCB     CS,5,$57,1,0,0,0,CW,0,CR,1
        FCB     CS,5,$57,9,0,0,0,CW,0,CR,1
* Write: drive 2 LSN 6, past its end (the image grows)
        FCB     CF,$C8,CS,5,$57,2,0,0,6,CW,0,CR,1
* ReWrite drive 0 LSN 0; ReRead drive 0 LSN 4 (what the Write put there); ReRead Extended drive 2 LSN 6
        FCB     CF,$05,CS,5,$77,0,0,0,0,CW,0,CR,1
        FCB     CS,5,$72,0,0,0,4,CR,3,CR,0
        FCB     CS,5,$F2,2,0,0,6,CR,0,CK,0,CR,1
* GetStat / SetStat (nothing back)
        FCB     CS,6,$47,0,$01,$53,0,$02
* Named objects: mount NAMED.DAT, read both its sectors; mount a missing one; create NEW.DAT and write it;
* create NAMED.DAT (it exists)
        FCB     CS,11,$01,9
        FCC     "NAMED.DAT"
        FCB     CR,1
        FCB     CS,5,$52,255,0,0,0,CR,3,CR,0
        FCB     CS,5,$52,255,0,0,1,CR,3,CR,0
        FCB     CS,9,$01,7
        FCC     "MISSING"
        FCB     CR,1
        FCB     CS,9,$02,7
        FCC     "NEW.DAT"
        FCB     CR,1
        FCB     CF,$77,CS,5,$57,255,0,0,0,CW,0,CR,1
        FCB     CS,11,$02,9
        FCC     "NAMED.DAT"
        FCB     CR,1
* Printing
        FCB     CS,9,$50,$50,$50,$52,$50,$4E,$50,$0D,$46
* Virtual serial channels. SERINIT 3: the host greets with "HELLO" (five bytes waiting)
        FCB     CS,2,$45,3,CS,1,$43,CR,2
        FCB     CS,3,$63,3,5,CR,5
        FCB     CS,1,$43,CR,2
* FASTWRITE 'a' on 3: the host echoes it with the case changed (one byte waiting: the single byte form)
        FCB     CS,2,$83,$61,CS,1,$43,CR,2
* SERWRITE 'b', SERWRITEM "cd": three bytes waiting; take two, then the last as a single byte
        FCB     CS,3,$C3,3,$62,CS,5,$64,3,2,$63,$64,CS,1,$43,CR,2
        FCB     CS,3,$63,3,2,CR,2,CS,1,$43,CR,2
* SERREADM for more than is waiting: no answer (logs $EE)
        FCB     CS,3,$63,3,4,CR,1
* SERSETSTAT SS.ComSt (26 bytes follow), SERGETSTAT; a write to channel 5, never opened (dropped)
        FCB     CS,29,$C4,3,$28,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26
        FCB     CS,3,$44,3,$01,CS,2,$85,$58
* 'q' on 3: the host closes the channel; the next SERREAD reports it (16, channel)
        FCB     CS,2,$83,$71,CS,1,$43,CR,2,CS,1,$43,CR,2
* SERSETSTAT SS.Open on 4, then SS.Close; SERTERM on 4 again (closed: nothing)
        FCB     CS,6,$C4,4,$29,$C4,4,$2A,CS,2,$C5,4
* an op code the server does not know ($41), then DWINIT: still in step
        FCB     CS,1,$41,CS,2,$5A,$02,CR,1
        FCB     CE
        ORG     $BFF2
        FDB     RESET,RESET,RESET,RESET,RESET,RESET,RESET   ; SWI3 SWI2 FIRQ IRQ SWI NMI RESET
        END     RESET
