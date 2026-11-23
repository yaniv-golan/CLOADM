// The maintainers' internal process labels stay out of the tree: review and ruling IDs ("UX R30", "R28b", "(R25)"),
// review-finding tags used as labels, old internal branch names, private planning references. This suite scans every
// tracked file for them, line by line, and checks each pattern on cases of its own. It is the one file exempt from the
// scan (it has to spell the labels out), with tools/vendor/ (third-party code). tests/private-paths.test.js, the
// private-reference guard, builds its patterns from parts and is scanned like any other file.
//
// The patterns live here and nowhere else: tests/changelog-guard.js requires this file for them and removes their
// matches from both sides before it compares a released CHANGELOG section with its tag, so a released section may
// lose a label and nothing else. Required from another file, it only exports; run, it checks.
// Run: node tests/internal-labels.test.js
const cp = require('child_process'), fs = require('fs'), path = require('path');
// joins parts, so a name tests/private-paths.test.js keeps out of the tree is not written whole in this file
const J = (...parts) => parts.join('');

// Every pattern is applied to one line at a time. The ones marked rNumber (3, 4 and 12: an R<number>) also match
// register and resistor names: the 6845 CRTC's R0-R17, the SAM's rate bits R1..R0, the AY-3-8910's R0-R17, the
// TMS7000's register file, the CoCo board's resistors. Those are excused in two ways only, never by a word elsewhere
// on the line:
//  * in one of the chip and register files named in REGISTER_FILES (the 6845, SAM, D64 Plus and CoCo board
//    sources, the screen reader, their MAME firmware and the chip tests), where an R-number is a register;
//  * anywhere else, by what stands right beside the R-number (excusedAt): a chip name, "register(s)", "reg" or
//    "rate bit" directly before it, for the registers that chip has (CHIP_BEFORE) (a list such as "CRTC R12/R13", "registers R0-R17" or "CRTC R0 113, R1 80"
//    included), "*" before it (TMS7000 indirect), "resistor(s)" directly before or after it, or ".." joining it to
//    another (R1..R0). Words that name particular 6845 registers excuse only those: before it, "start address",
//    "address" and "startAddress" R12-R15, "cursor" R10, R11, R14 and R15, "screenRows" R6; after it, "columns" and
//    "codes" R1, "rows" R4, R6 and R9, "skew" R8, "read-back" R12-R17, "start address" R12 and R13.
// Pattern 13 (finding IDs such as M1) is not applied in REGISTER_FILES, where M1/M0 are the SAM's memory size bits.
const REGISTER_FILES = new RegExp('^(?:' + [
  'js/chips/mc6845\\.js', 'js/machines/(?:d64plus|sam|cocopia)\\.js', 'js/claude/readtools\\.js',
  'tools/mame-diff/d64plus/[^/]+', 'tools/mame-diff/sam/(?:fastvid\\.asm|run-fastvid\\.js)', 'tools/mame-diff/coco3/gen-diag\\.js',
  'tests/(?:mc6845|ay8910|tms7000-core|d64plus|d64plus-screen-text|samrate|sammem|models|machine)\\.test\\.js',
].join('|') + ')$');
const SEP = '\\s*(?:\\/|,|and|or|to|–|-)\\s*';
// a list item: "R12", "R9 11" or "R10 $20 (no cursor)" (a register, its value and a note on it)
const ITEM = 'R\\d{1,2}[a-z]?(?:\\s+\\$?[0-9A-F]{1,4}\\b)?(?:\\s+\\([^()]*\\))?';
const before = (words) => new RegExp('(?:' + words + ')[\\s\\x60(]+(?:' + ITEM + SEP + ')*$', 'i');
// a chip name or a register word, with the registers it may stand before: the 6845 CRTC and the AY-3-8910 have
// R0-R17 (the AY's numbered in octal), the SAM's rate bits are R1..R0, the TMS7000's register file is R0-R255
const R0_17 = /^R(?:\d|1[0-7])$/;
const CHIP_BEFORE = [
  [before('\\b(?:CRTC|MC6845|HD6845S?|6845|PSG|AY|AY-3-891[023]|registers?|reg)'), R0_17],
  [before('\\b(?:SAM|rate bits?)'), /^R[01]$/],
  [before('\\bTMS70\\d\\d'), /^R(?:\d{1,2}|1\d\d|2[0-4]\d|25[0-5])$/],
];
// words that name particular registers, with the registers each may name
const NAMED_BEFORE = [
  [before('\\b(?:start address|address|startAddress)'), /^R1[2-5]$/],
  [before('\\bcursor'), /^R1[0145]$/],
  [before('\\bscreenRows'), /^R6$/],
];
const RESISTOR_BEFORE = new RegExp('\\bresistors?\\s+(?:R\\d{1,2}' + SEP + ')*$', 'i');
const RESISTOR_AFTER = new RegExp('^(?:' + SEP + 'R\\d{1,2})*\\s+resistors?\\b', 'i');
// words after a register that name what it holds, with the registers each may follow
const after = (words) => new RegExp('^(?:' + SEP + 'R\\d{1,2})*\\s+(?:' + words + ')\\b', 'i');
const NAMED_AFTER = [
  [after('columns?|codes'), /^R1$/], [after('rows?'), /^R[469]$/], [after('skew'), /^R8$/],
  [after('read-?back'), /^R1[2-7]$/], [after('start address'), /^R1[23]$/],
];
function excusedAt(line, start, end, file) {
  if (file && REGISTER_FILES.test(file)) return true;
  const before = line.slice(0, start), after = line.slice(end);
  const regs = line.slice(start, end).split('/').map((r) => r.replace(/[a-z]$/, ''));
  return [...CHIP_BEFORE, ...NAMED_BEFORE].some(([re, which]) => re.test(before) && regs.every((r) => which.test(r)))
    || /\*$/.test(before) || RESISTOR_BEFORE.test(before) || RESISTOR_AFTER.test(after)
    || NAMED_AFTER.some(([re, which]) => re.test(after) && regs.every((r) => which.test(r))) || /^\.\.R\d/.test(after) || /R\d\.\.$/.test(before);
}

const PATTERNS = [
  { id: 1, re: /\bUX[ -]?(?:rulings? )?R\d{1,3}[a-z]?\b/ },
  { id: 2, re: /\b(?:UX|PM|owner)[ -]rulings?\b|\bthe ruling(?:'s)?\b|\bR\d{1,3} ruling\b/ },
  { id: 3, re: /(?<![\w$#.])R(?:1[89]|[2-9]\d)[a-z]?\b/, rNumber: true },
  { id: 4, re: /(?<![\w$#.])R1[0-7][a-z]?\b/, rNumber: true },
  // "the owner" as a process role; an "Owner field" or an "Owner's Manual" is a thing, not a role
  { id: 5, re: /\bthe owner\b(?! field|'s manual)|\bowner(?:'s|-approved)\b(?! manual)/i },
  { id: 6, re: /\bPM(?: ruling\b|[ \t]*[-#_][ \t]*\d)/ },
  { id: 7, re: /(?:\/\/ |---- |check\(["'`]|^\s*)[mp]\d{1,2}: |UI\/UX review|\bfix-[A-Z]\b/ },
  { id: 8, re: /\b[Rr]eview,? \d{3} item \d+/ },
  { id: 9, re: /\bcloadm-\d+[a-z]?(?:-[a-z0-9]+)+|\bcorrection \d{3}\b/ },
  { id: 10, re: new RegExp(J('cloadm', '-private|session_01\\w{10,}|claude\\.ai\\/code\\/session|\\bmaintainers track\\b|\\b[Rr]oadmap\\b')) },
  { id: 11, re: /\bbrief's terms\b|\bw[1-9]'s\b|\b[Ww]ave [0-9]\b/ },
  // an R-number of any size where a label stands: opening a comment, a bracket, a list or a test name, and closed
  // as a label is ("R2: ", "R4's", "(R6)", "R12/R13: ", "R2-U3", "(R1, R2)")
  { id: 12, re: /(?:(?:\/\/|\/\*|<!--|^)[\s*=-]*|[([]\s*|,\s+|check\(["'`])R\d{1,3}[a-z]?(?:\/R\d{1,3}[a-z]?)?(?=:\s|'s\b|[-–]U\d|\)|,\s*R\d|\s+-\s)|check\(["'`]R\d{1,3}[a-z]?(?=\s)/, rNumber: true },
  // review-finding IDs F<n>, M<n>, U<n> used as labels in comments and test names ("// F3: ", "check('M1 reader",
  // "---- 5. F2/F6:", "(U7, R2-U3)", "(M2)", "//  * M1 - "); a function key ("F1 key", "(F10)", "(F5, a numpad
  // key)") or an opcode ("(F9)") is not one
  { id: 13, re: /(?:\/\/|\/\*|<!--|check\(["'`])[\s*=-]*(?:\d+[a-z]?\.\s+)?[FMU]\d{1,2}[a-z]?(?:\/[FMU]\d{1,2})?(?=[:,]\s|\s+[-(]|\s+(?!keys?\b)[a-z])|\([MU]\d{1,2}[a-z]?[,)]/, notInRegisterFiles: true },
  // review rounds named as the source of a change
  { id: 14, re: /\breview \d+\.\d+(?:\.\d+)? round\b|\bround-\d+ reviewer\b|\breview rounds?\b|\breviewer's finding\b|\bround[- ]\d+(?:'s\b| of review\b| review\b|, the final\b)|\(item \d+\)/i },
  // lettered finding labels A-E: a section header ("// ===== A: "), a letter and digit opening a comment ("// D2: ",
  // "// ---- A1: "), a header bullet ("//  * B - "), a test name opening with one ("check('A1 ", "check('C the "),
  // and the marker names made from one ('D2-MARK-x', window.__d2chat). A test name "B is ..." is the connector's view B. One letter alone opening a comment is
  // left: "// C is the quotient's bit 0", "// E accumulator" and "// A1 x3" (an MFM sync mark) are registers and
  // data, and the connector's views are really named A and B
  { id: 15, re: /\/\/\s*=+\s*[A-E]\d?:\s|(?:\/\/|\/\*)[\s*-]*[A-E]\d:\s|\/\/\s+\*\s+[A-E]\d? - |check\(["'`](?:[A-E]\d\s|[B-E] (?!is\b)[a-z])|\b[A-Z]\d-MARK\b|__[a-z]\d[a-z]+\b/ },
  // a process role or a reviewer's words as the reason for code
  { id: 16, re: /\b(?:UX|PM|design|product) lead\b|\bthe reviewers? (?:said|asked|wanted|found|noted|flagged)\b/i },
  // a ruling's sub-labels: "R44 b5", "(R44 b1)", "R44 (b4)", "R44, b4", and one opening a comment ("// b3: ",
  // "//  (b4) "), and a bare one in prose ("the launch (b4) releases", "(b1, b3)"). A variable named so is not one:
  // a call's or a keyword's parentheses ("mixCodes(c0, c1)", "catch (e2)", "if (c0)", "return (d1)")
  { id: 17, re: /\bR\d+,? \(?[a-e]\d\)?(?![\w(])|(?:\/\/|\/\*)\s*(?:\([a-e]\d\)\s|[a-e]\d:\s)|(?<![\w$)\],(])(?<![,(] )(?<!\b(?:catch|if|while|for|switch|return|typeof|await|yield|new) )\([a-e]\d(?:,\s*[a-e]\d)*\)/ },
  // a ticket or pull request named as the source ("PR-4", "PR #12", "issue #3", "see #40", "(#123)"); a number
  // inside a quoted title of another project's change ('"raster timing (#16698)"' in MAME's log) is that project's
  { id: 18, re: /\bPR(?:-| ?#)\d+\b|\b(?:issue|ticket|bug) #\d+\b|\bsee #\d+\b|\(#\d+\)(?!["'])/i },
];

const global = (re) => new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
// where the R-number of an rNumber match starts and ends ("// R2: " -> the "R2"; "R12/R13" whole)
function rSpan(m, at) {
  const k = m.search(/R\d/), len = /^R\d{1,3}[a-z]?(?:\/R\d{1,3}[a-z]?)?/.exec(m.slice(k))[0].length;
  return [at + k, at + k + len];
}

// The pattern ids that match one line ([] when it is clean). `file` is the line's path in the tree, which decides
// whether an R-number may be a register there (REGISTER_FILES); without it the line is read as any other file's.
function labelsIn(line, file) {
  return PATTERNS.filter((p) => {
    if (p.notInRegisterFiles && file && REGISTER_FILES.test(file)) return false;
    if (!p.rNumber) return p.re.test(line);
    for (const m of line.matchAll(global(p.re))) if (!excusedAt(line, ...rSpan(m[0], m.index), file)) return true;
    return false;
  }).map((p) => p.id);
}

// The line with every label match removed, then tidied so that deleting a label and the punctuation that only
// framed it ("(R25)", "(UX ruling R19 A+)", "R12: ") compares equal to the line written without it: a bracket that
// held a label and keeps at most one word without it goes whole, a separator left at the start of the line or before
// closing punctuation goes, and runs of blanks become one. Only a line that held a label is touched, so on a
// label-free text this returns every line as it is, and any other edit still shows as a difference.
const MARK = '\u0000';
function stripLine(line, file) {
  let s = line;
  for (const p of PATTERNS) {
    // a pattern may match what stands before the label ("// ", "check('", "(", ", "): keep that, drop the label
    if (p.notInRegisterFiles && file && REGISTER_FILES.test(file)) continue;
    s = s.replace(global(p.re), (m, ...rest) => {
      const at = rest.find((x) => typeof x === 'number');
      if (p.rNumber && excusedAt(s, ...rSpan(m, at), file)) return m;
      const k = p.id === 7 ? m.search(/[mp]\d{1,2}: $/) : p.id === 12 ? m.search(/R\d/) : p.id === 13 ? (m.startsWith('(') ? 1 : m.search(/[FMU]\d/)) : 0;
      return (k > 0 ? m.slice(0, k) : '') + MARK;
    });
  }
  if (s === line) return line;
  s = s.replace(/\(([^()]*)\)/g, (all, inner) => (!inner.includes(MARK) ? all
    : (inner.split(MARK).join('').match(/[A-Za-z0-9]+/g) || []).length <= 1 ? MARK : `(${inner})`));
  s = s.split(MARK).join('');
  const lead = /^\s*(?:[-*] |\d+\. |\/\/ ?|#+ )?/.exec(s)[0];
  let body = s.slice(lead.length);
  for (let prev = null; prev !== body;) {
    prev = body;
    body = body.replace(/^[\s,;:/+—–-]+/, '').replace(/([([])[\s,;:/+—–-]+/g, '$1')
      .replace(/\s+([,;:.)\]])/g, '$1')
      .replace(/([,;:])(?=[,;:.)\]])/g, '')
      .replace(/[ \t]{2,}/g, ' ')
      .replace(/\s+$/, '');
  }
  return lead + body;
}

const stripLabels = (text, file) => text.split('\n').map((l) => stripLine(l, file)).join('\n');

module.exports = { PATTERNS, REGISTER_FILES, excusedAt, labelsIn, stripLine, stripLabels };
if (require.main !== module) return;

let fail = 0;
const check = (name, cond, detail = '') => { if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log('ok   ', name, detail); };
const root = path.join(__dirname, '..');

// ---------------- each pattern, on a case it must catch and a case it must leave ----------------
const POSITIVE = {
  1: ['// UX R30: the panel decides', '(UX ruling R24)', 'UX rulings R15-R18', 'UX-R12', '(UX R11b)'],
  2: ['(R24 ruling)', "the ruling's own words", 'a PM ruling', 'the owner ruling', 'UX rulings'],
  3: ['(R25)', '// R24: a toast the user can see', 'R19 A+', 'R28b', 'R33, the Share screen'],
  4: ["check('R10 Reset while paused'", '// R11: paused while the card waits', '(R12, R13)', 'R16 (b): Tab out'],
  5: ["the owner's decision", 'verified by the owner', 'The owner reviews everything', '(owner-approved)'],
  6: ['(PM ruling)', 'PM-3', 'PM #12', 'PM_7'],
  7: ["check('m5: LIZA loaded'", '// p2: Install CLOADM', '  // ---- m4: the status', 'the v0.1.8 UI/UX review', '(the fix-D path)'],
  8: ['(review, 054 item 1)', 'Review 054 item 3'],
  9: ['fixed on cloadm-10-6309-disasm', 'cloadm-6-drivewire', 'cloadm-14b-x', "the owner's correction 008"],
  10: [J('github.com/yaniv-golan/cloadm', '-private'), J('claude.ai', '/code/session', '_01ABCDEFGHIJKLMNOP'), 'the maintainers track one privately', 'a roadmap', 'Roadmap'],
  11: ["(skipped on the brief's terms)", J('w1', "'s branch"), 'Wave 2', 'wave 3'],
  12: ['// R2: a view opened from the chat', '/* R12/R13: the small muted lines */', '// R7b: every note', '(R4\'s touchMode)', '(U7, R2-U3)',
    '// R2-U4: every view', "check('R2 a view'", '(R6)', '(R1, R2)'],
  13: ['// F3: the refusal belongs', "check('M1 reader: Stop ends'", '// ---- 5. F2/F6: the write', '//  * M1 - Stop while', '(U2, M2)',
    '// ================= F2: the embed API', 'card (M2) */', "check(`F2 the person's input`", '// ---- 3b. F1: a ROM-less'],
  14: ['(review 0.1.9 round 2)', "the round-2 reviewer's finding", 'two review rounds found', 'this review round added', "The reviewer's finding was", '// ---- round-3 review: the shapes', '// ---- round 3, the final commit:',
    "(round 2's rule)", '(round 2 of review, and a probe)', '// (item 1) a string'],
  15: ["  // ================= A: the person's input", '    // A1: the consent card', '// ---- A3: EmbedApi.type', '//  * B - the person\'s input',
    "check('A2 the person", "check(`B the person's input", "check('C the turn goes on", "check('D a machine without BASIC", "check('E backend",
    "const MARK = 'D2-MARK-conversation';", 'window.__d2chat = s.chat', '  // D3: a reload while a view'],
  16: ['as the UX lead asked', 'the PM lead decided', 'the reviewer said so', 'what the reviewers found', 'The reviewer flagged it'],
  17: ['// R44 (b4): a launch', '(R44 b1): the button', "check('R44 b5: typing", '(UX ruling R44, b4)', '//  (b4) Reset, a power cycle', '// b3: the status line', 'the launch (b4) releases the stop', '(b4) Reset', 'see (b1, b3) above', '* (c2) the strip'],
  18: ['fixed in PR-4', 'see PR #12', 'as issue #3 says', 'see #40 for why', 'a race (#123) in the mount', 'ticket #7'],
};
const NEGATIVE = {
  1: ['UX: the panel decides', 'UX R', 'a CRTC R12 read'],
  2: ['the rule says', 'a ruler', 'R12 rule'],
  3: ['$R30', 'PR25', 'R2D2', 'a.R30 b', '#R24'],
  4: ['R12/R13 start address', 'cursor (R14/R15, R10/R11)', 'the CRTC R10 blink bits', 'R6 rows', 'R1 and R9'],
  5: ['the owning machine', 'owners', 'CODEOWNERS', "the Owner's Manual says", 'the Owner field of the record', "the owner's manual"],
  6: [J('BEQ P', 'M1'), J('P', 'M2      RTS'), '3 PM', 'PMODE 4'],
  7: ['printed p13: bits', 'map: 1', 'm6809: the CPU', 'fix-up'],
  8: ['review 54 items', 'reviewed item 1'],
  9: ['cloadm.dev', 'cloadm-panel', 'a correction 08'],
  10: ['cloadm.dev', 'a road map', 'claude.ai/code'],
  11: ['const w1 =', 'w1 = 3', 'a wave', "the brief's text"],
  12: ['rate (R1..R0)', 'R1 x 8 by R6', "'toolu_R1'", 'SAM · rate bit R1 cleared', '(SAM R1)', 'Interlace and Skew Register (R8)', '`screenRows` (R6)',
    '// CRTC R0 113, R1 80, R2 96, R10 $20 (no cursor), R11 11, R12/R13 $0050'],
  13: ['// an unmapped physical key (F5, a numpad key)', 'Over (F10) runs a JSR', 'ADCB extended (F9)', '// F1 key opens help', 'an M1 Abrams'],
  14: ['the review of the code', 'a round of tests', 'reviewer: the person', 'coming round 11 frames later', 'round 2 trips', 'an item 1 list'],
  15: ["// C is the quotient's bit 0 [Atkinson p.59]", '// E accumulator', '// A1 x3, FB, 256 data, 2 CRC', '// C2 as output (bit 5 set)',
    "check('A: the only thing it fetches is panel.js'", "check('B is about 1 MiB'", '//   B (open_emulator_inline): this file', '// D and W are both 16-bit',
    "// A disk the person puts in", "check('a refused drop'", 'const w2 = lib()', '__proto__'],
  16: ['the lead line', 'a UX question', 'the reviewer: a person', 'reviewers read the diff'],
  17: ['catch (e2) { }', 'mixCodes(c0, c1)', 'twoFrames(c2);', 'const b1 = 3', 'f(a5)', 'R44 rows', 'if (c0) x();', 'while (d1 > 0)', 'return (d1)',
    'x = typeof (a1)', 'mix(c0)(c1)', 'arr[0](b2)', 'await (d3)', 'new (b4)', 'f(x, (c1))'],
  18: ['"trs/coco: raster timing (#16698)" (Oct 2026)', 'color: #000;', 'PR1     STA', '#C42B23', 'the issue is', 'press #'],
};
for (const p of PATTERNS) {
  const pos = POSITIVE[p.id], neg = NEGATIVE[p.id];
  const missed = pos.filter((l) => !labelsIn(l).includes(p.id));
  check(`pattern ${p.id} catches its labels`, pos.length >= 2 && !missed.length, JSON.stringify(missed));
  const wrong = neg.filter((l) => labelsIn(l).includes(p.id));
  check(`pattern ${p.id} leaves its look-alikes`, neg.length >= 2 && !wrong.length, JSON.stringify(wrong));
}
// the named look-alikes match no pattern at all
const NAMED = ['R12/R13 start address', 'cursor (R14/R15, R10/R11)', J('BEQ P', 'M1'), 'printed p13: bits', 'const w1 =', 'cloadm.dev',
  '// the data sheet\'s CRTC field widths: R4, R6 and R7', '(m2: our firmware in its socket)', 'resistors R10-R22'];
check('the named look-alikes (registers, resistors, asm labels, gime p13:, w1, the domain) match no pattern', NAMED.every((l) => !labelsIn(l).length),
  JSON.stringify(NAMED.filter((l) => labelsIn(l).length).map((l) => [l, labelsIn(l)])));
// an R-number is excused only by what stands right beside it: a ruling label elsewhere on a register line is caught
check('a register beside its chip is excused, a ruling label on the same line is not', labelsIn('// 6845 R12 (UX R30)').includes(1) && labelsIn('// 6845 R12 (R30)').includes(3), labelsIn('// 6845 R12 (UX R30)').join());
check('...and "6845" excuses only its own registers: R17 passes beside it, R30 does not', !labelsIn('// 6845 R17 x').length && labelsIn('// 6845 R30 x').includes(3));
// what stands right beside the R-number, outside the register files: a chip name, register/reg, *, resistor, ".."
const BESIDE = ['("Architecture", registers R0-R17):', 'm.load(0x0200, 0x9A, 0x0A);         // LDA *R10', '// AY R15 envelope', '// the PSG R11/R12 period',
  '// TMS7000 R10', '// TMS7001 R23 port', 'the TMS7000 R200 file', 'SAM R1 set', '// reg R14 holds it', 'AY-3-8912 R13', 'resistors R10-R15 as 10K', "the sound's resistor R22",
  'the CRTC R12-R15 read-back', 'cursor (R14/R15, R10/R11)', 'R12/R13 start address'];
check('an R-number with its chip, register, resistor or field right beside it is excused', BESIDE.every((l) => !labelsIn(l).length),
  JSON.stringify(BESIDE.filter((l) => labelsIn(l).length)));
// the reviewer's mutants and the old exclusion's holes: a context word elsewhere on the line excuses nothing
const STILL = [['// register the handler (R24)', 3], ['// play it (R25)', 3], ['the day R24 landed', 3], ['may R12 apply', 4], ['regress R11', 4],
  ['(R30) display', 3], ['registered R19 A+', 3], ['// raster lines move (R24)', 3], ['the cursor blinks; see R16', 4], ['an AY chip, as R25 said', 3],
  ['/* R12/R13: the small muted lines under a turn */', 4], ['// R12/R13 in full screen: the strip', 4], ['// AY: UX R30', 1],
  ['register (UX ruling R24)', 1], ["register: the owner's decision", 5], ['// 6845 timing, fixed in R25', 3]];
const missedStill = STILL.filter(([l, id]) => !labelsIn(l).includes(id));
check('...and a label is still caught when a chip or register word stands elsewhere on its line (the reviewer\'s mutants included)', !missedStill.length, JSON.stringify(missedStill));
// the register files: an R-number (and the SAM's M1/M0) is a register there, and only there
const inFile = (l, f) => labelsIn(l, f);
check('in a register file an R-number is a register: "// R1: every cycle fast" in tests/samrate.test.js, "; R12" in tools/mame-diff, "R10-R12 bits" in tests/ay8910.test.js',
  !inFile('// R1: every cycle fast', 'tests/samrate.test.js').length && !inFile('LDA $FFE1 ; R12', 'tools/mame-diff/d64plus/plus.asm').length
  && !inFile('//   amplitude         R10-R12 bits 0-3 level', 'tests/ay8910.test.js').length && !inFile('// M1 (bit 14) and P1', 'js/machines/sam.js').length);
check('...and the same lines are labels anywhere else (tools/browser-check.js, js/ui/page.js)',
  inFile('// R1: every cycle fast', 'tools/browser-check.js').includes(12) && inFile('//   amplitude         R10-R12 bits 0-3 level', 'js/ui/page.js').includes(4)
  && inFile('// M1: the phone', 'tools/browser-check.js').includes(13));
check('...and a register file still fails on every other kind of label', inFile('// UX R30 (the owner)', 'js/chips/mc6845.js').join() === '1,5');
// the register files are named one by one: a machine, a MAME tool or a test that is not about registers is read as
// any other file, and the words that name particular registers excuse only those registers
const OUTSIDE = [['// a fix (R24)', 'js/machines/coco3.js', 3], ['// M2: the GIME timer', 'js/machines/coco3.js', 13], ['// R24: a toast', 'tools/mame-diff/run.js', 12],
  ['// R2: the drive', 'js/machines/dragon.js', 12], ['// R24 rows', 'tests/coco3.test.js', 3], ['// F3: the refusal', 'tests/machine-switch.test.js', 13],
  ['// move the cursor (R24)', 'js/ui/page.js', 3], ['// the share address R24 decided', 'js/ui/share.js', 3], ['// the cursor (R2) fix', 'js/ui/page.js', 12],
  ['// the start address R30 rule', 'docs/using.md', 3],
  ['// the CRTC R40 decided', 'js/ui/page.js', 3], ['// register R24 handler', 'js/ui/page.js', 3], ['// the SAM R24 change', 'js/ui/page.js', 3], ['// AY R30 fix', 'js/ui/page.js', 3]];
const notCaught = OUTSIDE.filter(([l, file, id]) => !inFile(l, file).includes(id));
check('only the listed register files are exempt, and a chip or register word excuses only the registers it names (CRTC and AY R0-R17, SAM R0-R1, cursor, address)', !notCaught.length, JSON.stringify(notCaught));
check('...while the 6845 cursor and start address registers still pass beside those words', !labelsIn('cursor (R14/R15, R10/R11)').length
  && !labelsIn('R12/R13 start address').length && !labelsIn('the start address R12/R13').length && !labelsIn('\x60screenRows\x60 (R6)').length);

// ---------------- stripLine: what tests/changelog-guard.js compares ----------------
const STRIP = [
  ['- **Every toast is visible** (UX ruling R24). A toast', '- **Every toast is visible**. A toast'],
  ['- **ROMs in the Library** (UX ruling R19 A+). A', '- **ROMs in the Library**. A'],
  ['- **Menus and boxes give the focus back** (UX rulings R15–R18). The', '- **Menus and boxes give the focus back**. The'],
  ["  keys (BREAK is the strip's, R35); Stick", "  keys (BREAK is the strip's); Stick"],
  ['// R24: a toast the user can see', '// a toast the user can see'],
  ["check('m5: starting LIZA'", "check('starting LIZA'"],
  ['  - **What Claude did** (UX ruling R13), replacing', '  - **What Claude did**, replacing'],
];
for (const [from, to] of STRIP) check(`stripLine: ${JSON.stringify(from)}`, stripLine(from) === to, JSON.stringify(stripLine(from)));
const CLEAN = ['- **Every toast is visible**. A toast', 'R12/R13 start address  (two spaces kept)', '  a ( ) left alone', ''];
check('stripLine leaves a label-free line exactly as it is (spacing and brackets included)', CLEAN.every((l) => stripLine(l) === l));
check('stripLine keeps a bracket that still says something without its label', stripLine('(R24: never invisible wins)') === '(never invisible wins)', stripLine('(R24: never invisible wins)'));
check('stripLine: a word changed beside a removed label still differs', stripLine('**Every toast is shown** (UX ruling R24).') !== stripLine('**Every toast is visible** (UX ruling R24).'));

// ---------------- the CHANGELOG guard, labels removed ----------------
{
  const { check: guard } = require('./changelog-guard.js');
  const TAGGED = ['# Changelog', '', '## [Unreleased]', '', '### 0.2.0', '', '#### Added', '',
    '- **Every toast is visible** (UX ruling R24). A toast never hides.', "- A switch names what comes out (R25; owner's decision), and what stays.", ''].join('\n');
  const run = (text) => guard({ text, tagText: (t) => (t === 'v0.2.0' ? TAGGED : null), tags: ['v0.2.0'], ci: true, allowed: [], aliases: {} });
  const cleaned = TAGGED.replace(' (UX ruling R24)', '').replace(" (R25; owner's decision)", '');
  const clean = cleaned.replace(', and what stays', '');
  check('changelog guard: a released section that only lost its labels passes', run(cleaned).failures.length === 0 && run(cleaned).compared.join() === '0.2.0', run(cleaned).failures.join(' | '));
  check('changelog guard: removing more than the label fails', run(clean).failures.length === 1, run(clean).failures.join(' | '));
  check('changelog guard: a real word changed in a released section fails, labels removed or not',
    run(cleaned.replace('never hides', 'never vanishes')).failures.length === 1 && run(TAGGED.replace('never hides', 'never vanishes')).failures.length === 1);
  check('changelog guard: the tagged text unchanged, labels and all, still passes', run(TAGGED).failures.length === 0);
}

// ---------------- the tree ----------------
{
  const EXEMPT = (f) => f === 'tests/internal-labels.test.js' || f.startsWith('tools/vendor/');
  let files = [];
  try { files = cp.execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8', maxBuffer: 64 << 20 }).split('\0').filter(Boolean); } catch (e) { /* no git */ }
  check('the tracked files are listed (git ls-files)', files.length > 100, String(files.length));
  const hits = [], counts = {};
  let scanned = 0;
  for (const f of files) {
    if (EXEMPT(f)) continue;
    let buf;
    try { buf = fs.readFileSync(path.join(root, f)); } catch (e) { continue; }   // deleted in the work tree
    if (buf.includes(0)) continue;                                               // binary (fonts, images, ROM-free .bin)
    scanned++;
    buf.toString('utf8').split('\n').forEach((line, i) => {
      const ids = labelsIn(line, f);
      for (const id of ids) counts[id] = (counts[id] || 0) + 1;
      if (ids.length) hits.push(`${f}:${i + 1} [pattern ${ids.join(',')}] ${line.trim().slice(0, 140)}`);
    });
  }
  check(`no tracked file carries an internal process label (${scanned} text files scanned)`, !hits.length,
    hits.length ? `${JSON.stringify(counts)}\n  ${hits.slice(0, 40).join('\n  ')}${hits.length > 40 ? `\n  ... and ${hits.length - 40} more` : ''}` : '');
}

console.log(fail ? `${fail} FAILED` : 'all internal-labels checks passed');
process.exitCode = fail ? 1 : 0;
