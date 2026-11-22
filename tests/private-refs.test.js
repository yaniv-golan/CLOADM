// The maintainers' internal process labels stay out of the tree: review and ruling IDs ("UX R30", "R28b", "(R25)"),
// review-finding tags used as labels, old internal branch names, private planning references. This suite scans every
// tracked file for them, line by line, and checks each pattern on cases of its own. It is the one file exempt from the
// scan (it has to spell the labels out), with tools/vendor/ (third-party code).
//
// The patterns live here and nowhere else: tests/changelog-guard.js requires this file for them and removes their
// matches from both sides before it compares a released CHANGELOG section with its tag, so a released section may
// lose a label and nothing else. Required from another file, it only exports; run, it checks.
// Run: node tests/private-refs.test.js
const cp = require('child_process'), fs = require('fs'), path = require('path');

// Every pattern is applied to one line at a time. Patterns 3 and 4 (a bare R<number>) also match register and
// resistor names (the 6845 CRTC's R0-R17, the CoCo board's R10-R22), so they skip a line that LINE_EXCLUSION matches.
const LINE_EXCLUSION = /6845|CRTC|resistor|light pen|raster|cursor (start|end|address)|start address|startAddress|screenRows|\bR\d+ (skew|columns?|rows?)\b|R1[0-7]\/R1[0-7]|R1[2-5] read/i;

const PATTERNS = [
  { id: 1, re: /\bUX[ -]?(?:rulings? )?R\d{1,3}[a-z]?\b/ },
  { id: 2, re: /\b(?:UX|PM|owner)[ -]rulings?\b|\bthe ruling(?:'s)?\b|\bR\d{1,3} ruling\b/ },
  { id: 3, re: /(?<![\w$#.])R(?:1[89]|[2-9]\d)[a-z]?\b/, excludable: true },
  { id: 4, re: /(?<![\w$#.])R1[0-7][a-z]?\b/, excludable: true },
  { id: 5, re: /\bthe owner\b|\bowner(?:'s|-approved)\b/i },
  { id: 6, re: /\bPM(?: ruling\b|[ \t]*[-#_][ \t]*\d)/ },
  { id: 7, re: /(?:\/\/ |---- |check\(["'`]|^\s*)[mp]\d{1,2}: |UI\/UX review|\bfix-[A-Z]\b/ },
  { id: 8, re: /\b[Rr]eview,? \d{3} item \d+/ },
  { id: 9, re: /\bcloadm-\d+[a-z]?(?:-[a-z0-9]+)+|\bcorrection \d{3}\b/ },
  { id: 10, re: /cloadm-private|session_01\w{10,}|claude\.ai\/code\/session|\bmaintainers track\b|\b[Rr]oadmap\b/ },
  { id: 11, re: /\bbrief's terms\b|\bw[1-9]'s\b|\b[Ww]ave [0-9]\b/ },
];

// The pattern ids that match one line ([] when it is clean).
function labelsIn(line) {
  const excluded = LINE_EXCLUSION.test(line);
  return PATTERNS.filter((p) => !(p.excludable && excluded) && p.re.test(line)).map((p) => p.id);
}

// The line with every label match removed, then tidied so that deleting a label and the punctuation that only
// framed it ("(R25)", "(UX ruling R19 A+)", "R12: ") compares equal to the line written without it: a bracket that
// held a label and keeps at most one word without it goes whole, a separator left at the start of the line or before
// closing punctuation goes, and runs of blanks become one. Only a line that held a label is touched, so on a
// label-free text this returns every line as it is, and any other edit still shows as a difference.
const MARK = '\u0000';
const global = (re) => new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
function stripLine(line) {
  const excluded = LINE_EXCLUSION.test(line);
  let s = line;
  for (const p of PATTERNS) {
    if (p.excludable && excluded) continue;
    // pattern 7 may match the "// " or "check('" before the label: keep that prefix, drop only the label
    s = s.replace(global(p.re), (m) => { const k = p.id === 7 ? m.search(/[mp]\d{1,2}: $/) : -1; return (k > 0 ? m.slice(0, k) : '') + MARK; });
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

const stripLabels = (text) => text.split('\n').map(stripLine).join('\n');

module.exports = { PATTERNS, LINE_EXCLUSION, labelsIn, stripLine, stripLabels };
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
  10: ['github.com/yaniv-golan/cloadm-private', 'claude.ai/code/session_01ABCDEFGHIJKLMNOP', 'the maintainers track one privately', 'a roadmap', 'Roadmap'],
  11: ["(skipped on the brief's terms)", "w1's branch", 'Wave 2', 'wave 3'],
};
const NEGATIVE = {
  1: ['UX: the panel decides', 'UX R', 'a CRTC R12 read'],
  2: ['the rule says', 'a ruler', 'R12 rule'],
  3: ['$R30', 'PR25', 'R2D2', 'a.R30 b', '#R24'],
  4: ['R12/R13 start address', 'cursor (R14/R15, R10/R11)', 'the CRTC R10 blink bits', 'R12 rows', 'R1 and R9'],
  5: ['the owning machine', 'owners', 'CODEOWNERS'],
  6: ['BEQ PM1', 'PM2      RTS', '3 PM', 'PMODE 4'],
  7: ['printed p13: bits', 'map: 1', 'm6809: the CPU', 'fix-up'],
  8: ['review 54 items', 'reviewed item 1'],
  9: ['cloadm.dev', 'cloadm-panel', 'a correction 08'],
  10: ['cloadm.dev', 'a road map', 'claude.ai/code'],
  11: ['const w1 =', 'w1 = 3', 'a wave', "the brief's text"],
};
for (const p of PATTERNS) {
  const pos = POSITIVE[p.id], neg = NEGATIVE[p.id];
  const missed = pos.filter((l) => !labelsIn(l).includes(p.id));
  check(`pattern ${p.id} catches its labels`, pos.length >= 2 && !missed.length, JSON.stringify(missed));
  const wrong = neg.filter((l) => labelsIn(l).includes(p.id));
  check(`pattern ${p.id} leaves its look-alikes`, neg.length >= 2 && !wrong.length, JSON.stringify(wrong));
}
// the named look-alikes match no pattern at all
const NAMED = ['R12/R13 start address', 'cursor (R14/R15, R10/R11)', 'BEQ PM1', 'printed p13: bits', 'const w1 =', 'cloadm.dev',
  '// the data sheet\'s CRTC field widths: R4, R6 and R7', '(m2: our firmware in its socket)', 'R10-R22 resistors'];
check('the named look-alikes (registers, resistors, asm labels, gime p13:, w1, the domain) match no pattern', NAMED.every((l) => !labelsIn(l).length),
  JSON.stringify(NAMED.filter((l) => labelsIn(l).length).map((l) => [l, labelsIn(l)])));
// the line exclusion covers patterns 3 and 4 only: a register line still fails on a ruling label of another pattern
check('the line exclusion is for patterns 3 and 4 only: "UX R30" on a 6845 line is still caught', labelsIn('// 6845 R12 (UX R30)').join() === '1');
check('...and a bare R30 on a 6845 line is not', !labelsIn('// 6845 R30 x').length);

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
  const EXEMPT = (f) => f === 'tests/private-refs.test.js' || f.startsWith('tools/vendor/');
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
      const ids = labelsIn(line);
      for (const id of ids) counts[id] = (counts[id] || 0) + 1;
      if (ids.length) hits.push(`${f}:${i + 1} [pattern ${ids.join(',')}] ${line.trim().slice(0, 140)}`);
    });
  }
  check(`no tracked file carries an internal process label (${scanned} text files scanned)`, !hits.length,
    hits.length ? `${JSON.stringify(counts)}\n  ${hits.slice(0, 40).join('\n  ')}${hits.length > 40 ? `\n  ... and ${hits.length - 40} more` : ''}` : '');
}

console.log(fail ? `${fail} FAILED` : 'all private-refs checks passed');
process.exitCode = fail ? 1 : 0;
