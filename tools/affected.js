#!/usr/bin/env node
// Which suites and browser-check groups a change needs while you work: docs/development.md's "The fast loop" table,
// as data, applied to the files a diff touches.
//
//   node tools/affected.js [<base>]          files changed since <base> (default origin/main), committed or not,
//                                            plus untracked files
//   node tools/affected.js --files a,b,...   the given repository paths instead of a diff
//   node tools/affected.js ... --json        { files, suites, groups, unmapped, notes } instead of the commands
//
// It prints the two `--only` commands (tests/all.js and tools/browser-check.js) for the fast loop. The suites are not
// the gate: the local gate is the full `node tests/all.js` plus the browser-check groups the change touches (the
// second command), and the gate is a green CI run, attempt 1, which runs every group (AGENTS.md 4.7; docs/development.md,
// "The fast loop"; tools/prepush.js runs the author's checklist).
//
// A path under js/ui/, css/, play/ or index.html that no row maps to a panel's groups adds SMOKE, a fixed set of
// groups that load the page and check its general shape. tests/affected.test.js holds every file under js/ to at
// least one suite or group, and the rows marked `doc` to the table in docs/development.md, cell for cell.
const path = require('path'), cp = require('child_process');

// One entry per row. `row` is the first cell of the docs table, word for word, for the rows that are in it (the test
// compares suites and groups with the table); rows without `row` are this tool's own finer mappings. `paths` are
// prefixes (a trailing '/') or exact paths, matched against repository-relative paths with '/' separators.
const AREAS = [
  { row: '`js/cpu/` (6809, 6309, 6803)', paths: ['js/cpu/'],
    suites: ['cpu', 'opcodes', 'disasm', 'asm', 'nmi-arm', 'regress'], groups: ['models', 'cpu6309'] },
  { row: 'Video: `js/chips/` VDG, SAM, GIME, 6845, `js/video/`',
    paths: ['js/chips/mc6847.js', 'js/chips/sam6883.js', 'js/chips/gime.js', 'js/chips/mc6845.js', 'js/chips/artifacter.js', 'js/video/'],
    suites: ['video', 'mc6847', 'mc6845', 'coco3', 'gime-vsc', 'composite', 'sammem', 'samrate', 'regress', 'state'], groups: ['models', 'display', 'glLoss'] },
  { row: 'Machines and profiles (`js/machines/`)', paths: ['js/machines/', 'js/chips/mc6821.js', 'js/chips/attoclock.js', 'js/chips/attotime.js'],
    suites: ['machine', 'models', 'bus', 'coco3', 'mc10', 'alpha', 'd64plus', 'stub-sam', 'state', 'snapshot', 'regress'], groups: ['models', 'powerOn'] },
  { row: 'Floppy disks, `js/media/`', paths: ['js/media/', 'js/chips/wd17xx.js', 'js/chips/floppy.js', 'js/machines/fdc.js', 'js/ui/drives.js', 'js/ui/media-panel.js', 'js/ui/files.js'],
    suites: ['fdc', 'disk', 'detect', 'state'], groups: ['disk', 'media'] },
  { row: 'Cassette', paths: ['js/media/cassette.js', 'js/media/tape.js', 'js/media/deck.js', 'js/host/tape-sound.js', 'js/ui/tape-panel.js'],
    suites: ['tape'], groups: ['tape', 'tapePanel', 'tapeHud'] },
  { row: 'Cartridges and sound chips',
    paths: ['js/machines/carts.js', 'js/machines/ssc.js', 'js/machines/bus.js', 'js/machines/device.js', 'js/chips/ay8910.js', 'js/chips/sn76489.js', 'js/chips/sp0256.js',
      'js/host/audio.js', 'js/host/audio-worklet.js', 'js/ui/multipak-panel.js'],
    suites: ['bus', 'carts', 'ssc', 'sp0256', 'ay8910', 'audio'], groups: ['cartridge', 'sscBoard', 'audio'] },
  { row: 'Serial, printer, DriveWire',
    paths: ['js/chips/mos6551.js', 'js/machines/serial.js', 'js/machines/rs232.js', 'js/machines/becker.js', 'js/drivewire/', 'js/host/drivewire-ws.js',
      'js/host/web-serial.js', 'js/ui/serial-panel.js', 'js/ui/drivewire-panel.js', 'js/ui/printer-panel.js'],
    suites: ['serial', 'serial-api', 'acia', 'drivewire', 'web-serial'], groups: ['driveWire', 'webSerial', 'printer'] },
  { row: 'The assembler (`js/asm/`)', paths: ['js/asm/', 'js/ui/assembler-panel.js'], suites: ['asm', 'includes', 'disasm'], groups: ['debugger'] },
  { row: 'Debugger', paths: ['js/debugger.js', 'js/profiler.js', 'js/writewatch.js', 'js/ui/debugger-panel.js'],
    suites: ['debugger', 'debug-session', 'halt', 'probes', 'writewatch'], groups: ['debugger', 'debuggerScreen'] },
  { row: 'Keyboard and input',
    paths: ['js/host/input.js', 'js/host/gamepad.js', 'js/machines/keyboards.js', 'js/machines/keyqueue.js', 'js/machines/typist.js',
      'js/ui/touch-keys.js', 'js/ui/touch-layout.js', 'js/ui/typein.js', 'js/ui/key-hint.js'],
    suites: ['input', 'keyqueue', 'keyboard-symbols', 'touch-joystick', 'press-break'], groups: ['input', 'inputScreen', 'touchJoystick', 'keyboardSymbols', 'typing'] },
  { row: '`js/session.js`, snapshots', paths: ['js/session.js', 'js/media/snapshot.js', 'js/ui/snapshot-panel.js', 'js/ui/slots-panel.js'],
    suites: ['session', 'snapshot', 'state', 'restore-points', 'writewatch'], groups: ['snapshot', 'state'] },
  { row: '`js/drives.js` (the floppy drives)', paths: ['js/drives.js'],
    suites: ['session-drives', 'disks', 'disks-newdisk', 'disk-bare', 'disks-mount-case', 'disks-mount-race', 'restore-points'], groups: ['disk', 'driveWire'] },
  { row: '`js/library.js` (the media library)',
    paths: ['js/library.js', 'js/media/library.js', 'js/host/media-store', 'js/host/folder-handle.js', 'js/host/storage.js', 'js/ui/library.js'],
    suites: ['session-library', 'storage-move', 'move-inflight', 'library-case', 'recent', 'store-error-names', 'media-store', 'media-index-settled', 'media-multitab', 'store-races'], groups: ['library', 'librarySelect', 'mediaBackend'] },
  { row: 'The Claude chat and Ask Claude',
    paths: ['js/claude/', 'js/host/claude-brief.md', 'js/host/key-store.js', 'js/ui/claude.js', 'js/ui/claude-lines.js', 'js/ui/ask.js', 'js/ui/ask-popout.js', 'js/ui/command-box.js'],
    suites: ['claude', 'chat-firmware'], groups: ['claude', 'ask', 'commands', 'chatScreen'] },
  { row: '`cli/` (the command line and the MCP server)', paths: ['cli/', 'js/mcp/'], suites: ['cli', 'mcp', 'game-guide', 'starter-game'], groups: [] },
  { row: '`connector/` (the side-panel connector)', paths: ['connector/'], suites: ['connector', 'mcp', 'skill'], groups: ['connector'] },
  { row: '`examples/` (a program or game)', paths: ['examples/', 'tools/build-examples.js', 'tools/build-demo.js'],
    suites: ['pwa', 'starter-game', 'game-guide', 'welcome'], groups: ['pwa'] },
  { row: '`js/ui/`, `play/`, `css/`, `index.html`', paths: ['js/ui/', 'play/', 'css/', 'index.html'],
    suites: ['session', 'readme', 'screen-alternative'], groups: ['semantics'] },
  { row: 'Docs (`README.md`, `docs/`)', paths: ['README.md', 'docs/'],
    suites: ['readme', 'romdocs', 'game-guide', 'dev-docs-headless', 'disk-read-example'], groups: [] },
  { row: '`CHANGELOG.md`', paths: ['CHANGELOG.md'], suites: ['changelog'], groups: [] },
  { row: 'The test runner (`tests/all.js`, `suite-verdict.js`, `no-exit.js`)',
    paths: ['tests/all.js', 'tests/suite-verdict.js', 'tests/no-exit.js', 'tests/suite-times.json'],
    suites: ['allsummary', 'allsignal', 'allsched', 'suite-shards', 'exitguard', 'exitcode'], groups: [] },
  { row: '`tools/browser-check*.js`, `.github/`', paths: ['tools/browser-check', '.github/'], suites: ['browser-check'], groups: [],
    note: 'tools/browser-check*.js or .github/ changed: add the browser-check groups you touched' },

  // This tool's own rows, not in the table: the rest of js/ (so that every file maps somewhere) and the panels whose
  // groups are known.
  { paths: ['js/emu.js', 'js/util.js', 'js/errors.js', 'js/hooks.js', 'js/package.json'], suites: ['machine', 'session', 'regress'], groups: ['models'] },
  { paths: ['js/config.js'], suites: ['config'], groups: ['url'] },
  // the program pages and their cards, and the long link (#z=) and the share pictures
  { paths: ['js/program-pages.js', 'js/media/png.js', 'js/video/card.js', 'tools/program-cards.js'], suites: ['program-pages', 'pwa'], groups: ['url', 'pwa'] },
  { paths: ['js/media/snapshot.js'], suites: ['long-link', 'share-roms'], groups: ['share', 'askPopout'] },
  // the share card: Save picture and a short link's preview picture (one renderer)
  { paths: ['js/video/bezel.js'], suites: ['bezel', 'share-card', 'short-link'], groups: ['share', 'shortLink'] },
  // short links: the sealing, the store, the QR code (the Worker itself is shortlink/, tests/shortlink-worker.test.js)
  { paths: ['js/media/link-crypto.js', 'js/host/link-store.js', 'js/media/qr.js'], suites: ['short-link', 'qr', 'shortlink-worker'], groups: ['shortLink', 'share'] },
  { paths: ['js/roms.js', 'js/ui/rom-panel.js', 'js/ui/rom-sockets.js'], suites: ['roms', 'rom-store', 'stored-roms', 'romnames'], groups: ['romUi', 'romInput'] },
  { paths: ['js/selftest.js', 'js/ui/selftest-panel.js'], suites: ['session'], groups: ['models'] },
  { paths: ['js/embed-api.js', 'js/ui/embed.js', 'embed/'], suites: ['embed'], groups: ['embed'] },
  { paths: ['js/host/example-reader.js'], suites: ['session'], groups: ['models'] },
  { paths: ['js/machines/nitros9.js', 'js/media/os9.js', 'js/ui/nitros9-panel.js'], suites: ['nitros9', 'os9'], groups: ['nitros9'] },
  { paths: ['js/ui/poke-panel.js'], suites: [], groups: ['poke'] },
  { paths: ['js/ui/display-panel.js'], suites: ['display'], groups: ['display'] },
  { paths: ['js/ui/welcome.js'], suites: ['welcome'], groups: ['welcomeScreen', 'firstVisit'] },
  { paths: ['js/ui/install.js', 'sw.js', 'manifest.webmanifest', 'tools/pwa-files.js'], suites: ['pwa', 'install'], groups: ['pwa', 'install'] },
  { paths: ['js/ui/share.js', 'js/share-text.js'], suites: ['share-roms', 'share-card', 'share-text'], groups: ['share'] },
  { paths: ['js/bugreport.js', 'js/ui/bug-report.js'], suites: ['bugreport'], groups: ['commands'] },
  { paths: ['js/media/gif.js', 'tools/capture-gif.js'], suites: ['gif', 'share-text'], groups: ['share'] },
  { paths: ['js/version.js', 'js/ui/version-stamp.js', 'tools/version.js'], suites: ['version'], groups: ['reading', 'settings'] },
  { paths: ['faq/', 'about/'], suites: ['site-pages'], groups: ['reading', 'nav', 'pwa'] },
  { paths: ['js/ui/feedback.js'], suites: ['feedback-toasts'], groups: ['feedback', 'feedbackModel'] },
  { paths: ['js/ui/machine-panel.js'], suites: ['machine-menu'], groups: ['models', 'powerOn'] },
  { paths: ['js/ui/settings-file.js'], suites: ['settings'], groups: ['settings'] },
  { paths: ['js/ui/arm-guard.js'], suites: [], groups: ['armGuard'] },
  { paths: ['skills/', '.agents/skills/'], suites: ['skill', 'plugin'], groups: [] },
  { paths: ['.claude-plugin/', 'mcpb/'], suites: ['plugin'], groups: [] },
  { paths: ['tools/mame-diff/', 'tests/regress-hashes.json', 'tests/regress-shards.js', 'tests/regress-record.js'], suites: ['regress', 'mame-lib'], groups: [] },
  { paths: ['AGENTS.md', 'CLAUDE.md', 'CONTRIBUTING.md'], suites: ['fastloop', 'readme'], groups: [] },
  { paths: ['tools/affected.js'], suites: ['affected', 'fastloop'], groups: [] },
  { paths: ['tools/prepush.js'], suites: ['prepush'], groups: [] },
];

// The groups a page change gets when no row knows the panel's own: they load every model, read the page's
// structure, check it works offline, run the UI walkthrough and lay the page out at each size.
const SMOKE = ['models', 'semantics', 'pwa', 'uiQa', 'layout'];
const SMOKE_PATHS = ['js/ui/', 'css/', 'play/', 'index.html'];
const DOC_ROW = AREAS.find((a) => a.row && a.row.startsWith('`js/ui/`'));

const hit = (p, prefix) => (prefix.endsWith('/') ? p.startsWith(prefix) : p === prefix || (!/\.\w+$/.test(prefix) && p.startsWith(prefix)));
const matches = (p) => AREAS.filter((a) => a.paths.some((x) => hit(p, x)));
const uniq = (xs) => [...new Set(xs)];

// -> { files, suites, groups, unmapped, notes } for repository-relative paths
function affected(files) {
  const suites = [], groups = [], unmapped = [], notes = [];
  files = uniq(files.map((f) => f.replace(/\\/g, '/')).filter(Boolean)).sort();
  for (const f of files) {
    let rows = matches(f);
    // a changed suite runs itself
    const m = /^tests\/([^/]+)\.test\.js$/.exec(f);
    if (m && !m[1].startsWith('fixture-')) suites.push(m[1]);
    if (SMOKE_PATHS.some((x) => hit(f, x)) && !rows.some((a) => a !== DOC_ROW && a.groups.length)) groups.push(...SMOKE);
    for (const a of rows) { suites.push(...a.suites); groups.push(...a.groups); if (a.note) notes.push(a.note); }
    if (!rows.length && !m) unmapped.push(f);
  }
  if (unmapped.length) notes.push(`no row maps ${unmapped.length === 1 ? 'this file' : 'these files'}: ${unmapped.join(', ')} (the full gates cover them)`);
  return { files, suites: uniq(suites), groups: uniq(groups), unmapped, notes: uniq(notes) };
}

// Changed files from git: the diff against `base` (working tree included) and untracked files.
function changedFiles(base, cwd = process.cwd()) {
  const git = (args) => cp.execFileSync('git', args, { cwd, encoding: 'utf8' }).split('\n').map((l) => l.trim()).filter(Boolean);
  return uniq([...git(['diff', '--name-only', base]), ...git(['ls-files', '--others', '--exclude-standard'])]);
}

function commands(r) {
  const out = [];
  out.push(r.suites.length ? `node tests/all.js --only ${r.suites.join(',')}` : '# no suite selected: node tests/all.js in full is still the gate');
  if (r.groups.length) out.push(`node tools/browser-check.js --only ${r.groups.join(',')}`);
  return out;
}

function main(argv) {
  const json = argv.includes('--json');
  const fi = argv.indexOf('--files');
  let files;
  if (fi >= 0) {
    if (!argv[fi + 1]) { console.error('--files needs a comma-separated list of paths'); process.exitCode = 2; return; }
    files = argv[fi + 1].split(',');
  } else {
    const base = argv.find((a, i) => !a.startsWith('--') && argv[i - 1] !== '--files') || 'origin/main';
    try { files = changedFiles(base); } catch (e) {
      console.error(`git diff --name-only ${base} failed: ${(e.stderr || e.message).toString().trim()}`); process.exitCode = 2; return;
    }
  }
  const r = affected(files);
  if (json) { console.log(JSON.stringify(r, null, 2)); return; }
  if (!r.files.length) { console.log('no changed files'); return; }
  for (const l of commands(r)) console.log(l);
  for (const n of r.notes) console.log(`# ${n}`);
}

module.exports = { AREAS, SMOKE, affected, changedFiles, commands };
if (require.main === module) main(process.argv.slice(2));
