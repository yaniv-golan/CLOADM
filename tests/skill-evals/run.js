#!/usr/bin/env node
// The skill's evals: each case in this folder (prompt.md, case.yaml, graders/*.md, files/ — the layout
// `claude plugin eval` reads) run by a Claude Code agent with the CLOADM MCP server, twice: with the skill
// (skills/cloadm copied into the run's project as .claude/skills/cloadm) and without it. Both arms have the same
// server and tools, so the difference is the skill alone. (`claude plugin eval`'s own baseline drops the whole
// plugin, server included, which would test the tools rather than the skill.) Then a judge model grades each
// grader statement against the run's trace, and the results go to a workspace outside the repository.
//
// These are real, billed model runs, so this is not part of tests/all.js. It needs the `claude` CLI, logged in.
//
//   node tests/skill-evals/run.js [--out DIR] [--model M] [--judge-model M] [--case NAME]... [--arm with_skill|without_skill] [--runs N] [-j N]
//   node tests/skill-evals/run.js --regrade --out DIR     # grade the runs already in DIR again, with the graders as they are now
//
// Only the project's own programs are used (LIZA, assembled code, the files in a case's files/); no ROMs are given
// to the server, so every machine runs the built-in firmware.
'use strict';
const fs = require('fs'), os = require('os'), path = require('path'), zlib = require('zlib');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const HERE = __dirname;
const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : dflt; };
const many = (name) => args.flatMap((a, i) => (a === name ? [args[i + 1]] : []));
const OUT = path.resolve(opt('--out', path.join(os.tmpdir(), `cloadm-skill-evals-${Date.now()}`)));
const MODEL = opt('--model', 'claude-sonnet-5-5');
const JUDGE = opt('--judge-model', 'claude-sonnet-5-5');
const JOBS = Number(opt('-j', '4'));
const ARMS = many('--arm').length ? many('--arm') : ['with_skill', 'without_skill'];
const REGRADE = args.includes('--regrade');
const RUNS = Number(opt('--runs', '2'));
const CASES = fs.readdirSync(HERE, { withFileTypes: true }).filter((d) => d.isDirectory() && fs.existsSync(path.join(HERE, d.name, 'prompt.md')))
  .map((d) => d.name).filter((n) => !many('--case').length || many('--case').includes(n)).sort();

function readCase(name) {
  const dir = path.join(HERE, name);
  const md = fs.readFileSync(path.join(dir, 'prompt.md'), 'utf8');
  const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(md);
  const settings = m[1], prompt = m[2].trim();
  const maxTurns = Number((/max_turns: (\d+)/.exec(settings) || [])[1] || 40);
  const timeout = Number((/timeout_seconds: (\d+)/.exec(settings) || [])[1] || 900);
  const graders = fs.readdirSync(path.join(dir, 'graders')).filter((f) => f.endsWith('.md')).sort()
    .map((f) => fs.readFileSync(path.join(dir, 'graders', f), 'utf8').replace(/^---\n[\s\S]*?\n---\n/, '').trim());
  return { name, dir, prompt, maxTurns, timeout, graders };
}

function run(cmd, argv, { cwd, input, timeoutMs }) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const p = spawn(cmd, argv, { cwd, stdio: ['pipe', 'pipe', 'pipe'], env: process.env });
    let out = '', err = '';
    const timer = setTimeout(() => p.kill('SIGKILL'), timeoutMs);
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('close', (code) => { clearTimeout(timer); resolve({ code, out, err, ms: Date.now() - t0 }); });
    p.stdin.end(input || '');
  });
}

// One agent run: a fresh project directory with the media folder (the case's files in it) and, for the with-skill
// arm, the skill. Only project settings are read (no user skills or plugins), only the cloadm server is started.
async function agentRun(c, arm, k) {
  const runDir = path.join(OUT, c.name, arm, `run-${k}`);
  const proj = path.join(runDir, 'project'), media = path.join(proj, 'media');
  fs.mkdirSync(media, { recursive: true });
  if (fs.existsSync(path.join(c.dir, 'files'))) fs.cpSync(path.join(c.dir, 'files'), media, { recursive: true });
  // a case's setup.js makes the files that are built rather than kept (a binary from its source, a snapshot)
  if (fs.existsSync(path.join(c.dir, 'setup.js'))) {
    const s = await run(process.execPath, [path.join(c.dir, 'setup.js'), media], { cwd: media, timeoutMs: 60000 });
    if (s.code !== 0) throw new Error(`${c.name}/setup.js failed: ${s.err}`);
  }
  if (arm === 'with_skill') fs.cpSync(path.join(ROOT, 'skills', 'cloadm'), path.join(proj, '.claude', 'skills', 'cloadm'), { recursive: true });
  const mcp = path.join(runDir, 'mcp.json');
  fs.writeFileSync(mcp, JSON.stringify({ mcpServers: { cloadm: { command: process.execPath, args: [path.join(ROOT, 'cli', 'cloadm.js'), '--mcp', '--media-root', media] } } }));
  const prompt = `${c.prompt}\n\n(The emulator's media folder is ${media}.)`;
  const r = await run('claude', ['-p', prompt, '--model', MODEL, '--output-format', 'stream-json', '--verbose',
    '--mcp-config', mcp, '--strict-mcp-config', '--setting-sources', 'project',
    '--tools', 'Read,Glob,Grep,Skill', '--allowedTools', 'mcp__cloadm', 'Read', 'Glob', 'Grep', 'Skill',
    '--max-turns', String(c.maxTurns)], { cwd: proj, timeoutMs: c.timeout * 1000 });
  fs.writeFileSync(path.join(runDir, 'transcript.jsonl'), r.out);
  if (r.err) fs.writeFileSync(path.join(runDir, 'stderr.txt'), r.err);
  const events = r.out.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean);
  const trace = condense(events, runDir);
  fs.writeFileSync(path.join(runDir, 'trace.md'), trace.text);
  const result = events.find((e) => e.type === 'result') || {};
  const timing = { total_tokens: result.usage ? Object.values(result.usage).filter((v) => typeof v === 'number').reduce((a, b) => a + b, 0) : null,
    duration_ms: r.ms, total_duration_seconds: Math.round(r.ms / 100) / 10, num_turns: result.num_turns, cost_usd: result.total_cost_usd, exit: r.code };
  fs.writeFileSync(path.join(runDir, 'timing.json'), JSON.stringify(timing, null, 2));
  return { runDir, trace, timing };
}

// A run already in the workspace: its trace and timing, for grading again.
function regradeRun(c, arm, k) {
  const runDir = path.join(OUT, c.name, arm, `run-${k}`);
  const text = fs.readFileSync(path.join(runDir, 'trace.md'), 'utf8');
  return { runDir, trace: { text, skillUsed: /### call Skill\n\{"skill":"cloadm"/.test(text) }, timing: JSON.parse(fs.readFileSync(path.join(runDir, 'timing.json'), 'utf8')) };
}

// The trace a judge reads: every tool call with its input, every result (text cut to 1500 characters; an image as
// its size and the runner's own reading of it), the skill loads, and the final answer.
function condense(events, runDir) {
  const lines = [], shots = [];
  let skillUsed = false, n = 0;
  for (const e of events) {
    if (e.type === 'assistant') for (const b of e.message.content || []) {
      if (b.type === 'tool_use') { if (b.name === 'Skill') skillUsed = true; lines.push(`\n### call ${b.name}\n${JSON.stringify(b.input).slice(0, 4000)}`); }
      else if (b.type === 'text' && b.text.trim()) lines.push(`\n### assistant\n${b.text.trim()}`);
    }
    if (e.type === 'user') for (const b of e.message.content || []) {
      if (b.type !== 'tool_result') continue;
      const parts = Array.isArray(b.content) ? b.content : [{ type: 'text', text: String(b.content) }];
      for (const p of parts) {
        if (p.type === 'text') lines.push(`### result${b.is_error ? ' (error)' : ''}\n${p.text.slice(0, 1500)}`);
        else if (p.type === 'image') {
          const png = Buffer.from(p.source.data, 'base64'), file = path.join(runDir, `screenshot-${++n}.png`);
          fs.writeFileSync(file, png);
          const r = readShot(png);
          shots.push(r);
          lines.push(`### result: image ${path.basename(file)}, ${r.w}x${r.h}; the runner's reading of it: ${r.summary}`);
        }
      }
    }
    if (e.type === 'result') lines.push(`\n### final answer\n${e.result || '(none)'}`);
  }
  return { text: lines.join('\n'), skillUsed, shots };
}

// What the runner can tell from a screenshot without a model: the colours in the picture area and whether it is a
// checkerboard of square cells (any size from 2 to 32 pixels) in two colours.
function readShot(png) {
  let at = 8, w = 0, h = 0, ct = 6;
  const idat = [];
  while (at < png.length) {
    const len = png.readUInt32BE(at), type = png.toString('latin1', at + 4, at + 8), d = png.subarray(at + 8, at + 8 + len);
    if (type === 'IHDR') { w = d.readUInt32BE(0); h = d.readUInt32BE(4); ct = d[9]; }
    if (type === 'IDAT') idat.push(d);
    at += 12 + len;
  }
  const bpp = ct === 6 ? 4 : 3, raw = zlib.inflateSync(Buffer.concat(idat)), stride = w * bpp + 1;
  const scale = Math.max(1, Math.round(w / 320));
  const px = (x, y) => { const i = y * scale * stride + 1 + x * scale * bpp; return (raw[i] << 16) | (raw[i + 1] << 8) | raw[i + 2]; };
  const W = Math.round(w / scale), x0 = 32, y0 = 24, pw = 256, ph = 192;
  if (W !== 320) return { w, h, summary: 'not a 320-wide frame (a GIME mode?): no reading', checker: false };
  const colours = new Map();
  for (let y = y0; y < y0 + ph; y++) for (let x = x0; x < x0 + pw; x++) { const c = px(x, y); colours.set(c, (colours.get(c) || 0) + 1); }
  const top = [...colours.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([c, k]) => `#${c.toString(16).padStart(6, '0')} ${Math.round(k / (pw * ph) * 100)}%`);
  let checker = false, cell = 0;
  for (const s of [2, 4, 8, 16, 32]) {
    const a = px(x0, y0), b = px(x0 + s, y0);
    if (a === b) continue;
    let ok = true;
    for (let y = 0; y < ph && ok; y++) for (let x = 0; x < pw && ok; x++) ok = px(x0 + x, y0 + y) === (((Math.floor(x / s) + Math.floor(y / s)) & 1) ? b : a);
    if (ok) { checker = true; cell = s; break; }
  }
  return { w, h, checker, summary: `picture-area colours ${top.join(', ')}; ${checker ? `an exact two-colour checkerboard of ${cell}x${cell} cells over the whole 256x192 picture` : 'not an exact checkerboard over the whole picture'}` };
}

// A judge that gives no verdict (a malformed answer, a refusal) is asked again, twice at most.
async function judge(c, statement, trace) {
  let v;
  for (let i = 0; i < 3; i++) { v = await judgeOnce(c, statement, trace); if (!v.evidence.startsWith('judge gave no verdict')) break; }
  return v;
}
async function judgeOnce(c, statement, trace) {
  const prompt = `You grade one statement about what an AI agent did, from the trace of its run. The agent drove an emulator of a Dragon 64 / Tandy Color Computer through tools. Read the task, the trace and the statement. Decide whether the statement is true of this run. Be strict: if the trace does not show it, it is false. Answer with one line of JSON only: {"passed": true|false, "evidence": "<one or two sentences quoting or pointing to the trace>"}.

## Task given to the agent
${c.prompt}

## Statement
${statement}

## Trace
${trace.text.slice(-60000)}`;
  const r = await run('claude', ['-p', '--model', JUDGE, '--output-format', 'text', '--setting-sources', 'project', '--tools', '', '--strict-mcp-config'], { cwd: os.tmpdir(), input: prompt, timeoutMs: 300000 });
  // the verdict: the last line that parses as JSON with a "passed" field
  for (const line of r.out.split('\n').reverse()) {
    const s = line.trim().replace(/^```(json)?|```$/g, '');
    if (!s.startsWith('{')) continue;
    try { const j = JSON.parse(s); if ('passed' in j) return { text: statement, passed: j.passed === true, evidence: String(j.evidence || '') }; } catch (e) { /* not this line */ }
  }
  return { text: statement, passed: false, evidence: `judge gave no verdict: ${r.out.slice(0, 300)} ${r.err.slice(0, 300)}` };
}

async function pool(items, n, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (next < items.length) { const i = next++; out[i] = await fn(items[i]); } }));
  return out;
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const cases = CASES.map(readCase);
  const jobs = cases.flatMap((c) => ARMS.flatMap((arm) => Array.from({ length: RUNS }, (_, i) => ({ c, arm, k: i + 1 }))));
  console.log(`${jobs.length} runs (${cases.length} cases x ${ARMS.join(', ')} x ${RUNS}), model ${MODEL}, judge ${JUDGE}, into ${OUT}`);
  const runs = await pool(jobs, JOBS, async ({ c, arm, k }) => {
    fs.mkdirSync(path.join(OUT, c.name), { recursive: true });
    fs.writeFileSync(path.join(OUT, c.name, 'eval_metadata.json'), JSON.stringify({ eval_name: c.name, prompt: c.prompt, assertions: c.graders }, null, 2));
    const r = REGRADE ? regradeRun(c, arm, k) : await agentRun(c, arm, k);
    const expectations = await pool(c.graders, 3, (g) => judge(c, g, r.trace));
    const passed = expectations.filter((x) => x.passed).length;
    const grading = { expectations, summary: { passed, failed: expectations.length - passed, total: expectations.length, pass_rate: passed / expectations.length }, skill_loaded: r.trace.skillUsed, timing: r.timing };
    fs.writeFileSync(path.join(r.runDir, 'grading.json'), JSON.stringify(grading, null, 2));
    console.log(`${c.name.padEnd(20)} ${arm.padEnd(14)} run-${k} ${passed}/${expectations.length}${r.trace.skillUsed ? '  (skill loaded)' : ''}  ${r.timing.total_duration_seconds} s  ${r.timing.num_turns} turns  $${(r.timing.cost_usd || 0).toFixed(2)}`);
    return { name: c.name, arm, k, grading };
  });
  const table = ['| Case | ' + ARMS.join(' | ') + ' |', '|---|' + ARMS.map(() => '---|').join('')];
  for (const c of cases) table.push(`| ${c.name} | ` + ARMS.map((arm) => { const gs = runs.filter((x) => x.name === c.name && x.arm === arm).map((x) => x.grading); const loaded = gs.filter((g) => g.skill_loaded).length;
    const turns = gs.map((g) => g.timing.num_turns), secs = gs.map((g) => g.timing.total_duration_seconds);
    return `${gs.map((g) => `${g.summary.passed}/${g.summary.total}`).join(', ')}; turns ${turns.join(', ')}; ${secs.join(', ')} s${loaded ? `; skill loaded ${loaded}/${gs.length}` : ''}`; }).join(' | ') + ' |');
  const tot = (arm) => runs.filter((x) => x.arm === arm).reduce((s, x) => [s[0] + x.grading.summary.passed, s[1] + x.grading.summary.total], [0, 0]);
  table.push('| **all** | ' + ARMS.map((arm) => { const [p, t] = tot(arm); return `**${p}/${t}** (${Math.round(p / t * 100)}%)`; }).join(' | ') + ' |');
  fs.writeFileSync(path.join(OUT, 'summary.md'), table.join('\n') + '\n');
  console.log('\n' + table.join('\n'));
})();
