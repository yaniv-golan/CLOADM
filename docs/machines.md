# Machines

[CLOADM](../README.md) › Machines

Which machines CLOADM emulates, their options, and what is emulated chip by chip. Verification results are in [verification.md](verification.md).

## Models

| | Machine | CPU · video | Your ROM files | Against MAME ([details](verification.md)) |
|---|---|---|---|---|
| **DRAGON** | Dragon 32, Dragon 64, Dragon 200, Dragon 200-E, Dragon 64 Plus, Tano Dragon 64 | 6809 · MC6847 (+ HD6845S CRTC on the 64 Plus) | `d32.rom`, `d64_1.rom` + `d64_2.rom`, … | ✅ trace · ✅ video 20/20 on the Dragon 32, 64, 200, 200-E and Tano, PAL colour blending included on the Dragon 32, 64 and 200 (the Tano is NTSC) |
| **DRAGON** | Dragon Professional (Alpha): boot ROM, AY-3-8912 sound, built-in disk interface | 6809 · MC6847 | `alpha_bt_10.rom` + `alpha_ba.rom` | ✅ trace · ✅ video 20/20 · ✅ its own hardware and disk interface in lockstep, disk images byte-identical · ✅ sound against MAME's recording, within a stated tolerance |
| **COCO** | CoCo 1/2, CoCo 2B (MC6847T1 with lowercase) | 6809 · MC6847 / T1 | `bas13.rom` + `extbas11.rom` | ✅ trace · ✅ video 20/20, artifact colours included |
| **COCO** | Prológica CP 400 | 6809 · MC6847 | the CP 400's BASIC | ✅ trace · ✅ video 20/20 |
| **COCO 3** | CoCo 3, 128K / 512K | 6809 · GIME | `coco3.rom` | ✅ trace · ⚠️ video 34/49, the rest differ in text glyph shapes; artifact colours identical · ⚠️ PAL not verified (MAME's PAL CoCo 3 runs, but on a 262-line screen) |
| **MC-10** | MC-10 | 6803 · MC6847 | `mc10.rom` | ✅ trace · ✅ video 20/20, artifact colours included |
| **MC-10** | Matra Alice | 6803 · MC6847 | `alice.rom` | ✅ trace |
| **CLONES** | Dynacom MX-1600, LZ Color64, Codimex CD-6809 | 6809 · MC6847 | the clone's BASIC | ✅ trace |

Pick the machine from the menu at the top left of the emulator; switching a running machine asks first. RAM, CPU
and the CPU speed are in Machine settings: the CoCo 1/2 and 2B, the CoCo clones and the CP-400 offer 4K,
16K, 32K or 64K, and the MC-10 and Alice 4K or 20K. With less RAM selected, RAM
above the fitted chips is absent, and the SAM mirrors the video to what is there (MC6883 data sheet, p. 4-645).
On NTSC machines the 256×192 two-colour mode shows composite artifact colours, as on a TV, and on PAL Dragons the
colour modes show a PAL TV's blending of neighbouring lines. The Dragon 200-E fits a character generator ROM in
place of the VDG's own set; its video comparison shows the VDG's addressing and wiring with a character set built
by this project, not the real glyphs. The Dragon 64 Plus adds a second, 80-column screen of its own (640×264,
from its Hitachi HD6845S CRT controller), and the Display tab switches between the two; its glyphs, too, come
from a user-supplied character generator.

The Dragon 64, the Tano Dragon 64, the CoCo 1/2 and the CoCo 3 can run the Hitachi 6309 in place of the 6809
(Machine settings, CPU). The core and its sources are described in [cpu6309.md](cpu6309.md). The 6309 runs the 6809
instruction set in emulation mode, so the programs that run without ROMs — the welcome menu, LIZA and the colour
demo — and the Claude chat firmware run on it unchanged.

## What is emulated

| Part | Notes |
|---|---|
| MC6809E CPU | Full documented instruction set, all addressing modes, cycle counts, IRQ/FIRQ/NMI, SWI1-3, CWAI, SYNC |
| TMS7000 / TMS7040 CPU | The Speech/Sound Pak's own processor: the documented instruction set, all addressing modes, the status register, the stack in the register file, the five maskable interrupts and their vectors, and TRAPs. Assembler and disassembler included. Used by the Speech/Sound Pak cartridge (`js/machines/ssc.js`); its IOCNT0 per-level enables and flags follow the manual, differing from MAME (see below), and it is in lockstep with MAME through `run.js coco --ssc` (the SSC's ROM is user-supplied, so its firmware has to be ours) |
| SAM 6883 | Video mode and display offset, memory size and map type 0/1 (32K/64K mode; map type 1 needs the 64K size bit M1, as in MAME), page bit P1 (the low 32K moved to the upper half of RAM in 64K mode), ROM vectors, CPU rate (the speed POKEs: slow, address-dependent and fast, timed per bus cycle; at the fast rate the picture is lost as on the real machine) |
| 2 × MC6821 PIA | Data, DDR and control registers, C1 edge interrupts, C2 outputs |
| MC6847 VDG | Text, SG4/SG6 semigraphics, all 8 graphics modes, CSS colour sets; each line drawn as the beam passes it, so mode changes part-way along a line show where they happen; composite colour (NTSC artifact colours, PAL line blending) as MAME models it. An external character generator can replace the internal set (the Dragon 200-E's character ROM, with that machine's rewired AS/INTEXT/INV inputs) |
| MC6845 / HD6845S CRTC | The full register set as the data sheet defines it: frame geometry, display enable, start and cursor addresses, the cursor (start/end raster, blink bits), horizontal and vertical sync, and the HD6845S's readable start address, vertical sync width and non-wrapping cursor. The chip the Dragon 64 Plus's 80-column board rests on |
| Keyboard | Dragon matrix layout, mapped from the PC keyboard. Fast typing loses nothing: key changes are queued and applied at frame starts, one new key a frame, each held at least 3 frames and in the order typed |
| Sound | 6-bit DAC and single-bit sound through Web Audio, played on the audio thread by an AudioWorklet (a ScriptProcessorNode only where no AudioWorklet module can load: the connector's inline view, plain `http://`). No pops: resets, power cycles, machine switches, program loads and unlocking sound don't click, and pausing (or turbo, or sound off) fades out and back in over 5 ms; after a gap it waits for 40 ms of sound before fading back in, so it doesn't stutter while refilling |
| Cassette | `.CAS` turned into a real 1200/2400 Hz waveform on the cassette input, motor control, fast-forward while loading. WAV recordings decoded to `.CAS` (noise, speed drift, inverted phase and DC offset handled). **Record** captures what the machine writes to the cassette output (the DAC on the Dragon and CoCo, P20 on the MC-10) while the motor runs and saves it as `.CAS`; **Save .WAV** saves that recording or the tape in the deck as sound. While a tape is in the deck, the cassette panel under the screen shows the block being read, a counter, the motor, how fast it runs (fast-forward or **Real speed**), marks a read error (BASIC's `?IO ERROR` as the motor stops) with a rewind, and can **Skip the tape** (load what is on it instantly) |
| Joysticks | DAC comparator, with the mouse acting as the right joystick |
| Display | CRT · composite (composite colour, a WebGL CRT look with curvature, phosphor glow and scan lines) or Sharp · RGB (the pixels as they are); NTSC artifact phase; integer scaling; 4:3 or fill; an Old TV warm-up at power-on (off by default); remembered |
| Dragon 64 | Switching between the 32K-mode and 64K-mode BASIC ROMs through PIA1 PB2, and the 6551 ACIA's serial port at `$FF04-$FF07` ([which models have which serial, tape and disk paths](automation.md#which-storage-and-serial-paths-each-model-has); [a graphics program with no text to wait on](automation.md#a-graphics-program-has-no-text-to-wait-on); [a complete headless Node example](automation.md#a-complete-example-that-runs-from-outside-the-repository); [reading a disk with no DOS ROM](automation.md#reading-a-disk-with-no-dos-rom)) |
| Dragon 200-E | The Spanish character generator ROM in place of the VDG's internal set, and the driver's rewired VDG inputs; a 4K character-generator socket, required to boot |
| Printer | Dragons: the parallel port (PIA0 port B, one byte per strobe pulse on PIA1 PA1, BUSY on PIA1 PB0: CLOADM's printer is always attached and ready). CoCo 1/2/3 and MC-10: a serial printer on the bit-banger at 600 baud, as MAME fits by default. Shown in Machine settings, saved as received |
| DriveWire | CoCo 1/2/3 and clones, option `becker` (`?becker=true`): MAME's Becker port at $FF41 (status, bit 1: data waiting) and $FF42 (data); on the CoCo 3 only while the GIME's $FF90 bit 2 enables the spare chip select, as in MAME. The DriveWire 4 server (`js/drivewire/server.js`) runs in the page: disk transactions on up to 256 drives (images in the media store, read and written a sector at a time), named objects, printing (to the printout of the machine that printed), the time, 15 virtual serial channels (each can be bridged to a WebSocket, `js/host/drivewire-ws.js`). Machine settings: drives 0-3, write protect, add / new blank / save an image, one channel's WebSocket |
| Serial port | CoCo 1/2/3 and MC-10 bit-banger (TXD PIA1 PA1 / port 2 bit 0, RXD PIA1 PB0 / port 2 bit 2, DCD PIA1 CA1, MC-10 CTS port 2 bit 3), with a printer, a terminal (300-9600 baud, in Machine settings) or a loopback plug. Dragon 64, 200 and Tano: the 6551 ACIA at $FF04-$FF07 (all rates and word formats, parity, break, echo, interrupts on the CPU's IRQ), with nothing plugged in, a terminal or a loopback plug |
| Dragon Professional (Alpha) | As MAME's `dgnalpha`: the boot ROM bank and the BASIC bank (switched through PIA1 PB2 or PIA2 PA2), a third PIA, the AY-3-8912 (three tone channels, noise, envelopes; its port A selects the drives), the built-in WD2797 with two 3.5" drives (NMI through PIA2 CA2, DRQ on PIA2 CB1), the modem's registers. Its disks go in from the drives card under the screen, on its two built-in drives (no cartridge) |
| Dragon 64 Plus | A second, 80-column screen from an HD6845S CRTC and an 8K character generator (640×264, 80×22 characters of 8×12), the `$FFE2` bank register (two extra 32K RAM banks and a 2K video-RAM overlay over `$0000-$07FF`, for the CPU only: the MC6847 always shows the motherboard RAM), and `$FFE2`'s display-enable status. An 8K character-generator socket, required for that screen; the 512-byte timing PROM is stored and not used |

---

See also: [Using CLOADM](using.md) · [ROM list](roms.md) · [Verification](verification.md) · [The HD6309](cpu6309.md)
