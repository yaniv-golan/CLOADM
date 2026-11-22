#!/usr/bin/env node
// Compare one machine against MAME. Needs MAME (e.g. `apt install mame`); uses only our own firmware.
//
//   node tools/mame-diff/run.js <profile> [--ram <K>] [--video [--artifact N] [--attr] [--composite] [--text]] [--raster [--no-trace] [--keep]] [--vsc [--no-trace] [--keep]] [--printer [--no-trace]] [--serial] [--reset] [--rate|--ops] [--plus] [--plustext [--video]] [--paging [--video]] [--keep-firmware]
//   node tools/mame-diff/run.js <dragon64|coco|coco3|dgnalpha> --fdc [dragonfdc|premierfdc|cocofdc|multifdc|alphafdc] [--images|--write|--nmi|--multi|--blank <fmt>:<T>x<H>|--halt [--empty]|--nitros9] [--keep-firmware]
//   node tools/mame-diff/run.js <coco|coco3|dragon64|dragon32> --cart <setup> [--audio]
//
// Trace mode (default): lockstep instruction trace, registers and cycle counts.
// --video: the family's pixel comparison of every display mode (d64plus: its 80-column screen, d64plus/run-video.js); --artifact N sets MAME's and our composite
// colour option (0 off, 1 Standard, 2 Reverse; default 1, MAME's default). --video --text (coco3, --cpu 6309 for
// coco3h): the GIME text screens of coco3/text-screens.js, pixels and MAME's glyphs, and the screen-text reader.
// --raster: mid-line video changes swept across every beam position (<family>/raster.asm, lib/raster.js):
// lockstep to HALT, then every pixel of a swept field per case; --no-trace skips the lockstep part,
// --keep leaves MAME's movie and the difference images in the work directory.
// --vsc (coco3): the GIME's vertical fine scroll $FF9C in the native modes (coco3/gen-vsc.js, vsc-<part>.asm, each
// part from reset): lockstep to HALT, then a field of every case pixel by pixel (lib/raster.js; MAME 0.264 never scrolls, so neither may our
// mameCompat machine), then our shipped model's pictures against MAME's moved up by the scroll the sources give
// (coco3/spec.js vsc); --no-trace and --keep as for --raster.
// --printer: the printer firmware's output, byte for byte against MAME's -prin file (lib/printer.js), after
// a lockstep run to HALT (--no-trace skips it).
// --serial: the bit-banger serial port (or the 6551) in loopback, in lockstep with MAME's -rs232 loopback; then
// every byte sent must have been read back.
// --rate / --ops (SAM family): the CPU rate firmware (sam/rate.asm, sam/ops.asm) instead of diag.asm; MAME
// approximates the SAM rates, so this compares MAME with our config.mameCompat model of it.
// --plus (Dragon 64 Plus): the 80-column board firmware (d64plus/plus.asm) on top of diag.asm's base machine.
// --paging (Dragon 64 Plus): $FFE2 paging (d64plus/paging.asm), ours without mameCompat; with --video, the VDG
// picture under each paging against MAME's (d64plus/run-paging.js).
// --plustext (Dragon 64 Plus): the 80-column text screens of the screen-text reader (d64plus/plustext.asm, written by
// d64plus/text-screens.js); with --video, every screen's 640x264 picture against MAME's (d64plus/run-text.js).
// --fdc: a floppy disk controller cartridge (fdc/: -ext dragon_fdc or premier_fdc on dragon64, -ext fdc on coco and coco3)
// with our firmware as the DOS ROM, four drives; --images then also compares the disk images MAME and we write;
// --blank <vdk|jvc|dmk>:<T>x<H> puts a blank disk (js/media/disk.js blankDisk) in drive 0 and runs
// <board>-format-<T>x<H>.asm, which formats every track (with --images: the formatted images byte for byte;
// --no-trace --images compares the images only, for the long ones);
// --halt (coco3, cocofdc) runs fdc/coco-halt.asm, the halted sector reads; --halt --empty fdc/coco-halt-empty.asm, a
// halted read on a drive with no disk, which holds the CPU for good (the trace must stop at the same instruction);
// --write runs the short <board>-write.asm of the disk mounting tests instead of the diagnostic; --nmi (dragon64)
// runs fdc/nmi.asm, when the 6809 starts taking NMI (NMI from the controller's INTRQ). --nmi with --cpu 6309 runs
// the same firmware on the HD6309 (dragon64 and tanodr64; the 6309 follows MAME and does not arm NMI on TFR/EXG).
// --multi puts the controller in a Multi-Pak's slot 4 (-ext multi) and runs <board>-multi.asm (the diagnostic and the
// Multi-Pak's part).
// --sound (dgnalpha): the AY-3-8912 and the DAC against MAME's -wavwrite (alpha/sound-compare.js). On a SAM machine
// (dragon64, dragon32, coco, ...): the DAC and the single-bit sound, through the command line's --wav path
// (sam/dac-sound.js).
// --cass-sound (dragon64, dragon32, coco, ...): the sound mux with the cassette input selected while a tape plays
// (BASIC's AUDIO ON), against MAME's -wavwrite (sam/cass-sound.js).
// --board (dgnalpha): the Alpha's own hardware (alpha/board.asm: ROM paging, PIA2, AY-3-8912, modem).
// --cart: a cartridge (cart/spec.js setups: banked ROM, Games Master, Orchestra-90, Multi-Pak)
// with our firmware as its ROM, in lockstep; --audio then also compares MAME's -wavwrite recording with ours.
// --pia1b: PIA1 port B's input pins (sam/pia1b.asm, coco3/pia1b.asm, alpha/pia1b.asm; the CoCo wiring of MAME's coco.cpp).
// --floating: the floating bus, $FF60-$FFBF with no cartridge fitted (sam/floating.asm; MAME coco.cpp
// floating_bus_read), on every SAM machine.
// --reset [--cpu 6309]: the Reset button (sam/reset.asm): MAME's soft reset pressed from Lua, ours when MAME's trace shows it; RAM kept, the
// warm-start vector taken and refused, what the CPU and the PIAs keep over a reset.
// --memsize: the SAM memory-size (M1/M0) and page (P1) bits (sam/memsize.asm; MAME 6883sam.cpp read/write).
// --welcome: the 6803 welcome program's comparison build on the MC-10 and the Alice (mc10/gen-welcome.js
// makes a ROM-socket loader that copies the HALTCODE=1 build to $5000; the trace runs to its HALT). With --back,
// the loader first sets the returning visitor's greeting and option 5.
// --keep-firmware: don't regenerate diag.asm from gen-diag.js first.
// Exit code 0 only if everything matched (and the firmware reached HALT).
const path = require('path'), cp = require('child_process');
const { loadEmu } = require('./lib/firmware');
const { lockstep } = require('./lib/lockstep');
const { runRaster } = require('./lib/raster');
const { MameError } = require('./lib/mame');
const { runPrinter } = require('./lib/printer');

const args = process.argv.slice(2);
const profileId = args.find((a) => !a.startsWith('--') && !/^\d+$/.test(a));
const controller = args.includes('--fdc') && args[args.indexOf('--fdc') + 1] && !args[args.indexOf('--fdc') + 1].startsWith('--') ? args[args.indexOf('--fdc') + 1] : undefined;
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
// --blank <vdk|jvc|dmk>:<tracks>x<sides> -> { format, tracks, heads }
const blankOpt = () => {
  const v = opt('--blank');
  if (!v) return null;
  const m = /^(vdk|jvc|dmk):(\d+)x([12])$/.exec(v);
  if (!m) throw new Error(`--blank ${v}: <vdk|jvc|dmk>:<tracks>x<sides>`);
  return { format: m[1], tracks: +m[2], heads: +m[3] };
};
const Emu = loadEmu();
const profile = Emu.profiles[profileId];
if (!profile) {
  console.error(`usage: run.js <profile> [--ram N] [--video]\nprofiles: ${Object.keys(Emu.profiles).join(', ')}`);
  process.exitCode = 2;
  return;   // module top level: nothing below runs
}
// --cpu 6309 runs the HD6309 sweep (tools/mame-diff/6309) instead of the family's diagnostic firmware;
// the profile must have a 6309 option and an HD6309 MAME sibling (mame6309).
const cpuOpt = opt('--cpu');
// These three checks run before dispatch, so each sets exitCode and returns: a bare `process.exit()` can
// deadlock (Node 25.2.1, a background compile waiting for a GC) and this module is CommonJS, where a
// top-level `return` ends it. Nothing below the check runs.
if (cpuOpt && cpuOpt !== '6809' && cpuOpt !== '6309') {
  console.error(`run.js: --cpu must be 6809 or 6309, not ${cpuOpt}`); process.exitCode = 2; return;
}
if (cpuOpt === '6309' && !profile.options.cpu.values.includes('6309')) {
  console.error(`${profileId}: this model has no 6309 option`); process.exitCode = 2; return;
}
if (cpuOpt === '6309' && !profile.mame6309) {
  console.error(`${profileId}: this model has no HD6309 sibling in MAME`); process.exitCode = 2; return;
}
const spec = cpuOpt === '6309'
  ? require(path.join(__dirname, '6309', 'spec.js'))
  : require(path.join(__dirname, profile.family, 'spec.js'));

// Every branch returns the exit code instead of calling process.exit: Node 25.2.1 can deadlock inside
// process.exit while a background compile waits for a GC, which here would strand a finished MAME run. Returning
// lets the loop drain, so anything still open (a child, a FIFO) has to be closed on the way out - see
// lib/mame.js, whose streamTrace already kills MAME and unlinks the pipe before it resolves.
async function main() {
  if (args.includes('--plustext') && args.includes('--video')) {
    // the Dragon 64 Plus's 80-column text screens, pixel by pixel (d64plus/run-text.js)
    if (profile.family !== 'd64plus') { console.error('--plustext: the 80-column text screens are a Dragon 64 Plus comparison'); return 2; }
    const r = cp.spawnSync('node', [path.join(__dirname, 'd64plus', 'run-text.js'), profileId], { stdio: 'inherit' });
    return r.status === null ? 1 : r.status;
  }
  if (args.includes('--paging') && args.includes('--video')) {
    // the Dragon 64 Plus's VDG under every $FFE2 paging, pixel by pixel (d64plus/run-paging.js)
    if (profile.family !== 'd64plus') { console.error('--paging: the bank register is a Dragon 64 Plus comparison'); return 2; }
    const r = cp.spawnSync('node', [path.join(__dirname, 'd64plus', 'run-paging.js'), profileId], { stdio: 'inherit' });
    return r.status === null ? 1 : r.status;
  }
  if (args.includes('--video') && args.includes('--text')) {
    // the CoCo 3 GIME text screens and the screen-text reader (coco3/run-text.js)
    if (profile.family !== 'coco3') { console.error('--text: the GIME text screens are a CoCo 3 comparison'); return 2; }
    const r = cp.spawnSync('node', [path.join(__dirname, 'coco3', 'run-text.js'), cpuOpt || '6809'], { stdio: 'inherit' });
    return r.status === null ? 1 : r.status;
  }
  if (args.includes('--video') && profile.family === 'd64plus') {
    // the Dragon 64 Plus has no run-vdg.js: its own picture is the 80-column screen (d64plus/run-video.js); the base
    // machine's VDG under paging is --paging --video
    const r = cp.spawnSync('node', [path.join(__dirname, 'd64plus', 'run-video.js'), profileId], { stdio: 'inherit' });
    return r.status === null ? 1 : r.status;
  }
  if (args.includes('--video')) {
    const script = path.join(__dirname, profile.family, 'run-vdg.js');
    const ram = opt('--ram') ? ['--ram', opt('--ram')] : [];
    const env = Object.assign({}, process.env, opt('--artifact') !== undefined ? { ARTIFACT: opt('--artifact') } : {}, args.includes('--attr') ? { ATTR: '1' } : {}, args.includes('--composite') ? { MONITOR: 'composite' } : {});
    const r = cp.spawnSync('node', [script, profileId, ...ram], { stdio: 'inherit', env });
    return r.status === null ? 1 : r.status;
  }
  if (args.includes('--fdc')) {
    const fdc = require('./fdc/spec.js');
    const t = fdc.trace(profileId, { controller, regenerate: !args.includes('--keep-firmware'), write: args.includes('--write'), halt: args.includes('--halt'), empty: args.includes('--empty'), nitros9: args.includes('--nitros9'), nmi: args.includes('--nmi'), multi: args.includes('--multi'), blank: blankOpt(), cpu: cpuOpt || '6809' });
    t.install();
    // --no-trace with --images: the images alone (MAME untraced; for the long formats of --blank)
    let code = args.includes('--no-trace') && args.includes('--images') ? 0 : await lockstep(Object.assign({}, t, { machine: t.machine() }));
    if (args.includes('--images')) code |= require('./fdc/images-compare.js').compare(t);
    return code;
  }
  if (args.includes('--ssc')) {
    // the Speech/Sound Pak, in instruction lockstep (masked case): see ssc/spec.js.
    const t = require('./ssc/spec.js').trace(profileId);
    t.install();
    // exitCode, not process.exit: see tests/exitcode.test.js (main) and the note in tests/all.js
    process.exitCode = await lockstep(Object.assign({}, t, { machine: t.machine() }));
    return;
  }
  if (args.includes('--cart')) {
    const t = require('./cart/spec.js').trace(profileId, { setup: opt('--cart') });
    require('./lib/mame').lockWork(t.work);
    t.install();
    let code = await lockstep(Object.assign({}, t, { machine: t.machine() }));
    if (args.includes('--audio')) code |= await require('./cart/audio.js').compare(t);
    return code;
  }
  const config = opt('--ram') ? { ram: Number(opt('--ram')) } : {};
  // a family without the firmware the option names is a usage error, not a comparison result
  const need = (what, have) => {
    if (have) return true;
    console.error(`${profile.family}: no ${what} firmware for this family`);
    process.exitCode = 2;
    return false;
  };
  if (args.includes('--raster')) {
    if (!need('mid-line raster', spec.raster)) return undefined;
    return await runRaster(spec.raster(profileId, { config }), { trace: !args.includes('--no-trace'), keep: args.includes('--keep') });
  }
  if (args.includes('--vsc')) {
    if (!need('vertical scroll', spec.vsc)) return undefined;
    // every part (coco3/gen-vsc.js: each runs from reset, inside the first 2.6 million cycles)
    let code = 0;
    for (let part = 1; part <= spec.vscParts(); part++) {
      code |= await runRaster(spec.vsc(profileId, { config, part, regenerate: part === 1 }), { trace: !args.includes('--no-trace'), keep: args.includes('--keep') });
    }
    return code;
  }
  if (args.includes('--pia1b')) {
    if (!need('PIA1 port B', spec.pia1b)) return undefined;
    const t = spec.pia1b(profileId, { config });
    t.install();
    return await lockstep(Object.assign({}, t, { machine: t.machine() }));
  }
  if (args.includes('--floating')) {
    if (!need('floating-bus', spec.floating)) return undefined;
    const t = spec.floating(profileId, { config });
    t.install();
    return await lockstep(Object.assign({}, t, { machine: t.machine() }));
  }
  if (args.includes('--reset')) {
    // the Reset button: MAME's soft reset, ours at the same cycle (sam/spec.js reset); --cpu 6309 runs the same
    // firmware on the model's HD6309 sibling in MAME (dragon64h, tanodr64h), ours with the 6309 option
    const resetSpec = profile.family === 'sam' ? require(path.join(__dirname, 'sam', 'spec.js')) : spec;
    if (!resetSpec.reset) { console.error(`${profile.family}: no Reset firmware for this family`); process.exitCode = 2; return; }
    const t = resetSpec.reset(profileId, { config: cpuOpt === '6309' ? Object.assign({}, config, { cpu: '6309' }) : config });
    if (cpuOpt === '6309') {
      t.system = profile.mame6309; t.label += ' 6309';
      t.install = () => { require('./lib/firmware').writeProfileRoms(t.work, profile, t.slots, t.system); };
    }
    t.install();
    const m = t.machine();
    const beforeOurs = (e, base) => { if (!base || e.pc !== t.resetPc || !m.cpu.syncing) return false; t.resetOurs(m); return true; };
    process.exitCode = await lockstep(Object.assign({}, t, { machine: m, beforeOurs }));
    return;
  }
  if (args.includes('--memsize')) {
    // exitCode plus an explicit return, not process.exit: setting exitCode alone would fall through into the
    // next block, which would run a second comparison.
    if (!spec.memsize) { console.error(`${profile.family}: no SAM memory-size/page firmware for this family`); process.exitCode = 2; return; }
    const t = spec.memsize(profileId, { config });
    t.install();
    process.exitCode = await lockstep(Object.assign({}, t, { machine: t.machine() }));
    return;
  }
  if (args.includes('--printer')) {
    if (!need('printer', spec.printer)) return undefined;
    return await runPrinter(spec.printer(profileId, { config }), { trace: !args.includes('--no-trace') });
  }
  if (args.includes('--serial')) {
    if (!need('serial', spec.serial)) return undefined;
    const t = spec.serial(profileId, { config });
    t.install();
    let code = await lockstep(Object.assign({}, t, { machine: t.machine() }));
    const m = t.machine();
    // to HALT (a done flag alone is not enough: the CoCo 3's RAM starts filled with $FF)
    for (let f = 0; f < 600 && m.cpu.pc !== t.haltPc; f++) m.runFrame();
    const r = t.result(m);
    console.log(`[${t.label}] ${r.ok ? `all ${r.sent.length} bytes read back as sent` : `bytes read back differ: sent ${r.sent.join(',')}, read ${r.back.join(',')}`}`);
    if (!r.ok) code = 1;
    if (!code) require('fs').rmSync(t.work, { recursive: true, force: true });
    return code;
  }
  if (args.includes('--cass-sound')) {
    if (profile.family === 'sam') return require('./sam/cass-sound.js').compare(profileId, { keep: args.includes('--keep') });
    console.error('--cass-sound: the cassette sound comparison is for the SAM machines (sam/cass-sound.js)');
    process.exitCode = 2;
    return undefined;
  }
  if (args.includes('--sound')) {
    if (profile.family === 'alpha') return require('./alpha/sound-compare.js').compare(profileId, { keep: args.includes('--keep') });
    if (profile.family === 'sam') return require('./sam/dac-sound.js').compare(profileId, { keep: args.includes('--keep') });
    console.error('--sound: the sound comparisons are for dgnalpha (alpha/sound-compare.js) and the SAM machines (sam/dac-sound.js)');
    process.exitCode = 2;
    return undefined;
  }
  if (args.includes('--welcome')) {
    if (!need('welcome', spec.welcome)) return undefined;
    const t = spec.welcome(profileId, { config, back: args.includes('--back'), regenerate: !args.includes('--keep-firmware') });
    t.install();
    return await lockstep(Object.assign({}, t, { machine: t.machine() }));
  }
  if (args.includes('--board')) {
    if (!need('board', spec.board)) return undefined;
    const t = spec.board(profileId);
    t.install();
    return await lockstep(Object.assign({}, t, { machine: t.machine() }));
  }
  const rateFile = args.includes('--rate') ? 'rate.asm' : args.includes('--ops') ? 'ops.asm' : null;
  if (rateFile && !need('CPU rate', spec.rate)) return undefined;
  if (args.includes('--plustext')) {
    if (!need('80-column text', spec.plusText)) return undefined;
    const t = spec.plusText(profileId, { config, regenerate: !args.includes('--keep-firmware') });
    t.install();
    return await lockstep(Object.assign({}, t, { machine: t.machine() }));
  }
  if (args.includes('--paging')) {
    if (!need('paging', spec.paging)) return undefined;
    const t = spec.paging(profileId, { config });
    t.install();
    return await lockstep(Object.assign({}, t, { machine: t.machine() }));
  }
  if (args.includes('--plus')) {
    if (!need('80-column', spec.plus)) return undefined;
    const t = spec.plus(profileId, { config });
    t.install();
    return await lockstep(Object.assign({}, t, { machine: t.machine() }));
  }
  const t = rateFile ? spec.rate(profileId, { config, file: rateFile }) : spec.trace(profileId, { regenerate: !args.includes('--keep-firmware'), config });
  t.install();
  return await lockstep(Object.assign({}, t, { machine: t.machine() }));
}

main().then((code) => {
  // undefined means a usage error already set process.exitCode (2); a real code overrides it
  if (code !== undefined) process.exitCode = code;
}).catch((e) => { console.error(e instanceof MameError ? e.message : e.stack); process.exitCode = 1; });
