* ---------------- the printer: LLIST, PRINT #-2 ----------------
* Output goes to the printer through the two-byte call: ZCHROUT points at PRTOUT while LLIST or PRINT #-2 runs, and
* back at CHROUT after (PRTOFF, at $8000), so output to the screen and the tape takes the cycles it did. $6F (DEVNUM)
* is 254 meanwhile, as on the original [BB bb6 famous-pokes]. NEWLIN puts the output back, and DEVNUM to 0, before
* READY's and ERROR's text (PRTEND), so an error or BREAK leaves nothing more on the printer and the screen as it was
* [OWN]. PRINT's comma and TAB( and LIST's line end take the printer's own column there (PCOL, COLMN) [OWN]. This
* module is after $A000 so that the routine starting at $A000 stays there (section 3).

* PRTDEV: from PRINT #: the device. -1 as before (A = $FF, the file checked, CDEV); -2 [UM]: A = $FE with the output on
* the printer until PRINT's own end, which then returns through PRTOFF; PRINT #-2 alone prints a carriage return
* [BB bb11 stmt-printer2]. #-2 is seen in the text before the device is read, so PRINT #-1 takes more cycles than
* it did, never fewer; a space after # is then read as for any other device (?DN ERROR) [OWN].
PRTDEV  LDX     <TXTPTR
        LDD     1,X
        CMPD    #T_MINUS*256+'2'
        BEQ     PRD2
        LDA     #'#'            ; (CDEV reads the device from the #, in A)
        LDB     #$FE            ; (open for output)
        JSR     CDEV
        INCA
        RTS
PRD2    LEAX    2,X             ; (the 2: the last character taken)
        STX     <TXTPTR
        JSR     <ZCHRGET
        BEQ     PRD3
        LBCS    DNERR           ; (a digit after the 2: #-20 to #-29, ?DN ERROR as for any other device)
        PULS    X               ; PRINT's own return goes through PRTOFF
        LDD     #PRTOFF
        PSHS    D
        PSHS    X
        BRA     PRTON           ; (A = $FE, which PRINT stores in DEVNUM again)
PRD3    LEAS    2,S             ; PRINT #-2 alone: a carriage return, and PRINT's statement is done
        LDA     #13
        BRA     PRTOUT
* PRTON: the output to the printer, and DEVNUM (A) $FE
PRTON   LDD     #PRTOUT
        STD     <ZCHROUT+1
        LDA     #$FE
        STA     <DEVNUM
        RTS
* LLIST [range]: LIST to the printer, each line as LIST shows it and a carriage return [UM; BB bb11 stmt-printer2]
* (LIST leaves out a line's carriage return only at the printer's column 0, COLMN).
LLIST   BSR     PRTON
        JSR     LIST
* PRTEND: the output back on the screen and DEVNUM 0 (LLIST's end; NEWLIN, so READY and ERROR too)
PRTEND  CLR     <DEVNUM
        JMP     PRTOFF
* PRTOUT: A to the printer, once it is not busy (PIA 1 PB0, the printer's BUSY input, high) [DOC: Dragon Data Ltd,
* "Dragon 32 Information for Machine Code Users!", the $FF22 entry]: the byte on PIA 0 port B, then the strobe, PIA 1
* PA1, low and high (a byte is taken at each rise), the DAC's bits as they are [HW]. Keeps every register. Entry
* $800F. (bb10 stmt-printer and bb6 famous-pokes, where the original waited with no printer, were recorded on an
* emulator that read PB0 as busy; the wait is not taken from them: see docs/clean-room-basic.md, row 71.)
PRTOUT  PSHS    B,X
        LDX     #PIA1A
PRO1    LDB     2,X             ; (PIA1B)
        LSRB
        BCS     PRO1
        STA     PIA0B
        LDB     ,X
        ANDB    #$FD
        STB     ,X
        ORB     #2
        STB     ,X
        INC     PCOL            ; the printer's column: one more, or 0 after a carriage return
        CMPA    #13
        BNE     PRO2
        CLR     PCOL
PRO2    PULS    B,X,PC

* POS(n): the cursor's column (n is not used) (misc.inc's; here so that a routine starts at $A000:
* docs/clean-room-basic.md section 3)
POS     JSR     <ZFNARGN
        LDB     <CURPOS+1
        ANDB    #31
        JMP     GIVB
