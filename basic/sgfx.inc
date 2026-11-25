* ---------------- semigraphics points on the text screen: SET, RESET, POINT ----------------
* docs/clean-room-basic-p2.md section 5. Point (x 0-63, y 0-31) is an element of the character at
* $0400 + (y/2) x 32 + x/2; a semigraphics-4 character is $80 + (colour - 1) x 16 + its elements, bit 3 top left,
* bit 2 top right, bit 1 bottom left, bit 0 bottom right [HW, the MC6847 data sheet]. A cell holding a text
* character counts as no elements lit [OWN; BB].

* SGXY: (x,y at the text pointer, up to the ')' or the ',' after y -> X = the cell, A = the element's mask
* (?FC ERROR for x above 63 or y above 31 [BB])
SGXY    JSR     LPAREN
        JSR     GETBYT
        CMPB    #63
        BHI     SGFC
        PSHS    B
        JSR     COMBYT
        CMPB    #31
        BHI     SGFC
        LDA     #8
        LSRB                    ; y / 2; C: the bottom row
        BCC     SGX1
        LSRA
        LSRA
SGX1     LSR     ,S              ; x / 2; C: the right column
        BCC     SGX2
        LSRA
SGX2     PSHS    A
        LDA     #32
        MUL
        ADDB    1,S
        ADDA    #SCREEN/256
        TFR     D,X
        PULS    A
        LEAS    1,S
        RTS
SGFC    JMP     FCERR

* SET (x,y,c): light the element in colour c (0-8; the cell's colour is (c - 1) AND 7) [UM; c 0 OWN, BB]
SET     BSR     SGXY
        PSHS    A,X
        JSR     GETCOL
        DECB
        ASLB
        ASLB
        ASLB
        ASLB
        ORB     #$80
        JSR     RPKEEP
        PULS    A,X
        PSHS    A
        ORB     ,S+             ; the colour and the element
        LDA     ,X
        BPL     ST1             ; a text character: no other element lit
        ANDA    #$0F
        PSHS    A
        ORB     ,S+
ST1     STB     ,X
        RTS

* RESET (x,y): put the element out, keeping the cell's colour [UM]
RSETST  BSR     SGXY
        JSR     RPKEEP
        COMA
        LDB     ,X
        BMI     RST1
        LDB     #$80            ; a text character: no element lit
RST1     PSHS    B
        ANDA    ,S+
        STA     ,X
        RTS

* POINT (x,y): the cell's colour (1-8) if the element is lit, 0 if not, -1 for a text character [UM; BB]
POINT   BSR     SGXY
        JSR     RPKEEP
        LDB     ,X
        BPL     PT2
        ANDA    ,X
        BEQ     PT1
        LSRB
        LSRB
        LSRB
        LSRB
        ANDB    #7
        INCB
        FCB     $21             ; (BRN: skips the CLRB)
PT1     CLRB
        CLRA
        BRA     PT3
PT2     LDD     #-1
PT3     JMP     GIVNUM
