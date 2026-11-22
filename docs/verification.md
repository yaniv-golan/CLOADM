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
| Dragon 64 + Premier FDC (WD2791, `--fdc premierfdc`) | 5,890,277 instructions identical, HALT reached; disk images written byte-identical (`--images`) | – | – |
| Color Computer + CoCo FDC (WD1773, `--fdc`) | 5,851,757 instructions identical, HALT reached; disk images written byte-identical (`--images`) | – | – |
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
| CoCo 3 + Speech/Sound Pak (`--ssc int3`, interrupt case) | **outcome comparison against MAME differs**, and is not claimed: the device writes still match (107 of 107 rows) and both sides reach HALT, but the final work RAM does not — MAME leaves `$0405` = `$DF` and we leave `$FF`. `$0405` holds a `$FF7E` status read and bit 5 is the sound-activity circuit: on MAME that bit dips low for a while after an allophone load, and the firmware's fixed read 18.4 ms after the load lands **inside** that dip here and outside it on the CoCo 1/2 and 2B. Our own model stubs the circuit and always reads the bit high, so we read `$FF` on every model. Why the dip sits at a different offset on the CoCo 3 is **not established**. Our side is still pinned in the gate as `trace coco3 ssc int3 (our side; MAME differs at $0405)` | – | – |
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
set false at `js/machines/ssc.js:107` and never set again), so bit 5 reads high unconditionally here, which is why
we report `$FF` on every model.

Two consequences:

* **The CoCo 1/2's and CoCo 2B's pass does not show that the bit is modelled; it depends on where the read lands.** Their work-RAM match depends on where the
  firmware's fixed read lands relative to a window we do not model. Move the settle delay in `ssc.asm` and those
  two could read `DF` as well. Their device-write sequence, which is what the card's decode determines, is genuine
  coverage and is unaffected.
* **Why the dip sits at a different offset on the CoCo 3 is not established.** The card's clock is derived from the
  machine's (a 13-instruction 6809 loop costs 16 card cycles on the CoCo 1/2 and 56 on the CoCo 3, measured here),
  which is the obvious place to look, but the mechanism was not pinned down and is not claimed.

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
pin (status bit 6). This emulator's stage-1 model steps that sequencer once per card cycle, so it reaches `RET`
sooner. Measured on the same firmware built with and without the wait the firmware now has: MAME leaves `$BF` at
`$0405` (SBY low, sampled before the sequencer got there) when it reads the pin immediately, and `$FF` with the
wait; this emulator leaves `$FF` either way. The firmware therefore waits before it samples the pin, as real code
would. It is the emulator whose model is too fast, so the wait belongs in the firmware. That is a pacing difference in the
speech chip's stage-1 model, not a hardware deviation, and it is why the wait is in the firmware rather than a
`mameCompat` branch.

The "0 `SERVE`" run of the earlier revision and the comparison that now passes
(`tools/mame-diff/ssc/compare.js`) were both run with the same harness. Between them the firmware gained the
settle delay; no harness change is involved.

**Not verified for the Speech/Sound Pak: its audio.** The Speech/Sound Pak plays its AY sound, gated by the CoCo
sound mux as in MAME (`coco.cpp:555`: the cartridge is heard when PIA1 CB2 and PIA0 CB2 are high and PIA0 CA2 is
low; an equality test, so all three high selects another source, and a cartridge in a Multi-Pak slot is gated
the same way, as MAME's `coco_multi.cpp` forwards `set_sound_enable` to every slot). Its comparison with MAME
`-wavwrite` is not yet passing, and the comparison is recorded as **not verified**. What is measured: each side's
recording holds four level plateaus (a value held for roughly 120,000 samples at 48 kHz, so they are the waveform's
levels and not resampler edges). MAME's are **10,371, 11,110, 16,407 and 16,994 LSB**; ours are **−12,288,
−11,329, −4,546 and −3,587 LSB**. The steps between neighbouring plateaus are **739, 5,297 and 587 LSB** in
MAME's recording and **959, 6,783 and 959 LSB** in ours, so step for step **MAME's is 0.770, 0.781 and 0.612 of
ours**. A single offset and scale would make those three ratios equal; they are not, so no one offset-plus-scale
map reconciles the two sets, and no slope is claimed between them. Largest difference 29,281 LSB
against the cartridge comparisons' 2 LSB tolerance. **The cause is not established.**
Its speech (SP0256 synthesis) isn't implemented yet: the SP0256's model is the microsequencer
and host interface, with no filter and no DAC, so nothing reaches the mixer from it. That part is verifiable
without a copyrighted ROM: an SP0256 image built by our own tools can be installed in MAME and compared with
`-wavwrite`, as AGENTS.md section 5 (Cartridges) describes — so it is a real remaining task.
**The sound-activity circuit belongs to this same gap.** `$FF7E` bit 5 reports whether the speech chip is making
sound, and this emulator stubs it to a constant high (`js/machines/ssc.js:107`), so the bit is wrong for as long as
the SP0256's audio is; it is listed here rather than as a separate defect, and no work on it makes sense before
speech audio exists.

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
The board is described as **music only** wherever it appears, because speech is the unimplemented half above. Its
PIC (TMS7040) ROM is the user's, added through the ROM panel; the SP0256 allophone ROM is optional, since nothing
plays it yet. Offering the Pak on these four models rests on the instruction lockstep above; the interrupt case
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
resistors R10-R15 as 10K to 324K and the single-bit sound's R22 as 10K (as MAME 0.264's `coco12.cpp` cites it; the
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
snapshots); `tests/state.test.js` saves mid-field, scrolled and between a write and its latch.

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
text (some of it where the start skips it), sets R1, R6, R9 and R12/R13 and holds for ten fields; then text goes
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
sample: MAME pads `.CAS` playback with silence and writes its own sample timing.

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
(`tape/standin.asm`), and `tests/state.test.js` snapshots a tape in the silence and inside a block.

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
the 15; on the SE, removing it puts ENTER's row under the band). In Keys and Joystick mode every key (ENTER's row included), the switch, BREAK, CLEAR and Menu, or the
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
sample's average level, no pop at unlock, reset, switch, pause; latency steering over 15 simulated minutes, and a
140 ms queue - what a page stall leaves - back inside the 10-80 ms band within 8 s), the
AudioWorklet's queue and processor with hand-derived values (`tests/audio-worklet.test.js`: order, underrun to exact
silence, bounded drop-oldest, the MessagePort sink), and the real page in Chromium (browser check, group `audio`):
after the unlock an AudioWorkletNode plays and no ScriptProcessorNode is made (no deprecation warning); through
loads, resets, pause, turbo, sound off, machine switches and a 200 ms busy page, every sample the worklet plays at
full gain equals the one the output stage made (tolerance 0) and no step exceeds 0.01; the tone of a square-wave
program plays at the frequency the machine makes it (within the 0.5% steering) and the queue doesn't run dry while
it plays (at most 2% of blocks); volume and mute; the four fallbacks to the ScriptProcessorNode (no AudioWorklet,
its module failing to load or never loading, the processor failing); and (group `pwa`) offline. Not verified automatically: how it sounds on real devices and
other browsers (Safari and iOS, Firefox).

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

### Install as an app (the PWA offer)

The **Install CLOADM…** item and the one-time offer card (`js/ui/install.js`) have no MAME oracle (AGENTS.md
4.6): they are page behaviour. The oracle is the brief's own rules, checked two ways. In Node,
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
on the card, then **Install CLOADM…** in the machine menu; on an iPhone in Safari, wait for the card, follow
Share → Add to Home Screen, and open CLOADM from the home screen (it starts without the browser's bars and the
Menu item is gone).

### Menus, focus and what screen readers hear

The page's menus and boxes (the machine menu, the phone's Menu links, a drive's menu, the Ctrl+K box, the touch
keys' Menu sheet) and the polite live regions (Ctrl+K's match count, the Library's "N selected") have no MAME
oracle (AGENTS.md 4.6): the oracle is the UX rulings R15-R18. The browser check's group `menuFocus` drives them with
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

### The machine and its ROMs: toasts, switches, the disk ROM, the menu, the Library, the copy

UX rulings R24-R28 and R19 A+ have no MAME oracle (AGENTS.md 4.6): the oracle is the rulings themselves, and the
browser check's group `uiModel` drives them with real events at 1280x720 and at 390x844 with touch:

* R24: a disk dropped without a disk ROM: the toast (the disk is in drive 0 on the disk controller alone, with **Add
  disk ROM…**) has its box inside the viewport and `elementFromPoint` at its centre is the toast; it keeps its slot and
  its time runs. An error toast (a disk image CLOADM can't read) is red. With that disk in and no tape, the drives
  card is above the cassette deck on the phone and under the keyboard panel, and after it on the desktop. (`feedbackModel` checks the fixed top slot where nothing else is
  free, and that it goes after its 4 s.)
* R25: the switch confirmation's text for a tape and a cartridge (both in the Library), a tape and a disk, a RAM
  change (and Cancel putting the select back), a snapshot's own disk with **Save to Library** (stored and linked),
  DriveWire (not listed, still mounted after the switch); the toasts after the switch. `tests/switch-losses.test.js`
  checks `Session.takenOut` and `Session.keepSnapshotDisk` in Node, the Speech/Sound Pak case included.
* R26: the disk ROM card's title per machine (none on the Alpha and the MC-10), its `data-disk` mark with the socket
  counts unchanged, and a drive's **Add disk ROM…** landing on it (in view, focused, on top at its centre).
* R28, R28b: Ctrl K "roms" Enter (Your ROMs, focus on its heading, nothing scrolled), the palette's top result for
  each of its words, the ROMs row first and its label with and without a stored test ROM, the "needs ROMs" toast and
  its action, ↓ from the last machine to both footer items, Esc, and each footer item's focus.
* R19 A+: the ROMs chip's card with and without ROMs (the count and the machines worked out from `session.roms`),
  the drop's **Open Your ROMs**, and the card's link. `tests/stored-roms.test.js` checks `Session.storedRoms`.
* R27: every text node and title, label and placeholder of the page (emulator, machine menu, Your ROMs, Share,
  Library) holds no "stub" and no "Machine tab", and "disk ROM" is the one term; the ROMs row's states, the .dgn
  warning and the snapshot sentence word for word.

Not verified automatically: how the fixed top slot reads to a person on a real phone (screenshots
`r24-disk-toast-*.png` were looked at).

### A disk without a disk ROM

With no disk ROM a mount plugs the disk controller in with nothing in its ROM socket (`Session.plugBareDiskController`),
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
  and ends in HALT. Not run yet: MAME is not installed where this was written (see the change's report).
* `node tools/mame-diff/run.js <dragon64|coco|coco3> --fdc [dragonfdc|premierfdc|cocofdc|multifdc] [--multi] [--images]` runs the
  floppy disk controller cartridges (`fdc/`: `-ext dragon_fdc` with a WD2797 and `-ext premier_fdc` with a WD2791 on
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
  dragon200, tanodr64 **300 bytes identical**; coco, coco2b, coco3 and the clones mx1600, lzcolor64, cd6809 **305 identical**; mc10 **306 identical**; every
  trace identical to HALT.
  * The Dragon prints whenever PIA1 port A is written with PA1 (the strobe) high (MAME `dragon.cpp`), including at
    reset: the PIA's port A becomes inputs, pulled high (`6821pia.cpp` device_reset), so a reset prints PIA0 port B,
    $FF. The Printer box's text leaves such bytes out; the saved file has them.
  * The serial printers sample each bit at its middle, 1.5 to 9.5 bit times after the start edge, as MAME's
    `diserial.cpp` does (`js/machines/serial.js`). Making the line an output while it holds 0 is a start bit:
    the firmware sets the output register before the DDR.

* `node tools/mame-diff/run.js <profile> --serial` runs `sam/serial-loopback.asm` (`mc10/serial-loopback.asm`) with
  a loopback plug on the bit-banger, in lockstep with MAME's `-rs232 loopback`: the firmware sends 13 bytes as
  8N1 frames and reads every bit back from RXD, and records the port's other inputs (PIA1 port B, the carrier
  detect on CA1; the MC-10's CTS). Current results: coco, coco2b, coco3 (128K and 512K), mx1600, lzcolor64, cd6809, mc10 **identical to
  HALT**, all 13 bytes read back as sent. What the device drives follows MAME's devices: the printer holds RXD,
  DCD and CTS low (`rs232/printer.cpp`); the loopback drives DCD and CTS only from DTR and RTS, which these ports
  lack, so they stay high (`rs232/loopback.cpp`). With the CoCo's PIA1 port B as inputs, PB2 is the RAM size sense
  (PIA0 PB6) and PB1 reads 0 (`coco.cpp` pia1_pb_r).
* On the Dragon 64, 200 and Tano, `--serial` runs `sam/acia.asm` on the 6551 with a loopback plug: the registers
  after power-on and after a programmed reset; 20 bytes sent and read back at 1200, 9600 and 19200 baud in 6
  word formats (7 and 8 bits, odd, even, mark and space parity, two stop bits), every poll counted so each status
  change is compared to the cycle; the receive and transmit interrupts taken in CWAI; overrun; a break (framing
  error); DTR off stopping the clock. MAME's plug is its patch box (`-rs232 patch`, set in the run's cfg file:
  RxD from TxD, CTS, DSR and DCD held asserted), because the Dragon 64 does not wire the 6551's RTS and DTR to the
  port, so MAME's plain loopback would leave CTS high and the transmitter off. Current results: dragon64, dragon200,
  tanodr64 **identical to HALT**, all 20 bytes read back as sent. The chip follows MAME's `mos6551.cpp` state for
  state, including its clock: 1.8432 MHz divided by the rate, in whole Hz, running only while DTR is on or a byte
  is coming in. This run found that CWAI checks for an interrupt after 16 cycles (opcode, mask, two dead cycles
  and 12 pushes; MAME `base6x09.lst`), not 20: no earlier firmware had an interrupt arrive that soon.
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

MAME artefacts reproduced only under `config.mameCompat` (the comparisons turn it on; the product does not):

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
(`cpu.haltTail`) are charged at once up to the next event, not one step each. `tests/state.test.js`: snapshots taken
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
between instructions, at the machine's own time (`Coco3Machine.outsideWrite`, `flushOutsideWrites`): the same write
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
  reads refused while they run (the browser check's `connector` group, `tools/connector-check.js`).

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
