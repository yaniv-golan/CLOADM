// The boot-help card's cause ("No OK after 5 seconds") when the ROMs are recognised: with a cartridge plugged in it
// names the cartridge (it may have taken over at power-on), with none the old text stays (js/session.js bootStatus).
// Everything is synthetic: seeded bytes as stand-in ROMs (their CRCs forged to the Dragon 64's so the sockets say
// "recognised", as tests/open-rom.test.js does) that never print OK, and a seeded cartridge image. No real ROM is used.
const fs = require('fs'), path = require('path');
const Emu = require('./load')();

let fail = 0;
const check = (name, cond, detail = '') => { if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name}`); };
const fake = (size, seed) => { const b = new Uint8Array(size); let x = seed >>> 0; for (let i = 0; i < size; i++) { x = (x * 1103515245 + 12345) >>> 0; b[i] = x >>> 24; } return b; };
const frames = (s, n) => { for (let i = 0; i < n; i++) s.shownMachine.runFrame(); };

// the 4 bytes at `pos` chosen so that the whole image has CRC-32 `want` (as tests/open-rom.test.js does)
function forgeCrcAt(bytes, pos, want) {
  const T = new Uint32Array(256), top = new Uint8Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; T[n] = c >>> 0; top[T[n] >>> 24] = n; }
  let a = 0xFFFFFFFF;
  for (const b of bytes.subarray(0, pos)) a = (T[(a ^ b) & 0xFF] ^ (a >>> 8)) >>> 0;
  const back = (x, b) => { const j = top[x >>> 24]; return (((x ^ T[j]) << 8) | (j ^ b)) >>> 0; };
  let x = (parseInt(want, 16) ^ 0xFFFFFFFF) >>> 0;
  for (let i = bytes.length - 1; i >= pos + 4; i--) x = back(x, bytes[i]);
  for (let i = 0; i < 4; i++) x = back(x, 0);
  const v = (x ^ a) >>> 0, out = bytes.slice();
  for (let i = 0; i < 4; i++) out[pos + i] = (v >>> (8 * i)) & 0xFF;
  if (Emu.crc32(out) !== want) throw new Error(`forging ${want} failed`);
  return out;
}
const crcOf = (id) => Emu.profiles.dragon64.roms.find((r) => r.id === id).crcs[0];
const other = Emu.profiles.dragon64.roms.find((r) => r.id !== 'basic' && !r.chip).crcs[0];

const OLD = 'The ROMs are recognised, so this looks like a problem in CLOADM. Please report it.';
const NEW = (name) => `The ROMs are recognised, but a cartridge is plugged in (${name}), and it may have taken over at power-on. Take it out and switch on again; if that doesn't help, please report it.`;

(async () => {
  const s = new Emu.Session({ store: Emu.memoryStore() });
  s.switchMachine('dragon64');
  await s.library.importMedia('d64_1.rom', forgeCrcAt(fake(0x4000, 11), 0x2000, crcOf('basic')));
  await s.library.importMedia('d64_2.rom', forgeCrcAt(fake(0x4000, 12), 0x2000, other));
  const m = s.shownMachine;
  check('set-up: the stand-in ROMs are recognised, so the cause is not the unrecognised-file text',
    s.machineRoms('dragon64').sockets.filter((x) => !x.chip).every((x) => x.status === 'verified'), JSON.stringify(s.machineRoms('dragon64').sockets));

  // no cartridge: the old text
  s.powerCycle();
  frames(s, 300);
  let st = s.bootStatus();
  check('no cartridge: boot failed with the old cause, unchanged', m.cartPort === null && st.state === 'failed' && st.cause === OLD, JSON.stringify(st.cause));

  // a cartridge in: the new text, naming it
  s.load('game.rom', fake(0x4000, 13), { remember: false });
  check('set-up: the cartridge is in', !!m.cartPort && m.cartPort.name === 'Program Pak', m.cartPort && m.cartPort.name);
  frames(s, 300);
  st = s.bootStatus();
  check('cartridge in: boot failed and the cause names the cartridge as the chip shows it', st.state === 'failed' && st.cause === NEW('Program Pak'), JSON.stringify(st));

  // the ROM-less disk controller a mounted disk plugs in is not a cartridge the person chose: the old text
  const d = new Emu.Session({ store: Emu.memoryStore() });
  d.switchMachine('dragon64');
  await d.library.importMedia('d64_1.rom', forgeCrcAt(fake(0x4000, 11), 0x2000, crcOf('basic')));
  await d.library.importMedia('d64_2.rom', forgeCrcAt(fake(0x4000, 12), 0x2000, other));
  await d.media.write('disks/m.vdk', Emu.blankDisk('vdk', 40, 1));
  await d.drives.mount(0, 'disks/m.vdk');
  const dm = d.shownMachine;
  check('set-up: a disk is mounted with no disk ROM, so the bare controller is in the port', !!dm.cartPort && dm.cartPort === d.drives.bareController, dm.cartPort && dm.cartPort.name);
  d.powerCycle();
  frames(d, 300);
  st = d.bootStatus();
  check('bare disk controller in: boot failed and the cause keeps the old text', st.state === 'failed' && st.cause === OLD, JSON.stringify(st));

  // The SAME controller, in the person's machine, while a full-screen chat is on screen. The drives act on the person's
  // machine (drives.targetMachine is Session.loadTarget's: the BASIC session beside the chat), so the bare controller
  // there is still the one a mounted disk plugged in and the cause must still be the old text. The bug was LATENT: no
  // shipped consumer reads the cause for a machine that is not on screen (js/ui/boot-help.js is the only reader, and it
  // asks about the shown machine, which is the ROM-less chat machine), but callers DO ask about the person's machine
  // (chatTarget().bootStatus(), promptState, the load loops), and the file's own invariant (js/session.js:1785: the two
  // views of one machine "cannot disagree") is what this restores. Keyed on the shown machine, those two views named the
  // bare controller as a cartridge the moment the chat opened. (The chat needs 32K and a 6809; dragon64 has both, and
  // the chat firmware is the committed examples/chat.bin, as tests/menu-return.test.js opens it.)
  const c = new Emu.Session({ store: Emu.memoryStore() });
  c.switchMachine('dragon64');
  await c.library.importMedia('d64_1.rom', forgeCrcAt(fake(0x4000, 11), 0x2000, crcOf('basic')));
  await c.library.importMedia('d64_2.rom', forgeCrcAt(fake(0x4000, 12), 0x2000, other));
  await c.media.write('disks/m.vdk', Emu.blankDisk('vdk', 40, 1));
  await c.drives.mount(0, 'disks/m.vdk');
  const basic = c.shownMachine;
  check('set-up (chat): the bare controller is in the PERSON\'s machine\'s port',
    !!basic.cartPort && basic.cartPort === c.drives.bareController, basic.cartPort && basic.cartPort.name);
  c.startChat({ backend: { send: async () => ({ text: '', stopReason: 'end_turn' }) }, channel: new Emu.MemoryChannel(),
    firmware: new Uint8Array(fs.readFileSync(path.join(__dirname, '../examples/chat.bin'))) });
  check('set-up (chat): the chat machine is on screen, and the drives still act on the person\'s machine',
    c.shownMachine === c.chatMachines.chat && c.chatMachines.chat !== basic && c.drives.targetMachine === basic,
    JSON.stringify({ shownIsChat: c.shownMachine === c.chatMachines.chat, targetIsBasic: c.drives.targetMachine === basic }));
  // the bare controller survives the chat's own start: loadTarget's machine is the same one, and a chat does not
  // power it up (the chat firmware loads on the chat machine)
  check('set-up (chat): the person\'s machine still holds the bare controller, and it is still the bare one',
    basic.cartPort === c.drives.bareController, JSON.stringify({ port: basic.cartPort && basic.cartPort.name, bare: !!c.drives.bareController }));
  // The person's machine's own frames: frames() runs the SHOWN machine, which is the chat's now, and the chat's machine
  // runs its own firmware -- it is the person's machine whose boot is being asked about.
  for (let i = 0; i < 300; i++) basic.runFrame();
  // ONE call, on the route a Claude turn uses (chatTarget().bootStatus() is `_bootStatusOf(chatMachines.basic)`,
  // js/session.js:3448, and chatMachines.basic is this same object): comparing a second call to the first would be
  // comparing the function to itself and could not fail independently. The literal is OLD, so a page that fell back to
  // the cartridge text fails here.
  const viaChat = c.chatTarget().bootStatus();
  check('chat full screen, bare disk controller: the cause keeps the old text (a controller, not a cartridge)',
    viaChat.state === 'failed' && viaChat.cause === OLD, JSON.stringify(viaChat));

  console.log(fail ? `${fail} failed` : 'all passed');
  process.exitCode = fail ? 1 : 0;
})().catch((err) => { console.log(`FAIL ${err.stack}`); process.exitCode = 1; });
