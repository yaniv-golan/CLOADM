# Dragon and CoCo hardware for programs you write

For the 6809 Dragons and the CoCo 1/2 (and the CoCo 3 in its CoCo 2 modes). Take register values from here, not from
memory: one wrong bit gives another valid mode, which looks plausible and is wrong. The sources are the Motorola
data sheets of the MC6847 VDG, the MC6883 SAM and the MC6821 PIA, and CLOADM's models of those chips
(`js/chips/mc6847.js`, `js/chips/sam6883.js` in the CLOADM repository), which are checked against MAME.

## Memory map (64K machines, SAM map type 0)

| Address | What |
|---|---|
| `$0000-$00FF` | direct page (BASIC's variables; the built-in firmware's cursor at `$0088-$0089`) |
| `$0100-$01FF` | RAM vectors: IRQ `$010C`, FIRQ `$010F` (a `JMP`) |
| `$0200-$03FF` | BASIC's buffers and stack (the built-in firmware's stack below `$03D0`) |
| `$0400-$05FF` | the 32x16 text screen |
| `$0600-$7FFF` | free RAM (to `$3FFF` on 16K); BASIC's graphics pages start at `$0600` |
| `$8000-$BFFF` | BASIC ROM, or the built-in firmware |
| `$C000-$FEFF` | cartridge ROM (a disk ROM, or a game) |
| `$FF00-$FF03` | PIA0: keyboard and joystick; field sync on CB1 |
| `$FF20-$FF23` | PIA1: DAC (PA7-2), VDG mode (PB7-3), single-bit sound (PB1) |
| `$FF40-$FF5F` | cartridge I/O (a disk controller) |
| `$FFC0-$FFDF` | SAM: write-only bit pairs, the even address clears a bit and the odd one sets it (the value written does not matter) |
| `$FFF0-$FFFF` | CPU vectors |

## The text screen

32x16 characters, one byte each, at `$0400` unless the SAM is moved. Codes `$00-$3F`: the VDG's 64 characters light
on dark; `$40-$7F`: the same dark on green (BASIC's screen; a space is `$60`, `A-Z` are `$41-$5A`, digits and
punctuation are their ASCII code plus `$40`). Codes `$80-$FF`: SG4 semigraphics blocks: bits 6-4 the colour
(0 green, 1 yellow, 2 blue, 3 red, 4 buff, 5 cyan, 6 magenta, 7 orange), bits 3-0 the four quarters (8 top left,
4 top right, 2 bottom left, 1 bottom right): `$80` is a black cell, `$8F` a green one, `$BF` a red one.

## Graphics modes

The VDG's mode comes from PIA1 port B (`$FF22`): bit 7 A/G (1 = graphics), bits 6-4 GM2-GM0, bit 3 CSS (colour
set). Keep bits 2-0 as they were (read `$FF22`, `ANDA #$07`, `ORA` the new bits). The SAM's V2-V0 must match.

| BASIC | VDG mode | Pixels, colours | `$FF22` bits 7-4 | `$FF22` with CSS 0 / 1 (low bits 0) | SAM V2-V0 | Bytes |
|---|---|---|---|---|---|---|
| PMODE 0 | RG2 | 128x96, 2 | `1011` | `$B0` / `$B8` | 011 | 1536 |
| PMODE 1 | CG3 | 128x96, 4 | `1100` | `$C0` / `$C8` | 100 | 3072 |
| PMODE 2 | RG3 | 128x192, 2 | `1101` | `$D0` / `$D8` | 101 | 3072 |
| PMODE 3 | CG6 | 128x192, 4 | `1110` | `$E0` / `$E8` | 110 | 6144 |
| PMODE 4 | RG6 | 256x192, 2 | `1111` | `$F0` / `$F8` | 110 | 6144 |

Two-colour modes: a set bit is green (CSS 0) or buff (CSS 1) on black, 8 pixels a byte, most significant bit on the
left. Four-colour modes: 2 bits a pixel, green/yellow/blue/red (CSS 0) or buff/cyan/magenta/orange (CSS 1). A row is
32 bytes in the 256-wide and 4-colour 128-wide modes, 16 bytes in RG2 and RG3. Note `$E8` is CG6 (PMODE 3, four
colours), not PMODE 4.

## The SAM: where the screen is, how much it sees, which mode

- **V2-V0** (`$FFC0-$FFC5`): `$FFC0`/`$FFC1` clear/set V0, `$FFC2`/`$FFC3` V1, `$FFC4`/`$FFC5` V2. Text is V = 000.
- **F0-F6** (`$FFC6-$FFD3`): the screen's address in 512-byte units, `$FFC6`/`$FFC7` clear/set F0 up to
  `$FFD2`/`$FFD3` for F6. `$0400` is F = 2 (`$FFC6`, `$FFC9`, `$FFCA`, `$FFCC`, `$FFCE`, `$FFD0`, `$FFD2`); `$0600`
  is F = 3 (`$FFC7`, `$FFC9`, then F2-F6 cleared).
- **M1-M0** (`$FFDA-$FFDD`): the RAM size the video counter wraps at. BASIC sets it at power-on; **the built-in
  firmware leaves it at 4K**, so a screen reaching above `$0FFF` (any graphics page at `$0600`) shows the wrong bytes
  until you set it: `STA $FFDA` (M0 clear) and `STA $FFDD` (M1 set) on a 32K or 64K machine.

## Recipe: PMODE 4 on the built-in firmware

Checked in CLOADM on a Dragon 64 without ROMs: a green rectangle on black.

```asm
        ORG     $3000
START   LDX     #$0600          ; the picture: 6144 bytes from $0600
        LDD     #0
CLEAR   STD     ,X++
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
        STA     $FFDA           ; SAM M = 10: 32K/64K RAM
        STA     $FFDD
        STA     $FFC7           ; SAM F = 3: the picture at $0600
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

Then `run` `"$3000"`, `run_frames` until `{pc: <DONE's address>}` (the assembler's result gives the symbols), then 2
more frames (the one it stopped in, then a whole one), then `screenshot`.

## The keyboard matrix (what games read)

Write a column pattern to `$FF02` (one bit low selects a column), read the rows on `$FF00` (a key down pulls its row
bit low; bit 7 is the joystick comparator). Put `$FF` back in `$FF02` afterwards.

| Row (PA bit) | Dragon, columns 0-7 | CoCo, columns 0-7 |
|---|---|---|
| 0 | `0 1 2 3 4 5 6 7` | `@ A B C D E F G` |
| 1 | `8 9 : ; , - . /` | `H I J K L M N O` |
| 2 | `@ A B C D E F G` | `P Q R S T U V W` |
| 3 | `H I J K L M N O` | `X Y Z UP DOWN LEFT RIGHT SPACE` |
| 4 | `P Q R S T U V W` | `0 1 2 3 4 5 6 7` |
| 5 | `X Y Z UP DOWN LEFT RIGHT SPACE` | `8 9 : ; , - . /` |
| 6 | `ENTER CLEAR BREAK - - - - SHIFT` | `ENTER CLEAR BREAK (CoCo 3: ALT CTRL F1 F2) SHIFT` |

The arrows and SPACE are columns 3-7 on both, row 5 on the Dragon and row 3 on the CoCo.

## 6809 points that catch people out

- Short branches reach -128..+127 bytes: use `LBRA`, `LBNE` or `JMP` beyond that.
- Direct-page addressing only when you write `<` (`LDA <$80`); otherwise extended, which is always right.
- `ORCC #$50` before changing a vector or the PIA set-up, and set your own stack.
- `JSR [$A000]` calls through a ROM vector; `JSR $A000` would run the vector's bytes.
