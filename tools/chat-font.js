// The chat terminal's own font: a 6-wide, 8-tall uppercase-and-lowercase set designed for
// this project, drawn by the firmware into a 256x192 two-colour VDG screen (GM7), 42 columns by 24 rows.
// No ROM is used or copied: these are original glyphs, written as 6 bits a row (bit 5 = leftmost).
//
//   node tools/chat-font.js            print the table as 6809 source
//   node tools/chat-font.js --svg FILE render a preview sheet
//
// ASCII 0x20-0x7E. Each glyph is 8 hex bytes, one row each, top row first.
const GLYPHS = {
  ' ': '00 00 00 00 00 00 00 00',
  '!': '04 04 04 04 04 00 04 00', '"': '0A 0A 0A 00 00 00 00 00', '#': '0A 0A 1F 0A 1F 0A 0A 00',
  '$': '04 0F 14 0E 05 1E 04 00', '%': '18 19 02 04 08 13 03 00', '&': '0C 12 14 08 15 12 0D 00',
  "'": '04 04 08 00 00 00 00 00', '(': '02 04 08 08 08 04 02 00', ')': '08 04 02 02 02 04 08 00',
  '*': '00 04 15 0E 15 04 00 00', '+': '00 04 04 1F 04 04 00 00', ',': '00 00 00 00 00 04 04 08',
  '-': '00 00 00 1F 00 00 00 00', '.': '00 00 00 00 00 0C 0C 00', '/': '00 01 02 04 08 10 00 00',
  '0': '0E 11 13 15 19 11 0E 00', '1': '04 0C 04 04 04 04 0E 00', '2': '0E 11 01 02 04 08 1F 00',
  '3': '1F 02 04 02 01 11 0E 00', '4': '02 06 0A 12 1F 02 02 00', '5': '1F 10 1E 01 01 11 0E 00',
  '6': '06 08 10 1E 11 11 0E 00', '7': '1F 01 02 04 08 08 08 00', '8': '0E 11 11 0E 11 11 0E 00',
  '9': '0E 11 11 0F 01 02 0C 00', ':': '00 0C 0C 00 0C 0C 00 00', ';': '00 0C 0C 00 0C 04 08 00',
  '<': '02 04 08 10 08 04 02 00', '=': '00 00 1F 00 1F 00 00 00', '>': '08 04 02 01 02 04 08 00',
  '?': '0E 11 01 02 04 00 04 00', '@': '0E 11 17 15 17 10 0E 00',
  'A': '0E 11 11 1F 11 11 11 00', 'B': '1E 11 11 1E 11 11 1E 00', 'C': '0E 11 10 10 10 11 0E 00',
  'D': '1E 11 11 11 11 11 1E 00', 'E': '1F 10 10 1E 10 10 1F 00', 'F': '1F 10 10 1E 10 10 10 00',
  'G': '0E 11 10 17 11 11 0F 00', 'H': '11 11 11 1F 11 11 11 00', 'I': '0E 04 04 04 04 04 0E 00',
  'J': '07 02 02 02 02 12 0C 00', 'K': '11 12 14 18 14 12 11 00', 'L': '10 10 10 10 10 10 1F 00',
  'M': '11 1B 15 15 11 11 11 00', 'N': '11 11 19 15 13 11 11 00', 'O': '0E 11 11 11 11 11 0E 00',
  'P': '1E 11 11 1E 10 10 10 00', 'Q': '0E 11 11 11 15 12 0D 00', 'R': '1E 11 11 1E 14 12 11 00',
  'S': '0F 10 10 0E 01 01 1E 00', 'T': '1F 04 04 04 04 04 04 00', 'U': '11 11 11 11 11 11 0E 00',
  'V': '11 11 11 11 11 0A 04 00', 'W': '11 11 11 15 15 1B 11 00', 'X': '11 11 0A 04 0A 11 11 00',
  'Y': '11 11 0A 04 04 04 04 00', 'Z': '1F 01 02 04 08 10 1F 00',
  '[': '0E 08 08 08 08 08 0E 00', '\\': '00 10 08 04 02 01 00 00', ']': '0E 02 02 02 02 02 0E 00',
  '^': '04 0A 11 00 00 00 00 00', '_': '00 00 00 00 00 00 00 1F',
  '`': '08 04 02 00 00 00 00 00',
  'a': '00 00 0E 01 0F 11 0F 00', 'b': '10 10 16 19 11 11 1E 00', 'c': '00 00 0E 10 10 11 0E 00',
  'd': '01 01 0D 13 11 11 0F 00', 'e': '00 00 0E 11 1F 10 0E 00', 'f': '06 09 08 1C 08 08 08 00',
  'g': '00 00 0F 11 0F 01 0E 00', 'h': '10 10 16 19 11 11 11 00', 'i': '04 00 0C 04 04 04 0E 00',
  'j': '02 00 06 02 02 12 0C 00', 'k': '10 10 12 14 18 14 12 00', 'l': '0C 04 04 04 04 04 0E 00',
  'm': '00 00 1A 15 15 11 11 00', 'n': '00 00 16 19 11 11 11 00', 'o': '00 00 0E 11 11 11 0E 00',
  'p': '00 00 1E 11 1E 10 10 00', 'q': '00 00 0F 11 0F 01 01 00', 'r': '00 00 16 19 10 10 10 00',
  's': '00 00 0F 10 0E 01 1E 00', 't': '08 08 1C 08 08 09 06 00', 'u': '00 00 11 11 11 13 0D 00',
  'v': '00 00 11 11 11 0A 04 00', 'w': '00 00 11 11 15 15 0A 00', 'x': '00 00 11 0A 04 0A 11 00',
  'y': '00 00 11 11 0F 01 0E 00', 'z': '00 00 1F 02 04 08 1F 00',
  '{': '02 04 04 08 04 04 02 00', '|': '04 04 04 04 04 04 04 00', '}': '08 04 04 02 04 04 08 00',
  '~': '00 00 08 15 02 00 00 00',
};
const FIRST = 0x20, LAST = 0x7E;

// the packed table, one glyph after another, 8 bytes each
function table() {
  const out = [];
  for (let c = FIRST; c <= LAST; c++) {
    const hex = GLYPHS[String.fromCharCode(c)];
    if (!hex) throw new Error(`font: no glyph for 0x${c.toString(16)} (${JSON.stringify(String.fromCharCode(c))})`);
    out.push(...hex.split(' ').map((h) => parseInt(h, 16) & 0x3F));
  }
  return out;
}

module.exports = { GLYPHS, FIRST, LAST, table };

if (require.main === module) {
  if (process.argv.includes('--svg')) {
    const file = process.argv[process.argv.indexOf('--svg') + 1] || 'chat-font.svg';
    const scale = 6, cols = 16, cw = 6 * scale, ch = 8 * scale;
    const rows = Math.ceil((LAST - FIRST + 1) / cols);
    let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${cols * cw}" height="${rows * ch}" style="background:#0a3d0a">`;
    for (let i = 0; i < LAST - FIRST + 1; i++) {
      const g = table().slice(i * 8, i * 8 + 8), ox = (i % cols) * cw, oy = Math.floor(i / cols) * ch;
      for (let y = 0; y < 8; y++) for (let x = 0; x < 6; x++) if ((g[y] >> (5 - x)) & 1) svg += `<rect x="${ox + x * scale}" y="${oy + y * scale}" width="${scale}" height="${scale}" fill="#39e83f"/>`;
    }
    svg += '</svg>';
    require('fs').writeFileSync(file, svg);
    console.log(`${file}: ${LAST - FIRST + 1} glyphs`);
  } else {
    const t = table();
    for (let i = 0; i < t.length; i += 8) console.log('        FCB     ' + t.slice(i, i + 8).map((b) => '$' + b.toString(16).padStart(2, '0').toUpperCase()).join(','));
  }
}
