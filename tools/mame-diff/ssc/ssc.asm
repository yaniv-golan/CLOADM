* ssc.asm: our own 6809 firmware for the Speech/Sound Pak comparison (MAME coco -ext ssc).
*
* It runs as the CoCo's BASIC ROMs, not as a cartridge: the Pak has no ROM of its own at $C000 (its rom()
* is null), so the only place for our 6809 code is the ROM socket BASIC occupies. The firmware therefore
* assembles at $A000 (the `bas` slot), with its vectors at $BFF2 exactly where the CoCo reads them, and
* reaches the Pak purely through $FF7D/$FF7E. The Pak goes in the extension slot alongside it.
*
* What it drives, from MAME's coco_ssc.cpp:
*   - $FF7D write bit 0: high resets the SP0256; a 1 -> 0 transition resets the PIC and the AY and clears
*     the busy flag.
*   - $FF7E write: latch a byte for the PIC's port A, set busy, assert INT3.
*   - $FF7E read: $1F plus bit 7 (PIC not busy), bit 6 (SP0256 SBY), bit 5 (sound-activity output).
*   - $FF7D read: always $FF.
*
* The busy flag is the handshake: the PIC firmware clears it when it has serviced a command, so waiting on bit
* 7 keeps the two emulators together. WAITBUS polls with a bounded loop and counts a give-up at TIMEOUTS, so a
* hang in one of them shows up as a differing trace or a differing RAM byte rather than a stalled run.
*
        ORG     $A000
RESET   ORCC    #$50           ; interrupts masked: the SSC raises INT3 on the PIC, never on the 6809
        LDS     #$7F00
        JMP     START

SSC_RESET EQU   $FF7D
SSC_DATA  EQU   $FF7E
POLLMAX   EQU   $0400
TIMEOUTS  EQU   $0410
SSCSETTLE EQU   $0200
SSCSPEECH EQU   $0800           ; wait for the SP0256's sequencer to settle (see section 6)

* Every RAM location this firmware uses is written before it is read, so the run cannot depend on what a
* machine's RAM holds at power-on: the real DRAM powers up undefined, and the two emulators do not agree on a
* value (MAME's coco12 leaves it $FF, this emulator fills it $00). $0400-$0405 are stores. TIMEOUTS is the one
* exception and is a read-modify-write, so it is cleared here. The PIC's firmware (ssc-pic.asm) keeps its
* state in the register file and reads no uninitialised memory.
START   CLR     TIMEOUTS
        JSR     SSCRESET

* ---- 2. $FF7D reads $FF always, and $FF7E gives the status bits
        LDA     SSC_RESET
        STA     $0400           ; kept in RAM so the trace shows the value
        LDA     SSC_DATA
        STA     $0401

* ---- 3. every allophone number our SP0256 data has an entry for, then bytes above 63 that it must ignore
* (entries 1-8 exist in tools/mame-diff/ssc/gen-roms.js; 0 and 9-15 are empty entries on purpose)
        LDB     #$00
ALLOOP  STB     SSC_DATA
        JSR     WAITBUS
        INCB
        CMPB    #$10
        BNE     ALLOOP
        LDB     #$40
HILOOP  STB     SSC_DATA
        JSR     WAITBUS
        INCB
        CMPB    #$44
        BNE     HILOOP

* ---- 4. AY register selection: each low nibble, with the handshake after each
        LDB     #$00
AYLOOP  STB     SSC_DATA
        JSR     WAITBUS
        INCB
        CMPB    #$10
        BNE     AYLOOP

* ---- 5. a second reset, and a read after it, to show the state returns to where it started
        JSR     SSCRESET
        LDA     SSC_RESET
        STA     $0402

* ---- 6. status reads either side of a command, to show bit 7 following the handshake
        LDA     SSC_DATA
        STA     $0403
        LDA     #$21
        STA     SSC_DATA
        LDA     SSC_DATA       ; busy: bit 7 clear
        STA     $0404
        JSR     WAITBUS
* Wait for the SP0256's sequencer to settle before sampling its SBY pin (status bit 6). Measured, this build
* against the same build without the wait: MAME reads $BF at $0405 (SBY low) when sampled immediately and $FF
* (SBY high) with the wait; this emulator reads $FF either way. The difference is pacing. MAME steps the speech
* sequencer once per sample (clock/336, ~9.3 kHz), so after an allophone load its RET - which raises SBY - is
* still several sample periods away when the firmware looks. This emulator's stage-1 model steps the sequencer
* once per card cycle, so it has already reached RET. Real code waits for the chip rather than assuming it has
* finished, which is what this does. SSCSPEECH = $0800 is 16,387 cycles ($A05F LDX 3, then 2,048 iterations of
* LEAX -1,X / BNE at 8 each) - about 18.3 ms at the card's 894,886 Hz, many sample periods (each ~107 us). It
* runs once, at the end of the case, so its length costs nothing else.
        LDX     #SSCSPEECH
SSSPEECH LEAX   -1,X
        BNE     SSSPEECH
        LDA     SSC_DATA       ; done: bit 7 set, bit 6 SBY settled
        STA     $0405

* ---- 7. the end
        BRA     HALT

HALT    BRA     HALT

* ---- SSCRESET: a reset over the Pak, bit 0 high then a 1 -> 0 transition. It sits after the main flow so
* ---- the JSR's return address is an instruction, not this routine's first byte.
* The delay after the transition is not padding: the reset restarts the PIC's own firmware, which has to run its
* port and interrupt setup (ten MOVPs, about 50 machine cycles) before it can take a command. A command written
* straight after the reset arrives while the PIC is still setting its port direction registers, so it takes the
* interrupt with its DDRs not yet configured and drives nothing. Real code waits for the card to come back; this
* gives it a margin well past that, so the sequence a test sees does not depend on the exact cycle it issues at.
SSCRESET LDA   #$01
        STA     SSC_RESET
        LDA     #$00
        STA     SSC_RESET
        LDX     #SSCSETTLE
SSDELAY LEAX    -1,X
        BNE     SSDELAY
        RTS

* ---- WAITBUS: poll $FF7E until the busy bit (7) is set.
* This is the bounded form, which the source ships: with IOCNT0 = $0C the card never interrupts, so the wait
* must give up and count it or the firmware would never reach HALT. gen-roms.js builds the INT3 case from this
* same file with the block below substituted for an unbounded poll, where the card does answer and a give-up
* path would only hide a difference.
* ---- WAITBUS-BOUNDED
WAITBUS LDY     #POLLMAX
WBLOOP  LDA     SSC_DATA
        BITA    #$80
        BNE     WBDONE
        LEAY    -1,Y
        BNE     WBLOOP
        INC     TIMEOUTS
WBDONE  RTS
* ---- WAITBUS-END

* ---- the CoCo's sound mux: select the cartridge and enable sound, so the Pak can be heard ----
* MAME's coco.cpp gates cartridge audio on the sound mux: soundmux_status() is SOUNDMUX_ENABLE (PIA1 CB2) |
* SOUNDMUX_SEL1 (PIA0 CA2) | SOUNDMUX_SEL2 (PIA0 CB2), and bCartSoundEnable is
* `status == (SOUNDMUX_ENABLE | SOUNDMUX_SEL2)` (coco.cpp:555) - PIA1 CB2 high and PIA0 CB2 high, with PIA0 CA2
* low. That is handed to the cartridge as SOUND_ENABLE (coco.cpp:585-587) and opens the SSC's output gain
* (coco_ssc.cpp:259-270). Without it the Pak is silent however its AY is programmed.
* Each PIA's C2 is driven from its control register, and the bits are (MC6821 manual; js/chips/mc6821.js
* Port.c2 implements exactly this): bit 5 = C2 is an output, bit 4 = set/reset mode, bit 3 = the level it takes
* in that mode. $FF01/$FF03 are PIA0's CR A/B and $FF21/$FF23 PIA1's on the CoCo. So $38 = 0b00111000 (bit 5
* set, bit 4 set, bit 3 set) is "output, set/reset mode, level 1" and $30 is the same with level 0.
* NOTE: writing a whole control byte like this also clears the DDR-select bit (bit 2) and the IRQ-enable bits
* (0 and 1) of those registers. Harmless here - the firmware never reads PIA1's CA1/CB1 - but it is a real
* side effect of the store and not something a general driver should do casually.
MUXON   LDA     #$30
        STA     $FF01           ; PIA0 CRA: CA2 low  -> SOUNDMUX_SEL1 clear (the equality needs it CLEAR)
        LDA     #$38
        STA     $FF03           ; PIA0 CRB: CB2 high -> SOUNDMUX_SEL2
        STA     $FF23           ; PIA1 CRB: CB2 high -> SOUNDMUX_ENABLE
        RTS

* ---- the CoCo's vectors, at the top of the `bas` slot where the machine reads them
        ORG     $BFF2
        FDB     IRQH,IRQH,FIRQH,IRQH,IRQH,NMIH,RESET
IRQH    RTI
FIRQH   RTI
NMIH    RTI
        END     RESET
