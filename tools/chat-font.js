// The chat terminal's own font (js/video/chat-font.js, original glyphs, no ROM), as the chat firmware's 6809 table or
// a preview sheet.
//
//   node tools/chat-font.js            print the table as 6809 source
//   node tools/chat-font.js --svg FILE render a preview sheet
const { GLYPHS, FIRST, LAST, table } = require('../js/video/chat-font.js');
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
