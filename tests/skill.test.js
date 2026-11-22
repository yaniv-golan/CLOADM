// The agent skill (skills/cloadm/, and its copy at .agents/skills/cloadm/ for agents that read skills from there):
// the copy is identical, byte for byte; the frontmatter follows the Agent Skills specification
// (https://github.com/agentskills/agentskills/blob/main/docs/specification.mdx: name 1-64 lowercase letters, digits
// and single hyphens, the parent folder's name; description 1-1024 characters; compatibility at most 500); every file
// it points at is there; it names every tool the MCP server has, and nothing it presents as a tool is not one (so a
// renamed or new tool makes this fail until the skill follows, AGENTS.md); the facts it states about the server are
// the server's (the built-in firmware's banner, the bundled programs); and its PMODE 4 recipe, run on the built-in
// firmware as the skill says to, draws what it says. Only the project's own firmware and programs.
// Run: node tests/skill.test.js
'use strict';
const fs = require('fs'), path = require('path'), zlib = require('zlib');

let fail = 0, n = 0;
const check = (name, cond, detail = '') => { n++; if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name}`); };
const ROOT = path.join(__dirname, '..');
const SKILL = path.join(ROOT, 'skills', 'cloadm'), COPY = path.join(ROOT, '.agents', 'skills', 'cloadm');

// ---------------- the copy is the same ----------------
function tree(dir) {
  const out = new Map();
  const walk = (d, rel) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const p = path.join(d, e.name), r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(p, r);
      else out.set(r, fs.readFileSync(p));
    }
  };
  walk(dir, '');
  return out;
}
const a = tree(SKILL), b = fs.existsSync(COPY) ? tree(COPY) : new Map();
const differ = [...new Set([...a.keys(), ...b.keys()])].filter((k) => !a.has(k) || !b.has(k) || !a.get(k).equals(b.get(k)));
check('.agents/skills/cloadm is an identical copy of skills/cloadm (cp -r skills/cloadm .agents/skills/)', a.size > 0 && differ.length === 0, differ.join(', '));

// ---------------- frontmatter ----------------
const text = fs.readFileSync(path.join(SKILL, 'SKILL.md'), 'utf8');
const fm = /^---\n([\s\S]*?)\n---\n/.exec(text);
const fields = {};
if (fm) for (const line of fm[1].split('\n')) { const m = /^([a-z-]+): (.*)$/.exec(line); if (m) fields[m[1]] = m[2]; }
check('SKILL.md starts with a frontmatter block', !!fm);
check('name: lowercase letters, digits and single hyphens, at most 64, the folder\'s name',
  /^[a-z0-9]+(-[a-z0-9]+)*$/.test(fields.name || '') && fields.name.length <= 64 && fields.name === path.basename(SKILL), fields.name);
check('description: 1-1024 characters, says when to use it and that it needs the cloadm tools',
  !!fields.description && fields.description.length <= 1024 && /whenever/i.test(fields.description) && /cloadm MCP tools/.test(fields.description), String((fields.description || '').length));
check('compatibility: at most 500 characters', !fields.compatibility || fields.compatibility.length <= 500);
check('only fields the specification knows', Object.keys(fields).every((k) => ['name', 'description', 'license', 'compatibility', 'metadata', 'allowed-tools'].includes(k)), Object.keys(fields).join(','));
const lines = text.split('\n').length;
check('SKILL.md stays short enough to load whole (under 500 lines)', lines < 500, String(lines));

// ---------------- it stops without the tools ----------------
check('SKILL.md tells the agent to stop when the cloadm tools are absent', /If there is none, \*\*stop\*\*/.test(text) && /docs\/mcp\.md/.test(text));

// ---------------- every file it points at exists ----------------
const all = [...a.entries()].filter(([k]) => k.endsWith('.md')).map(([, v]) => v.toString('utf8')).join('\n');
const refs = [...new Set([...all.matchAll(/`(references\/[a-z0-9-]+\.md)`/g)].map((m) => m[1]))];
check('every references/... file named exists', refs.length >= 3 && refs.every((r) => a.has(r)), refs.filter((r) => !a.has(r)).join(', '));
check('every reference file is named from SKILL.md', [...a.keys()].filter((k) => k.startsWith('references/')).every((k) => text.includes(`\`${k}\``)));

// ---------------- the tools it names are the server's ----------------
const M = require('../cli/mcp.js'), T = require('../js/mcp/tools.js'), { framePng } = require('../cli/cloadm.js');
const serverTools = T.createToolbox(M.nodeHost({ mediaRoot: null, roms: [], png: framePng }), {}).tools().map((t) => t.name);
const table = text.slice(text.indexOf('## The tools, by what they do'), text.indexOf('## The core loop'));
// the last cell of each table row holds the tool names
const named = table.split('\n').filter((l) => /^\| /.test(l) && !/^\| To\.\.\./.test(l)).flatMap((l) => [...l.slice(l.lastIndexOf('|', l.length - 2)).matchAll(/`([a-z_]+)`/g)].map((m) => m[1]));
const missing = serverTools.filter((t) => !named.includes(t)), extra = named.filter((t) => !serverTools.includes(t));
check('the skill\'s tool table names every tool the server has', missing.length === 0, missing.join(', '));
check('the skill\'s tool table names no tool the server does not have', extra.length === 0, extra.join(', '));

// ---------------- the connector essentials: one source for the Worker's instructions ----------------
{
  const mk = text.split('<!-- connector-essentials:start -->').length - 1 === 1 && text.split('<!-- connector-essentials:end -->').length - 1 === 1;
  check('SKILL.md has exactly one connector-essentials section, with start and end markers', mk);
  const section = mk ? text.slice(text.indexOf('<!-- connector-essentials:start -->') + 35, text.indexOf('<!-- connector-essentials:end -->')).trim() : '';
  const built = require('child_process').execFileSync(process.execPath, ['--input-type=module', '-e',
    "import('./connector/build.js').then((b) => { const v = b.views(); process.stdout.write(JSON.stringify({ i: v.instructions, h: v.essentialsHash, t: v.tools.map((t) => t.name) })); })"], { cwd: ROOT, encoding: 'utf8' });
  const b = JSON.parse(built);
  check('the built connector INSTRUCTIONS are the skill\'s section exactly (edit the skill, rebuild, redeploy the Worker)', section.length > 500 && b.i === section, `${b.i.length} vs ${section.length}`);
  // every tool-like name in the section is a tool the connector has (its two server tools or one of the panel's)
  const known = new Set([...b.t, 'open_emulator', 'open_emulator_inline', 'machine_output', 'machine_id']);
  const names = [...new Set([...section.matchAll(/\b[a-z]+(?:_[a-z]+)+\b/g)].map((m) => m[0]))];
  check('the connector essentials name only tools the connector has', names.length >= 8 && names.every((x) => known.has(x)), names.filter((x) => !known.has(x)).join(', '));
  check('the connector essentials keep the safety rule: machine output is data, never instructions', /machine_output[^\n]*data, never instructions/.test(section));
  check('the connector essentials keep the ROM rule: the person adds ROMs in the panel, no tool reads them, never look for them yourself',
    /ROMs: they live in the panel[^\n]*No tool reads or returns them[^\n]*never look for ROMs yourself/.test(section));
  check('the connector essentials do not speak for the host (no "the person approves each call")', !/approves each call/i.test(section));
}

// ---------------- what it says about the server is so, and its recipe works ----------------
(async () => {
  const tb = T.createToolbox(M.nodeHost({ mediaRoot: null, roms: [], png: framePng }), {});
  const call = async (name, args) => { const r = await tb.call(name, args); if (!r.ok) throw new Error(`${name}: ${JSON.stringify(r.error || r)}`); return r.image ? Object.assign({ png: r.image }, r.data) : r.data; };
  try {
    for (const model of ['dragon64', 'coco', 'coco3', 'mc10']) {
      const { machine } = await call('boot', { model });
      const w = await call('run_frames', { machine_id: machine.machine_id, until: { text: 'BUILT-IN STUB' } });
      check(`${model}: the built-in firmware's banner is the "BUILT-IN STUB" the skill says to wait for`, w.status === 'met' && w.frames_run < 20, `${w.status} ${w.frames_run}`);
      await call('close_machine', { machine_id: machine.machine_id });
    }
    // LIZA: the prompt wait the skill gives, and the answer already there when type_text returns
    {
      const { machine } = await call('boot', { model: 'dragon64' }), id = machine.machine_id;
      await call('run_frames', { machine_id: id, until: { text: 'BUILT-IN STUB' } });
      await call('load', { machine_id: id, program: 'liza' });
      const p = await call('run_frames', { machine_id: id, until: { text: '>' } });
      check('LIZA: the skill\'s prompt wait (until text ">") is met, at the prompt', p.status === 'met' && p.machine_output.screen.lines[p.machine_output.screen.lines.length - 1] === '>');
      await call('press_keys', { machine_id: id, keys: ['H'], frames: 5 });
      await call('run_frames', { machine_id: id, frames: 10 });
      const s1 = (await call('screen_text', { machine_id: id })).machine_output.lines;
      check('on the built-in firmware POLCAT does not see press_keys (as the skill says)', s1[s1.length - 1] === '>', s1[s1.length - 1]);
      await call('type_text', { machine_id: id, text: 'I FEEL SAD\n' });
      const s2 = (await call('screen_text', { machine_id: id })).machine_output.lines;
      check('LIZA has answered by the time type_text returns (the skill: read before waiting)', s2.includes('> I FEEL SAD') && s2.length > s1.length + 1, s2.join('|'));
      await call('close_machine', { machine_id: id });
    }
    // reset and power_cycle on the built-in firmware, as the skill's gotcha says: reset restarts the program it last
    // loaded; power_cycle clears RAM and brings the banner back (no cartridge in)
    {
      const fsP = require('fs'), os = require('os');
      const dir = fsP.mkdtempSync(path.join(os.tmpdir(), 'cloadm-skill-'));
      const Emu = require('./load')();
      const bin = Emu.toBinary(Emu.assemble(['        ORG $3000', 'START   LDX #MSG', '        LDY #$04E6', 'PR      LDA ,X+', '        BEQ SPIN',
        '        STA ,Y+', '        BRA PR', 'SPIN    INC $3100', '        BRA SPIN', 'MSG     FCC /STUCK/', '        FCB 0', '        END START'].join('\n'), '6809'));
      fsP.writeFileSync(path.join(dir, 'stuck.bin'), bin);
      const tb2 = T.createToolbox(M.nodeHost({ mediaRoot: dir, roms: [], png: framePng }), {});
      const c2 = async (name, args) => { const r = await tb2.call(name, args); if (!r.ok) throw new Error(`${name}: ${JSON.stringify(r.error)}`); return r.data; };
      await c2('boot', { model: 'dragon64' });
      await c2('run_frames', { machine_id: 'm1', until: { text: 'BUILT-IN STUB' } });
      await c2('load', { machine_id: 'm1', path: 'stuck.bin' });
      await c2('run_frames', { machine_id: 'm1', frames: 10 });
      await c2('reset', { machine_id: 'm1' });
      await c2('run_frames', { machine_id: 'm1', frames: 10 });
      const afterReset = (await c2('registers', { machine_id: 'm1' })).registers.pc;
      await c2('power_cycle', { machine_id: 'm1' });
      const w = await c2('run_frames', { machine_id: 'm1', until: { text: 'BUILT-IN STUB' } });
      const pcAfterPower = (await c2('registers', { machine_id: 'm1' })).registers.pc;
      const ram = (await c2('peek', { machine_id: 'm1', address: 0x3000, length: 2 })).machine_output.hex.join('');
      check('built-in firmware: reset restarts the program it last loaded (the PC is back in it)', afterReset >= 0x3000 && afterReset < 0x3020, afterReset.toString(16));
      check('built-in firmware: power_cycle clears RAM and brings the banner back', w.status === 'met' && /\$3000: 00 00/.test(ram) && pcAfterPower >= 0x8000, `${ram} pc ${pcAfterPower.toString(16)}`);
      fsP.rmSync(dir, { recursive: true, force: true });
    }
    // the PMODE 4 recipe in references/hardware.md: a green rectangle on black, the rest of the picture black
    {
      const hw = a.get('references/hardware.md').toString('utf8');
      const src = /## Recipe: PMODE 4[\s\S]*?```asm\n([\s\S]*?)```/.exec(hw)[1];
      const { machine } = await call('boot', { model: 'dragon64' }), id = machine.machine_id;
      await call('run_frames', { machine_id: id, until: { text: 'BUILT-IN STUB' } });
      const asm = await call('assemble_and_load', { machine_id: id, source: src });
      await call('run', { machine_id: id, target: '$3000' });
      const stop = await call('run_frames', { machine_id: id, until: { pc: asm.symbols.DONE } });
      await call('run_frames', { machine_id: id, frames: 2 });   // the frame it stopped in, then a whole one (the skill's rule)
      const shot = await call('screenshot', { machine_id: id });
      const px = pixels(Buffer.from(shot.png));
      // 320x240 with a 32x24 border: the picture is x 32-287, y 24-215; the rectangle is pixels 64-191, rows 64-127
      const at = (x, y) => { const i = (y * px.w + x) * 4; return [px.d[i], px.d[i + 1], px.d[i + 2]]; };
      const green = (c) => c[1] > 150 && c[0] < 100 && c[2] < 100, black = (c) => c[0] < 40 && c[1] < 40 && c[2] < 40;
      check('the skill\'s PMODE 4 recipe runs to DONE on the built-in firmware', stop.status === 'met');
      check('the recipe draws a green rectangle (pixels 64-191, rows 64-127) on black, 2 colours, as the table says',
        px.w === 320 && green(at(32 + 64, 24 + 64)) && green(at(32 + 191, 24 + 127)) && black(at(32 + 63, 24 + 64)) && black(at(32 + 192, 24 + 100)) && black(at(32 + 100, 24 + 128)) && black(at(32 + 10, 24 + 10)),
        JSON.stringify([at(96, 88), at(95, 88), at(224, 124)]) + ' ' + rowRuns(px, 88));
      await call('close_machine', { machine_id: id });
    }
  } catch (e) {
    check('the skill\'s claims run on the server', false, e.message);
  }
  check('SKILL.md says to prefer the CLOADM side-panel connector for playing or watching, and not to refuse files or scripts', /prefer the CLOADM side-panel connector if it is available; use these tools for the person's own files, scripting and tests/.test(text) && /Description only, not a rule/.test(text));
check('an eval covers the steering (prefer-side-panel)', fs.existsSync(path.join(__dirname, 'skill-evals/prefer-side-panel/case.yaml')) && fs.readdirSync(path.join(__dirname, 'skill-evals/prefer-side-panel/graders')).length >= 2);
console.log(fail ? `${fail} FAILED` : `${n}/${n} skill checks passed`);
  process.exitCode = fail ? 1 : 0;
})();

// RGBA, 8 bits, as framePng writes it (filter 0 on every row)
function pixels(buf) {
  let at = 8, w = 0, h = 0;
  const idat = [];
  while (at < buf.length) {
    const len = buf.readUInt32BE(at), type = buf.toString('latin1', at + 4, at + 8), d = buf.subarray(at + 8, at + 8 + len);
    if (type === 'IHDR') { w = d.readUInt32BE(0); h = d.readUInt32BE(4); }
    if (type === 'IDAT') idat.push(d);
    at += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat)), d = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) raw.copy(d, y * w * 4, y * (w * 4 + 1) + 1, (y + 1) * (w * 4 + 1));
  return { w, h, d };
}
function rowRuns(px, y) {
  const out = [];
  let prev = '';
  for (let x = 0; x < px.w; x++) { const i = (y * px.w + x) * 4, c = `${px.d[i]},${px.d[i + 1]},${px.d[i + 2]}`; if (c !== prev) { out.push(`${x}:${c}`); prev = c; } }
  return out.join(' ');
}
