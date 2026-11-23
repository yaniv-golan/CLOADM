// The MCP server (node cli/cloadm.js --mcp; cli/mcp.js over js/mcp/tools.js), spawned and driven over stdio JSON-RPC
// as a coding agent's client drives it, with the project's own programs and firmware only:
//  * both protocol eras: the initialize handshake (2025-11-25 and earlier) and the stateless revision (2026-07-28:
//    server/discover, resultType, serverInfo in _meta, UnsupportedProtocolVersionError -32022);
//  * tools/list: every schema an object root with additionalProperties false, required inside properties, names in
//    the spec's character set, annotations, the same order every time;
//  * every tool's happy path and its errors ({ code, remedy, detail }, as isError results), the machine_id lifecycle
//    and the cap of 8, --read-only, the media root (escapes by .., by an absolute path and through a link are refused),
//    cancellation (no reply, the machine stops), progress notifications, images only from screenshot;
//  * the page's tools give byte for byte what the in-page Claude's tools give on the same machine state (screen_text,
//    peek, disassemble, machine_info), and the same refusals ({ code, remedy, detail }) for the same bad input;
//  * --serve: the same tools over JSON lines.
// Run: node tests/mcp.test.js
const fs = require('fs'), os = require('os'), path = require('path'), zlib = require('zlib');
const { spawn, execFileSync } = require('child_process');
const Emu = require('./load')();

let fail = 0, n = 0;
// failed unless the suite reaches its end: a server that stops answering must not let the process exit cleanly
process.exitCode = 1;
const check = (name, cond, detail = '') => { n++; if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name}`); };
const ROOT = path.join(__dirname, '..');
const CLI = path.join(ROOT, 'cli', 'cloadm.js');
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cloadm-mcp-')));
const tmp = (...p) => path.join(TMP, ...p);
// HOME (and APPDATA) in a temporary directory: the servers here never read the real ~/.config/cloadm/config.json
fs.mkdirSync(path.join(TMP, 'home'));
const ENV = Object.assign({}, process.env, { SOURCE_DATE_EPOCH: '1700000000', HOME: path.join(TMP, 'home'), APPDATA: path.join(TMP, 'home', 'AppData') });

// A server, driven a message at a time: send() writes a message, reply(id) waits for the response with that id.
// Every server is killed at the end, so a failed check cannot leave one running and keep this suite from exiting.
const spawned = [];
function server(args = [], env = ENV) {
  const p = spawn(process.execPath, [CLI, '--mcp', ...args], { cwd: ROOT, env, stdio: ['pipe', 'pipe', 'pipe'] });
  spawned.push(p);
  const got = [], waiters = [];
  let buf = '', stderr = '';
  p.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      let msg;
      try { msg = JSON.parse(line); } catch (e) { msg = { notJson: line }; }
      got.push(msg);
      for (const w of waiters.slice()) if (w.test(msg)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(msg); }
    }
  });
  p.stderr.on('data', (d) => { stderr += d; });
  // a server that exits fails whatever still waits on it, with its reason, rather than leaving the suite to end silently
  p.on('close', (c) => { for (const w of waiters.splice(0)) w.reject(new Error(`the server exited (${c}) before replying; stderr ${stderr.slice(-300)}`)); });
  let id = 100;
  const api = {
    got, get stderr() { return stderr; },
    send: (msg) => p.stdin.write((typeof msg === 'string' ? msg : JSON.stringify(msg)) + '\n'),
    wait: (test, ms = 60000) => new Promise((resolve, reject) => {
      const hit = got.find(test);
      if (hit) { resolve(hit); return; }
      const w = { test, resolve, reject };
      waiters.push(w);
      setTimeout(() => { if (waiters.includes(w)) { waiters.splice(waiters.indexOf(w), 1); reject(new Error(`no reply in ${ms} ms; got ${JSON.stringify(got.slice(-3)).slice(0, 400)}; stderr ${stderr.slice(-300)}`)); } }, ms).unref();
    }),
    request(method, params, meta) {
      const rid = ++id;
      const msg = { jsonrpc: '2.0', id: rid, method, params: Object.assign({}, params, meta ? { _meta: meta } : {}) };
      api.send(msg);
      return api.wait((m) => m.id === rid && ('result' in m || 'error' in m));
    },
    // a tool call -> { result, data (the parsed text), error (the tool's { code, remedy, detail }) }
    async call(name, args = {}) {
      const r = await api.request('tools/call', { name, arguments: args });
      if (r.error) return { rpcError: r.error };
      const res = r.result, data = JSON.parse(res.content[0].text);
      return { res, data, error: res.isError ? data.error : null };
    },
    async init(version = '2025-11-25') {
      const r = await api.request('initialize', { protocolVersion: version, capabilities: {}, clientInfo: { name: 'mcp.test', version: '1' } });
      api.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
      return r;
    },
    close: () => new Promise((resolve) => { p.on('close', (code) => resolve(code)); p.stdin.end(); }),
  };
  return api;
}
// --serve: all requests written, then stdin closed; the replies, in order
function serveRun(requests, args = []) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [CLI, '--serve', ...args], { cwd: ROOT, env: ENV });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.on('close', (code) => resolve({ code, replies: out.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l)) }));
    p.stdin.end(requests.map((q) => (typeof q === 'string' ? q : JSON.stringify(q))).join('\n') + '\n');
  });
}
const pngSize = (b64) => { const b = Buffer.from(b64, 'base64'); return { sig: b.subarray(1, 4).toString(), w: b.readUInt32BE(16), h: b.readUInt32BE(20), b }; };
const pngPixels = (buf) => {
  let at = 8, w = 0, h = 0;
  const idat = [];
  while (at < buf.length) {
    const len = buf.readUInt32BE(at), type = buf.toString('latin1', at + 4, at + 8), d = buf.subarray(at + 8, at + 8 + len);
    if (type === 'IHDR') { w = d.readUInt32BE(0); h = d.readUInt32BE(4); }
    if (type === 'IDAT') idat.push(d);
    at += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat)), px = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) raw.copy(px, y * w * 4, y * (w * 4 + 1) + 1, (y + 1) * (w * 4 + 1));
  return px;
};
// the in-page Claude's tools on a Session restored from a snapshot file: the page's target and the page's runner
async function pageSession(file, roms = []) {
  const s = new Emu.Session({ welcomeMenu: false });
  s.switchMachine('dragon64', {}, { menu: false });
  if (roms.length) s.addRoms(roms);
  s.openSnapshot(await s.readSnapshot(new Uint8Array(fs.readFileSync(file))));
  return s;
}
const pageRead = (s, name, input) => { try { return { out: Emu.runReadOnlyTool(s.chatTarget(), name, input) }; } catch (e) { return { error: e.tool }; } };
const J = JSON.stringify;

// media: a machine-code .cas (namefile, data, EOF blocks as js/media/formats.js parseCas reads them), a program and a
// snapshot directory; outside the root, a secret a link points at
fs.mkdirSync(tmp('media'));
fs.mkdirSync(tmp('outside'));
fs.writeFileSync(tmp('outside', 'secret.bin'), 'not for the agent');
fs.symlinkSync(tmp('outside', 'secret.bin'), tmp('media', 'link.bin'));
fs.symlinkSync(tmp('outside'), tmp('media', 'linkdir'));
// links a write must not follow: one that leads nowhere yet (outside), one to a file outside
fs.symlinkSync(tmp('outside', 'pwned.cloadm-state'), tmp('media', 'dangling.cloadm-state'));
fs.symlinkSync(tmp('outside', 'secret.bin'), tmp('media', 'exists.cloadm-state'));
fs.symlinkSync(tmp('outside'), tmp('media', 'dir.cloadm-state'));
// files a read must not take whole or wait on: a FIFO, and one past the size limit (sparse: no disk used)
execFileSync('mkfifo', [tmp('media', 'fifo.asm')]);
fs.writeFileSync(tmp('media', 'big.asm'), '');
fs.truncateSync(tmp('media', 'big.asm'), (64 << 20) + 1);
const casBlock = (type, bytes) => { let sum = (type + bytes.length) & 0xFF; bytes.forEach((b) => { sum = (sum + b) & 0xFF; }); return [...Array(128).fill(0x55), 0x3C, type, bytes.length, ...bytes, sum, 0x55]; };
const code = Emu.assemble('        ORG $3000\nSTART   LDA #$5A\n        STA $3100\nL       BRA L\n        END START\n', '6809');
const seg = code.segments[0];
fs.writeFileSync(tmp('media', 'prog.cas'), Uint8Array.from([...casBlock(0, [...Buffer.from('PROG    '), 2, 0, 0, 0x30, 0x00, 0x30, 0x00]), ...casBlock(1, [...seg.data]), ...casBlock(0xFF, [])]));
fs.writeFileSync(tmp('media', 'prog.bin'), Emu.toBinary(code, { format: 'dragondos' }));
fs.writeFileSync(tmp('media', 'junk.xyz'), 'no program here');
fs.writeFileSync(tmp('media', 'notes.cloadm-state'), 'my notes, not a snapshot');
fs.writeFileSync(tmp('media', 'lib.asm'), 'VALUE   EQU $42\n');
fs.writeFileSync(tmp('media', 'hello.bas'), '10 print "hi~"\n20 GOTO 10\n');
fs.writeFileSync(tmp('media', 'plain.bas'), '10 PRINT "HI"\n');
// our own firmware as the Dragon 64's BASIC ROM: it scans the keyboard matrix for BREAK (from js/machines/keyboards.js)
// and counts the presses at $3100, so press_break has a machine that reads the key
{
  const [row, col] = Emu.keyboards[Emu.profiles.dragon64.keyboard].BREAK;
  const src = ['        ORG $8000', 'RESET   LDS #$7F00', '        CLR $FF03', '        LDA #$FF', '        STA $FF02', '        LDA #$04', '        STA $FF03', '        CLR $FF01',
    '        CLR $FF00', '        LDA #$04', '        STA $FF01', '        CLR $3100', 'SCAN    LDA #$' + ((~(1 << col)) & 0xFF).toString(16), '        STA $FF02', '        LDA $FF00',
    '        ANDA #$' + (1 << row).toString(16), '        BNE SCAN', '        INC $3100', 'UP      LDA $FF00', '        ANDA #$' + (1 << row).toString(16), '        BEQ UP', '        BRA SCAN', ''].join('\n');
  const r = Emu.assemble(src, '6809'), rom = new Uint8Array(0x4000);
  rom.set(r.segments[0].data, 0); rom[0x3FFE] = 0x80; rom[0x3FFF] = 0;
  fs.mkdirSync(tmp('roms'));
  fs.writeFileSync(tmp('roms', 'd64_1.rom'), rom);
}

(async () => {
  // ---------------- the handshake era ----------------
  const s = server(['--media-root', tmp('media'), '--roms', tmp('roms')]);
  const init = await s.init('2025-06-18');
  check('initialize: the client\'s version back, tools capability, serverInfo and instructions', init.result.protocolVersion === '2025-06-18' && init.result.capabilities.tools.listChanged === false
    && init.result.serverInfo.name === 'cloadm-files' && init.result.serverInfo.title === 'CLOADM on this computer' && /machine_id/.test(init.result.instructions) && init.result.resultType === 'complete', J(init));
  check('instructions: the first line names the route, "You are driving CLOADM on the person\'s computer."', init.result.instructions.split('\n')[0] === 'You are driving CLOADM on the person\'s computer.', J(init.result.instructions.split('\n')[0]));
  const unknownVersion = await s.request('initialize', { protocolVersion: '1999-01-01', capabilities: {}, clientInfo: { name: 'x', version: '1' } });
  check('initialize with a version the server does not speak: it answers with its newest handshake version', unknownVersion.result.protocolVersion === '2025-11-25', J(unknownVersion));
  const list = (await s.request('tools/list', {})).result.tools, list2 = (await s.request('tools/list', {})).result.tools;
  const names = list.map((t) => t.name);
  const want = ['list_models', 'list_machines', 'boot', 'switch_machine', 'close_machine', 'machine_info', 'screen_text', 'peek', 'disassemble', 'poke', 'type_text', 'load_basic',
    'press_break', 'assemble_and_load', 'run', 'find_bytes', 'press_keys', 'run_frames', 'step', 'registers', 'screenshot', 'reset', 'power_cycle', 'set_display', 'load', 'insert_tape', 'insert_disk', 'save_snapshot', 'restore_snapshot', 'add_roms', 'remove_roms'];
  check('tools/list: the agreed vocabulary (the page\'s tools under their own names, the rest in the same style), in a fixed order', J(names) === J(want) && J(list) === J(list2), J(names));
  const page = new Set([...Emu.readOnlyTools(), ...Emu.actingTools()].map((t) => t.name));
  const badSchema = list.filter((t) => {
    const sc = t.inputSchema;
    return sc.type !== 'object' || sc.additionalProperties !== false || !sc.properties || !(sc.required || []).every((r) => r in sc.properties)
      || !/^[A-Za-z0-9_.-]{1,128}$/.test(t.name) || !t.description || !t.title || t.annotations.openWorldHint !== (t.name === 'add_roms')
      || !['readOnlyHint', 'destructiveHint', 'idempotentHint'].every((h) => typeof t.annotations[h] === 'boolean')
      || (t.annotations.readOnlyHint && (t.annotations.destructiveHint || !t.annotations.idempotentHint))
      || (!['list_models', 'list_machines', 'boot', 'add_roms', 'remove_roms'].includes(t.name) && !(sc.required || []).includes('machine_id'));
  });
  // (besides the schemas being closed: the toolbox itself refuses an argument a tool does not take, by name)
  {
    const refused = [];
    for (const t of list) {
      const r = await s.call(t.name, { machine_id: 'm1', zz_not_a_parameter: 1 });
      if (!(r.res.isError && r.error.code === 'bad-argument' && /"zz_not_a_parameter"/.test(r.error.detail || ''))) refused.push(`${t.name}: ${r.error && r.error.code}`);
    }
    check('every tool refuses an argument it does not take, naming it', !refused.length, refused.slice(0, 4).join('; '));
  }
  check('tools/list: every schema an object root, closed, required inside properties; names, titles; all four hints on every tool (read-only ones idempotent, not destructive; openWorldHint only on add_roms, which fetches a URL); machine_id required', !badSchema.length, badSchema.map((t) => t.name).join());
  const pageSchemaSame = [...Emu.readOnlyTools(), ...Emu.actingTools()].every((p) => {
    const t = list.find((x) => x.name === p.name), props = Object.assign({}, t.inputSchema.properties);
    delete props.machine_id;
    return J(props) === J(p.input_schema.properties) && J(t.inputSchema.required.filter((r) => r !== 'machine_id')) === J(p.input_schema.required);
  });
  check('the page\'s tools take the page\'s parameters, exactly, plus machine_id', pageSchemaSame && page.size === 10);
  const ro = list.filter((t) => t.annotations.readOnlyHint).map((t) => t.name);
  check('readOnlyHint on exactly the tools that change nothing', J(ro) === J(['list_models', 'list_machines', 'machine_info', 'screen_text', 'peek', 'disassemble', 'find_bytes', 'registers', 'screenshot']), J(ro));
  check('destructiveHint on what types, writes, loads or replaces', ['poke', 'type_text', 'load', 'reset', 'power_cycle', 'restore_snapshot', 'switch_machine', 'save_snapshot'].every((nm) => list.find((t) => t.name === nm).annotations.destructiveHint === true)
    && list.find((t) => t.name === 'run_frames').annotations.destructiveHint === false);
  check('boot and load (the local server) say to prefer the CLOADM side-panel connector for playing or watching, and keep these tools for files, scripting and tests',
    ['boot', 'load'].every((n) => /prefer the CLOADM side-panel connector if it is available; use these tools for the person's own files, scripting and tests/.test(list.find((t) => t.name === n).description)));
  check('page tool descriptions leave out the page\'s consent text', !list.some((t) => /Let Claude use the emulator|The person is asked on every call/.test(t.description)) && /Write bytes of memory/.test(list.find((t) => t.name === 'poke').description));

  // ---- the machine lifecycle ----
  const noMachine = await s.call('screen_text', { machine_id: 'm9' });
  check('a call before boot: isError no-machine, with the remedy', noMachine.res.isError && noMachine.error.code === 'no-machine' && /call boot first/.test(noMachine.error.remedy), J(noMachine.error));
  const boot = await s.call('boot', { model: 'coco' });
  check('boot: a machine_id and the machine; no ROMs for the CoCo, so the built-in firmware', boot.data.machine.machine_id === 'm1' && boot.data.machine.model === 'coco' && boot.data.machine.roms === false && !boot.res.isError, J(boot.data));
  const badModel = await s.call('boot', { model: 'zx81' });
  check('boot an unknown model: unknown-model', badModel.error.code === 'unknown-model', J(badModel.error));
  const badOpt = await s.call('boot', { model: 'coco', options: { ram: 48 } });
  check('boot with a value the model does not have: bad-option, naming the values', badOpt.error.code === 'bad-option' && /4 or 16 or 32 or 64/.test(badOpt.error.detail), J(badOpt.error));
  const needRoms = await s.call('boot', { model: 'coco', roms: true });
  check('boot asking for ROMs the server lacks: missing-roms', needRoms.error.code === 'missing-roms' && /Color BASIC/.test(needRoms.error.detail), J(needRoms.error));
  const extra = await s.call('boot', { model: 'coco', colour: 'red' });
  check('an unknown parameter: bad-argument naming it and the ones the tool takes', extra.error.code === 'bad-argument' && /no parameter "colour" \(it takes model, options, roms\)/.test(extra.error.detail), J(extra.error));
  const d64 = await s.call('boot', { model: 'dragon64' });
  check('boot a model the server has ROMs for: it runs them, and says nothing about BASIC', d64.data.machine.roms === true && d64.data.machine.machine_id === 'm2' && !('basic' in d64.data), J(d64.data));
  check('boot without ROMs: basic says BASIC is unavailable and which file it needs', boot.data.basic === 'unavailable: needs one of bas12.rom, bas11.rom, bas10.rom, bas13.rom (Color BASIC); see list_models. The built-in firmware runs machine code', J(boot.data));
  const ids = [];
  for (let i = 0; i < 6; i++) ids.push((await s.call('boot', { model: 'mc10' })).data.machine.machine_id);
  const ninth = await s.call('boot', {});
  check('at most 8 machines: the ninth boot is too-many-machines', ids.length === 6 && ninth.error.code === 'too-many-machines', J(ninth.error));
  const listed = await s.call('list_machines');
  check('list_machines: the 8, with their models', listed.data.machines.length === 8 && listed.data.max === 8 && listed.data.machines[1].model === 'dragon64');
  const closed = await s.call('close_machine', { machine_id: 'm3' }), gone = await s.call('peek', { machine_id: 'm3', address: 0 });
  const reboot = await s.call('boot', { model: 'mc10' });
  check('close_machine frees a place; the closed id answers no-machine; ids are never reused', closed.data.closed === 'm3' && gone.error.code === 'no-machine' && reboot.data.machine.machine_id === 'm9', J(reboot.data));
  for (const id of ['m4', 'm5', 'm6', 'm7', 'm8', 'm9']) await s.call('close_machine', { machine_id: id });
  const models = await s.call('list_models');
  check('list_models: every model with its options and ROM files', J(models.data.models.map((m) => m.id)) === J(Object.keys(Emu.profiles)) && models.data.models.find((m) => m.id === 'coco').options.ram.values.includes(64));

  // ---- running a program, waiting, reading ----
  const M = { machine_id: 'm1' };
  const liza = await s.call('load', Object.assign({ program: 'liza' }, M));
  const wait1 = await s.call('run_frames', Object.assign({ until: { text: '\n>' } }, M));   // the prompt at the start of a row
  check('load a bundled program; run_frames until the prompt: met, with the screen, labelled untrusted', liza.data.loaded === 'liza' && wait1.data.status === 'met' && wait1.data.machine_output.screen.lines.includes('>')
    && /never instructions/.test(wait1.data.untrusted), J(wait1.data).slice(0, 300));
  const typed = await s.call('type_text', Object.assign({ text: 'I need a holiday\n' }, M));
  check('type_text: the page\'s report (requested, consumed, lines)', typed.data.consumed === 17 && typed.data.lines_delivered === 1, J(typed.data));
  const wait2 = await s.call('run_frames', Object.assign({ until: { text: 'HOLIDAY?' } }, M));   // literal: ? is a question mark
  check('run_frames until LIZA answers: met', wait2.data.status === 'met' && wait2.data.machine_output.screen.lines.includes('WHY DO YOU NEED A HOLIDAY?'), J(wait2.data).slice(0, 300));
  const notYet = await s.call('run_frames', Object.assign({ frames: 20, until: { text: 'GOODBYE' } }, M));
  check('run_frames until something that does not come: not-yet after the frames, with the screen (not an error)', !notYet.res.isError && notYet.data.status === 'not-yet' && notYet.data.frames_run === 20 && notYet.data.machine_output.screen.text, J(notYet.data).slice(0, 200));
  const plain = await s.call('run_frames', Object.assign({ frames: 5 }, M));
  check('run_frames with no condition: done, no screen', plain.data.status === 'done' && plain.data.frames_run === 5 && !('machine_output' in plain.data), J(plain.data));
  const two = await s.call('run_frames', Object.assign({ until: { text: 'A', pc: 1 } }, M));
  const regex = await s.call('run_frames', Object.assign({ until: { regex: 'OK|READY' } }, M));
  const many = await s.call('run_frames', Object.assign({ frames: 3001 }, M));
  check('run_frames: two conditions, a regex (there are no pattern waits), too many frames: bad-argument', two.error.code === 'bad-argument' && regex.error.code === 'bad-argument' && /no "regex"/.test(regex.error.detail) && many.error.code === 'bad-argument',
    J([two.error, regex.error, many.error]));
  // until.text is a plain substring: what reads like a pattern is just text, and costs nothing to look for
  const t0text = Date.now();
  const literal = await s.call('run_frames', Object.assign({ frames: 5, until: { text: '(A?){20}A{20}B' } }, M));
  const dotStar = await s.call('run_frames', Object.assign({ frames: 5, until: { text: 'LIZA.*THERAPIST' } }, M));
  const caseless = await s.call('run_frames', Object.assign({ frames: 5, until: { text: 'why do you need', ignore_case: true } }, M));
  const cased = await s.call('run_frames', Object.assign({ frames: 5, until: { text: 'why do you need' } }, M));
  const icPc = await s.call('run_frames', Object.assign({ frames: 5, until: { pc: 1, ignore_case: true } }, M));
  check('until.text: a substring (a pattern is just text, and costs nothing), ignore_case matches lowercase, case matters without it; ignore_case without text: bad-argument',
    literal.data.status === 'not-yet' && dotStar.data.status === 'not-yet' && Date.now() - t0text < 5000 && caseless.data.status === 'met' && cased.data.status === 'not-yet' && icPc.error.code === 'bad-argument',
    J([literal.data && literal.data.status, caseless.data && caseless.data.status, cased.data && cased.data.status, icPc.error]));
  const text = await s.call('screen_text', M);
  check('screen_text: the screen under machine_output, labelled untrusted', text.data.machine_output.lines[0] === 'LIZA - A DRAGON 64 THERAPIST' && text.data.untrusted, J(text.data).slice(0, 200));

  // ---- the page's tools give what the page gives, on the same machine ----
  const snapFile = tmp('media', 'same.cloadm-state');
  const saved = await s.call('save_snapshot', Object.assign({ path: 'same.cloadm-state' }, M));
  const mPeek = await s.call('peek', Object.assign({ address: 0x400, length: 64 }, M));
  const mDis = await s.call('disassemble', Object.assign({ address: 0x3000, count: 12 }, M));
  const mInfo = await s.call('machine_info', M);
  const mText = await s.call('screen_text', M);
  const ps = await pageSession(snapFile);
  check('save_snapshot writes under the media root', saved.data.saved === 'same.cloadm-state' && fs.statSync(snapFile).size === saved.data.size);
  check('screen_text: byte for byte what the in-page tool gives on the same machine', J(mText.data.machine_output) === J(pageRead(ps, 'screen_text', {}).out));
  check('peek: byte for byte the in-page tool\'s answer', J(mPeek.data.machine_output) === J(pageRead(ps, 'peek', { address: 0x400, length: 64 }).out));
  check('disassemble: byte for byte the in-page tool\'s answer', J(mDis.data.machine_output) === J(pageRead(ps, 'disassemble', { address: 0x3000, count: 12 }).out));
  check('machine_info: byte for byte the in-page tool\'s answer (not wrapped: the emulator\'s own words), then the route, "local"', J(mInfo.data) === J(Object.assign({}, pageRead(ps, 'machine_info', {}).out, { route: 'local' })), J(mInfo.data));
  // the same refusals, with the same { code, remedy, detail }
  for (const [name, input] of [['peek', { address: 70000 }], ['peek', { address: 65535, length: 2 }], ['peek', { address: 1, length: 0 }], ['peek', { address: '1024' }], ['disassemble', { address: 0, count: 65 }]]) {
    const mine = await s.call(name, Object.assign({}, input, M)), theirs = pageRead(ps, name, input);
    check(`${name} ${J(input)}: refused exactly as the page refuses it`, mine.res.isError && theirs.error && J(mine.error) === J(theirs.error), `${J(mine.error)} vs ${J(theirs.error)}`);
  }
  const extraArg = await s.call('peek', Object.assign({ address: 0x400, count: 4 }, M));
  check('a page tool refuses a parameter it does not have, as the schema says (additionalProperties false)', extraArg.error && extraArg.error.code === 'bad-argument' && /no parameter "count"/.test(extraArg.error.detail), J(extraArg));
  // ROM reads: the page's rule, whatever it is, on a machine running the user's ROM (m2: our firmware in its socket)
  await s.call('run_frames', { machine_id: 'm2', frames: 3 });
  await s.call('save_snapshot', { machine_id: 'm2', path: 'rom.cloadm-state' });
  const romPeek = await s.call('peek', { machine_id: 'm2', address: 0x8000, length: 32 }), romDis = await s.call('disassemble', { machine_id: 'm2', address: 0x8000, count: 4 });
  const pr = await pageSession(tmp('media', 'rom.cloadm-state'), [{ name: 'd64_1.rom', bytes: new Uint8Array(fs.readFileSync(tmp('roms', 'd64_1.rom'))) }]);
  check('ROM reads follow the page\'s rule: peek and disassemble of the ROM give what the in-page tools give', J(romPeek.data.machine_output) === J(pageRead(pr, 'peek', { address: 0x8000, length: 32 }).out)
    && J(romDis.data.machine_output) === J(pageRead(pr, 'disassemble', { address: 0x8000, count: 4 }).out), J(romPeek).slice(0, 200));

  // ---- acting tools ----
  const poked = await s.call('poke', Object.assign({ address: 0x3F00, bytes: [1, 2, 3] }, M));
  const romPoke = await s.call('poke', Object.assign({ address: 0xA000, bytes: [1] }, M));
  check('poke: the page\'s report; a write to ROM: not-ram', poked.data.written === 3 && romPoke.error.code === 'not-ram', J([poked.data, romPoke.error]));
  const asm = await s.call('assemble_and_load', Object.assign({ source: ' INCLUDE lib.asm\n ORG $3800\nS LDA #VALUE\n STA $3900\nL BRA L\n' }, M));
  const ran = await s.call('run', Object.assign({ target: '$3800' }, M));
  const atL = await s.call('run_frames', Object.assign({ until: { pc: asm.data.symbols.L } }, M));
  const regs = await s.call('registers', M);
  check('assemble_and_load (with an INCLUDE from the media root), run, run_frames until pc: stops at the instruction', asm.data.written === 7 && ran.data.how === 'jump' && atL.data.status === 'met'
    && regs.data.registers.pc === asm.data.symbols.L && regs.data.registers.a === 0x42 && regs.data.cpu === '6809', J([asm.data, atL.data.status, regs.data]));
  const badAsm = await s.call('assemble_and_load', Object.assign({ source: ' FROB\n' }, M));
  const noBasic = await s.call('load_basic', Object.assign({ program: '10 PRINT 1' }, M));
  check('assemble_and_load with errors: assembly-failed; load_basic on the built-in firmware: no-basic', badAsm.error.code === 'assembly-failed' && noBasic.error.code === 'no-basic', J([badAsm.error, noBasic.error]));
  const stepped = await s.call('step', Object.assign({ count: 3 }, M));
  check('step: exactly the instructions asked, the registers after (BRA L stays at L)', stepped.data.instructions === 3 && stepped.data.registers.pc === asm.data.symbols.L && stepped.data.cycles === 9, J(stepped.data));
  const breakStub = await s.call('press_break', M);
  check('press_break on the built-in firmware: not-consumed (the page\'s answer: the stub reads no BREAK)', breakStub.error.code === 'not-consumed', J(breakStub.error));
  const breakRom = await s.call('press_break', { machine_id: 'm2' });
  const counted = await s.call('peek', { machine_id: 'm2', address: 0x3100 });
  check('press_break with a ROM that scans the matrix: consumed, and the firmware counted it', breakRom.data.consumed === 1 && /^\$3100: 01( |$)/.test(counted.data.machine_output.hex[0]), J([breakRom, counted.data]));
  const untyp = await s.call('type_text', Object.assign({ text: 'café' }, M));
  check('type_text with a character the machine cannot type: not-typable', untyp.error.code === 'not-typable', J(untyp.error));

  // ---- media under the root ----
  const lp = await s.call('load', Object.assign({ path: 'prog.bin' }, M));
  await s.call('run_frames', Object.assign({ frames: 2 }, M));
  const p1 = await s.call('peek', Object.assign({ address: 0x3100 }, M));
  check('load a binary from the media root: it runs', /prog\.bin/.test(lp.data.message) && /^\$3100: 5A( |$)/.test(p1.data.machine_output.hex[0]), J([lp.data, p1.data]));
  const tape = await s.call('insert_tape', Object.assign({ path: 'prog.cas' }, M));
  const notTape = await s.call('insert_tape', Object.assign({ path: 'junk.xyz' }, M));
  check('insert_tape: a .cas goes in the deck; a file that is no tape: bad-media', /^prog\.cas is in the deck\. There's no BASIC to type CLOAD into\.$/.test(tape.data.message) && notTape.error.code === 'bad-media', J([tape.data, notTape.error]));
  const unknown = await s.call('load', Object.assign({ path: 'junk.xyz' }, M));
  const disk = await s.call('insert_disk', Object.assign({ path: 'prog.bin' }, M));
  check('load of an unknown format and insert_disk of a non-disk: rejected, the machine says why', unknown.error.code === 'rejected' && /unknown format/.test(unknown.error.detail) && disk.error.code === 'rejected' && /not a disk image/.test(disk.error.detail), J([unknown.error, disk.error]));
  const escapes = [];
  for (const p of ['../outside/secret.bin', tmp('outside', 'secret.bin'), 'link.bin', 'linkdir/secret.bin', 'missing.bin']) escapes.push((await s.call('load', Object.assign({ path: p }, M))).error.code);
  check('the media root holds: .., an absolute path, a link to a file and a link to a directory outside are refused; a missing file cannot-read', J(escapes) === J(['outside-media-root', 'outside-media-root', 'outside-media-root', 'outside-media-root', 'cannot-read']), J(escapes));
  const wout = await s.call('save_snapshot', Object.assign({ path: '../outside/x.cloadm-state' }, M)), wlink = await s.call('save_snapshot', Object.assign({ path: 'linkdir/x.cloadm-state' }, M));
  check('writing outside the media root is refused too (also through a link), and nothing is written', wout.error.code === 'outside-media-root' && wlink.error.code === 'outside-media-root' && !fs.existsSync(tmp('outside', 'x.cloadm-state')), J([wout.error, wlink.error]));
  const wlinks = [];
  for (const p of ['dangling.cloadm-state', 'exists.cloadm-state', 'dir.cloadm-state', 'linkdir/y.cloadm-state']) wlinks.push((await s.call('save_snapshot', Object.assign({ path: p }, M))).error);
  check('save_snapshot never writes through a link: one that leads nowhere yet, one to a file outside, one to a directory outside, one inside a linked directory; nothing outside changes',
    wlinks.every((e) => e && e.code === 'outside-media-root') && !fs.existsSync(tmp('outside', 'pwned.cloadm-state')) && fs.readFileSync(tmp('outside', 'secret.bin'), 'utf8') === 'not for the agent'
    && fs.readdirSync(tmp('outside')).length === 1, J(wlinks));
  const tf = Date.now();
  const fifoLoad = await s.call('load', Object.assign({ path: 'fifo.asm' }, M)), bigLoad = await s.call('load', Object.assign({ path: 'big.asm' }, M));
  const fifoInc = await s.call('assemble_and_load', Object.assign({ source: ' INCLUDE fifo.asm\n ORG $3800\n RTS\n' }, M));
  const bigInc = await s.call('assemble_and_load', Object.assign({ source: ' INCLUDE big.asm\n ORG $3800\n RTS\n' }, M));
  check('a FIFO and a file over the size limit: load says cannot-read, INCLUDE include-unreadable, at once and without reading them', fifoLoad.error.code === 'cannot-read' && bigLoad.error.code === 'cannot-read'
    && fifoInc.error && fifoInc.error.code === 'include-unreadable' && bigInc.error && bigInc.error.code === 'include-unreadable' && Date.now() - tf < 5000, J([fifoLoad.error, bigLoad.error, fifoInc.error, bigInc.error]));
  // save_snapshot writes only snapshots: a name ending .cloadm-state, and an existing file only if it is a snapshot
  const wrongName = await s.call('save_snapshot', Object.assign({ path: 'prog.bin' }, M)), newName = await s.call('save_snapshot', Object.assign({ path: '.bashrc' }, M));
  const notASnapshot = await s.call('save_snapshot', Object.assign({ path: 'notes.cloadm-state' }, M));
  await s.call('save_snapshot', Object.assign({ path: 'again.cloadm-state' }, M));
  const again = await s.call('save_snapshot', Object.assign({ path: 'again.cloadm-state' }, M));
  check('save_snapshot: a name not ending .cloadm-state is refused (bad-argument), an existing file that is no snapshot is not replaced (cannot-write), a snapshot is',
    wrongName.error && wrongName.error.code === 'bad-argument' && newName.error && newName.error.code === 'bad-argument' && !fs.existsSync(tmp('media', '.bashrc'))
    && fs.readFileSync(tmp('media', 'prog.bin')).equals(Buffer.from(Emu.toBinary(code, { format: 'dragondos' })))
    && notASnapshot.error && notASnapshot.error.code === 'cannot-write' && /not a snapshot/.test(notASnapshot.error.detail) && fs.readFileSync(tmp('media', 'notes.cloadm-state'), 'utf8') === 'my notes, not a snapshot'
    && again.data && again.data.saved === 'again.cloadm-state', J([wrongName.error, newName.error, notASnapshot.error, again.data]));
  const restored = await s.call('restore_snapshot', Object.assign({ path: 'same.cloadm-state' }, M));
  const afterRestore = await s.call('screen_text', M);
  check('restore_snapshot: the machine as saved', restored.data.machine.model === 'coco' && J(afterRestore.data.machine_output) === J(mText.data.machine_output), J(restored.data).slice(0, 200));
  const notSnap = await s.call('restore_snapshot', Object.assign({ path: 'junk.xyz' }, M));
  check('restore_snapshot of a file that is no snapshot: bad-media', notSnap.error.code === 'bad-media', J(notSnap.error));

  // ---- a BASIC listing (m2 runs our firmware in the BASIC socket, so it counts as having ROMs) ----
  {
    const bas = await s.call('load', { machine_id: 'm2', path: 'hello.bas' });
    check('load of a .bas: says it types NEW, the listing and RUN, and what the keyboard changes (lowercase to uppercase) or drops (~ has no key)',
      bas.data && /and RUN/.test(bas.data.typed) && J(bas.data.changed) === J(['lowercase typed as uppercase']) && J(bas.data.dropped) === J(['~']), J(bas));
    await s.call('press_break', { machine_id: 'm2' });
    const noRun = await s.call('load', { machine_id: 'm2', path: 'plain.bas', run: false });
    check('load of a .bas with run false: NEW and the listing, no RUN; nothing changed or dropped', noRun.data && /not run/.test(noRun.data.typed) && !/and RUN/.test(noRun.data.typed) && !('changed' in noRun.data) && !('dropped' in noRun.data), J(noRun));
    // what the Session queues at the keyboard, either way (our firmware in the BASIC socket, so the machine has ROMs)
    const queued = (opts) => {
      const ls = new Emu.Session({ welcomeMenu: false });
      ls.switchMachine('dragon64', {}, { menu: false });
      ls.addRoms([{ name: 'd64_1.rom', bytes: new Uint8Array(fs.readFileSync(tmp('roms', 'd64_1.rom'))) }]);
      ls.load('p.bas', new Uint8Array(Buffer.from('10 PRINT 1\n')), Object.assign({ remember: false }, opts));
      return ls.shownMachine.typist.queue.filter((c) => typeof c === 'string').join('');
    };
    check('Session.load of a listing: NEW, the lines, RUN; with run false the same without RUN (the page\'s default is unchanged)',
      queued({}) === 'NEW\r10 PRINT 1\rRUN\r' && queued({ run: false }) === 'NEW\r10 PRINT 1\r', J([queued({}), queued({ run: false })]));
    const runBin = await s.call('load', { machine_id: 'm2', path: 'prog.bin', run: false });
    check('run false on something that is not a BASIC listing: bad-argument', runBin.error && runBin.error.code === 'bad-argument' && /BASIC listing/.test(runBin.error.detail), J(runBin.error));
  }

  // ---- the rest ----
  const shot = await s.call('screenshot', M);
  const img = shot.res.content.find((c) => c.type === 'image'), sz = img && pngSize(img.data);
  check('screenshot: an image/png of the frame, its size in the text', img && img.mimeType === 'image/png' && sz.sig === 'PNG' && sz.w === shot.data.width && shot.data.width === 320, J(shot.data));
  const imagesElsewhere = s.got.filter((m) => m.result && m.result.content && m.result.content.some((c) => c.type === 'image')).length;
  check('images come only from screenshot', imagesElsewhere === 1, `${imagesElsewhere}`);
  await s.call('poke', Object.assign({ address: 0x3F80, bytes: [0xAB] }, M));
  const rs = await s.call('reset', M), pc = await s.call('power_cycle', M);
  const afterPower = await s.call('peek', Object.assign({ address: 0x3F80 }, M));
  check('reset and power_cycle: the machine back; power_cycle clears RAM', rs.data.machine.model === 'coco' && pc.data.machine.model === 'coco' && !/^\$3F80: AB( |$)/.test(afterPower.data.machine_output.hex[0]), J(afterPower.data));
  const sw = await s.call('switch_machine', Object.assign({ model: 'd64plus' }, M));
  const plus = await s.call('set_display', Object.assign({ screen: 'plus' }, M)), noPlus = await s.call('set_display', { machine_id: 'm2', screen: 'plus' });
  check('switch_machine keeps the machine_id; set_display chooses the Plus\'s screen, and is refused on a one-screen machine', sw.data.machine.model === 'd64plus' && sw.data.machine.machine_id === 'm1'
    && plus.data.screen === 'plus' && noPlus.error.code === 'rejected', J([sw.data, plus.data, noPlus.error]));

  // ---- protocol errors and progress ----
  const unknownTool = await s.request('tools/call', { name: 'format_disk', arguments: {} });
  const unknownMethod = await s.request('resources/list', {});
  s.send('this is not json');
  const parse = await s.wait((m) => m.error && m.error.code === -32700);
  check('an unknown tool is the protocol\'s -32602; an unknown method -32601; bad JSON -32700', unknownTool.error.code === -32602 && unknownMethod.error.code === -32601 && parse.id === null, J([unknownTool, unknownMethod]));
  const prog = await s.request('tools/call', { name: 'run_frames', arguments: { machine_id: 'm2', frames: 120 }, _meta: { progressToken: 'p1' } });
  const notes = s.got.filter((m) => m.method === 'notifications/progress' && m.params.progressToken === 'p1');
  check('progress: notifications/progress for a call that asked, increasing, with the total', prog.result && notes.length >= 2 && notes.every((m, i) => i === 0 || m.params.progress > notes[i - 1].params.progress) && notes[0].params.total === 120, J(notes.slice(0, 2)));

  // ---- cancellation: no reply for the cancelled call, the machine stops, the next call is served ----
  s.send({ jsonrpc: '2.0', id: 'long', method: 'tools/call', params: { name: 'run_frames', arguments: { machine_id: 'm2', frames: 3000, until: { text: 'NEVER' } } } });
  await new Promise((r) => setTimeout(r, 300));
  const t0 = Date.now();
  s.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 'long', reason: 'test' } });
  const after = await s.call('list_machines');
  const m2 = after.data.machines.find((m) => m.machine_id === 'm2');
  await new Promise((r) => setTimeout(r, 300));
  check('cancellation: the next call is answered at once, the cancelled one never is, and the machine stopped short of 3000 frames', Date.now() - t0 < 5000 && !s.got.some((m) => m.id === 'long') && m2.frame < 3000 + 200, `${Date.now() - t0} ms, frame ${m2.frame}`);
  // a cancellation for a call still waiting its turn: it never runs and is never answered
  const f0 = (await s.call('list_machines')).data.machines.find((m) => m.machine_id === 'm2').frame;
  s.send({ jsonrpc: '2.0', id: 'q1', method: 'tools/call', params: { name: 'run_frames', arguments: { machine_id: 'm2', frames: 400, until: { text: 'NEVER' } } } });
  s.send({ jsonrpc: '2.0', id: 'q2', method: 'tools/call', params: { name: 'run_frames', arguments: { machine_id: 'm2', frames: 1000 } } });
  s.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 'q2', reason: 'test' } });
  const q1 = await s.wait((m) => m.id === 'q1');
  const f1 = (await s.call('list_machines')).data.machines.find((m) => m.machine_id === 'm2').frame;
  check('cancelling a queued call: it never runs and gets no reply; the call before it is answered', q1.result && !s.got.some((m) => m.id === 'q2') && f1 - f0 === 400, `${f1 - f0} frames, ${J(q1).slice(0, 100)}`);
  // a line over the limit is refused (-32600) without being kept, and the server goes on
  s.send('{"jsonrpc":"2.0","id":"huge","method":"ping","params":{"pad":"' + 'x'.repeat(9 << 20) + '"}}');
  const huge = await s.wait((m) => m.error && m.error.code === -32600 && /too long/.test(m.error.message));
  const pingAfter = await s.request('ping', {});
  check('a line over 8 MB: -32600 (id null, it was not read), and the next request is answered', huge.id === null && pingAfter.result, J(huge));
  // a batch (an array) is not a message this server takes
  s.send('[{"jsonrpc":"2.0","id":"b1","method":"ping"}]');
  const batch = await s.wait((m) => m.error && m.error.code === -32600 && m.id === null && /one JSON-RPC 2.0 message per line/.test(m.error.message));
  check('a JSON-RPC batch: -32600', !!batch && !s.got.some((m) => m.id === 'b1'));
  // a line that is valid JSON but no object (null, a number) is an invalid request, and the server goes on
  s.send('null');
  s.send('7');
  const pingAfterNull = await s.request('ping', {});
  check('a line of null or a number: -32600, and the next request is answered', pingAfterNull.result && s.got.filter((m) => m.error && m.error.code === -32600 && m.id === null).length >= 4, J(pingAfterNull));
  check('stdout carried only JSON-RPC messages', !s.got.some((m) => m.notJson || m.jsonrpc !== '2.0'));
  const exit = await s.close();
  check('the server exits when its input closes', exit === 0, `${exit}`);

  // ---------------- the stateless era (2026-07-28) ----------------
  const st = server();
  const META = { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientInfo': { name: 'mcp.test', version: '1' } };
  const disc = await st.request('server/discover', {}, META);
  check('server/discover: the versions it speaks (newest first), capabilities, instructions, serverInfo in _meta, resultType', disc.result.supportedVersions[0] === '2026-07-28' && disc.result.supportedVersions.includes('2025-11-25')
    && disc.result.capabilities.tools && disc.result.resultType === 'complete' && disc.result._meta['io.modelcontextprotocol/serverInfo'].name === 'cloadm-files' && disc.result.instructions, J(disc));
  const tl = await st.request('tools/list', {}, META);
  check('tools/list without a handshake: the tools, ttlMs and cacheScope, serverInfo in _meta', tl.result.tools.length === want.length && tl.result.ttlMs > 0 && tl.result.cacheScope === 'private' && tl.result._meta['io.modelcontextprotocol/serverInfo']);
  const b2 = await st.request('tools/call', { name: 'boot', arguments: { model: 'mc10' } }, META);
  check('tools/call without a handshake: served, resultType complete, the handle in the result', b2.result.resultType === 'complete' && JSON.parse(b2.result.content[0].text).machine.machine_id === 'm1');
  const old = await st.request('tools/list', {}, { 'io.modelcontextprotocol/protocolVersion': '1999-01-01' });
  check('a version it does not speak: UnsupportedProtocolVersionError -32022 with the supported list', old.error && old.error.code === -32022 && old.error.data.supported.includes('2026-07-28') && old.error.data.requested === '1999-01-01', J(old));
  const noFiles = await st.call('load', { machine_id: 'm1', path: 'prog.bin' });
  check('with no media root set, the default ~/CLOADM: a file not there is cannot-read, naming the folder; reading creates nothing',
    noFiles.error.code === 'cannot-read' && noFiles.error.detail.includes(path.join(TMP, 'home', 'CLOADM')) && !fs.existsSync(path.join(TMP, 'home', 'CLOADM')), J(noFiles.error));
  await st.close();

  // ---------------- press_keys: keys and the joystick held for frames, as a game reads them ----------------
  // Our program waits for each field sync, then counts the frames LEFT is down ($3100), LEFT with SHIFT ($3101), the
  // right fire button ($3102) and the right joystick's x at or above 48 ($3103, through the DAC comparator).
  {
    const g = server();
    await g.init();
    await g.call('boot', { model: 'coco' });
    const G = { machine_id: 'm1' };
    await g.call('run_frames', Object.assign({ frames: 3 }, G));
    const kb = Emu.keyboards[Emu.profiles.coco.keyboard], col = (k) => '$' + ((~(1 << kb[k][1])) & 0xFF).toString(16), row = (k) => '$' + (1 << kb[k][0]).toString(16);
    const src = [' ORG $3800', 'START ORCC #$50', ' CLR $3100', ' CLR $3101', ' CLR $3102', ' CLR $3103',
      ' CLR $FF01', ' CLR $FF00', ' LDA #$34', ' STA $FF01', ' CLR $FF03', ' LDA #$FF', ' STA $FF02', ' LDA #$34', ' STA $FF03',
      ' CLR $FF21', ' LDA #$FE', ' STA $FF20', ' LDA #$34', ' STA $FF21',
      'LOOP LDA $FF03', ' BPL LOOP', ' LDA $FF02',
      ` LDA #${col('LEFT')}`, ' STA $FF02', ' LDA $FF00', ` ANDA #${row('LEFT')}`, ' BNE NOLEFT', ' INC $3100',
      ` LDA #${col('SHIFT')}`, ' STA $FF02', ' LDA $FF00', ` ANDA #${row('SHIFT')}`, ' BNE NOLEFT', ' INC $3101',
      'NOLEFT LDA #$FF', ' STA $FF02', ' LDA $FF00', ' BITA #1', ' BNE NOFIRE', ' INC $3102',
      'NOFIRE LDA #192', ' STA $FF20', ' NOP', ' NOP', ' LDA $FF00', ' BPL NOJOY', ' INC $3103', 'NOJOY BRA LOOP', ''].join('\n');
    const asm = await g.call('assemble_and_load', Object.assign({ source: src }, G));
    await g.call('run', Object.assign({ target: '$3800' }, G));
    await g.call('run_frames', Object.assign({ frames: 2 }, G));
    const counts = async () => (await g.call('peek', Object.assign({ address: 0x3100, length: 4 }, G))).data.machine_output.hex[0];
    const k1 = await g.call('press_keys', Object.assign({ keys: ['LEFT'], frames: 10 }, G));
    const c1 = await counts();
    const k2 = await g.call('press_keys', Object.assign({ keys: ['{left}', 'shift'], frames: 5 }, G));
    const c2 = await counts();
    await g.call('run_frames', Object.assign({ frames: 5 }, G));
    const c3 = await counts();
    check('press_keys: LEFT held 10 frames is read on 10 frames; LEFT+SHIFT 5 more; released after (names in any case, {NAME} too)',
      asm.data && k1.data && k1.data.frames_run === 10 && J(k1.data.keys) === J(['LEFT']) && c1 === '$3100: 0A 00 00 00' && J(k2.data.keys) === J(['LEFT', 'SHIFT']) && c2 === '$3100: 0F 05 00 00' && c3 === c2,
      J([asm.error, k1, c1, c2, c3]));
    const j1 = await g.call('press_keys', Object.assign({ joystick: { fire: true, x: 63 }, frames: 4 }, G));
    await g.call('run_frames', Object.assign({ frames: 3 }, G));
    const c4 = await counts();
    check('press_keys joystick: fire and x held 4 frames, then the stick back in the middle and fire up', j1.data && j1.data.frames_run === 4 && c4 === '$3100: 0F 05 04 04', J([j1, c4]));
    const errs = [];
    for (const a of [{ keys: ['ESC'] }, { keys: ['LEFT'], frames: 0 }, {}, { keys: [] }, { joystick: { x: 64 } }, { joystick: { port: 'middle' } }, { keys: 'LEFT' }]) errs.push((await g.call('press_keys', Object.assign(a, G))).error);
    check('press_keys refuses a key the keyboard lacks (naming those it has), 0 frames, nothing to press, a stick value out of 0-63, an unknown port, keys not a list',
      errs.every((e) => e && e.code === 'bad-argument') && /ESC/.test(errs[0].detail) && /LEFT/.test(errs[0].detail), J(errs));
    await g.call('boot', { model: 'mc10' });
    const noStick = await g.call('press_keys', { machine_id: 'm2', joystick: { fire: true } }), noLeft = await g.call('press_keys', { machine_id: 'm2', keys: ['LEFT'] });
    check('press_keys on the MC-10: no joystick port (rejected), and no LEFT key (bad-argument)', noStick.error && noStick.error.code === 'rejected' && noLeft.error && noLeft.error.code === 'bad-argument', J([noStick.error, noLeft.error]));
    const arrow = await g.call('type_text', Object.assign({ text: '\u2190' }, G));
    check('type_text of an arrow: not-typable, and the remedy points at press_keys', arrow.error && arrow.error.code === 'not-typable' && /press_keys/.test(arrow.error.remedy), J(arrow.error));
    await g.close();
  }

  // ---------------- the tape: its state in the machine summary, and run_frames until it stops or ends ----------------
  // Our programs drive the cassette motor (PIA1 CA2, $FF21): one leaves it on, one turns it off after a while.
  {
    const t = server(['--media-root', tmp('media')]);
    await t.init();
    await t.call('boot', { model: 'coco' });
    const T1 = { machine_id: 'm1' };
    await t.call('run_frames', Object.assign({ frames: 3 }, T1));
    const casLen = fs.statSync(tmp('media', 'prog.cas')).size;
    const none = await t.call('machine_info', T1);
    await t.call('insert_tape', Object.assign({ path: 'prog.cas' }, T1));
    const info0 = await t.call('machine_info', T1);
    const tape0 = info0.data.tape;
    check('machine_info: no tape, no tape field; a tape in the deck: its name, motor off, at byte 0 of its length, block 0 of 3, not at the end',
      !('tape' in none.data) && tape0 && tape0.name === 'prog.cas' && tape0.motor === false && tape0.position === 0 && tape0.length === casLen && tape0.percent === 0 && tape0.block === 0 && tape0.blocks === 3 && tape0.at_end === false, J(info0.data));
    await t.call('assemble_and_load', Object.assign({ source: ' ORG $3800\nS LDA #$3C\n STA $FF21\nL BRA L\n' }, T1));
    await t.call('run', Object.assign({ target: '$3800' }, T1));
    const playing = await t.call('run_frames', Object.assign({ frames: 200 }, T1));   // past the tape's 2 s of silence and its leader (js/media/tape.js)
    const mid = playing.data.machine.tape;
    const end = await t.call('run_frames', Object.assign({ frames: 1000, until: { tape: 'end' } }, T1));
    const atEnd = end.data.machine.tape;
    check('run_frames: the tape in its machine summary (motor on, moving); until tape "end": met when the last byte has played, at 100%',
      mid && mid.motor === true && mid.position > 0 && mid.position < casLen && mid.percent === Math.round(mid.position / casLen * 1000) / 10 && end.data.status === 'met' && end.data.frames_run < 1000 && atEnd.at_end === true && atEnd.position === casLen && atEnd.percent === 100 && atEnd.block === 3,
      J([mid, end.data.status, end.data.frames_run, atEnd]));
    // rewind (insert again) and turn the motor off after about 3.2 s, once the silence and leader have played: until tape "stopped"
    await t.call('insert_tape', Object.assign({ path: 'prog.cas' }, T1));
    await t.call('assemble_and_load', Object.assign({ source: ' ORG $3900\nS LDA #$3C\n STA $FF21\n LDB #12\nO LDX #30000\nD LEAX -1,X\n BNE D\n DECB\n BNE O\n LDA #$34\n STA $FF21\nL BRA L\n' }, T1));
    await t.call('run', Object.assign({ target: '$3900' }, T1));
    const stop = await t.call('run_frames', Object.assign({ frames: 1, until: { tape: 'stopped' } }, T1));
    const stop2 = await t.call('run_frames', Object.assign({ frames: 500, until: { tape: 'stopped' } }, T1));
    const st = stop2.data.machine.tape;
    check('until tape "stopped": not yet while the motor runs; met when the program turns it off, part way through the tape',
      stop.data.status === 'not-yet' && stop2.data.status === 'met' && stop2.data.frames_run > 5 && st.motor === false && st.position > 0 && st.position < casLen && st.at_end === false, J([stop.data.status, stop2.data.status, stop2.data.frames_run, st]));
    const badTape = await t.call('run_frames', Object.assign({ until: { tape: 'paused' } }, T1));
    await t.call('boot', { model: 'coco' });
    const noTape = await t.call('run_frames', { machine_id: 'm2', until: { tape: 'end' } });
    check('until tape: only "stopped" or "end"; with no tape in the deck: rejected', badTape.error && badTape.error.code === 'bad-argument' && noTape.error && noTape.error.code === 'rejected', J([badTape.error, noTape.error]));
    await t.close();
  }

  // ---------------- find_bytes: a pattern anywhere in memory, as the CPU sees it ----------------
  {
    const f = server(['--read-only']);
    await f.init();
    await f.call('boot', { model: 'coco' });
    const F = { machine_id: 'm1' };
    await f.call('run_frames', Object.assign({ frames: 3 }, F));
    // the built-in firmware's ROM holds what we look for too: an RTS ($39) is everywhere, so it shows the cap
    const lots = await f.call('find_bytes', Object.assign({ pattern: '39' }, F));
    check('find_bytes: at most 64 matches, in address order, as $hex, and says it stopped', lots.data && lots.data.matches.length === 64 && lots.data.truncated === true
      && lots.data.matches.every((a, i, l) => /^\$[0-9A-F]{4}$/.test(a) && (i === 0 || parseInt(a.slice(1), 16) > parseInt(l[i - 1].slice(1), 16))), J(lots.data && lots.data.matches.slice(0, 3)));
    await f.close();
    const w = server();
    await w.init();
    await w.call('boot', { model: 'coco' });
    await w.call('run_frames', Object.assign({ frames: 3 }, F));
    await w.call('poke', Object.assign({ address: 0x5000, bytes: [0xDE, 0xAD, 0xBE, 0xEF] }, F));
    await w.call('poke', Object.assign({ address: 0x6000, bytes: [0xDE, 0x00, 0xBE, 0xEF] }, F));
    const exact = await w.call('find_bytes', Object.assign({ pattern: 'DE AD BE EF' }, F));
    const wild = await w.call('find_bytes', Object.assign({ pattern: 'de??beef' }, F));
    const ranged = await w.call('find_bytes', Object.assign({ pattern: 'DE ?? BE EF', from: '$5800', to: '$7FFF' }, F));
    const edge = await w.call('find_bytes', Object.assign({ pattern: 'DE AD BE EF', from: '$5000', to: '$5003' }, F));
    const cut = await w.call('find_bytes', Object.assign({ pattern: 'DE AD BE EF', from: '$5000', to: '$5002' }, F));
    check('find_bytes: exact bytes, ?? for any byte (spaces optional, any case), within from-to (a match must fit inside it)',
      J(exact.data.matches) === J(['$5000']) && J(wild.data.matches) === J(['$5000', '$6000']) && J(ranged.data.matches) === J(['$6000']) && J(edge.data.matches) === J(['$5000']) && J(cut.data.matches) === J([]) && exact.data.truncated === false,
      J([exact.data, wild.data, ranged.data, edge.data, cut.data]));
    const errs = [];
    for (const a of [{ pattern: '' }, { pattern: 'XY' }, { pattern: 'ABC' }, { pattern: '?? ??' }, { pattern: '00'.repeat(33) }, { pattern: '00', from: '$6000', to: '$5000' }, { pattern: '00', from: 70000 }]) errs.push((await w.call('find_bytes', Object.assign(a, F))).error);
    check('find_bytes refuses an empty pattern, non-hex, half a byte, only wildcards, more than 32 bytes, a range backwards or out of memory',
      errs.every((e) => e && e.code === 'bad-argument'), J(errs));
    await w.close();
  }

  // ---------------- the picture shows what until saw ----------------
  // The VDG draws each line as the beam passes it, so a character written after the beam has passed its row shows from
  // the next frame. Our program clears the screen and writes K at $400 part way through a frame: when until.text is met,
  // the screenshot must show the whole K (its 12 lines), at scale 1 and 2.
  {
    const k = server();
    await k.init();
    await k.call('boot', { model: 'coco' });
    const K = { machine_id: 'm1' };
    await k.call('run_frames', Object.assign({ frames: 3 }, K));
    await k.call('assemble_and_load', Object.assign({ source: ' ORG $3A00\nS ORCC #$50\n LDS #$7F00\n LDX #$400\n LDA #$60\nC STA ,X+\n CMPX #$600\n BNE C\n LDX #20000\nD LEAX -1,X\n BNE D\n LDA #$0B\n STA $400\nL BRA L\n' }, K));
    await k.call('run', Object.assign({ target: '$3A00' }, K));
    const met = await k.call('run_frames', Object.assign({ frames: 60, until: { text: 'K' } }, K));
    const shot = async (scale) => pngPixels(Buffer.from((await k.call('screenshot', Object.assign({ scale }, K))).res.content.find((c) => c.type === 'image').data, 'base64'));
    const one = await shot(1), two = await shot(2);
    // the K's cell is x 32-39, y 24-35 at scale 1; a blank cell (x 72-79) is the reference
    const cellRows = (px, w, sc, x0) => Array.from({ length: 12 * sc }, (_, r) => px.subarray(((24 * sc + r) * w + x0 * sc) * 4, ((24 * sc + r) * w + (x0 + 8) * sc) * 4));
    const kRows = cellRows(one, 320, 1, 32), blank = cellRows(one, 320, 1, 72);
    const drawn = kRows.filter((row, i) => !row.equals(blank[i])).length;
    const k2 = cellRows(two, 640, 2, 32);
    let doubled = true;
    for (let r = 0; r < 24 && doubled; r++) for (let x = 0; x < 16 && doubled; x++) doubled = k2[r].readUInt32LE(x * 4) === kRows[r >> 1].readUInt32LE((x >> 1) * 4);
    await k.call('run_frames', Object.assign({ frames: 1 }, K));
    const later = await shot(1);
    check('until text met: the screenshot shows the whole K (the frame after the one in which it was written), the same as a frame later, and doubled exactly at scale 2',
      met.data.status === 'met' && drawn >= 10 && one.equals(later) && doubled, J([met.data.status, met.data.frames_run, drawn, one.equals(later), doubled]));
    await k.close();
  }

  // ---------------- run_frames until the screen changes ----------------
  // Our program waits ~0.3 s (a countdown), then writes one cell of the text screen at $400 and loops: what it writes
  // is poked into it (the byte at W+1, an LDA #). A character and a semigraphics block shape are changes; a block whose
  // colour alone changes (as BASIC's cursor blinks) is not. In a graphics mode the pixels are compared.
  {
    const c = server();
    await c.init();
    await c.call('boot', { model: 'coco' });
    const C = { machine_id: 'm1' };
    await c.call('run_frames', Object.assign({ frames: 3 }, C));
    // (interrupts off and the stack out of the way: in a graphics mode an interrupt's pushes would be on the screen)
    const prog = (value, at = '$0400') => ` ORG $3A00\nS ORCC #$50\n LDS #$7F00\n LDX #20000\nD LEAX -1,X\n BNE D\nW LDA #${value}\n STA ${at}\nL BRA L\n`;
    const wait = async (value, at) => {
      await c.call('assemble_and_load', Object.assign({ source: prog(value, at) }, C));
      await c.call('run', Object.assign({ target: '$3A00' }, C));
      return (await c.call('run_frames', Object.assign({ frames: 60, until: { screen: 'changed' } }, C))).data;
    };
    await c.call('poke', Object.assign({ address: 0x400, bytes: [0x8F] }, C));   // a green block to start from
    const colourOnly = await wait('$9F');       // the same block shape in yellow: no change
    const shape = await wait('$93');            // another shape: a change
    const text = await wait('$01');             // the letter A: a change
    const same = await wait('$01');             // A again: nothing changes
    check('until screen "changed": a new character and a new block shape stop it (part way, not at once); a block\'s colour alone or writing what is there does not',
      colourOnly.status === 'not-yet' && colourOnly.frames_run === 60 && shape.status === 'met' && shape.frames_run > 5 && shape.frames_run < 60 && text.status === 'met' && text.frames_run > 5 && same.status === 'not-yet',
      J([colourOnly, shape, text, same].map((d) => [d.status, d.frames_run])));
    // a graphics mode (the firmware's $3800 program sets PMODE 4 through the SAM and VDG): the pixels are compared
    const gfx = ' ORG $3800\nS ORCC #$50\n LDS #$7F00\n LDA #$F8\n STA $FF22\n STA $FFC0\n STA $FFC3\n STA $FFC5\nL BRA L\n';
    await c.call('assemble_and_load', Object.assign({ source: gfx }, C));
    await c.call('run', Object.assign({ target: '$3800' }, C));
    await c.call('run_frames', Object.assign({ frames: 5 }, C));   // the new mode settles over a frame or two
    const pmode4 = await c.call('machine_info', C);
    check('machine_info over MCP: $F8 (PMODE 4) is RG6, 256x192 in 2 colours', pmode4.data.video.mode === 'MC6847 graphics, RG6 256x192 2-colour', J(pmode4.data.video));
    const g = await wait('$FF', '$0410');       // 8 pixels lit in the picture at $400
    check('until screen "changed" in a graphics mode: a change in the picture stops it', g.status === 'met' && g.frames_run > 5 && g.frames_run < 60, J([g.status, g.frames_run]));
    const badScreen = await c.call('run_frames', Object.assign({ until: { screen: 'same' } }, C));
    check('until screen: only "changed"', badScreen.error && badScreen.error.code === 'bad-argument', J(badScreen.error));
    await c.close();
  }

  // ---------------- a screenshot is a whole frame ----------------
  // The VDG draws each line as the beam reaches it. Stopped part way through a frame (step, or run_frames until a pc),
  // the frame being drawn is not shown: screenshot gives the last complete frame and says the machine is mid-frame.
  {
    const v = server();
    await v.init();
    await v.call('boot', { model: 'coco' });
    const V = { machine_id: 'm1' };
    await v.call('run_frames', Object.assign({ frames: 3 }, V));   // the firmware sets the VDG to text at $400
    await v.call('assemble_and_load', Object.assign({ source: ' ORG $3800\nL BRA L\n' }, V));
    await v.call('run', Object.assign({ target: '$3800' }, V));
    await v.call('run_frames', Object.assign({ frames: 2 }, V));
    const pixels = async () => { const r = await v.call('screenshot', V); return { data: r.data, px: pngPixels(Buffer.from(r.res.content.find((c) => c.type === 'image').data, 'base64')) }; };
    const before = await pixels();
    // new text on the top and the bottom row, then half a frame of BRA L (3 cycles each; a frame is 14,934)
    const fill = Array(32).fill(0xFF);   // orange blocks (SG4 colour 7) on the green text screen
    await v.call('poke', Object.assign({ address: 0x400, bytes: fill }, V));
    await v.call('poke', Object.assign({ address: 0x5E0, bytes: fill }, V));
    await v.call('step', Object.assign({ count: 2500 }, V));
    const mid = await pixels();
    check('screenshot inside a frame (after step): the last complete frame, and it says so', mid.px.equals(before.px) && mid.data.mid_frame === true && before.data.mid_frame === false, J([before.data, mid.data]));
    await v.call('run_frames', Object.assign({ frames: 1 }, V));
    const after = await pixels();
    // A step that crosses a frame's end: the frame it closed is the last complete one (drawn with the new bottom row,
    // the beam having passed the top before the poke), and the machine is inside the next one. The oracle: a second
    // machine doing the same and finishing that frame in the frame loop. A step of 10,000 crosses two frame ends: the
    // picture is the second frame it closed (drawn entirely after the poke: top row new too), not the first.
    const crossed = {};
    for (const [key, finish] of [['step', { count: 5000 }], ['frames', 1], ['step2', { count: 10000 }], ['frames2', 2]]) {
      const w = server();
      await w.init();
      await w.call('boot', { model: 'coco' });
      await w.call('run_frames', Object.assign({ frames: 3 }, V));
      await w.call('assemble_and_load', Object.assign({ source: ' ORG $3800\nL BRA L\n' }, V));
      await w.call('run', Object.assign({ target: '$3800' }, V));
      await w.call('run_frames', Object.assign({ frames: 2 }, V));
      await w.call('step', Object.assign({ count: 2500 }, V));
      await w.call('poke', Object.assign({ address: 0x400, bytes: fill }, V));
      await w.call('poke', Object.assign({ address: 0x5E0, bytes: fill }, V));
      const f0 = { frame: (await w.call('list_machines', {})).data.machines[0].frame };
      if (typeof finish === 'object') await w.call('step', Object.assign(finish, V)); else await w.call('run_frames', Object.assign({ frames: finish }, V));
      const r = await w.call('screenshot', V);
      crossed[key] = { data: r.data, px: pngPixels(Buffer.from(r.res.content.find((c) => c.type === 'image').data, 'base64')), framesBefore: f0.frame, framesAfter: (await w.call('list_machines', {})).data.machines[0].frame };
      await w.close();
    }
    {
      const s = crossed.step, f = crossed.frames, W0 = s.data.width, r0 = (px, y) => px.subarray(y * W0 * 4, (y + 1) * W0 * 4);
      check('screenshot after a step that crosses a frame end: mid_frame true, and the frame the step closed (as the frame loop draws it; its bottom row new)',
        s.framesAfter === s.framesBefore + 1 && s.data.mid_frame === true && f.data.mid_frame === false && s.px.equals(f.px)
        && !r0(s.px, 30 + 15 * 12).equals(r0(before.px, 30 + 15 * 12)), J([s.framesBefore, s.framesAfter, s.data, f.data, s.px.equals(f.px)]));
      const s2 = crossed.step2, f2 = crossed.frames2;
      check('screenshot after one step call that crosses two frame ends: mid_frame true, and the last frame it closed (top and bottom rows new), not the first',
        s2.framesAfter === s2.framesBefore + 2 && s2.data.mid_frame === true && f2.data.mid_frame === false && s2.px.equals(f2.px)
        && !r0(s2.px, 30).equals(r0(before.px, 30)) && !r0(s2.px, 30 + 15 * 12).equals(r0(before.px, 30 + 15 * 12)) && !s2.px.equals(s.px),
        J([s2.framesBefore, s2.framesAfter, s2.data, f2.data, s2.px.equals(f2.px)]));
    }
    const W = after.data.width, row = (px, y) => px.subarray(y * W * 4, (y + 1) * W * 4);
    const top = 30, bottom = 30 + 15 * 12;   // inside the first and the last text row (border 24 lines, 12 lines a row)
    check('screenshot after the frame ends: the new frame, top and bottom rows both drawn', after.data.mid_frame === false && !row(after.px, top).equals(row(before.px, top)) && !row(after.px, bottom).equals(row(before.px, bottom)), J(after.data));
    // run_frames until a pc in the middle of a frame: the same rule
    // (a countdown of 1000 x 8 cycles from a frame's start: H is reached about half way through it)
    const cd = await v.call('assemble_and_load', Object.assign({ source: ' ORG $3900\nS LDX #1000\nD LEAX -1,X\n BNE D\nH BRA H\n' }, V));
    await v.call('run', Object.assign({ target: '$3900' }, V));
    const shownBefore = (await pixels()).px;
    await v.call('poke', Object.assign({ address: 0x400, bytes: Array(32).fill(0x80) }, V));
    const atPc = await v.call('run_frames', Object.assign({ frames: 5, until: { pc: cd.data.symbols.H } }, V));
    const shot = await pixels();
    check('screenshot after run_frames stops at a pc inside a frame: the last complete frame, mid_frame true', atPc.data.status === 'met' && atPc.data.frames_run === 0 && shot.data.mid_frame === true && shot.px.equals(shownBefore), J([atPc.data, shot.data]));
    // A change made inside a frame (timed from field sync to fall between the top and the bottom text rows; then run_frames
    // stops at DONE): the next frame began before the
    // change, so its top is still the old picture (as on the hardware); the one after is drawn entirely after it
    await v.call('poke', Object.assign({ address: 0x400, bytes: Array(32).fill(0x60) }, V));
    await v.call('poke', Object.assign({ address: 0x5E0, bytes: Array(32).fill(0x60) }, V));
    await v.call('run_frames', Object.assign({ frames: 2 }, V));   // 2: the machine had stopped inside a frame (this very rule)
    const half = await v.call('assemble_and_load', Object.assign({ source: ' ORG $3B00\nS ORCC #$50\n LDA $FF02\nW LDA $FF03\n BPL W\n LDX #1000\nD LEAX -1,X\n BNE D\n LDA #$FF\n LDX #$400\nT STA ,X+\n CMPX #$420\n BNE T\n LDX #$5E0\nB STA ,X+\n CMPX #$600\n BNE B\nDONE BRA DONE\n' }, V));
    await v.call('run', Object.assign({ target: '$3B00' }, V));
    const oldPic = (await pixels()).px;
    const stop = await v.call('run_frames', Object.assign({ frames: 5, until: { pc: half.data.symbols.DONE } }, V));
    const plus0 = await pixels();
    await v.call('run_frames', Object.assign({ frames: 1 }, V));
    const plus1 = await pixels();
    await v.call('run_frames', Object.assign({ frames: 1 }, V));
    const plus2 = await pixels();
    check('a change inside a frame: +0 the last whole frame (mid_frame); +1 a whole frame that began before it (top old, bottom new); +2 drawn entirely after it, as the description says',
      stop.data.status === 'met' && plus0.data.mid_frame === true && plus0.px.equals(oldPic)
      && plus1.data.mid_frame === false && row(plus1.px, top).equals(row(oldPic, top)) && !row(plus1.px, bottom).equals(row(oldPic, bottom))
      && !row(plus2.px, top).equals(row(oldPic, top)) && !row(plus2.px, bottom).equals(row(oldPic, bottom)), J([stop.data.status, plus0.data, plus1.data, plus0.px.equals(oldPic), row(plus1.px, top).equals(row(oldPic, top)), row(plus1.px, bottom).equals(row(oldPic, bottom)), row(plus2.px, top).equals(row(oldPic, top))]));
    const desc = (await v.request('tools/list', {})).result.tools.find((t) => t.name === 'screenshot').description;
    check('screenshot\'s description says run_frames 2 shows a frame drawn entirely after the stop', /run_frames 2 to see a frame drawn entirely after this point/.test(desc), desc);
    // scale: each pixel repeated 2 or 3 times across and down (nearest neighbour), nothing else changed
    const one = await pixels(), two = await v.call('screenshot', Object.assign({ scale: 2 }, V));
    const big = pngPixels(Buffer.from(two.res.content.find((c) => c.type === 'image').data, 'base64'));
    let same = two.data.width === 640 && two.data.height === 480 && big.length === 640 * 480 * 4;
    for (let y = 0; same && y < 480; y++) for (let x = 0; same && x < 640; x++) same = big.readUInt32LE((y * 640 + x) * 4) === one.px.readUInt32LE(((y >> 1) * 320 + (x >> 1)) * 4);
    const badScale = await v.call('screenshot', Object.assign({ scale: 4 }, V)), halfScale = await v.call('screenshot', Object.assign({ scale: 1.5 }, V));
    check('screenshot scale 2: 640x480, every pixel the scale-1 pixel it covers; scale 4 or 1.5: bad-argument', same && badScale.error && badScale.error.code === 'bad-argument' && halfScale.error && halfScale.error.code === 'bad-argument', J([two.data, badScale.error]));
    await v.close();
  }

  // ---------------- --read-only ----------------
  const r = server(['--read-only', '--media-root', tmp('media')]);
  const rInit = await r.init();
  const rl = (await r.request('tools/list', {})).result.tools.map((t) => t.name);
  const hiddenNamed = want.filter((t) => !rl.includes(t) && new RegExp(`\\b${t}\\b`).test(rInit.result.instructions));
  const fullNamed = want.filter((t) => new RegExp(`\\b${t}\\b`).test(init.result.instructions));
  check('--read-only: the instructions name no hidden tool and say read-only mode is on; the full server\'s name only tools it has',
    !hiddenNamed.length && /Read-only mode: input, memory writes, media and snapshots are disabled/.test(rInit.result.instructions) && !/Read-only mode/.test(init.result.instructions)
    && fullNamed.includes('type_text') && fullNamed.includes('press_keys'), J([hiddenNamed, fullNamed]));
  check('--read-only: the instructions still open with the route line', rInit.result.instructions.split('\n')[0] === require('../cli/mcp.js').LOCAL_ROUTE_LINE, J(rInit.result.instructions.split('\n')[0]));
  check('--read-only: only the tools that leave input, memory and files alone (plus booting, closing and running machines)', J(rl) === J(['list_models', 'list_machines', 'boot', 'close_machine', 'machine_info', 'screen_text', 'peek', 'disassemble', 'find_bytes', 'run_frames', 'registers', 'screenshot', 'set_display']), J(rl));
  await r.call('boot', { model: 'coco' });
  const refused = await r.call('poke', { machine_id: 'm1', address: 0x3000, bytes: [1] }), refusedFile = await r.call('save_snapshot', { machine_id: 'm1', path: 'x.cloadm-state' });
  check('--read-only: an acting tool is refused with read-only (and a remedy), not run', refused.error.code === 'read-only' && refusedFile.error.code === 'read-only' && !fs.existsSync(tmp('media', 'x.cloadm-state')), J([refused.error, refusedFile.error]));
  await r.close();

  // ---------------- --serve ----------------
  const sv = await serveRun([
    { id: 1, tool: 'boot', arguments: { model: 'coco3' } },
    { id: 2, tool: 'load', arguments: { machine_id: 'm1', program: 'welcome' } },
    { id: 3, tool: 'run_frames', arguments: { machine_id: 'm1', frames: 40 } },
    { id: 4, tool: 'screenshot', arguments: { machine_id: 'm1' } },
    { id: 5, tool: 'peek', arguments: { machine_id: 'm1', address: 70000 } },
    'not json',
    { id: 7, tool: 'nope', arguments: {} },
    'null',
    { id: 9, tool: 'list_machines', arguments: {} },
  ]);
  const here = new Emu.Session({ welcomeMenu: false });
  here.switchMachine('coco3', {}, { menu: false });
  here.startWelcome(new Uint8Array(fs.readFileSync(path.join(ROOT, 'examples', here.welcomeFile))));
  here.runFrames(40);
  const px = pngPixels(Buffer.from(sv.replies[3].result.png, 'base64'));
  check('--serve: replies in order with their ids; a screenshot\'s PNG is machine.render()\'s pixels', sv.code === 0 && J(sv.replies.map((x) => x.id)) === J([1, 2, 3, 4, 5, null, 7, null, 9]) && sv.replies[3].ok
    && px.equals(Buffer.from(Emu.frameToRGBA(here.shownMachine.render()).buffer)), J(sv.replies.map((x) => x.ok)));
  check('--serve: errors in the tools\' shape', sv.replies[4].error.code === 'bad-address' && sv.replies[5].error.code === 'bad-argument' && sv.replies[6].error.code === 'bad-argument' && /no tool "nope"/.test(sv.replies[6].error.detail)
    && sv.replies[7].error.code === 'bad-argument' && sv.replies[8].ok, J(sv.replies.slice(4)));

  // ---------------- a call that runs into the wall-time limit (a host too slow to finish it) ----------------
  // type_text of 150 keys on a host whose clock runs 20 ms a frame, with a 2 s limit: it is stopped part way. It must
  // say so (time-limit, "N of 150 keys typed"), never cut the text silently or blame the person ("stopped").
  {
    const T = await import(require('url').pathToFileURL(path.join(ROOT, 'js/mcp/tools.js')).href);
    const programs = (f) => new Uint8Array(fs.readFileSync(path.join(ROOT, 'examples', path.basename(f))));
    let t = 0;
    const host = { roms: () => [], png: () => new Uint8Array(0), program: programs, now: () => (t += 20), date: () => new Date(0), yield: () => new Promise(setImmediate),
      readMedia() { throw new T.McpToolError('no-media-root'); }, writeMedia() { throw new T.McpToolError('no-media-root'); } };
    const own = new Emu.Session({ welcomeMenu: false });
    own.switchMachine('dragon64', {}, { menu: false });
    own.startWelcome(programs(own.welcomeFile));
    own.runFrames(40);
    const tb = T.createToolbox(host, { session: own, wallMs: 2000 });
    const m = own.shownMachine, before = m.stubKeysTaken;
    const r = await tb.call('type_text', { machine_id: 'm1', text: 'L'.repeat(150) });
    const got = /^(\d+) of 150 keys typed before the time limit; the rest was not typed$/.exec((r.error && r.error.detail) || '');
    const typed = m.stubKeysTaken - before;
    check('type_text past the wall-time limit: time-limit, saying how many of the keys went in (not "stopped": nobody stopped it)',
      !r.ok && r.error.code === 'time-limit' && /time limit/.test(r.error.remedy) && !!got && Number(got[1]) > 0 && Number(got[1]) < 150 && Number(got[1]) === typed, J(r).slice(0, 300));
    own.runFrames(200);
    check('... and nothing more goes in after it returns', m.stubKeysTaken - before === typed && m.stubKeys.length === 0 && !m.typist.busy, `${m.stubKeysTaken - before} vs ${typed}`);
  }
  // the call that does not finish even once it is stopped (here, part way, the machine stops running frames and the
  // typing job stops ending, so the stop at the limit cannot end it; a Debugger stop would be machine-stopped
  // instead): time-limit still says how many of the keys went in
  {
    const T = await import(require('url').pathToFileURL(path.join(ROOT, 'js/mcp/tools.js')).href);
    const programs = (f) => new Uint8Array(fs.readFileSync(path.join(ROOT, 'examples', path.basename(f))));
    let t = 0, own = null;
    const host = { roms: () => [], png: () => new Uint8Array(0), program: programs, date: () => new Date(0), yield: () => new Promise(setImmediate),
      now: () => { t += 20; if (t === 1500) { own.runFrames = () => 0; const j = own.shownMachine.typist.state && own.shownMachine.typist.state.job; if (j) j.end = () => {}; } return t; },
      readMedia() { throw new T.McpToolError('no-media-root'); }, writeMedia() { throw new T.McpToolError('no-media-root'); } };
    own = new Emu.Session({ welcomeMenu: false });
    own.switchMachine('dragon64', {}, { menu: false });
    own.startWelcome(programs(own.welcomeFile));
    own.runFrames(40);
    const tb = T.createToolbox(host, { session: own, wallMs: 2000 });
    const m = own.shownMachine, before = m.stubKeysTaken;
    const r = await tb.call('type_text', { machine_id: 'm1', text: 'L'.repeat(150) });
    const got = /^(\d+) of 150 keys typed before the time limit; the call did not finish$/.exec((r.error && r.error.detail) || '');
    check('type_text that does not finish even when stopped: time-limit, still saying how many of the keys went in',
      !r.ok && r.error.code === 'time-limit' && !!got && Number(got[1]) > 0 && Number(got[1]) < 150, J(r).slice(0, 300));
  }

  // ---------------- a host that has its own machine (Claude's side panel, connector/view/) ----------------
  {
    const T = await import(require('url').pathToFileURL(path.join(ROOT, 'js/mcp/tools.js')).href);
    const programs = (f) => new Uint8Array(fs.readFileSync(path.join(ROOT, 'examples', path.basename(f))));
    const host = { roms: () => [], png: () => new Uint8Array(0), program: programs, now: () => 0, date: () => new Date(0), yield: () => new Promise(setImmediate),
      readMedia() { throw new T.McpToolError('no-media-root'); }, writeMedia() { throw new T.McpToolError('no-media-root'); } };
    const own = new Emu.Session({ welcomeMenu: false });
    own.switchMachine('coco3', {}, { menu: false });
    own.startWelcome(programs(own.welcomeFile));
    own.runFrames(40);
    const tb = T.createToolbox(host, { session: own, refuseRomReads: true });
    const names = tb.tools().map((t) => t.name);
    {
      const d = (t, n) => t.tools().find((x) => x.name === n).description;
      check('own session: boot and load (the panel itself) do not send the person elsewhere', ['boot', 'load'].every((n) => !/side-panel connector/.test(d(tb, n))));
    }
    check('own session: the host\'s machine is m1 at once; close_machine is not offered', !names.includes('close_machine') && names.includes('boot')
      && J((await tb.call('list_machines', {})).data.machines.map((m) => m.machine_id)) === '["m1"]', names.join(','));
    const r = await tb.call('screen_text', { machine_id: 'm1' });
    check('own session: the tools read the host\'s Session as the page does', r.ok && J(r.data.machine_output) === J(Emu.runReadOnlyTool(own.chatTarget(), 'screen_text', {})), J(r).slice(0, 200));
    const poked = await tb.call('poke', { machine_id: 'm1', address: 0x3F00, bytes: [7] });
    check('own session: the tools act on the host\'s Session itself', poked.ok && own.readByte(0x3F00) === 7);
    const booted = await tb.call('boot', { model: 'dragon32' });
    check('own session: boot switches the host\'s machine in place and returns m1', booted.ok && booted.data.machine.machine_id === 'm1' && own.shownMachine.id === 'dragon32'
      && /already on/.test(tb.tools().find((t) => t.name === 'boot').description), J(booted).slice(0, 200));
    const sw = await tb.call('switch_machine', { machine_id: 'm1', model: 'coco', options: { ram: 64 } });
    check('own session: switch_machine changes the same Session', sw.ok && own.shownMachine.id === 'coco' && own.shownMachine.config.ram === 64, J(sw).slice(0, 200));
    // ---- a machine the Debugger has stopped (a stop it keeps): the tools that must run it or press its
    // keys refuse with machine-stopped and change nothing; every read works and leaves it stopped; step steps and
    // leaves it stopped; after Resume everything works again; a launch (reset) releases it
    {
      const st = new Emu.Session({ welcomeMenu: false });
      st.switchMachine('dragon64', {}, { menu: false });
      st.startWelcome(programs(st.welcomeFile));
      st.runFrames(40);
      const tbs = T.createToolbox(host, { session: st });
      const id = { machine_id: 'm1' };
      st.debug.halt();
      const m0 = st.shownMachine, f0 = m0.frameCount, keys0 = m0.stubKeys.length, pc0 = st.debug.pc;
      const remedy = Emu.TOOL_ERRORS['machine-stopped'];
      for (const [tool, args] of [['type_text', { text: '1' }], ['press_break', {}], ['run', { target: 0x3000 }], ['run', { target: 'RUN' }],
        ['press_keys', { keys: ['1'] }], ['run_frames', { frames: 5 }], ['run_frames', { frames: 5, until: { pc: 0x3000 } }]]) {
        const r = await tbs.call(tool, Object.assign({}, id, args));
        check(`stopped: ${tool} ${J(args)} refuses with machine-stopped, where it stopped and the remedy; nothing ran or was queued`,
          !r.ok && r.error.code === 'machine-stopped' && r.error.remedy === remedy && r.error.detail === `stopped in the Debugger at ${Emu.hex(pc0)} (halt)`
          && st.paused && m0.frameCount === f0 && m0.stubKeys.length === keys0 && st.debug.pc === pc0, J(r).slice(0, 300));
      }
      for (const [tool, args] of [['screen_text', {}], ['peek', { address: 0x400, length: 4 }], ['registers', {}], ['screenshot', {}], ['disassemble', { address: pc0, count: 2 }],
        ['machine_info', {}], ['find_bytes', { pattern: '00' }], ['poke', { address: 0x3F00, bytes: [5] }], ['assemble_and_load', { source: ' NOP\n', org: 0x3E00 }]]) {
        const r = await tbs.call(tool, Object.assign({}, id, args));
        check(`stopped: ${tool} works on the stopped machine and leaves it stopped`, r.ok && st.paused && m0.frameCount === f0, J(r).slice(0, 200));
      }
      check('stopped: poke and assemble_and_load wrote', st.readByte(0x3F00) === 5 && st.readByte(0x3E00) === 0x12);
      const stepped = await tbs.call('step', Object.assign({}, id, { count: 3 }));
      check('stopped: step steps (3 instructions) and leaves the machine stopped, where the steps ended', stepped.ok && stepped.data.instructions === 3 && st.paused
        && st.debug.pc !== pc0 && stepped.data.registers.pc === st.debug.pc, J(stepped).slice(0, 200));
      // the stop step leaves keeps the reason the steps gave: a watchpoint hit stays a watchpoint stop (not a halt)
      {
        const asm = Emu.assemble(' ORG $3000\nGO LDA #1\n STA $3100\n BRA GO\n', '6809');
        st.pokeBytes(0x3000, [...asm.segments[0].data]);
        st.shownMachine.cpu.jump(0x3000);
        st.debug.addWatchpoint(0x3100, 1, { read: false, write: true });
        const w = await tbs.call('step', Object.assign({}, id, { count: 2 }));
        check('stopped: step that hits a watchpoint leaves the machine stopped with the watchpoint as the reason',
          w.ok && st.paused && st.debug.stopReason.kind === 'watchpoint' && st.debug.stopReason.address === 0x3100, J([w, st.debug.stopReason]).slice(0, 240));
        st.debug.clearWatchpoints();
        // (the welcome program again, which reads the keys the checks below type: a launch, so it releases the stop)
        st.startWelcome(programs(st.welcomeFile));
        st.runFrames(40);
      }
      st.resume();
      const typed = await tbs.call('type_text', Object.assign({}, id, { text: '1' }));
      const ranOn = await tbs.call('run_frames', Object.assign({}, id, { frames: 5 }));
      const pressed = await tbs.call('press_keys', Object.assign({}, id, { keys: ['SPACE'] }));
      check('stopped: after Resume, type_text, run_frames and press_keys work again', typed.ok && ranOn.ok && ranOn.data.frames_run === 5 && pressed.ok,
        J([typed, ranOn, pressed]).slice(0, 300));
      const runningStep = await tbs.call('step', Object.assign({}, id, { count: 1 }));
      check('stopped: step on a running machine leaves it running, as before', runningStep.ok && !st.paused, J(runningStep).slice(0, 200));
      st.debug.halt();
      const reset = await tbs.call('reset', id);
      check('stopped: a launch (reset) releases the stop, and the machine runs', reset.ok && !st.paused && (await tbs.call('run_frames', Object.assign({}, id, { frames: 3 }))).ok);
    }
    // ---- a stop made DURING a call (the review's probe: a host whose yield, called once a frame while a call runs,
    // makes the Debugger stop after a few frames, as the person's Pause would): the call fails machine-stopped with
    // where it stopped, whatever was in flight is dropped, and the person's stop is left as it is
    {
      const st = new Emu.Session({ welcomeMenu: false });
      st.switchMachine('dragon64', {}, { menu: false });
      st.runLiza(programs(st.lizaFile));
      st.runFrames(150);
      let haltIn = 0;
      const probe = Object.assign({}, host, { yield: () => { if (haltIn > 0 && --haltIn === 0) st.debug.halt(); return new Promise(setImmediate); } });
      const tbp = T.createToolbox(probe, { session: st });
      const id = { machine_id: 'm1' }, m = st.shownMachine;
      const midCall = async (tool, args, n = 5) => { st.resume(); haltIn = n; const r = await tbp.call(tool, Object.assign({}, id, args)); haltIn = 0; return r; };
      const where = (r) => !r.ok && r.error.code === 'machine-stopped' && /^stopped in the Debugger at \$[0-9A-F]{4} \(halt\)/.test(r.error.detail || '');
      for (const [label, args] of [['run_frames', { frames: 200 }], ['run_frames until text', { frames: 200, until: { text: 'NEVER ON SCREEN' } }]]) {
        const f0 = m.frameCount;
        const r = await midCall('run_frames', args);
        check(`mid-call stop: ${label} fails machine-stopped (not ok, not "not-yet"), and the machine stays stopped`, where(r) && st.paused && m.frameCount - f0 < 200, J(r).slice(0, 240));
      }
      {
        const r = await midCall('run_frames', { frames: 200, until: { pc: 0x0001 } });
        check('mid-call stop: run_frames until pc fails machine-stopped, does NOT resume the person\'s stop, and takes its breakpoint away',
          where(r) && st.paused && !st.debug.breakpoints().includes(0x0001), J(r).slice(0, 240));
      }
      {
        // its own stop: a pc the program reaches is met, and the machine runs on
        st.resume(); st.runFrames(2); st.debug.halt(); const pc = st.debug.pc; st.resume();
        const r = await tbp.call('run_frames', Object.assign({}, id, { frames: 200, until: { pc } }));
        check('run_frames until pc: its own breakpoint stop is met and resumed, as before', r.ok && r.data.status === 'met' && !st.paused, J(r).slice(0, 200));
      }
      {
        const held = new Map(), set = m.setKey.bind(m);
        m.setKey = (k, down) => { held.set(k, down); return set(k, down); };
        const r = await midCall('press_keys', { keys: ['A'], frames: 200 });
        m.setKey = set;
        check('mid-call stop: press_keys fails machine-stopped and lets go of the keys', where(r) && st.paused && held.get('A') === false, J(r).slice(0, 240));
      }
      {
        const text = 'I FEEL QUITE WELL TODAY THANK YOU VERY MUCH\n';
        const r = await midCall('type_text', { text }, 8);
        const m2 = /(\d+) of (\d+) keys typed, the rest dropped/.exec((r.error && r.error.detail) || '');
        const queued = m.typist.queue.length + m.stubKeys.length;
        st.resume(); st.runFrames(100);
        check('mid-call stop: type_text fails machine-stopped (not a time-out), saying how many keys went in; the rest is dropped and none goes in after Resume',
          where(r) && m2 && +m2[1] < +m2[2] && +m2[2] === text.length && queued === 0 && m.typist.queue.length === 0 && m.stubKeys.length === 0, J({ r, queued }).slice(0, 300));
      }
    }
    let notSession = null;
    try { T.createToolbox(host, { session: { machine: {} } }); } catch (e) { notSession = e.message; }
    check('own session: only a Session', /session must be a Session/.test(notSession), notSession);
    let badRoute = null;
    try { T.createToolbox(host, { route: 'phone' }); } catch (e) { badRoute = e.message; }
    check('route: only "local" or "panel"', /route must be local or panel/.test(badRoute), badRoute);
    // the games, by name, as on the page (Session.runGame); refused where the page refuses them
    const game = await tb.call('load', { machine_id: 'm1', program: '2048' });
    const ran = await tb.call('run_frames', { machine_id: 'm1', frames: 100 });
    const graphics = await tb.call('screen_text', { machine_id: 'm1' });
    // THE GAME IS RUNNING. This machine has no user ROMs, so on a CoCo with 64K the built-in key vector at $A000
    // is not there: the game's `JSR [POLCAT]` lands in the stub ROM and the PC is OUTSIDE the program for 2 frames
    // in every 6, on a fixed 2,4,2,4-frame cycle. A single sample therefore says nothing -- the old check read the
    // PC once at frame 100 and passed only when that frame happened to fall inside the cycle (it does on main; this
    // branch's title runs one frame longer, so the same sample fell outside and the check went red without anything
    // about the game changing). Two properties are independent of where the window starts: the game is inside its
    // own program on most frames, and it keeps COMING BACK into it (a game stuck in the ROM, or one that exited its
    // loop, does neither). Measured over 300 frames on both trees: 200/300 frames inside (66.7%) and 49-50 returns.
    const bin2048 = fs.readFileSync(path.join(ROOT, 'examples/2048.bin'));
    const progStart = bin2048.readUInt16BE(2), progEnd = progStart + bin2048.readUInt16BE(4);
    const FRAMES = 300;
    let inProgram = 0, reentries = 0, wasInside = null;
    for (let i = 0; i < FRAMES; i++) {
      await tb.call('run_frames', { machine_id: 'm1', frames: 1 });
      const pc = own.shownMachine.cpu.pc, nowInside = pc >= progStart && pc < progEnd;
      if (nowInside) inProgram++;
      if (nowInside && wasInside === false) reentries++;
      wasInside = nowInside;
    }
    const running = inProgram > FRAMES / 2 && reentries >= 10;
    check('load: the bundled game 2048 runs (its board is in a graphics mode)', game.ok && game.data.loaded === '2048' && ran.ok && running
      && graphics.ok && graphics.data.machine_output.text === false,
      J([{ insideFrames: `${inProgram}/${FRAMES}`, reentries }, game, graphics]).slice(0, 300));
    const mines = await tb.call('load', { machine_id: 'm1', program: 'minesweeper' });
    check('load: minesweeper too', mines.ok && own.shownMachine.cpu.pc >= 0x3000, J(mines).slice(0, 200));
    await tb.call('boot', { model: 'mc10' });
    const no6809 = await tb.call('load', { machine_id: 'm1', program: '2048' });
    check('load: a game on a machine that cannot run it is refused as the page refuses it', !no6809.ok && no6809.error.code === 'rejected' && /6809 code/.test(no6809.error.detail), J(no6809));
    const badProg = await tb.call('load', { machine_id: 'm1', program: 'tetris' });
    check('load: an unknown program names the bundled ones', !badProg.ok && /welcome, liza, demo, 2048 or minesweeper/.test(badProg.error.detail), J(badProg));
    // no tool returns ROM memory directly on a host that refuses ROM reads: with the user's ROMs (here bytes standing in for them) peek,
    // find_bytes and disassemble are refused; without ROMs they read
    await tb.call('boot', { model: 'dragon32', roms: false });
    const free = await tb.call('peek', { machine_id: 'm1', address: 0xA000, length: 4 });
    own.addRoms([{ name: 'd32.rom', bytes: Uint8Array.from({ length: 16384 }, (_, k) => (k * 7 + 3) & 255) }]);
    const withRoms = own.romCodeIn();
    const refused = await Promise.all([tb.call('peek', { machine_id: 'm1', address: 0xA000, length: 4 }), tb.call('find_bytes', { machine_id: 'm1', pattern: '03 0A' }), tb.call('disassemble', { machine_id: 'm1', address: 0x8000, count: 4 })]);
    const shown = await tb.call('screen_text', { machine_id: 'm1' });
    check('refuseRomReads: peek, find_bytes and disassemble are refused while the user\'s ROMs run; the screen still reads', free.ok && withRoms === 'roms'
      && refused.every((x) => !x.ok && x.error.code === 'rejected' && /no tool returns ROM memory directly/.test(x.error.detail)) && shown.ok, J(refused).slice(0, 400));
    // ... and that is all it is: a program run on the machine still reads ROM. The docs say so (a determined agent can
    // infer ROM contents through execution); this pins the path they name, run_frames waiting for a byte's value
    const romByte = own.readByte(0xA000);
    const wrong = await tb.call('run_frames', { machine_id: 'm1', frames: 1, until: { address: 0xA000, value: (romByte + 1) & 255 } });
    const right = await tb.call('run_frames', { machine_id: 'm1', frames: 1, until: { address: 0xA000, value: romByte } });
    check('refuseRomReads is not a seal: run_frames until a ROM byte holds a value still answers (as docs/mcp.md says)', wrong.ok && wrong.data.status === 'not-yet' && right.ok && right.data.status === 'met', J([wrong.data && wrong.data.status, right.data && right.data.status]));
    const stdio = T.createToolbox(host);
    const boot2 = await stdio.call('boot', { model: 'dragon32' });
    stdio.call('poke', { machine_id: boot2.data.machine.machine_id, address: 0x3000, bytes: [1] });
    check('refuseRomReads is off by default (the stdio server reads any memory of a machine it booted)', (await stdio.call('find_bytes', { machine_id: boot2.data.machine.machine_id, pattern: '01', from: 0x3000, to: 0x3000 })).ok);
    // mcpResult: one shape for both hosts
    const shot = T.mcpResult({ ok: true, data: { width: 1 }, image: Uint8Array.of(1, 2) }, (b) => Buffer.from(b).toString('base64'));
    const err = T.mcpResult({ ok: false, error: { code: 'rejected', remedy: 'x' } }, null);
    check('mcpResult: text JSON, structuredContent, an image block; errors as isError', shot.content[1].data === 'AQI=' && shot.content[1].mimeType === 'image/png' && J(shot.structuredContent) === '{"width":1}'
      && err.isError && JSON.parse(err.content[0].text).error.code === 'rejected', J([shot, err]));
  }

  // ---------------- the guide (docs/mcp.md) cannot drift from the server ----------------
  {
    const doc = fs.readFileSync(path.join(ROOT, 'docs/mcp.md'), 'utf8');
    const T = require('../js/mcp/tools.js');
    const missing = [...want, ...Object.keys(T.MCP_ERRORS)].filter((w) => !doc.includes(`\`${w}\``));
    check('docs/mcp.md names every tool and every error code', !missing.length, missing.join(' '));
    check('docs/mcp.md: batches are refused (-32600), until.text is a substring with no pattern waits, the residual risks named', /batch[^.]*-32600/i.test(doc) && /no pattern waits/.test(doc) && /worker with a timeout/.test(doc)
      && /`until\.text` is a plain substring/.test(doc) && /hard link/.test(doc) && /race/.test(doc));
    const tb2 = T.createToolbox({ roms: () => [] });
    const descs = tb2.tools().filter((t) => ['assemble_and_load', 'load_basic', 'poke'].includes(t.name)).map((t) => t.description);
    check('the page tools\' descriptions keep "Any other failure inside the emulator is tool-failed." and drop the page\'s consent text', descs.length === 3 && descs.every((d) => /Any other failure inside the emulator is tool-failed\.$/.test(d) && !/Let Claude use/.test(d) && !/asked on every call/.test(d)), J(descs.map((d) => d.slice(-80))));
    const configs = [...doc.matchAll(/```json\n([\s\S]*?)```/g)].map((m) => { try { return JSON.parse(m[1]); } catch (e) { return null; } });
    const clients = configs.filter((c) => c && c.mcpServers), settings = configs.filter((c) => c && !c.mcpServers);
    check('docs/mcp.md: every JSON block is valid; the client configurations start the server with --mcp; the config file example has roms and mediaRoot',
      configs.every(Boolean) && clients.length >= 2 && clients.every((c) => c.mcpServers.cloadm.args.includes('--mcp') && /cli\/cloadm\.js$/.test(c.mcpServers.cloadm.args[0]))
      && settings.length === 1 && J(Object.keys(settings[0])) === J(['roms', 'mediaRoot']));
    const ex = /```text\n(\{"id": 1[\s\S]*?)```/.exec(doc);
    const run = ex ? await serveRun(ex[1].trim().split('\n')) : { replies: [] };
    check('docs/mcp.md: the --serve example runs as written, and LIZA answers', run.replies.length === 5 && run.replies.every((x) => x.ok) && run.replies[4].result.status === 'met'
      && run.replies[4].result.machine_output.screen.lines.includes('WHY DO YOU NEED A HOLIDAY?'), J(run.replies.map((x) => x.ok)));
  }
  // --serve: { cancel: id } stops a request that is running; it then answers cancelled
  {
    const p = spawn(process.execPath, [CLI, '--serve'], { cwd: ROOT, env: ENV });
    spawned.push(p);
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stdin.write(JSON.stringify({ id: 1, tool: 'boot', arguments: {} }) + '\n');
    p.stdin.write(JSON.stringify({ id: 2, tool: 'run_frames', arguments: { machine_id: 'm1', frames: 3000, until: { text: 'NEVER' } } }) + '\n');
    p.stdin.write(JSON.stringify({ id: 3, tool: 'run_frames', arguments: { machine_id: 'm1', frames: 3000 } }) + '\n');
    p.stdin.write(JSON.stringify({ id: 4, tool: 'list_machines', arguments: {} }) + '\n');
    await new Promise((r) => setTimeout(r, 400));
    p.stdin.write(JSON.stringify({ cancel: 3 }) + '\n');
    p.stdin.write(JSON.stringify({ cancel: 2 }) + '\n');
    p.stdin.end();
    await new Promise((r) => p.on('close', r));
    const replies = out.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
    check('--serve: { cancel: id } stops a running request, which answers cancelled', replies.length === 4 && replies[1].id === 2 && replies[1].error && replies[1].error.code === 'cancelled', J(replies));
    check('--serve: a queued request that is cancelled answers cancelled without running', replies[2].id === 3 && replies[2].error && replies[2].error.code === 'cancelled'
      && replies[3].ok && replies[3].result.machines[0].frame < 3000, J(replies.slice(2)));
  }

  // ---------------- settings: the command line, then the config file, then unset ----------------
  {
    const home = tmp('cfg-home'), cfgDir = path.join(home, '.config', 'cloadm'), cfg = path.join(cfgDir, 'config.json');
    fs.mkdirSync(cfgDir, { recursive: true });
    fs.mkdirSync(tmp('cfg-media'));
    fs.writeFileSync(tmp('cfg-media', 'only-here.bin'), Emu.toBinary(code, { format: 'dragondos' }));
    const env = Object.assign({}, ENV, { HOME: home });
    // starts a server, loads a file and reads the start-up line -> { line, load: the load's error code or 'ok' }
    const probe = async (args, file = 'only-here.bin') => {
      const p = server(args, env);
      await p.init();
      await p.call('boot', { model: 'coco' });
      const r = await p.call('load', { machine_id: 'm1', path: file });
      await p.close();
      return { line: p.stderr, load: r.error ? r.error.code : 'ok', detail: r.error && r.error.detail };
    };
    // nothing set: the media root is ~/CLOADM, made on the first write only (a --read-only server never makes it)
    const dflt = path.join(home, 'CLOADM');
    const none = await probe([]), noneOut = await probe([], '../only-here.bin');
    check('no --media-root and no config file: the default ~/CLOADM, said on stderr; a missing file names the folder; .. is refused before it exists too; starting and reading create nothing',
      none.load === 'cannot-read' && none.detail.includes(dflt) && none.line.includes(`media root ${dflt} (default)`) && none.line.includes(`config file ${cfg}`) && noneOut.load === 'outside-media-root' && !fs.existsSync(dflt), J([none, noneOut]));
    {
      const ro = server(['--read-only'], env);
      await ro.init();
      await ro.call('boot', { model: 'coco' });
      const refused = await ro.call('save_snapshot', { machine_id: 'm1', path: 'first.cloadm-state' });
      await ro.close();
      const w = server([], env);
      await w.init();
      await w.call('boot', { model: 'coco' });
      const first = await w.call('save_snapshot', { machine_id: 'm1', path: 'first.cloadm-state' });
      const out = await w.call('load', { machine_id: 'm1', path: '../outside.bin' });
      await w.close();
      check('the default media root: --read-only never makes it; the first save does, and writes there; .. still cannot leave it',
        refused.error && refused.error.code === 'read-only' && first.data && first.data.saved === 'first.cloadm-state' && fs.statSync(path.join(dflt, 'first.cloadm-state')).isFile()
        && out.error && out.error.code === 'outside-media-root', J([refused.error, first, out.error]));
      fs.rmSync(dflt, { recursive: true });
    }
    fs.writeFileSync(cfg, JSON.stringify({ mediaRoot: tmp('cfg-media'), roms: [tmp('roms')] }));
    const fromFile = await probe([]);
    check('the config file gives the media root and the ROMs when the command line does not', fromFile.load === 'ok' && /1 ROM file\(s\) \(config file\)/.test(fromFile.line) && /\(config file\)/.test(fromFile.line), J(fromFile));
    const cli = await probe(['--media-root', tmp('media'), '--roms', tmp('roms')], 'prog.bin');
    const cliMiss = await probe(['--media-root', tmp('media')]);
    check('the command line wins over the config file', cli.load === 'ok' && /\(command line\)/.test(cli.line) && cliMiss.load === 'cannot-read', J([cli, cliMiss]));
    const placeholders = await probe(['--media-root=${user_config.media_root}', '--roms=${user_config.roms}']);
    const empties = await probe(['--media-root=', '--roms=']);
    check('a literal ${...} placeholder or an empty --media-root= / --roms= counts as not given: the config file applies', placeholders.load === 'ok' && empties.load === 'ok' && /1 ROM file\(s\) \(config file\)/.test(empties.line), J([placeholders, empties]));
    // a config file with placeholders or empty values: unset; a relative path: from the file's directory; ~/ from home
    fs.mkdirSync(path.join(home, 'proj'));
    fs.writeFileSync(path.join(home, 'proj', 'only-here.bin'), Emu.toBinary(code, { format: 'dragondos' }));
    fs.writeFileSync(cfg, JSON.stringify({ mediaRoot: '~/proj', roms: ['${user_config.roms}', ''] }));
    const tilde = await probe([]);
    fs.writeFileSync(cfg, JSON.stringify({ mediaRoot: '../../proj' }));
    const relative = await probe([]);
    fs.writeFileSync(path.join(home, 'only-here.bin'), Emu.toBinary(code, { format: 'dragondos' }));
    fs.writeFileSync(cfg, JSON.stringify({ mediaRoot: '~' }));
    const bareTilde = await probe([]);
    fs.writeFileSync(cfg, JSON.stringify({ mediaRoot: '${HOME}/proj' }));
    const placeholderInFile = await probe([]);
    check('in the config file: ~ and ~/ are the home directory, a relative path is from the file\'s directory, a placeholder is unset', tilde.load === 'ok' && /0 ROM file\(s\),/.test(tilde.line) && bareTilde.load === 'ok' && relative.load === 'ok' && placeholderInFile.load === 'cannot-read' && /\(default\)/.test(placeholderInFile.line), J([tilde, bareTilde, relative, placeholderInFile]));
    // a config file that is wrong stops the server with a reason (exit 2), never a crash
    const start = (args) => new Promise((resolve) => {
      const p = spawn(process.execPath, [CLI, '--mcp', ...args], { cwd: ROOT, env });
      let err = '', out = '';
      p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { err += d; });
      p.on('close', (c) => resolve({ c, err, out }));
      p.stdin.end();
    });
    const bad = [];
    for (const text of ['{ not json', '[1, 2]', '{"roms": 5}', '{"mediaRoot": 7}', '{"media_root": "x"}']) { fs.writeFileSync(cfg, text); bad.push(await start([])); }
    check('a config file that is not JSON, not an object, has a wrong type or an unknown key: exit 2, the file and the reason on stderr, nothing on stdout',
      bad.every((b) => b.c === 2 && b.err.includes(cfg) && b.out === '' && !/at .*\.js:\d+/.test(b.err)), J(bad.map((b) => [b.c, b.err.trim()])));
    // a media root that holds the config file ("mediaRoot": "."): no save_snapshot reaches it, also through a link
    fs.writeFileSync(cfg, JSON.stringify({ mediaRoot: '.' }));
    fs.symlinkSync(cfg, path.join(cfgDir, 'cfg.cloadm-state'));
    {
      const p = server([], env);
      await p.init();
      await p.call('boot', { model: 'coco' });
      const direct = await p.call('save_snapshot', { machine_id: 'm1', path: 'config.json' });
      const linked = await p.call('save_snapshot', { machine_id: 'm1', path: 'cfg.cloadm-state' });
      await p.close();
      check('save_snapshot never writes the config file: by its name (not a snapshot name) or through a link to it (the config file, refused)',
        direct.error && direct.error.code === 'bad-argument' && linked.error && linked.error.code === 'cannot-write' && /config file/.test(linked.error.detail)
        && fs.readFileSync(cfg, 'utf8') === JSON.stringify({ mediaRoot: '.' }), J([direct.error, linked.error]));
    }
    fs.rmSync(path.join(cfgDir, 'cfg.cloadm-state'));
    fs.rmSync(cfg);
    fs.mkdirSync(cfg);   // there, but not a file that can be read
    const unreadable = await start([]);
    check('a config file that cannot be read: exit 3 with the reason, not ignored', unreadable.c === 3 && unreadable.err.includes(`cannot read the config file ${cfg}`), J(unreadable));
    fs.rmdirSync(cfg);
    const bare = await start(['--roms']);
    check('a bare --roms with no value: a usage error (exit 2)', bare.c === 2 && /--roms needs a path/.test(bare.err), J(bare));
  }

  // ---------------- starting the server wrongly ----------------
  const bad = await new Promise((resolve) => {
    const p = spawn(process.execPath, [CLI, '--mcp', '--media-root', tmp('nope')], { cwd: ROOT });
    let out = '', err = '';
    p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { err += d; });
    p.on('close', (c) => resolve({ c, out, err }));
    p.stdin.end();
  });
  check('a media root that does not exist: exit 3, the reason on stderr, nothing on stdout', bad.c === 3 && /cannot read the media root/.test(bad.err) && bad.out === '', J(bad));
  const both = await new Promise((resolve) => { const p = spawn(process.execPath, [CLI, '--mcp', '--frames', '5'], { cwd: ROOT }); let err = ''; p.stderr.on('data', (d) => { err += d; }); p.on('close', (c) => resolve({ c, err })); p.stdin.end(); });
  check('--mcp with a step: usage error, exit 2', both.c === 2 && /takes --roms PATH, --media-root DIR and --read-only/.test(both.err), J(both));
})().catch((e) => { check('the MCP suite ran to the end', false, e.stack); }).finally(() => {
  for (const p of spawned) if (p.exitCode === null) p.kill();
  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(fail ? `${fail} FAILED` : `${n}/${n} MCP checks passed`);
  process.exitCode = fail ? 1 : 0;
});
