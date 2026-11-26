* ---------------- errors ----------------
* An error prints ?XX ERROR, and IN n when a program was running, then goes back to the OK prompt [UM].
* Each code below is the offset of the error's two letters in ERRTAB; jump to ERROR with it in B.
ERR_NF  EQU     0               ; NEXT without FOR
ERR_SN  EQU     2               ; syntax
ERR_RG  EQU     4               ; RETURN without GOSUB
ERR_OD  EQU     6               ; out of DATA
ERR_FC  EQU     8               ; illegal function call
ERR_OV  EQU     10              ; overflow
ERR_OM  EQU     12              ; out of memory
ERR_UL  EQU     14              ; undefined line
ERR_BS  EQU     16              ; bad subscript
ERR_DD  EQU     18              ; redimensioned array
ERR_DZ  EQU     20              ; division by zero
ERR_ID  EQU     22              ; illegal direct
ERR_TM  EQU     24              ; type mismatch
ERR_OS  EQU     26              ; out of string space
ERR_LS  EQU     28              ; string too long
ERR_ST  EQU     30              ; string formula too complex
ERR_CN  EQU     32              ; can't continue
ERR_UF  EQU     34              ; undefined function
ERR_FD  EQU     36              ; bad file data
ERR_AO  EQU     38              ; file already open
ERR_DN  EQU     40              ; device number
ERR_IO  EQU     42              ; input/output
ERR_FM  EQU     44              ; file mode
ERR_NO  EQU     46              ; file not open
ERR_IE  EQU     48              ; input past end of file
ERR_DS  EQU     50              ; direct statement in file
ERR_NE  EQU     52              ; (reserved)
ERRTAB  FCC     "NFSNRGODFCOVOMULBSDD/0IDTMOSLSSTCNUFFDAODNIOFMNOIEDSNE"

SNERR   LDB     #ERR_SN
        FCB     $8C             ; (CMPX #: skips the next LDB)
FCERR   LDB     #ERR_FC
        FCB     $8C             ; (CMPX #: skips the next LDB)
OMERR   LDB     #ERR_OM
        FCB     $8C             ; (CMPX #: skips the next LDB)
ULERR   LDB     #ERR_UL
        FCB     $8C             ; (CMPX #: skips the next LDB)
TMERR   LDB     #ERR_TM
        FCB     $8C             ; (CMPX #: skips the next LDB)
OVERR   LDB     #ERR_OV
        FCB     $8C             ; (CMPX #: skips the next LDB)
DZERR   LDB     #ERR_DZ
        FCB     $8C             ; (CMPX #: skips the next LDB)
IDERR   LDB     #ERR_ID
        FCB     $8C             ; (CMPX #: skips the next LDB)
CNERR   LDB     #ERR_CN
        FCB     $8C             ; (CMPX #: skips the next LDB)
FDERR   LDB     #ERR_FD
        FCB     $8C             ; (CMPX #: skips the next LDB)
DNERR   LDB     #ERR_DN
        FCB     $8C             ; (CMPX #: skips the next LDB)
FMERR   LDB     #ERR_FM
        FCB     $8C             ; (CMPX #: skips the next LDB)
IEERR   LDB     #ERR_IE

ERROR   LDS     <STRBOT         ; drop everything the program had on the stack
        CLR     <DEVNUM         ; (the message on the screen, whatever PRINT #-1 was doing [OWN])
        STS     <BASESP
        JSR     RSTTMP          ; and the string temporaries
        JSR     NEWLIN
        LDA     #'?'
        JSR     <ZCHROUT
        LDX     #ERRTAB
        ABX
        LDA     ,X
        JSR     <ZCHROUT
        LDA     1,X
        JSR     <ZCHROUT
        JSR     PRMSG
        FCN     " ERROR"
        CLR     <OLDTXT         ; an error cannot be continued
        CLR     <OLDTXT+1
        JSR     DIRCHK
        BEQ     ERR1
        BSR     PRTIN
ERR1    JSR     CRLF
        BRA     READY

* PRTIN: print " IN " and the line number in D
PRTIN   PSHS    D
        JSR     PRMSG
        FCN     " IN "
        PULS    D
        JMP     LINPRT
