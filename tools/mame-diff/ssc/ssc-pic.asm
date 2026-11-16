* ssc-pic.asm: our own TMS7040 firmware for the Speech/Sound Pak (stage 2), standing in for
* the PIC's internal ROM during verification. It is NOT the real firmware and does not speak: the real ROM,
* and the SP0256-AL2 data it drives, are the user's own dumps at run time (AGENTS.md hard rule 1).
*
* What it does, and why:
*  - The CoCo writes a command byte to $FF7E and asserts INT3 on the PIC. The PIC's port A holds that byte,
*    and its port C is the control bus to the AY-3-8913 and the SP0256 (see js/machines/ssc.js for the bit
*    assignments, and MAME's coco_ssc.cpp for the source of each).
*  - On an interrupt it reads port A, drives the device the command selects, and releases the busy line back
*    to the CoCo by writing port C bit 7 set. Until it does, a $FF7E read returns bit 7 clear.
*  - The comparison needs the command byte to be observable on the chips, so this firmware forwards the byte
*    to allophone selection (ALD on port C bit 5, data on port D) and to the AY (address latch when BDIR and
*    BC1 are both set, data write when BDIR is set and BC1 clear), selecting each with its chip select. One
*    POKE from the 6809 side then produces a visible SP0256 load and AY transaction in both MAME and this
*    emulator, which is what the lockstep and -wavwrite comparisons need.
*  - It ends the service by writing port C bit 7 high: the documented way to clear the CoCo's busy flag
*    (coco_ssc.cpp ssc_port_c_w).
*
* Peripheral registers are reached with MOVP, not MOV: on this part MOV moves within the register file, and
* only the peripheral-file instructions (MOVP, ANDP, ORP, XORP, BTJOP, BTJZP) address >0100->01FF.
* Addresses from the TMS7000 Family Data Manual Table 3-8: P0 >0100 IOCNT0, P4 >0104 port A data,
* P6 >0106 port B, P8 >0108 port C, P10 >010A port D.
*
* Layout: a full 4 KB image. The code sits at the base of the PIC's region (>F000 in the memory map) and the
* vectors are the last entries, >FFF8/>FFF9 for INT3 and >FFFE/>FFFF for reset (Table 3-12). The build fills
* everything else, so MAME loads exactly the bytes the tests load.
*
        ORG     $F000

* ---- reset: the data-direction registers become outputs, INT3 is enabled, then idle until the CoCo writes
* ---- $FF7E. The DDRs matter: a port line reads as an input unless its DDR bit is set, and the hardware
* ---- starts with every DDR clear (MAME's device_start: "memset(m_port_ddr, 0, 4); m_port_ddr[1] = 0xff"),
* ---- so without this the PIC would read its input pins instead of the values it wrote.
RESET   MOVP    %>00,P0 ; IOCNT0 clear: INT3 disabled while the ports are set up
* Port A is an INPUT: it carries the CoCo's command byte in, so its DDR must be clear or the PIC would read
* back its own (empty) output latch instead of the pins. Ports B, C and D are outputs.
        MOVP    %>00,P5 ; port A DDR: every line an input
        MOVP    %>FF,P7 ; port B DDR: every line an output
        MOVP    %>FF,P9 ; port C DDR: every line an output (the control bus)
        MOVP    %>FF,P11 ; port D DDR: every line an output (the data bus)
        MOVP    %>00,P8 ; port C: chip selects deasserted, ALD low, busy low
        MOVP    %>00,P10 ; port D: data bus idle
        MOVP    %>00,P4 ; port A: no command yet
* IOCNT0 as the source ships: $0C sets bits 2 and 3, which Figure 3-16 makes INT2's enable and INT2's flag, so
* INT3 stays masked and the CoCo's command never interrupts. That is deliberate: it is the lockstep's case for a
* core that must refuse a masked interrupt. gen-roms.js builds a second image from this same file with the value
* substituted to $30 (INT3 enable, bit 4, plus INT3 flag clear, bit 5), which is the interrupt path.
IOCNT0_INIT MOVP    %>0C,P0 ; IOCNT0: INT3 masked - bits 2/3 are INT2's enable and flag
        EINT ; global interrupt enable
WAIT    JMP     WAIT ; idle until the CoCo asserts INT3

* ---- INT3 service: forward the command byte to the devices, then release the CoCo's busy line
* The AY-3-8913 takes its register number from the low nibble of the address write and deselects on a
* non-zero upper nibble (js/chips/ay8910.js), so the command byte is masked to a register number before it
* is used as an address. The unmasked byte goes to the SP0256, whose allophone numbers run to 63.
SERVE   MOVP    P4,A ; A = the command byte the CoCo wrote to $FF7E
        MOVP    A,P10 ; port D = the byte: the allophone number for the SP0256
* SP0256 allophone load: ALD (port C bit 5) high, then low, with the byte still on port D
        MOVP    %>20,P8 ; ALD high (bit 5); chip selects deasserted
        MOVP    %>00,P8 ; ALD falls: the SP0256 latches the allophone number
* AY-3-8913: latch the register number (the command's low nibble), then write the low nibble as its data.
* Both writes must carry a value whose upper nibble is clear, because the AY deselects the chip on a non-zero
* upper nibble (js/chips/ay8910.js); the low nibble is what the chip uses for both an address and a data byte.
        ANDP    %>0F,P10 ; port D = the low nibble: a valid AY address and data value
        MOVP    %>09,P8 ; bit 6 clear (ACS selected), bits 3 and 0 set: latch address
        MOVP    %>08,P8 ; bit 6 clear, bit 3 set, bit 0 clear: write data
* release the CoCo's busy line: a 0 -> 1 edge of port C bit 7
        MOVP    %>80,P8 ; busy up
        MOVP    %>00,P8 ; back down, so the next interrupt makes the same edge
        RETI

* ---- vectors: INT3 at >FFF8/>FFF9, reset at >FFFE/>FFFF (Table 3-12)
        ORG     $FFF8
        FDB     SERVE             ; INT3 vector
        ORG     $FFFE
        FDB     RESET             ; reset vector
        END     RESET
