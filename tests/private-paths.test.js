// Nothing private reaches a tracked file: no session ids or links to a Claude session, no name of the private
// planning repository, no path on a developer's own machine or worktree, no shared local work folder, no local
// instructions file, no runner or worker named for a machine, no planning or inbox item number, no personal email
// address, and no branch name other than the CI globs (`claude/**`, `ds/**`). tests/internal-labels.test.js keeps the
// review and ruling labels out; this suite keeps out what points at private places.
//
// Every pattern and every case below is built from parts (J joins them), so this file holds none of what it looks
// for and scans itself like any other. Only tools/vendor/ (third-party code) is exempt, and .gitignore for the local
// instructions file alone (it is where that file is kept out of git).
// Run: node tests/private-paths.test.js
const cp = require('child_process'), fs = require('fs'), path = require('path');

const J = (...parts) => parts.join('');
const SEP = '[ \\t\\u00A0]*';                        // none, spaces, a tab or a no-break space

// a planning id: the planning prefix and a number, spaced (a space, two, a tab or a no-break space) or joined, in
// either case. Spared: a year in prose (the spaced form with exactly four digits, as in "10 at night, 2026"), and in
// an .asm file an assembly label (the joined form at the start of a line, or as an operand after an opcode)
function planningSpared(line, m, file) {
  const sep = m[1], digits = m[2], before = line.slice(0, m.index);
  if (sep.length && digits.length === 4) return true;
  if (!sep.length && file && file.endsWith('.asm')) return /^\s*$/.test(before) || /^(?:\S+)?\s+[A-Z]{2,5}\s+$/i.test(before);
  return false;
}
// an inbox item: the mailbox word and a number. Spared where a $-hex address stands by the match: the chat
// firmware's key mailbox is a byte at an address, not an item
function inboxSpared(line, m) {
  const near = line.slice(Math.max(0, m.index - 24), m.index + m[0].length + 24);
  return /\$[0-9A-F]{2,4}\b/i.test(near);
}
// an email address that is not a GitHub noreply one: a whole address, not a URL's userinfo
// ("https://user@host") or a package's version ("playwright@1.63.0"), and never an RFC 2606 / RFC 6761 reserved
// domain (example.com, example.org, example.net, or a .example, .test, .invalid or .localhost name)
function emailSpared(line, m) {
  const domain = m[2].toLowerCase();
  return /(?:^|\.)users\.noreply\.github\.com$/.test(domain) || /^example\.(?:com|org|net)$/.test(domain)
    || /\.(?:example|test|invalid|localhost)$/.test(domain);
}

const PATTERNS = [
  { id: 'session', what: 'a Claude session id', re: new RegExp(J('\\bsession', '_01[A-Za-z0-9]{10,}')) },
  { id: 'session-link', what: 'a link to a Claude session', re: new RegExp(J('claude\\.ai', '\\/code\\/session')) },
  { id: 'private-repo', what: 'the private planning repository', re: new RegExp(J('cloadm', '-private'), 'i') },
  { id: 'local-path', what: 'a path on a developer machine or a cloud container', re: new RegExp(J('\\/home', '\\/user\\b|\\/tmp', '\\/claude-|\\/root', '\\/\\.ccr\\b')) },
  // a home directory on macOS or Windows: the Users folder at the root, or under a drive letter (either slash)
  { id: 'home-path', what: 'a home directory on a Mac or a Windows machine', re: new RegExp(J('(?<![\\w.-])\\/Users', '\\/[A-Za-z][\\w.-]*|\\b[A-Za-z]:[\\\\\\/]Users', '[\\\\\\/]'), 'i') },
  { id: 'worktree', what: 'a worktree path', re: new RegExp(J('\\.claude', '\\/worktrees\\b')) },
  { id: 'worker', what: 'a runner or worker named for a machine', re: new RegExp(J('\\bCLOADM', '-local\\b|\\blocal[- ]runner\\b|\\bworker[- ]session\\b|\\bw[1-9]', "'s\\b"), 'i') },
  // a branch, bare or as a ref ("origin/…", "refs/heads/…", "refs/remotes/origin/…"): a CI glob ("ds/**",
  // "claude/**") is public and fine, and any other path segment ("js/claude/brief.js", "@anthropic-ai/claude-code")
  // is not a branch;
  // and a release-stage branch (claude/ then v<major>.<minor>[.<patch>]-stage, exactly) is public process: CI runs on it
  { id: 'branch', what: 'a branch name outside the CI globs',
    re: new RegExp(J('(?:(?<![\\w\\/.@-])|(?<=\\b(?:origin|refs\\/heads|refs\\/remotes\\/origin)\\/))(?:ds|claude)', '\\/(?!\\*\\*)(?!(?<=claude\\/)v\\d+\\.\\d+(?:\\.\\d+)?-stage(?![\\w\\/-]|\\.\\w))[a-z0-9][\\w.-]*')) },
  { id: 'planning', what: 'a planning item number', re: new RegExp(J('\\bP', 'M(', SEP, ')(\\d+)\\b'), 'gi'), spared: planningSpared },
  { id: 'inbox', what: 'an inbox item number', re: new RegExp(J('\\b(?:in', 'box|mail', 'box)(', SEP, ')(\\d{1,6})\\b'), 'gi'), spared: inboxSpared },
  { id: 'inbox-path', what: 'an inbox path', re: new RegExp(J('\\/to', '-local\\/\\d+')) },
  { id: 'bus', what: 'the shared local work folder', re: new RegExp(J('(?:~|\\$HOME)\\/cloadm', '-[\\w.-]+'), 'i') },
  { id: 'local-md', what: 'the machine-local instructions file', re: new RegExp(J('\\bCLAUDE\\.', 'local\\.md\\b'), 'i'), exempt: (f) => f === '.gitignore' },
  { id: 'email', what: 'a personal email address',
    re: new RegExp(J('(?<![\\w.+\\/:-])([\\w.+-]+)', '@((?:[A-Za-z0-9-]+\\.)+[A-Za-z]{2,})\\b(?![.@\\w-])'), 'g'), spared: emailSpared },
];

// the pattern ids that match one line of `file` (a path in the tree; without it the line is read as a .js file's)
function refsIn(line, file = 'x.js') {
  return PATTERNS.filter((p) => {
    if (p.exempt && p.exempt(file)) return false;
    if (!p.spared) return p.re.test(line);
    const g = new RegExp(p.re.source, p.re.flags.includes('g') ? p.re.flags : p.re.flags + 'g');
    for (const m of line.matchAll(g)) if (!p.spared(line, m, file)) return true;
    return false;
  }).map((p) => p.id);
}
module.exports = { PATTERNS, refsIn };
if (require.main !== module) return;

let fail = 0;
const check = (name, cond, detail = '') => { if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log('ok   ', name, detail); };
const root = path.join(__dirname, '..');

// ---------------- each pattern, on what it must catch and what it must leave ----------------
// [line, file] pairs; a bare string is a line of a .js file
const POSITIVE = {
  session: [J('Claude-Session: session', '_01ASiPWX2AHK7JT1P1UZmant'), J('from session', '_01ABCDEFGHIJKLMN')],
  'session-link': [J('https://claude.ai', '/code/session', '_01ABCDEFGHIJ'), J('see claude.ai', '/code/session/x')],
  'private-repo': [J('github.com/yaniv-golan/cloadm', '-private'), J('the CLOADM', '-PRIVATE plan')],
  'local-path': [J('/home', '/user/CLOADM/tests'), J('written to /tmp', '/claude-0/scratchpad'), J('/root', '/.ccr/README.md')],
  worktree: [J('.claude', '/worktrees holds every other worktree'), J('cd .claude', '/worktrees/x')],
  worker: [J('run on CLOADM', '-local'), J('the local', ' runner'), J('a local', '-runner job'), J('w1', "'s branch"), J('the worker', ' session')],
  'home-path': [J('/Users', '/jane/src/CLOADM'), J('C:', '\\Users\\jane\\CLOADM'), J('c:', '/use', 'rs/jane/x'), J('see /Users', '/sam')],
  branch: [J('git push origin', '/ds/cpu-fix'), J('refs/heads', '/claude/label-cleanup'), J('refs/remotes/origin', '/ds/x-y'), J('(ds', '/cpu6309-welcome fixed it)'), J('ds', '/load-flicker-w2 brings'), J('claude', '/label-cleanup'), J('claude', '/v0.2-stage-x'), J('claude', '/foo-stage'), J('claude', '/v02-anything'), J('ds', '/v0.2-stage')],
  planning: [J('as P', 'M 143 says'), J('see P', 'M143'), J('p', 'm 12 asks'), J('P', 'M  7'), J('P', 'M\t7'), J('P', 'M 7'),
    [J('BEQ     P', 'M1'), 'tests/x.js'], [J('; P', 'M 12 asked for this'), 'examples/x.asm'], [J('P', 'M 12345 decided'), 'docs/x.md']],
  inbox: [J('in', 'box 12'), J('Mail', 'box 3 says'), J('in', 'box 123456'), J('in', 'box\t9')],
  'inbox-path': [J('../to', '-local/12.md'), J('~/x/to', '-local/3')],
  bus: [J('~/cloadm', '-bus/inbox'), J('$HOME/CLOADM', '-shared/x')],
  'local-md': [[J('see CLAUDE.', 'local.md'), 'AGENTS.md'], [J('claude.', 'local.md holds it'), 'docs/x.md']],
  email: [J('jane', '@', 'company.io'), J('mail first.last', '@company.co.uk for it'), J('<someone', '@gmail.com>')],
};
const NEGATIVE = {
  session: ['the session ends', 'session_id', J('a session', '_01 prefix')],
  'session-link': ['claude.ai/code', 'claude.ai/settings', 'https://claude.ai/'],
  'private-repo': ['the private planning', 'cloadm.dev', 'cloadm-panel'],
  'local-path': ['/home/runner/work/CLOADM', 'the user home', '/tmp/cloadm-nitros9', 'os.tmpdir()'],
  worktree: ['a worktree', 'git worktree add', 'worktrees'],
  worker: ['const w1 = 3', 'W2 is held', 'a Web Worker', 'the runner', 'service-worker events'],
  'home-path': ['/home/runner/work', 'the Users list', 'api/Users', 'https://site.com/x/Users', 'D:\\games\\x', 'fooUsers/x'],
  branch: ['refs/heads/main', 'origin/main', 'refs/heads/ds/**', 'origin/claude/**', 'branches: [main, "claude/**", "ds/**"]', 'js/claude/brief.js', '@anthropic-ai/claude-code', 'skills/claude', 'the ds/** glob', J('claude', '/v0.2-stage'), J('merged into claude', '/v0.1.9-stage'), J('on `claude', '/v0.2-stage` and `main`')],
  planning: [J('at 10 P', 'M 2026 we met'), J('P', 'M 1999'), 'PMODE 4', '3 PM', 'npm 12', '2pm 3',
    [J('P', 'M1     BITA    #KRIGHT'), 'examples/starter-game/catch.asm'], [J('        BEQ     P', 'M1'), 'examples/starter-game/catch.asm'],
    [J('        BHS     P', 'M2'), 'examples/x.asm']],
  inbox: [J('the $7000 key mail', 'box 1'), J('mail', 'box at $7000, byte 2'), J('in', 'box zero'), 'the mailbox', J('in', 'box1234567')],
  'inbox-path': ['to-local/x', '/to-local/', '/to-locals/12'],
  bus: ['/tmp/cloadm-nitros9', 'cloadm-regress-cli-x', '~/cloadm', 'cloadm-panel'],
  'local-md': [['CLAUDE.md', 'AGENTS.md'], ['local.md', 'docs/x.md'], [J('CLAUDE.', 'local.md'), '.gitignore']],
  email: [J('yaniv-golan', '@users.noreply.github.com'), 'playwright@1.63.0', J('https://user', '@host.com/x'), J('https://user:pass', '@host.com/'),
    J('someone', '@example.com'), J('a', '@b.example'), J('x', '@site.test'), J('y', '@z.invalid'), J('z', '@machine.localhost'), '@types/node', 'npm i x@latest'],
};
const pair = (c) => (Array.isArray(c) ? c : [c, 'x.js']);
for (const p of PATTERNS) {
  const pos = POSITIVE[p.id], neg = NEGATIVE[p.id];
  const missed = pos.filter((c) => !refsIn(...pair(c)).includes(p.id));
  check(`${p.id}: catches ${p.what}`, pos.length >= 2 && !missed.length, JSON.stringify(missed));
  const wrong = neg.filter((c) => refsIn(...pair(c)).includes(p.id));
  check(`${p.id}: leaves its look-alikes`, neg.length >= 2 && !wrong.length, JSON.stringify(wrong));
}
// the spared forms are spared per match: a second, unspared one on the same line is still caught
check('planning: a year beside a real id on one line is still caught', refsIn(J('10 P', 'M 2026, then P', 'M 12')).includes('planning'));
check('inbox: an address near one item does not spare another far along the line',
  refsIn(J('mail', 'box at $7000; ............................................. and in', 'box 12')).includes('inbox'));

// ---------------- the tree, this file included ----------------
{
  const EXEMPT = (f) => f.startsWith('tools/vendor/');
  let files = [];
  try { files = cp.execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8', maxBuffer: 64 << 20 }).split('\0').filter(Boolean); } catch (e) { /* no git */ }
  check('the tracked files are listed (git ls-files)', files.length > 100, String(files.length));
  check('this file is scanned like any other', files.includes('tests/private-paths.test.js') && !EXEMPT('tests/private-paths.test.js'));
  const hits = [];
  let scanned = 0;
  for (const f of files) {
    if (EXEMPT(f)) continue;
    let buf;
    try { buf = fs.readFileSync(path.join(root, f)); } catch (e) { continue; }   // deleted in the work tree
    if (buf.includes(0)) continue;                                               // binary
    scanned++;
    buf.toString('utf8').split('\n').forEach((line, i) => {
      const ids = refsIn(line, f);
      if (ids.length) hits.push(`${f}:${i + 1} [${ids.join(',')}] ${line.trim().slice(0, 140)}`);
    });
  }
  check(`no tracked file points at a private place (${scanned} text files scanned)`, !hits.length, hits.length ? `\n  ${hits.slice(0, 40).join('\n  ')}` : '');
}

console.log(fail ? `${fail} FAILED` : 'all private-paths checks passed');
process.exitCode = fail ? 1 : 0;
