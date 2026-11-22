; diskread.asm - read two sectors from a Dragon disk by driving the WD2797 itself through $FF40-$FF43, with no DOS ROM.
; For the disk note in docs/automation.md; Dragon 32/64/200 with the Dragon disk controller cartridge, built-in firmware.
; Written for this project from the WD2797 datasheet's command set and the register map in js/machines/fdc.js.
;
;   $FF40  command (write) / status (read)      $FF42  sector register
;   $FF41  track register                       $FF43  data register
;   $FF48  the controller's own latch (write): bits 1-0 drive, 2 motor, 3 single density (0: double), 5 NMI enable
;
; It does a restore, reads track 0 sector 1 into BUF1, seeks to track 2 and reads sector 5 into BUF2, 256 bytes each by
; polling DRQ (no interrupt: NMI stays off), and leaves for the host: DONE = $A5, the last status of each read in STAT1 and
; STAT2 and where it stopped writing in END1 and END2 (a word each: the address after the last byte taken).
;
; Speed matters: double density delivers a byte every 32 microseconds, 28.4 cycles of the Dragon's 0.89 MHz CPU, and a byte
; not taken before the next one arrives is lost (status bit 2). The transfer loop below is 26 cycles a byte at most and
; waits in a 10-cycle polling loop between bytes, so a byte is always taken within about 20 cycles of its DRQ.
DONE    EQU     $3100           ; $00 until the guest has finished, then $A5
STAT1   EQU     $3101           ; the WD2797's status after the first read
STAT2   EQU     $3102           ; ... after the second
END1    EQU     $3104           ; the address after the last byte the first read stored (word)
END2    EQU     $3106           ; ... the second read
BUF1    EQU     $3200           ; track 0 sector 1
BUF2    EQU     $3300           ; track 2 sector 5
FDCCMD  EQU     $FF40           ; command / status
FDCTRK  EQU     $FF41           ; track register
FDCSEC  EQU     $FF42           ; sector register
FDCDAT  EQU     $FF43           ; data register
CTRL    EQU     $FF48           ; drive select, motor, density, NMI enable
CMDREST EQU     $00             ; restore (type I): step to track 0, fastest step rate
CMDSEEK EQU     $10             ; seek (type I): to the track in the data register
CMDREAD EQU     $88             ; read sector (type II); bit 3 (L) says the ID's length code 1 means 256 bytes
        ORG     $3000
START   ORCC    #$50            ; no IRQ or FIRQ: the guest polls
        CLR     DONE
        LDA     #$04            ; drive 0, motor on, double density, NMI off
        STA     CTRL
        LDA     #CMDREST
        STA     FDCCMD
        BSR     IDLE            ; the head is on track 0
        LDA     #1
        STA     FDCSEC
        LDX     #BUF1
        BSR     READ            ; track 0 sector 1
        STA     STAT1
        STX     END1
        LDA     #2              ; the seek's target goes in the data register
        STA     FDCDAT
        LDA     #CMDSEEK
        STA     FDCCMD          ; the seek
        BSR     IDLE
        LDA     #5
        STA     FDCSEC
        LDX     #BUF2
        BSR     READ            ; track 2 sector 5
        STA     STAT2
        STX     END2
        LDA     #$A5
        STA     DONE
SPIN    BRA     SPIN
; wait until the controller is not busy
IDLE    LDA     FDCCMD          ; reading the status also clears INTRQ
        BITA    #$01
        BNE     IDLE
        RTS
; read the sector in the sector register into X..X+255: 256 bytes polling DRQ -> A the final status, X the address after the
; last byte stored. (A sector the controller cannot find never raises DRQ and would leave this loop waiting for ever: a driver
; for real use also watches the busy bit or a timer.)
READ    LDA     #CMDREAD
        STA     FDCCMD
        LDB     #0              ; 256 bytes: B counts down from 0 round to 0 (a mutation to 255 takes one byte too few)
POLL    LDA     FDCCMD
        BITA    #$02            ; DRQ: a byte is waiting
        BEQ     POLL
        LDA     FDCDAT          ; reading the data register clears DRQ
        STA     ,X+
        DECB
        BNE     POLL
WAITEND LDA     FDCCMD          ; all taken: wait for the controller to finish (it checks the CRC)
        BITA    #$01
        BNE     WAITEND
        RTS
        END     START
