// The ROM privacy copy says both halves, everywhere it describes ROM privacy.
//
// CLOADM itself never uploads a ROM, and never puts one in a share link or an exported settings file (tests/rompack.test.js and
// tests/settings.test.js prove that). But Claude's peek and disassemble tools read whatever the machine has mapped, ROM areas
// included, and what Claude reads is sent to Anthropic with the conversation. A page that says only "never uploaded" is wrong
// for a user of Claude, so every place that talks about ROM privacy has to carry the second half too, and the old one-sided
// phrases must not come back. The pages' own text is asserted in the browser check (romUi, reading, ask); this test covers the
// documentation, the Help and front pages and the files the browser check does not read.
// Run: node tests/privacy-copy.test.js
const fs = require('fs'), path = require('path');

let fail = 0;
const check = (name, cond, detail = '') => { if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log('ok   ', name, detail); };
const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/\s+/g, ' ');

const ROM_FILES = ['README.md', 'docs/using.md', 'docs/claude.md', 'index.html', 'roms/index.html', 'play/index.html', 'help/index.html'];
for (const f of ROM_FILES) {
  const t = read(f);
  check(`${f}: says that CLOADM itself never uploads ROMs`, /never uploads (your ROMs|them)/.test(t));
  check(`${f}: says that what Claude reads from memory, ROM areas included, goes to Anthropic`, /ROM areas included/.test(t) && /Anthropic/.test(t));
  check(`${f}: no one-sided "never uploaded" or "once; they never leave your browser" for ROMs is left`,
    !/ROMs? (are|is) never uploaded|They are never uploaded|It is never uploaded|once; they never leave your browser|never uploaded, never in share links|Nothing is uploaded/.test(t));
}
check('README.md: the Claude paragraph says what Claude reads from the machine goes to Anthropic',
  /What Claude reads from the machine's memory \(ROM areas included\) is sent to Anthropic as part of your conversation/.test(read('README.md')));
check('docs/claude.md: the Consent paragraph says the ROM areas Claude peeks at or disassembles are sent too',
  /ROM areas Claude peeks at or disassembles are sent too/.test(read('docs/claude.md')));
check('docs/claude.md: the tools paragraph says peek and disassemble read ROM areas and that it is sent to Anthropic',
  /Both read whatever the machine has mapped at the address, ROM areas included, and what they return is sent to Anthropic as part of your conversation/.test(read('docs/claude.md')));
check('the Ask Claude panel footer names the machine memory with the ROM areas',
  /id="askSendNote">Your messages and what Claude reads from the machine's memory \(ROM areas included\) go to Anthropic with your key\./.test(read('play/index.html')));
check('the Help page answers "Do my ROMs ever leave my browser?"', /Do my ROMs ever leave my browser\?/.test(read('help/index.html')));

console.log(fail ? `${fail} FAILED` : 'all privacy copy checks passed');
process.exitCode = fail ? 1 : 0;
