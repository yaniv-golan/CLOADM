# Writing and testing games

[CLOADM](../README.md) › Game development

A practical guide to writing machine-code games for the Dragon 32/64/200 and the Tandy Color Computer 1/2 (and the
CoCo 3 in its CoCo 2 modes) with CLOADM, and to testing them end to end from the command line: keys in, frames run,
the screen, memory, the picture and the sound checked, in CI or by a coding agent. The worked example is a small
game written for this project, [`examples/starter-game/catch.asm`](../examples/starter-game/catch.asm): copy it as a
starting point.

Everything here runs with no ROMs. Hardware facts are from the Motorola data sheets of the chips: the MC6847 Video
Display Generator (VDG), the MC6883 Synchronous Address Multiplexer (SAM), the MC6821 Peripheral Interface Adapter
(PIA) and the MC6809 CPU (its cycle table); [Verification](verification.md) says how CLOADM's models of them are
checked against MAME.

## With or without ROMs

| | Built-in firmware (no ROMs) | Your BASIC ROMs (`--roms`) |
|---|---|---|
| What runs | CLOADM's own small firmware ([`js/machines/stub.js`](../js/machines/stub.js)) | Color BASIC / Dragon BASIC, from your own dumps |
| ROM calls | **POLCAT** (`JSR [$A000]`: a typed key in A, Z set if none) and **CHROUT** (`JSR [$A002]`: print A at the cursor, `$0088`) only. The other vectors at `$A004-$A00D` return at once (the cassette ones with carry set: an error) | every BASIC routine |
| Interrupts | IRQ and FIRQ go through the RAM vectors at `$010C` and `$010F` (a `JMP`, as in Color BASIC); the firmware's handlers just acknowledge the PIAs. The field sync interrupt (PIA0 CB1) is on and the CPU's IRQ unmasked when a program starts | BASIC's own handlers (its `TIMER`, sound) |
| Keys | `--type` feeds POLCAT; `--hold` presses keys in the matrix (what a game reads itself) | `--type` and `--hold` both press keys in the matrix, as BASIC's POLCAT reads it |
| Loads | machine code: `.bin`, `.cas` machine-code files, cartridges (run at `$C000`), `--asm` source | everything, BASIC programs and listings too |
| SAM memory size | 4K (M = 00): set it before showing a screen above `$0FFF` ([The screen](#the-screen)) | set for the machine's RAM |

A game that drives the hardware itself (the screen through the VDG and SAM, keys through the PIA, sound through the
DAC) runs the same on both, and so does one that uses only POLCAT and CHROUT. A program started on the built-in
firmware begins with the screen in text mode at `$0400`, the DAC at mid level with sound enabled, and S at `$03D0`;
set S yourself (`LDS #...`).

The MC-10 and Matra Alice are different machines (MC6803 CPU, no PIAs, the VDG at `$4000`, keys at `$BFFF`); their
built-in firmware has POLCAT at `$F883` and CHROUT at `$F9C6`. This guide is about the 6809 machines.

## Memory maps

The Dragon and the CoCo share their memory map (64K machines in the SAM's map type 0, the power-on state):

| Address | What | Notes for a game |
|---|---|---|
| `$0000-$00FF` | direct page | BASIC's variables; the built-in firmware uses `$0088-$0089` (cursor) |
| `$0100-$01FF` | RAM vectors (`$010C` IRQ, `$010F` FIRQ) | |
| `$0200-$03FF` | BASIC's buffers and stack | the built-in firmware's line buffer `$02D6-$031D`, stack below `$03D0` |
| `$0400-$05FF` | the 32x16 text screen | the SAM can put the screen anywhere on a 512-byte boundary |
| `$0600-$7FFF` | free RAM (to `$3FFF` on 16K) | BASIC's graphics pages start at `$0600`; a disk DOS keeps workspace there and moves them up (by how much depends on the DOS) |
| `$8000-$BFFF` | BASIC ROM (Dragon: 16K; CoCo: Extended BASIC `$8000-$9FFF`, Color BASIC `$A000-$BFFF`) | the built-in firmware here; 64K machines can map RAM instead (SAM map type 1, `$FFDF`) |
| `$C000-$FEFF` | cartridge ROM | a disk ROM, or your cartridge game |
| `$FF00-$FF03` | PIA0 | keyboard and joystick, field sync (FS) on CB1, horizontal sync on CA1, sound mux on CA2/CB2 |
| `$FF20-$FF23` | PIA1 | DAC (PA7-2), cassette, VDG mode (PB7-3), single-bit sound (PB1), sound enable (CB2), cartridge interrupt (CB1) |
| `$FF40-$FF5F` | cartridge I/O | a disk controller |
| `$FFC0-$FFDF` | SAM registers | write-only bit pairs: an even address clears a bit, the odd one sets it |
| `$FFF0-$FFFF` | CPU vectors | read from the ROM's `$BFF0-$BFFF` |

**Where a game goes.** `ORG $3000` runs on every 6809 machine, 16K ones included: code and data from `$3000`, and
`$3000-$3FFF` (4K) is the room a 16K machine has above it; on 32K and 64K machines RAM runs on to `$7FFF`. Set the
stack yourself (the starter game's `LDS #START` grows it down from just below the game, into free RAM). Buffers belong after the code,
as `RMB` (the assembler reserves the space and nothing else is put there) or as `EQU` addresses above the image's
last byte; an `EQU` buffer inside the image overwrites the program when it is written. The assembler does not check
this for you: compare the buffer addresses with the image's end (`--asm game.asm --json` reports the program's
symbols; put a label after the last `RMB` to see where it ends).

The Dragon 64 adds a 6551 ACIA at `$FF04-$FF07`; the CoCo 3 has its GIME at `$FF90-$FFBF` and puts the CoCo 2
text screen where its registers say (the built-in firmware leaves it at `$0400`).

## Programs CLOADM loads

| Format | How it is loaded and started |
|---|---|
| DragonDOS binary (`.bin`: header `$55`, type, load, length, exec, `$AA`) | into memory, then a jump to exec (on the built-in firmware after a reset and two frames) |
| CoCo (DECB) segmented binary (`.bin`: `$00 len addr data`... `$FF 0000 exec`) | the same, every segment |
| `.cas` tape image (and `.wav` recordings of tapes) | a machine-code file goes straight into memory and runs; with BASIC ROMs it is loaded with `CLOADM:EXEC` in emulated tape time (`--fast-cas` skips that) |
| cartridge (`.rom`, `.ccc`, `.dgn`, up to 128K) | in the cartridge port: run at `$C000` on the built-in firmware, autostarted by BASIC with ROMs |
| assembler source (`--asm`) | assembled for the machine's CPU and run (below) |

```sh
node bin/cloadm.js --load game.bin --frames 100 --screenshot game.png      # on the command line
```

On the page, drop the file on the screen or use the Media tab.

## Assembling

CLOADM's assembler ([`js/asm/assembler.js`](../js/asm/assembler.js)) is a two-pass 6809/6309/6803 assembler with the
usual Motorola syntax: `label mnemonic operand ; comment`, a `*` or `;` in the first column for a comment line;
`ORG EQU FCB FDB FCC RMB SETDP INCLUDE END`; `IF`/`ELSE`/`ENDIF` on symbols passed in by the build; expressions with
`+ - * / & | ( )`, `$hex`, `%binary`, `'c'` and `*`. `END label` gives the exec address. It writes a DragonDOS
binary when no block is below the first `ORG` (gaps filled with zeros) and a CoCo segmented binary otherwise; both
load on every machine.

```sh
node bin/cloadm.js --asm game.asm --frames 50 --screen      # assemble and run in one step (INCLUDEs from its folder)
```

From a script, `assemble(source, '6809')` and `toBinary(result)` (`js/emu.js`) give the binary; the page's
Assembler tab does the same. 6809 points that catch people out:

* Branches (`BRA`, `BNE`, ...) reach -128..+127 bytes; the assembler says "branch out of range": use `LBRA`, `LBNE`
  or `JMP`.
* Direct-page addressing is used only when you write `<` (`LDA <$80`); otherwise the assembler uses extended
  addressing, which is always right.
* Disable interrupts (`ORCC #$50`) before you change a vector or the PIA setup, and set your own stack.
* `JSR [$A000]` calls through a ROM vector; `JSR $A000` would run the vector's bytes.

## The keyboard

The keyboard is a matrix of 7 rows by 8 columns on PIA0: write a column pattern to port B (`$FF02`, one bit low
selects a column), read the rows on port A (`$FF00`, a key down pulls its row's bit low; bit 7 is the joystick
comparator). The two families wire the same keys to different rows:

| Row (PA bit) | Dragon, columns 0-7 (PB bit) | CoCo, columns 0-7 |
|---|---|---|
| 0 | `0 1 2 3 4 5 6 7` | `@ A B C D E F G` |
| 1 | `8 9 : ; , - . /` | `H I J K L M N O` |
| 2 | `@ A B C D E F G` | `P Q R S T U V W` |
| 3 | `H I J K L M N O` | `X Y Z UP DOWN LEFT RIGHT SPACE` |
| 4 | `P Q R S T U V W` | `0 1 2 3 4 5 6 7` |
| 5 | `X Y Z UP DOWN LEFT RIGHT SPACE` | `8 9 : ; , - . /` |
| 6 | `ENTER CLEAR BREAK - - - - SHIFT` | `ENTER CLEAR BREAK (ALT CTRL F1 F2 on the CoCo 3) SHIFT` |

So the arrows and SPACE are in columns 3-7 on both, in row 5 on the Dragon and row 3 on the CoCo: testing both row
bits gives one binary for both machines, which is what the starter game does:

```asm
        LDA     #%11011111      ; column 5 (LEFT) low
        STA     $FF02
        LDA     $FF00
        ANDA    #%00101000      ; rows 5 and 3
        CMPA    #%00101000      ; not equal: LEFT is down
```

Put `$FF` back in `$FF02` afterwards. Reading the matrix sees keys held down, which is what a game wants; POLCAT
gives one character per key press instead (with ROMs it reads the same matrix; on the built-in firmware it returns
what `--type` typed). In tests, `--hold RIGHT:10` holds a key for ten frames.

## The screen

The SAM fetches the screen for the VDG; the PIA1 port B bits pick the VDG's mode and the SAM's V bits must match it.

* **Where:** SAM F0-F6 (`$FFC6-$FFD3`) give the screen's address in 512-byte units. `$0400` is F = 2: write
  `$FFC6` (F0 clear), `$FFC9` (F1 set), and `$FFCA`, `$FFCC`, `$FFCE`, `$FFD0`, `$FFD2` (F2-F6 clear).
* **How much it can see:** the SAM's video address counter wraps at the RAM size set in M1-M0 (`$FFDA-$FFDD`):
  4K for M = 00, 16K for 01, all of it for 10. BASIC sets M for the machine's RAM at power-on (10 on 32K and 64K
  machines); the built-in firmware leaves it at 00, so a screen that reaches above `$0FFF` (a graphics page at
  `$0600` already does) shows the bytes at its address modulo 4K until the program sets M itself:
  `STA $FFDA` (M0 clear) and `STA $FFDD` (M1 set) on a 32K or 64K machine, `STA $FFDB` (M0 set) and `STA $FFDC`
  (M1 clear) on a 16K one.
* **Text and semigraphics** (VDG A/G = 0, SAM V = 0): 32x16 characters, one byte each. Codes `$00-$3F` are the VDG's
  64 characters shown light on dark, `$40-$7F` the same characters dark on green (BASIC's screen: a space is `$60`;
  letters `A-Z` are `$41-$5A`, digits and punctuation are their ASCII code plus `$40`). Codes `$80-$FF` are SG4
  blocks: bits 6-4 the colour (0 green, 1 yellow, 2 blue, 3 red, 4 buff, 5 cyan, 6 magenta, 7 orange), bits 3-0 the
  four quarters of the cell (8 top left, 4 top right, 2 bottom left, 1 bottom right), so `$80` is a black cell and
  `$BF` a red one.
* **Graphics** (VDG A/G = 1): PIA1 port B bit 7 is A/G, bits 6-4 GM2-GM0, bit 3 CSS (the colour set); keep bits 2-0
  as they are (bit 2 is the Dragon 64's ROM select, bit 1 the single-bit sound).

| BASIC name | VDG mode | Pixels, colours | `$FF22` bits 7-4 | SAM V2-V0 | Bytes |
|---|---|---|---|---|---|
| PMODE 0 | RG2 | 128x96, 2 | `1011` | 011 | 1536 |
| PMODE 1 | CG3 | 128x96, 4 | `1100` | 100 | 3072 |
| PMODE 2 | RG3 | 128x192, 2 | `1101` | 101 | 3072 |
| PMODE 3 | CG6 | 128x192, 4 | `1110` | 110 | 6144 |
| PMODE 4 | RG6 | 256x192, 2 | `1111` | 110 | 6144 |

In the two-colour modes a set bit is green (CSS 0) or buff (CSS 1) on black; in the four-colour modes each 2-bit
pixel is green, yellow, blue, red (CSS 0) or buff, cyan, magenta, orange (CSS 1). This program draws a green
rectangle in PMODE 4:

```asm
; example: pmode4
        ORG     $3000
START   LDX     #$0600          ; the picture: 6144 bytes from $0600
        LDD     #0
CLEAR   STD     ,X++            ; (about 2.6 frames on a Dragon)
        CMPX    #$0600+6144
        BNE     CLEAR
        LDX     #$0600+32*64+8  ; row 64, byte 8 (pixel 64)
        LDB     #64             ; 64 rows
ROW     LDA     #16             ; 16 bytes = 128 pixels
FILL    COM     ,X+
        DECA
        BNE     FILL
        LEAX    32-16,X         ; the next row: 32 bytes a row
        DECB
        BNE     ROW
        STA     $FFDA           ; SAM M = 10: 32K/64K RAM, so the VDG sees
        STA     $FFDD           ; above $0FFF (the built-in firmware leaves 4K)
        STA     $FFC7           ; SAM F = 3: the picture at 3 x 512 = $0600
        STA     $FFC9
        STA     $FFCA
        STA     $FFCC
        STA     $FFCE
        STA     $FFD0
        STA     $FFD2
        STA     $FFC0           ; SAM V = 110
        STA     $FFC3
        STA     $FFC5
        LDA     $FF22           ; VDG: A/G 1, GM 111 (RG6), CSS 0
        ANDA    #$07
        ORA     #$F0
        STA     $FF22
DONE    BRA     DONE
        END     START
```

The VDG draws the screen line by line while the program runs, so a change to lines it has already drawn this frame
shows only in the next one: in a test, run a frame (`--frames 1`) before a screenshot of something that just
changed.

## Sound

The 6-bit DAC is PIA1 port A bits 7-2 (`$FF20`; bits 1-0 are the printer strobe or serial output and the cassette
input). It reaches the speaker when the analogue multiplexer selects it, PIA0 CA2 = 0 and CB2 = 0 (control
registers `$FF01` and `$FF03` = `$34`), and sound is enabled, PIA1 CB2 = 1 (`$FF23` = `$3C`). The built-in
firmware and BASIC leave all three set that way; a game sets them anyway. Then every write to `$FF20` is a new
level: a square wave is a loop that writes two values, and its pitch is set by the loop's length in CPU cycles.

The starter game's `TONE` routine writes `$FC` and `$00` in turn; one half period is `18 + 8 x A` cycles (counted
from the MC6809 cycle table in its comments), so its pitch is the CPU clock (888,625 Hz on the Dragon, 894,886 Hz
on the CoCo) divided by twice that. The CPU plays the sound itself, so the game stops while it plays; a game that
must keep moving plays a few cycles of the wave each frame instead. The single-bit sound output (PIA1 PB1) adds the
level of 32 DAC steps when set (the sample 10240 in a `--wav` recording).

## Timing

The VDG's field sync (FS) ends each frame: 50 times a second on a Dragon (PAL), 60 on a CoCo. It reaches PIA0 CB1,
which sets bit 7 of `$FF03`; reading `$FF02` clears it. Either poll it (the starter game, with interrupts off):

```asm
WAITFS  LDA     $FF02           ; clear the flag
WFS     LDA     $FF03           ; bit 7: the next field sync
        BPL     WFS
        RTS
```

or let it interrupt: with bit 0 of `$FF03` set the flag raises IRQ, which goes through the RAM vector at `$010C`:

```asm
; example: vsync
        ORG     $3000
START   ORCC    #$50            ; no interrupts while the vector changes
        LDA     #$7E            ; JMP TICK at the IRQ RAM vector
        STA     $010C
        LDX     #TICK
        STX     $010D
        LDA     #$35            ; PIA0 CB1 (FS) interrupt on, CB2 low (the DAC mux)
        STA     $FF03
        ANDCC   #$EF            ; IRQ on (FIRQ stays off)
MAIN    LDA     FRAMES
WAIT    CMPA    FRAMES          ; until the next frame
        BEQ     WAIT
        LDA     FRAMES          ; one frame's work: here, the count on the screen
        STA     $0400
        BRA     MAIN
TICK    LDA     $FF02           ; acknowledge: reading port B clears the flag
        INC     FRAMES
        RTI
FRAMES  FCB     0
        END     START
```

With BASIC ROMs, taking over `$010C` stops BASIC's own interrupt work (its `TIMER`, `SOUND` and `PLAY`), which a
machine-code game doesn't need. `CWAI #$EF` or `SYNC` wait for the interrupt without the busy loop.

## The ROM calls

With only POLCAT and CHROUT a program prints and reads keys on every 6809 machine, with or without ROMs:

```asm
; example: hello
        ORG     $3000
START   LDX     #MSG
PRINT   LDA     ,X+
        BEQ     KEY
        JSR     [$A002]         ; CHROUT: print A
        BRA     PRINT
KEY     JSR     [$A000]         ; POLCAT: a key in A, Z set if none
        BEQ     KEY
        JSR     [$A002]         ; echo it
        BRA     KEY
MSG     FCC     "PRESS A KEY"
        FCB     13,0
        END     START
```

```sh
node bin/cloadm.js --asm hello.asm --type 'Z' --expect-screen 'PRESS A KEY\nZ'
```

## Testing a game from the command line

The command line ([Automation](automation.md) has every step) runs the game in emulated time, so the same steps give
the same frames, screens and sounds on every run. A test is a script of steps:

* **Start the game:** `--load game.bin` (or `--asm game.asm`).
* **Wait, don't sleep:** `--wait-for 'text:PRESS SPACE'` (the screen text), `--wait-for 'mem:$3005=1'` (a byte),
  `--wait-for 'pc:$3100'` (an address reached); `--frames N` or `--seconds S` to let time pass.
* **Press keys:** `--hold SPACE:2`, `--hold RIGHT:10`, `--hold LEFT+SPACE` (the matrix, for games); `--type 'RUN\n'`
  (typing, for POLCAT and BASIC).
* **Check:** `--expect-screen 'SCORE 002'`, `--expect-mem '$3003=2'`, `--expect-screenshot ref.png`; any that fails
  ends the run with exit code 1 and the screen it failed on.
* **Keep the evidence:** `--screenshot out.png`, `--wav out.wav` ... `--wav-stop`, `--save-snapshot`.

Two habits make games easy to test. Keep the state a test reads (score, lives, the game's state) at fixed addresses,
as the starter game does at `$3003-$3008`; and change the byte a test waits for after the screen it announces is
drawn, so a test that waits for it sees the new screen.

The starter game's own test, [`examples/starter-game/catch.cloadm`](../examples/starter-game/catch.cloadm), plays two
catches and lets three blocks fall:

```text
load examples/starter-game/catch.bin
wait-for text:PRESS SPACE TO START
hold SPACE:2
wait-for mem:$3005=1
expect-mem $3007=13
hold LEFT
expect-mem $3006=13
wait-for mem:$3003=1
...
expect-screen SCORE 002
frames 1
expect-screenshot tests/fixtures/starter-game/catch-play.png
timeout 60
wait-for mem:$3005=2
expect-screen GAME OVER
```

```sh
node bin/cloadm.js --script examples/starter-game/catch.cloadm              # Dragon 64 (the default)
node bin/cloadm.js --machine coco --script examples/starter-game/catch.cloadm
```

The picture reference belongs to the video chip that drew it: the Dragon 32, 64 and 200 and the CoCo 1/2 (an MC6847)
draw this screen identically, while the CoCo 2B's MC6847T1 draws other letter shapes and the CoCo 3's frame is twice
as wide, so a game that runs on those keeps a reference per chip.

### Two patterns that settle a test

**Wait for the byte, then one frame, then look at the picture.** A game changes its state byte while the VDG is part
way through drawing a frame, so the frame on screen at that moment is still partly the old one. `--expect-screen`
and `--expect-mem` read memory and hold as soon as the bytes are written; a screenshot (`--screenshot`,
`--expect-screenshot`) is the last frame the VDG drew, so run `--frames 1` before it:

```sh
# pattern: settle
node bin/cloadm.js --load examples/starter-game/catch.bin --wait-for 'text:PRESS SPACE' --hold SPACE:2 \
  --wait-for 'mem:$3005=1' --frames 1 --expect-screen 'SCORE 000' --screenshot playfield.png
```

Without `--frames 1` the picture is the half-drawn frame, and it differs from one taken a frame later.

**Wait for a key to be let go.** A key that started one screen must not also act on the next: the starter game's
`WAITSP` waits until SPACE is up, then until it is pressed, so SPACE held from the title screen does not skip the
game-over screen. In the test, `--hold SPACE:2` presses and releases (two frames down, then up), so each screen sees
its own press; a key held across a screen change is one press, and the next screen waits for it to be released.
Playing again after the game ends:

```sh
# pattern: release
node bin/cloadm.js --load examples/starter-game/catch.bin --wait-for 'text:PRESS SPACE' --hold SPACE:2 \
  --wait-for 'mem:$3005=1' --timeout 60 --wait-for 'mem:$3005=2' --hold SPACE:2 --wait-for 'mem:$3005=1' \
  --frames 1 --expect-mem '$3004=0' --expect-screen 'SCORE 000'
```

And the other side, the test that the game waits: SPACE held from the title to past the end of the game is one
press, so the game-over screen stays (a game without the release wait starts again at once, and this fails):

```sh
# pattern: held
node bin/cloadm.js --load examples/starter-game/catch.bin --wait-for 'text:PRESS SPACE' --hold SPACE:2500 \
  --frames 50 --expect-mem '$3005=2' --expect-screen 'GAME OVER'
```

### Visual and audio regression tests

A **picture** reference is a PNG of a frame you have looked at and approved: make it once with `--screenshot`, check
it in, and compare every later run with `--expect-screenshot`, pixel for pixel. A difference fails with the number
of pixels and the first one (position, expected and actual colour); `--diff diff.png` before it writes a picture
with the differences in red; `--tolerance N` allows N pixels (for a blinking cursor, say). The frame is the
machine's own pixels, the same on every run, so the default tolerance of 0 is the one to use. The starter game's
reference is [`tests/fixtures/starter-game/catch-play.png`](../tests/fixtures/starter-game/catch-play.png), for the
MC6847 machines (above).

A **sound** reference is a WAV of a sound effect: `--wav` records the frames that run until `--wav-stop`, as 16-bit
PCM at 44100 Hz, with the DAC's levels exact (value d is 320 x d) and no filtering, so the same run gives the same
file, byte for byte, and a plain `cmp` is the comparison:

```sh
node bin/cloadm.js --load examples/starter-game/catch.bin --wait-for 'text:PRESS SPACE' --hold SPACE:2 \
  --wait-for 'mem:$3005=1' --hold LEFT --wait-for 'mem:$3008=14' \
  --wav catch.wav --frames 12 --wav-stop --expect-mem '$3003=1'
cmp catch.wav tests/fixtures/starter-game/catch-sound.wav
```

[`tests/starter-game.test.js`](../tests/starter-game.test.js) runs both, and checks that they fail when the game is
broken (a paddle that does not move, a catch that does not score, a sound a semitone off, another colour). Make a
new reference only after looking at (or listening to) the new output: a test that rewrites its own reference checks
nothing.

### GitHub Actions

```yaml
jobs:
  game:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@v4
        with: { path: game }
      - uses: actions/checkout@v4
        with: { repository: yaniv-golan/cloadm, path: cloadm }
      - uses: actions/setup-node@v4
        with: { node-version: '22' }
      # the game, played and checked on both families; no ROMs needed
      - run: |
          for m in dragon64 coco; do
            node cloadm/bin/cloadm.js --machine $m --asm game/src/game.asm \
              --wait-for 'text:PRESS SPACE' --hold SPACE:2 --wait-for 'mem:$3005=1' \
              --frames 1 --diff diff-$m.png --expect-screenshot game/test/play-$m.png \
              --wav sound-$m.wav --frames 25 --wav-stop
            cmp sound-$m.wav game/test/sound-$m.wav
          done
      - uses: actions/upload-artifact@v4
        if: failure()
        with: { name: differences, path: 'diff-*.png' }
```

---

See also: [Automation](automation.md) · [Using CLOADM](using.md) · [Machines](machines.md)
