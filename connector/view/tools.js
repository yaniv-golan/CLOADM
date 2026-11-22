// The side panel's app tools, without a DOM: the transport-neutral toolbox (js/mcp/tools.js) on the panel's own
// Session, so the names, schemas, refusals and untrusted-output wrapping are the local server's (node cli/cloadm.js
// --mcp), byte for byte. What the panel cannot do is left out, and its limits are kept:
//  * one machine, the one on screen (machine_id "m1"): boot and switch_machine change it; close_machine is not offered;
//  * no tool returns ROM memory directly: peek, find_bytes and disassemble refuse while the user's ROM code can be in
//    memory (refuseRomReads), and no tool takes or returns a ROM file. This is not a seal: a program the agent runs on
//    the machine (assemble_and_load and step, BASIC's PEEK, run_frames until a memory byte holds a value) can still
//    read ROM, so a determined agent can infer its contents through execution; add_roms and remove_roms are left
//    out (the panel's ROMs are added in the view itself, and the toolbox has no ROM store here);
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
export const PANEL_API = 2;
export const TEXT_MAX = 100000;
export const LEFT_OUT = Object.freeze(['close_machine', 'insert_tape', 'insert_disk', 'save_snapshot', 'restore_snapshot', 'add_roms', 'remove_roms']);
// the bundled programs' files a load by name can ask for (Session.welcomeFile, lizaFile, gameFile and the demo, for
// every model): variant A fetches them from the site beside js/, variant B carries them inline
export const PROGRAM_FILES = Object.freeze(['welcome.bin', 'welcome6803-mc10.bin', 'welcome6803-alice.bin', 'liza.bin', 'liza6803-mc10.bin', 'liza6803-alice.bin', 'demo.bin', '2048.bin', 'minesweeper.bin']);
export const NO_FILES = 'Claude\'s side panel has no media folder and reads no files: load a bundled program by name (program), or write code with assemble_and_load';

// host: the toolbox's host minus files ({ png, program, now, date, yield }); ROMs are already in the Session's store
export function panelToolbox(session, host) {
  const noFiles = () => { throw new McpToolError('no-media-root', NO_FILES); };
  const tb = createToolbox(Object.assign({}, host, { roms: () => [], includeReader: null, readMedia: noFiles, writeMedia: noFiles, checkWritable: noFiles }), { session, refuseRomReads: true });
  const offered = (name) => tb.has(name) && !LEFT_OUT.includes(name);
  return {
    tools: () => tb.tools().filter((t) => offered(t.name)),
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
