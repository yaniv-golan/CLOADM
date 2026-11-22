# Models, ROMs and what runs without them

The model list tool gives this live (with each option's allowed values); this is a summary to plan with. CLOADM ships
no ROMs. The user supplies their own dumps to the server; never ask for, fetch or write out ROM images.

## Models

| `model` | Machine | CPU | ROM files for BASIC (the first group is required) | Options |
|---|---|---|---|---|
| `dragon32` | Dragon 32 | 6809 | Dragon 32 BASIC: `d32.rom` | cpu, ram, hires |
| `dragon64` | Dragon 64 (the default) | 6809/6309 | 32K-mode BASIC: `d64_1.rom`; optional 64K-mode BASIC: `d64_2.rom` | cpu, ram, hires, ssc |
| `dragon200` | Dragon 200 | 6809 | 32K-mode BASIC: `ic18.rom`; optional 64K-mode BASIC: `ic17.rom` | cpu, ram, hires |
| `dragon200e` | Dragon 200-E | 6809 | 32K-mode BASIC: `ic18_v1.4e.ic34`; optional 64K-mode: `ic17_v1.4e.ic37`; character generator: `rom26.ic1` | cpu, ram, hires, inverseVideo |
| `tanodr64` | Tano Dragon 64 | 6809/6309 | as the Dragon 64 | cpu, ram, hires |
| `dgnalpha` | Dragon Professional (Alpha) | 6809 | boot ROM: `alpha_bt_10.rom` or `alpha_bt_04.rom`; BASIC: `alpha_ba.rom` | cpu, ram |
| `d64plus` | Dragon 64 Plus | 6809 | as the Dragon 64, plus the 80-column board's character generator `chargen.ic22` | cpu, ram |
| `coco` | Color Computer 1/2 | 6809/6309 | Color BASIC: `bas12.rom`, `bas11.rom`, `bas10.rom` or `bas13.rom`; optional Extended Color BASIC: `extbas11.rom` or `extbas10.rom` | cpu, ram, hires, becker, ssc |
| `coco2b` | Color Computer 2B | 6809 | Color BASIC `bas13.rom`; optional Extended `extbas11.rom` | cpu, ram, hires, becker, ssc |
| `mx1600` | Dynacom MX-1600 | 6809 | `mx1600bas.rom`; optional `mx1600extbas.rom` | cpu, ram, hires, becker |
| `lzcolor64` | LZ Color64 | 6809 | `color_basic.ci24`; optional `extendido.ci23` | cpu, ram, hires, becker |
| `cd6809` | Codimex CD-6809 | 6809 | `cd6809bas84.rom` or `cd6809bas83.rom`; optional Extended | cpu, ram, hires, becker |
| `cp400` | Prológica CP-400 | 6809 | `cp400bas.rom` | cpu, ram, hires, becker |
| `coco3` | Color Computer 3 | 6809/6309 | Super Extended Color BASIC: `coco3.rom` | cpu, ram, hires, becker, ssc |
| `coco3p` | Color Computer 3 (PAL) | 6809 | `coco3p.rom` | cpu, ram, hires, becker |
| `mc10` | TRS-80 MC-10 | 6803 | Micro Color BASIC: `mc10.rom` | cpu, ram |
| `alice` | Matra Alice | 6803 | `alice.rom` | cpu, ram |

Options go in `boot`'s `options`, e.g. `{"cpu": "6309"}` on a Dragon 64, CoCo or CoCo 3, `{"ram": 16}` where the
model offers it. DIR and the other disk commands need the user's disk ROM (DragonDOS or Disk Extended Color BASIC);
without it a disk still goes in, on the disk controller alone, for a program that drives the controller itself (the
result says so).

## Without ROMs: the built-in firmware

Every model boots CLOADM's own small firmware. After a few frames the screen shows the model's name and
`NO ROM LOADED - BUILT-IN STUB`: wait for `BUILT-IN STUB` before you run anything. It gives:

- **POLCAT** (`JSR [$A000]`): returns a key typed with `type_text` in A, Z set if none. It does not see keys held
  with `press_keys` (those go to the keyboard matrix, which games scan themselves).
- **CHROUT** (`JSR [$A002]`): prints A at the cursor (`$0088-$0089`) on the 32x16 text screen at `$0400`.
- The other ROM vectors (`$A004-$A00D`) return at once; the cassette ones with carry set (an error).
- IRQ and FIRQ through the RAM vectors at `$010C` and `$010F`; the field-sync interrupt on.
- A program it starts begins with the text screen at `$0400` and S at `$03D0`: set your own stack.
- The SAM's memory size is left at 4K: a screen above `$0FFF` needs it set (`references/hardware.md`).

On the MC-10 and the Alice (6803, no PIAs, the screen at `$4000`) POLCAT is at `$F883` and CHROUT at `$F9C6`.

What runs: machine code (`assemble_and_load` + `run`), `.bin` files (DragonDOS or CoCo DECB), machine-code `.cas`
tapes (straight into memory), cartridges (`.rom`, `.ccc`: started at `$C000`), and the bundled programs. What does
not: BASIC (`load_basic`, typing `RUN`, `.bas` files are refused with `no-basic`), BASIC tapes, disks.

## The bundled programs

`load` with `program`:

| Program | What it is | Models |
|---|---|---|
| `liza` | a small therapist chatbot: shows `>` and answers a typed line (`BYE` to leave) | 6809 models; the MC-10 and Alice get their own 6803 build |
| `welcome` | CLOADM's welcome screen | 6809 models; 6803 builds for the MC-10 and Alice |
| `demo` | prints through CHROUT, then draws colour bars in a graphics mode; waits for a key | 6809 models only (refused on a 6803) |

They run the same with or without ROMs.
