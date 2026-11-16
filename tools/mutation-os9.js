// Mutation sweep for the OS-9 geometry checks in js/media/disk.js: break one check at a time and require that
// tests/disk.test.js fails. A check whose removal nothing notices is not covered by a test.
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const FILE = path.join(ROOT, 'js/media/disk.js');

// Every condition in os9Geometry, and every layout/save decision that depends on it, gets its own mutant: a
// mutant that changes several at once (as an earlier version did for the three gaps) hides the ones nothing tests.
// Two guards are deliberately NOT in this list: `size < 0x60` and `totalSectors <= 0`. Removing either still falls
// back to plain JVC, because a later check rejects the same image - measured. They are cheap early exits, not
// behaviour no test pins, and pretending a mutant "catches" them would be the overstatement this sweep exists to
// avoid. `sectors !== 18` IS in the list: it is this emulator's own 18 x 256 MFM limitation, and without it a
// genuine 10- or 16-sector OS-9 image is ACCEPTED as OS-9 (measured) and then built as an 18-sector track.
const MUTANTS = [
  ['COCO bit in opt_type (os9_dsk.cpp:118)', 'let coco = (type & 0x20) !== 0;', 'let coco = false;'],
  ['Gimix COCO bit in opt_density (os9_dsk.cpp:125)', 'if (density & 0x80) coco = true;', ''],
  ['COCO flag requires opt_dtype 1 (os9_dsk.cpp:128)', 'if (dtype !== 1) coco = false;', ''],
  ['sector base ID 1 (os9_dsk.cpp:169)', 'if (sectorBaseId !== 1) continue;', ''],
  ['the 18-sector restriction (10/16-sector images are not ours)', 'if (sectors !== 18) return null;', ''],
  ['MFM density (os9_dsk.cpp:180)', 'if (!(density & 1)) continue;', ''],
  ['cylinders and sides (os9_dsk.cpp:185,190)', 'if (tracks > cylinders || heads > sides) continue;', ''],
  ['sectors per track and track 0 (os9_dsk.cpp:194)', 'if (sectors > perTrack || sectors > track0) continue;', ''],
  ['256-byte sectors (os9_dsk.cpp:201)', 'if (sectorSize !== 256) continue;', ''],
  ['interleave within the track (os9_dsk.cpp:206)', 'if (interleave > sectors) continue;', ''],
  ['DD.TOT lower bound (os9_dsk.cpp:151)', 'if (size < totalSectors * 256) continue;', ''],
  ['DD.TOT upper bound (os9_dsk.cpp:160)', 'if (size > (totalSectors + sectors - 10) * 256) continue;', ''],
  ['OS-9 track layout (os9_dsk.cpp:279 order/data)', 's(OS9_IDS[i], i, OS9_IDS[i] - 1);', 's(g.firstSector + i, JVC_INTERLEAVE[i], i);'],
  ['OS-9 gap 1 (os9_dsk.cpp:279)', 'buildWdTrackMfm(100000, sects, OS9_GAPS[2], OS9_GAPS[0], OS9_GAPS[1])', 'buildWdTrackMfm(100000, sects, OS9_GAPS[2], 32, OS9_GAPS[1])'],
  ['OS-9 gap 2 (os9_dsk.cpp:279)', 'buildWdTrackMfm(100000, sects, OS9_GAPS[2], OS9_GAPS[0], OS9_GAPS[1])', 'buildWdTrackMfm(100000, sects, OS9_GAPS[2], OS9_GAPS[0], 24)'],
  ['OS-9 gap 3 (os9_dsk.cpp:279)', 'buildWdTrackMfm(100000, sects, OS9_GAPS[2], OS9_GAPS[0], OS9_GAPS[1])', 'buildWdTrackMfm(100000, sects, 22, OS9_GAPS[0], OS9_GAPS[1])'],
  ['headerless OS-9 save stays headerless', '} else if (geo.os9) header = [];', '}'],
  ['size ambiguity is decided by LSN 0, not the size', '{ const os9 = os9Geometry(bytes); if (os9) return os9; }', ''],
];

// This tool rewrites js/media/disk.js in place to break one check at a time, then puts it back. Two guards keep
// that from costing anyone work: it refuses to start unless the file matches HEAD (so it never overwrites an
// uncommitted edit), and it restores the exact bytes it read, on exit, on a throw and on Ctrl-C, checking the
// restored file's hash before it reports success.
const crypto = require('crypto');
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

let headOk = true;
try { execFileSync('git', ['diff', '--quiet', 'HEAD', '--', 'js/media/disk.js'], { cwd: ROOT }); } catch (e) { headOk = false; }
if (!headOk) {
  // no process.exit() in a tool: Node 25 can deadlock in it (tests/exitcode.test.js), so set the code and fall out
  // of the main body by returning from the module's top level
  console.error('mutation-os9: js/media/disk.js has uncommitted changes; commit or set them aside first (this tool rewrites the file)');
  process.exitCode = 2;
  return;
}

const original = fs.readFileSync(FILE, 'utf8');
const originalSha = sha(original);
if (original.includes('/* MUTANT */')) {
  console.error('mutation-os9: js/media/disk.js still contains a mutant from an interrupted run; restore it from git first');
  process.exitCode = 2;
  return;
}
let restored = false;
const restore = () => { if (restored) return; restored = true; fs.writeFileSync(FILE, original); };
// On a signal: put the file back, then let the signal take its normal course. Re-raising is not process.exit():
// the default action still terminates the tool, and the file is already restored.
const onSignal = (sig) => {
  restore();
  process.removeAllListeners(sig);
  process.kill(process.pid, sig);
};
process.on('SIGINT', () => onSignal('SIGINT'));
process.on('SIGTERM', () => onSignal('SIGTERM'));
process.on('uncaughtException', (e) => { restore(); console.error(e); process.exitCode = 1; });

let bad = 0;
try {
  for (const [name, find, replace] of MUTANTS) {
    if (!original.includes(find)) { console.log(`?? ${name}: text not found`); bad++; continue; }
    fs.writeFileSync(FILE, original.replace(find, `/* MUTANT */ ${replace}`));
    let failures = 0;
    try {
      const out = execFileSync(process.execPath, [path.join(ROOT, 'tests/disk.test.js')], { encoding: 'utf8' });
      failures = (out.match(/^FAIL/mg) || []).length;
    } catch (e) {
      failures = ((e.stdout || '') .match(/^FAIL/mg) || []).length || 1;
    }
    console.log(`${failures ? 'caught' : 'MISSED'} ${name}: ${failures} failing check(s)`);
    if (!failures) bad++;
  }
} finally {
  restore();
  if (sha(fs.readFileSync(FILE, 'utf8')) !== originalSha) {
    console.error('mutation-os9: js/media/disk.js was NOT restored correctly; check `git diff js/media/disk.js`');
    process.exitCode = 3;
  }
}
console.log(bad ? `${bad} mutation(s) not caught` : 'every mutation is caught');
process.exitCode = bad ? 1 : 0;
