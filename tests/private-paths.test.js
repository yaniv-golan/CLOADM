// Nothing private reaches a tracked file: no session ids or links to a Claude session, no name of the private
// planning repository, no path on a developer's own machine or worktree, no name of a local runner or a worker, and
// no branch name other than the CI globs (`claude/**`, `ds/**`). tests/internal-labels.test.js keeps the review and
// ruling labels out; this suite keeps out what points at private places. It is exempt from its own scan (it has to
// spell out what it looks for), as are tests/internal-labels.test.js (its cases spell some of the same) and
// tools/vendor/ (third-party code).
// Run: node tests/private-paths.test.js
const cp = require('child_process'), fs = require('fs'), path = require('path');

const PATTERNS = [
  { id: 'session', what: 'a Claude session id', re: /\bsession_01[A-Za-z0-9]{10,}/ },
  { id: 'session-link', what: 'a link to a Claude session', re: /claude\.ai\/code\/session/ },
  { id: 'private-repo', what: 'the private planning repository', re: /cloadm-private/i },
  { id: 'local-path', what: 'a path on a developer machine or a cloud container', re: /\/home\/user\b|\/tmp\/claude-|\/root\/\.ccr\b/ },
  { id: 'worktree', what: 'a worktree path', re: /\.claude\/worktrees\b/ },
  { id: 'worker', what: 'a local runner or a worker by name', re: /\bCLOADM-local\b|\blocal[- ]runner\b|\bworker[- ]session\b|\bw[1-9]'s\b/i },
  // a branch: "ds/cpu6309-welcome", "claude/v0.1.9-stage". The CI globs "ds/**" and "claude/**" are public and fine,
  // and a path segment ("js/claude/brief.js", "@anthropic-ai/claude-code") is not a branch
  { id: 'branch', what: 'a branch name outside the CI globs', re: /(?<![\w\/.@-])(?:ds|claude)\/(?!\*\*)[a-z0-9][\w.-]*/ },
];

const refsIn = (line) => PATTERNS.filter((p) => p.re.test(line)).map((p) => p.id);
module.exports = { PATTERNS, refsIn };
if (require.main !== module) return;

let fail = 0;
const check = (name, cond, detail = '') => { if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log('ok   ', name, detail); };
const root = path.join(__dirname, '..');

// ---------------- each pattern, on what it must catch and what it must leave ----------------
const POSITIVE = {
  session: ['Claude-Session: session_01ASiPWX2AHK7JT1P1UZmant', 'from session_01ABCDEFGHIJKLMN'],
  'session-link': ['https://claude.ai/code/session_01ABCDEFGHIJ', 'see claude.ai/code/session/x'],
  'private-repo': ['github.com/yaniv-golan/cloadm-private', 'the CLOADM-PRIVATE plan'],
  'local-path': ['/home/user/CLOADM/tests', 'written to /tmp/claude-0/scratchpad', '/root/.ccr/README.md'],
  worktree: ['.claude/worktrees holds every other worktree', 'cd .claude/worktrees/x'],
  worker: ['run on CLOADM-local', 'the local runner', 'a local-runner job', "w1's branch", 'the worker session'],
  branch: ['(ds/cpu6309-welcome fixed it)', 'merged into claude/v0.1.9-stage', 'ds/load-flicker-w2 brings', 'claude/label-cleanup'],
};
const NEGATIVE = {
  session: ['the session ends', 'session_id', 'a session_01 prefix'],
  'session-link': ['claude.ai/code', 'claude.ai/settings', 'https://claude.ai/'],
  'private-repo': ['the private planning', 'cloadm.dev', 'cloadm-panel'],
  'local-path': ['/home/runner/work/CLOADM', 'the user home', '/tmp/cloadm-nitros9', 'os.tmpdir()'],
  worktree: ['a worktree', 'git worktree add', 'worktrees'],
  worker: ['const w1 = 3', 'W2 is held', 'a Web Worker', 'the runner', 'service-worker events'],
  branch: ['branches: [main, "claude/**", "ds/**"]', 'js/claude/brief.js', '@anthropic-ai/claude-code', 'skills/claude', 'the ds/** glob'],
};
for (const p of PATTERNS) {
  const pos = POSITIVE[p.id], neg = NEGATIVE[p.id];
  const missed = pos.filter((l) => !refsIn(l).includes(p.id));
  check(`${p.id}: catches ${p.what}`, pos.length >= 2 && !missed.length, JSON.stringify(missed));
  const wrong = neg.filter((l) => refsIn(l).includes(p.id));
  check(`${p.id}: leaves its look-alikes`, neg.length >= 2 && !wrong.length, JSON.stringify(wrong));
}

// ---------------- the tree ----------------
{
  const EXEMPT = (f) => f === 'tests/private-paths.test.js' || f === 'tests/internal-labels.test.js' || f.startsWith('tools/vendor/');
  let files = [];
  try { files = cp.execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8', maxBuffer: 64 << 20 }).split('\0').filter(Boolean); } catch (e) { /* no git */ }
  check('the tracked files are listed (git ls-files)', files.length > 100, String(files.length));
  const hits = [];
  let scanned = 0;
  for (const f of files) {
    if (EXEMPT(f)) continue;
    let buf;
    try { buf = fs.readFileSync(path.join(root, f)); } catch (e) { continue; }   // deleted in the work tree
    if (buf.includes(0)) continue;                                               // binary
    scanned++;
    buf.toString('utf8').split('\n').forEach((line, i) => {
      const ids = refsIn(line);
      if (ids.length) hits.push(`${f}:${i + 1} [${ids.join(',')}] ${line.trim().slice(0, 140)}`);
    });
  }
  check(`no tracked file points at a private place (${scanned} text files scanned)`, !hits.length, hits.length ? `\n  ${hits.slice(0, 40).join('\n  ')}` : '');
}

console.log(fail ? `${fail} FAILED` : 'all private-paths checks passed');
process.exitCode = fail ? 1 : 0;
