# Verification against MAME

[CLOADM](../README.md) › Verification against MAME

Every chip is compared with MAME 0.264 by running diagnostic firmware written for this project in both emulators,
in lockstep. No copyrighted ROM is used for testing.

* `node tools/mame-diff/run.js dragon64` compares every instruction's registers, flags and cycle count with MAME's.
  On the Dragon 64: 1,028,112 instructions identical, and the firmware reaches its HALT loop.
* `node tools/mame-diff/run.js dragon64 --video` compares the screen pixel by pixel: on the Dragon 64, all 20
  display modes are identical.
* `node tools/mame-diff/run.js dragon64 --fdc` runs the floppy controller cartridges against MAME the same way,
  with our firmware as the disk ROM and four drives; `--images` also compares the disk images both write.
* `node tools/mame-diff/run.js coco --cart gmc --audio` runs a cartridge with our firmware as its ROM, then compares
  the sound MAME records with ours, sample by sample.
* `node tests/regress.test.js` replays the verified traces and frames in seconds, without MAME, after every change.
  `node tests/all.js` includes it, and CI runs `all.js` on every pushed commit (see AGENTS.md section 4).

Where MAME and the hardware disagree, the hardware wins and the difference is documented: see
[Deviations from MAME](#deviations-from-mame) below.

## Which MAME

MAME 0.264 is the reference. These areas are compared on MAME 0.289 instead, and say so where they are described:

* the HD6309 core's lockstep and its regression hashes, because 0.264 is not an oracle for the 6309's divides: it
  charges `DIVD #$02` 3 cycles where 0.289 charges 28 ([cpu6309.md](cpu6309.md));
* the Dragon 64 Plus's `$FFE2` bank register, which 0.264 never applies to memory and 0.289 does, as Compusense's
  notes say: its banking was probed on 0.289, and the 0.264 comparison runs with the banks held (below);
* the Hi-Res joystick interfaces and the CoCo 3 mouse ([Input](#input), below).

[mame-0289-results.md](mame-0289-results.md) records what every comparison reports under 0.289.

## Results per machine

What each machine's comparison with MAME 0.264 showed when it was verified (the regression gate,
`tests/regress.test.js`, keeps these traces and frames from changing):

| Machine | Instruction trace (registers and cycles) | Display modes | Mid-line changes (`--raster`) |
|---|---|---|---|
| Dragon 64 | 1,028,112 instructions identical, HALT reached | 20/20 identical, PAL colour blending included | 17/17 identical |
| Dragon 64 Plus | identical, HALT reached: 1,016,256 instructions (the base machine), 1,177,312 (the 80-column board) and 334,449 (the 80-column text screens), under `mameCompat`; 2,546,275 (the `$FFE2` paging of the traced schematic, without `mameCompat`; its VDG picture 8 of 8 identical); the bank register from Compusense's technical notes (see below) | the 80-column screen 640 x 264 identical, but on 0.264 its video RAM is never written (see below); the six 80-column text screens identical, every pixel, with the video RAM put into MAME's share by the harness | – |
| Dragon 32, Dragon 200, Tano Dragon 64 | identical | 20/20 identical, PAL colour blending included on the Dragon 32 and 200 (the Tano is NTSC) | 17/17 identical |
| Dragon 200-E | 1,028,112 instructions identical, HALT reached | 20/20 identical, with a character generator written by this project (see below) | 17/17 identical (its own variant of cases 5 and 11, see below) |
| Prológica CP 400 | 1,043,371 instructions identical, HALT reached | 20/20 identical | – |
| Color Computer 1/2, 2B | identical | 20/20 identical, NTSC artifact colours included, at each artifact setting | 17/17 identical (coco, coco2b) |
| Color Computer 1/2 at 4K, 16K and 32K | identical at every size (1,099,793 / 1,079,377 / 1,043,371 instructions) | 20/20 identical at 4K and 16K | 17/17 identical at 4K and 16K |
| Dynacom MX-1600, LZ Color64, Codimex CD-6809 | identical | – | – |
| Color Computer 3 (128K and 512K) | 88,797 instructions identical | 34/49 identical; the rest differ only in text glyph shapes (our own font designs); the same at each artifact setting, artifact colours included. Text attributes (`--attr`): 34/34 identical, exactly (every attribute byte; 32/40/64/80 columns; lines per row 0-6; blink off and on). GIME text screens and the screen reader (`--text`, 6809 and 6309): 14/14, apart from glyph shapes, with MAME's glyphs and ours where the expected text says. Composite monitor (`--composite`): 67/67 at artifact settings 0, 1 and 2 (46 exact, 21 apart from glyph shapes), with `$FF98` BPI and MOCH | 8/8 identical, per line (MAME cannot draw part of a GIME line) |
| Color Computer 3 (PAL) | cannot be verified against MAME: its `coco3p` keeps the CoCo 3's 262-line NTSC geometry, so it does not run a PAL field (see below) | – | – |
| MC-10 | 908,205 instructions identical | 20/20 identical, NTSC artifact colours included, at each artifact setting | 10/10 identical |
| Matra Alice | 908,205 instructions identical, HALT reached | – | – |
| Dragon 64 + Dragon FDC (WD2797, `--fdc`) | 5,833,479 instructions identical, HALT reached; disk images written byte-identical (`--images`); NMI arming (`--fdc --nmi`): identical, HALT reached at instruction 799 | – | – |
| Dragon 64 running the HD6309 (CPU option 6309) | NMI arming (`--fdc --nmi --cpu 6309`): identical registers and cycle counts, 1,197,190 instructions, HALT reached at 793; also 1,197,190 on MAME 0.264 (container) | – | – |
| Tano Dragon 64 on the HD6309 | NMI arming (`--fdc tanodragonfdc --nmi --cpu 6309`): identical, 1,204,410 instructions, HALT reached at 793; also 1,204,410 on MAME 0.264 | – | – |
| Dragon 200-E + Dragon FDC (WD2797, `--fdc dragonfdc`) | 5,839,407 instructions identical, HALT reached at 2,402,179; disk images written byte-identical (`--images`: d0.vdk 368,652 bytes, d1.vdk 184,332 bytes) | – | – |
| Dragon 64 + Premier FDC (WD2791, `--fdc premierfdc`) | 5,890,277 instructions identical, HALT reached; disk images written byte-identical (`--images`) | – | – |
| Color Computer + CoCo FDC (WD1773, `--fdc`) | 5,851,757 instructions identical, HALT reached; disk images written byte-identical (`--images`) | – | – |
| Dragon 64 and Color Computer, the controller with an empty ROM socket (`--fdc --bare`) | identical, HALT reached: dragon64 1,200,945 instructions (HALT at 66,473), coco 1,208,171 (HALT at 66,937) | – | – |
| Blank disks (`--fdc <controller> --blank <format>:<T>x<H>`) | a blank disk formatted by our firmware: dragonfdc VDK 40 × 1, cocofdc JVC 35 × 1, premierfdc VDK 40 × 1 and dragonfdc DMK 40 × 2 identical in lockstep to HALT (8,750,860, 7,717,543, 8,750,920 and 17,534,051 instructions); formatted images byte-identical for the VDK and JVC ones and for dragonfdc VDK 40 × 2, VDK 80 × 2 and JVC 40 × 2 and cocofdc JVC 40 × 2 (`--images`; MAME cannot save DMK, so the DMK one is checked sector by sector in ours) | – | – |
| Color Computer 3 + CoCo FDC (WD1773, `coco3 --fdc`) | 5,851,680 instructions identical, HALT reached; disk images written byte-identical (`--images`) | – | – |
| Color Computer + Multi-Pak with the CoCo FDC in slot 4 (`--fdc multifdc`) | 5,851,742 instructions identical, HALT reached; disk images written byte-identical (`--images`) | – | – |
| Dragon 64 + Multi-Pak with the Dragon FDC in slot 4 (`--fdc dragonfdc --multi`) | 5,831,499 instructions identical, HALT reached; disk images written byte-identical (`--images`) | – | – |
| Dragon 64 + Multi-Pak with the Premier FDC in slot 4 (`--fdc premierfdc --multi`) | 5,882,274 instructions identical, HALT reached; disk images written byte-identical (`--images`) | – | – |
| Color Computer + Multi-Pak with the CoCo FDC in slot 4 (`--fdc cocofdc --multi`) | 5,833,809 instructions identical, HALT reached; disk images written byte-identical (`--images`) | – | – |
| Dragon Professional (Alpha) | 768,865 instructions identical, HALT reached (the SAM diagnostic, started by our boot ROM); its own hardware (`--board`): 1,129,123 identical; its disk interface (`--fdc alphafdc`): 5,822,674 identical, disk images byte-identical (`--images`) | 20/20 identical | – |
| Color Computer / CoCo 3 + banked ROM cartridge (`--cart banked`, `bankedshort`) | 1,202,713 / 1,202,635 instructions identical, HALT reached (128K and 40K images) | – | – |
| Color Computer / CoCo 3 / Dragon 64 / Dragon 32 + Games Master (`--cart gmc`) | 1,750,945 / 1,750,867 / 1,739,165 / 1,739,165 instructions identical, HALT reached; sound within 2 LSB of MAME's recording (`--audio`) | – | – |
| Color Computer / CoCo 3 / Dragon 64 / Dragon 32 + Orchestra-90 (`--cart orch90`) | 1,179,871 / 1,179,795 / 1,172,651 / 1,172,651 instructions identical, HALT reached; sound identical to MAME's recording (`--audio`) | – | – |
| Color Computer / CoCo 3 / Dragon 64 / Dragon 32 + Multi-Pak (`--cart multi`) | 1,198,373 / 1,198,295 / 1,179,297 / 1,179,297 instructions identical, HALT reached; sound identical to MAME's recording (`--audio`) | – | – |
| Color Computer + Speech/Sound Pak (`--ssc`, masked-interrupt case) | 1,164,214 instructions identical, HALT reached at 195,913 (see below) | – | – |
| CoCo 2B + Speech/Sound Pak (`--ssc`, masked-interrupt case) | 1,164,214 instructions identical, HALT reached at 195,913 — the same trace as the CoCo, because this firmware reads only the CPU and the Pak, and the 2B differs from the CoCo 1/2 in the VDG and the keyboard matrix, which it never touches | – | – |
| CoCo 3 + Speech/Sound Pak (`--ssc`, masked-interrupt case) | 1,157,487 instructions identical, HALT reached at 213,485 | – | – |
| Dragon 64 + Speech/Sound Pak (`--ssc`, masked-interrupt case) | 1,156,994 instructions compared (a 4-second run: the count of instructions the comparison covers, not of the firmware's work), HALT reached at 195,913 — the **same trace** as the CoCo's, instruction for instruction: measured, both reach HALT after 195,913 instructions and 708,037 cycles, and the trace hash to HALT is the same (`7b896afc`) on both. The compared count differs from the CoCo's (1,164,214) only because the run is bounded by emulated seconds and the two models' clocks differ slightly (888,625 vs 894,886 Hz, 0.7 %), not because the PAL frame is longer: a longer frame holds proportionally more instructions, so the rate per emulated second is nearly the same | – | – |
| Color Computer + Speech/Sound Pak (`--ssc int3`, interrupt case) | outcome comparison against MAME: 107 of 107 device-write rows identical, work RAM identical, HALT on both sides (not an instruction lockstep: the two CPUs overlap, see below). **The work-RAM match is not coverage of the sound-activity bit**: `$0405` holds a `$FF7E` status read whose bit 5 comes from an activity window this emulator does not model, and this model's pass depends on the firmware's fixed read landing outside that window (see below) | – | – |
| CoCo 2B + Speech/Sound Pak (`--ssc int3`, interrupt case) | outcome comparison against MAME: 107 of 107 device-write rows identical, work RAM identical, HALT on both sides (this model's own `compare.js` run, not the CoCo's). As above, the work-RAM match is **not** coverage of bit 5 | – | – |
| CoCo 3 + Speech/Sound Pak (`--ssc int3`, interrupt case) | **outcome comparison against MAME differs**, and is not claimed: the device writes still match (107 of 107 rows) and both sides reach HALT, but the final work RAM does not — MAME leaves `$0405` = `$DF` and we leave `$FF`. `$0405` holds a `$FF7E` status read and bit 5 is the sound-activity circuit: on MAME that bit dips low for a while after an allophone load, and the firmware's fixed read 18.4 ms after the load lands **inside** that dip here and outside it on the CoCo 1/2 and 2B. Our own model stubs the circuit and always reads the bit high, so we read `$FF` on every model. This difference is **known and open** (below: it is not the card's clock, which ran 4 times fast on the CoCo 3 and is fixed; it is the stubbed circuit). Our side is still pinned in the gate as `trace coco3 ssc int3 (our side; MAME differs at $0405)` | – | – |
| Dragon 64 + Speech/Sound Pak (`--ssc int3`, interrupt case) | outcome comparison against MAME: 107 of 107 device-write rows identical, work RAM identical, HALT on both sides. As on the CoCo 1/2 and 2B, the work-RAM match is **not coverage of the sound-activity bit** (below), so that half is weaker than it looks; the write sequence is genuine | – | – |

**Speech/Sound Pak** (`run.js coco --ssc`, `tools/mame-diff/ssc/`). The Pak's own ROMs are the user's, so the
comparison installs firmware written for this project on both sides: `ssc-pic.asm` for the TMS7040 and `ssc.asm`
for the 6809 (in the BASIC socket, since the Pak presents no ROM of its own). The 6809 writes each command at
`$FF7E` and polls the busy bit; the PIC firmware takes the interrupt, drives the SP0256 and the AY, and releases
the busy line.

*The masked-interrupt case* (`run.js coco --ssc`, the source as it ships). `ssc-pic.asm` writes `IOCNT0 = $0C`,
which Figure 3-16 makes INT2's enable and INT2's flag, so INT3 stays masked. The card correctly refuses every
interrupt, the busy flag never clears, and the firmware's bounded poll gives up after `POLLMAX` reads. Result:
1,164,214 instructions identical in every register and cycle count, HALT reached at instruction 195,913, and
both sides leave the same RAM at HALT. The time-out counter gets exactly 37, one per command, on each side;
pinned at that number
(`tests/ssc.test.js`) it is a regression case which fails if a core takes a masked interrupt. The firmware clears
that counter itself rather than reading it: the two emulators disagree about a power-on RAM value and real DRAM
has none.

*On the Dragon 64* the same two cases run with the firmware in the Dragon's BASIC socket (`run.js dragon64
--ssc`), and the masked one is identical in every register and cycle count: HALT reached at instruction 195,913
after 708,037 cycles. That is the **same trace** as the CoCo's - measured, the trace hash to HALT is identical on
both (`7b896afc`) - which is what the Pak's decode being the CoCo's `$FF7D`/`$FF7E` on the Dragon predicts. Only
the number of instructions the comparison covers differs (1,156,994 here, 1,164,214 on the CoCo), and only because
the run is bounded by emulated seconds while the two models' clocks differ slightly (888,625 vs 894,886 Hz, 0.7 %).
The Dragon's PAL frame is longer (312 lines, 17,784 cycles at 49.97 Hz, against 262 lines, 14,934 cycles at
59.92 Hz), but a longer frame holds proportionally more instructions, so the rate per emulated second is nearly
the same: measured over four seconds, 1,145,500 instructions on the Dragon and 1,154,619 on the CoCo (0.8 % fewer,
tracking the clock rather than the 17 % lower frame rate). The Dragon's 16K BASIC exists in two banks selected by
PIA1 PB2, and the reset vector comes from whichever is selected, so the harness lays our image into both. Only the
bank selected at reset is needed to reach HALT (measured, below); the second keeps the run from depending on which
bank a machine powers on in. That is a harness detail, not a hardware difference.

*The interrupt case* (`node tools/mame-diff/ssc/compare.js`, and the gate). `gen-roms.js` builds the PIC with
`$30` (INT3 enable, bit 4, plus INT3 flag clear, bit 5) and the 6809 with an unbounded wait, so every command is
serviced through the ISR and the firmware reaches HALT with TIMEOUTS = 0 after 37 commands and 107 device writes.
Both emulators are compared, but not instruction by instruction: the two CPUs overlap here, and MAME
interleaves them on its scheduler, so the number of poll reads between a command and its service differs by
construction. The oracle is the **outcome**: the ordered sequence of device writes (each command's SP0256
allophone load and AY-3-8913 address/data write, with value and order), plus the firmware's final work RAM, and
HALT on both sides. MAME's rows come from tapping the PIC's peripheral writes and applying MAME's own
`coco_ssc.cpp` decode; ours come from `writes.js` applying the same decode to this emulator's chips.
`compare.js` takes the model as an argument (`node tools/mame-diff/ssc/compare.js coco3`, or `SSC_PROFILE`),
because each model the page offers the Pak on needs its own run: the CoCo 2B and the CoCo 3 have their own cart
port and sound mux, and the CoCo 3 adds the GIME. Result on 0.264:

* **CoCo 1/2, CoCo 2B and the Dragon 64**: 107 of 107 write rows identical, work RAM identical, HALT reached on
  both sides. That includes `$0405`, but it is **not coverage of the sound-activity bit** (see the next point), so
  this pass is weaker than it looks.
* **CoCo 3: the work RAM does NOT match**, so this model's outcome comparison is recorded as **not passing**. The writes still match (107 of 107 rows) and both sides reach HALT, but MAME leaves `$0405` = `$DF`
  and we leave `$FF`.

*What bit 5 of `$FF7E` does, measured (read-only probes on 0.264; no code changed for this).* The
sound-activity circuit's output is **not constant on MAME either**: after an allophone load it dips low for a
while and then returns high, on **every** model. Measured at frame resolution, in milliseconds after the last
allophone load:

| model | bit 5 after the load |
|---|---|
| CoCo 2B | high at 18.2, 34.9 and 51.6 ms; **low** at 68.3 and 85.0 ms; high again from 101.7 ms |
| CoCo 3 | **low** at 20.2, 36.9, 53.6 and 70.3 ms; high from 86.9 ms |

The firmware reads `$FF7E` at a **fixed 18.384 ms** after that load, the same figure on both models to the last
digit. So the read does not move — the **window** does: 18.4 ms is outside the CoCo 2B's window (it reads `FF`)
and inside the CoCo 3's (it reads `DF`). This emulator's own model of the circuit is a stub (`soundActive` is
set false in the `SpeechSoundPak` constructor, `js/machines/ssc.js`, and never set again), so bit 5 reads high
unconditionally here, which is why we report `$FF` on every model.

Two consequences:

* **The CoCo 1/2's and CoCo 2B's pass does not show that the bit is modelled; it depends on where the read lands.** Their work-RAM match depends on where the
  firmware's fixed read lands relative to a window we do not model. Move the settle delay in `ssc.asm` and those
  two could read `DF` as well. Their device-write sequence, which is what the card's decode determines, is genuine
  coverage and is unaffected.
* **The CoCo 3's `$0405` difference is known and open.** It was measured with the Pak's clock running 4 times fast on
  the CoCo 3 (a 13-instruction 6809 loop cost 56 card cycles there against 16 on the CoCo 1/2): the card advanced
  one cycle per machine tick, and a CoCo 3 tick is a GIME clock, a quarter of a CPU cycle. That is fixed (the card
  counts the host's `cartClockHz`, below), and `compare.js coco3` still leaves 107 of 107 device writes identical
  with `$0405` reading `$DF` on MAME and `$FF` here. So the clock was not the cause: what remains is the
  sound-activity circuit, which this emulator stubs. It stays open until the circuit is modelled (deferred: MAME's
  circuit averages the AY's level per stream update call, not per unit of time).

Our side is also pinned as a hash in `tests/regress.test.js`, in the same form as every other case: the full
instruction trace (registers and cycle counts) to HALT, plus the final work RAM and the ordered write sequence —
the gate runs our emulator only, so it records our side and never MAME output. There is no time-out count in that
hash: this build has no time-out path, so $0410 cannot vary and hashing it would add a constant, not coverage.
There is one such key per model the page offers the Pak on, so a change that moves one model's trace and not
another's is visible rather than averaged away. The CoCo 3's key is named `trace coco3 ssc int3 (our side; MAME
differs at $0405)` so that a reader of the key list cannot mistake it for a MAME-backed one.

*What changed between "0 commands serviced" and a full run, measured, with the cause narrowed to one change.*
An earlier revision of this branch
reported "0 commands serviced, the PIC never reaches `SERVE`" on 0.264, which contradicted an even earlier
"35 of 37". Both were measured with firmware that lacked the post-reset settle delay, so a bisect was run over
the four combinations of settle delay and wait form, one 0.264 run each, recording the PIC image MAME actually
executes (read back from its program space), the number of `$FF7E` commands, and the number of `SERVE` entries:

| PIC image | settle | 6809 wait | commands | `SERVE` |
|---|---|---|---|---|
| `$30` (as read back from MAME's PIC space: `A2 30 00`) | yes | unbounded | 37 | 37 |
| `$30` | yes | bounded | 37 | 37 |
| `$30` | no | unbounded | 1 | **0** |
| `$30` | no | bounded | 37 | 35 |
| `$0C` (masked control) | yes | bounded | 37 | 0 |

The image is correct in every run — the substituted byte is `$30` on disk and `$30` as the PIC executes it — so
the image was never the cause. The difference is the settle delay. Without it the first `$FF7E` write arrives
before the PIC has finished its reset sequence: read at that write, the PIC's `IOCNT0` is `$02` and not the `$12`
it holds once it is listening, i.e. it has not yet executed the `$30` write that enables INT3 or the `EINT`
after it. MAME does not service that first command, and the two wait forms diverge from there: the bounded wait
gives up and issues the next command, whose interrupt it does service, recovering 35 of the 37; the unbounded
wait never gives up, so no further `$FF7E` write is made, no new interrupt is raised, and the run stays at zero.
With the settle delay the first command lands after the PIC is listening, and MAME services all 37. Which
internal MAME step drops that early command (the input line's edge or the global interrupt flag) was not
established, and the two commands the bounded form loses were not identified individually; neither affects this
case now that both sides compare equal. The earlier "35 of 37" and "0" figures are superseded by the first row.

*One measured timing difference in that case, and how the firmware handles it.* The SP0256 runs its own
sequencer at its sample rate (MAME steps it once per sample, `clock/336`, about 9.3 kHz), not at the card's cycle
rate, so after an allophone load it can take several sample periods to reach the `RET` that raises the `SBY`
pin (status bit 6). When this was measured, this emulator's stage-1 model stepped that sequencer once per card
cycle, so it reached `RET` sooner: on the same firmware built with and without the wait it now has, MAME left `$BF`
at `$0405` (SBY low, sampled before the sequencer got there) when it read the pin immediately, and `$FF` with the
wait, while this emulator left `$FF` either way. The firmware therefore waits before it samples the pin, as real
code would. The stage-2 sequencer (below, "The Speech/Sound Pak's SP0256 timing") runs once per sample on the chip's
own clock, as MAME does, so that pacing difference is gone; the wait stays, since real firmware needs it too.

The "0 `SERVE`" run of the earlier revision and the comparison that now passes
(`tools/mame-diff/ssc/compare.js`) were both run with the same harness. Between them the firmware gained the
settle delay; no harness change is involved.

**The Speech/Sound Pak's AY sound** (`node tools/mame-diff/ssc/audio.js <coco|coco2b|coco3|dragon64>`). The Pak
plays its AY sound gated by the CoCo sound mux as in MAME (`coco.cpp:555`: the cartridge is heard when PIA1 CB2 and
PIA0 CB2 are high and PIA0 CA2 is low; an equality test, so all three high selects another source, and a cartridge
in a Multi-Pak slot is gated the same way, as MAME's `coco_multi.cpp` forwards `set_sound_enable` to every slot).
Both sides run our own firmware (`ssc/gen-ay.js`): the TMS7040 plays every step of an AY program from its own
reset, so no 6809 handshake is in the sound, and the 6809 only opens the mux. The program covers every channel's
volume 0-15 alone and against the others, all 16 envelope shapes on one, two and three channels and through a tone
gate, tone periods 0, 1, $FFF and others, noise periods 0, 1, 16 and 31 alone and mixed, and a write to a
deselected chip. Two checks, on each of the four models the Pak is offered on, both passing on MAME 0.264:

| Model | AY data writes (MAME's time, Lua tap on the PIC's port C) | Levels (steady samples, 48 kHz, 2 channels) |
|---|---|---|
| CoCo 1/2 | 187 of 187, each within 0.331 card cycles | 539,538 compared, largest difference 0 LSB (tolerance 2) |
| CoCo 2B | 187 of 187, within 0.331 | 539,538 compared, 0 LSB |
| CoCo 3 | 187 of 187, within 0.456 | 533,726 compared, 0 LSB |
| Dragon 64 | 187 of 187, within 0.000 | 539,400 compared, 0 LSB |

The write limit is half a card cycle: MAME's Pak clock is 894,886 Hz, ours 894,886.25, which drifts a third of a
cycle over the 1.33 s program (measured worst 0.456 cycle, on the CoCo 3, in the table above). The levels are compared at every sample where both recordings hold one value for three samples running,
from the later of 20 ms (MAME's first sound update period, as for the cartridges) and the 6809's opening of the mux:
before it, the recording is the machine's own DAC and single-bit sound (compared by `sam/dac-sound.js`). The 2 LSB
tolerance covers float rounding in the order MAME sums its streams; one AY level step here is at least 58 LSB.
**Transitions are not part of the result**: at every level change MAME's recording is one output sample (1/48000 s)
later than the resampler port puts ours, on every model. With that delay every sample matches within 1 LSB (the
run reports it on its own line), and it is the same constant `cart/audio.js` measured for the cartridges, but its
source in MAME's sound path is not established, so it is not applied to the result.

What made it match, each found by this comparison and fixed in `js/chips/ay8910.js` and `js/machines/ssc.js`:
* **The output network.** `coco_ssc.cpp:181` builds the AY-3-8913 with `set_flags(AY8910_SINGLE_OUTPUT)`, which
  replaces the default legacy flag: its three channels are one resistor network into a 1 kOhm load, not three
  levels added, and the table is not normalised (`build_3D_table` with `normalize = 0`); the Pak routes it at
  `AY8913_GAIN 2.0` (`coco_ssc.cpp:59`). The AY core has a `'single'` output mode for it; the Dragon Alpha's
  AY-3-8912 stays `'legacy'`. Before: four plateaus of −12,288 / −11,329 / −4,546 / −3,587 LSB against MAME's
  10,371 / 11,110 / 16,407 / 16,994; after, those exactly (`tests/ay8910.test.js` pins MAME's four numbers).
* **The stream rate.** The AY's clock is `DERIVED_CLOCK(2, 1)`, twice the card's cycle rate (the TMS7040's divider
  of 2 is its own), and MAME streams it at clock / 8: one sample per 4 card cycles, not 8. Every tone played at half
  MAME's frequency.
* **When a write lands.** MAME's TMS7000 charges an instruction's cycles before executing it (`tms7000op.cpp`,
  e.g. `am_i2p`), so a port write's time is the instruction's end, and the AY stream is brought up to that time
  with the old registers, the sample in progress included (a stream view's end rounds up, `sound.h`). So every
  sample that starts before the write plays the old registers and the first to start at or after it the new.
  Getting this wrong put tones half a period out of phase after a period change.
* **The card's clock.** At power-on the card started at the CPU's first instruction, 4 cycles after MAME's time 0
  (every write 4 cycles late; the host now gives the power-on origin, `powerOnTick()`); and on the CoCo 3 it ran 4
  times fast (above). Both are pinned by `tests/ssc.test.js` against MAME's write times, 129 and 216 card cycles.
* **MAME's whole-hertz sample grid** (`config.mameCompat` only; "Deviations from MAME").

**The Speech/Sound Pak's SP0256 timing** (`node tools/mame-diff/ssc/speech.js <coco|coco2b|coco3|dragon64>`). The
speech chip's sequencer (`js/chips/sp0256.js`, stage 2) runs one step per sample on its own 3.12 MHz clock: the
instruction set, the parameter decode for every load in all four modes, repeat counts with SETMODE's high bits,
interpolation, deltas, PAUSE, JSR/RTS and PAGE, the LRQ/SBY handshake, and LRQ on the PIC's INT1. Its bit order is
the one an unreversed AL2 dump speaks in (LSB first, branch addresses most significant bit first; GI's binary
notation agrees). Both sides run our own images: the speech program from `ssc/sp0256-asm.js`, installed in MAME
under the AL2's file name, `sp0256-al2.bin`, but always our own generated image, never a real SP0256-AL2, which is
copyrighted and never fetched, recreated or used here (AGENTS.md hard rule 1) (`ssc/gen-speak.js`:
50 allophones, one test each, each ending in a marker load whose timing a misframed field would change), a PIC
program that loads allophones 1-50 as the chip's LRQ asks for them, and a 6809 program that reads `$FF7E` once the
last load is made. Two checks, both passing on MAME 0.264:

| Model | Address loads (MAME's time, Lua tap on the PIC's port C) | `$FF7E` changes (Lua read tap) |
|---|---|---|
| CoCo 1/2 | 50 of 50, each within 0.309 card cycles | 2 of 2, each on the same 6809 read; SBY's rise seen |
| CoCo 2B | 50 of 50, within 0.309 | 2 of 2, same read |
| CoCo 3 | 50 of 50, within 0.426 | 2 of 2, same read |
| Dragon 64 | 50 of 50, within 0.000 | 2 of 2, same read |

Each load's time is the moment the chip took the allophone before it, so the 50 times pin every test's length to
the card cycle: a field width wrong by one bit, a repeat count or a pitch period off by one sample, moves every load
after it. The parameter table (GI's bit-precision maps, which the stage-1 work could not read from GI's scan) is
restated in our own form from MAME's, and was checked against it entry by entry, 64 of 64. The 6809 does not read
the status while the PIC is loading: a status read brings the chip up to that moment (MAME's `sby_r` updates its
stream), so an LRQ change could come from a 6809 read, and MAME hands that to the PIC across two CPUs it interleaves
on its scheduler, which moved single loads by one pass of the PIC's polling loop when the 6809 read throughout. Under
`config.mameCompat` the chip runs on MAME's grid, and an LRQ change less than a card cycle ahead of a PIC instruction
reaches it first (both under "Deviations from MAME"). The Pak's existing comparisons were re-run with the new
sequencer (its image rebuilt by the assembler: `gen-roms.js`): `run.js <profile> --ssc` identical to HALT on all four
models, and `ssc/compare.js` identical on the CoCo 1/2, 2B and Dragon 64, with the CoCo 3's `$0405` as before. The
interrupt-case keys `trace <profile> ssc int3` changed (the 6809's status reads see SBY at the new times; the
instruction counts are unchanged) and were recorded after those runs passed.

The CI has no MAME, so `tests/ssc.test.js` holds MAME's own recording of this run on the CoCo 1/2 and the Dragon 64
(`tests/fixtures/ssc/speech-mame.json`: the 50 address-load times and the `$FF7E` changes, with the speech image MAME
ran) and runs that image under `config.mameCompat`: every load within half a card cycle of MAME's, every status change
on MAME's read. It fails if the address load is applied at once instead of at the end of the PIC's instruction (the
first load 11 card cycles early), if the mameCompat LRQ-ahead rule is removed (load 28 on the CoCo, 39 on the Dragon,
one polling pass of 23 cycles late), or if a field width is wrong (DELTA_9's pitch read as 4 bits: from load 27 on),
and if `gen-speak.js` stops building the recorded image.

**The Speech/Sound Pak's SP0256 sound** (`node tools/mame-diff/ssc/speech-audio.js <coco|coco2b|coco3|dragon64>`).
The chip's output (`js/chips/sp0256.js`, stage 3, MAME's model): the excitation (an impulse of the amplitude every
pitch period, or plus or minus the amplitude from a 15-bit noise register), six second-order filter stages in 16-bit
arithmetic that wraps, their B and F multipliers from the SP0250 Applications Manual's coefficient quantization (our
table is built from its step breakpoints and equals MAME's 128 values), and the last stage held to 14 bits, times 4.
The Pak (`js/machines/ssc.js`) adds it to its sound path at MAME's gain, `SP0256_GAIN` 1.75 of full scale 32,768,
gated by the sound mux with the AY (`set_sound_enable`). Both sides run our own images: the speech program from
`ssc/gen-voice.js` (24 tests: every load that sets coefficients in all four modes, voiced at several pitches and
amplitudes, both coefficient signs and stage 5, interpolation, SETMSB and delta updates of a playing sound, noise,
PAUSE, and the chip halting after a voiced and after an unvoiced sound), installed in MAME as `sp0256-al2.bin` but
always our own image, never a real SP0256-AL2; its PIC program is `gen-speak.js`'s with two holds, and the 6809 only
opens the mux (`gen-ay.js`). MAME records at the chip's stream rate (`-wavwrite`, `-samplerate 9285`,
`-nocompressor`), so each recorded sample is one chip sample; ours is the machine's sound path read at each speech
sample's stamp and written as MAME writes a WAV sample (clamped to plus or minus 1, times 32,767, truncated):

| Model | Samples compared | Largest difference | Over 1 LSB |
|---|---|---|---|
| CoCo 1/2 | 18,380 (from sample 190) | 1 LSB | 0 |
| CoCo 2B | 18,380 | 1 LSB | 0 |
| CoCo 3 | 17,813 (from sample 757, where its 6809 opens the mux) | 1 LSB | 0 |
| Dragon 64 | 18,380 | 1 LSB | 0 |

All 24 address loads are made on each, MAME's recording holds about 2,170 distinct values and none clipped, and its
two channels are the same. Our sample k is compared with MAME's sample k + 1: from its first sound update on, MAME's
recording is one output sample later than its streams put it, the constant the cartridge and AY comparisons also
see (`cart/audio.js`, `ssc/audio.js`; its source in MAME is not established). The first 1/50 s is left out, because
in that update MAME's resampler holds one sample twice, and so is everything before the 6809 opens the mux (the
machine's own sound, compared by `sam/dac-sound.js`; on the CoCo 3 it differs here, -8,191 against 0), plus 4 samples:
MAME gates the sample the mux opens on when it mixes, we when the sample is made. The 1 LSB tolerance covers float
rounding: MAME resamples the AY's idle level (heard, since the mux is open) from its 1.79 MHz stream with 32-bit
float sums, which moves the sum by an ulp at some samples; measured, 1 sample in 18,564 differs, by 1. The test
image's levels are chosen to stay inside what the recording can hold (`gen-voice.js` runs our chip to choose the
INPUTS; the expected output is MAME's recording), so two parts of the model cannot be seen in it: the 14-bit hold and
the 16-bit wrap. Both only act beyond full scale, where the recording clips; `tests/sp0256.test.js` pins them with
values worked by hand from MAME's model.

The CI has no MAME, so `tests/ssc.test.js` holds MAME's recording on the CoCo 1/2 and the Dragon 64
(`tests/fixtures/ssc/voice-mame.json`, with the speech image and PIC program MAME ran) and requires the same, every
sample within 1 LSB, plus that `gen-voice.js` still builds those images. Mutations, each turning it red: the B term
shifted by 8 instead of 9; the coefficient table's first segment 8k instead of 8k + 1; no delay reset at an impulse;
the halted chip forgetting its amplitude; noise taps 0x4000; no amplitude interpolation; the Pak's gain 1.5; the
speech stamped 3 periods on; and speech not gated by the mux (a hardware-grid check: with gen-speak.js's 6809
program, which never opens the mux, the sound path holds one level). `tests/state.test.js` snapshots the Pak in the
middle of an allophone, part way through a frame, with speech levels not yet passed on, and the restored machine's
sound is identical level for level.

**The sound-activity circuit** is the one part of the Pak still missing. `$FF7E` bit 5 reports whether the Pak is
making sound, and this emulator stubs it to a constant high (`soundActive` in `js/machines/ssc.js`). MAME's circuit
follows the AY's level only (`coco_ssc.cpp`: the AY is routed through it, the SP0256 straight to the speaker); it is
deferred, and the CoCo 3's `$0405` difference in `ssc/compare.js` comes from it.

**Where the Pak is offered, and where it is not.** The cartridge port's board menu offers it on the four models
whose Pak **instruction lockstep** (`run.js <profile> --ssc`, the masked case) has matched MAME 0.264 to HALT: CoCo
1/2 (`coco`), CoCo 2B (`coco2b`), CoCo 3 (`coco3`) and the Dragon 64 (`dragon64`). The five other CoCo profiles
(the MX-1600, LZ Color64 and CD-6809 clones, the PAL CoCo 3 and the Prológica CP-400) and the other Dragons do not
offer it. MAME 0.264
lists the `ssc` slot on every Dragon driver, but only the Dragon 64 has been run here, so only the 64 is offered;
the Dragon 32, 200, 200-E, Tano Dragon 64, Dragon Professional (Alpha) and Dragon 64 Plus would each need their own `run.js <profile> --ssc` first. The MC-10 and Alice have no
cartridge port at all.
The Dragon 64's lockstep needed one harness change before it could pass, not a product change. The masked run is
the same firmware at the same address (`ssc.asm` at `$A000`, the Dragon 64's BASIC socket): the Pak's decode is
the CoCo's `$FF7D`/`$FF7E` on that machine too, which is why the same firmware reaches HALT there at the same
instruction. `ssc/spec.js` also lays the image into every ROM socket at its own base and size
(`romImage(fw.asm, r.at, r.size)`), which produces the same images for the CoCo profiles as the old layout did;
for the Dragon 64 that means
the 64K-mode BASIC bank is filled as well, though that is belt-and-braces rather than a requirement (as said above
for the Dragon's two banks): measured, filling only the 32K-mode bank reaches HALT in the same 195,913 (masked) and 7,506 (INT3) instructions, because PB2
is high at reset so the first bank is the one that runs and this firmware never flips it.
The interrupt case then read "HALT NOT reached" on the Dragon for a CPU that had never left its loop. MAME's Lua
`state["PC"]`, sampled at a frame boundary, is not the instruction the CPU is executing: once the loop is entered
the CPU fetches the `BRA` at `$A06E` on every pass and never fetches `$A070` again, yet the sample reads `$A070`
(`SSCRESET`'s first byte - a real code address, executed twice before HALT) in **478 of 720 CoCo frames and 599 of
600 Dragon frames**, and `$A06F`, the loop's operand byte, in 240 of the CoCo's frames, with 2 samples elsewhere;
the 12-second figures are the ones quoted (at 4 seconds the CoCo's split is different again, so run length matters
too). That is why the old code passed on the CoCo by luck and failed on the Dragon: its accept set was
`{HALT, HALT+1}`, and while no CoCo frame sampled `HALT` itself, the loop's operand byte is in that set and a third
of them sampled it - neither address is a fetch the firmware makes in the loop. `compare.js` now counts
fetches of the HALT opcode itself and counts reads of the byte after the loop (a read tap, in practice fetches) once it has started (`leftAfterHalt`;
a CPU that ran on past the `BRA`, not a general detector of leaving the loop by another route, which this firmware
does not have); a run that reports
neither fails as a harness fault rather than passing. That harness-fault branch (`halts` = 0, or no `leftAfterHalt`
count) is exercised only by these manual MAME runs: `compare.js` needs MAME, so the fast gate covers the masked
lockstep (the two regress keys) and not the interrupt-case comparison or its detector.
**What the Dragon 64's runs cover, and what they do not.** They cover the Pak on that machine: its decode at
`$FF7D`/`$FF7E`, the PIC driving the AY and the SP0256, and the outcome of every command. They do not cover the
Dragon's own glue, because this firmware never touches it. Measured by mutation: inverting PIA1 PB2's bank-select
polarity, or forcing bank 1 at all times, leaves **both** Dragon SSC traces (masked and INT3) unchanged, and the
firmware never writes the 6551's `$FF04-$FF07`. Those parts are covered by keys that do reach them - `trace
dragon64` (the SAM diagnostic's phase 4 reads BANKID at `$BF00` with PB2 both ways, and fails on the PB2 mutation)
and `acia dragon64`. The comparable earlier statement for the CoCos' SSC keys is the same: they cover the Pak, and
the models' own differences are covered by their own keys.
Its PIC (TMS7040) ROM is the user's, added through the ROM panel and required; the SP0256-AL2 speech ROM is the
user's too and optional (CLOADM never includes it). The words for it are one table, `SSC_TEXT` in `js/session.js`:
without the speech ROM the board menu says **Speech/Sound Pak (music; speech needs your SP0256-AL2 ROM)** and with it
**Speech/Sound Pak**; the ROM panel's speech socket says it is optional, what it does and that CLOADM never includes
it, or, loaded, that the Pak speaks; and when a program first asks the Pak to speak with no speech ROM (an address
load, noted by the Pak and checked by the Session after every frame, however the frames were run: the page,
Claude's tools, MCP, a script) the Session emits `speech-rom` once in its life, which the page shows as one toast
with an "Add ROMs" button (the stdio MCP server, `cli/mcp.js`, has no page, and nothing there listens for it). `tests/ssc-board.test.js` holds the words, the label switch and the once-a-session rule
(more speech, and the Pak out and in again, say nothing more; with the ROM in, or a program that never speaks, nothing
at all); the browser check's `sscBoard` group checks the menu label both ways, both panel lines and the toast exactly
once through the page, all with our own stand-in speech program, and hears the speech reach the machine's sound
path once the stand-in speech image is added. Offering the Pak on these four models rests on the instruction lockstep above; the interrupt case
(`compare.js`) additionally passes on the CoCo 1/2, the CoCo 2B and the Dragon 64, and on the CoCo 3 it does not.
That pass is weaker than it sounds: those three models' work RAM matches because the firmware's fixed read lands
outside a sound-activity window this emulator does not model (above), so it is not evidence about bit 5 either
way. The CoCo 3's Pak is offered on the strength of its lockstep and its identical device-write sequence, with that
one status bit recorded as a known gap.

**Deviation from MAME: the TMS7000's IOCNT0 interrupt enables.** The TMS7000 Family Data Manual (TI SPND001B,
1986) gives each interrupt one enable bit and one flag bit, which is how `js/cpu/cpu7000.js` models it. Figure
3-16 (p. 3-30): IOCNT0 bits 0/1 are INT1's enable/flag, bits 2/3 INT2's, bits 4/5 INT3's, bits 6-7 the memory
mode. Page 3-32: an interrupt going active latches its flag, which "stays latched when the signal goes inactive".
Page 3-29: the flag clears when the interrupt is acknowledged, and page 3-32 when a 1 is written to its bit (a
write of 0 leaves it). §3.6.1 (p. 3-29): a reset clears the enables and the mode bits and "leaves the INTn flag
bits unchanged". IOCNT1 is not modelled because this part has none: Table 3-14 (p. 3-30) gives it to the
TMS70x2/TMS70Cx2 devices only, and Table 3-12's note (p. 3-24) says the same of INT4 and INT5.

MAME 0.264's `src/devices/cpu/tms7000/tms7000.cpp` differs three ways. (1) Its flag is not a latch:
`flag_ext_interrupt` (lines 372-382) re-derives it from the input pin's current state (`m_irq_state`), so it
drops when the line does. (2) Its take rule is `(m_io_control[n] >> shift & 3) == 3` (`check_interrupts`, lines
384-396): enable and flag both set, which with a level-tracking flag means "take it only while the input is still
asserted" - so an interrupt that arrives while its level is masked and whose line then releases is lost to MAME
and kept by the manual. (3) A write of 1 to a flag bit clears `m_io_control` but then calls
`flag_ext_interrupt` again (`tms7000_pf_w`, lines 539-562), so writing the clear bit while the line is still
asserted puts the flag straight back, where the manual clears it.

The manual is what `js/cpu/cpu7000.js` implements (`irqEnabled`, `writeIocnt0`, and `interrupt()` latching the
flag). A `config.mameCompat` branch is not needed for this comparison, and none is added: the three rules agree in
every state the Pak's firmware passes through, given the settle delay after a reset. The firmware waits for the
PIC to finish its reset before the first command, so INT3 is always enabled while the line is idle before a write
asserts it, and each `$FF7E` write asserts it afresh while the previous one has been acknowledged; no flag is
ever derived from a released line and no clear is ever written while the line is still asserted. (Without that
delay the first command does land before `IOCNT0` enables INT3; the bisect above measured that outcome (MAME
drops the command and the PIC never reaches SERVE) but it did not measure the two flag models diverging, and
that is not claimed here.) The 1,164,214-instruction masked lockstep
and the 107-row interrupt-case comparison are the evidence. `tests/tms7000-core.test.js`
section 11b checks the manual's table, the latch, and the write-1/leave-on-0 rule against the pages cited above.

**Dragon Alpha sound** (`run.js dgnalpha --sound`, `tools/mame-diff/alpha/sound-compare.js`): MAME records our
firmware (`alpha/sound.asm`: a tone, two tones at other volumes, noise, a triangle and an attack-hold envelope, and
the DAC alone) with `-wavwrite` at 48 kHz; we render our machine's sound levels at the same rate and in MAME's scale.
Per segment: the pitch within 1% (all are equal), the RMS within 3% (5% for noise; the worst is 1.47%), the
attack-hold envelope's shape within 3% of its range (0.52%). Not sample by sample: MAME resamples the AY's 125 kHz
stream through its own filter and starts its sample clock elsewhere. The DC level is not compared: MAME's mix
carries constant offsets (its DAC and single-bit sound at -1 when silent) and our audio output removes DC.

**Dragon and CoCo sound, and the command line's `--wav`** (`run.js <dragon64|dragon32|coco> --sound`,
`tools/mame-diff/sam/dac-sound.js`): our firmware (`sam/dac-sound.asm`, in place of BASIC) plays DAC square waves at
two pitches, at half the swing, in the upper half of the range, and the single-bit sound. MAME records it with
`-wavwrite` at 48 kHz; ours is the machine's level events of every frame through the page's output stage without its
DC filter (`AudioOutput`, `highPass: false`), the path `cloadm --wav` records through. MAME's output is ours times one
scale factor plus one offset (its silent level is not 0), both taken from the first segment; MAME does not block DC, so
its segment means follow the levels. Per segment: the pitch within 1% (all are equal), the RMS within 0.5% and the mean
within 0.5% of the first segment's RMS. The DAC's half swing and upper half match to 0.01% (RMS) and 0.08% (mean), the
single-bit sound to 0.06% and 0.24%, on all three machines. The single-bit sound adds 32 DAC steps
(`js/machines/cocopia.js`), the weight of the DAC's top bit: the Tandy service manual's parts list gives the DAC's
resistors R10-R15 as 10K to 324K and the single-bit sound's resistor R22 as 10K (as MAME 0.264's `coco12.cpp` cites it; the
manual itself was not available to this check), and MAME's level matches (it was 31.5 steps, which this comparison finds
1.50% off and fails; `tests/cli-wav.test.js` pins it at 10240 alone and 30400 with DAC 63). A mutation
that moves the DAC's upper half up one step fails the mean check alone (0.71% to 1.04%).

**The sound mux on the cassette input** (`run.js <dragon64|dragon32|coco> --cass-sound`, `tools/mame-diff/sam/cass-sound.js`):
our firmware (`sam/cass-sound.asm`, in place of BASIC) selects the mux's sources while a tape we build (a $55 leader)
plays: a DAC square wave (the scale), the cassette selected with sound enabled and the motor on (BASIC's `AUDIO ON`
while loading), the same with sound disabled, with the motor off, and the DAC selected with the tape playing. MAME
records it with `-wavwrite`; per segment the RMS and the mean within 5% of the first segment's RMS. MAME 0.264 puts
the cassette selection at a constant bias, 32 DAC steps (its `coco.cpp` `update_sound`: 0x40 on its 0..0x7E scale), and
mixes no tape signal: the RMS is 0 in every segment but the first, while its cassette device is playing (Lua:
`position` advancing). CLOADM used 0 there (a mean 104% of segment 1's RMS off); it now uses the bias, and every
segment matches on all three machines (RMS 0 / 0, mean within 0.2%). `tests/regress.test.js` hashes the firmware's sound
(`sound dragon64 cass-sound`, `sound coco cass-sound`). On real hardware the cassette input is heard through the TV
(`AUDIO ON`); CLOADM follows MAME here and plays the tape on the page's side instead (Tape sound, below), so this is
not a deviation. The CoCo 3 shares the code (`js/machines/cocopia.js`) and was not compared (the firmware maps as a
CoCo 1/2's BASIC).
`tests/cli-wav.test.js` then shows the recording itself is exact: firmware writing a known DAC pattern gives every level
as 320 x the DAC value, every interval between writes is the cycle count from the MC6809 data sheet (within 0.01
cycle; the worst seen is 0.003), the WAV is the box filter of the machine's level events sample for sample, two runs
give the same bytes, and a snapshot taken mid-sound continues with the same samples.

**Screenshot comparison** (`--expect-screenshot`): `tests/cli-screenshot.test.js` compares frames with references
written by its own PNG encoder (RGB, RGBA, grey and palette, grey and palette also at 1, 2 and 4 bits, every filter type), so the decoder is checked against files it
did not write; one changed pixel is found and named, the tolerance and the difference picture are checked pixel by
pixel. The frame itself is `machine.render()`, which the `--video` comparisons above check against MAME.


**CoCo 3 text attributes.** The display-mode comparison above cannot see the attribute bits fully: our text glyphs
are our own design, so a character cell that differs counts as a font difference when it shows only two colours,
and an underline drawn on the wrong row or a blink in the wrong state would pass that way. `run.js coco3 --video
--attr` (`coco3/vdg-attr.asm`, generated by `run-vdg.js` with `ATTR=1`) fills the screen with blank characters only
(`$20`, and `$A0`, which the GIME draws from the same glyph), each with its cell number as the attribute byte, so
every one of the 256 bytes appears and no glyph ever shows. It is compared exactly, with no font allowance, in 32,
40, 64 and 80 columns at lines per row 0-6, and in 40 and 80 columns with the blink state on (one GIME timer
expiry toggles it, then the timer is stopped so it holds; each blink picture must differ from the same mode with
blink off). Result against MAME 0.264: 34 of 34 identical: background (bits 0-2), the underline in the foreground
colour (bits 3-5, 6) on the row MAME's `gime.cpp` and ours pick for 8, 9-10 and 11 lines a row and nowhere else, and
blink (bit 7) blanking the character and its underline. Lines per row 7 is not compared: MAME makes it `0xFFFF`
lines a row and reads its font past the end of the table.

**CoCo 3 GIME text screens and Claude's screen reader.** `run.js coco3 --video --text [--cpu 6309]`
(`coco3/run-text.js`; the screens and their expected text in `coco3/text-screens.js`, the firmware it generates in
`coco3/vdg-text.asm`) puts up 14 GIME text screens: 32, 40, 64 and 80 columns with and without attributes, every
character code ($00-$FF), a video start of `$72348` with a decoy in the row before it, a start scrolled six rows
into 30 rows of text with `$FF9C` set, 9 and 11 lines per row, 200 and 225 lines (rows cut short included), 256-byte
virtual rows with a horizontal offset, and an offset that wraps within a row. The expected rows are literals,
written from the GIME's layout and never produced by the reader. For each screen it checks (1) every pixel against
MAME, a cell allowed to differ only in glyph shape (our font is our own design; the cell must show only its two
colours in both pictures); (2) MAME's own picture against the expected text, character by character: every cell
expected blank is blank in MAME, cells expected to hold the same character show the same MAME glyph, and cells
expected to hold different characters show different ones (in rows shown whole; the 128 codes of the charset
screen give 127 distinct glyphs, and the codes with bit 7 set the same glyphs as without); (2b) our own picture
against the same text, exactly: every cell our font's glyph for the expected character, underlined on the row the
GIME documents for the lines per row (with (1) and (2) this closes the glyph allowance: an underline a row early or
a horizontal offset ignored in our renderer fails here); (3) `screen_text` on our
machine at that moment returns exactly the expected rows, row count, base and attribute runs. Result against MAME
0.264: 14 of 14 on `coco3` and 14 of 14 on `coco3h` (6309). `tests/coco3-screen-text.test.js` runs the same
firmware without MAME on both CPUs, plus the cases that need no picture (graphics and short rows declined, the
attribute bytes never read as text, `$FF9C` changing neither picture nor reading under `mameCompat` and scrolling
both on the machine as shipped, the VDG machines unchanged). These screens run under `mameCompat`, as every MAME
comparison does: MAME 0.264 does not apply `$FF9C`'s fine scroll (next).

**The screen-text readers on screens the VDG page reader cannot read.** `tests/screen-text-readers.test.js` runs
firmware of our own (assembled in the test, no ROM) that writes known text on three screens: the Dragon 64 Plus's
80-column screen (every code `$00`-`$FF`, from start `$0000` and scrolled three rows), the CoCo 3's GIME text modes
on a page at physical `$60000` that the firmware writes through one MMU slot and then unmaps (40 columns with
attributes: all 128 codes with and without bit 7, underline and colours, shown to the CPU at `$C000`; 80 columns
without, the video start three rows in, shown to the CPU nowhere), and a CoCo 3 compatibility-mode page at physical
`$60400` (the SAM's page bits and `$FF9D`) while CPU `$0400` holds other text (every VDG code, normal and inverse,
and a row of semigraphics; mapped nowhere, then at `$C400`). On each, `screen_text` and `Session.screenText` (the
embed API's `screenText`, the Ask panel, the boot watchdog) must return the rows derived from the firmware's data
through hand-written character tables, and the rendered frame - the picture the MAME comparisons above verify -
must show those characters cell by cell: the GIME's cells against its fonts' glyphs (as `run-text.js` 2b does), the
Plus board's through a character generator of our own that draws each code as its byte. Mutants that turn it red:
reading the compatibility page through the CPU's map or at the power-on `$70400`, attribute bytes read as
characters, 40 columns read as 80, bit 7 not ignored, the Plus start address ignored, Plus unknown codes not
counted, `Session.screenText` reading the main screen only, the VDG page or the fallback read through the CPU's map
(the Plus's `$FFE2` banks, a CoCo 3 slot mapped to ROM), `base` given while a bank hides the page, and the boot
watchdog reading the shown screen (the 80-column view, with OK on the VDG page). A page the SAM's display offset
moves: firmware of our own on the Dragon 32 and the CoCo 2 writes "OK" at `$0400` and another page at `$0C00`,
then sets F = 6; the picture must equal a control firmware's that shows the same bytes from `$0400` with F = 2 (so
the VDG really shows `$0C00`), both readers must read `$0C00` with `base` `$0C00`, the boot watchdog and the Ask
panel's `?ERROR` check must see only the displayed page, and a 4K counter (M = 00) must wrap F = 8 to `$0000`
(`base` null). Mutants: the offset ignored, the F bits shifted wrongly (in the SAM or in the reader), the counter size
ignored, and `base` compared on row 0 only or without the page's last byte. The reader changes no emulation: the regress hashes
are unchanged. Not covered: a compatibility-mode text row other than 12 lines (`$FF9C` other than `$0F`), where the
GIME shows more than 16 rows of 32 bytes; the reader reads the first 16.

**CoCo 3 GIME vertical fine scroll (`$FF9C`, VSC).** Sources: [S1] Sock Master's GIME reference
(`6809.org.uk/twilight/sock/gime.html`, "FF9C Vertical scroll register - VSC": bits 7-4 unused; consecutive values
scroll the screen up one scanline at a time where more than one scanline makes up a text row or a graphics row);
[S2] the Tandy CoCo 3 Service Manual (26-3334), section 1.5, printed p13 (bits 3-0 VSC3-0; `$0F` in compatibility
mode; `$FF9D`/`$FF9E` the start in 8-byte units); [S3] Super Extended BASIC Unravelled II, ch. 5, printed pp16, 18-19
(bits 7-4 reserved; BASIC scrolls a row by resetting VSC and moving the start by a row, so VSC does not carry into
the start); [S4] Tepolt, *Assembly Language Programming for the CoCo3* (1987), printed p25 and pp29-30 (with 8-line
native text, VSC 0-7 move the picture up and the next buffer row comes in at the bottom; its "bit 3 = SCEN"
conflicts with S1 and S2 and is not implemented); [S5] N. Marentes, Jumping Joey technical notes, "THE COCO3 CAN
DISPLAY SEMIGRAPHICS MODES" (compatibility-mode `$FF9C` 7/8/9/10 give SG6/SG8/SG12/SG24, which corroborates the
lines-per-row table `COMPAT_TEXT_LPR` that MAME and we use there). The model (`js/chips/gime.js` `vscLine`): in a
GIME mode whose `$FF98` lines per row is 2, 8, 9, 10 or 11, a VSC below the row height starts the body VSC scanlines
into its first row, so the picture moves up by VSC lines and the bottom shows the next row of the buffer, in part;
VSC is latched at the start of the field, with the video start. MAME 0.264 loads VSC into the row's line counter at
`new_frame`, but its top border sets the counter back to 0 on every line (`gime.cpp` `record_border_scanline`), so
it never scrolls; `config.mameCompat` does the same (a deviation, below). Each case below, what MAME does and what
we do:

| Case | MAME 0.264 | CLOADM (shipped) | Settled by |
|---|---|---|---|
| Native rows of 2, 8, 9, 10, 11 lines, VSC below the row height | no scroll | scrolled VSC lines | S1, S4 (MAME contradicted: `mameCompat` keeps MAME's) |
| VSC at or above the row height | no scroll | no scroll | nothing: unknown |
| Rows of 1 line (`$FF98` LPR 0 and 1) | no scroll | no scroll | nothing: unknown (S1 needs more than one line a row; LPR 1 may be 2 lines on some GIMEs) |
| LPR 7 (MAME: a row that never ends) | no scroll | no scroll | nothing: unknown |
| When a write takes effect | (no effect) | at the next field's start | MAME's `new_frame` latch, followed; unverified |
| 1986 and 1987 GIMEs | one model | one model | nothing: unknown |
| Compatibility mode | lines per row from `$FF9C` (S5's SG modes) | the same | S2, S5, MAME |

The compatibility-mode text at `$FF9C` values other than BASIC's `$0F` is in the pixel comparison: `run.js coco3
--video` puts up `compat text` at 8, 9, 4 and 1 lines a row (S5's 3-, 2- and 1-line SG settings and the 8-line
setting) on a 192-line body and 8 lines on a 200-line one, as well as BASIC's 12. Each is compared with MAME cell for
cell, a cell tall as `$FF9C` says, so a screen showing 24, 22, 48, 192 or 25 rows (not 16) is checked where it differs.
Result against MAME 0.264: 0 of 5 different - the 1-line screen pixel-identical, the other four identical apart from
our own font design (the instructions differ per cell, glyphs do not). The reader that follows these rows
(`GIME.legacyTextScreen`) is checked against our own frame, row for row and cell for cell, in
`tests/screen-text-readers.test.js` section 3b; it DECLINES rows under 8 lines ($FF9C 4-9 and $0B-$0E), where a glyph
is shown only in part, with the same answer and reason the GIME native reader gives rows under 8 scanlines.

That comparison's own per-cell grid had a bug these cases found: it took the body to start at picture line 24 and be
192 lines tall, right for a 192-line screen only. On a 200- or 225-line screen (`$FF99` bits 5-6) the top border is 23
or 8 lines, the body starts at line 22 or 7, and the grid straddled two text rows, so a two-colour cell read as three
and a correct picture was reported different. It now takes the start and the height from `$FF99` (24/192, 22/200,
7/225); the whole `--video` suite then passes with 0 different of 49.

`run.js coco3 --vsc` (`coco3/gen-vsc.js`, our firmware in `coco3/vsc-1.asm` to `vsc-5.asm`) puts up 60 cases:
8-line text and double-height (2-line) graphics with VSC stepped through 0-15, 9-, 10- and 11-line text, 8- and
11-line graphics, 1-line rows (LPR 0 and 1), LPR 7, the 200- and 225-line resolutions, and VSC written mid-field (in
the top border and in the body, cleared again in the bottom border). The screen holds blank characters with a
different attribute byte in every cell, so no font shows and every pixel is compared exactly. The cases are split
over five parts, each run from reset, because MAME 0.264's 6809 runs on a whole-Hz clock (894886 Hz), 0.38 ppm slower
than its GIME's video timing: an HS edge reaches its CPU one cycle earlier every 2,603,190 cycles, which our CoCo 3
`mameCompat` does not model (an earlier single-firmware build of these cases, about 6.3 million cycles long, showed
exactly that: a `SYNC` one cycle shorter in MAME at about cycle 2,603,182 after reset, and again 2,603,190 cycles
later, nothing else); each part halts by cycle 2,030,115. For each part: (1)
lockstep with MAME to HALT; (2) a field of every case against MAME's, pixel by pixel, and no case may change the
picture from its lead-in field (MAME never scrolls); (3) the same firmware on our machine as shipped: each case's
picture must be MAME's picture of the same field moved up by the scroll the sources give (worked out in `spec.js`
`scrollOf`, not by our GIME), the bottom VSC lines of the body excepted (the next buffer row, which MAME does not
show), and must differ from its lead-in field exactly when it scrolls. Result against MAME 0.264: every part
identical to HALT (720984, 720984, 720984, 720984 and 911939 instructions compared, HALT at instruction 203408 or
155922), 60 of 60 cases identical, and 60 of 60 hardware-model cases MAME's picture moved by the sources' scroll.
`tests/gime-vsc.test.js` checks the shipped model line by line against rows worked out by hand from S1 and S4
(graphics of 2, 8, 9, 10 and 11 lines, every VSC; 8-line text, where the underline marks each row's last line; 225
lines; bits 4-7 ignored; the field-start latch; compatibility mode; `mameCompat`; the text screen the reader sees;
snapshots); `tests/state-carts.test.js` saves mid-field, scrolled and between a write and its latch.

The Dragon 200-E's character generator is a character ROM, and like the BASIC ROMs it is the user's to supply:
CLOADM never ships or fetches one. Its video comparison installs, in both emulators, a 4K pattern built by
`tools/mame-diff/sam/spec.js` (`genChargen()`), so it proves the VDG's composed address
`(raster line << 8) | (PIA1 PB4 << 7) | byte & 0xFFF`, the PB4 bank input, the LK1 "Inverse Video" link and the
200-E's rewired AS/INTEXT (INTEXT is /AS, so text bytes with bit 7 clear reach the generator). It does **not**
prove the real Spanish glyphs, which depend on the user's own dump. The same applies to the Dragon 64 Plus's 8K
character generator below.

The Dragon 200-E's mid-line comparison (`--raster`) is 17 of 17 cases, with lockstep to HALT. It runs its own
variant of the firmware (`gen-raster.js --chargen`, `raster-chargen.asm`), because two cases mean something else on
this machine. Case 5 sweeps PB4, which is the generator's bank here, not INT/EXT; MAME draws the bank once per
field (it calls `char_rom_r()` from `screen_update`, after the field has run, and `config.mameCompat` holds it the
same way), so the sweep runs at SAM V=1, where each split line's reads past the visible area move the display
counter. Case 11 writes PB1 alone; on this machine MAME splits the line there too (below), so the case must show,
where on the other machines it must not. The "must not change" guard compares a swept field with the last lead-in
field, not the second: the first field of a case still shows the bank the previous case left.

The SAM counter probe (`tools/mame-diff/sam/samv.asm`, `run-samv.js`) puts an address-tagged byte at every
display address and shows it at SAM V=0 and V=1: every pixel matches MAME on the Dragon 32, 64, 200, 200-E,
Tano Dragon 64, CP 400, CoCo and CoCo 2B, so our SAM fetches the same bytes in V=1 text as MAME.

**Why PAL CoCo 3 timing has no MAME oracle.** `mame coco3p -listxml` reports `vtotal 262`, `refresh 59.922748`,
and `coco3.cpp`'s `coco3p` machine config only swaps the clock (28.475 MHz) and the GIME variant - it never calls
`set_raw` again, so MAME drives the same 262-line, 59.92 Hz screen as `coco3`, and its PAL GIME flag changes only
the colour encoding. This emulator models a real PAL field instead: 312 lines with 25 padding lines at the top and
25 inside the bottom border (`js/chips/gime.js`), which is what a PAL CoCo 3 displays. That is the product
behaviour; MAME's artefact is not reproduced. The consequence is that PAL CoCo 3 frame and interrupt timing cannot
be compared with MAME: `node tools/mame-diff/run.js coco3p` diverges at instruction 54,860 (MAME reads VBORD `$08`
where we read `$00`; the same divergence point is instruction 54,850 with the diagnostic firmware as it was
before four open-bus reads were removed from it, which is where the earlier figure came from), and forcing MAME's
262 lines only moves the divergence to 36,605 at another register,
because the rest of the PAL geometry differs too. The NTSC CoCo 3 is verified normally.

**Dragon 64 Plus.** The board's own technical notes are the primary source: Compusense, "Dragonplus Interface
Technical Information" (4 pages, (c) Compusense Ltd; archived by the Dragon Archive at
`archive.worldofdragon.org/browse/downloads/Software/Dragon/Compusense Ltd/Dragon Plus/DragonPlusTech.pdf`, and
confirmed by an original owner as the document Compusense supplied). Page 1 maps `$FFE0`/`$FFE1` to the 6845 and
`$FFE2` to the memory bank register, and adds two 32K dynamic banks (A, B) and a 2K static video RAM (C) over the
low addresses, the video RAM "without losing the remainder of the dynamic bank". Page 2 gives the write table:
R2 R1 = 00 standard, 01 bank A, 11 bank B; R0 = 1 the video RAM; bits 3-7 not used. Page 3 gives the read: bit 0
is 1 while the display is on and 0 while it blanks. Page 4 gives a 6845 register table (R9 = 10) and the
character set in a 2764, of which only the first set is used, 16 bytes a character. The machine follows these,
and `tests/d64plus.test.js` checks each against the notes' tables. The notes contradict themselves on one point:
page 2 calls `$FFE2` "a write only register", and page 3 then defines its read (bit 0, the display status); the
machine follows both, as MAME does (writes set the banks, reads return the status).

Not verified, by the notes or by MAME:
* the bank switching itself against any emulator: MAME 0.264 never applies it (below), so the comparison runs
  with the banks held on the standard RAM, and the switching is checked only by the unit tests from the notes;
* the real 80-column glyphs (the user's `chargen.ic22`);
* findings from P. Harvey-Smith's Eagle schematic of his own DragonPlus board (World of Dragon forum, 7 June 2017,
  `viewtopic.php?p=15826`), each "from a traced schematic with known drawing errors; not verified on hardware":
  * the dot clock is the host crystal divided by 8 for the 6845 CLK (IC25 QC), which matches our 8-pixel cell
    (and MAME's);
  * SAM P1 does not bypass the banks: the bank PROM decodes CPU A15. We (and MAME's SAM, which forms the address
    before its banks see it) let an access paged by P1 to the upper 32K miss the banks. **Open item:** this
    differs from what we and MAME do; a later behaviour change, not made here;
  * `$FFE2` bit 2 only XORs Z7 into the extra DRAM's address, so `$04` (R2 R1 = 10) selects motherboard RAM like
    `$00` (and `$05` motherboard RAM with the video RAM over `$0000-$07FF`). The machine follows this
    (`js/machines/d64plus.js` `writeBank()`); under `config.mameCompat` it keeps MAME's no-change decode (below);
  * the MC6847 fetches motherboard RAM in the E = 0 phase, so the 32-column screen does not see the selected
    bank or the video RAM. The machine follows this: the VDG always reads the motherboard RAM.

  Cited in the code and tests as "P. Harvey-Smith's traced Eagle schematic of his DragonPlus board (World of Dragon
  forum, 7 June 2017; known drawing errors; not verified on hardware)". `tests/d64plus.test.js` checks both against
  tables written out from it: the CPU's read of `$0100` and `$1000` for every `$FFE2` value after `$00`, `$02`,
  `$06` and `$07`, with a distinct byte in each RAM; and the VDG's picture under every value, with one pattern in
  the motherboard RAM and another in banks A, B and the video RAM, against the picture the motherboard pattern alone
  draws.

**Dragon 64 Plus paging against MAME 0.264.** MAME 0.264 never applies `$FFE2` to memory (below), so its CPU and VDG
always reach the motherboard RAM: for these two points its outcome is the schematic's. `run.js d64plus --paging`
runs our firmware `d64plus/paging.asm` on our machine **without** `mameCompat` (our banks reach memory): it selects
bank A, bank B and the video RAM, then `$04` or `$05`, and reads and writes `$0100`, `$0101`, `$01FF`, `$1000` and
`$1001`, never touching `$0000-$7FFF` while a bank or the video RAM covers the address. Identical to HALT: 2,546,275
instructions compared, registers and cycle counts identical, HALT at instruction 1,223,365 (`trace d64plus
paging.asm` in the regression gate). With the old decode (`$04` keeping bank A) it diverges at the first read
under `$04` (instruction 27,162). `run.js d64plus --paging --video` holds the VDG's text screen on `$0000` under
each of `$00`, `$02`, `$06`, `$01`, `$03`, `$07`, `$04` and `$05` (each phase changes CSS so headless MAME redraws)
and compares the 256 × 192 picture with MAME's: 8 of 8 identical, 0 pixels differing. With a VDG that sees the
banks, 6 of the 8 differ (35,616 to 36,864 pixels each; `$00` and `$04` pass, as they should). This proves the
MAME-equal outcome only: that the banks themselves hold what the CPU wrote is checked against Compusense's notes
by the unit tests, not by MAME 0.264.

Against MAME 0.264: `run.js d64plus` (the Dragon 64's diagnostic) and `run.js d64plus --plus` (our 80-column
firmware: every HD6845S register and the R12-R15 read-back, the video-RAM bank, distinct bytes in banks A and B,
the cursor and the start address) are identical to HALT, and `d64plus/run-video.js` matches all 168,960 pixels
of the 640×264 screen, with the 8K pattern `tools/mame-diff/d64plus/spec.js` (`genChargen()`) builds in both
emulators. They run under `config.mameCompat`, because 0.264 does not apply the bank register to memory (below),
so in that comparison the video RAM is never written: the picture proves the CRTC's geometry, the cell addressing
for code 0, the start-address walk and the cursor column, not the drawing of written characters, which the unit
tests cover from the data sheet and MAME's `crtc_update_row()`. The real 80-column glyphs need the user's own
`chargen.ic22`.

**Dragon 64 Plus 80-column text and Claude's screen reader.** `run.js d64plus --plustext` runs our firmware
`d64plus/plustext.asm` (written by `d64plus/text-screens.js`), which puts up six screens: 80 columns from `$0000`,
40 columns from `$0100`, a start scrolled three rows, a start at `$07C0` that wraps round the 2K video RAM, a 14-bit
start `$2850` that mirrors `$0050`, and 64 columns of 20 rows of 13 lines; each clears the video RAM, writes its
text (some of it where the start skips it), sets CRTC R1, R6, R9 and R12/R13 and holds for ten fields; then text goes
on the MC6847 page. Against 0.264 under `mameCompat`: 334,449 instructions to HALT, registers and cycle counts
identical (`trace d64plus plustext.asm` in the regression gate). `run.js d64plus --plustext --video` compares each
screen's picture with MAME's, every pixel (MAME sizes its screen to R1 x 8 by R6 x (R9 + 1); ours must be dark
outside that): 6 of 6 identical, 0 pixels differing, with a character generator of our own in both
(`run-text.js` `TEXTGEN`) that draws each cell's whole 8-bit code on its even raster lines, so a match proves each
cell's code, row and column (a drawing that turned code c into c ^ `$40` fails it; with `genChargen()`, which keeps
only a code's low four bits, it had passed). Since 0.264 never lets the CPU write the
video RAM (below), the Lua script puts each screen's 2K, built from the screen's own writes, into MAME's
`:video_ram` share when the screen begins; our machine runs without `mameCompat`, so its own firmware writes fill
the video RAM, and the match shows they put exactly those bytes there. `tests/d64plus-screen-text.test.js` reads
every screen with `screen_text` against literal rows in `text-screens.js`, decodes our picture (drawn with a
generator that shows each code as its byte) back to the same rows, and covers the declines, `base`, a read
mid-frame, snapshots, the VDG screen and Compusense's own register table (p. 4). Sources for what the reader assumes
rather than compares with MAME: the HD6845S R8 table (Hitachi, "HD6845S, HD68A45S, HD68B45S" data sheet, Interlace
and Skew Register (R8), Tables 4-6, PDF p. 11; the printed page numbers are cropped in the archived scan) puts bits
1-0 = 00/10 non-interlace, 01 interlace sync, 11 interlace sync and video, and bits 5-4 (display skew) and 7-6
(cursor skew) at 00 none, 01 one character, 10 two, 11 non-output, so Compusense's `$A2` is non-interlace with
two-character display and cursor skew, and the "non-output" decline (bits 5-4 = 11) is sourced. The character
mapping: P. Mooney (Serenarian), "Appendix A: The DragonPlus Character Set", his IC22 EPROM dump transcribed from a
1986 programmer printout (World of Dragon forum, 25 March 2018, `archive.worldofdragon.org/phpBB3/viewtopic.php?p=16452`),
and the Dragon Archive's Compusense character ROM dump both put `A` at EPROM offset `$0410` and `a` at `$0610`, so
code c's glyph is at c x 16 and `$20`-`$7E` are ASCII; `$00`-`$1F` hold other visible symbols (accented letters,
the pound sign and so on), `$7F` is a solid block and `$80`-`$FF` are mostly underlined forms of `$00`-`$7F`. The
reader declines a code outside `$20`-`$7E` because it does not map those symbols or the underlining. Which half of the
generator: P. Harvey-Smith's Eagle schematic, traced from his own DragonPlus board (World of Dragon forum, 7 June
2017, `viewtopic.php?p=15826`), has EPROM A0-A3 on the 6845's RA0-RA3, A4-A10 on character bits 0-6, A11 on
character bit 7 (through the latch/jumper path) and A12 on a font-select jumper; no 6845 output drives A11 or A12;
Compusense's notes say only the first set is used and the archived ROM's upper 4K is all `$FF`. No ROM image was
downloaded or used for any of this, and none is in the repository. Not verified: the real glyphs (the user's ROM).

**Cassette** (`tools/mame-diff/tape/run-tape.js`, on the Dragon 32 and 64, the CoCo 1/2 and 2B and the CoCo 3): MAME
runs our writer firmware (`tape/csave.asm`, which writes a namefile, a 255-byte data block and an end-of-file block
through the DAC as BASIC's writer does) and records its cassette output; that WAV decodes to exactly the 669 bytes
written, as our own capture of the same firmware does. MAME then reads, with our reader firmware
(`tape/cload.asm`), the `.CAS` and the WAV we captured and the WAV we export from that `.CAS`: every one reads back
3 blocks and 255 data bytes with the right sum and no bad checksum, in MAME as on our machines. The CoCo 3 runs this
pair unchanged in its 32K BASIC socket. Tape images and WAVs are compared by the bytes they hold, not sample by
sample: MAME pads `.CAS` playback with silence and writes its own sample timing. The WAVs `buildCas` and `casToWav` make for the same program (a sine and a square wave, with a player's gaps: the layout `tapeGaps` shares with the deck) are read the same way (`run-tape.js` builds them and checks that `buildCas` writes exactly the stream the writer firmware writes).

**Playing a `.CAS` file** (`tools/mame-diff/tape/run-playback.js`, on the Dragon 64 and the CoCo): a `.CAS` file has
no silence and often shortened leaders, and BASIC waits about half a second after starting the motor before it
looks for a block, so how the file is played decides what loads. Two firmwares of ours, installed as the BASIC ROM,
play four images (128-byte leaders; one-byte leaders; a gapped file; two files with two-byte leaders) in MAME and on
our machines. `tape/gaps.asm` times the cassette input: MAME plays 2 s of silence at the start of the tape and 1 s
before every later namefile and after every namefile, and makes every leader in front of a namefile and the block
after it 128 bytes; we play the same silences (all 8 runs identical: the same number, each within 0.5%, in fact within
8 of about 38,600 loop counts). `tape/cloadm.asm` reads the tape as BASIC's CLOADM does, with its half-second wait
after the motor starts for the namefile and again for the data blocks: it reads the same blocks in MAME and here,
type, length, checksum and first byte, on all 8 runs. Without the made-up leaders, our machine loses the first data
block of the one-byte-leader and two-file images. `tests/tape.test.js` pins the signal (silences and made-up leaders
worked out from the image), `tests/tape-load.test.js` loads tapes through `Session.load` with a BASIC stand-in
(`tape/standin.asm`), and `tests/state-tape.test.js` snapshots a tape in the silence and inside a block.

The MC-10 and Alice use their own 6803 pair (`tape/csave6803.asm`, `tape/cload6803.asm`), since the machine has a
6803 and no motor relay: the writer toggles P20 a square cycle per bit and the reader times the cycles on P24,
reporting the data bytes and their sum in registers and the block and bad-checksum counts in its internal RAM.
The firmware keeps its state in the 6803's internal RAM because the machine may have only the base 4K, which is
what MAME's `mc10` fits by default. On that machine MAME's recording of our writer decodes to the same 669 bytes,
and MAME reads our captured `.cas` and both WAV exports with our reader to the same counts, on the MC-10 and on
the Alice. That `.cas` case was skipped for a while, reported as "the file opens but no signal reaches the
machine"; two things were wrong and both are fixed. MAME's `mc10` and `alice` load a `.cas` with the *alice32*
variant of the CoCo format, which puts 15 s of silence before every block rather than the plain CoCo 1 s, making
our 669-byte capture a 50.3 s tape - far longer than the 30 s the comparison allowed, so it never reached the
data. And the halt test accepted any PC in `haltPc..haltPc+2`, where `haltPc+2` is the entry of a subroutine the
reader calls constantly, so a run that had not finished could look like a halt and report its scratch state. The
comparison now allows 70 s for that file (`mc10` halts at ~36 s) and requires an actual `BRA *` halt.

### Input

`node tools/mame-diff/sam/run-hires.js coco|coco3 [max3|rat]`, and the keyboard maps in
`tests/input.test.js`. Every keyboard position, both Hi-Res circuits and the CoCo 3's mouse come from a
published source:

Translated typing of every printable character (`tests/keyboard-symbols.test.js`, browser-check group
`keyboardSymbols`) has no MAME oracle (MAME has no host-keyboard translation to compare with): its oracle is the
machines' key legends, written into our key-echo firmware (`tools/keyecho/gen-keyecho.js`: MAME 0.264's
`PORT_CHAR` pairs and Color BASIC's control-key table). That firmware scans the matrix as BASIC does and writes
what it decodes to the screen, so the characters typed through US-layout key events (Shift held as a person
holds it), Claude's typing and pasted text are read back from video RAM on the Dragon 64, Dragon 200-E, CoCo,
CoCo 3 (6809 and 6309), MC-10 and Alice.

| What | Source | Checked by |
|---|---|---|
| Dragon keyboard matrix | MAME 0.264 `src/mame/trs/dragon.cpp`, `INPUT_PORTS_START( dragon_keyboard )` (ports `row0`-`row6`, bits PB0-PB7) | `tests/input.test.js` positional map: every one of the 55 physical keys reaches the matrix position whose legend it names |
| Dragon 200-E keyboard | MAME 0.264 `src/mame/trs/dragon.cpp`, `dragon200e_keyboard` (ports `row0`-`row6`: the Dragon's keys and bindings, with N-tilde on `KEYCODE_COLON`, row 1 bit 3), dumped from a running `mame dragon200e` | `tests/input.test.js`: all 55 physical keys reach the cell MAME names (expected cells copied from the dump, not from `keyboards.js`); `browser-check` `input` types in positional mode on a 200-E |
| CoCo 1/2 and CoCo 3 matrix | MAME 0.264 `src/mame/trs/coco3.cpp`, `INPUT_PORTS_START( coco3_keyboard )`; the CoCo 1/2 shares the shape, and `coco12.cpp` `coco_keyboard` adds no keys the CoCo 3 lacks | same test, 59 keys |
| MC-10 and Matra Alice matrix | MAME 0.264 `src/mame/trs/mc10.cpp`, `INPUT_PORTS_START( mc10 )` and `INPUT_PORTS_START( alice )` (port 1 strobes the columns, `$BFFF` reads the rows) | same test, 48 keys each |
| Tandy Hi-Res Joystick Interface timing | MAME 0.264 `src/mame/trs/coco.cpp`, `keyboard_changed` and `poll_hires_joystick`: started by the DAC (PIA1 PA2-PA7) falling below `$20`, fires after `535 + 5850 x position` microseconds, truncated to whole microseconds as `attotime::from_usec` does | lockstep: firmware `sam/hires.asm`, on `coco` and `coco3` |
| CoCo Max 3 interface timing | same file: started by PIA0 PA2 (right port) or PA3 (left port), fires after `380 + 2885 x position` microseconds | lockstep: firmware `sam/hires-max3.asm`, on `coco` and `coco3` |
| CoCo 3 "The Rat" mouse | MAME 0.264 `src/mame/trs/coco3.cpp`, `INPUT_PORTS_START( coco_rat_mouse )` (2-bit counts per axis) and `coco.cpp` `poll_joystick`: the comparator answers against `joy_rat_table = {15, 24, 42, 33}` | lockstep: firmware `sam/hires-rat.asm` sweeps the DAC and records JOYIN at every step; `tests/input.test.js` checks all four table values |
| CoCo Max input module registers | MAME 0.264 `src/devices/bus/coco/coco_max.cpp`, `ff90_read`: each read returns the value the previous read staged, cycling Y, X, left button, right button | `tests/input.test.js`, against the mouse's position |

All of these are compared in **instruction lockstep**: every register and every cycle count must be identical
and the firmware must reach HALT. On the local MAME (0.289, not the 0.264 reference), at stick positions
0/341/682/1023:

| Machine and interface | Instructions compared | Result |
|---|---|---|
| `coco`, Tandy | 14,957 / 18,468 / 22,013 / 25,524 | identical, HALT reached |
| `coco`, CoCo Max 3 | 15,056 / 14,356 / 18,601 / 17,901 | identical, HALT reached |
| `coco3`, Tandy | 20,434 / 28,923 / 32,468 / 35,979 | identical, HALT reached |
| `coco3`, CoCo Max 3 | 20,534 / 24,812 / 24,078 / 28,356 | identical, HALT reached |
| `coco3`, the Rat | 18,035 at each count | identical, HALT reached |

A cycle-level difference found this way and fixed: the one-shot's deadline is now MAME's own formula
(`trunc(535 + 5850 * axis/1023)` microseconds) evaluated from the time of the write, and JOYIN is sampled at
the read's own bus cycle rather than after it.

The touch joystick (the on-screen panel's Joystick mode) has no MAME counterpart: MAME's fire buttons are live
inputs set from Lua, and there is no touch panel to compare with. The port it drives is the one above, already
MAME-verified, and the host path is checked on its own: `tests/touch-joystick.test.js` runs our own firmware
(`tools/mame-diff/sam/fire-scan.asm`) in the BASIC socket on a Dragon 64 and a CoCo 3, which sets PIA0 up as the
machine's keyboard scan does and records the row byte with nothing down and again once a button shows, so the
touch stick's FIRE and a gamepad's button must leave the firmware the same byte; the same test pins the vector
to axis mapping (centre, ends, the dead zone at its edges, clamping) with values worked out by hand. The browser
check's `touchJoystick` group drives real touch events through Chromium (CDP) at 390x844, 844x390 and 1024x768:
drags of the travel radius and of half it read the machine's own axes, FIRE and the button bit, the stick and
FIRE held at once, ABC's one keypress, the strip's Y on the matrix, `?touch=`, the remembered mode across a
reload, a mocked gamepad standing the stick down, the mouse-as-right-joystick yielding to the stick, the welcome
menu ignoring taps under the stick, and no part of the panel over `#screen`.

Not verified automatically: a real gamepad and a real mouse (the browser check drives a mocked
`navigator.getGamepads`; the Rat is driven in Node), and the feel of the touch keyboard and the touch stick on a
real phone or tablet.

The panel held sideways on a short screen is checked by the browser check's `inputScreen` group at the iPhone 15 and
iPhone SE landscape descriptors, 844x390 and 932x430 with safe-area insets emulated through CDP
(`Emulation.setSafeAreaInsetsOverride`, which `env(safe-area-inset-*)` reads), 667x375 and 653x280, in Keys and
Joystick mode: BREAK, CLEAR, the switch, Menu (and the strip and FIRE) lie inside the viewport less the insets, clear
of the screen and of each other, with their labels unclipped and, where a button has a name of its own, that label
in its name; the split keys stay at least 40 px tall and below the panel's top padding. With the same emulated
insets, sideways (932x430, and 1100x480 for the install card's gutter) and upright (390x844), the same group puts a
toast (with a control placed so that the only free spot is under the notch), the install card, the command box
(upright, opened with the app bar scrolled away), the Ask Claude panel and sheet, the page view's status pill and
the chat's turn status inside the safe area; the pill and the turn status are unhidden directly, as their own
conditions need a running Claude turn. Not verified
automatically: Safari's own toolbar on a real iPhone (Chromium's `dvh` equals the window's height, so the toolbar's
share is not exercised).

Held upright, the same group loads LIZA at nine phone sizes, each the visible area a browser's toolbars leave:
iPhone SE in Safari (375x548) and Chrome for iOS (375x540), iPhone 13 (390x664, and 390x632 with 47 px above) and
iPhone 15 (393x659, and 393x628 with 59 px above) with a 34 px home indicator inset, a Pixel 7 in Chrome
(412x839), and an iPhone 15 and an iPhone SE in Safari 26 (its user agent, 393x852 and 375x667: the page runs under the
floating toolbar, which no viewport unit or inset counts, so the panel must end 84 px above the bottom edge; the
84 px is a model of that toolbar, which the iOS Simulator's Safari showed it clears by 62 px on the SE and 100 px on
the 15; on the SE, removing it puts ENTER's row under the band). In Keys and Joystick mode every key (ENTER's row included), the switch, BREAK, CLEAR and ⌄, or the
strip, the stick and FIRE, must lie inside the visual viewport less the insets at load, with the page not scrolled,
each key at least 40 px tall and none over the screen. With real touch events (CDP) a drag of 40 px that starts on Q,
and one that starts on SHIFT, must reach neither the machine's matrix (`setKey`) nor the no-ROM stub's queue (SHIFT
stays off) and must not scroll the page; a tap must press and release Q; a hold must keep W down past a 14 px wobble
until the finger lifts; a chord (SHIFT held by one finger, Q tapped by another within the hold time) must put SHIFT
down in the matrix before Q and up after it, and leave SHIFT off. A drag counts only if its first move (12 px, past
the 10 px threshold) reached the page within the 100 ms hold time, and a chord only if Q lifted within it (up to
three tries each), as anything slower is a hold. Not verified automatically: Chrome's and Safari's real toolbars on an
iPhone (they are modelled as a shorter window, or Safari 26's as an 84 px band), and how a drag feels there.
The band is chosen from the user agent (Safari 26 or later on an iPhone, not installed): a Safari 26 set to keep
its address bar at the top, or another browser sending the same user agent, gets the band where it has no toolbar
over the page, and the screen is smaller than it need be there.

### Sound output (the page's audio path)

The machines' sound is compared with MAME's `-wavwrite` recordings (above); the way the page plays it has no MAME
oracle (AGENTS.md 4.6). The output stage's samples are checked in Node (`tests/audio.test.js`: the high-pass of each
sample's average level, no pop at unlock, reset, switch, pause; latency steering over 15 simulated minutes; the bounded catch-up on a mocked clock that models the page's
requestAnimationFrame loop and the audio thread's 128-sample quanta at 44.1/48 kHz and 50/60 fps: steady state in the
band with no short quantum, a 0.3 s and a 2 s stall of both kinds (no tick at all; ticks with the machine paused) back
to sound within N = ceil((TARGET_MS + a frame + a tick) / quantum) callbacks with no short quantum after, the same
pause without the re-prime refilling slowly, and a 250 ms queue back inside the band within `CATCHUP_MS`), the
AudioWorklet's queue and processor with hand-derived values (`tests/audio-worklet.test.js`: order, underrun to exact
silence, the re-prime's wait and its bound, bounded drop-oldest, the MessagePort sink), and the real page in Chromium
(browser check, group `audio`; samples captured through the processor's tap, its copy of every block it plays):
after a pause it restarts at least `TARGET_MS` deep and the second after holds the re-prime's contract, classified
by one shared function (`classifyShort`, `tools/browser-check-audio.js`, the same code its model tests assert
against): a train of short blocks (2 or more - the shallow restart's hover), a short whose gap completed (a later
block's `primes` count up: the fade reached 0, silence, a re-prime) and a restart shallower than `TARGET_MS` all
FAIL, and a lone short block PASSES only when the samples played through it step within the no-pop bound - the
worklet's specified dip ("a dip that refills before the fade reaches 0 is not a gap", `js/host/audio-worklet.js`),
accepted only when provably click-free by the product's own measure (`tests/audio-short.test.js` drives a real
`SampleQueue` through each verdict on the page's own clock-driven schedule);
after the unlock an AudioWorkletNode plays and no ScriptProcessorNode is made (no deprecation warning); through
loads, resets, pause, turbo, sound off, machine switches and a 200 ms busy page, every sample the worklet plays at
full gain equals the one the output stage made (tolerance 0) and no step exceeds 0.01; after an underrun the fade out and
in is a ramp of at most level / fadeLen (5 ms) a sample, measured on a loud 0.5 block put in through the sink (that
program's own DAC level is blocked to near silence, so the step bound alone cannot see a missing fade); the tone of a square-wave
program plays at the frequency the machine makes it (within the 0.5% steering) and the queue doesn't run dry while
it plays (at most 2% of blocks); volume and mute; the four fallbacks to the ScriptProcessorNode (no AudioWorklet,
its module failing to load or never loading, the processor failing); and (group `pwa`) offline, where the worklet's
module comes from the kept copy and plays. Not verified automatically: how it sounds (a glitch heard or not) on real
devices and other browsers (Safari and iOS, Firefox).

Tape sound (`js/host/tape-sound.js`) is the page's, not the machine's, so it has no MAME oracle either (MAME 0.264 mixes
no tape signal into these machines' sound: below). `tests/tape-sound.test.js`: the signal it plays over each frame is
the tape's, checked tick by tick against a second copy of the tape stepped one tick at a time; nothing when the tape
doesn't move (motor off, the end, a rewind, a seek, another tape); a motor switched on mid-frame fills the frame's
end; it reads ahead for fast loading without moving the tape; a playing tape is heard, a stopped one fades below 1e-3
RMS within 6 frames with no step larger than while it played, and its largest sample step is under a third of the raw
square's (the low-pass); at volume 0 the output is the machine's exactly; a machine whose tape is heard saves the same
snapshot. The page (browser check, group `tapeHud`, desktop and phone): on by default, heard while the tape plays
(the output stage's RMS over 0.01), below 1e-4 once the motor stops and while it is switched off; with the page's
Sound switched off nothing at all is sent to the output while the tape plays (`tests/tape-sound.test.js` checks the
same gate in Node). How it sounds is a matter of ear, not checked automatically.

### The machine menu's descriptions and Help's list of machines

Each description in `js/machines/menu.js` states only what the MAME 0.264 driver lines it cites say
(`src/mame/trs/dragon.cpp`, `dgnalpha.cpp`, `coco12.cpp`, `coco3.cpp`, `mc10.cpp`: the COMP() entry's year, maker, name
and parent, a machine config or ROM_START, or the driver's own notes, such as the Alpha's "a prototype in development
when Dragon Data went bust"), and a maker the model's name already gives is not repeated. Where a driver states no
country (the clones' and the Alice's), the descriptions say none; the section subtitles are the design's agreed words,
and KITS's, which names what the catch-all holds, says only what MAME's cp400 entry does (a CoCo child with its own
BASIC ROM). This is checked by reading, against the cited lines, not by a test. `tests/machine-menu.test.js`: every profile has a description
with its source, no description names a model that does not exist, and none repeats the maker its model's name gives; `describe()`'s form; every section the menu
shows has a subtitle and no other does; KITS's subtitle names every model the catch-all holds; Help's generated list is
up to date with the data and lists exactly the 17 models `availableProfiles()` offers, each with its description and
every ROM socket's label and file names. Browser check, group `uiModel` (1280x720 and 390x844): with no ROMs, the top
line and no tags or legend, and that line as the menu's aria-describedby (none once ROMs are stored); the band above
the footer fading into the panel's colour, with no mask over the page; every section's subtitle as the data words it; every item's aria-description its
description, and no live region; **Which one is mine? ↗** a menu item linking `help/#machines` that closes the menu when used; the footer standing below the models' own scrolling box, the last model (the CP-400) whole and on top when scrolled to the end; on the desktop arrow
focus changing the footer line to the focused item's description (aria-hidden), and hovering the CD-6809 showing its
line in view at the menu's foot; on the phone no footer line but the subtitles and the link; with a synthetic Dragon
32 BASIC stored, the tags on every row and ✓ exactly on the machines `machineRoms` calls bootable; the link opening
Help at `#machines` with 17 models.

### The tape's extras: Eject, the Ctrl+K tape commands, several files, recordings named

No MAME oracle (AGENTS.md 4.6): page behaviour. `tests/tape-extras.test.js` records real CSAVEs, the project's writer
firmware (`tools/mame-diff/tape/csave.asm`) running as the Dragon 32's ROM with the name in its namefile block changed
per case: "HELLO" names HELLO.CAS, a blank name and an empty recording "Recording HH-MM.cas", "A/B" A_B.CAS (and
every other forbidden character "_"), two runs in one recording one file named after the first with 2 files;
`MediaLibrary.uniqueName` gives "HELLO (2).CAS" and "(3)" once the names are taken. A 2-file tape reports file 2 of 2
past its second namefile block. `Session.ejectTape` empties the deck, emits `'tape'`, clears the tape watch, and
with the motor on resets nothing: the machine runs on and the motor stays on. Browser check, group `tapePanel`
(1440x900 and 390x844): Ctrl+K without a tape lists **Insert a tape…** (which opens the tape picker, .cas and .wav),
then Rewind, Eject and Save the tape as .WAV muted ("No tape in", aria-disabled, no disabled attribute, after every row
that applies); choosing each of them keeps the box open, changes nothing, puts its reason on its row and says it once
in the live region; with a tape, "rewind" and "eject" find them, not muted; a 3-file tape reads "LOADING · FILE 2 OF 3 ·
BLOCK 4 OF 9"; **Rewind the tape** rewinds; **Eject the tape**, with the motor on, hides the deck, says "Tape
ejected." and leaves the focus on the slot's deck button with the motor still on; the commands are then muted
again; the slot's **Eject** sits beside **Rewind**, is disabled with no tape, and ejects the same way. Group `tape`:
the writer firmware's recording is saved to the Library as CLOADM.CAS, byte for byte, and the toast's **Download**
saves the same bytes under that name; the recording kept at a machine switch is offered as CLOADM.CAS and saved as
"CLOADM (2).CAS"; both are on the Library's shelf after a reload. Two runs of the writer in one recording save one
CLOADM.CAS, and the toast says "(2 files)"; with `?storage=fallback` ("Download and open files") the recording is
downloaded as CLOADM.CAS and nothing is kept. On the touch phone the slot's Rewind, Eject, Record and Save .WAV are at
least 44 px tall.

### Ctrl+K: ranking, typos, the machines, Help

No MAME oracle (page behaviour). `tests/command-rank.test.js` runs `rankCommands` on the page's own command list
with the models' "Switch to" rows: "rset" gives Reset first, "setings" and "setin" a settings command, "coco 3"
Switch to CoCo 3, "help", "guide" and "how" Help, "delete rom", "forget" and "remove rom" Your ROMs, "eject" with a
tape and no disk Eject the tape; "xyzzy" nothing; "switch" and "machine" the one Switch machine… row and no model
rows; every model has its row by its name, the running one muted ("Running now", "You're using the <model> now.") and after
the ones that apply; "eject" with only a tape gives Eject the tape, then Eject disk muted ("No disk in"), with both in
both apply in the list's order, with neither both muted; Rewind and Save the tape as .WAV say their reasons, the WAV
not with a recording; a synthetic list shows the tiers (label
start in list order, then other words, then a near miss); 3-letter words are not forgiven and a near miss keeps its
first letter; the marks are the matched parts of the label. `tests/disk-bare.test.js` checks Eject disk's state and reason
with no disk in. Browser check, group `commands` (1280x720 and 390x844): the same first rows, selected; at most 8
commands then Ask Claude; the marks and the option's accessible name (the plain label, found by role and exact name);
↓ wrapping from the last row to the first and ↑ from none chosen to the last; "coco 3" Enter opening the switch
confirmation naming the CoCo 3, Cancel keeping the Dragon 64; Switch machine… opening the machine menu; Help opening
`help/` in a new tab; the empty box's list with Switch machine… and Help last; every label in Help; the running
Dragon 64's row muted "Running now" after the other Dragon 64s, reached with the arrows, and Enter on it keeping the
box open, putting "You're using the Dragon 64 now." on the row, saying it once in the live region and switching
nothing; "eject" with a tape in giving Eject the tape, then Eject disk muted; every muted row in the empty box
aria-disabled and reached by the arrows.

### The tape HUD and the cassette panel

Browser check, groups `tapeHud` and `tapePanel`. At 1440x900, 820x1180, 390x844 and 844x390 (touch at the last three),
a tape dropped on the screen loads through our BASIC stand-in (`tools/mame-diff/tape/standin.asm`) and the tape line
comes up wholly in the viewport with the page unscrolled, on top at its centre, never meeting the picture's text area,
with the name and block; exactly one animation runs on the page while the tape moves (the cassette panel's window);
**Deck** brings the panel into view (not held sideways, where the touch keys cover the page and it is not offered). At
the end of the tape, with the motor still on: "End of tape", the stamp, no animation running, and the line goes; a
polite live region has said "Tape … playing" and "End of tape …" once each. In the Claude chat view and the browser's
Fullscreen at 1440x900 and 390x844, the line is either in view, on top and off the text, or not shown at all (the
phone chat, whose text fills the screen); in Fullscreen at both sizes it is shown. Only geometry relationships are
asserted, no coordinates. The line is placed again whenever the canvas or the screen area changes size: at the
desktop size the monitor is narrowed in place (no window resize) and, in the very frame the canvas is refitted, the line
already lies off the new text and inside the tube (without the ResizeObserver it lies outside it). The live region is
written exactly twice from the tape going in to its end (a MutationObserver counts the writes). DOM writes in the slots row and the
line, per element over 2 s (desktop and phone): none with a tape stopped in the deck, and only changes while it plays
(at most 8 a second, the position readouts); the rewrite every frame it replaced was 40-60 a second per element. The panel's
own checks (`tapePanel`) also find no reel turning at the end of the tape.

### First use (the cold usability test's findings)

What a first-time visitor without the docs meets has no MAME oracle (AGENTS.md 4.6): it is page copy and page
behaviour, checked against the approved design's own words. `tests/first-use.test.js` (Node) pins the welcome menu's
prompt against the options it lists ("PRESS 1 TO N", N the highest number on screen) on every build, greeting and
carry-on, and after the games menu and back; the message of a machine-code tape that loads and starts ("HI.CAS
loaded ($3000–$30FF) and started at $3000.") and `tapeStatus().started`, which the deck reads ("LOADED · STARTED
$3000") until the motor runs, the tape is rewound or another goes in, with no other memory above $0800 changed; the
install steps for Safari on a Mac; and the Help page's "Claude: getting an API key". In Chromium, the browser check's
first-use checks (run with the `uiCopy` group) drive the real page: a non-number key on the welcome menu shows its
note, with Add ROMs inside the sentence, exactly once a visit (a number key does not); the API key field's console,
pricing and Use with Claude links in the chat's card and the Ask panel; a dropped HI.CAS's toast and deck; the switch
question within 80 px of the machine button with the focus on Switch, directly under the bar at 390x844, and Esc
cancelling it; a mocked gamepad's toast, once; 2048's toast gone at the first arrow key and the colour demo's gone at
4 s while hovered; and the install card with macOS and iOS Safari user agents. Menu's Settings… is checked in the
`mobile` group.

### Install as an app (the PWA offer)

The **Install CLOADM…** item and the one-time offer card (`js/ui/install.js`) have no MAME oracle (AGENTS.md
4.6): they are page behaviour. The oracle is the offer's rules as written here, checked two ways. In Node,
`tests/install.test.js` pins the pure rules: what each stored answer means, the first **Not now** waiting 14 days
and a second ending the offers, a dismissed browser dialog waiting without spending that budget, every condition of
the card one at a time, the program clock, and which steps each browser's user agent gets. In Chromium, the browser
check's group `install` drives the real page with a synthetic `beforeinstallprompt` (mocked `prompt()` and
`userChoice`), an iOS user agent and a standalone display mode: every condition broken alone, the answers across
reloads, a background tab not counting, Esc, focus (the offer never takes it; typing into LIZA while it appears
loses no key), a menu or a view taking the card away without an answer (the offer returns when they close, and Esc
still closes the menu), and the placement. For the placement the check measures for itself, never through
`install.js`: the real boxes of the screen, Reset and the machine controls, every app-bar control, the machine menu
and every visible on-screen key, plus `elementFromPoint` over each of them, over a sweep of 56 window sizes (with
and without the touch keyboard, phones upright and sideways), three live resizes measured once the screen has
settled, a resize back to a roomy size bringing a deferred offer within two frames with the retry throttle held,
and the once-a-second re-check putting right a card moved under it. At every size the card is clear of all of
them or not up with the offer still owed and nothing stored.

Not verified automatically: a real install prompt (Chromium's dialog cannot be driven, so `prompt()` is mocked),
and iOS's Add to Home Screen. Manually: in Chrome on a computer, run a program for a minute and choose **Install**
on the card, then **Install CLOADM…** in the app bar (behind **Menu** on a phone); on an iPhone in Safari, wait for the card, follow
Share → Add to Home Screen, and open CLOADM from the home screen (it starts without the browser's bars and the
Menu item is gone).

### Phones and the app bar (the browser check's `mobile` group)

The phone and app bar layout, with real touch
(`hasTouch`, `isMobile`) at the visible sizes it is designed for: 320x460, 375x548 and 393x659 upright, 734x343 sideways. Every
check failed on v0.1.8 except the guards named here. Upright, at each size: with the full keyboard the screen is at
least as wide as v0.1.8 made it (229 px at 375x548; guard at 393x659); the strip is Keys, Pad, Stick, BREAK, CLEAR and
⌄ (Hide keys) in one row, none overlapping (the switch clear of BREAK), none under 44x44 px, all on the page; the app
bar is one row of 48 px (the machine, Open…, Ask Claude, Menu; Add ROMs not in it), its controls 44 px and more, and
exactly one visible control is named Menu; ⌄ hides the keys, the screen then takes the page's width less 16 px (1 px of
rounding allowed: the picture is whole pixels) and ⌨ (Show keys) is 44x44 inside the window and brings them back;
scrolled to the page's foot, ⌨ covers nothing of it; 2048 opens on Pad with the screen at the page's width, exactly one visible BREAK (the strip's), every pad key 48 px and more and none over the strip, and the strip's BREAK takes 2048 back to the welcome menu. The app bar is 48 px at its first paint (an init script reads
it at the first animation frame) and 2 s later, with the touch class already on. Menu wears a dot while there is no
BASIC (its name then "Menu (ROMs needed)"), lists Programs… first, then "Add ROMs (BASIC needs them)" with the same dot, then Share,
Settings…, the links, Commands… and Install CLOADM…, opens moving nothing in the bar with the focus on its first item
(Tab goes to the next), and its Add ROMs opens Add ROMs; at 390x844 its Settings… brings the settings tabs into view
with the focus on Display. Minesweeper opens on Pad (Up, Left, Down, Right, SPACE, ENTER, F, ABC, no BREAK: the strip's is the only one; every key 48 px and
more, Stick offered); the pad's → and F reach the machine as RIGHT and F; ABC shows the keyboard for one key; Keys
chosen in Minesweeper is remembered for it on that machine while 2048 still opens on Pad and LIZA on Keys; the MC-10's
switch is Keys | Pad. The games' toast says "tap a key" and BREAK, never "Esc" or "press", lies under the app bar and
over no key, upright and sideways; Claude's paused status on touch is "Paused: you tapped a key · Stop ends Claude's
turn". Guards: on a computer the toast keeps "press a key" and "BREAK (Esc)"; sideways the screen is 250x187 at
242,52 as on v0.1.8, with one control named Menu. Sideways the panel's Menu has Machine…, Commands…, Install CLOADM… and Hide keys, and
Machine… opens the machine picker on screen and on top; Esc closes it. No install offer appears on a phone, with the
prompt held and 120 s of LIZA run, on a first and a second visit (sideways a guard: v0.1.8's offer found no place
there either); Install CLOADM… (in Menu upright, in the panel's Menu sideways) still opens the browser's install dialog (a guard upright). At 1440 and
1024 px and at 1920 px the status shows the speed alone, shown and whole in the page font (the links go tight first);
only at 1200 px in a wide fallback font may it be left out (the layout group), never cut to a stub.

### Menus, focus and what screen readers hear

The page's menus and boxes (the machine menu, the phone's Menu links, a drive's menu, the Ctrl+K box, the touch
keys' Menu sheet) and the polite live regions (Ctrl+K's match count, the Library's "N selected") have no MAME
oracle (AGENTS.md 4.6): the oracle is the focus and announcement behaviour written down here. The browser check's group `menuFocus` drives them with
real mouse, touch and keyboard events at 1280x720 and at 390x844 with touch, and after every step reads
`document.activeElement` and whether the surface shows: Tab out of the machine menu closes it; Esc with the focus
on the screen closes the machine menu (or Menu's links) and gives the focus to its button with no BREAK reaching
the machine; a press outside on nothing focusable closes the surface and gives the focus back to its opener, a
press on a control leaves it there; a `.menu-open` left on the bar at desktop width leaves Esc on the screen as
BREAK; a drive's button keeps the focus while its menu opens and gets it back on Esc or a press outside; the keys'
Menu sheet is a labelled group, opens with the focus on its first button and gives it back to Menu on Esc and on a
tap outside; a machine menu or drive menu left open under the Debugger (opened by keyboard, Ctrl+K) does not take
its Esc, and neither does a machine menu or keys' Menu left open under Claude's full-screen chat on a phone (one Esc
on the screen leaves the chat); Ctrl+K
says "3 commands" for "res" (counted by hand from the command table) and the no-match line for "zzz", only after the
typing pauses; the Library's region is outside the selection bar, says "2 selected" after two toggles and was
written exactly twice (a `MutationObserver` counts the writes).

Not verified automatically: what a real screen reader says (the live regions' text and politeness are checked,
not the speech).

### Document semantics: landmarks, headings and what a reading mode extracts

The play page as a document has no MAME oracle (AGENTS.md 4.6): the oracle is HTML and WAI-ARIA's landmark and
heading model, Chromium's accessibility tree (Playwright's accessibility snapshot, and the full tree over the DevTools
protocol for the canvas's subtree), and Mozilla's Readability 0.6.0 (`tools/vendor/readability`, an unmodified copy,
development only) standing in for a browser's reading mode, which works from the markup, not the stylesheet. The
browser check's group `semantics` runs at 1440x900, a Pixel 7 in portrait and landscape and an iPad, and checks:
exactly one `<main>` (the emulator's) and one main landmark in every view (each view is its own while open); the
landmark set; one h1 and no heading level skipped, in the emulator, every view and the full-screen chat; every
surface that is not drawn (dialogs, menus, tab panels, asides, navs, views, the folded Multi-Pak, the emulator behind a
view, the app bar's links folded behind a phone's Menu, the drawer and the ports in the touch layout) hidden by its
`hidden` attribute or by `inert` and `aria-hidden`, out of the accessibility snapshot and unable to take the focus,
as the page starts and after each was opened and closed; every dialog named and none claiming `aria-modal`, because
none is modal (Tab leaves the open command box); the screen canvas an `application` with its name and, in its
subtree, the text of `Session.screenAlternative()` (Claude's `screen_text` reader; `tests/screen-alternative.test.js`
checks it in Node), following the screen; and Readability's article: the screen's text, at most 400 characters, none
of the panels' text, and in a view the view's text, not the emulator's. The landing page: banner, the site
navigation, one main, contentinfo, headings in order.

Not verified automatically: what Chrome's own reading mode (Android or desktop) and a real screen reader present;
Readability is the stand-in. Mutations that turn the group red: no `inert` on what a view or a layout hides (20
checks), a second `<main>` (16), the ports under the screen a `<div>` instead of an `<aside>` (6).

**How the text-alternative comparison avoids a race, and what it does not cover.** `#screenAlt` is a DOM mirror of
`Session.screenAlternative()` that the page refreshes at most once a second (js/ui/screen.js), and Chromium's
accessibility tree is a third copy read over the DevTools protocol. Measured with CPU throttling at 4x, the live
screen differed from the mirror in 40 of 135 samples across the three seconds a greeting takes to type, so a
single-shot comparison of one live read against the AX text failed on a slow runner with nothing wrong. The check now
requires four readings to agree - the live text before and after the AX read, the mirror, and the AX text - and
retries until they do, within a stated bound; and it separately measures the mirror's lag after a key changes the
screen, which is what makes a mirror that simply stops updating fail rather than being waited out (a mirror
refreshing every 2.2 s goes red by name).

**What a group's own closes and the tone measurement are bounded against, and what still is not.** Every close a
group's own body performs - a context (299 sites), a page it opened itself (10), the library storage group's own
browser and its persistent-context profile, the connector module's seven closes (it is a group of the check too,
and shares the one helper from `tools/browser-check-lib.js`) - goes through `bounded()` (10 s; 15 s for a
browser), reported by name: a hung close FAILs `"<group>: a context it opened closes"` (deliberately distinct
from the per-group cleanup's `"<group>: its context closes"`, so the log shows which layer caught it), the run
goes on with exit 1, and the cleanup catches the still-open context again. A planted close that never resolves
fails by name twice (once per layer) and leaks no Chromium. The two browsers a group launches OUTSIDE the run's
own (the library storage group's) are reached by neither the cleanup nor the final `browser.close()`, so their
closes are raced and their Chromium is killed on a timeout, and the summary is followed by an actual exit with
the chromium count back at baseline (measured: before the fix a planted hung close left the run idling with 5
Chromium processes until killed from outside; after it, a named FAIL, exit 1, 19 s, no process left). The belts
reach only their own processes: the group's own browser launches through `chromium.launchServer()` (whose
BrowserServer exposes the process handle a directly-launched browser does not in this build) and a hung close is
followed by exactly that server's `kill()`; a `connect()` that throws closes the server through the same bounded
report before re-throwing, so the launch itself cannot leak; and the persistent context's belt finds its process
by its own `mkdtemp` profile path, regex-escaped and passed to `pgrep` as a literal argv element - a bystander
Chromium from another run survives the planted hung close while the run's own is killed (measured). A belt that
did not or could not run says so in the FAIL's after-text (`killed` only when a process was found and signalled;
`its process was already gone`, or `could not look for its process (pgrep not found)` otherwise). After a kill,
the signalled pids are waited for, bounded (2 s), and the profile directory's removal is retried, bounded; a
directory that still will not go is a named warning - a leaked temp dir, never a throw burying the group's real
result. The sound group's tone measurement - a `page.evaluate` polling `window.blocks`
for a full second of full blocks - is bounded from the Node side (10 s, ~10x the ~1.02 s of audio it needs):
a starved source FAILs `sound: the tone measurement ran and produced its numbers` AND `sound: the tone
measurement fills its second of full blocks`, the first naming that the measurement produced nothing at all (it
holds even if every other line is deleted - a mutant that swallowed the starve branch is red through it, by
name), the second carrying the probe's own state (blocks so far, full count against the count needed, resampler
mode, queue depth, the audio clock and the context's own state - every read guarded, and the state read itself
bounded at 5 s). A starved tone does not stop the group: the tone-dependent checks (frequency, dry) are skipped,
the fallback contexts - which open their own - and the whole-session equality checks still run. The volume peak
polls (200 full blocks each) are bounded the same way, with their own probe state, and each has its own named
ran-check (`sound: the loud/soft volume peak poll ran and produced its number`) - the loud one sits outside the
guard that skips the volume checks, so a swallowed starve outcome cannot skip its way to green (a mutant with
both polls starved and the loud starve FAIL deleted is red through it, by name); the mute fade needs only a live
source, not a peak value, and runs either way. What IS bounded and reported besides these: the dump's wait (5 s)
and every wait through the lib (`waitFor` and friends, 30 s).

`bounded()` itself is tested for what a caller can observe: its four outcomes, that the timer is unref'd (a child
process holding only the race exits at once instead of idling out the bound - the property whose absence once
held runs open 14.9 s after their summary; the unref-removed and the clear-and-unref-removed mutants are red by
name through it), and that a settle arriving after the bound cannot change the outcome the caller saw. Two of its
internals are deliberately not asserted because no caller can observe them: the cleared timer (an uncleared
timer that is unref'd holds nothing open; Node 25.2.1 does not even list an unref'd pending timer in
`getActiveResourcesInfo`) and the settled flag (a late settle's second outcome lands in a lost `Promise.race`
branch; every caller awaits the race once). Both stay in the helper as defense-in-depth behind the observable
property, and their mutants staying green is by design, not a hole.

Still unbounded, honestly: a page wedged in **synchronous** JavaScript cannot be bounded from the host at all - a
`Promise.race` bounds the wait, not the work - so that case still ends by the caller's timeout (the CI job's
`timeout-minutes`, or whatever runs the check locally). The same is true of a hung close of the RUN's own browser
after the finally's bound fires: that browser (the run's one `chromium.launch()`) has no process handle in this
build, so nothing inside the run can kill it - the FAIL lines and the exit code are always produced first, and
the caller's timeout is the exit backstop of last resort for it (the groups' own browsers, above, do have
kill belts; the main browser does not). The `http.Server.close()` calls (the run's server, the groups' local
servers) are not raced: they are paired with `closeAllConnections()` and unref'd, which is what keeps them from
holding the process, and a server that ignored that would end by the same caller's timeout.

### The machine and its ROMs: toasts, switches, the disk ROM, the menu, the Library, the copy

These have no MAME oracle (AGENTS.md 4.6): the oracle is the behaviour listed below, and the
browser check's group `uiModel` drives them with real events at 1280x720 and at 390x844 with touch:

* Every toast is visible: a disk dropped without a disk ROM: the toast (the disk is in drive 0 on the disk controller alone, with **Add
  disk ROM…**) has its box inside the viewport and `elementFromPoint` at its centre is the toast; it keeps its slot and
  its time runs. An error toast (a disk image CLOADM can't read) is red. With that disk in and no tape, the drives
  card is above the cassette deck on the phone and under the keyboard panel, and after it on the desktop. (`feedbackModel` checks the fixed top slot where nothing else is
  free, and that it goes after its 4 s.)
* A toast replacing a focused or hovered one (`feedbackModel`, 1440x900): a toast replacing a focused one leaves the box up (a `MutationObserver` records no
  `hidden` write) and the focus never on the body (in the same task and a frame later); with another action (an equal
  label, another object) the focus is on the box, the new toast is up 10 s later and Enter fires nothing, and after
  Shift+Tab it goes 8 s later; with the same action object the focus stays on the button and Enter runs it; with no
  action the focus is on the box. A toast replacing a hovered one stays 10 s, then has its full 4 s after the pointer
  leaves. One announcement per toast (the live region's text changes once for each). The provisional pin: a toast
  raised as a sheet (a `.controls` element shrinking in 150 ms) opens is in view in its first frame in the top slot,
  in the free place once the transition ends, with no animation, and its rect is the same in every 50 ms sample from
  350 ms on; a focused provisional toast keeps the slot, and one that lands in the slot already focused is still provisional
  past 300 ms, taking a place that opened meanwhile once the focus leaves. `tests/feedback-toasts.test.js` checks the same rules in Node,
  with the 300 ms limit and a hovered provisional toast.
* Opaque sheets (`feedbackModel`): at 390x844 with touch and the Ask sheet at peek, a toast too tall for the band under the screen
  text is in the header band (the top slot under the 48 px bar), over neither the sheet nor its controls, its rect the
  same from 350 ms on; at 900x800 with the side panel over part of the slots, the toast is in a free place that meets
  no control part that shows and none of the panel's controls; the guard: every shown `[data-occludes]` element (the
  sheet at peek, the panel, the attention card) has opacity 1 up its ancestors and a background alpha of 1; an
  opaque overlay sliding in over a control occludes nothing until its transition ends (top slot in frame 1, its own
  place after); a test `<dialog>` opened with `showModal()` over a toast, and a toast raised under it: in both
  `elementFromPoint` at the toast's centre is the toast, and the region leaves the dialog and the top layer when it
  closes; one announcement per toast. `askEsc` (5d) now runs the turn on a phone (header band, no Stop covered) and at
  900 px (none of the panel's controls covered): the "toast over the Stop" it was written for cannot form under
  the rule for opaque sheets, and in both the pill does not come and go and a Stop can be reached. `tests/feedback-toasts.test.js` checks each
  rule in Node.
* The fallback slot keeps off Claude's Stop (`askEsc`): where a toast has no free place while a turn runs -- a phone
  held sideways (844x390, touch) while Claude types, and the full-screen chat at 1280x800 and held sideways -- the long
  toast takes the fallback slot, and that slot is the top one only if it covers none of Claude's Stops that show,
  otherwise the stylesheet's bottom one. For 20 toasts in a row, long and short, in each layout: the premise (the long
  toast is in the fallback slot), `elementFromPoint` at every shown Stop's centre is never the toast, `#viewClaude`
  never changes visibility (0 changes), and a Stop can be clicked while each toast shows. With the fallback always the
  top slot (the code before this check) it fails: the toast lies over `#btnAskStop` or `#btnClaudeStop` (held sideways
  over the pill's own `#btnViewStop` too), the pill comes and goes once per long toast, and held sideways no Stop can be
  clicked.
* The phone layout (`phone`, iPhone 15 upright): the four chips in their fixed order under the keyboard panel, each in
  view and at least 44 x 44; each opens its sheet (a modal dialog, the focus inside, its title) and Esc closes it with
  the focus back on the chip; the hardware keyboard does not reach the machine while a sheet is open (the welcome
  menu's "1"); a tape mounted from the Tape sheet names itself on the chip (text, outline, accessible name); a held
  stick is let go of when a sheet opens; Esc with the drive menu over the Disks sheet closes the menu first; a sheet is
  modal, and its Esc ranks over Claude paused by a key; Hide keys from the Power sheet, then ⌨, with the chips up throughout; a toast's
  action button at least 44 px tall. `uiModel` checks the Disks chip after a dropped disk; `semantics` the landmarks with
  the ports as chips and every closed sheet hidden for real; `tapeHud` that the reels turn only in an open Tape sheet.
  Also in `phone`: Menu → Settings… (its order, the sheet's tabs at least 44 px, its top edge at or below the screen's
  foot, Expand and Collapse, the palette's "Display settings" on Display, the tab last used); the focus back on a chip
  opened with the focus elsewhere; one sheet at a time and Ask's sheet closed; NitrOS-9 under the drives, the Disks
  chip's file name and "2 disks"; Paused; the full-screen chat closing a sheet; sideways (iPhone 15 landscape) the keys'
  Menu, the ports' side sheet (its size, tabs, each port in reach, Esc back to Menu), Power… and Settings…, the tab that
  holds media, and turning with a sheet open; a short phone (375 x 548, 320 x 460) with no chip row, Menu's two items
  and their states, its dot and name, and the ports' sheet from the bottom; a desktop at 1440 x 900 with the ports and
  drawer where they were before (and back there after the touch keys on and off) and no duplicate ids. Screenshots of
  each sheet. `mobile` keeps its screen-size floors unchanged.
  Also in `phone`: Menu → Programs… (Menu's order with Programs… first; the "Programs" sheet's sections, the shelf with
  "on screen now", the focus in it; the Media tab left with only the tape options; the sheet's order, Last time at the
  top, then the no-ROM card, the shelf, Recent, Snapshots with its heading and note, the Library link), then 2048 from
  it: two taps, the sheet closed and the game running; the palette's "Programs" found by programs, games, demos, liza
  and run, with 2048 marked "on screen now" and no Last time while it runs, and Last time (2048) the sheet's first item after a reset; on a desktop the palette's "Programs" selecting the
  Media tab from Display with the focus on the shelf's first item; "Chat with Claude" from the sheet closing it. No Menu label with its words run together, upright, sideways (the keys' Menu), at
  393 x 659 (`mobile`) and in the desktop app bar at 1440 and 900 px: every two drawn letters with a space between them
  in the text stand apart on the screen. The media file pickers' accept values, exactly: their extensions and
  application/octet-stream, and no picker asking for image/*.
* A switch names what comes out: the switch confirmation's text for a tape and a cartridge (both in the Library), a tape and a disk, a RAM
  change (and Cancel putting the select back), a snapshot's own disk with **Save to Library** (stored and linked),
  DriveWire (not listed, still mounted after the switch); the toasts after the switch. `tests/switch-losses.test.js`
  checks `Session.takenOut` and `DiskDrives.keepSnapshot` in Node, the Speech/Sound Pak case included.
* The disk ROM card: its title per machine (none on the Alpha and the MC-10), its `data-disk` mark with the socket
  counts unchanged, and a drive's **Add disk ROM…** landing on it (in view, focused, on top at its centre).
* The machine menu's footer and Your ROMs: Ctrl K "roms" Enter (Your ROMs, focus on its heading, nothing scrolled), the palette's top result for
  each of its words, the ROMs row first and its label with and without a stored test ROM, the "needs ROMs" toast and
  its action, ↓ from the last machine to both footer items, Esc, and each footer item's focus.
* ROMs in the Library: the ROMs chip's card with and without ROMs (the count and the machines worked out from `session.roms`),
  the drop's **Open Your ROMs**, and the card's link. `tests/stored-roms.test.js` checks `Session.storedRoms`.
* ROM state, one story (browser check `romTruth`, `tools/browser-check.js`): on one first visit, with no
  reload, the side card, the welcome menu and Your ROMs are checked against each other in three states — no ROMs,
  an unrecognised ROM loaded (our own NOP image at a socket's name and size, never a real dump), and "Run without
  ROMs" with the ROMs still in the sockets. The card says "Running with no ROMs." only in the first, is gone in the
  second, and says "Running without your ROMs." with a working "Use my ROMs" button in the third; menu option 3 reads "ADD YOUR ROMS FOR
  BASIC" in the first and "USE YOUR ROMS FOR BASIC" in the third. Your ROMs lists a machine under "Also ready to run
  BASIC" only for a verified dump, and the note about a file that could not be used sits beside the socket list.
  `tests/roms.test.js` checks the two rules in Node (`Session.machinesVerified`, `Session.romsReadyButOff`), with a
  mutant that asks "filled" instead of "verified".
  **Not verified:** no MAME loader sets ROMSW to 1, so the "USE YOUR ROMS FOR BASIC" branch is not MAME-compared.
  It is the same menu table and a two-way branch on one byte (the same code path that draws "ADD YOUR ROMS FOR
  BASIC", which is compared), held instead by the Node tests on both welcome builds, which read the drawn cells.
* ROM tiles: an empty Library shows the ROMs chip and the "No ROMs yet" card; under the ROMs chip (none under All) a
  tile per stored image with its name, size, "Used by" (a shared image names every machine) and a Remove button of at
  least 44 px (one column on the phone); Remove takes the tile away, the toast reads "Removed d64_1.rom." with Undo and
  the second line about the running Dragon 64, both machines' sockets are empty and the machine still runs it; the
  toast stays past its 8 s while focused; Undo brings the tile and both sockets back byte for byte; Your ROMs reads
  "Removed · still in the running machine"; the toast's Switch off and on leaves the machine without ROMs; a ROM the
  machine doesn't use gets no second line; after a reload the removed ROMs are gone. `tests/rom-remove.test.js`
  checks it in Node with NOP stand-in ROMs: each image once in `romFiles` with its users, removal from every socket
  written to the store (a library loaded again from it lacks the image), Undo byte for byte (never over a ROM put in a socket since: that one stays,
  after a collect too, and the skipped socket is named; a disk cartridge switched off and on without its ROM gets it
  back, with a restart), a running machine's
  registers, cycles and screen identical to a twin's for 30 frames after the removal, still running it after a
  reset, without ROMs after a switch off and on, and a disk cartridge's ROM taken out at the switch off and on. On
  the page, after the Remove the machine's socket still holds the same bytes and its frames and cycles go on.
* The copy: every text node and title, label and placeholder of the page (emulator, machine menu, Your ROMs, Share,
  Library) holds no "stub" and no "Machine tab", and "disk ROM" is the one term; the ROMs row's states, the .dgn
  warning and the snapshot sentence word for word.
* The welcome tune: it plays only when the person asked for the menu (the visit's own start and Programs' Welcome menu,
  once the sound is unlocked); a machine switch, Reset, a power cycle and a return from LIZA, a game or the demo are silent.
  `tests/welcome-tune.test.js` measures the DAC (the MC-10's latch) over about 3 s of frames on both firmware builds; the browser
  check's group `visit` reads the firmware's PLAYED flag and counts the tune's DAC events after a page switch and a return.

Not verified automatically: how the fixed top slot reads to a person on a real phone (screenshots
`r24-disk-toast-*.png` were looked at).

### Library writes from every door: guest creates, saves and renames

No MAME oracle (AGENTS.md 4.6): these are the Library's own ordering rules, and the oracle is each race played out
with the loser held inside the await where its check had already passed. `tests/store-races.test.js`:
* A guest's DriveWire named-object call over each server the Session builds besides the Becker port's (a real CoCo on
  Web Serial, through a mocked `navigator.serial`; the full-screen chat's): a CREATE whose write is in flight when a
  move starts is a Library operation the move waits for, after which the move is refused naming the guest's drive and
  the object is in the store the session still uses; a CREATE or a MOUNT asked while the move copies is answered 0,
  hands out no drive and writes neither place. Every server comes from one constructor
  (`Session.newDriveWireServer`), which wires both guards.
* addAndBootNitros9's floppy save and Save to Library (`drives.keepSnapshot`) store their disks/ name as one creation
  (`library.createDisk`, the same path as a dropped disk image): a rename onto the name while the save is held is
  refused ("a disk is being made under that name") and both images keep their bytes; a save asked behind a rename of
  that name in flight refuses ("There is already a disk named n9.dsk in your library"), leaving the renamed image as
  it was; an import asked during Save to Library refuses, and so does one asked while either save is still in its
  case probe after the write (the landing comes at the creation's end, not before its write).
* The words: a case-only rename on a store that does not tell cases apart names the new name without the folder
  typed ("so work.vdk and WORK.VDK are the same name"); a blank new name, "disks/" alone and a ".." segment are
  refused naming the item ("work.vdk was not renamed: the new name is blank (empty or only spaces).", "... ".." is
  not a name a file can have."), each word for word, with the store unchanged; Save to Library of a disk with no
  file name says so and what to do, and of one whose name is not a disk image's file name ("sub/x.vdk") says why.
On the stage branch 30 of its first 45 checks fail. Each guard bypassed on its own (the real CoCo's server or the chat's
built without the guards, either guard dropped, either save back to a plain Library operation, the creation's claim
or its landing check dropped, the landing moved before the write, each message reverted) turns it red.

### A disk without a disk ROM

With no disk ROM a mount plugs the disk controller in with nothing in its ROM socket (`DiskDrives.plugBareController`),
without a reset, and the disk goes in. The program used is ours: `tools/mame-diff/fdc/gen-bare.js` writes one read
routine (restore, then read track 0 sector 1 of drive 0, every byte taken on DRQ by polling; on the CoCo with NMI on
INTRQ) in two builds: a ROM build for the MAME comparison below and a RAM build that runs on the built-in firmware.

* `tests/disk-bare.test.js` (Dragon 64 with a VDK, CoCo with a JVC): the mount's message word for word; the board
  with no ROM, its cartridge space reading 00 and no CART line tied to Q or raised, before and while running; the
  program loaded first runs on through the mount (frames and its count go on, its code intact), its first read
  finds no controller and its next one reads the sector, compared with the bytes `images.js`'s formula gives; a
  snapshot taken in the middle of the transfer restored into a fresh machine runs on identically (registers, cycles,
  frames) and finishes the read; a disk ROM stored afterwards waits for the next power cycle and then goes into the
  same board's socket with the disk still in (the Delta DOS ROM on a Dragon: its own board replaces it at a reset,
  with the disk moved across); **Take out** with the program running on; the MC-10, a Multi-Pak with no
  controller, a cartridge in the port (it comes out, with a power-up); `disk=` before `load=` in a link; the command
  box's disk commands; the command line's `--disk` note on stderr and in the JSON, and the guest's read.
  Mutations that turned it red: the old refusal back; the board tying CART to Q; a reset when the board goes in; no
  ROM fitted at the power cycle; the link's media in the order given.
* The browser check's group `disk`: the card and an empty drive's menu with no disk ROM (its buttons and note), the
  game dropped and then its disk (the toast and **Add disk ROM…**, the cartridge port's name, **Take out**), the game
  running on and reading the disk (its screen), the loaded drive's menu, **Add disk ROM…** landing on the disk ROM's
  card, Ctrl+K "mount" → **Insert a disk…** and **Eject disk**, a disk ROM dropped afterwards (the toast, the card)
  and put in by **Switch off and on**. Group `url`: `load=…&disk=…` in either order runs the game with its disk in
  (its first read, at its start, succeeds); `disk=` with no link is reported. Groups `media`, `feedback` and
  `uiModel` follow the new messages, and `uiModel` checks the phone's slot order.

## The comparisons

`tools/mame-diff/` compares this emulator with MAME's `dragon64` driver. Neither tool uses the Dragon ROMs: both
emulators run diagnostic firmware written for this project, installed in the ROM sockets.
Each run works in a folder of its own under the system temp folder (`lib/workdir.js`), removed when it ends (also on
Ctrl-C), so runs of the same machine can go at the same time. If MAME can't find a ROM file, the run stops at once and
names it.

* `node tools/mame-diff/run.js <profile>` compares instruction traces in lockstep. It checks every register, flag and cycle
  count after every instruction. The diagnostic firmware covers the ALU over a grid of operands with carry/half-carry in and
  out, all indexed addressing modes, TFR/EXG, the stack, SWI1-3, every short and long branch, PIA registers, HS/FS timing
  and IRQ, CWAI, SYNC, SAM writes, Dragon 64 ROM bank switching, the 64K map type, page bit P1 (with and without M1 and TY), keyboard rows and the joystick comparator.
  Current result: **1,028,112 instructions identical**, cycle counts included.
* `node tools/mame-diff/run.js <profile> --video` compares the rendered screen pixel by pixel in all 20 display modes. All text,
  semigraphics and graphics modes are identical on the Dragon and CoCo machines, including the CoCo 2B's MC6847T1
  character set with lowercase. Composite colour is compared exactly as well (see below); `--artifact N` sets MAME's
  "Artifacting" option and ours alike (0 off, 1 Standard, 2 Reverse; default 1, MAME's default).
  Current results: dragon64, dragon32, tanodr64, coco, coco2b and mc10 **20/20 identical** (coco, coco2b and mc10 at
  each of the three settings); coco3 49 modes, **34 identical**, 15 identical
  apart from our own font designs, 0 different, at each of the three settings (RGB monitor, exact RGB: the
  compatibility modes' artifact colours are mixes of exact GIME colours, 55,384 and 73,728 pixels in the two
  256-pixel modes).
* `node tools/mame-diff/run.js <profile> --raster` compares video changes made *part-way along a scanline*.
  The firmware (`<family>/gen-raster.js` writes `raster.asm`; `lib/raster.js` runs it) shows, per case, plain
  lead-in fields and then fields in which a video register is written on many lines, one CPU cycle later on each line,
  so the writes cover every beam position. It runs in lockstep with MAME to HALT (so every write lands on the same
  cycle), then MAME records `-aviwrite` and one swept field per case is compared pixel by pixel, border included. A case
  also fails if its writes change nothing (or, for a write that must not show, if they change anything).
  Current results, all with identical traces to HALT: dragon64, coco and coco2b **17/17** (VDG modes, CSS, INT/EXT,
  SAM V0-V2 and F, a non-video PIA bit, and composite colour across a mid-line mode change); mc10 **10/10** (every latch bit); coco3 **8/8** (palette, border, resolution,
  horizontal offset, CSS in CG2; lines per row, vertical offset and the COCO bit are latched per field
  and must not show). **CoCo 3 limitation:** MAME's GIME records each line whole, at its end, and cannot render a
  partial line, so the CoCo 3 comparison is per line: it proves which line each write lands in, at every cycle of the
  line. Ours does the same. A change part-way along a GIME line (which real hardware may show) is neither modelled nor
  verified against hardware; no source describing it has been found.
* `node tools/mame-diff/run.js mc10 --welcome` (and `alice`) compares the 6803 welcome program with MAME. The program
  runs at `$5000` in RAM on the page, but MAME cannot load a `.bin` there and set the PC, so `mc10/gen-welcome.js`
  writes `welcome-load-<machine>.asm`: a loader in the ROM socket that copies the `HALTCODE=1` build (its own bytes,
  as `FCB`) to `$5000` and jumps to it. Both emulators run that image, so the CPU executes the shipped bytes; the
  comparison build's stop is in fixed 2-byte slots, so it is the same length as the shipping build and differs from
  it only there (`tests/welcome6803.test.js`). `--back` has the loader set what the Session sets for a returning
  visitor first (GREET 1, "WELCOME BACK", and option 5, "CARRY ON WITH LIZA"). On MAME 0.264 the traces run to HALT
  with every register and cycle count identical (mc10 16,347 instructions, alice 16,344; with `--back` 17,337 on
  both), and `mc10/run-welcome-video.js <machine> [--back]` compares the drawn screen with MAME's `-aviwrite`
  capture, pixel by pixel: 0 of 49,152 pixels differ in all four runs. The comparison stops at the HALT, before the
  tune: the tune keeps the latch's value in RAM because `$BFFF` reads the keyboard (`tests/welcome6803.test.js`
  checks it writes only the sound bit and leaves the text screen).
* **Composite colour** follows MAME 0.264's model (`mc6847.cpp`, class `artifacter`; `MC6847.finishLine`). NTSC:
  in the 256×192 mode each pair of pixels takes one of 16 colours chosen by a six-pixel window (MAME's
  `artifact_correction` table; 14 of the colours are fixed mixes of the background and foreground,
  `artifact_colors`); the phase setting swaps each mix with its partner. PAL: on each odd active line in the
  semigraphics and four-colour modes, two different colours one above the other become one blended colour
  (`create_color_blend_table`). Both follow the mode a line begins with, as MAME's do. Besides the pixel
  comparison, every composite pixel is checked against MAME's own colour for it, computed from MAME's palette
  (`tools/mame-diff/lib/composite.js`), so the two phases cannot be confused with each other. This is MAME's model
  of a composite TV, not a signal-level simulation; no hardware measurement is compared.
  **Decision:** this model is CLOADM's composite colour, and there is no separate signal-level
  simulation. A simulation of the composite signal (pixels modulated onto the colour subcarrier and decoded with
  filters) gives colours of its own, which cannot be verified pixel for pixel against the reference; MAME's model
  can be, and is. The CoCo 3 shows artifact colours in its compatibility modes' 256-pixel two-colour mode
  through the same artifacter, as MAME's GIME does (`gime.cpp` render_scanline; `GIME.artifactLegacy`), with
  the palette entries in use as background and foreground. MAME applies them on either monitor; CLOADM ties them
  to CRT · composite (the composite monitor), as a real RGB monitor shows no artifact colours.
  The CoCo 3's composite monitor shows MAME's measured composite colours (`gime.cpp` `get_composite_color()`,
  BSD-3-Clause, copyright-holders Nathan Woods; `js/chips/gime.js`), the phase-inverted set while `$FF98` bit 5
  (BPI) is set, and grey while bit 4 (MOCH) is ((r + g + b) / 3, `mc6847.h` `black_and_white()`); the artifact
  colours are mixed from whichever of them is in use. Like MAME, the choice applies to the whole picture, not
  from the line where `$FF98` was written. `run.js coco3 --video --composite [--artifact N]`
  (`coco3/vdg-composite.asm`: every display mode, plus BPI, MOCH and both on six of them) is identical to MAME's
  composite monitor at artifact settings 0, 1 and 2, apart from glyph shapes in text; each BPI and MOCH picture
  must differ from its plain mode. The colours before this were an approximation of our own, which fails 62 of
  the 67 modes.
* **The CRT look** (the Display tab's curvature, phosphor glow and scan lines; `GlPresenter` in
  `js/video/canvas.js`, a WebGL fragment shader) changes only how the frame is shown, never the frame, so it has
  no automatic oracle. `tools/browser-check.js --screenshots DIR` draws a fixed 256×192 artifact-colour picture at
  fixed settings (`display-crt-default`, `-crt-phase2`, `-crt-max`, `-crt-flat`, `-sharp`), which are reviewed by
  eye. What the browser check does verify: the WebGL presenter is in use, each control changes the setting and the
  machine (composite colour on or off, the phase), integer scaling gives a whole number of display pixels per
  line, "Fill" fills the area, everything is remembered over a reload, and without WebGL (forced) the 2D
  presenter draws the picture, the tab says the CRT look is off and the page has no errors.
  Manual review (Chromium, 640×480 picture at device scale 1): curvature, glow, edge darkening and
  the swap of the two artifact phases look as intended; scan-line gaps aliased into curved bands at two display
  pixels per line, so they now fade out below three (`lineScale` in the shader); Sharp shows square pixels.
* **Defaults:** CRT · composite with artifact phase 1 (MAME's default), curvature 35 %, glow 55 %, 4:3, no
  integer scaling. So composite colour is on from the start, and the CoCo 3 starts on its composite monitor's
  palette; Sharp · RGB switches it to the RGB monitor's.

* `node tools/mame-diff/run.js <dragon64|coco> --fdc --bare` runs `fdc/bare-dragon.asm` or `fdc/bare-coco.asm`
  (`fdc/gen-bare.js`) as BASIC with the controller's ROM socket empty (MAME's holds 8K of 00, ours no ROM; both read
  00), drive 0 holding `images.js`'s double-sided disk: a program that reads track 0 sector 1 through the registers
  and ends in HALT. MAME 0.264: every instruction identical in all registers and cycle counts, and HALT reached:
  `dragon64 --fdc --bare` 1,200,945 instructions compared (HALT at 66,473), `coco --fdc --bare` 1,208,171 (HALT at
  66,937). `tests/regress.test.js` replays both (`trace dragon64 bare`, `trace coco bare`).
* `node tools/mame-diff/run.js <dragon64|dragon200e|coco|coco3> --fdc [dragonfdc|premierfdc|cocofdc|multifdc] [--multi] [--images]` runs the
  floppy disk controller cartridges (`fdc/`: `-ext dragon_fdc` with a WD2797 on the Dragon 64 and the Dragon 200-E (its
  slot's default, as `dragon.cpp`'s dragon200e() is dragon64()), `-ext premier_fdc` with a WD2791 on
  the Dragon 64, `-ext fdc` with a WD1773 on the CoCo and the CoCo 3, and `multifdc`: the same CoCo controller in slot 4 of a
  Multi-Pak, `-ext multi`, which the front-panel switch selects at reset, so the same firmware runs while every NMI
  and HALT reaches the CPU through the Multi-Pak) with our firmware as the disk ROM
  (`fdc/gen-diag.js`) and four drives: a double-sided disk, a write-protected one (MAME opens an image inside a ZIP
  read-only), a drive without a disk and a DMK disk, all built by `fdc/images.js`. The firmware covers register commit
  delays, the index pulse, restore/seek/step at every rate with update and verify, step-out below track 0, verify
  failure, read address, read sector (E delay, multi-sector, the WD2797's b flag, side 1), lost data, record not
  found, write sector and deleted data marks, read track, write track in MFM and FM, write protect, the drive without
  a disk, force interrupt (immediate, index, during a seek), NMI on INTRQ, the Dragon's DRQ-on-CART FIRQ transfer,
  the CoCo's HALT transfer and multi-sector write. The Premier board's WD2791 has an inverted data bus, so its
  firmware (`premier.asm`) writes and tests the complement of every register value; it also checks the WD2791's side
  compare (C and S flags), and as the board connects no interrupt line, it polls the status where the others wait for
  NMI. `--images` then runs MAME untraced to the end and requires the
  disk images it writes and ours to be byte-identical (MAME cannot save DMK; ours is checked by reading back what the
  firmware wrote). The controller is a port of MAME's `wd_fdc.cpp` (both data separators, the bit-level live state
  with its roll-back), `floppy.cpp` (rotation, flux, weak bits, flux writing) and the VDK/JVC/DMK flux builders,
  in MAME's exact time (`js/chips/attotime.js`). Things MAME does that we reproduce because they are part of what is
  compared, and which real hardware may not do: a revolution takes 0.20000000298 s (`set_rpm` divides in single
  precision); the cartridge slot delays NMI by 12 and HALT by 6 CPU cycles (`coco.cpp`) through a pool of two
  timers per line, so a change waiting while two newer ones arrive is lost (the Dragon board re-sends NMI on every DRQ
  change, which can swallow a short NMI pulse; our firmware never relies on one); PIA1 CB1 (CART) starts low.
  On the CoCo 3 the same firmware runs from `fdc/boot3.asm` in the 32K ROM, which first sets the GIME's INIT0 to
  $04: $FF40-$FF5F reach the cartridge only while INIT0 bit 2 (SCS) is set (MAME `coco3_state::ff40_read`; CoCo 3
  BASIC sets it), as ours does. The line delays are CPU cycles there too, not GIME clocks (`slotHz`: the slot's own clock, XTAL / 32 on the CoCo 3).
  `--multi` puts the controller in a Multi-Pak's slot 4 (`-ext multi -ext:multi:slot4 <controller>`, slots 1-3
  empty; MAME offers controllers in slot 4 only) and runs `<board>-multi.asm`: the whole diagnostic, then `$FF7F` read
  back, the controller's registers out of reach (reading 00, taking no writes) while SCS selects another slot, NMI (and
  the CoCo's HALT) passing through while it does, and the Dragon's CART (DRQ) reaching PIA1 CB1 only while CTS selects
  slot 4 (that part runs from RAM, its ROM being switched out). In a Multi-Pak the controller's lines go through the
  Multi-Pak's slot (no delay) and then the machine's (NMI 12, HALT 6 cycles), so the re-sent NMI no longer swallows the
  pulse there: MAME takes that NMI, and so do we. This needed one machine-wide time: a timer armed while another
  device's timer runs counts from that timer's exact time (`js/chips/attoclock.js`, `host.attoNow`), as in MAME.
  `--blank <vdk|jvc|dmk>:<T>x<H>` puts a new blank disk (`js/media/disk.js` `blankDisk`, what the drives card's
  New blank disk makes) alone in drive 0 and runs `<board>-format-<T>x<H>.asm`: it reads the blank (sector 1 of
  track 0, sector 18 of the last track and side), then formats every track and side with a write track whose IDs
  carry the track and side and whose data names them, reading sector 18 back and writing the track again if it is
  not there (a write track can end early: track 73 side 1 of 80 × 2 does, in MAME as here), and reads both ends
  back. With `--images` the formatted images must be byte-identical; `--no-trace --images` skips the lockstep for
  the long formats. A MAME that exits with an error (an image it cannot load) fails the run. A blank DMK is
  double-sided only: MAME 0.264 cannot load a single-sided DMK (its `dmk_format::identify` reads byte 4 bit 4 as
  the side count, then rejects a non-zero byte 4 as reserved; later MAME checks from byte 5 and writes 0x10 itself),
  so CLOADM makes none it could not compare.
  `--nmi` (dragon64) runs `fdc/nmi.asm` with `fdc/nmi-boot.asm`, which never loads S at reset: when the 6809 starts
  taking NMI. An NMI edge before S is loaded is lost; EXG with S does not arm NMI, TFR r,S does (as LDS and LEAS),
  as MAME's `m6809.cpp` and `m6809.lst` do. The NMI is the controller's INTRQ, raised and dropped with Force
  Interrupt. **On the HD6309 the first five edges are dropped** (`--nmi --cpu 6309`, on dragon64 and on tanodr64
  through `--fdc tanodragonfdc`): the 6309's TFR and EXG are its own implementation and neither arms NMI (MAME
  `hd6309.lst`, the TFR and EXG handlers), so the firmware's EXG and TFR pulses do nothing there. Its last pulse
  loads S with LDS, which the 6309 does arm on (MAME's 6309 uses the base core's LD16 handler, which sets
  `lds_encountered`, `base6x09.lst`), so one NMI is taken through the 6309's own frame, vector and timing: the
  counts are 0,0,0,0,0,1 against the 6809's 0,0,0,1,2,3. All three runs are identical to MAME 0.264 (the reference;
  the 6309 rows are also identical on 0.289) instruction for instruction: 1,197,190 (dragon64, 6309), 1,204,410
  (tanodr64, 6309) and 1,197,166 (dragon64, 6809), HALT reached in each. The CoCo-family NMI path is not exercised: the CoCo's cartridge NMI arrives through the
  Multi-Pak, which is a separate comparison.

* `node tools/mame-diff/run.js <coco|coco3|dragon64|dragon32> --cart <setup> [--audio]` runs the cartridges
  (`cart/`) with our own firmware as the cartridge ROM (`boot.asm` replaces the BASIC ROMs and jumps to it;
  on the CoCo 3 `boot3.asm` replaces its 32K ROM, first checks that a `$FF40` write does not reach the cartridge
  while the GIME's spare chip select is off (INIT0 bit 2, MAME `spare_chip_select_enabled`), then turns it on;
  `head.asm` copies each
  firmware's code to RAM so it can switch banks and slots): `banked` and `bankedshort` (an RPK with PCB type
  "paged16k", which makes MAME pick `banked_16k`; 128K and 40K images), `gmc` (`-ext gmc`), `orch90` (`-ext orch90`,
  the firmware installed as the Orchestra-90's own ROM) and `multi` (`-ext multi`: a banked cartridge, an
  Orchestra-90, an empty slot and the Games Master with the firmware; on the Dragons, whose Multi-Pak MAME builds
  without a banked board, slot 1 holds a Program Pak). The Dragons run `gmc`, `orch90` and `multi` (MAME 0.264's
  Dragon cartridge list, `dragon_cart_add_basic_devices`, has no banked board). The firmware covers every bank register
  value, the SCS range and the `$FF60-$FF7F` space, writes to the ROM window, every `$FF7F` value with what each
  selection shows and where SCS writes land, the PSG's tone, volume, latch and data bytes, period 0, noise modes and
  the noise register reset, every Orchestra-90 DAC code on one side and fast changes on both, and the CART line
  (tied to Q, or clear for an empty Multi-Pak slot) through the PIA1 CB1 flag and its FIRQ. `--audio` then has MAME
  record the sound with `-wavwrite` and builds the same recording from what our cartridge did: each PSG or DAC write
  with its time, our chip model at MAME's stream rate, and a port of the MAME 0.264 resampler and final mix
  (`cart/audio.js`). One constant in that port was measured, not derived from MAME's source: MAME's recording is
  one output sample later than its resampler alone puts it (found by fitting the Games Master recording; the same
  value serves every setup). Write times are our machine's own exact time under `mameCompat` with no adjustment
  (on the CoCo 3, MAME's CPU clock of 894886 Hz in quarter cycles, from 4 cycles before the first instruction;
  `js/machines/coco3.js` `clockUnits`).
  The tolerance is 2 LSB, for the order in which MAME adds its streams' floats. The first 20 ms (MAME's first
  sound update) are left out: there, some of the Orchestra-90's DAC writes land one 192 kHz sample earlier than the
  model has them (28 samples), and the run reports that count.
  Repeatability: MAME's recording is the same file run after run (12 runs of `coco3 --cart gmc --audio`, from fresh
  and reused work directories and under CPU load: identical WAVs; our side has no randomness). The Games Master has
  no headroom under the tolerance: on the CoCo 3, 750 of its 576,080 compared samples differ by exactly 2 LSB (6,448
  by 1). A run is compared only when MAME ran to the end (its exit status, and a recording at least as long as the
  comparison), and one run at a time per work directory (`<work>.lock`): two runs of the same comparison used to
  overwrite each other's recording.
  It is compared only when MAME built the cartridge it is about: a Lua probe lists the devices in MAME's slot, and
  each setup names the ones it needs (`:ext:gmc:gmc_psg`, `:ext:orch90`, the Multi-Pak's slot 2 Orchestra-90 and
  slot 4 Games Master). A review run that recorded silence (largest difference 17,462 LSB, 78,318 samples over, 0
  with sound) is what MAME records when the image ends up on a Program Pak instead (`:ext:pak`; reproduced by
  dropping `-ext gmc`): that run is now refused with MAME's slot, images, output and arguments instead of compared.
  On the CoCo 3 the Orchestra-90's ROM is compared only at `$C000-$DFFF`: MAME 0.264's GIME maps the cartridge
  through `get_cart_base()` with the default 32K `get_cart_size()`, so above `$DFFF` it reads past the end of the
  8K region, bytes that change from run to run (two runs found 1,190 and 1,199 non-zero bytes in `$E000-$FEFF`).
  The board decodes A0-A12 only (MAME's own `cts_read`, `offset & 0x1fff`, used on the other machines), so ours
  mirrors the 8K there, as on the CoCo 1/2 and the Dragons, where that is compared (`cart/orch90.asm`, `multi.asm`
  read the boot ROM's machine flag at `$BFF0`).
  Two machine behaviours the cartridge comparison brought out, now as in MAME and the hardware: the 6809's `CLR`
  reads its operand before writing (MAME `CLR8` `@read_operand`; the MC6809 data sheet's cycle-by-cycle table), so
  `CLR` of a PIA data register clears its flags; and `$FF60-$FFBF` with nothing there read the floating bus on the
  Dragon and CoCo 1/2 (the byte at `$FFFF`, or the next opcode byte for a no-offset indexed read: MAME's
  `coco.cpp` `floating_bus_read`, after Darren A's measurements), where they used to read `$FF`.
  One caveat on that: MAME's test masks the index postbyte with `$BF`, which makes `,X` and `,U` no-offset but
  leaves `,Y` and `,S` reading `$FFFF`'s byte, while Darren A's description says every no-offset indexed read
  returns the next opcode. CLOADM follows MAME (and the lockstep comparison below), so the `,Y`/`,S` case is
  MAME's behaviour, not a hardware measurement - it is unverified against a real machine.
* `node tools/mame-diff/run.js <profile> --printer` prints every byte value 0-255 and a line of text with firmware
  written for this project (`sam/printer-parallel.asm` for the Dragons, `sam/printer-serial.asm` for the CoCos,
  `mc10/printer.asm`), runs it in lockstep with MAME to HALT, and compares MAME's printer file (`-prin`) with our
  printout byte for byte; both must also be exactly what the firmware sent. Current results: dragon32, dragon64,
  dragon200, dragon200e (3,566,429 instructions identical, HALT at 3,059), tanodr64 **300 bytes identical**; coco, coco2b, coco3 and the clones mx1600, lzcolor64, cd6809 **305 identical**; mc10 **306 identical**; every
  trace identical to HALT.
  * The Dragon prints whenever PIA1 port A is written with PA1 (the strobe) high (MAME `dragon.cpp`), including at
    reset: the PIA's port A becomes inputs, pulled high (`6821pia.cpp` device_reset), so a reset prints PIA0 port B,
    $FF. The Printer box's text leaves such bytes out; the saved file has them.
  * The serial printers sample each bit at its middle, 1.5 to 9.5 bit times after the start edge, as MAME's
    `diserial.cpp` does (`js/machines/serial.js`). Making the line an output while it holds 0 is a start bit:
    the firmware sets the output register before the DDR.
  * `run.js coco --printer --stub-init` runs `sam/printer-stubinit.asm`, which sets PIA1 up exactly as CLOADM's
    no-ROM stub does (`js/machines/sam.js` and `coco3.js` stubInit) before the same print. Before 0.2 the stub made
    PA1 an output with 0 in its output register, then wrote $80: MAME 0.264 and ours both printed one NUL before the
    first byte (306 bytes identical, the extra one a $00), so every program started on the stub had a printout
    beginning with $00. The stub now puts mark in the output register first: **305 bytes identical**, nothing
    before the first byte sent, trace identical to HALT (3,211,861 instructions). `tests/stub-printer.test.js`
    checks the printed bytes of every CoCo-lineage stub, and that the Dragons' stub prints only the reset's byte.
  * `run.js mc10 --printer --stub-init` (and `alice`) runs `mc10/printer-stubinit.asm`, ports set up as the MC-10 and
    Alice stub sets them up (`js/machines/mc10.js` stubInit, port 2's data register before its DDR): **306 bytes
    identical**, nothing before the first byte, trace identical to HALT (3,584,013 instructions compared).
  * `run.js <coco|mc10|alice> --printer --glitch` runs `sam/` or `mc10/printer-glitch.asm`: the printer line dropped
    for a few cycles once it idles at mark, then the print. MAME 0.264's receiver (`diserial.cpp`) has no false-start
    check: any drop is a start bit, and it prints $FF for it; so does CLOADM's (`js/machines/serial.js`), **307 bytes
    identical** on the MC-10 and Alice, 306 on the CoCo (one text byte shorter). The MC-10 firmware first sets port 2
    up DDR first, the order the stub had before 0.2. MAME's m6801 drives port 2 only once its data register has been
    written (`m6801.cpp` `write_port2`: `if (!m_port2_written) return;`, cleared at reset, set by `p2_data_w` and the
    output compare), so that order prints nothing there. CLOADM's 6803 drove the data register's 0 and printed a
    stray byte (its first byte came out $7F instead of $00) until it did the same (`js/cpu/cpu6803.js`, `p2Written`, a
    field in the 6803's state; a 6809 snapshot is unchanged, so `SNAPSHOT_VERSION` does not move). The MC6803's data
    registers are not set by reset, so the hardware's level there is
    undefined; MAME's choice is kept. `tests/stub-printer.test.js` checks CLOADM's bytes against MAME's record.

* `node tools/mame-diff/run.js <profile> --serial` runs `sam/serial-loopback.asm` (`mc10/serial-loopback.asm`) with
  a loopback plug on the bit-banger, in lockstep with MAME's `-rs232 loopback`: the firmware sends 13 bytes as
  8N1 frames and reads every bit back from RXD, and records the port's other inputs (PIA1 port B, the carrier
  detect on CA1; the MC-10's CTS). Current results: coco, coco2b, coco3 (128K and 512K), mx1600, lzcolor64, cd6809, mc10 **identical to
  HALT**, all 13 bytes read back as sent. What the device drives follows MAME's devices: the printer holds RXD,
  DCD and CTS low (`rs232/printer.cpp`); the loopback drives DCD and CTS only from DTR and RTS, which these ports
  lack, so they stay high (`rs232/loopback.cpp`). With the CoCo's PIA1 port B as inputs, PB2 is the RAM size sense
  (PIA0 PB6) and PB1 reads 0 (`coco.cpp` pia1_pb_r).
* On the Dragon 64, 200, 200-E, 64 Plus and Tano, `--serial` runs `sam/acia.asm` on the 6551 with a loopback plug: the registers
  after power-on and after a programmed reset; 20 bytes sent and read back at 1200, 9600 and 19200 baud in 6
  word formats (7 and 8 bits, odd, even, mark and space parity, two stop bits), every poll counted so each status
  change is compared to the cycle; the receive and transmit interrupts taken in CWAI; overrun; a break (framing
  error); DTR off stopping the clock. MAME's plug is its patch box (`-rs232 patch`, set in the run's cfg file:
  RxD from TxD, CTS, DSR and DCD held asserted), because the Dragon 64 does not wire the 6551's RTS and DTR to the
  port, so MAME's plain loopback would leave CTS high and the transmitter off. Current results: dragon64, dragon200,
  dragon200e (1,186,693 instructions, HALT at 24,876), tanodr64 **identical to HALT**, all 20 bytes read back as sent. The chip follows MAME's `mos6551.cpp` state for
  state, including its clock: 1.8432 MHz divided by the rate, in whole Hz, running only while DTR is on or a byte
  is coming in. This run found that CWAI checks for an interrupt after 16 cycles (opcode, mask, two dead cycles
  and 12 pushes; MAME `base6x09.lst`), not 20: no earlier firmware had an interrupt arrive that soon.
  The 64 Plus has the same 6551 and port because MAME's `d64plus()` starts from `dragon64(config)`
  (`src/mame/trs/dragon.cpp`); its run (`d64plus/spec.js` `serial`) is the same firmware on its own ROM files.
* `node tools/mame-diff/drivewire/run-dw.js [profile ...]` runs `drivewire/dw.asm`, a DriveWire client that plays a
  script of transactions over the Becker port and logs every byte the server sends: RESET, INIT, NOP, DWINIT, TIME;
  Read, ReRead, Read Extended (a right and a wrong checksum), ReRead Extended, Write (a wrong checksum, a
  write-protected drive, a drive not mounted, past the end of an image), ReWrite; GetStat and SetStat; named object
  mount and create; printing; virtual serial channels (SERINIT, SERREAD in each of its forms, SERREADM including
  asking for more than is waiting, SERWRITE, FASTWRITE, SERWRITEM, SERSETSTAT with SS.ComSt, SS.Open and SS.Close,
  SERGETSTAT, SERTERM, a channel the host closes); an unknown op code. MAME 0.264 runs it with its Becker port on
  (`coco_dwsock`, set in the run's cfg file), connected over TCP to the same server (`spec.js` sets up its drives,
  named object, clock and channel host); our machine runs it with the server in-process. One MAME run gives two
  comparisons. (1) Instruction lockstep to HALT, every register and cycle count. MAME's TCP link has real latency,
  so left alone its polls would see an answer sooner or later from run to run (a control run without the hold
  below diverges at instruction 52, the first poll). The server therefore writes to a file how many bytes it has
  taken and answered, once the answer is on the socket. `dw.asm` writes SYNC before each status poll, and a Lua
  write tap there holds MAME's CPU until that count covers every byte written to $FF42 (counted by a second tap).
  Every poll then sees what ours sees from its in-process server, which answers at once; this relies on Linux
  delivering loopback TCP data to the receiving socket within the sender's write. (2) The log of 2624 bytes the
  server sent, the five images and named objects it wrote, its printout and the guest's channel bytes, byte for
  byte. Current results: coco, coco2b and the clones mx1600, lzcolor64, cd6809 1,636,422 instructions, coco3
  1,636,346, all **identical to HALT**, and
  every byte identical (`--no-trace` runs the byte comparison alone). That the server follows the
  DriveWire 4 specification is shown by `tests/drivewire.test.js`, whose expected bytes come from the
  specification's tables. That run found that MAME's CoCo 3 passes $FF40-$FF5F through only while the GIME
  enables its spare chip select ($FF90 bit 2, `coco3_m.cpp` ff40_read); we do the same.
  Where the specification leaves a choice, or is not followed literally: the checksum is the 16-bit sum of all 256
  bytes (Appendix B's C listing, `while(--count)`, would leave out the last byte, while every transaction defines it
  as "the 16 bit checksum on the 256 bytes"); write protect answers $F2, OS-9's E$WP (Appendix A lists only $F3-$F6
  but says the codes "mirror the same codes used in OS-9"); a sector past the end of an image reads as zeroes and
  writing one grows the image. Virtual window channels (128-142) are served as the specification defines them:
  they open, read and write through the same transactions as the serial channels, and SERREAD's one-byte and
  count replies use the table's numbers (129-143 and 145-161, which evaluate to the same `channel + 1` and
  `channel + 17` the serial channels use). They are raw byte pipes like the serial channels, because the
  specification gives no window descriptor ("TODO: /Z window descriptor overview" is its own note) and no
  FASTWRITE encoding for them ("- 128 + 32??? see aaw"), so window FASTWRITE is not implemented. Not implemented:
  WireBug, the 230K rate-switch ops ($E6, $FD: a wire bit rate, which a Becker port does not have, and the
  specification gives no layout or reply for them), OP_RFM ($D6: it appears only in Appendix C's op-code table,
  with no transaction described anywhere in the document) and the virtual modem (a channel is a raw byte pipe),
  and the 250 ms transaction timeouts (a Becker port loses no
  bytes, and the machine waits for the store instead). None of this has been tried against a real DriveWire 4
  server or a real CoCo driver (HDB-DOS, NitrOS-9): those need ROMs and software we do not ship.
* The Session's serial API (`session.serial`: subscribers, `flush`, `trace`, `status`; `tests/serial-api.test.js`)
  adds no hardware behaviour, so its oracle is the MAME-verified chips themselves and times worked out by hand: every
  byte 00..FF both ways on the 6551 (an echo guest) and the bit-banger (`docs/examples/serialrx.asm` and a sender),
  byte-exact; each byte to the machine delivered at the end of its stop bit (t0 + 10n bit times); consecutive bytes
  the 6551 receives exactly 10 bit times apart (16 clocks of 1.8432 MHz / 12 a bit, at 9600 baud), and those it sends
  back to back 10 bit times and one clock apart, as MAME's `mos6551.cpp` takes a clock to go from the stop bit to the
  next byte; a late data register read gives exactly one overrun. With a full trace on (register reads included),
  `sam/acia.asm` on the Dragon 64 and `sam/printer-serial.asm` on the CoCo give the same regression hashes as without.
* The Session's disk controller trace (`session.disk`: `trace`, `status`; `tests/disk-trace.test.js`) adds no hardware
  behaviour either: its oracle is the MAME-verified controllers and disks whose bytes are a formula
  (`tools/mame-diff/fdc/images.js`). Small polled readers and writers on the built-in firmware show a full 256-byte
  sector as 256 bytes taken and requested; a 33-cycle byte loop at double density (a byte every 32 us, about 28.6 CPU
  cycles) as lost data with fewer bytes taken; the WD2797's read sector without the `b` flag as 512 requested; a
  missing sector as record not found; a write-protected disk as write protect, on the WD2797, WD2791 and WD1773. With
  a trace on, the floppy diagnostics (`fdc/dragon.asm`, `coco.asm`, `premier.asm`, `alpha.asm`, `coco-multi.asm`,
  `coco-halt.asm`) give the same regression hashes as without, and the trace sees their full 256-byte reads.
* <a id="web-serial"></a>**Web Serial (a real CoCo on a serial cable) is not verified.** `js/host/web-serial.js` serves DriveWire on a
  serial port the browser opens (8N1, 38400-230400 baud), on the same drives as the emulated machine, through a
  second server so the two links do not mix. `tests/web-serial.test.js` and the browser check run it against a
  mocked `navigator.serial` (a port made of web streams): the port is opened at the chosen rate, Reads and Writes
  are answered from and land in the shared images, stop and unplugging close it. Nothing has been run on a real
  cable. To try it: a CoCo with a DriveWire-enabled DOS (HDB-DOS for DriveWire, or NitrOS-9 with the DriveWire
  drivers) on its bit-banger port, a DriveWire serial cable and a USB serial adapter; Chrome or Edge on a desktop;
  open `play/`, add a disk image in Machine settings' DriveWire box and choose it for drive 0, pick the rate the
  CoCo's driver uses, click "Serve a real CoCo…" and choose the adapter; then `DIR` (HDB-DOS) or `dir /x0`
  (NitrOS-9) on the CoCo should list the image.
* `node tools/mame-diff/run.js <profile> --reset` presses the Reset button (`sam/reset.asm`). MAME's Lua presses it
  with `machine:soft_reset()` five frames after the firmware waits in `SYNC`; ours is reset when MAME's trace shows the
  reset, and both elapsed-cycle counts start again there (MAME's own count restarts after a soft reset; when the
  button is pressed is outside the machine, and nothing the firmware does after it depends on when). Its Lua prelude
  zeroes `$0071-$0073` and `$0100-$011F` in MAME before the first instruction, so the power-on read of the warm-start
  flag sees what our zero-filled RAM holds. The firmware follows BASIC's warm-start convention (RSTFLG `$71` = `$55`
  and a NOP at the address in RSTVEC `$72-$73`; as the published Color BASIC and Dragon BASIC disassemblies are
  commonly described, not re-checked against a primary source): the first Reset takes the vector, the second finds
  no NOP there and starts cold, and reads what RAM kept. Every instruction identical to HALT (270, two presses) on
  dragon64, tanodr64, dragon32, dragon200, coco, coco2b and cp400, and with `--cpu 6309` on MAME's dragon64h and
  tanodr64h. It found two differences, both fixed: ours set CC
  to I|F on a Reset, clearing the other flags (MAME sets I and F and leaves the rest), and our CoCo latched
  a new PIA1 CA1 edge from the serial port on a Reset (MAME keeps the PIA's input levels). The regression gate runs
  it on dragon64, tanodr64, coco and dragon64 with the 6309, pressing five frames after each `SYNC`. There is no
  Reset comparison for the CoCo 3 (or the MC-10 and the Alpha): the boot box's "took over Reset" check reads the
  same `$71`-`$73` there, which is not verified against MAME on the CoCo 3.
* `node tools/mame-diff/run.js <profile> --pia1b` reads PIA1 port B's input pins with PIA0 PB6 high, low and an
  input, and port B all inputs, mixed and all outputs (`sam/pia1b-body.asm`). Every Dragon and CoCo wires them as
  MAME's `coco.cpp` `pia1_pb_r` has them: bit 2 senses the RAM size (16K reads it high; with 32K or 64K it follows
  PIA0 PB6), bit 0 is the RS-232 port's received data (the CoCo's bit-banger, whose default printer holds it low;
  the Dragon 64, 200 and Tano's 6551 port, idle high with nothing connected; the Dragon 32 has none, and MAME's
  Alpha has the 6551 but no port: profile field `rs232`), the other pins read 0. Identical to MAME on dragon32,
  dragon64, dragon200, tanodr64, dgnalpha, coco, coco2b, mx1600, lzcolor64, cd6809, cp400 (CoCo hardware, so the
  same wiring), coco3 and coco3p, and on the CoCo at 4K, 16K and 32K (`--ram N`). On the Alpha
  (`alpha/pia1b.asm`) the firmware runs at `$A000` from both ROM banks, since PIA1 PB2 as an output pages between
  them. (The Dragons and the CoCo 1/2 used to read `$FA`.)

## Deviations from MAME

* Playing a `.CAS` file (`js/media/tape.js`): MAME rewrites the file's leaders, making every leader in front of a
  namefile, and in front of the block after one, exactly 128 bytes (a longer one is shortened), adds one $55 to
  every block, and plays a run of $55 bytes between two blocks about four times as long (measured with
  `tape/gaps.asm`: a run of n bytes between blocks gives 4n - 3). A `.CAS` file is the bytes that were on the
  tape; we play them as they are and only make up leaders that are too short for BASIC to find the block, with
  MAME's silences. What a program reads is the same (`tape/cloadm.asm`, above); the comparison of the signal
  checks the silences and shows the runs between them without comparing them.

* The Speech/Sound Pak's speech on the sound path (`js/machines/ssc.js`, `SP_LAG`): each speech sample's level is
  heard from two sample periods after its period starts, about 0.2 ms late. The chip makes a sample when its period
  ends (or, for a status read or an address load, when it starts), up to a PIC instruction after the AY's samples
  for the same moment have been passed on, and the machine's sound path takes levels in time order; two periods on
  is after the card's position whenever a sample is made. MAME's stream holds sample k for its own period. The
  comparison (`ssc/speech-audio.js`) reads our levels at those stamps, so the values are compared exactly; only
  the 0.2 ms differs.

MAME artefacts reproduced only under `config.mameCompat` (the comparisons turn it on; the product does not):

* SP0256 sample rate (`js/chips/sp0256.js`, `SAMPLE_CLOCKS`; `js/machines/ssc.js`, `spGrid`): the hardware makes one
  sample every 312 clocks of its 3.12 MHz crystal, 10 kHz (GI's "SP0250 Applications Manual", June 1982, pin 20
  SYNC: "640ns positive pulse with a duty cycle of 312 clocks"; the 3.12 MHz crystal from the Radio Shack SP0256
  datasheet, catalog 276-1784; CPCWiki's "SP0256 Measured Timings" gives 3.12 MHz / 2 / 156 = 10 kHz, a secondary
  source not read here, its host being network-blocked). MAME 0.264's `sp0256.cpp` divides by `CLOCK_DIVIDER
  (7*6*8)`, 336, with no citation, while its own comment says it generates "~10kHz samples"; as a whole-hertz
  stream that is 9,285 samples a second, counted from each second's start. Under `config.mameCompat` the chip runs
  on MAME's grid; otherwise at 10 kHz.

* SP0256 LRQ and the PIC's scheduler (`js/machines/ssc.js`, `stepCard`): MAME gives a CPU the time to its next timer
  as a whole number of its cycles, rounded down, and does not run it for none, so the speech chip's per-sample timer
  fires before a PIC instruction that would start less than one card cycle earlier. Under `config.mameCompat` an LRQ
  change that close reaches INT1 before the instruction; otherwise after it, at the instruction's end. Measured with
  `ssc/gen-speak.js`: instructions starting 0.06 and 0.88 card cycles before a sample boundary read the INT1 flag set
  on MAME, each moving one address load by a pass of the PIC's polling loop (23 card cycles) until this was modelled.

* Speech/Sound Pak AY sample grid (`js/machines/ssc.js`, `mameAySamples`): on the hardware the AY makes one sample
  per 4 card cycles (its clock is twice the card's, and a sample is 8 of its clocks). MAME keeps device clocks as
  whole hertz, so the Pak is 894,886 Hz (888,625 on the Dragon), the AY 1,789,772 Hz and its stream 1,789,772 / 8 =
  223,721 samples a second, counted from each second's start (`sound.cpp`, `time_to_buffer_index`), where 4 card
  cycles would make 223,721.56. MAME's grid therefore slips about half a sample a second against the card's
  cycles, and a register write near a sample boundary lands one sample later than on the hardware's grid; measured
  with `ssc/gen-ay.js`, that put a tone half a period out of phase after a period change at 1.008 s. Under
  `config.mameCompat` the AY's samples fall on MAME's grid; otherwise on the hardware's (`tests/ssc.test.js`:
  223,721 and 223,722 samples in the first 894,886 card cycles).

* CoCo 3 GIME vertical fine scroll (`$FF9C`): MAME 0.264 never scrolls a GIME-mode row (its top border resets the
  row's line counter on every line, `gime.cpp` `record_border_scanline`, after `new_frame` loaded VSC into it). The
  sources (Sock Master's GIME reference, "FF9C Vertical scroll register - VSC"; Tepolt (1987) pp29-30; above, "CoCo
  3 GIME vertical fine scroll") say VSC below the row height moves the picture up by VSC lines; the machine as shipped
  does that (`js/chips/gime.js` `vscLine`). What no source settles, and how we treat it, MAME-identical in every
  comparison: VSC at or above the row height, rows of one line (`$FF98` LPR 0 and 1) and LPR 7 are not scrolled;
  VSC is latched at the start of the field (MAME's `new_frame`); 1986 and 1987 GIMEs are not told apart. Each of
  these is unverified on real hardware.

* Dragon 64 Plus: MAME 0.264's `$FFE2` write (`d64plus_bank_w()`) sets its two memory banks' entries, but CPU and
  VDG accesses to `$0000-$7FFF` keep reaching the standard RAM: a Lua probe writing each documented value and
  then `$0100` and `$1000` reads back what it wrote every time, while the `:plus_ram` and `:video_ram` shares are
  never written. Compusense's technical notes (above) document working banks, and MAME 0.289 banks as the notes
  say; 0.264 does not. A separate local probe of 0.289's `$FFE2` (16 cases, none differing from
  `js/machines/d64plus.js`) found bits 2-1 select the bank, bit 0 maps the video RAM over `$0000-$07FF` only,
  and the read's bit 0 is 1 outside blanking. Both versions' `d64plus_bank_w()` leave both banks' entries as
  they were for the undocumented `$04`/`$05` (0.264's entries after `$03` then `$04`: plus RAM 1, video RAM 3), and
  so do we under `mameCompat`. Without `mameCompat` the banks reach the CPU (`js/machines/d64plus.js`).

* Dragon 64 Plus, without `mameCompat`: `$FFE2` = `$04` selects the motherboard RAM (`$05` the motherboard RAM
  with the video RAM), where MAME's `d64plus_bank_w()` leaves the banks as they were; and the MC6847 always fetches
  the motherboard RAM, where MAME's driver installs the banks in the SAM's space, through which its VDG fetches
  too. Source: P. Harvey-Smith's traced Eagle schematic of his DragonPlus board (World of Dragon forum, 7 June 2017,
  `viewtopic.php?p=15826`; known drawing errors): bit 2 only XORs Z7 into the extra DRAM's address, and the MC6847
  reads in E = 0. Not verified on hardware. MAME 0.264 still compares (it never applies `$FFE2`, so its outcome is the schematic's:
  `run.js d64plus --paging [--video]`, above); the 0.289 probe above was not re-run, and on `$04`/`$05` and the
  VDG 0.289 is expected to differ from us.

* A cartridge that ties CART to Q (the program pak with auto-start, the banked ROM cartridge, the Games Master, the
  Orchestra-90): MAME toggles the line five times through its slot's timers whenever a PIA1 register is written
  (`cococart.cpp` `twiddle_q_lines`, called from `coco.cpp` `ff20_write` and on the CoCo 3 from
  `coco3_state::ff20_write`, "something that approximates the
  cartridge Q line behavior"). On the hardware CART follows the CPU's Q clock all the time (`coco_pak.cpp`: "normal
  CoCo PAKs tie their CART line to Q - the system clock"); without `mameCompat`
  ours toggles it once per scan line, so PIA1 CB1 (and on the CoCo 3 the GIME's EI0) sees edges continuously
  (`js/machines/sam.js` `lineStart`, `js/machines/coco3.js` `hsRiseEvent`).

* HALT: MAME suspends its 6809 at the scheduler check point where HALT arrives, inside an instruction, and runs the
  rest of the instruction after HALT is released. The MC6809E data sheet (Motorola, HALT pin description) has the
  processor stop at the end of the current instruction, as ours does without `mameCompat` (`js/machines/sam.js`
  `haltChanged`, `js/machines/coco3.js` `fireEvent`, `js/cpu/cpu6809.js` `haltTail`).
* CoCo 3 exact time (the disk drives' clock): MAME's machine time is reckoned in its 6809's cycles (1e18 / 894886
  attoseconds, a GIME clock being a quarter of one at 0.89 MHz) and starts one CPU cycle later than ours; measured with
  a Lua tap on the WD1773's registers (its first status read at 0.272549799639 s, 7 CPU cycles after MAME's CoCo on
  the same firmware). Without `mameCompat` the GIME clock of the real 28.636363 MHz crystal is used
  (`js/machines/coco3.js`).

* m6809 `SYNC` with an interrupt already pending takes 3 cycles in MAME (`base6x09.lst`), 5 in ours: the Motorola
  MC6809 data sheet's instruction table gives SYNC ">= 4" cycles, plus one to release (`js/cpu/cpu6809.js`;
  both paths tested in `tests/cpu.test.js`).

* CoCo 3, a write to the SAM rate bits (`$FFD6`-`$FFD9`) from outside the CPU while the disk controller's HALT holds
  an instruction: MAME 0.264 carries the held instruction on at the new clock once HALT is released. Ours drops it
  (`js/machines/coco3.js` `writeIO`, `haltCancel`): the project's rule for any change from outside while an instruction
  is held (the MC6809E data sheet's HALT description: an outside change meets the CPU between instructions; see
  `haltCancel`), so its halted time is charged at the rate before the write and it runs again from its start, its bus
  accesses before the held one made again, at the new rate. Only the debugger's memory write reaches this (a
  program's own write is made by the instruction in flight, and a tool's poke skips the I/O page), so no firmware can
  observe it and the MAME comparisons do not cover it; `tests/halt-held.test.js` does.
* Dragon 200-E: MAME's driver drives the VDG's INTEXT from two places, from each fetched byte (`sam_read()`, /D7)
  and from PB4 on every PIA1 port B write (`coco12_state::pia1_pb_changed()`, inherited). When they disagree, the
  write is a mode change to MAME's mc6847 and splits the line, so its reads run on past the visible area and, at
  SAM V=1, move the display counter, although nothing on the 200-E's VDG changed. The 200-E's PB4 reaches only the
  character generator (`dragon200e_state::char_rom_r()` in the same driver), so without `mameCompat` a PB write
  that changes no VDG input changes nothing (`js/machines/sam.js` `mameIntextTrack`; both halves tested in
  `tests/models.test.js`, raster case 11).
* MAME's mc6847 records a line lazily: only on a mode change and at the next HS. The part of a line after a change
  is drawn from the last sample's mode, and pixels it never draws keep the previous frame's (`MC6847.endLine`, `keepTail`).
* MC-10: MAME's CPU clock is a whole number of Hz (894887 against the VDG's 3579545 / 4), its 6801 core performs
  accesses at the instruction's start, the HS start is truncated one clock early, and a write before that start
  freezes the rest of the line (`js/machines/mc10.js`).

## NitrOS-9 boot test

What the page's **Boot NitrOS-9** ([using.md](using.md#booting-nitros-9)) rests on. `tests/nitros9.test.js` boots the official NitrOS-9
v3.3.0 Level 2 CoCo 3 DriveWire images (6809 and 6309) with our own boot loader (`js/machines/nitros9.js`, the one the page boots with) in
place of the CoCo 3 ROM and our DriveWire server on the Becker port, types `dir` at the shell, and checks the screen
text against the NitrOS-9 sources that print it and every DriveWire transaction (but TIME) against MAME 0.264 running
the same image, loader and server (`tools/nitros9/boot-mame.js --record`, kept in `tests/fixtures/nitros9/`). The
images are not in this repository: `node tools/nitros9/fetch.js` downloads them from the project's SourceForge
release, pinned by SHA-256, into `$NITROS9_CACHE` (default: the system's temporary folder); without them the test
skips with that reason. Both cases are full boot checks: the 6309 image clears the kernel's system page with
TFM r0,r1+ ($113B), which this branch's core runs correctly, so it reaches the shell like the 6809 one.

The page's path to it, without MAME (nothing in it is hardware behaviour; the machine, loader and server are the
ones compared above):

* `tests/os9.test.js`: the image detection (`js/media/os9.js`) on hand-built OS-9 disks laid out from the NitrOS-9
  definitions (`tools/nitros9/os9-image.js`: `defs/rbf.d`, `defs/os9.d`, no NitrOS-9 bytes): the Becker boot disk, its CPU and
  volume name, and every refusal (not whole sectors, no OS-9 LSN 0, a root that isn't a directory, no boot track, a
  floppy of more than 40 tracks, the bit-banger or another boot device, a headless build), and the floppy layouts that
  boot (35 tracks single-sided, 40 double-sided: the boot track at track 34 of side 0). Then, with the release images
  fetched, all 24 images of both v3.3.0 CoCo 3 archives, each classified as its file name says (the `_becker.dsk` and
  `_40d_1` images boot).
* `tests/nitros9-session.test.js`: `Session.bootNitros9` on hand-built disks (the machine it makes, the loader running
  the boot track, reset and power cycle booting again, Back to BASIC, the CPU switch for a 6309 build, the errors for
  another machine, a missing or wrong image, the `nitros9=` link and its parse errors, Share refusing a NitrOS-9
  snapshot, the embed API's `peek` refusing), then the release images through the Session to the shell and `dir`, at
  512K and 128K.
* `tests/state.test.js`: a snapshot file taken while the loader is part way through a boot-track sector opens in a
  fresh Session with no ROMs (the loader is built in) and runs on identically, instruction for instruction and frame
  for frame.
* `tools/browser-check.js` (`nitros9`): the slot under the screen in Chromium, its errors, a dropped image's offer,
  the link and Share, and the release images booted from the page to the shell with `dir` typed on the keyboard.

### From a floppy

`tests/nitros9.test.js` also boots the v3.3.0 `_40d_1.dsk` images (6809 and 6309) with our floppy loader
(`js/machines/nitros9.js`: restore, seek to track 34, its 18 sectors read with the controller's HALT and NMI as Disk
BASIC's DSKCON reads them, then into $2602) in place of the CoCo 3 ROM and the CoCo disk controller (no ROM) holding
the image in drive 0. It presses Return at `setime`'s prompt and types `dir`, checks the screen against the sources
that print it (`level2/coco3/startup`, `level1/cmds/setime.asm`, the makefile's `$(DSK360K_1)` for the root), and
compares every CPU write to the controller's registers ($FF40-$FF4F, in order) with MAME 0.264 running the same image
and loader (`tools/nitros9/boot-floppy-mame.js --record`, a Lua write tap; `tests/fixtures/nitros9/coco3-*-floppy.json`
hold register numbers and values only): 2,227 writes identical on the 6809, 2,199 on the 6309. The loader itself runs
in lockstep with MAME on a hand-built boot floppy (`run.js coco3 --fdc cocofdc --nitros9 [--cpu 6309]`: 1,110,244
instructions identical in registers and cycles, the boot track's loop reached at 323,191), in the regression gate.

**What this needed: HALT as MAME has it.** The CoCo disk controller holds the CPU with HALT while it waits for each
byte (`coco_fdc.cpp`: HALT = !DRQ while the control latch's bit 7 is set), and the cartridge slot delays the line by 6
of its cycles (`coco.cpp` `set_line_delay`). Two things differed from MAME, and NitrOS-9's floppy booter
(`boot_1773.asm`, a loop of `LDA DATAREG,Y / STA ,X+ / NOP / BRA`) failed on them: LSN 0 read one byte off at 0.89
MHz, every byte read twice at 1.78 MHz.

* HALT that reaches the 6809 inside an instruction suspends MAME's CPU at the next check point; the instruction's
  remaining bus cycles, its read of the data register included, happen after the release. Our 6809 ran the whole
  instruction first and only charged the halted cycles afterwards, so the LDA read the data register before its
  DRQ. Now an I/O access after the stop point waits for the release (`js/machines/coco3.js` `haltWait`): the machine's
  events run on until HALT is released, the rest of the instruction is placed at its real time (`ioShift`) and
  charged from the release as before. This applies in both modes, not only under `mameCompat`: MAME's slot delay
  with a CPU that finishes the instruction first (the MC6809E data sheet's HALT) is neither MAME nor the hardware,
  and is what broke NitrOS-9; MAME's pair is the one compared.
* The slot's clock follows the CPU rate. MAME derives it from the driver's clock (`coco3.cpp`, `DERIVED_CLOCK(1, 1)`),
  and the SAM's speed change sets the driver's clock (`6883sam.cpp` `update_cpu_clock`:
  `m_cpu->owner()->set_unscaled_clock`), so at 1.78 MHz the HALT and NMI delays are 6 and 12 cycles of the fast
  clock. Ours kept XTAL / 32. The SAM machines (CoCo 1/2, Dragons) are unchanged: nothing compared there runs a halted
  transfer at a fast rate.

`tools/mame-diff/fdc/coco-halt.asm` (`run.js coco3 --fdc cocofdc --halt`) reads sectors with three loops, NitrOS-9's,
Disk BASIC's style (HALT enabled straight after the command) and one that polls the first DRQ, at 0.89 and 1.78 MHz:
918,190 instructions identical in registers and cycles, HALT reached at 197,899; in the regression gate. Every N9 and
polled read stores its sector's 256 bytes; a DOS-style read stores 257, the first one stale (the control latch's DRQ
input only follows the WD1773 from its first DRQ, so HALT can't hold the read before it), in MAME and here alike. The
146 hashes recorded before this change are unchanged.

The wait for HALT's release inside an instruction (`js/machines/coco3.js` `haltWait`) goes no further than the run it
is in: the frame, or the slice `runCycles` was given. A read whose DRQ never comes (a read sector on an empty drive)
would otherwise hold the frame forever. Past that point the instruction is suspended (`haltSuspend`): the CPU's
registers go back to its start (`cpu.mark` / `cpu.rewind`), every bus access it made before the held one is kept in
order, address and byte (code fetches, RAM and I/O, reads and writes: `busLogged`), and frames go on with the CPU
halted. That log is kept only while a device that can assert HALT is attached (`logBus`): the CoCo FDC alone drives
the line here, a Multi-Pak answers for its slots, and a device that drives it without declaring `Device.canHalt` is
refused at the first HALT (a machine with nothing else attached logs nothing and runs 4.4% faster by the median of
five paired runs; `tests/coco3-buslog.test.js`). A held instruction keeps its own log, so a snapshot restores with it and a restored
machine whose controller is then taken out still replays it. The log is live: nothing attaches a device inside a step,
so a device attached later needs nothing from before it came (`Machine.devicesAttached`; a cartridge asked to go in
or come out from inside an instruction is refused, as the programmer error it is). A HALT from a source with no log
behind it halts the CPU between instructions rather than suspending one: with nothing logged, a replay would drop
the instruction and make its accesses twice (`fireEvent`). In shipped code the only such source is a non-device one,
a test hook - the slot's line timer is the only event that asserts HALT, and a device's own assertion either carries
the log or is refused first - and that path also skips the mid-instruction cycle accounting (`haltArrived`'s
`haltS`/`haltK`/`haltN`, and the `haltTail` `haltReleased` would charge). A
snapshot loaded over a machine with a different cartridge announces the port's new state either way, so the log
follows the file (`Machine.loadState`). When HALT is released the instruction runs again from its start (`cpu.rerun`: no interrupt taken first, not
traced twice) with those accesses replayed, not made again: each read returns the byte it returned then, each write
is not repeated (`replayRead`, `replayWrite`), so the bytes it reads are the ones it read, not memory as it has itself
changed it since (a 6309 TFM whose source overlaps its destination), and an I/O write that remapped memory (the MMU)
doesn't change what it fetched. The held access is made at the release, so it ends where the uninterrupted wait would have. The suspended instruction is in the snapshot
(`haltDefer`, snapshot version 2). `tests/fdc.test.js`: on an empty drive, in both timing models, frames keep
completing with the CPU halted inside the LDA, and a disk put in the drive (the sector's bytes read) or a Force
Interrupt (the loop runs on) releases it; a release by DRQ 11 frames later gives the same trace, the same data and the
same data-register accesses run as one slice, as frames and as 37-tick slices, for the LDA and for an INC of the data
register (its read replayed), and for the HD6309 in native mode (`LDA $FF4B,Y`, whose post byte's native saving is
added as the instruction goes; `cpu.mark` keeps those savings too); taking the controller out after 600 suspended
frames releases the CPU where the time has got to, and the next frame is one frame long. A long wait's halted cycles
(`cpu.haltTail`) are charged at once up to the next event, not one step each. `tests/state-carts.test.js`: snapshots taken
while suspended (6809, and 6309 native), restored into a fresh machine, run on identically (trace, frames). The MAME runs above are unchanged by it. MAME holds the CPU the same way:
`tools/mame-diff/fdc/coco-halt-empty.asm` (`run.js coco3 --fdc cocofdc --halt --empty`) reads a sector on drive 0, then
issues a read on drive 2, which has no disk, in Disk BASIC's order: 2,506 instructions identical in registers and
cycles, MAME's trace stops inside the LDA of the data register (`EMPTY`) and so does ours, which then runs no
instruction for the rest of MAME's 4 seconds, its CPU still held; in the regression gate. (The disk going in after a longer wait,
120 frames, ends that read with Record Not Found: the controller's own handling of a disk arriving mid-command, not
HALT, and not compared with MAME.)

The replay is checked as it goes: each access must be at the logged address (a write of the logged byte), and the
first one past the log must be an I/O access in the bus cycle the held one was in. Only a snapshot whose log doesn't
belong to its instruction fails that; the instruction is then dropped (`replayDropped`, as for a redirect below),
before any access reaches the bus. `tests/halt-replay.test.js`: a 6309 TFM held on an empty drive for three frames, in
its four forms (`r0+,r1+` with 17 and 65 bytes, `r0-,r1-` through the vectors into the I/O page, `r0+,r1`, `r0,r1+`),
ends with the memory and registers of the same program with HALT disabled in the drive select latch, and for the two
forms that move both pointers with the bytes derived from the TFM's definition (the build before this change copied
the bytes it had itself written); a malformed `haltDefer.log` or `.mem` in a snapshot is refused with a message, and so are times out of range
(`haltDeferTimes`: the start after the machine's time or not a whole tick, the held access far past its log or before
it, the stop point, the release, the speed change; they would put the machine's time or the CPU's count far off); a
well-formed log that doesn't match the instruction (an address, a written byte, one access too few or too many, the
held access in another cycle, every access logged so that the replay completes it) is dropped when it runs again,
with the CPU's cycle count keeping up with the time as in any drop, then the TFM runs afresh to the right bytes. Between runs
no instruction is under way, so the CPU's cycle count is 0 (`haltPark`, and on a restore): an access from outside
while it is held (the debugger's memory view) is timed at the machine's time, not hundreds of cycles ahead at the held
access's, and a restored machine releases it on the same cycle as the one saved; a TFM held with the debugger writing
I/O after every slice gives snapshots that all load, and a held `PSHU` that changed the speed ends identically after
one and three save-and-restore round trips.

A WRITE from outside made while the suspended instruction's events run (between runs, `heldIo`) is queued and made
between instructions, at the machine's own time (`HaltReplay.outsideWrite`, `flushOutsideWrites`): the same write
made while parked, with `$FFD9` (measured in `tests/held-writeio.test.js`), charged 34,724 CPU cycles over the
frame at commit 570d3fc, before this change; made one tick inside the window it charged 4,856, because the rate-write path took its
`!inStep` branch and dropped the suspended instruction from inside its own event. Now the two charge the same
number, and leave the machine at the same cycle, trace, registers and time (`tests/held-writeio.test.js`: the held
instruction stays, the write lands once in order, the parked machine and the run after it are identical either way).
The queue is in the snapshot, as `outsideWrites` (snapshot version 3; a version 1 or 2 file has none and restores
owing none), is made by a run that throws out of the window, and a reset drops it (a reset drops
every access made while an instruction was held, and the same write made while parked is wiped by one too). Only an
event handler is ever in the window (it is open only inside the machine's own event run); a UI POKE or a
debugger-panel write arrives between frames, and while a queue is still waiting it joins that queue instead.
`poke` (no bus cycle) is not queued unless a queued write is still waiting, which it follows, so the later call's
value is final. A read is not deferred: it is serviced in the window at the held access's time, with its device
side effects there - a status or data read clears the FDC's INTRQ/DRQ, and a read that releases HALT is what a
halted loop waits for. The flush makes a queued write through `busWrite`, below the debugger's wrapper and `write()`'s
queueing branch, so no watchpoint fires for a write the debugger made. The entry being made stays at the head of the
queue until it has landed, so a write an event handler makes during it (its I/O sync pumps events) queues behind it,
the last entry included; a flushed write that stalls the machine ends the run before any instruction runs. A
snapshot whose queue holds a poke at `$FF00` or above is refused, as `poke` itself refuses the I/O page. A
queued poke's return value (whether the CPU will see the byte) is worked out when `poke` is called, under the mapping
at that time; an MMU or ROM-mode write queued ahead of it can change the mapping before it lands, so the answer can
be stale. The byte itself is placed under the mapping the earlier queued writes leave, in order. Making the answer
exact would need `poke` to wait for the queue, which is outside this change.

The CPU redirected from outside while an instruction is suspended (`Machine.jump`, `injectAndRun` with a start
address, the debugger setting a register to a new value, any other write to the CPU's registers, a write to memory
the instruction had fetched, read or written before its held access, a snapshot taken after such a write) drops the
suspended instruction (`haltCancel`): the CPU is then between instructions with the state it was given, runs nothing
while HALT is asserted, and runs from that state once HALT is released. The rule is the MC6809E data sheet's (Motorola, signal
descriptions, HALT: the processor halts "at the end of the present instruction" and stays halted "without loss of
data"; the page is not cited: no copy of the data sheet could be reached from the environment this was written in,
and the two phrases are the ones this project already cited), so an outside change can only meet it between instructions, and our suspended instruction
has changed no register yet. The bus accesses it made before its held one stay made (the debugger reports none of
them, not even a RAM write a watchpoint covers: it reports an instruction's accesses when it completes, and this one
never does; `cpu.trace`, called as an instruction starts, has it once). Every path is caught by one
check (`cpuCheck`): the registers the instruction was suspended with (`cpu.mark`) and the bytes below the I/O page of
every bus access it made (its log, not its idle cycles, which present an address and read nothing;
in the snapshot as `haltDefer.mem`) are kept and compared before it runs again, before the debugger checks a
breakpoint and before a snapshot is saved (the bytes come from the access log, which grows with the instruction: a
6309 TFM's are all there however long it is, `tests/halt-replay.test.js`; the CPU's cycle log grows the same way,
`cpu.reserveLog`); `Machine.cpuRedirected` drops it at once for a jump and the debugger. A
write that changes nothing (a register set to its value, memory it didn't use) keeps it. The CPU's cycle count gets
the time it was halted, as a kept instruction's `haltTail` gives it: after a speed change the instruction made before
its held access, at the old rate up to that write and the new rate after it (as `clockChanged` places it). Not covered: a dropped instruction that had
changed the CPU speed sets the new clock division but not MAME's slice adjustment (`clockChanged`, `mameCompat`), and
no MAME run drops an instruction. MAME
0.264's debugger, writing PC, only sets `m_pc` (`m6809.cpp` `state_import`): its 6809 goes on through the rest of the
old instruction's microcode from the new address, an emulator artefact with no hardware counterpart, not
reproduced. `tests/halt-held.test.js`: an INC of the data register held on an empty drive, the CPU sent to
`LDA $FF03` by a write to PC, `Machine.jump`, the debugger and `injectAndRun`, and by a snapshot taken after the write
(which holds no suspended instruction), and by the LDA written over the INC's code (debugger, `poke`): nothing runs
until a Force Interrupt releases HALT, then the LDA reads PIA0 itself and the INC's write never happens (6809 in both
timing models, and 6309); with A set instead, the INC runs from its start and reads the data register again; a write
elsewhere or PC set to its own value keeps the INC, which completes with its read replayed; a breakpoint on the INC,
which is then dropped by a direct register write or a jump to its own address, stops before it runs again; an
`INC ,X`'s idle-cycle byte written keeps it (the run is the unwritten run); after a snapshot round trip, a change to
an `INC [,X]`'s pointer drops it and a change past its code keeps it, as without the round trip, with the same trace;
a dropped instruction's CPU cycles keep up with the machine's time, also one that slowed the CPU (`STD ,X` on
`$FFD8`) before its held access; a snapshot loaded over a suspended instruction
runs on as its source.

Under the debugger a suspended step is not an instruction (`js/debugger.js`): no trace entry, no step counted, no
watchpoint hit until the instruction completes; the breakpoint check is made once, at its start, and never while it
is held (also after a snapshot is loaded, or with a debugger first made while it is held). A command that must
return waits for a halted CPU a frame (a single step) or two seconds (step over, run to return, run to an address:
longer than a sector not found, which a WD279x ends after 5 index pulses, 1 s) and
then stops with kind `halted`, the PC unchanged; Run goes on frame by frame. `tests/halt-held.test.js`, compared with
the CPU's own trace and a free run, both timing models: 40 single steps across a held LDA equal 40 traced
instructions with the free run's registers and cycles, each step taken while held stops `halted` after one frame
with no trace entry; a breakpoint on the held LDA stops once per execution, at the traced registers; Run on an empty
drive goes 100 frames without a stop or a counted step (breakpoint elsewhere, or on the held LDA after its one stop,
also after a snapshot round trip or with the debugger made while it is held);
a read watchpoint on a held `INC $FF4B` stops once per read the controller saw, with its value; run to return on an
empty drive stops `halted` after two seconds with no instruction counted, and with the disk returns having counted the
traced instructions; a run to an address counts completed instructions only. Unchanged by this: the debugger counts
an interrupt's entry, and each cycle of a CWAI or SYNC wait, as a step, as it always has.

Found and not fixed: at power-on the WD1773 starts a restore on its own (`wd_fdc.cpp` `mr_w`); with NMI enabled, its
INTRQ reaches our CPU about 8 cycles later than MAME's. The diagnostics and both NitrOS-9 boots send Force Interrupt
first (as `boot_1773.asm`'s HWInit does), so nothing compared depends on it.

## The games (2048 and Minesweeper)

Programs of our own, not hardware behaviour: they use the VDG's 128x192 four-colour mode (CG6), the SAM's display
registers, the DAC and the firmware's POLCAT, all already compared with MAME (the `--video` comparisons cover CG6,
the welcome tune the DAC path). The oracle is the games' rules and their documented random numbers, written
independently in `tests/games.test.js`:

* 2048: a model of the slide-and-join rule and of the new tile (the 16-bit Galois LFSR with taps $B400, eight steps a
  byte, rejection sampling for the square and the one-in-ten 4) plays 60 scripted moves from a fixed seed, and the
  board and BCD score in memory match after every move; joins happen once per move; a move that changes nothing brings
  no tile; a full board with only a vertical join left is not over; a stuck board is over (both checked on the model
  first); 2048 is announced once and play goes on; the same game on the Dragon 32, CoCo, CoCo 3 and 6309.
* 2048's animation, `tests/games-slide.test.js` (16 checks), at the field clock the tests read (the ENTROPY byte, which
  every field of the slide AND of the pop ticks once - both take a VSYNC, which the key wait does not; the pop is also
  sampled per frame so its own fields can be seen): a tile travelling three squares is drawn in each square it passes
  over, so a row's ink takes more than two shapes over the fields; the joined tile is drawn for exactly one field in the
  `$AA`/`$55` fill that no tile
  style has, between its own looks (read from the box's dominant even-row and odd-row bytes); a new tile is SMALL
  (the pop's 4x20 = 80 inked bytes) for frames after an empty slot, then FULL (6x34 = 204), both sizes derived from
  the geometry; a tile mid-slide carries the mover's OWN value, not a merged one (a 4's `$FF` body on the columns it
  crosses, and a joining tile - a 2 crossing three squares to join a 2, a 4 to join a 4 - showing what it WAS, `$55`
  or `$FF`, never the `$FF` or `$77` of the value the join makes); the board in memory is the move's rule state with
  exactly one tile added, unchanged by how it was drawn; a key pressed mid-slide ends it at once (no intermediate
  shape after it) and is played as the next move, which puts the tile where that key sends it; a key during the
  POP ends it at once too, and keys pressed during one animation are queued four deep and all played, in order
  (the queue's depth and oldest-first order are checked directly, and on a CoCo 3 whose RAM is garbage at
  power-on); nothing is left behind (a square a mover has left shows no ink on that field); the flash lasts one
  field, measured in machine cycles against the machine's own `frameCycles` (`d/F = 0.999` on a 50 Hz Dragon and a
  60 Hz CoCo); and the order is slide, then flash, then pop.

  **Every mutant, with its exact edit and what it was measured to redden.** Every row was measured in a separate
  worktree at `b985014`. The rows depend only on `tests/` and `examples/`, and those are the same at `b985014` as at
  this commit (`git diff b985014 HEAD -- tests examples` is empty): every later commit edits this file alone.
  To reproduce one: apply the edit,
  `node tools/build-examples.js`, then `node tests/games-slide.test.js` and `node tests/games.test.js`.
  "slide N" = N of the 16 checks in `tests/games-slide.test.js` fail; "game N" = N of the 151 in
  `tests/games.test.js`.

  | The mutant | The edit | Measured at b985014 |
  |---|---|---|
  | no `SLIDE` | `GLSLIDE`: `JSR SLIDE` -> `NOP` | slide 9, game 0: crossed squares, merged-tile flash, order, one-field flash, mover values (h, i, k), flash duration, nothing left behind. (On (p) this fails only because the slide never runs, so there are no movers: (p) is not catching a trail here.) |
  | vertical step | in `SPOS`, delete the two `LSLA` after `LDA MSTEP` (a column step of 1, not 4) | slide 1: crossed squares |
  | skip a middle square | the second `SPSTEP` line (`FCB 1,1,2`) becomes `FCB 1,2,3` | slide 1: crossed squares |
  | a vanished tile | `SLPASS` becomes two passes. First pass: for each mover, `JSR SPOS`; `BEQ` past a mover that did not move this field, otherwise empty its `MPREV`. Second pass: for each mover, `JSR SPOS`; `BEQ` past one that did not move, otherwise draw `MTMP`. (Both passes skip unmoved movers; the blanking is unconditional for movers that did move.) | slide 1: every mover on its square (k) |
  | flash on wrong squares | in FLASH's paint loop, the `LDB B,X` commented "in B for SQPOS" becomes `LDA B,X` (NOT the restore loop's `LDB B,X`, commented "in B for DRAWSQ") | slide 1: the flash field |
  | only the first join flashes | after the first `JSR BOX`, `LBRA FLTICK` | slide 1: the flash field |
  | a field between the boxes | the paint loop has one `JSR BOX`; put `JSR SLFIELD` right after it, before `INC MI` | slide 2: the flash field, flash duration |
  | a field before the restore | the first instruction under `FLGO` becomes `JSR SLFIELD`, before the `LDA #1` that is there | slide 2: the flash field, flash duration |
  | a VSYNC before the restore | the first instruction under `FLGO` becomes `JSR VSYNC`, before the `LDA #1` that is there | slide 1: flash duration (d/F = 1.995) |
  | the pop never small | `SPPUT`: `LDA #1 / STA POP` -> `CLR POP` | slide 3: order, pop sizes, pop is cuttable |
  | the pop drawn full size | the pop box `#TILEW`/`#TILEH` instead of `-2`/`-14` | slide 3 (cut, order, pop sizes), game 1 (the board picture) |
  | the pop never cuttable | replace `SPWAIT`'s `LDA #3` with `LDB #3`, and the body `PSHS A / JSR SLFIELD / LDA KQN / PULS A / BNE SPDONE / DECA / BNE SPWAIT` with `JSR VSYNC / DECB / BNE SPWAIT` (three bare VSYNCs) | slide 2: order, pop is cuttable |
  | R drops the queue | in NEWGAME, immediately after `CLR WONSEEN` (before the `CLR SKIPPED` there), insert `CLR KQN` | slide 1: keys queued behind R |
  | queue depth 1 | `CMPB #4` -> `CMPB #1` in KQPUSH | slide 2 (keys behind R, queue depth), game 1 (the board picture) |
  | a broken queue shift | in KQPOP, `LDA 1,X` -> `LDA ,X` | slide 2 (keys behind R, queue depth), game 1 (the board picture) |
  | the queue not cleared at START | remove `CLR KQN` from START | slide 1: queue depth (the CoCo 3 leg) |
  | a joining tile reads the board | in `SPOS`, replace `LDB MI / LDX #MVF / LDA B,X` with `LDA MTO / LDX #BOARD / LDA A,X` | slide 2: joining tile, every mover on its square |
  | every mover drawn as a 2 | in `SPTILE`, `LDA MV` -> `LDA #1` | slide 3: mover values (h), joining tile (i), every mover on its square (k) |
  | two new tiles | a second `JSR SPAWN` after `GLDONE` | slide 3 (rule state, key mid-slide, pop is cuttable), game 6 |
  | a 2 drawn as a 4 | in `DRAWSQ`, after `LDA B,X`: `CMPA #1 / BNE DQ0 / LDA #2` and a new label `DQ0` before `JSR TILEAT` | slide 1 (the cut check), game 1 (the board picture) |
  | no flash at all | `JSR FLASH` -> `NOP` | slide 3: order, the flash field, flash duration |
  | a trail of copies | in SLPASS's clear pass, `LDB SPKEEP / JSR SPEMPTY` becomes `LDB SPKEEP / NOP / NOP / NOP` (a vacated square is never emptied; three NOPs keep the code size) | slide 1: nothing is left behind (a square with no mover on it keeps 204 bytes of ink) |

  **Two product defects were found in review and fixed, each now checked:** a tile could vanish for a whole field - a
  mover that stayed put was not redrawn after another mover blanked its square - so the per-field draw now draws every
  mover and empties a square only when no mover is on it, and the check requires, per field, each mover's own body on
  the square the model puts it. And the pop could
  not be cut - its three fields ran blind - so each pop field now takes a VSYNC, an ENTROPY tick and a POLCAT poll like
  the slide's, and a check presses a key during the pop and requires the move applied within one field. A third: the
  slide read a mover's value off the post-move board, so a tile that merged slid in already showing the merged value;
  the per-mover `MVF` table (filled from the row before it is packed) fixes it, and the joining-tile check turns red
  when the slide reads the board again. A fourth: the flash loaded the join square into the wrong register, so squares
  0..MRGN-1 always flashed; the check above names it.
  **A part-painted frame is expected:** a tile is drawn one square at a time and a field's draw takes part of a frame,
  so a single frame can show a tile partly painted; the next field completes it. It is not a wrong value or a missing
  tile (that is the defect above, checked), and the checks read the body byte of the rows already drawn.
* Minesweeper: over 40 seeds the first square is safe with no mine next to it, ten mines, every count right, and the
  flood opens exactly what the rules open; flags (at most ten, not on open squares, a flagged square does not open);
  a scripted win and a loss; the stack stays within 32 bytes of $3000 over a whole game (a queue, never recursion); a
  flagged blank square inside the first square's area stays flagged and the flood goes round it, against the model's
  flood with that square left out (the mines laid by the model from the same random numbers).
* Leaving: BREAK on either title page goes to `DONE` in text mode with the SAM's M back to what the Session recorded
  (0 on the built-in firmware, 2 while the game ran). With BASIC: a stand-in BASIC written for the test (it sets the
  SAM as BASIC does, prints OK and COLD or WARM from BASIC's warm-start flag at `$0071`, and its POLCAT reads SPACE
  and BREAK from the matrix; no ROM code) boots, the reset button gives WARM (the control), 2048 runs on it reading
  keys through its POLCAT, and BREAK brings it back started cold (OK COLD, M = 10, its idle loop): the game has drawn
  over BASIC's program area, so a warm start would trust garbage. Without the flag cleared the check fails. Under 32K (4K and 16K CoCos) the Session, the command line (exit 3) and a link refuse, saying why.
* Text drawn in the bitmap is read back through the font in `examples/games.inc`; the screens also match reference
  PNGs in `tests/fixtures/games` through `--expect-screenshot` (made by the same commands and looked at), and
  Minesweeper's sounds a reference WAV through `--wav`, whose bursts (click, ticks, buzz, chirps, explosion) are
  checked from the samples; the flag's notes are measured on the DAC against the delay loop's 5*D+22 cycles.
* The browser check (`visit`, `url`) opens both from the welcome menu's games menu, presses keys, sees the frame
  change, leaves with BREAK (Esc) back to the menu, and opens them with `?start=`; the MC-10 refuses them.
* Ten deliberate breakages of the rules (a joined tile joining again, the 4's odds, the vertical-join test, the win
  value, mines next to the first square, the flood, the win count, the flag limit, the mines shown on a loss, the
  games menu's keys) each turn `tests/games.test.js` or `tests/welcome.test.js` red, and so do five more: the flood
  opening flagged squares (testing OPEN only), the title page ignoring BREAK, the SAM's M not put back, no reset at
  `DONE` with ROMs, and no RAM check.
* Where a game's image and variables may reach: both games REFUSE a 16K machine (`GAMES.ram = 32`, and `checkGame`
  refuses), so the 16K bound (`$4000`) does not apply to them. `tests/games.test.js` holds them instead to their real
  bound, the 32K machine's RAM top and ROM base: image and variables below `$8000`. It also records every display
  base the SAM's F register is set to across the scripted game (`displayBase = F6..F0 * 512`,
  `js/chips/sam6883.js:101`) and requires the pages shown to be exactly `$0400` while the image and the variables stay
  clear of each page's 6K. Three deliberate breakages each turn it red by name: an image crossing `$8000`, a variable
  placed at the stack's floor (`$2FDF`), and a second page shown over the image (`$3000`).

### The analogue joystick in Minesweeper

The joystick is read through the machines' analogue comparator (PIA0 PA7 against the PIA1 DAC) and timed by the
field flag, so the tests work at the level that matters to a player: what the game's own state does after so many
fields.

* **The comparator's boundary, not a point.** `joy >= dac` sets PA7, checked either side of the comparator's own
  level at both DAC tests the game makes (40 and 24), on both axes of both ports, and with CA2 and CB2 each
  selected to prove the axis and the port that is not selected does not answer for it.
* **The steps, in fields.** A held stick steps on the field it leaves the centre, then 300 ms later and every
  120 ms: measured as fields 1, 16, 22, 28, 34, 40, 46 at 50 Hz and 1, 19, 26, 33, 40, 47, 54 at 60 Hz (the second
  step is 15 fields after the first at 50 Hz, 18 at 60; the repeat is 6 and 7). The wait is counted in fields, so
  each machine's own field length is what turns 300 ms and 120 ms into the 15/6 and 18/7 waits; the two lists are
  the measured result, not one table. Centring the stick and pushing the same way again is a new press (one step,
  then the 300 ms wait) - the bug the test exists for was a re-push that took 256 fields.
* **The dead zone.** 24 to 39 on the machine's axis moves nothing; 23 and 40 do.
* **Fire.** A press of exactly 400 ms flags on its own last field (20 fields at 50 Hz, 24 at 60), one field less
  opens on the release, and a half-second press after a win or a loss restarts the game without opening a square
  (the restart is on the release). The boundary is measured on `IN`, the action the field itself decided. Measured
  on the merged build: the flag's PIXELS are drawn in that same field (the square's glyph bytes change while
  `STATE` is still 0), and the `STATE` variable follows one field later, so the screen shows the flag when the
  press is decided and only the bookkeeping trails.
* **The phantom filter.** A key in the matrix rows fire's own column pulls down is ignored while fire is down, on
  every family (Dragon, CoCo, CoCo 3 PAL, Tano) with 'F' - the one game key those rows hold on a CoCo - and each
  with a control showing 'F' does flag with fire up. The table itself is checked to hold both families' rows: no
  Dragon row key is one the game acts on, so only the CoCo half can be shown to matter.
* **No buzz.** A 2 s recording with the stick idle has no 50 or 60 Hz line: the DAC rests at 0, so the mute around
  each field's read (PIA1 CB2 low) steps between two zero levels.
* **The silence level, measured.** The DAC rests at **0**, not at mid (32). With a joystick read once a field, a
  0-to-32 step every field measured as a 2.3e-2 line at the field rate, against 3.8e-4 for anything else; at 0 the
  same recording measures 0.00e+0 at both rates. This is our choice of silence level, not a deviation from MAME (the
  DAC level is the program's). The game's sounds are unaffected in kind, order or pitch.
* **Mutation evidence, as deltas over a green baseline** (a copy of the tree, one change, rebuilt, only added
  failures counted): the taps and the hold swapped, no repeat, the comparator's thresholds moved to 16/47, the mute
  left on, silence back at 32, the key's own axis swapped, the first diagonal taken as the y axis; the direction
  kept across the centre, the fire count starting at 0, the phantom table cut to the Dragon's rows and cut to the
  CoCo's, the restart on the press, the burst predicate without its floor, and the fire release mark never cleared
  (a loss by fire then restarts on the next field, so the loss is never seen).

## The side-panel connector (claude.ai)

Not hardware behaviour, so MAME is not its oracle (AGENTS.md section 4.6). The emulator in the view is the same
`js/`; what is new is the connector around it, checked against the MCP Apps specification (ext-apps
`specification/2026-01-26/apps.mdx`) and the local MCP server:

* the folded emulator of the self-contained view runs LIZA identically to the plain modules: screen, frame count and
  every pixel (`tests/connector.test.js`);
* the panel's tools are the local server's, name, schema and annotations byte for byte, with the file tools left out;
  results keep the `untrusted` wrapping; over 100,000 characters is `too-long`;
* the bridge's protocol, in a vm and in Chromium: `ui/initialize` before the emulator's module runs, `tools/list`
  answered at once, `notifications/tools/list_changed` when the emulator is ready, early calls held, a failed start
  `not-started`, a different `PANEL_API` `out-of-step`;
* both views nested as Claude nests them (host → sandbox proxy → `srcdoc` view, `allow-scripts allow-same-origin
  allow-forms`) under the CSP the specification builds from the declared `_meta.ui.csp`, with and without CORS on the
  site: typing into LIZA, a game and its screenshot, real keys, storage, ROMs kept in the view's storage and memory
  reads that include the ROM areas while they run (the browser check's `connector` group, `tools/connector-check.js`).
* the view's own controls, in Chromium (the same group): inline, with the host sizing the view from its content, the
  screen 4:3 at the full width and the height stable (no resize loop); in the side panel (a fixed height) the screen
  filling the limiting dimension within 16 px at 400, 600 and 900 px wide and at 900 x 560, the toolbar one row;
  Details closed at first and opening to every diagnostic; an error to act on (not started, out of step) on the status
  line; ⋯'s **Open in side panel** only inline with fullscreen offered, and the host's new context after the request;
  every Programs and Machine item, Programs per machine (a 6803 machine's own builds); the menus from the keyboard;
  the sound switch; Claude's chip on an acting call (its colour, its keys as they reach the machine, one announcement,
  gone within 3 s, the action line kept), the quiet chip on a read, and none for the person's own keys, also during
  Claude's call. The screen's size and the chip's words are unit-tested in Node (`tests/connector.test.js`). How the
  view looks is reviewed on the screenshots (`--screenshots`).
* on a phone, in Chromium with touch (the same group): inline, `ui/notifications/size-changed` carries the content's
  height at 320, 390 and 600 px wide, equal to the body's laid-out height, sent again when the width changes and not
  again once an auto-sizing host has taken it, and never in the side panel or fullscreen; at 390 x 844 fullscreen the
  toolbar and the screen start below the host's `safeAreaInsets` (or below the 56 px top reserve when the host gives
  none), the keys and the status line end above the bottom inset, also at 390 x 640; the on-screen keys show on a touch
  screen and not on a desktop, a tap on H, I, ENTER reaches LIZA (`screen_text` through the host), sticky SHIFT for one
  key; Keys | Pad | Stick with exactly one BREAK showing in each, in the bottom row, and no Stick on the MC-10; each
  program's own mode (2048 the Pad, Minesweeper the Pad with F, LIZA the Keys) and the Pad's arrows moving 2048's
  tiles (the frame changes); the choice kept per program across a reload of the view, and with a storage that throws
  kept for the view's life without an error and back to the program's mode after a reload; a host that asks before each call: an approved call answered after the wait, a denied one
  leaving the next working. The insets, the touch test, the content height and the keys' codes are unit-tested in Node.
  How the view feels on a real phone (the app's title chip, the soft keyboard it no longer needs, its approval prompts)
  is a manual test ([deploy-connector.md](deploy-connector.md), "On a phone").

What only claude.ai can show (its side panel, its approval prompts, what it grants a custom connector) is a manual
test: [deploy-connector.md](deploy-connector.md), "Verify".

## The HD6309 running the 6809 builds

Not hardware behaviour: the 6309 core is compared with MAME per instruction already ([cpu6309.md](cpu6309.md)); this
is the page's and Session's choice of *which* build to run. The 6309 executes every 6809 instruction in emulation mode
(where a reset leaves it), so the welcome menu, LIZA, the colour demo and the Claude chat firmware are the 6809
builds on it too. The oracle is parity: the same bytes on a 6309 and on a 6809 must end in the same CPU state and the
same screen.

* `tests/cpu6309-session.test.js`: on every model with a 6309 option (`dragon64`, `tanodr64`, `coco`, `coco3`; the
  CoCo 2B has no CPU option, so a case there would resolve to 6809 and prove nothing) the Session's `welcomeFile`,
  `lizaFile`, `lizaNeeds`, `carryOn`, `startWelcome`, `startLiza` and `startChat` behave as on the 6809; each build
  (welcome, LIZA, demo, chat firmware) ends in the same CPU state and screen on the 6309 as on the 6809; a 4K MC-10 and
  its 6803 rules are unchanged; and the 6309 choice survives a visit. It fails 62 checks on the commit before the fix,
  so it is not vacuous.
* `tools/browser-check.js` (`cpu6309`, in the full run): `?machine=dragon64&cpu=6309` opens on the menu with no error
  toast and no `undefined` (the bug's `examples/undefined: HTTP 404`), key 1 runs LIZA without leaving the 6309, BYE
  returns to the menu, key 2 runs the demo (sampling its program counter and the 6309 trap bit), key 4 opens the chat
  on the 6309, a new visit with no query parameters keeps the choice from storage, and Machine settings' CPU row
  switches a CoCo 1/2 to the 6309 into its menu.

## SAM CPU rate (the speed POKEs)

What the MC6883 data sheet says, and what we do (Motorola, Advance Information; pages of the 25-page scan):

* **Rate 00** (p. 11): every cycle is crystal / 16, as before.
* **Rate 01, address-dependent** (p. 11): crystal / 16 for `$0000-$7FFF` and `$FF00-$FF1F`, and crystal / 8 for
  everything else, including the `$FFFF` of internal cycles. The 6809 now reports every bus cycle with its address
  (`js/cpu/cpu6809.js`; the addresses follow hoglet67's captures of a real 6809, as in XRoar). Each cycle is timed
  by its address.
  * The data sheet shows the stretched cycles at a speed change (Figure 8) but not their length. We use XRoar's
    lengths: 15 crystal clocks slow→fast, 17 fast→slow, and 25 when an odd number of fast cycles has put the SAM
    out of step with the VDG.
  * The data sheet doesn't say whether RAM above `$8000` in map type 1 is fast. We keep it slow, so that video
    and refresh stay transparent as p. 11 promises for this mode (XRoar does the same).
* **Rate 1x, fast** (p. 11; Figure 3 note 1, p. 6): every cycle is crystal / 8. The VDG's time slot carries a
  second CPU address, and neither display nor refresh is available.
  * The data sheet doesn't say what the VDG shows then. We take, as XRoar does, that it latches RAM at the
    address the SAM last presented for the CPU.
  * We apply that per video byte: each byte of a line reads RAM at the CPU's last RAM address at that byte's
    fetch time. The active line starts 254 crystal clocks after HS falls (from XRoar's `mc6847.h`). XRoar
    applies it per 16-byte run, so its garbage is coarser than ours.
  * The SAM's video counter keeps advancing. Going back to slow restores the picture at once.
* Software timing (delay loops, `SOUND`, cassette loading) changes as it does on hardware.
  `tests/tape-rate.test.js` shows a pulse-counting loader. Run from ROM at rate 01, it fails: its loop runs
  twice as fast. Run from RAM at rate 01, it still loads, because there the speed-change cycles cost exactly
  what the fast cycles save. Nothing special-cases loading.

How it's verified:

* **XRoar, hardware model.** `tools/mame-diff/sam/run-xroar.js` runs the same firmware on XRoar 1.13 (built
  headless) and compares every instruction's time in crystal clocks, for `rate.asm`, `ops.asm` and the
  diagnostic firmware.
  * `rate.asm` covers timed loops in ROM, RAM and mixed at every rate, mid-field switches, the data sheet's
    sequence for leaving rate 01, and map type 1.
  * `ops.asm` covers every instruction class and addressing mode at rate 01 from ROM and RAM.
  * Result: every instruction takes the same time. XRoar's video phase after reset differs from ours, so the
    comparison resynchronises after field-sync polls. It reports interrupt entries and `CWAI` waits that the
    phase places differently.
* **MAME, with `config.mameCompat`.** MAME 0.264 runs any non-zero rate at full speed everywhere
  (`6883sam.cpp`, "dual speed ???"). It also re-times the cycles already run in its scheduler slice when the
  clock changes. Our MAME model follows its scheduler exactly:
  * slices end at m6809 check points;
  * a rate change re-times the slice;
  * MAME's whole-Hz clocks make the CoCo's CPU run 0.28 ppm slower than a quarter of its VDG clock.

  `node tools/mame-diff/run.js <profile> --rate` and `--ops` must show every instruction identical in all
  registers and cycle counts, with HALT reached. This holds on `dragon64`, `dragon32`, `coco`, `coco2b` and
  `tanodr64`.

**Deviation from MAME:** at the fast rate, MAME keeps the screen intact, while real Dragons and CoCos lose it
([MAME bug 6774](https://mametesters.org/view.php?id=6774)). We implement the data sheet. MAME's intact screen is
kept only under `config.mameCompat`. `tools/mame-diff/sam/run-fastvid.js` checks it: MAME's bitmap at the fast
rate equals its slow-rate bitmap bit for bit, and so does ours under `mameCompat`. Without it, ours changes the
picture and keeps it the same in every field. The fast-rate picture has no automatic oracle: XRoar screenshots of
`fastvid.asm` are the second opinion. Both lose the screen and show characters from the RAM the CPU reads.

**Not emulated:**

* About one in five 1983 Dragons wouldn't run at the fast rates. We emulate a machine that accepts the POKEs.
* Nothing persists past a reset or a power cycle: there is no "damage".

---

See also: [The HD6309 core](cpu6309.md) · [MAME 0.289 results](mame-0289-results.md) · [Development](development.md) · [Machines](machines.md)
