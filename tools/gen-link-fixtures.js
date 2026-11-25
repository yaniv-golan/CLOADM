#!/usr/bin/env node
// The golden share links (tests/fixtures/links/), generated ONCE per format version and committed; tests/link-freeze
// .test.js opens each and checks what comes back, and fails if a fixture's bytes change. Never regenerate an existing
// fixture: a format that changes gets a NEW fixture beside the old ones (the old must still open: AGENTS.md, "Formats
// are frozen"). No ROMs: the moments run on the built-in firmware, the program is plain text.
//   node tools/gen-link-fixtures.js [DIR]      writes the fixtures that are not there yet, and says which exist
// DIR is the committed fixtures' folder by default. tests/link-freeze.test.js passes a temporary copy instead: a test
// run must never be able to touch the tracked fixtures, whatever state the overwrite guard is in.
// Each file is JSON: { what, format, machine, ... } with the link's bytes in base64url (a long link's fragment after
// #z=) or a short link's sealed object and its key (base64url), as the store would serve it.
const fs = require('fs'), path = require('path');
const Emu = require('../tests/load')();

const DIR = process.argv[2] ? path.resolve(process.argv[2]) : path.join(__dirname, '../tests/fixtures/links');
const BASE = 'https://cloadm.dev/play/';
// the moment: our own 14-byte program on the Dragon 64's built-in firmware, filling the text screen with "A"
// (LDX #$0400 / LDA #$41 / STA ,X+ / CMPX #$0600 / BNE back to the STA / BRA *), run until it sits in its last loop
const FILL = [{ addr: 0x7000, data: Uint8Array.from([0x8E, 0x04, 0x00, 0x86, 0x41, 0xA7, 0x80, 0x8C, 0x06, 0x00, 0x26, 0xF9, 0x20, 0xFE]) }];
// the program: plain text in a Dragon's BASIC (load_basic's form)
const PROGRAM = '10 REM GOLDEN\n20 FOR I=1 TO 3:PRINT "Hi";I:NEXT\n30 GOTO 20';

async function main() {
  const s = new Emu.Session({ store: Emu.memoryStore() });
  s.switchMachine('dragon64', undefined, { menu: false });
  s.inject(FILL, 0x7000);
  s.runFrames(5);
  const file = await s.shareFile(new Date('2026-11-25T00:00:00Z'));
  const long = await Emu.encodeLongLink(file.moment.snap, file.moment.meta);
  const program = await Emu.encodeProgramLink({ machine: 'dragon64', config: { cpu: '6809', ram: 64, ssc: 'none' }, text: PROGRAM });
  const sealedMoment = await Emu.sealMoment(file.bytes, Emu.SEALED_KIND.moment);
  const sealedProgram = await Emu.sealMoment(program, Emu.SEALED_KIND.program);
  const b64 = (u8) => Buffer.from(u8).toString('base64url');
  const fixtures = {
    'z1-moment.json': { what: 'a long link (#z=) holding a moment', format: { linkByte0: Emu.LONG_LINK_VERSION, snapshotVersion: file.moment.snap.version }, machine: 'dragon64', z: b64(long) },
    'z2-program.json': { what: 'a long link (#z=) holding a BASIC program', format: { linkByte0: Emu.PROGRAM_LINK_VERSION, programFormat: 1 }, machine: 'dragon64', z: b64(program) },
    'sealed1-moment.json': { what: 'a short link\'s sealed object holding a moment (.cloadm)', format: { sealedVersion: Emu.SEALED_VERSION, kind: Emu.SEALED_KIND.moment, snapshotVersion: file.moment.snap.version },
      machine: 'dragon64', sealed: b64(sealedMoment.sealed), key: sealedMoment.key },
    'sealed1-program.json': { what: 'a short link\'s sealed object holding a BASIC program', format: { sealedVersion: Emu.SEALED_VERSION, kind: Emu.SEALED_KIND.program, programFormat: 1 },
      machine: 'dragon64', sealed: b64(sealedProgram.sealed), key: sealedProgram.key },
  };
  fs.mkdirSync(DIR, { recursive: true });
  for (const [name, value] of Object.entries(fixtures)) {
    const f = path.join(DIR, name);
    if (fs.existsSync(f)) { console.log(`${name}: exists, kept (a fixture is never regenerated)`); continue; }
    fs.writeFileSync(f, JSON.stringify(value, null, 1) + '\n');
    console.log(`${name}: written`);
  }
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
