# Every comparison under MAME 0.289

The project's reference is MAME 0.264. This is what the whole harness reports when the MAME in use is **0.289**,
so the maintainers can decide when to move the reference. It records facts and changes no emulator behaviour.

Every 0.289 figure below was produced by running the harness against MAME 0.289 (`0.289 (unknown)`). **The 0.264
column is empty on purpose.** Nothing in it was run, and none of it is guessed from source or memory; the exact
commands to fill it are in each section so a session with 0.264 can run them. Read a row with only a 0.289 result
as "this is what 0.289 does", not as "the project is verified".

No regression hash was recorded or changed for any of this. AGENTS.md 4.2 says the 0.264 gate is the evidence,
and 0.289 results are not a substitute.

**One exception, and it is not this document's subject.** The HD6309's two regression hashes
(`trace dragon64 6309`, `trace coco3 6309`) are taken against 0.289, because 0.264 cannot be an oracle for
them: it undercharges `DIVD` by 25 cycles (3 against 28), so 6309 firmware that divides diverges on 0.264 for a
reason that is MAME's bug, not ours. That is a deviation under AGENTS.md 4.6 (a primary source says MAME is
wrong), it is documented in [cpu6309.md](cpu6309.md), and `config.mameCompat` encodes
0.289's figures so the comparison stays strict. The rule above still holds for everything else: where 0.264 can
compare, 0.264 is the evidence.

## How the harness picks ROM file names

MAME 0.289 repartitioned two of the ROM sets the harness installs our firmware into, so those systems would not
start under it ("Required files are missing"):

| system | 0.264 name(s) | 0.289 name(s) | kind |
|---|---|---|---|
| dragon32 | `d32.rom` (16K) | `dragon_data_ltd_1-0.ic18` + `dragon_data_ltd_1-1.ic17` (8K each) | **partition**: the image is split, low half first |
| tanodr64 | `d64_1.rom`, `d64_2.rom` | `tano_1.ic18`, `tano_2.ic17` | rename: same contents, same sizes |

`tools/mame-diff/lib/firmware.js` reads `mame -version` once per process, and `romFilesFor()` maps each slot to
the names that version asks for. A slot whose several names are **alternatives** (the CoCo's four BASIC
revisions, of which one holds color BASIC) gets the whole image under every name, as the harness always wrote
them; only a slot listed in `SPLIT_SLOTS` is divided, and the only one is the Dragon 32's. Installing the split
everywhere was a bug this branch introduced and now fixes - it is not a property of 0.289, and on plain main the
CoCo boots under 0.289 without any of this code.

The 0.264 names are written too, so one work folder serves either MAME.

## Lockstep (`node tools/mame-diff/run.js <profile>`) - all 14 profiles

| profile | 0.289 result | instructions | 0.264 (not run here) |
|---|---|---|---|
| dragon32 | identical, HALT | 1,028,156 | |
| dragon64 | identical, HALT | 1,028,156 | |
| dragon200 | identical, HALT | 1,028,156 | |
| tanodr64 | identical, HALT | 1,043,415 | |
| coco | identical, HALT | 1,043,371 | |
| coco2b | identical, HALT | 1,043,415 | |
| mx1600 | identical, HALT | 1,043,415 | |
| lzcolor64 | identical, HALT | 1,043,415 | |
| cd6809 | identical, HALT | 1,043,415 | |
| coco3 (512K) | identical, HALT | 88,797 | |
| coco3p (512K) | **diverges at 54,860**: A `$08` (MAME) vs `$00` (ours) after `LDA $FF92`; cycles identical; no HALT | 54,860 | |
| mc10 | identical, HALT | 908,205 | |
| alice | identical, HALT | 908,205 | |
| dgnalpha | (driven by `--board`, below) | | |

**The CoCo 3 (PAL) divergence, 54,850 vs 54,860.** The README used to say 54,850. Both numbers describe the same
divergence point: the same instruction (`82B7 BEQ`, comparing the VBORD bit read from `$FF92`), the same cycle
count (208,335) and the same register values - MAME's VBORD is set, ours is clear. Only the instruction *index*
moved, because the CoCo 3 diagnostic firmware had four `LDA $FDFF` open-bus reads removed (the work-folder
commit that stopped it reading open bus), which is ten instructions. 54,860 is current; 54,850 is what the same
build reports with the longer firmware, and the old figure was stale rather than wrong about the cause.

**alice is now identical.** An earlier 0.289 audit (outside this tree) recorded a divergence at instruction
191,484 on a keyboard-latch read. The cause was in the harness, not the emulator: it pressed the MC-10's matrix
positions on the Alice's AZERTY matrix. The Alice keyboard branch fixed that. It is not a 0.289 difference -
0.264 was never the problem there either.

**coco3p has always differed.** It is the documented PAL case ([verification.md](verification.md)): MAME models
the PAL CoCo 3 with 262 lines and the product has 312, and the 0.289 audit saw the same divergence.

## Video (`--video`)

| profile | 0.289 result | 0.264 (not run here) |
|---|---|---|
| dragon64 | 20/20 modes identical | |
| coco | 20/20 identical | |
| mc10 | 20/20 identical | |
| coco3 (512K) | 31 identical, 15 identical apart from our own character design, 3 **different** of 49 | |

The **15** are not a 0.289 difference: 0.264 reports the same 15. They differ in glyph shapes only, because
MAME draws with its own character ROM and we may not ship one (AGENTS.md rule 1), so the harness supplies a
synthetic font and the glyph pixels cannot match. Counts, colours and layout agree.

The **3** are new in 0.289: `CG1 CSS0`, `CG1 CSS1` and `RG1`. MAME 0.289's `gime.cpp` branches the
MC6847-compatibility graphics path on SAM `V0`, in both the fetch and the render:

```c
// fetch (record_legacy_scanline), 0.289 ~lines 1513-1517
if (m_sam_state & SAM_STATE_V0) pitch = record_scanline_res<16, ...>(...);   // what 0.264 always did
else                            pitch = record_scanline_res<32, ...>(...);   // new in 0.289
// render, 0.289 ~lines 1877-1884
if (m_sam_state & SAM_STATE_V0) render_scanline<16, &gime_device::emit_mc6847_samples<2>>(...);  // 4-pixel cells
else                            render_scanline<32, &gime_device::emit_mc6847_samples<1>>(...);  // 8-pixel cells
```

With V0 clear it fetches 32 bytes a line and emits one output pixel per sample (8-pixel cells); with V0 set it
keeps 0.264's 16 bytes and two pixels per sample (4-pixel cells). 0.264 had no branch at all. The change came in
with MAME's "trs/coco: raster timing (#16698)" (Oct 2026), whose description includes "Fix GIME legacy graphics
fetch widths and pixel decoding", without a hardware rationale in the PR or a comment in the code. The three
modes differ on 8-pixel boundaries over the whole active area, with the same four colours in the same counts -
MAME paints an 8-pixel cell where we paint a 4-pixel half.

Is 0.289 right? Chris Lomont's *Color Computer 1/2/3 Hardware Programming* (v0.8, 2006), GIME section, on the
SAM video mode bits says **"Note the correspondence of HR2-HR0 to the text mode's bytes/line"** and "Old SAM
modes work if CCB bit set. HR and CRES are Don't Care in SAM mode", so the SAM's HR bits are documented as
selecting bytes per line - the mechanism 0.289 is modelling - which makes V0 changing the fetch width in legacy
mode consistent with the documented hardware and 0.264 the simplification. Not confirmed: a source stating the
legacy-mode *cell width* (4 vs 8 output pixels) directly. **Listed, not implemented** - it needs
`config.mameCompat` and a decision about which is the default.

To fill the 0.264 column: `node tools/mame-diff/run.js <profile> --video`.

## Raster (`--raster`, mid-line changes)

| profile | 0.289 result | 0.264 (not run here) |
|---|---|---|
| dragon64 | 17/17 identical | |
| coco | 17/17 identical | |
| mc10 | 10/10 identical | |
| coco3 (512K) | 8/8 identical | |

## SAM CPU rate (`--rate`, `--ops`)

| case | 0.289 result | 0.264 (not run here) |
|---|---|---|
| dragon64 `--rate` | identical, HALT, 1,191,855 | |
| dragon64 `--ops` | identical, HALT, 1,159,963 | |
| coco `--rate` | identical, HALT, 1,205,990 | |
| coco `--ops` | identical, HALT, 1,179,039 | |

## Floppy controllers (`--fdc`) - all four DIVERGE on 0.289

| controller | 0.289 result |
|---|---|
| dragon64 dragonfdc | diverges at 519,731 |
| dragon64 premierfdc | diverges at 754,822 |
| coco cocofdc | diverges at 523,048 |
| dgnalpha alphafdc | diverges at 48,947 |

This is the one place where 0.289 differs in a way that changes a result, and the cause is in MAME.

The Dragon FDC trace at instruction 519,731: MAME is at `C03E LDB <$43`, in `READBUF`, taking the next byte of
a sector because DRQ is asserted; ours has taken an NMI and is at `C003` (the NMI handler) because our
controller has ended the command and asserted INTRQ. So **MAME is late and we are early**: the command
completes on the same cycle count, but MAME holds DRQ up for the last byte and delays INTRQ until that byte is
read.

That is a 0.289 change, and it is in the source:

* `drop_drq()` (0.289 `src/devices/machine/wd_fdc.cpp`, ~line 2358) gained, with the comment "HACK: delay INTRQ
  until last byte is read (should that perhaps inhibit command completion instead?)":

  ```c
  if(!(status & S_BUSY) && !intrq) { intrq = true; intrq_cb(intrq); }
  ```

  immediately before `drq = false; drq_cb(false);`. 0.264 asserted INTRQ in `command_end()`.
* 0.264's `command_end()` was `if (status & S_BUSY) { ...; intrq = true; intrq_cb(intrq); }`; 0.289 now
  negates DRQ first and only asserts INTRQ `if(!drq)`. The same file also moved a `drop_drq()` call and added
  an `S_LOST` DRQ negation in `reset()`.

So this is **not** a difference the project always had: our `commandEnd()` (`js/chips/wd17xx.js:291`) is
0.264's version verbatim, which is why we agree with 0.264 and disagree with 0.289.

**Decision: we keep 0.264's behaviour.** AGENTS.md 4.6 lets us refuse a MAME behaviour only with a primary source
saying MAME is wrong. Here the source is MAME's own: the 0.289 line is introduced by a comment that calls it a
"HACK" and asks "should that perhaps inhibit command completion instead?", which is an admission that the
behaviour is not derived from the WD2797 data sheet or any measurement. A hack with no hardware sourcing does
not meet 4.6, so it is not something to model. The code stays as it is, matching 0.264 - no change was made on
this branch, and none should be made for this reason.

If a hardware source ever shows the real controller delays INTRQ until the last DRQ byte is read, that becomes a
0.264-side correction of our own, judged on the source and not on MAME. If the reference itself moves to 0.289,
the behaviour could then be reproduced behind `config.mameCompat` for the comparison only, with this reasoning
recorded next to it.

The 0.289 lines, cited: `src/devices/machine/wd_fdc.cpp`, `drop_drq()` (~2357-2365) and `reset()` (~358-366);
0.264's counterpart is `command_end()` in the same file.

Commands, for both columns:
```
node tools/mame-diff/run.js dragon64 --fdc [premierfdc]
node tools/mame-diff/run.js coco --fdc
node tools/mame-diff/run.js dgnalpha --fdc alphafdc
```

## Tape (`tools/mame-diff/tape/run-tape.js`)

Passes on 0.289: every check on dragon64, coco, mc10 and alice - MAME's recording of our writer firmware decodes
to the bytes written (669), and MAME and our machine each read our captured `.cas`, captured `.wav` and exported
`.wav` to the same result (X=255, A:B=32410, NBLK=3, NBAD=0).

That result is **stricter than it was**. Two harness faults made a run that had not finished look like a pass, and
both are fixed: the halt test accepted any PC in `haltPc..haltPc+2` (which is a subroutine entry, not padding), and
the MC-10/Alice `.cas` case was skipped because its format is a 50.3 s tape and the run allowed 30 s. Re-run on
0.264, all four profiles (dragon64, coco, mc10, alice) pass every file, including the `.cas` case that used to be
skipped.

Re-measured on **0.289** with the new harness: `mc10` and `alice` pass all eight checks each, including
`captured.cas`, with the same figures as 0.264 - MAME reads our `captured.cas`, `captured.wav` and `exported.wav`
to X=255, A:B=32410, NBLK=3, NBAD=0, and our machine reads each of them to the same. Run with local MAME 0.289,
`SDL_VIDEODRIVER=dummy` (headless), `run-tape.js mc10` and `run-tape.js alice` unchanged, so `alice` is now
covered on 0.289 as well as on 0.264.

## Dragon 64 Plus `$FFE2`: unmeasurable on 0.264

`d64plus`'s bank register `$FFE2` cannot be measured on MAME 0.264. With our own firmware in both BASIC ROM
sockets, writing `$FFE2` changes the bank objects' entries (read back as `pram_bank` 0/1/2 and `vram_bank`
0/1/2/3, exactly as the driver sets them) but **CPU accesses never reach the banks**: for every value `$00`-`$07`,
including the `0`/`2`/`6` cases the driver handles unconditionally, what the CPU reads at `$0100`/`$1000` does not
follow the selected bank. Setting the entries from outside the driver, bypassing `$FFE2` entirely, changes nothing
the CPU sees either, so the install itself is inert there rather than the handler. Reproduced independently by
the Dragon 64 Plus work's own runs, so it is not a harness error.

The cause is not known, and it is not a source difference between the versions: every function on the path is
identical in tags `mame0264` and `mame0289` - `d64plus_state::machine_start` (which installs `m_pram_bank` on
`m_sam->space(0)` over `$0000-$7FFF` and `m_vram_bank` over `$0000-$07FF`), `d64plus_bank_w`, `d64plus()`, the
SAM's empty `coco_ram` map, all of `src/devices/machine/6883sam.cpp`, `install_bank_generic`, and the
`memory_access_cache` notifier that is supposed to invalidate the SAM's cached view of that space. The SAM does
route CPU RAM through its own cached view of `space(0)`, and that cache is invalidated at the end of
`install_bank_generic` in both versions.

**Therefore MAME 0.289 is the oracle for `$FFE2`.** On 0.289 the register behaves as the driver source says: bits
2-1 select the 32K bank (setting both the pram and vram banks), and bit 0 overlays the 2K video RAM on
`$0000-$07FF` only. For an unknown value (`$04`, `$05`) the default case leaves both bank entries as they were,
but **bit 0 is still applied**: so `$05` turns the overlay *on* and `$04` changes nothing. Only a value that both
selects case 0/2/6 and has bit 0 clear removes the overlay. CLOADM's `js/machines/d64plus.js` matches this on
all 16 probed cases under `config.mameCompat`. As shipped, `$FFE2` = `$04`/`$05` selects the motherboard RAM (`$05`
with the video RAM over it; docs/verification.md, "Deviations from MAME").

## Summary

| family | 0.289 |
|---|---|
| lockstep, 13 of 14 profiles | identical |
| coco3p | diverges (pre-existing PAL model, documented) |
| video | all identical except the CoCo 3's 3 GIME modes (new in 0.289) and our own font glyphs (not a difference) |
| raster | identical |
| SAM rate/ops | identical |
| floppy controllers | **all four diverge** (MAME 0.289 delays INTRQ until the last DRQ byte is read) |
| tape | identical |
| d64plus `$FFE2` | measurable on 0.289 only; inert on 0.264 (see above, cause unknown, no source difference) |

Two things would need work if the reference moved to 0.289: the GIME V0 fetch width (three CoCo 3 video modes)
and the WD FDC's delayed INTRQ. Neither is implemented here. They are not the same kind of finding: the GIME one
is consistent with documented hardware (Lomont's bytes-per-line rule) and would need a decision about which model
to keep, while the FDC one is a change MAME's own comment calls a "HACK" with no hardware source, so it does not
meet AGENTS.md 4.6 and we keep 0.264's behaviour.
