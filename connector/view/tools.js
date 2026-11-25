// The side panel's app tools, without a DOM: the transport-neutral toolbox (js/mcp/tools.js) on the panel's own
// Session, so the names, schemas, refusals and untrusted-output wrapping are the local server's (node cli/cloadm.js
// --mcp), byte for byte. What the panel cannot do is left out, and its limits are kept:
//  * one machine, the one on screen (machine_id "m1"): boot and switch_machine change it; close_machine is not offered;
//  * Claude reads all of the machine's memory, ROM areas included, as on every host; no tool takes or returns a ROM
//    file, and add_roms and remove_roms are left out (the panel's ROMs are added in the view itself, and the toolbox
//    has no ROM store here);
//  * the ONE refusal left is the person's own WAD: a level converted from it is id Software's game data, not a ROM,
//    so peek, disassemble, find_bytes, screen_text, screenshot, step, registers and run_frames' memory/pc conditions
//    are refused while it is loaded (js/mcp/tools.js userDataGuard), on every host; machine_info still answers;
//  * no files: the panel has no media folder (the host's sandbox has no downloads, and nothing here may reach the
//    user's disk), so insert_tape, insert_disk, save_snapshot and restore_snapshot are left out, and load runs the
//    bundled programs only (a path is refused with no-media-root, naming what does work);
//  * Claude's limits for app tools (claude.com/docs/connectors/building/mcp-apps/app-tools): 45 s a call and 100,000
//    characters of result. The toolbox stops any run after WALL_MS (25 s) and run_frames after RUN_FRAMES_MAX frames,
//    as on the stdio server; a result longer than TEXT_MAX is refused with too-long instead of being cut.
// Used by connector/view/panel.js in the browser, and by connector/build.js in Node for the list the view's bridge
// answers before the emulator has loaded.
import { createToolbox, mcpResult, McpToolError } from '../../js/mcp/tools.js';

// The contract between the view's HTML (bridge.js and the CLOADM_VIEW config, built into the Worker) and this module
// with panel.js (served from cloadm.dev in variant A). Raise it whenever either side's expectations of the other
// change: the bridge's attach(), fail() and hostContext, CLOADM_VIEW's fields, the shell's element ids. The bridge
// refuses an emulator whose number differs (out-of-step). 2: the toolbar, Details and the host context (the view's UX).
// 3: the bridge's sizeChanged() and its safe-area, platform and device context keys; the shell's #keys and keys-item.
export const PANEL_API = 3;
// the Machine menu's groups, by each profile's lineage (js/machines/profiles.js): every model is in exactly one
export const MACHINE_GROUPS = Object.freeze([['Dragon', (p) => p.lineage === 'dragon'], ['Color Computer', (p) => p.lineage === 'coco'], ['MC-10', (p) => p.lineage === 'mc10']]);
export const TEXT_MAX = 100000;
export const LEFT_OUT = Object.freeze(['close_machine', 'insert_tape', 'insert_disk', 'save_snapshot', 'restore_snapshot', 'add_roms', 'remove_roms']);
// the bundled programs' files a load by name can ask for (Session.welcomeFile, lizaFile, gameFile and the demo, for
// every model): variant A fetches them from the site beside js/, variant B carries them inline
export const PROGRAM_FILES = Object.freeze(['welcome.bin', 'welcome6803-mc10.bin', 'welcome6803-alice.bin', 'liza.bin', 'liza6803-mc10.bin', 'liza6803-alice.bin', 'demo.bin', '2048.bin', 'minesweeper.bin']);
export const NO_FILES = 'Claude\'s side panel has no media folder and reads no files: load a bundled program by name (program), or write code with assemble_and_load';

// ---------------- the panel's tool list, compacted ----------------
// claude.ai drops a tool list whose input schemas together pass 8 KB, so the panel lists its tools with ONE compaction
// of the toolbox's own schemas (the local stdio server lists them in full, closed and fully described: no second copy of
// the schemas exists to drift). The compaction changes nothing but words and a few shapes, and
// tests/connector.test.js compares the full and the compact schema of every tool structurally:
//  * machine_id has no description (boot returns it; boot's description and the connector's instructions say so);
//  * the root and nested `additionalProperties: false`, and empty `required` lists, are left out (the toolbox's call()
//    refuses an argument a tool does not take, by name);
//  * an address, {anyOf: [{integer, minimum, maximum}, {string, pattern}]}, is {type: [integer, string]} whose
//    description states the range and the hex form: "...: 0-65535 or hex ("$3000")";
//  * switch_machine's model, options and roms say "as boot" and carry no model list (boot has it);
//  * SHORTER: the descriptions below, each a substitution into the toolbox's own wording (so its numbers are the
//    constants'), and a rule that no longer finds its text is an error, not a silent no-op.
const WORDS = [
  ['run_frames.until', 'checked after every frame; pc stops at the instruction', 'checked every frame; pc: at the instruction'],
  ['run_frames.until', 'text (with ignore_case if you like), address with value, pc, tape, or screen.', 'text (and ignore_case), address with value, pc, tape, screen.'],
  ['run_frames.until.text', 'text that must appear on the screen, as it is: a plain substring of the rows as screen_text reads them (joined by "\\n", each row\'s trailing spaces trimmed), e.g. "OK" or "PRESS ANY KEY"', 'text that must appear on the screen: a substring of screen_text\'s rows (joined by "\\n", trailing spaces trimmed), e.g. "OK"'],
  ['run_frames.until.ignore_case', 'match whatever the case (screens are mostly upper case)', 'ignore the case'],
  ['run_frames.until.address', 'a memory address to watch', 'an address to watch'],
  ['run_frames.until.value', 'the byte value address must hold', 'the byte address must hold'],
  ['run_frames.until.screen', 'the screen: "changed" stops when it differs from the start of the call (text modes: a character or a semigraphics block shape,', '"changed": stops when the screen differs from the start of the call (text modes: a character or block shape,'],
  ['run_frames.until.screen', 'graphics modes: any pixel', 'graphics: any pixel'],
  ['run_frames.until.tape', 'the tape in the deck: "stopped" (the motor is off; at once if it already is) or "end" (its last byte has played)', '"stopped" (motor off; at once if it already is) or "end" (last byte played)'],
  ['find_bytes.to', 'the last address a match may use', 'the last address to search'],
  ['boot.options', '; list_models gives each model\'s', ' (list_models)'],
  ['boot.roms', 'run the user\'s BASIC ROMs given to the server (default: true when the server has them for this model); false runs the built-in firmware, which runs machine code only', 'false: the built-in firmware (machine code only); default true if the server has the user\'s BASIC ROMs for the model'],
  ['switch_machine.model', null, 'the model, as boot takes it'],
  ['switch_machine.options', null, 'as boot'],
  ['switch_machine.roms', null, 'as boot'],
  ['press_keys.keys', 'e.g. ["LEFT"] or ["SHIFT", "UP"]; a name may be in braces ("{ENTER}") and in any case', 'e.g. ["SHIFT", "UP"]; braces and any case allowed'],
  ['press_keys.joystick', 'x and y 0-63 (32 is the middle), fire pressed or not', 'x, y 0-63 (32 centred), fire'],
  ['screenshot.scale', 'each pixel repeated this many times across and down', 'pixel repeat'],
  ['assemble_and_load.source', 'Assembler source text', 'Assembler source'],
  ['assemble_and_load.source', 'A comment starts with ; (a line with * or ;); after an instruction that takes no operand,', 'A comment starts with ; (or * at line start); after an instruction with no operand,'],
  ['assemble_and_load.org', 'if the source has its own ORG', 'if the source has ORG'],
  ['run.target', 'decimal integer ', 'decimal '],
  ['load_basic.program', 'The program listing: numbered', 'Numbered'],
  ['poke.address', 'Decimal integer ', 'Decimal '],
];
const NO_ENUM = ['switch_machine.model'];   // boot lists the models
const isAddress = (n) => Array.isArray(n.anyOf) && n.anyOf.length === 2 && n.anyOf[0].type === 'integer' && n.anyOf[1].type === 'string' && !!n.anyOf[1].pattern;
const used = new Set();
function compactNode(node, path, root) {
  if (Array.isArray(node)) return node.map((x) => compactNode(x, path, false));
  if (!node || typeof node !== 'object') return node;
  if (isAddress(node)) {
    const { minimum, maximum } = node.anyOf[0];
    node = { type: ['integer', 'string'], description: String(node.description).replace(/: a decimal integer .*$/, `: ${minimum}-${maximum} or hex ("$3000")`) };
  }
  const out = {};
  for (const [k, v] of Object.entries(node)) {
    if (k === 'additionalProperties' && v === false) continue;
    if (k === 'required' && Array.isArray(v) && !v.length) continue;
    if (k === 'enum' && NO_ENUM.includes(path)) { used.add(`${path}#enum`); continue; }
    if (k === 'properties') { out[k] = Object.fromEntries(Object.entries(v).map(([pn, pv]) => [pn, compactNode(pv, `${path}.${pn}`, false)])); continue; }
    out[k] = k === 'items' || k === 'anyOf' ? compactNode(v, path, false) : v;
  }
  if (path.endsWith('.machine_id')) delete out.description;
  if (typeof out.description === 'string') {
    for (const [at, from, to] of WORDS) {
      if (at !== path) continue;
      if (from === null) { out.description = to; used.add(`${at}\u0000`); continue; }
      if (out.description.includes(from)) { out.description = out.description.replace(from, to); used.add(`${at}\u0000${from}`); }
    }
  }
  return out;
}
// -> the tool with its input schema compacted (a copy: the toolbox's own schemas, shared between tools, are not touched)
export function compactTool(t) { return Object.assign({}, t, { inputSchema: compactNode(t.inputSchema, t.name, true) }); }
// the rules that found their text, for the check that none has gone stale (tests/connector.test.js)
export const compactionRules = () => ({ words: WORDS.map(([at, from]) => `${at}\u0000${from === null ? '' : from}`), used: [...used], noEnum: NO_ENUM.map((p) => `${p}#enum`) });

// host: the toolbox's host minus files ({ png, program, now, date, yield }); ROMs are already in the Session's store
export function panelToolbox(session, host) {
  const noFiles = () => { throw new McpToolError('no-media-root', NO_FILES); };
  const tb = createToolbox(Object.assign({}, host, { roms: () => [], includeReader: null, readMedia: noFiles, writeMedia: noFiles, checkWritable: noFiles }), { session, route: 'panel' });
  const offered = (name) => tb.has(name) && !LEFT_OUT.includes(name);
  return {
    tools: () => tb.tools().filter((t) => offered(t.name)).map(compactTool),
    has: offered,
    // -> the MCP tools/call result; base64(bytes) -> text. The picture may be a promise (the browser encodes it).
    async call(name, args, { signal = null, base64 } = {}) {
      const r = offered(name) ? await tb.call(name, args, { signal }) : { ok: false, error: new McpToolError('bad-argument', `no tool "${name}" in the side panel${LEFT_OUT.includes(name) ? ` (${NO_FILES})` : ''}`).tool };
      if (r.ok && r.image) r.image = await r.image;
      return capped(mcpResult(r, base64));
    },
  };
}

// a result Claude would not take whole -> a refusal that says how to ask for less
export function capped(result, max = TEXT_MAX) {
  const size = result.content.reduce((n, c) => n + (c.type === 'text' ? c.text.length : c.data.length), 0);
  if (size <= max) return result;
  const error = { code: 'too-long', remedy: 'ask for less: a shorter peek or disassemble, a narrower find_bytes, a smaller screenshot scale', detail: `the result is ${size} characters; Claude takes at most ${max}` };
  return { content: [{ type: 'text', text: JSON.stringify({ error }) }], structuredContent: { error }, isError: true };
}
