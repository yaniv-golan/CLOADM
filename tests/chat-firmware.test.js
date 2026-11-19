// Run: node tests/chat-firmware.test.js
//
// The chat terminal firmware (examples/chat.asm): a 6809 program written for this
// project that replaces BASIC and draws onto a 256x192 two-colour VDG screen (GM7) with this project's own
// 6x8 font (examples/chat-font.inc): 42 columns by 24 rows, lowercase.
//
// It sends each typed line over the byte channel to the backend and displays the reply as it streams in. The
// DriveWire channel comes later; these tests drive the firmware through the same narrow channel the
// chat uses (js/claude/channel.js).
//
// The expected behaviour is written here from the chat terminal's specification, not read out of the program:
//  * the screen is 42 columns by 24 rows; text wraps at a word boundary, and a word longer than a whole line
//    is broken (a word that fits on a fresh line is never split);
//  * lowercase is shown as lowercase (the font has both cases, so no inverted-video trick);
//  * a reply longer than the screen scrolls, keeping the newest lines;
//  * a line typed at the keyboard reaches the backend byte for byte (no case change, no added characters), up to
//    255 characters; it wraps as it is typed the way replies wrap: a word that
//    does not fit moves to the next line, a word with no space breaks at the character, and a space that falls at
//    the end of a full line ends it unseen (typedLayout below); BACKSPACE goes back across the wraps, and a key
//    past the limit is refused visibly: the screen flashes
//    (the VDG's CSS bit, green to buff, for about a tenth of a second) instead of the key being dropped silently;
//  * "Thinking..." shows until the first byte of the reply arrives.
const fs = require('fs'), path = require('path');
const Emu = require('./load')();

let fail = 0, n = 0;
const check = (name, cond, detail = '') => { n++; if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name} ${detail}`); };
const ROOT = path.join(__dirname, '..');
const FONT = require('../tools/chat-font.js');

// ---- the firmware source and its committed binary ----
const src = fs.readFileSync(path.join(ROOT, 'examples/chat.asm'), 'utf8');
const include = (name) => { const p = path.join(ROOT, 'examples', name); return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null; };
const asm = Emu.assemble(src, '6809', { include });
check('chat.asm assembles', asm.ok, asm.ok ? '' : JSON.stringify(asm.errors).slice(0, 400));
const bin = fs.existsSync(path.join(ROOT, 'examples/chat.bin')) ? new Uint8Array(fs.readFileSync(path.join(ROOT, 'examples/chat.bin'))) : null;
check('the committed chat.bin is the source assembled', !!bin && Buffer.from(Emu.toBinary(asm)).equals(Buffer.from(bin)));

// the screen size from the firmware's own source, and the one the chat tells Claude (CHAT_SCREEN, the brief)
const equ = (name) => Number((new RegExp(`^${name}\\s+EQU\\s+(\\d+)`, 'm').exec(src) || [])[1]);
const COLS = equ('COLS'), ROWS = equ('ROWS'), GLYPH_W = 6, GLYPH_H = 8;
check('the chat tells Claude the screen size the firmware has (CHAT_SCREEN = COLS and ROWS in chat.asm)', COLS === 42 && ROWS === 24
  && Emu.CHAT_SCREEN.cols === COLS && Emu.CHAT_SCREEN.rows === ROWS
  && Emu.claudeBrief({ machine: 'Dragon 64', ram: 64, cpu: '6809', software: 'none', family: 'dragon', view: 'full', edition: 'cloadm.dev', tools: true }).includes(`${COLS} columns by ${ROWS} rows`),
  `firmware ${COLS}x${ROWS}, CHAT_SCREEN ${Emu.CHAT_SCREEN.cols}x${Emu.CHAT_SCREEN.rows}`);
// the two variables the page reads (Session.chatPromptEmpty) sit where CHAT_STATE says, in the assembled source
check('CHAT_STATE is where the firmware keeps BLEN and WAIT', asm.ok && asm.symbols.get('BLEN') === Emu.CHAT_STATE.blen && asm.symbols.get('WAIT') === Emu.CHAT_STATE.wait,
  `BLEN $${(asm.symbols.get('BLEN') || 0).toString(16)}, WAIT $${(asm.symbols.get('WAIT') || 0).toString(16)}`);
const SCREEN = 0x400;

// Decode the GM7 bitmap into text, using the same font table the firmware draws with: for each cell
// (column c, row r) read the 6x8 pixel block at pixel (c*6, r*8) and find the glyph that matches.
const GLYPH_ROWS = [];
for (let code = FONT.FIRST; code <= FONT.LAST; code++) {
  const g = FONT.table().slice((code - FONT.FIRST) * 8, (code - FONT.FIRST) * 8 + 8);
  GLYPH_ROWS.push({ ch: String.fromCharCode(code), g });
}
const pix = (m, x, line) => (m.ram[SCREEN + line * 32 + (x >> 3)] >> (7 - (x & 7))) & 1;
function screenRows(m) {
  const out = [];
  for (let r = 0; r < ROWS; r++) {
    let line = '';
    for (let c = 0; c < COLS; c++) {
      // the cell's 8 rows of 6 bits, MSB = leftmost pixel
      const cell = [];
      for (let ry = 0; ry < GLYPH_H; ry++) {
        let bits = 0;
        for (let rx = 0; rx < GLYPH_W; rx++) bits = (bits << 1) | pix(m, c * GLYPH_W + rx, r * GLYPH_H + ry);
        cell.push(bits);
      }
      const hit = GLYPH_ROWS.find((g) => g.g.every((v, i) => v === cell[i]));
      line += hit ? hit.ch : (cell.every((v) => v === 0) ? ' ' : '?');
    }
    out.push(line);
  }
  return out;
}

// run the firmware on a stub machine with a channel; one frame runs the machine, then bytes cross the seam
function start() {
  const m = Emu.createMachine('dragon64');
  m.injectAndRun(asm.segments, asm.exec);
  const channel = new Emu.MemoryChannel();
  const toBackend = [];
  channel.onReceive = (bytes) => { if (bytes) toBackend.push(...bytes); };
  const rx = Emu.CHAT_CHANNEL.rx, tx = Emu.CHAT_CHANNEL.tx;
  // the seam, exactly as ChatSession.pump does it, without a chat backend in the way: either side can move a
  // byte, and the firmware clears RXSTAT when it takes one, so a reply can cross several bytes in a frame.
  const pump = () => {
    for (;;) {
      let moved = false;
      if (!(m.ram[rx] & 0x80)) {
        const b = channel.poll();
        if (b != null) { m.ram[rx + 1] = b; m.ram[rx] = 0x80; moved = true; }
      }
      if (m.ram[tx] & 0x80) { const b = m.ram[tx + 1]; m.ram[tx] = 0; channel.fromMachine(Uint8Array.of(b)); moved = true; }
      if (!moved) break;
    }
  };
  const s = { machine: m, channel, toBackend };
  s.run = (frames = 2) => { for (let i = 0; i < frames; i++) { pump(); m.runFrame(); pump(); } };
  s.type = (text) => { for (const ch of text) { m.stubKeys.push(ch.charCodeAt(0)); s.run(2); } };
  // (the mailbox carries one byte a frame, so a 255-character line takes 256 frames to go)
  s.enter = () => { m.stubKeys.push(13); s.run(3); for (let i = 0; i < 400 && pending(); i++) s.run(1); };
  // while the firmware still has line bytes queued, keep stepping
  const pending = () => m.ram[asm.symbols.get('SPEND')] !== 0;
  s.screen = () => screenRows(m);
  return s;
}
// the wrap rule from the spec, as an oracle independent of the firmware
function wrap(text, width = COLS) {
  const out = [];
  for (const para of String(text).split('\n')) {
    let line = '';
    for (const word of para.split(' ')) {
      if (!line) line = word;
      else if (line.length + 1 + word.length <= width) line += ' ' + word;
      else { out.push(line); line = word; }
      while (line.length > width) { out.push(line.slice(0, width)); line = line.slice(width); }
    }
    out.push(line);
  }
  return out;
}

// ---- 1. boots to a prompt on an empty screen ----
{
  const s = start();
  s.run(30);
  const screen = s.screen();
  check('the firmware boots to a prompt', screen[0].includes('>'), JSON.stringify(screen.slice(0, 2)));
  check('the rest of the screen is blank', screen.slice(1).every((l) => l.trim() === ''));
}

// ---- 2. a typed line reaches the backend byte for byte ----
{
  const s = start();
  s.run(30);
  s.type('Hello Claude 123');
  s.enter();
  const sent = s.toBackend.map((b) => String.fromCharCode(b)).join('');
  check('the typed line reaches the backend exactly, lowercase kept', sent.includes('Hello Claude 123'), JSON.stringify(sent));
  check('the line ends with CR', sent.endsWith('\r'), JSON.stringify(sent.slice(-2)));
}

// ---- 3. a reply is shown and wraps at word boundaries ----
{
  const s = start();
  s.run(30);
  s.type('hi'); s.enter();
  const reply = 'This is a fairly long sentence that must wrap at the words on a forty two column screen for sure.';
  s.channel.send(new TextEncoder().encode(reply + '\r'));
  s.run(150);              // the seam moves one byte per frame, so a 98-byte reply needs ~100 frames
  const want = wrap(reply).filter((l) => l.length);
  const got = s.screen().map((l) => l.replace(/\s+$/, '')).filter((l) => l.length);
  const missing = want.filter((w) => !got.includes(w));
  check('the reply is shown, wrapped exactly at word boundaries', missing.length === 0, JSON.stringify({ want, got: got.slice(0, 5), missing }));
}

// ---- 4. a word longer than the whole line is broken, nothing lost ----
{
  const s = start();
  s.run(30);
  s.type('hi'); s.enter();
  const long = 'A'.repeat(70);
  s.channel.send(new TextEncoder().encode(long + '\r'));
  s.run(120);              // 71 bytes through a one-byte-per-frame seam, then the second row is drawn
  const shown = s.screen().join('').split('A').length - 1;
  check('a 70-character word is broken across lines and none of it is lost', shown === 70, `(${shown} of 70)`);
}

// ---- 5. lowercase is shown as lowercase ----
{
  const s = start();
  s.run(30);
  s.type('hi'); s.enter();
  s.channel.send(new TextEncoder().encode('mixedCase Words here\r'));
  s.run(40);
  const text = s.screen().join('\n');
  check('lowercase letters show as lowercase', /mixedCase Words here/.test(text), JSON.stringify(text.split('\n').slice(0, 4)));
}

// ---- 6. a reply longer than the screen scrolls, keeping the newest lines ----
{
  const s = start();
  s.run(30);
  s.type('hi'); s.enter();
  const lines = Array.from({ length: 30 }, (_, i) => `line ${i}`);
  s.channel.send(new TextEncoder().encode(lines.join('\r') + '\r'));
  s.run(300);              // 211 bytes through a one-byte-per-frame seam, then ten scrolls
  const screen = s.screen().join('\n');
  check('scrolling keeps the newest line', /line 29/.test(screen), JSON.stringify(s.screen().slice(-3)));
  check('the oldest line has scrolled away', !/^line 0$/m.test(screen));
}

// ---- 7. "Thinking..." shows until the first reply byte ----
{
  const s = start();
  s.run(30);
  s.type('hi'); s.enter();
  check('"Thinking..." shows while waiting', /Thinking\.\.\./.test(s.screen().join(' ')), JSON.stringify(s.screen().slice(0, 3)));
  s.channel.send(new TextEncoder().encode('done\r'));
  s.run(40);
  check('the reply appears below it', /done/.test(s.screen().join(' ')));
}

// the typed-line wrap rule from the spec: rows of 40 characters after the prompt, then 42; a character that does not
// fit moves the row's last word (after its last space) to the next row; a space that does not fit ends the row and
// is not shown; a row with no space breaks at the character
function typedLayout(text, first = COLS - 2, width = COLS) {
  const rows = [];
  let row = '', cap = first;
  for (const ch of text) {
    if (row.length === cap) {
      if (ch === ' ') { rows.push(row); row = ''; cap = width; continue; }
      const k = row.lastIndexOf(' ');
      if (k >= 0) { rows.push(row.slice(0, k + 1)); row = row.slice(k + 1); } else { rows.push(row); row = ''; }
      cap = width;
    }
    row += ch;
  }
  rows.push(row);
  return rows;
}
const onScreen = (rows, layout) => layout.every((l, i) => rows[i].trimEnd() === (i === 0 ? `> ${l}` : l).trimEnd());

// ---- 8. a long prompt (69 characters) arrives intact, wrapped across two screen lines as it is typed ----
const POEM = 'Will you please write a short poem about how wonderful the Dragon is?';
{
  const s = start();
  s.run(30);
  s.type(POEM);
  const shown = s.screen();
  check('a 69-character prompt wraps as it is typed, at a word (the space at the full line is not carried over)', shown[0] === '> Will you please write a short poem about'
    && shown[1].trimEnd() === 'how wonderful the Dragon is?' && onScreen(shown, typedLayout(POEM)), JSON.stringify(shown.slice(0, 2)));
  s.enter();
  const sent = s.toBackend.map((b) => String.fromCharCode(b)).join('');
  check('the 69-character prompt reaches the backend byte for byte, then CR', sent === `${POEM}\r`, JSON.stringify(sent));
}

// ---- 9. a 255-character line, and the limit ----
const CHARS = 'abcdefghijklmnopqrstuvwxyz ABCDEFGHIJKLMNOPQRSTUVWXYZ 0123456789.,?!';
const LONG = Array.from({ length: 255 }, (_, i) => CHARS[(i * 7) % CHARS.length]).join('');
{
  const s = start();
  s.run(30);
  s.type(LONG);
  const rows = s.screen(), layout = typedLayout(LONG);
  check('a 255-character line is all on screen, wrapped at words as typed', LONG.length === 255 && onScreen(rows, layout), JSON.stringify({ rows: rows.slice(0, 8), layout }));
  // past the limit: the key is refused, and the screen flashes
  const lit = () => { const f = s.machine.render(); const seen = new Set(); for (let i = 0; i < f.data.length; i += 37) seen.add(f.table[f.data[i]]); return [...seen].sort().join(); };
  const normal = lit();
  s.machine.stubKeys.push('X'.charCodeAt(0));
  const during = [];
  for (let i = 0; i < 12; i++) { s.run(1); during.push(lit()); }
  check('a key past 255 is not taken: the line is unchanged on screen', onScreen(s.screen(), layout) && s.screen()[layout.length].trim() === ''
    && s.machine.ram[asm.symbols.get('BLEN')] === 255);
  check('a key past 255 flashes the screen (CSS: green to buff) and it comes back', during.some((c) => c !== normal) && during[during.length - 1] === normal,
    JSON.stringify({ normal, during }));
  s.enter();
  const sent = s.toBackend.map((b) => String.fromCharCode(b)).join('');
  check('the whole 255-character line reaches the backend byte for byte, then CR (nothing past the limit)', sent === `${LONG}\r`, `${sent.length} bytes`);
}

// ---- 10. BACKSPACE goes back across the wrap ----
{
  const s = start();
  s.run(30);
  const t = 'x'.repeat(COLS - 2) + 'abcde';           // row 0 full after the prompt, 5 characters on row 1
  s.type(t);
  for (let i = 0; i < 7; i++) { s.machine.stubKeys.push(8); s.run(2); }
  const rows = s.screen();
  check('BACKSPACE takes back across the wrap: row 1 is empty, row 0 ends two characters earlier', rows[1].trim() === '' && rows[0] === `> ${'x'.repeat(COLS - 4)}  `,
    JSON.stringify(rows.slice(0, 2)));
  s.type('YZ!');
  const after = s.screen();
  check('typing goes on from there, wrapping again', after[0] === `> ${'x'.repeat(COLS - 4)}YZ` && after[1].trimEnd() === '!', JSON.stringify(after.slice(0, 2)));
  s.enter();
  const sent = s.toBackend.map((b) => String.fromCharCode(b)).join('');
  check('the line sent is what is on screen', sent === `${'x'.repeat(COLS - 4)}YZ!\r`, JSON.stringify(sent));
}

// ---- 11. a word that does not fit moves to the next line; BACKSPACE follows it back ----
{
  const s = start();
  s.run(30);
  s.type(`${'x'.repeat(35)} hello`);                  // 'o' does not fit on the first row: "hello" moves down
  const moved = s.screen();
  check('a word that does not fit moves to the next line whole', moved[0] === `> ${'x'.repeat(35)}     ` && moved[1].trimEnd() === 'hello', JSON.stringify(moved.slice(0, 2)));
  for (let i = 0; i < 6; i++) { s.machine.stubKeys.push(8); s.run(2); }   // "hello", then the space before it
  const back = s.screen();
  check('BACKSPACE takes the moved word back, then the space before it on the row above', back[1].trim() === '' && back[0] === `> ${'x'.repeat(35)}     `, JSON.stringify(back.slice(0, 2)));
  s.type('Yz');
  const again = s.screen();
  check('typing goes on at that place', again[0] === `> ${'x'.repeat(35)}Yz   `, JSON.stringify(again.slice(0, 2)));
  s.enter();
  const sent = s.toBackend.map((b) => String.fromCharCode(b)).join('');
  check('the line sent is what was kept', sent === `${'x'.repeat(35)}Yz\r`, JSON.stringify(sent));
}

console.log(`${n - fail}/${n} chat firmware checks passed`);
process.exitCode = fail ? 1 : 0;
