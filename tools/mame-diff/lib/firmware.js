// Firmware helpers: assemble our diagnostic programs and lay them out as ROM images.
const fs = require('fs'), path = require('path'), cp = require('child_process');

const ROOT = path.join(__dirname, '../../..');
const loadEmu = () => require(path.join(ROOT, 'tests/load.js'))();

// write a generated file in one step (a run assembling it at the same time sees the old or the new file, whole)
function writeAtomic(file, text) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}
// assemble a source file (INCLUDE "name" reads name from the file's directory); regenerate it first if a
// generator script is given
function assembleFile(file, cpu, generator) {
  if (generator) cp.execFileSync('node', [generator], { stdio: 'ignore' });
  const include = (name) => { const f = path.join(path.dirname(file), name); return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null; };
  const res = loadEmu().assemble(fs.readFileSync(file, 'utf8'), cpu, { include });
  if (!res.ok) throw new Error(`${path.basename(file)}: ` + res.errors.map((e) => `${e.file || ''} line ${e.line}: ${e.message}`).join('; '));
  return res;
}
// image of `size` bytes starting at CPU address `base`, unused bytes = fill
function romImage(asm, base, size, fill) {
  const rom = new Uint8Array(size).fill(fill);
  for (const s of asm.segments) if (s.addr >= base && s.addr < base + size) rom.set(s.data.subarray(0, base + size - s.addr), s.addr - base);
  return rom;
}
// ---------------- MAME version and its ROM file names ----------------
// The project's reference is MAME 0.264, but MAME has repartitioned some ROM sets since, and the file names a
// system asks for are not a property of the machine. 0.289 renamed two of ours (see versionNotes below), so
// the harness writes the names the MAME in use actually wants. The version is detected once per process from
// `mame -version`; MAME=<path> overrides the binary, as before.
let detected = null;
function mamePath() {
  return process.env.MAME || (fs.existsSync('/usr/games/mame') ? '/usr/games/mame' : 'mame');
}
// { major, minor, text } from `mame -version` ("0.289 (unknown)"); major/minor are numbers
function mameVersion() {
  if (detected) return detected;
  let text = '';
  try { text = cp.execFileSync(mamePath(), ['-version'], { encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'ignore'] }); } catch (e) { text = ''; }
  const m = /(\d+)\.(\d+)/.exec(text || '');
  detected = m ? { major: Number(m[1]), minor: Number(m[2]), text: text.trim() } : { major: 0, minor: 0, text: text.trim() || 'unknown' };
  return detected;
}
// is this (major, minor) at least major.minor? Takes the version rather than reading the running MAME, so the
// naming can be tested against both 0.264 and 0.289 without either being installed.
const versionAtLeast = (v, major, minor) => v.major > major || (v.major === major && v.minor >= minor);
const atLeast = (major, minor) => versionAtLeast(mameVersion(), major, minor);

// ROM file names by MAME version, per system. A system that is not listed uses its slot's `files` unchanged.
// Each entry maps a slot id to { '0.289': [names] }, where the names are matched to the slot's existing ones
// in order (so a 16K single file becomes two 8K halves, low half first).
const VERSION_ROM_NAMES = {
  // 0.289 split the 16K Dragon 32 image into two 8K files (dragon_data_ltd_1-0.ic18 low, _1-1.ic17 high)
  dragon32: { basic: { '0.289': ['dragon_data_ltd_1-0.ic18', 'dragon_data_ltd_1-1.ic17'] } },
  // 0.289 renamed the Tano Dragon 64 ROMs (same contents, one 16K per bank)
  tanodr64: { basic: { '0.289': ['tano_1.ic18'] }, basic64: { '0.289': ['tano_2.ic17'] } },
};

// Slots whose version-specific names are a PARTITION of the image (one file per piece) rather than a rename.
// Only the Dragon 32's 0.289 split is one; every other multi-name slot lists alternatives.
const SPLIT_SLOTS = new Set(['dragon32:basic']);

// The file names a slot should be written under for the MAME in use, and how its bytes are split over them.
// Returns [{ name, bytes }]: one entry per file, already sliced. `slots` is { slotId: Uint8Array }.
// `version` defaults to the running MAME and exists so tests can ask what 0.264 or 0.289 would be written.
function romFilesFor(profile, slots, version = mameVersion()) {
  const v = version;
  const renames = VERSION_ROM_NAMES[profile.id] || {};
  const out = [];
  for (const sl of profile.roms) {
    const data = slots[sl.id];
    const rename = renames[sl.id] && (versionAtLeast(v, 0, 289) ? renames[sl.id]['0.289'] : null);
    const names = rename || sl.files;
    // A slot's several names are usually ALTERNATIVES that each take the whole image (coco's bas slot lists four
    // BASIC revisions, and color BASIC is in one of them), which is what writeRoms always wrote for them.
    // Splitting those into equal pieces is what made MAME refuse to boot: only a slot in SPLIT_SLOTS is a real
    // partition, and only there are the bytes divided.
    if (names.length === 1 || !SPLIT_SLOTS.has(`${profile.id}:${sl.id}`)) {
      for (const name of names) out.push({ name, bytes: data });
      continue;
    }
    // a partition: one file per piece, divided evenly (a 16K image into two 8K halves, low first)
    const each = Math.floor(data.length / names.length);
    names.forEach((name, i) => out.push({ name, bytes: data.subarray(i * each, i === names.length - 1 ? data.length : (i + 1) * each) }));
  }
  return out;
}

// write ROM files where MAME looks for them: <work>/roms/<system>/<name>
function writeRoms(work, system, files) {
  const dir = path.join(work, 'roms', system);
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, data] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), data);
}

// Write a profile's slots into MAME's ROM folder under the names the MAME in use asks for. The 0.264 names are
// written too, so one work folder serves either MAME (a stale name is harmless; MAME reads only its own).
// Every name this profile can need across the MAME versions we know of: the slot's own names (0.264) and any
// version-specific ones (0.289). Writing all of them means one work folder serves either MAME - each version
// reads only the names it asks for, so the others are inert files.
const KNOWN_VERSIONS = [{ major: 0, minor: 264 }, { major: 0, minor: 289 }];
function romFilesForAllVersions(profile, slots) {
  const out = new Map();
  for (const v of KNOWN_VERSIONS) for (const f of romFilesFor(profile, slots, v)) if (!out.has(f.name)) out.set(f.name, f.bytes);
  return [...out].map(([name, bytes]) => ({ name, bytes }));
}

// Write a profile's slots into MAME's ROM folder under every name set we know (see romFilesForAllVersions).
// `system` is where MAME looks for them: the profile's own driver by default, or its HD6309 sibling when the
// same profile runs on the 6309 (dragon64 -> dragon64h), which is a different folder.
function writeProfileRoms(work, profile, slots, system = profile.mame) {
  const files = {};
  for (const f of romFilesForAllVersions(profile, slots)) files[f.name] = f.bytes;
  writeRoms(work, system, files);
  return files;
}

// MAME options matching a machine config (so both emulators run the same hardware)
function mameConfigArgs(config) {
  return config.ram ? ['-ramsize', `${config.ram}K`] : [];
}

// MAME's per-system cfg file: the settings its Lua API will not change while it runs (port CONFIG fields
// such as ctrl_sel and hires_intf are read at setup). MAME writes the file itself when it exits, so this
// must be rewritten before every run.
//   right: what is in the right controller port — MAME's ctrl_sel: 1 joystick (with a Hi-Res interface on it,
//          chosen by hiresIntf), 2 the Rat mouse, 0 nothing
//   hiresIntf: MAME's HIRES_INTF_TAG: 0 none, 1 Hi-Res (Tandy) in the right port, 2 CoCo Max 3 style in the
//          right port, 3 Hi-Res in the left, 4 CoCo Max 3 in the left
function writeCfg(work, system, hiresIntf, right = 1) {
  const dir = path.join(work, 'cfg');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${system}.cfg`), `<?xml version="1.0"?>
<mameconfig version="10">
    <system name="${system}">
        <input>
            <keyboard tag=":" enabled="1" />
            <port tag=":ctrl_sel" type="CONFIG" mask="15" defvalue="1" value="${right}" />
            <port tag=":ctrl_sel" type="CONFIG" mask="240" defvalue="16" value="16" />
            <port tag=":hires_intf" type="CONFIG" mask="7" defvalue="0" value="${hiresIntf}" />
        </input>
    </system>
</mameconfig>
`);
}

module.exports = { ROOT, loadEmu, assembleFile, romImage, writeRoms, writeProfileRoms, romFilesFor, versionAtLeast, mameVersion, mamePath, mameConfigArgs, writeCfg, writeAtomic };
