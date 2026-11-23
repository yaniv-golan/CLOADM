# Debugging programs on the emulated machine

The machine stops between tool calls, so everything here is safe to repeat: nothing runs unless you run it.
On this computer, save a snapshot before you poke or step through something you may want to undo.

## Stop at an address (a breakpoint)

`run_frames` with `until: {pc: "$3012"}` runs until the program counter reaches that address and stops at that
instruction (`status: "met"`). Then read the registers, peek memory, or step. `"not-yet"` means the code did not get
there in those frames: the branch you expected was not taken, or the program is waiting for input. Give it the input
or look at where it is (the result carries the PC).

A watchpoint on data: `until: {address: "$0400", value: 72}` stops as soon as that byte holds that value.

## Step

`step` runs exactly `count` instructions and returns the registers and the cycles they took. Step a few at a time
and disassemble at the PC to see what is next. After stepping, the video frame is unfinished: a screenshot then is
the last whole frame (`mid_frame: true`); run 2 frames to see a whole frame drawn after it.

In the side panel the person can stop the machine in the page's Debugger. Then `step` still steps (as the Debugger's
Step does) and leaves the machine stopped where it ended, but `run_frames`, `type_text`, `press_keys`, `press_break`
and `run` fail with `machine-stopped` until the person presses Resume: read the registers and memory meanwhile.

## Read code

`disassemble` from an address (up to 64 instructions) in the machine's own instruction set (6809, 6309 or 6803).
Start at a known entry point: the exec address a load reported, the address you passed to `run`, the PC from
`registers`, or a vector (`peek` two bytes at `$FFFE` for reset, `$010C` for the IRQ jump on a 6809 Dragon/CoCo).
Disassembling from the middle of an instruction gives nonsense that looks plausible: if a listing looks odd, start a
byte or two earlier.

## Search memory

`find_bytes` takes a hex pattern with `??` for any byte (`"B6 FF 00"`, `"86 ?? 39"`) and an optional `from`/`to`
range, and returns where it starts, as `$hex`, at most 64 (narrow the range when it says `truncated`). Useful
patterns on the 6809 Dragon and CoCo:

| Looking for | Pattern |
|---|---|
| code that writes a keyboard column (`STA $FF02`, `STB $FF02`) | `B7 FF 02`, `F7 FF 02` |
| code that reads the keyboard rows (`LDA $FF00`, `LDB $FF00`) | `B6 FF 00`, `F6 FF 00` |
| calls to POLCAT / CHROUT (`JSR [$A000]` / `JSR [$A002]`) | `AD 9F A0 00`, `AD 9F A0 02` |
| writes to the VDG mode (`STA $FF22`) | `B7 FF 22` |
| a text string on screen codes or ASCII | the bytes of the string |

Then disassemble around each hit to see what it does.

## Which keys does a program read?

A program that scans the matrix writes a column mask to `$FF02` and tests row bits read from `$FF00`. Find those
(`find_bytes` above, or stop at them with `until: {pc}`), and disassemble around them: the value stored to `$FF02`
selects the column (the zero bit), and the `ANDA`/`BITA` mask after the read selects the rows. Look the pair up in the
keyboard matrix in `references/hardware.md` (the Dragon and the CoCo wire rows differently). A program that uses
POLCAT gets ASCII codes instead: look for `CMPA #<code>` after the `JSR [$A000]`.

Confirm by experiment: save a snapshot (on this computer), `press_keys` the key you think it reads for a few frames, check the effect
(screen, memory, PC), restore, and try the next.

## Registers

`registers` gives them as decimal numbers (pc, a, b, d, x, y, u, s, dp, cc on the 6809; e, f, w, v, md too on the
6309; a, b, d, x, s, cc on the 6803). CC bits, high to low: E F H I N Z V C.
