* ssc-tone.asm: our own TMS7040 firmware for the Speech/Sound Pak's AY audio comparison.
*
* The verification firmware (ssc-pic.asm) walks the AY's register file without ever setting a tone or a volume,
* so the Pak is silent on both emulators and a -wavwrite comparison would compare two silences. This one programs
* the AY deliberately, and changes the frequency twice mid-run so a comparison sees the tone move.
*
* Register sequence (js/chips/ay8910.js's map; MAME's ay8910.cpp is the same part):
*   7  mixer: tone A, B and C on (bits 0-2 clear), noise off (bits 3-5 set) = $38
*   0/1 tone A period, 2/3 tone B period (12-bit dividers of clock/16; the AY's clock is 1,789,772.5 Hz,
*       twice the card's cycle rate, so period 140 -> 799 Hz and period 93 -> 1203 Hz)
*   8  volume A = 12/15, 9 volume B = 6/15, 10 volume C = 0 (silent) -> two channels sound
* then period 70 (1598 Hz) / 46 (2432 Hz), then 200 (559 Hz) / 33 (3390 Hz).
*
* The AY-3-8913 latches its register number on a port C write with BDIR and BC1 both set, and its data on a
* write with BDIR set and BC1 clear (js/chips/ay8910.js); port C bits 3 and 0 are those lines and bit 6 is the
* chip select (0 = selected). Port D carries the byte both times (coco_ssc.cpp routes port D to the chip), so a
* register write is: port D = register, port C = $09; port D = value, port C = $08.
*
* It is NOT the real firmware and does not speak (AGENTS.md hard rule 1: the user supplies the real ROMs).
*
* TMS7000 syntax, as this project's assembler takes it (js/asm/isa7000.js): immediate is %$nn, an address is
* @addr, an indirect register is *Rn, a register-file address is Rn. There is no JSR (CALL is the extended
* call), and MOV moves between registers and the register file only - the peripheral file is reached with MOVP.
        ORG     $F000

* ---- reset: ports to output, INT3 enabled, then idle until the CoCo writes $FF7E ----
RESET   MOVP    %$00,P0 ; IOCNT0 clear while the ports are set up
        MOVP    %$00,P5 ; port A: every line an input (the CoCo's command byte comes in here)
        MOVP    %$FF,P7 ; port B: outputs
        MOVP    %$FF,P9 ; port C: outputs (the control bus)
        MOVP    %$FF,P11 ; port D: outputs (the data bus)
        MOVP    %$00,P8 ; port C: chip selects deasserted, ALD low, busy low
        MOVP    %$00,P10 ; port D idle
        MOVP    %$00,P4 ; port A: no command yet
IOCNT0_INIT MOVP    %$30,P0 ; INT3 enable (bit 4) + INT3 flag clear (bit 5), Figure 3-16
        EINT
WAIT    JMP     WAIT

* ---- a command starts the tone sequence ----
* NOTE the cartridge's audio is gated by the CoCo's sound mux, which the 6809 opens (MAME coco.cpp:555:
* bCartSoundEnable = soundmux_status() == (SOUNDMUX_ENABLE|SOUNDMUX_SEL2), i.e. PIA1 CB2 and PIA0 CB2 high with
* PIA0 CA2 low). It is opened in the 6809 firmware, ssc.asm's MUXON, which writes those PIAs' control registers -
* NOT here, and not by a harness poke. The TMS7040 cannot reach the 6809's bus: its address space is this ROM,
* its register file and its peripheral file only.
* (Reading back: MUXON drives the C2 control lines, not $FF01's data bits; $FF01 is PIA0's control register A.)
SERVE   MOVP    P4,A ; A = the command byte
        CALL    @TONE1
        CALL    @PAUSE
        CALL    @TONE2
        CALL    @PAUSE
        CALL    @TONE3
        MOVP    %$80,P8 ; busy up (releases the CoCo)
        MOVP    %$00,P8 ; back down, so the next interrupt is the same edge
        RETI

* ---- one AY register write: A = register number, B = value ----
AYREG   MOVP    A,P10        ; port D = register number
        MOVP    %$09,P8      ; BDIR|BC1: latch the address
        MOVP    B,P10        ; port D = value
        MOVP    %$08,P8      ; BDIR only: write the data
        RETS

* ---- tone 1: mixer on, two channels, A = 799 Hz, B = 1203 Hz ----
TONE1   MOV     %$07,A
        MOV     %$38,B
        CALL    @AYREG       ; mixer: tone A/B/C on, noise off
        MOV     %$00,A
        MOV     %$8C,B
        CALL    @AYREG       ; tone A low = $8C (140)
        MOV     %$01,A
        MOV     %$00,B
        CALL    @AYREG       ; tone A high = 0
        MOV     %$02,A
        MOV     %$5D,B
        CALL    @AYREG       ; tone B low = $5D (93)
        MOV     %$03,A
        MOV     %$00,B
        CALL    @AYREG       ; tone B high = 0
        MOV     %$08,A
        MOV     %$0C,B
        CALL    @AYREG       ; volume A = 12
        MOV     %$09,A
        MOV     %$06,B
        CALL    @AYREG       ; volume B = 6
        MOV     %$0A,A
        MOV     %$00,B
        CALL    @AYREG       ; volume C = 0
        RETS

* ---- tone 2: the same two channels an octave up ----
TONE2   MOV     %$00,A
        MOV     %$46,B
        CALL    @AYREG       ; tone A low = 70 (1598 Hz)
        MOV     %$02,A
        MOV     %$2E,B
        CALL    @AYREG       ; tone B low = 46 (2432 Hz)
        RETS

* ---- tone 3: one more change, then steady ----
TONE3   MOV     %$00,A
        MOV     %$C8,B
        CALL    @AYREG       ; tone A low = 200 (559 Hz)
        MOV     %$02,A
        MOV     %$21,B
        CALL    @AYREG       ; tone B low = 33 (3390 Hz)
        RETS

* ---- a delay between tones so each is heard: R0 counts 0..255 while R1 counts 7 outer passes ----
PAUSE   MOV     %$FF,R0
        MOV     %$07,R1
PLOOP   DJNZ    R0,@PLOOP
        DJNZ    R1,@PLOOP
        RETS

* ---- vectors: INT3 at >FFF8/>FFF9, reset at >FFFE/>FFFF (Table 3-12)
        ORG     $FFF8
        FDB     SERVE
        ORG     $FFFE
        FDB     RESET
        END     RESET
