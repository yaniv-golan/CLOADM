// Every workflow action is pinned, and the trigger that runs contributor code without the repository's own token is
// never used. Read the files, not the workflow runs: this is what a reviewer can check before a push.
//
//   - every `uses:` in .github/workflows/*.yml names a full 40-hex commit SHA with the release tag beside it as a
//     comment. A tag or a branch can be moved to other code; a SHA cannot, and the tag in the comment is what makes
//     the bump reviewable (Dependabot, .github/dependabot.yml, proposes the pair);
//   - `pull_request_target` is not a trigger anywhere: it runs the BASE repository's token and secrets against a pull
//     request's code, which is exactly what this project does not want for a workflow that runs contributor code;
//   - tests.yml runs on `pull_request` as well as on pushes;
//   - tests.yml's permissions grant nothing but `contents: read`;
//   - the pins were checked against real releases with `gh api` when they were added (a network call is not a test
//     here: a unit test that needed GitHub to answer would fail the gate whenever it is unreachable).
//
// The readers below are written against YAML SHAPE, not one spelling of it: a step may be a block map or a flow map,
// `on:` may list its events in a block or a flow sequence, and a value may be quoted or spaced unusually. Each
// reader has self-checks for the shapes it must accept and the ones it must refuse, because a reader that recognised
// nothing would pass every file (a step written `- { uses: actions/checkout@v7 }` was invisible to an earlier line
// matcher, and an unpinned action in it would have shipped green).
// Run: node tests/workflows.test.js
const fs = require('fs'), path = require('path');

let fail = 0;
const check = (name, cond, detail = '') => { if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name} ${detail}`); };
const DIR = path.join(__dirname, '..', '.github', 'workflows');
const files = fs.readdirSync(DIR).filter((f) => /\.ya?ml$/.test(f)).sort();
const read = (f) => fs.readFileSync(path.join(DIR, f), 'utf8');

// YAML without a parser (this project has no dependencies). What these readers need is a small, stated subset of
// block and flow mappings, which is all a GitHub workflow may use:

// A line with its comment removed. Quotes are respected so a '#' inside a string is not taken for a comment.
function stripComment(line) {  let q = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { if (c === q) q = null; continue; }
    if (c === '"' || c === "'") { q = c; continue; }
    if (c === '#' && (i === 0 || /\s/.test(line[i - 1]))) return line.slice(0, i);
  }
  return line;
}

// Split a flow collection's inner text on commas at depth 0 (nested { } and [ ] stay whole). A flow step may hold a
// whole `with: { fetch-depth: 0 }` map, and a naive split would cut it in half.
function splitFlow(inner) {
  const parts = [];
  let depth = 0, cur = '';
  for (const c of inner) {
    if (c === '{' || c === '[') depth++;
    if (c === '}' || c === ']') depth--;
    if (c === ',' && depth === 0) { parts.push(cur); cur = ''; continue; }
    cur += c;
  }
  parts.push(cur);
  return parts;
}

// Every action reference in a workflow, read STRUCTURALLY. A line matcher was defeated three times in review -- a
// quoted key (`- "uses": x@v1`), a flow map (`- {"uses": x@v1}`) and a value on the next line each left an unpinned
// action green -- so this works on the file's shape instead:
//
//   1. block-scalar bodies are removed FIRST: a `run: |` body is script text, and a `uses:` in it is not an action;
//   2. a quoted key is a key, and a '#' inside quotes is not a comment;
//   3. a key's value may be on its own line or the next, in block or flow form.
//
// It answers one question -- which actions does this file reference -- and THROWS on a `uses:` it cannot read rather
// than skipping it, so a shape it does not understand is a red check, not a silent pass.
function pairsOnLine(line) {
  const code = stripComment(line);
  const KEY = /(?:^|[\s,{])(?:"([^"]+)"|'([^']+)'|([A-Za-z_][\w.-]*))\s*:/g;
  const out = [];
  let m;
  while ((m = KEY.exec(code))) {
    const key = m[1] !== undefined ? m[1] : m[2] !== undefined ? m[2] : m[3];
    let i = KEY.lastIndex, depth = 0, q = null;
    for (; i < code.length; i++) {
      const c = code[i];
      if (q) { if (c === q) q = null; continue; }
      if (c === '"' || c === "'") { q = c; continue; }
      if (c === '{' || c === '[') depth++;
      if (c === '}' || c === ']') { if (depth === 0) break; depth--; }
      if (c === ',' && depth === 0) break;
    }
    out.push({ key, value: code.slice(KEY.lastIndex, i).trim() });
    KEY.lastIndex = i;
  }
  return out;
}
function actionRefs(text) {
  const lines = text.split('\n');
  const code = lines.map(stripComment);
  // 1. blank out block-scalar bodies
  const dead = new Array(lines.length).fill(false);
  for (let i = 0; i < code.length; i++) {
    if (!/:\s*[|>][-+]?\s*$/.test(code[i])) continue;
    const base = /^\s*/.exec(code[i])[0].length;
    for (let j = i + 1; j < code.length; j++) {
      if (!code[j].trim()) { dead[j] = true; continue; }
      if (/^\s*/.exec(code[j])[0].length <= base) break;
      dead[j] = true;
    }
  }
  // 2/3. every uses: key, with its value on its line or the next
  const refs = [];
  for (let i = 0; i < lines.length; i++) {
    if (dead[i] || !code[i].trim()) continue;
    const indent = /^\s*/.exec(code[i])[0].length;
    for (const { key, value } of pairsOnLine(lines[i])) {
      if (key !== 'uses') continue;
      let v = value.trim();
      if (/^["']/.test(v)) v = v.replace(/^["']|["']$/g, '');
      if (v === '') {
        // the value is on the next, more-indented line (and that line is not itself a key: value)
        const n = i + 1;
        if (n >= lines.length || dead[n] || /^\s*/.exec(code[n])[0].length <= indent) throw new Error(`uses has no value at line ${i + 1}`);
        v = code[n].trim().replace(/^["']|["']$/g, '');
      }
      if (!v || v.startsWith('{')) throw new Error(`cannot read the uses value at line ${i + 1}: ${lines[i].trim()}`);
      // the release tag lives in the line's comment -- whether it follows the value or the closing brace of a flow
      // map (`{ uses: x@sha }  # v7.0.1` / `{ uses: x@sha  # v7.0.1 }`): one comment on a line with one uses: names it
      // the tag itself is the first token of the comment: `# v7.0.1`, `# v6.1.0, with: { path: x }`, `# v7.0.1 }`
      const comment = /#\s*(v\S+)/.exec(lines[i]);
      refs.push(Object.assign(pin(v), { comment: comment ? comment[1].replace(/[},;\]]+$/, '') : '' }));
    }
  }
  return refs;
}

// The events named by the document's top-level `on:` value -- in the spellings a workflow uses: a block mapping
// (`on:\n  push:`), a block sequence (`on:\n  - push`), a flow mapping (`on: {push: …, pull_request: …}`), a flow
// sequence (`on: [push, pull_request]`) and a scalar (`on: push`).
function onEvents(text) {
  const lines = text.split('\n').map(stripComment);
  const ev = new Set();
  let inOn = false;
  for (const l of lines) {
    if (!l.trim()) continue;
    const indent = /^\s*/.exec(l)[0].length;
    const top = /^\s*["']?on["']?\s*:\s*(.*)$/.exec(l);
    if (top && indent === 0) {
      const value = top[1].trim();
      inOn = true;
      const seq = /^\[(.*)\]$/.exec(value);
      if (seq) for (const t of seq[1].split(',')) { const v = t.trim().replace(/^["']|["']$/g, ''); if (v) ev.add(v); }
      const map = /^\{(.*)\}$/.exec(value);
      if (map) for (const t of splitFlow(map[1])) { const k = /^\s*["']?([A-Za-z_][\w.-]*)["']?\s*:/.exec(t); if (k) ev.add(k[1]); }
      if (value && !seq && !map) for (const t of value.split(/\s+/)) ev.add(t.replace(/^["']|["']$/g, ''));
      continue;
    }
    if (inOn) {
      if (indent === 0) { inOn = false; continue; }      // the next top-level key ends `on:`
      // a block sequence item (- push) or a block mapping key (push:)
      const m = /^\s*(?:-\s*)?["']?([A-Za-z_][\w.-]*)["']?\s*:?/.exec(l);
      if (m) ev.add(m[1]);
    }
  }
  return ev;
}

// Permissions, as the blocks a workflow may carry. A per-job `permissions:` block (indented under jobs:) must not be
// read as the workflow's, in either direction: a job-level write under a workflow-level read is still a workflow
// whose default is read, and a job-level read under a workflow-level write must not make the file look read-only.
// `permissions: write-all` / `read-all` and an inline flow map are read too. Inside a block, blank and comment lines
// are skipped (this repo's YAML is heavily commented), and anything that is not a `key: value` pair -- a sibling
// top-level key, `jobs:` -- ends it.
const readOnly = (perms) => !!perms && Object.entries(perms).every(([k, v]) => (k === '*' ? v === 'read-all' : v === 'read'));

// EVERY permissions block in the workflow, the workflow-level one and each job's -- as [{ indent, map }]. GitHub
// resolves a job-level block OVER the workflow-level one, so a workflow whose top level says `contents: read` still
// runs a job with a write token if that job grants it; a check of the top level alone proves nothing about the jobs.
function permissionBlocks(text) {
  const lines = text.split('\n').map(stripComment);
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)permissions\s*:\s*(.*)$/.exec(lines[i]);
    if (!m) continue;
    const base = m[1].length, value = m[2].trim(), map = {};
    if (/^(write-all|read-all)$/.test(value)) map['*'] = value;
    else {
      const flow = /^\{(.*)\}$/.exec(value);
      if (flow) for (const t of splitFlow(flow[1])) { const kv = /^\s*["']?([\w-]+)["']?\s*:\s*["']?([\w-]+)["']?/.exec(t); if (kv) map[kv[1]] = kv[2]; }
      else for (let j = i + 1; j < lines.length; j++) {
        const l = lines[j];
        if (!l.trim()) continue;
        const ind = /^\s*/.exec(l)[0].length;
        if (ind <= base) break;
        const kv = /^\s*["']?([\w-]+)["']?\s*:\s*["']?([\w-]+)["']?\s*$/.exec(l);
        if (!kv) break;
        map[kv[1]] = kv[2];
      }
    }
    out.push({ indent: base, map });
  }
  return out;
}
// The workflow-level block alone (indent 0); null when the workflow grants nothing by default.
const permissionsOf = (text) => { const b = permissionBlocks(text).find((x) => x.indent === 0); return b ? b.map : null; };

// The job keys the workflow defines: the keys directly under a top-level `jobs:`, each at one indent.
function jobKeys(text) {
  const lines = text.split('\n').map(stripComment);
  const keys = [];
  let inJobs = false, jobIndent = null;
  for (const l of lines) {
    if (!l.trim()) continue;
    const top = /^jobs\s*:\s*(.*)$/.exec(l);
    if (top) { inJobs = true; continue; }
    if (!inJobs) continue;
    const indent = /^\s*/.exec(l)[0].length;
    if (indent === 0) { inJobs = false; continue; }
    const m = /^\s*["']?([\w-]+)["']?\s*:\s*$/.exec(l);
    if (!m) continue;
    if (jobIndent === null) jobIndent = indent;
    if (indent === jobIndent) keys.push(m[1]);
  }
  return keys;
}
// Each job's `name:` value, keyed by job key -- a STEP's `name:` is not a job name, and a step named "gates" must not
// stand in for the job that fails the run.
function jobNames(text) {
  const lines = text.split('\n').map(stripComment);
  const out = {};
  let inJobs = false, jobIndent = null, job = null;
  for (const l of lines) {
    if (!l.trim()) continue;
    if (/^jobs\s*:\s*/.test(l)) { inJobs = true; continue; }
    if (!inJobs) continue;
    const indent = /^\s*/.exec(l)[0].length;
    if (indent === 0) { inJobs = false; continue; }
    if (jobIndent === null) jobIndent = indent;
    if (indent === jobIndent) { const k = /^\s*["']?([\w-]+)["']?\s*:\s*$/.exec(l); job = k ? k[1] : null; continue; }
    if (job && indent === jobIndent + 2) {
      const n = /^\s*name\s*:\s*(.+)$/.exec(l);
      if (n) out[job] = n[1].trim().replace(/^["']|["']$/g, '');
    }
  }
  return out;
}

// Every action reference in a workflow, found STRUCTURALLY (see the reader at the top of this file):
//   - a quoted key is a key (`- "uses": x@v1`, `- {"uses": x@v1}`);
//   - a value may be on the same line or the next;
//   - a `uses:` inside a `run: |` body is script text, not an action, and is not read.
// Each is returned as { target, ref, comment }, with the tag comment beside the value when there is one.
function usesOf(text) {
  return actionRefs(text);
}
// A `target@ref`, with the ref taken after the LAST '@' (`github.ref` is not a pin).
const pin = (target, comment) => { const at = target.lastIndexOf('@'); return { target, ref: at < 0 ? '' : target.slice(at + 1), comment: (comment || '').trim() }; };
const verdictOf = (u) => {
  if (u.target.includes('${{')) return 'expression';
  if (u.target.startsWith('./')) return 'local';
  if (u.target.startsWith('docker://')) return 'image';
  if (!/^[0-9a-f]{40}$/.test(u.ref)) return 'not-a-sha';
  if (!/^v\d+(\.\d+){0,2}$/.test(u.comment)) return 'no-tag-comment';
  return 'pinned';
};
// A `uses:` naming a file in THIS repository (`./.github/workflows/tests.yml`): a reusable workflow called in place.
// There is no SHA to pin it to -- it is the same commit as the caller by definition, which is stronger than a pin --
// but it must name a file that exists and is a reusable workflow (its `on:` accepts workflow_call), or the call is a
// broken reference that fails only when a tag is pushed. Returns null for a pinned action.
const ROOT = path.join(__dirname, '..');
function reusableTarget(u) {
  if (verdictOf(u) !== 'local') return null;
  const rel = u.target.replace(/^\.\//, '');
  const file = path.join(ROOT, rel);
  if (!fs.existsSync(file)) return { rel, problem: `no such file in this repository: ${rel}` };
  const text = fs.readFileSync(file, 'utf8');   // onEvents() strips comments per line itself
  if (!onEvents(text).has('workflow_call')) return { rel, problem: `${rel} is called as a reusable workflow but its on: does not accept workflow_call` };
  return { rel, problem: null };
}

// Every file that may hold an action reference: the workflows, and any composite action under .github/actions/
// (action.yml / action.yaml, whose runs.steps may themselves use actions). None exists today; a new one is read the
// same way, so it cannot arrive unpinned and unnoticed.
const ACTIONS = path.join(__dirname, '..', '.github', 'actions');
function actionFiles(dir = ACTIONS, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) actionFiles(p, out);
    else if (/^action\.ya?ml$/.test(e.name)) out.push(p);
  }
  return out;
}
const composites = actionFiles();
check('there are workflows to check', files.length >= 2, files.join(', '));
// A reader that finds nothing would pass every file. Each workflow must yield at least one action reference, and the
// total must be at least the count the files are known to hold: a dropped or newly invisible `uses:` fails here.
const MIN_USES = 23;   // tests.yml 13 + release.yml 7 + pages.yml 3, measured when they were pinned
{
  let total = 0;
  for (const f of files) {
    const text = read(f);
    const refs = usesOf(text);
    total += refs.length;
    check(`${f}: every action reference is read (at least one)`, refs.length >= 1, `${refs.length} found`);
    check(`${f}: pull_request_target is not a trigger (it runs the base repository's token against contributor code)`,
      !onEvents(text).has('pull_request_target'), [...onEvents(text)].join(', '));
    for (const u of refs) {
      const local = reusableTarget(u);
      if (local) {
        check(`${f}: ${u.target} names a reusable workflow in this repository`, local.problem === null, local.problem || local.rel);
        continue;
      }
      check(`${f}: ${u.target} is pinned to a commit SHA with its tag in a comment`, verdictOf(u) === 'pinned',
        `${verdictOf(u)}${u.comment ? ' (comment: ' + u.comment + ')' : ''}`);
    }
  }
  for (const p of composites) {
    const refs = usesOf(fs.readFileSync(p, 'utf8'));
    for (const u of refs) {
      check(`${path.relative(path.join(__dirname, '..'), p)}: ${u.target} is pinned to a commit SHA with its tag in a comment`,
        verdictOf(u) === 'pinned', `${verdictOf(u)}${u.comment ? ' (comment: ' + u.comment + ')' : ''}`);
    }
    check(`${path.relative(path.join(__dirname, '..'), p)}: its action references are read`, true, `${refs.length} found`);
  }
  check(`every workflow's action references are found in total (at least ${MIN_USES})`, total >= MIN_USES, `${total} found`);
}

// One action, one version. An action used in two workflows with two different pins is a bump applied to one file and
// not the other (or a tag comment that was not updated with the SHA): each pin is a valid SHA with a valid tag
// comment, so the per-reference check above passes both, and the mismatched workflows drift apart silently (one runs
// the old action, one the new). Read across EVERY file, keyed by the repository the action comes from -- a vendored
// action (`./...`) has no version to agree on.
function actionVersions(texts) {
  const byAction = new Map();
  for (const [f, text] of texts) for (const u of usesOf(text)) {
    if (verdictOf(u) !== 'pinned') continue;
    const at = u.target.lastIndexOf('@'), repo = u.target.slice(0, at).toLowerCase();
    if (!byAction.has(repo)) byAction.set(repo, []);
    byAction.get(repo).push({ file: f, sha: u.ref, tag: u.comment });
  }
  return byAction;
}
// THE RULE, in one place, so the check and its own test cannot drift apart: an action disagrees with itself when its
// uses do not all carry the SAME (SHA, tag) pair. Both halves matter -- a SHA bumped without its tag comment leaves a
// reader believing the old version, which is the same lie as an unapplied bump -- so a pair, not just the SHA.
function disagreements(byAction) {
  const out = [];
  for (const [repo, uses] of byAction) {
    const pins = new Set(uses.map((u) => `${u.sha} # ${u.tag}`));
    if (pins.size > 1) out.push(`${repo}: ${uses.map((u) => `${u.file}@${u.tag}`).join(' vs ')}`);
  }
  return out;
}
{
  const byAction = actionVersions(files.map((f) => [f, read(f)]));
  const disagree = disagreements(byAction);
  check('every action is pinned to one SHA and tag everywhere it is used (a bump applied to one workflow and not another)',
    disagree.length === 0, disagree.join(' | ') || `${byAction.size} actions`);
  // ...and the rule BITES, through the same function the real check calls: two SHAs for one action is a disagreement,
  // one SHA in both is not, a SHA bumped while its tag comment is not is a disagreement, and three uses split 2-1 is a
  // disagreement too (the size is 2, which a check written `> 2` would call consistent).
  const S1 = '1'.repeat(40), S2 = '2'.repeat(40), S3 = '3'.repeat(40);
  const group = (uses) => new Map([['actions/cache', uses.map(([sha, tag], i) => ({ file: `${i}.yml`, sha, tag }))]]);
  const cases = [
    ['one SHA and tag everywhere', group([[S1, 'v6.1.0'], [S1, 'v6.1.0']]), 0],
    ['a bump applied to one file and not another', group([[S1, 'v6.1.0'], [S2, 'v6.0.0']]), 1],
    ['a SHA bumped and its tag comment left behind', group([[S1, 'v6.1.0'], [S1, 'v6.0.0']]), 1],
    ['three uses split two to one', group([[S1, 'v6.1.0'], [S1, 'v6.1.0'], [S2, 'v6.0.0']]), 1],
  ];
  const bad = cases.filter(([, g, want]) => disagreements(g).length !== want);
  check('...and it calls exactly these one pin, two pins, a stale tag comment and a 2-1 split what they are',
    bad.length === 0, bad.map(([n, , w]) => `${n} (wanted ${w})`).join(' | '));
}

// ---- the readers' own blind spots, each a shape that would ship an unpinned action or a dangerous trigger green ----
{
  const cases = [
    ['a branch pin', '- uses: actions/checkout@main', 'not-a-sha'],
    ['a shorthand version tag', '- uses: actions/checkout@v7', 'not-a-sha'],
    ['a full tag name, not a SHA', '- uses: actions/checkout@v7.0.1', 'not-a-sha'],
    ['a short SHA', '- uses: actions/checkout@3d3c42e', 'not-a-sha'],
    ['a SHA with no tag comment', '- uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1', 'no-tag-comment'],
    ['a SHA with a non-tag comment', '- uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1  # main', 'no-tag-comment'],
    ['a pinned action', '- uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1  # v7.0.1', 'pinned'],
    ['an indented pinned step', '        uses: actions/cache@55cc8345863c7cc4c66a329aec7e433d2d1c52a9  # v6.1.0', 'pinned'],
    ['a flow-map step', '- { uses: actions/checkout@v7 }', 'not-a-sha'],
    ['a flow-map step with more keys', '- { name: x, uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1  # v7.0.1 }', 'pinned'],
    ['a local action', '- uses: ./.github/actions/local', 'local'],
  ];
  const bad = cases.filter(([, line, want]) => { const u = usesOf(line + '\n')[0]; return !u || verdictOf(u) !== want; });
  check('the pin reader reads every shape, and rejects every unpinned spelling', bad.length === 0,
    bad.map(([n, , w]) => `${n} (wanted ${w})`).join(' | '));
  // A local target is a reusable workflow only when the FILE says so: a call to a file that does not exist, or to one
  // whose on: has no workflow_call, is a reference that fails only when a release is pushed (release.yml calls
  // tests.yml). verdictOf() alone calls both "local" and would pass them.
  {
    const miss = reusableTarget({ target: './.github/workflows/tests-y.yml', ref: '', comment: '' });
    check('a local target that names no file in the repository is refused', miss && /no such file/.test(miss.problem || ''), JSON.stringify(miss));
    const notReusable = reusableTarget({ target: './.github/workflows/release.yml', ref: '', comment: '' });
    check('a local target whose file does not accept workflow_call is refused', notReusable && /workflow_call/.test(notReusable.problem || ''), JSON.stringify(notReusable));
    const good = reusableTarget({ target: './.github/workflows/tests.yml', ref: '', comment: '' });
    check('...and release.yml\'s call to tests.yml is a real reusable workflow', good && good.problem === null, JSON.stringify(good));
    // a pinned action is not a local target at all, so the same function must not judge it
    check('...while a pinned action is not a reusable target and is left to the SHA check', reusableTarget({ target: 'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1', ref: '3d3c42e5aac5ba805825da76410c181273ba90b1', comment: 'v7.0.1' }) === null);
  }
  // A step converted to flow style is still found: an unpinned action must not become invisible by changing the
  // spelling of the step it sits in. Both the inline comment and the one after the closing brace name the tag.
  {
    const flow = [
      ['- { uses: actions/checkout@v7 }', 'not-a-sha'],
      ['- { name: x, uses: actions/cache@v4 }', 'not-a-sha'],
      ['- { name: x, uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1  # v7.0.1 }', 'pinned'],
      ['- { uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 }  # v7.0.1', 'pinned'],
      // a flow step that carries its own flow map: the inner braces must not be mistaken for the step's end
      ['- { name: x, uses: actions/checkout@v7, with: { fetch-depth: 0 } }', 'not-a-sha'],
      ['- { uses: actions/cache@v4, with: { path: x, key: y } }', 'not-a-sha'],
      ['- { uses: actions/cache@55cc8345863c7cc4c66a329aec7e433d2d1c52a9  # v6.1.0, with: { path: x } }', 'pinned'],
      // a brace in the TRAILING comment must not be taken for the step's end (the round-3 regression)
      ['- { uses: actions/checkout@v7 }  # pinned per {org}/{repo}', 'not-a-sha'],
      ['- { uses: actions/checkout@v7 }  # pinned: ${{ matrix.node }}', 'not-a-sha'],
      // a '}' inside a quoted value is not the step's end either
      ['- { uses: actions/checkout@v7, with: { body: "a}b" } }', 'not-a-sha'],
    ];
    const missed = flow.filter(([line, want]) => { const u = usesOf(line + '\n')[0]; return !u || verdictOf(u) !== want; });
    check('a flow-style step is read like a block one, pinned or not, with or without its own with: map', missed.length === 0,
      missed.map(([l, w]) => `${l} (wanted ${w})`).join(' | '));
  }
  // and it finds EVERY uses:, not only the first, in a mix of block and flow steps
  const many = usesOf('- uses: actions/checkout@v7\n- { uses: actions/cache@v4 }\n- uses: actions/setup-node@v7\n');
  check('the reader sees every uses: in a file, block and flow alike',
    many.length === 3 && many.every((u) => verdictOf(u) === 'not-a-sha'), JSON.stringify(many.map((u) => u.target)));
}

// The trigger reader: every spelling of `on:` a workflow uses, and never the word inside a comment or a value.
{
  const cases = [
    ['a block trigger', 'on:\n  push:\n  pull_request_target:\n', true],
    ['a block sequence', 'on:\n  - push\n  - pull_request_target\n', true],
    ['a flow sequence', 'on: [push, pull_request_target]\n', true],
    ['a flow mapping', 'on: {push: null, pull_request_target: {branches: [main]}}\n', true],
    ['a single scalar', 'on: pull_request_target\n', true],
    ['a quoted key', 'on:\n  "pull_request_target":\n', true],
    ['a comment only', '# pull_request_target is never used\non:\n  push:\n', false],
    ['a run block mentioning it', 'on:\n  push:\nsteps:\n  - run: echo pull_request_target: yes\n', false],
    ['the safe sibling', 'on:\n  push:\n  pull_request:\n', false],
  ];
  const bad = cases.filter(([, src, want]) => onEvents(src).has('pull_request_target') !== want);
  check('the trigger reader finds pull_request_target in every spelling and nowhere else', bad.length === 0,
    bad.map(([n]) => n).join(' | '));
}

// The permissions reader: read-only means nothing but read, in every spelling -- and only the WORKFLOW-level block.
{
  const cases = [
    ['read-only block', 'permissions:\n  contents: read\n', true],
    ['read-only flow', 'permissions: {contents: read}\n', true],
    ['read-all', 'permissions: read-all\n', true],
    ['a second write scope', 'permissions:\n  contents: read\n  actions: write\n', false],
    ['a commented second write scope', 'permissions:\n  contents: read\n  # why\n  actions: write\n', false],
    ['a blank-separated second write scope', 'permissions:\n  contents: read\n\n  actions: write\n', false],
    ['write-all', 'permissions: write-all\n', false],
    ['no permissions key', 'name: x\n', false],
    ['a job-level write under a workflow read', 'permissions:\n  contents: read\njobs:\n  a:\n    permissions:\n      contents: write\n', true],
    ['a job-level read under a workflow write', 'permissions:\n  contents: write\njobs:\n  a:\n    permissions:\n      contents: read\n', false],
    // the workflow-level map is right in both of these; the JOBS are what the every-block check must catch
    ['a workflow read with one job granting write', 'permissions:\n  contents: read\njobs:\n  a:\n    permissions:\n      contents: write\n', true],
  ];
  const bad = cases.filter(([, src, want]) => readOnly(permissionsOf(src)) !== want);
  check('the permissions reader accepts only read-only, sees a commented or blank-separated scope, and ignores job-level blocks',
    bad.length === 0, bad.map(([n]) => n).join(' | '));
  // ...and every block, jobs included, must be read-only: a job-level write under a workflow-level read is a token
  // that can push (GitHub resolves the job's block over the workflow's)
  {
    const perJob = ['permissions:\n  contents: read\njobs:\n  a:\n    permissions:\n      contents: write\n',
                    'permissions:\n  contents: read\njobs:\n  a:\n    permissions: {actions: write}\n'];
    const missed = perJob.filter((src) => permissionBlocks(src).every((b) => readOnly(b.map)));
    check('a job-level write is caught by the every-block check (the workflow-level read alone cannot see it)', missed.length === 0,
      `${missed.length} of ${perJob.length} not caught`);
    // and the check that uses it on tests.yml really looks at every block, not only the first
    const blocks = permissionBlocks('permissions:\n  contents: read\njobs:\n  a:\n    permissions:\n      contents: read\n  b:\n    permissions:\n      contents: read\n');
    check('...and every permissions block in a file is found, not only the first', blocks.length === 3, `${blocks.length} blocks`);
  }
  // and a later jobs: block is not read as part of permissions (the shape that once hid `actions: write`)
  const crossed = permissionsOf('permissions:\n  contents: read\n\njobs:\n  a:\n    name: b\n');
  check('...and the permissions block ends at a top-level key, not at jobs:', crossed && !('name' in crossed), JSON.stringify(crossed));
}

// The triggers and permissions the workflow that runs contributor code must keep.
{
  const tests = read('tests.yml');
  check('tests.yml runs on pull_request (and never pull_request_target)',
    onEvents(tests).has('pull_request') && !onEvents(tests).has('pull_request_target'), [...onEvents(tests)].join(', '));
  // Read-only everywhere, with NO exception: the site deploy used to live here and needed pages/id-token write, which
  // is exactly why it was moved to pages.yml (a called workflow may not grant more than its caller). A write scope
  // arriving in this file is now a failure with nothing to work around.
  check('tests.yml grants nothing but contents: read, at the workflow level and in every job',
    permissionBlocks(tests).length > 0 && permissionBlocks(tests).every((b) => readOnly(b.map)),
    JSON.stringify(permissionBlocks(tests)));
  // The job names the PR template, CONTRIBUTING and docs/development.md name must be the ones the workflow really
  // runs. Read from each JOB's own `name:`, keyed by its job key -- a step named "gates" is not the gates job.
  const names = Object.values(jobNames(tests));
  const keys = jobKeys(tests);
  check('the job keys are read from under jobs:', keys.includes('suites') && keys.includes('gates') && keys.includes('pages'), keys.join(' | '));
  for (const job of ['browser-check shards are complete', 'gates']) {
    check(`tests.yml has a job named "${job}" (the docs and the PR template name it)`, names.includes(job), names.join(' | '));
  }
  check('tests.yml names a "node tests/all.js <part>" job family (tests/all.js --shard i/n)', names.some((n) => /^node tests\/all\.js \$\{\{\s*matrix\.shard\s*\}\}$/.test(n)),
    names.join(' | '));
  check('tests.yml names a "browser check <shard>" job family', names.some((n) => /^browser check \$\{\{\s*matrix\.shard\s*\}\}$/.test(n)),
    names.filter((n) => /browser check/.test(n)).join(' | '));
  // A RE-RUN must never cancel: cancelling the newest head's run on behalf of an older commit's re-run takes away
  // the run whose `gates` job is the answer being waited for. The condition is read, not assumed.
  {
    // per LINE: stripComment reads one line, and passing it a whole file would treat the document as one line
    const expr = (text) => { const m = /^\s*cancel-in-progress:\s*(.+)$/m.exec(text.split('\n').map(stripComment).join('\n')); return m ? m[1].trim() : null; };
    const e = expr(tests);
    // The property: no input can make a RE-RUN cancel. A `||` in the condition is what breaks it -- one disjunct
    // that ignores run_attempt is enough to cancel the newest head's run on behalf of an older commit's re-run,
    // which takes away the run whose `gates` job is being waited for. So the condition must carry the attempt guard
    // and must not OR anything around it. (Checking only for the substring `run_attempt == 1` passed the old
    // expression, which had it behind a `||`.)
    check('tests.yml cancels only on a first attempt (a re-run never cancels another run)',
      !!e && /run_attempt\s*==\s*1/.test(e) && !/\|\|/.test(e), String(e));
    // and the reader bites, on both shapes that break it: no guard at all, and the guard ORed around
    const bad = [
      'concurrency:\n  cancel-in-progress: ${{ github.ref != \'refs/heads/main\' }}\n',
      'concurrency:\n  cancel-in-progress: ${{ github.event_name == \'pull_request\' || (github.ref != \'refs/heads/main\' && github.run_attempt == 1) }}\n',
    ];
    const missed = bad.filter((t) => { const x = expr(t); return !!x && /run_attempt\s*==\s*1/.test(x) && !/\|\|/.test(x); });
    check('...and neither an unguarded nor an ORed-around condition passes', missed.length === 0, `${missed.length} of ${bad.length} passed`);
  }
  // a step's name: is not a job's: a workflow whose only "gates" is a step must not satisfy the check above
  {
    const trap = 'jobs:\n  a:\n    name: run\n    steps:\n      - name: gates\n        run: echo\n';
    check('...and a step named "gates" is not read as the gates job', !Object.values(jobNames(trap)).includes('gates'), JSON.stringify(jobNames(trap)));
  }
}

// The gates job is what turns the parts into one verdict, so its wiring is held here: it needs every job it judges,
// runs the all.js completeness check on the parts' logs (the only thing that catches a planning bug that drops a
// suite while every part passes), requires each needed job's success, and exits with the status it collected.
// Each rule is read from the gates job's own lines, comments stripped; the mutants below show each one can fail.
function gatesProblems(text) {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => /^  gates:\s*$/.test(l));
  if (start < 0) return ['no gates job'];
  let end = lines.findIndex((l, i) => i > start && /^ {2}\S/.test(l));
  if (end < 0) end = lines.length;
  const body = lines.slice(start + 1, end).map(stripComment).filter((l) => l.trim()).map((l) => l.trim());
  const has = (re) => body.some((l) => re.test(l));
  const problems = [];
  const needs = (body.find((l) => /^needs:/.test(l)) || '').replace(/^needs:\s*/, '');
  const needed = needs.replace(/[[\]\s]/g, '').split(',').filter(Boolean).sort().join(',');
  if (needed !== 'pages,shards,suites') problems.push(`needs is [${needed}], not [shards, suites, pages]`);
  if (!has(/^node \.github\/scripts\/suite-shards\.js counts\/all-\*\.log \|\| status=1$/)) problems.push('does not run suite-shards.js on counts/all-*.log with || status=1');
  for (const job of ['shards', 'suites', 'pages']) {
    if (!has(new RegExp(`^test "\\$\\{\\{ needs\\.${job}\\.result \\}\\}" = success \\|\\| status=1$`))) problems.push(`does not require needs.${job}.result == success`);
  }
  if (!has(/^test "\$have" = "\$want" \|\| status=1$/)) problems.push('does not require every browser shard to have reported');
  const run = body.filter((l) => !/^(- |uses:|with:|name:|if:|path:|pattern:|merge-multiple:|if-no-files-found:|node-version:)/.test(l));
  if (!body.includes('exit $status')) problems.push('does not end its summary step with exit $status');
  else if (run.indexOf('exit $status') < run.findIndex((l) => /suite-shards\.js/.test(l))) problems.push('exit $status comes before the checks');
  return problems;
}
{
  const tests = read('tests.yml');
  const real = gatesProblems(tests);
  check('the gates job needs every job, runs the all.js completeness check, requires each success and exits with the status', real.length === 0, real.join(' | '));
  const mutants = {
    'M6: a job dropped from needs': (t) => t.replace('needs: [shards, suites, pages]', 'needs: [shards, pages]'),
    'M7: the suites result not required': (t) => t.replace(/^ *test "\$\{\{ needs\.suites\.result \}\}" = success \|\| status=1\n/m, ''),
    'M8: the completeness check not run': (t) => t.replace(/^ *node \.github\/scripts\/suite-shards\.js counts\/all-\*\.log \|\| status=1\n/m, ''),
    'the completeness check run without || status=1': (t) => t.replace('counts/all-*.log || status=1', 'counts/all-*.log || true'),
    'the browser shard count not required': (t) => t.replace('test "$have" = "$want" || status=1', 'test "$have" = "$want" || true'),
    'no exit $status': (t) => t.replace(/^ *exit \$status\n/m, ''),
  };
  for (const [what, mutate] of Object.entries(mutants)) {
    const m = mutate(tests);
    check(`...and fails on ${what}`, m !== tests && gatesProblems(m).length > 0, gatesProblems(m).join(' | '));
  }
}

// The updater that keeps the pins fresh is present, watches github-actions, and runs weekly.
{
  const dep = fs.existsSync(path.join(__dirname, '..', '.github', 'dependabot.yml'))
    ? fs.readFileSync(path.join(__dirname, '..', '.github', 'dependabot.yml'), 'utf8') : '';
  check('dependabot.yml exists for github-actions, weekly',
    /package-ecosystem:\s*github-actions/.test(dep) && /interval:\s*weekly/.test(dep));
}

console.log(fail ? `${fail} FAILED` : 'all passed');
process.exitCode = fail ? 1 : 0;
