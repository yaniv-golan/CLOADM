// headless-frame.mjs - drive a Dragon 64 from Node with the public modules only: no test helper, no browser.
//
//   node docs/examples/headless-frame.mjs [out.png]
//
// It runs from any directory (it finds the repository from its own path; set CLOADM_DIR=/path/to/cloadm to use it from
// a copy elsewhere). What it does, each step checked:
//   1. makes a Session and switches it to a Dragon 64 (the built-in firmware: no ROMs needed)
//   2. assembles docs/examples/framecount.asm (read from the repository, so a copy of this file needs only CLOADM_DIR) with the
//      bundled assembler and loads the DragonDOS binary
//   3. waits for the guest's frame counter in RAM, with no text on the screen to wait on
//   4. holds the SPACE key in the keyboard matrix for two frames
//   5. steps one frame and reads the raw framebuffer: colour codes plus the colour table
//   6. writes the frame as a PNG and prints the elapsed frames and CPU cycles
// docs/automation.md ("A graphics program has no text to wait on") explains it; tests/dev-docs-headless.test.js runs it.
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.env.CLOADM_DIR ? pathToFileURL(resolve(process.env.CLOADM_DIR) + '/') : new URL('../../', import.meta.url);
const { Session, assemble, toBinary, frameToRGBA } = await import(new URL('js/emu.js', root));
const { framePng } = await import(new URL('cli/cloadm.js', root));   // (a PNG encoder is the one thing the library leaves to the CLI)
const out = process.argv[2] || 'headless-frame.png';

const FRAME = 0x3100, KEYSEEN = 0x3101;        // the guest's tick counter and the tick that last saw SPACE (framecount.asm)
const fail = (what) => { throw new Error(`headless-frame: ${what}`); };

// 1. a machine
const session = new Session({ welcomeMenu: false });
session.switchMachine('dragon64', {}, { menu: false });
const m = session.shownMachine;

// 2. a DragonDOS binary from source, loaded and started as dropping it on the page would
const res = assemble(readFileSync(new URL('docs/examples/framecount.asm', root), 'utf8'), m.profile.cpu === '6309' ? '6309' : '6809');
if (!res.ok) fail(res.errors.map((e) => e.message).join('; '));
const loaded = session.load('framecount.bin', toBinary(res), { remember: false });
if (!/DragonDOS binary/.test(loaded)) fail(`not loaded as a DragonDOS binary: ${loaded}`);

// 3. wait on a memory byte: whole frames, a bound on how long
const frame0 = m.frameCount, cycles0 = m.now();
for (let n = 0; session.readByte(FRAME) < 3; n++) { if (n > 200) fail('the frame counter never reached 3'); session.runFrames(1); }

// 4. a key held in the matrix (as a finger would) for two frames, then let go: the guest reads the matrix once a tick
if (!('SPACE' in m.keyPos)) fail('this keyboard has no SPACE');
m.setKey('SPACE', true);
session.runFrames(2);
m.setKey('SPACE', false);

// 5. one more frame, then the raw framebuffer: frame.data is one colour code a pixel, frame.table the RGBA of each code
session.runFrames(1);
const seen = session.readByte(KEYSEEN);
if (seen < 4) fail(`the guest never saw SPACE down (KEYSEEN ${seen})`);
const frame = m.render();
const { x, y, width, height } = frame.active;       // the picture inside the border: 256x192 here
if (width !== 256 || height !== 192) fail(`unexpected picture ${width}x${height}`);
const lit = (row) => { let n = 0; for (let px = 0; px < width; px++) if (frame.data[(y + row) * frame.width + x + px] !== frame.data[y * frame.width + x]) n++; return n; };
if (lit(96) === 0 || lit(95) !== 0) fail(`row 96 should hold the line the key drew (row 96: ${lit(96)} pixels, row 95: ${lit(95)})`);
const rgba = frameToRGBA(frame);                    // Uint32 per pixel, 0xAABBGGRR
if (rgba.length !== frame.width * frame.height) fail('the RGBA frame has the wrong size');

// 6. a PNG, and what elapsed
writeFileSync(out, framePng(frame));
console.log(JSON.stringify({ png: out, frame: [frame.width, frame.height], picture: { x, y, width, height }, litOnRow96: lit(96),
  frames: m.frameCount - frame0, cycles: m.now() - cycles0, counter: session.readByte(FRAME), keySeenAtTick: seen }));
