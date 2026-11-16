// Run: node tests/ssc-board.test.js
//
// The Speech/Sound Pak as a BOARD the page can insert, as opposed to the device's own behaviour
// (tests/ssc.test.js). What this file pins:
//   * which models offer the Pak and which refuse it, and the message a refusal gives;
//   * the PIC ROM's three states - missing, wrong size, present - through the Session;
//   * that the Pak inserts and PLAYS with no SP0256 allophone ROM, because speech is not implemented (its ROM
//     socket is optional, and the card must not require it);
//   * that the Pak survives insert -> snapshot -> restore as the port's board;
//   * that the cartridge board entry refuses a cartridge IMAGE (the Pak has no image socket).
//
// Every ROM here is built by our own tools (tools/mame-diff/ssc/gen-roms.js); no real dump is used or needed
// (AGENTS.md hard rule 1).
const Emu = require('./load')();
const { buildPic, buildSp0256, buildAsm, OUT } = require('../tools/mame-diff/ssc/gen-roms.js');

let fail = 0;
const check = (name, cond, detail = '') => { if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name}`); };
const throws = (fn) => { try { fn(); return null; } catch (e) { return e; } };

// a Session over an in-memory store, like the page's but with nothing remembered between runs. The ROMs live in
// the MEDIA store (js/media/library.js), the configuration in the key-value store, so both are shared here when a
// test carries one run's state into the next.
const kv = () => { const m = new Map(); return { get: (k) => (m.has(k) ? m.get(k) : null), set: (k, v) => m.set(k, v), delete: (k) => m.delete(k), keys: () => [...m.keys()] }; };
const newSession = (store = kv(), media = new Emu.MemoryMediaStore()) => new Emu.Session({ store, media, welcomeMenu: false });
const session = async () => { const s = newSession(); s.switchMachine('coco'); return s; };
// the whole file runs inside one async function: CommonJS with top-level await is refused by Node
const main = async () => {

const PIC = buildPic();
const SP_ROM = buildSp0256();
// the Pak's two ROMs under the names the ROM panel offers, put in the Session's library the way a drop would
const storeSscRoms = (s, { pic = PIC, sp = SP_ROM } = {}) => {
  if (pic) s.roms.put('ssc', 'tms7040', pic, 'pic-7040-510.bin');
  if (sp) s.roms.put('ssc', 'sp0256', sp, 'sp0256-al2.bin');
};

// ---------------------------------------------------------------- which models offer it
{
  const s = await session();
  check('coco offers the Speech/Sound Pak', s.offersSsc === true);
  for (const id of ['coco2b', 'coco3']) {
    const t = new Emu.Session({ store: kv(), welcomeMenu: false });
    t.switchMachine(id);
    check(`${id} offers it: its --ssc lockstep matched to HALT`, t.offersSsc === true);
  }
  // a Dragon and the MC-10: the Pak is a Color Computer cartridge, and neither is verified for it
  for (const [id, name] of [['dragon64', 'Dragon 64'], ['dragon32', 'Dragon 32'], ['mc10', 'MC-10'], ['alice', 'Alice']]) {
    const t = new Emu.Session({ store: kv(), welcomeMenu: false });
    t.switchMachine(id);
    check(`${name}: offersSsc is false`, t.offersSsc === false);
    const e = throws(() => t.insertSsc());
    check(`${name}: inserting it is refused with a clear message`,
      e instanceof Emu.SessionError && /can't take the Speech\/Sound Pak/.test(e.message) && /only on the Color Computer models/.test(e.message),
      e ? e.message : 'did not throw');
    // and the option itself is refused, so no config or URL can force it on
    const e2 = throws(() => Emu.resolveConfig(id, { ssc: 'music' }));
    check(`${name}: the ssc option itself is unknown to that model`, e2 && /unknown option "ssc"/.test(e2.message), e2 ? e2.message : 'accepted');
  }
  // a CoCo clone that has not been through the lockstep is not offered either
  const c = new Emu.Session({ store: kv(), welcomeMenu: false });
  c.switchMachine('mx1600');
  check('MX-1600 (not run through the --ssc lockstep): not offered', c.offersSsc === false);
}

// ---------------------------------------------------------------- the PIC ROM's three states
{
  const s = await session();
  check('no ROMs: both of the Pak\'s sockets are shown, the PIC required and the speech one not',
    s.sscRoms().length === 2 && s.sscRoms()[0].required === true && s.sscRoms()[1].required === false,
    JSON.stringify(s.sscRoms()));
  const e = throws(() => s.insertSsc());
  check('no ROMs: refused, naming the PIC ROM and its usual file name',
    e instanceof Emu.SessionError && /PIC ROM/.test(e.message) && /pic-7040-510\.bin/.test(e.message) && /Load the ROM file first/.test(e.message),
    e ? e.message : 'did not throw');
  check('no ROMs: the message says PIC only - the speech ROM is not demanded',
    e && !/sp0256-al2/.test(e.message), e && e.message);

  // a wrong-sized PIC image is refused by the device with the sizes named
  storeSscRoms(s, { pic: new Uint8Array(0x800), sp: null });
  const e2 = throws(() => s.insertSsc());
  check('a wrong-sized PIC image: refused, naming both sizes',
    e2 && /TMS7040 ROM must be 4096 bytes/.test(e2.message) && /got 2048/.test(e2.message), e2 ? e2.message : 'did not throw');

  // present: it goes in, and the port holds the Pak
  storeSscRoms(s, { pic: PIC, sp: SP_ROM });
  const msg = s.insertSsc();
  check('the PIC ROM present: the Pak inserts', s.sscInserted && s.machine.cartPort.type === 'ssc', String(s.sscInserted));
  check('...and the message says music only', /music only/.test(msg) && /speech is not implemented/.test(msg), msg);
  check('...and the option is remembered as music', s.machine.config.ssc === 'music', s.machine.config.ssc);
  check('...and the Pak is the port\'s board, with its label', s.machine.cartPort.name === 'Speech/Sound Pak', s.machine.cartPort.name);
  // eject: the port empties and the option goes back
  s.ejectSsc();
  check('eject: the port is empty and the option is none', !s.sscInserted && s.machine.config.ssc === 'none');
}

// ---------------------------------------------------------------- no speech ROM: it inserts and plays
{
  // The SP0256's allophone data is optional, and the music side must work
  // without it. The card is driven exactly as the tone firmware drives it - an AY register write needs the PIC,
  // so the tone is checked through the device's own AY after the reset defaults, which is what plays a tone once
  // the PIC's firmware has written the mixer and volumes.
  const s = await session();
  storeSscRoms(s, { pic: PIC, sp: null });
  const e = throws(() => s.insertSsc());
  check('no speech ROM: the Pak inserts anyway', !e && s.sscInserted, e ? e.message : '');
  const pak = s.machine.cartPort;
  check('...its SP0256 carries no allophone data (the documented empty case, not a zero-filled image)',
    pak.sp0256Data === null, String(pak.sp0256Data));
  // the AY is present and can still be programmed: a mixer write makes a channel audible, which is what the
  // music path needs; the speech ROM plays no part in it
  check('...and the AY is there, silent at reset', pak.ay && pak.ayLevel === 0);
  pak.ay.writeReg(7, 0x38);     // mixer: tone A, B, C enabled
  pak.ay.writeReg(8, 12);       // channel A volume
  pak.ay.writeReg(0, 0x8E); pak.ay.writeReg(1, 0x00);   // channel A period low 8 bits
  // The card's reported level is gated by the CoCo's sound mux, which this firmware-driven test never opens, so
  // the AY's OWN output is what to measure here: that is the music path the speech ROM plays no part in.
  let level = 0;
  for (let k = 0; k < 4000; k++) { pak.ay.step(pak.ayOut); level = Math.max(level, Math.abs(pak.ayOut[0])); }
  check('...the AY sounds without any speech ROM (music path independent of it)', level > 0, `peak level ${level}`);
  // the card runs: frames advance with no error, which is what "plays" means at this level
  check('...and the machine runs frames with the Pak in', !throws(() => { for (let f = 0; f < 3; f++) s.machine.runFrame(); }));
}

// ---------------------------------------------------------------- it survives a snapshot
{
  const s = await session();
  storeSscRoms(s);
  s.insertSsc();
  const snap = JSON.parse(Emu.state.toJSON(s.machine.snapshot()));
  check('snapshot: the port holds the Pak', snap.state.cartridge && snap.state.cartridge.type === 'ssc', JSON.stringify(snap.state.cartridge && snap.state.cartridge.type));
  let m = null;
  const e = throws(() => { m = Emu.restoreSnapshot(Emu.state.fromJSON(JSON.stringify(snap)), s.machine.roms); });
  check('snapshot: restored, the Pak is in the port again', !e && m && m.cartPort && m.cartPort.type === 'ssc', e ? e.message : '');
  check('snapshot: and the restored card still steps', m && !throws(() => { for (let f = 0; f < 2; f++) m.runFrame(); }));
}

// ---------------------------------------------------------------- the board takes no cartridge image
{
  const e = throws(() => Emu.cartridgeFor(new Uint8Array(0x100), 'ssc'));
  check('a cartridge image on the ssc board is refused, saying it takes none',
    e && /takes no cartridge image/.test(e.message) && /ROM panel/.test(e.message), e ? e.message : 'did not throw');
  check('the board is named for the menu, music only', /music only/.test(Emu.CART_BOARDS.ssc.name) && /speech not yet/.test(Emu.CART_BOARDS.ssc.name), Emu.CART_BOARDS.ssc.name);
  // and the Session refuses the board choice with the same reason
  const s = await session();
  s.cartBoard = 'ssc';
  const e2 = throws(() => Emu.cartridgeFor(new Uint8Array(0x100), s.cartBoard));
  check('the Session can select the board, and an image still fails on it', !!e2 && /takes no cartridge image/.test(e2.message));
}

// ---------------------------------------------------------------- the option brings it back on a new machine
{
  const st = kv(), md = new Emu.MemoryMediaStore();
  const a = newSession(st, md);
  a.switchMachine('coco');
  storeSscRoms(a);
  a.insertSsc();
  check('the option and the ROM are remembered', a.machine.config.ssc === 'music');
  // a fresh Session on the same two stores: the machine's config says music and the ROM is still stored, so the
  // Pak comes back. The ROM lives in the MEDIA store and the config in the key-value store; ready() loads both.
  const b = await newSession(st, md).ready();
  b.switchMachine('coco');
  check('a new Session on the same store starts with the Pak in', b.sscInserted === true);
  // and a power cycle keeps it (as real hardware does: a power cycle keeps what is inserted)
  b.powerCycle();
  check('...and a power cycle keeps it', b.sscInserted === true);
}

console.log(fail ? `${fail} FAILED` : 'all passed');
process.exitCode = fail ? 1 : 0;
};

main().catch((e) => { console.error(e); process.exitCode = 1; });
