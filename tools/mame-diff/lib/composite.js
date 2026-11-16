// Absolute check of composite colour against MAME, independent of a learned colour map (which accepts any
// one-to-one relabelling, so it could not tell the two artifact phases apart). Where we drew an NTSC
// artifact mix, MAME's pixel must be that mix computed from MAME's own palette (mc6847.cpp s_palette: black
// $263016, green $30D200, buff $BFC8AD, through mixColours of js/chips/artifacter.js, i.e. MAME's update_colors); where we drew
// a PAL blend, MAME's pixel must be that blend's colour (create_color_blend_table).
//   codeAt(x, y): our colour code at active-area pixel (x, y); mameAt(x, y): MAME's pixel as 0xRRGGBB
// Returns { mixes: pixels checked, wrong: of those, how many differ, first: the first difference, as text }.
function compositeCheck(Emu, phase, codeAt, mameAt) {
  const V = Emu.MC6847, rgbOf = (c) => ((c & 0xFF) << 16) | (c & 0xFF00) | ((c >> 16) & 0xFF);
  const black = 0xFF163026, want = [Emu.mixColours(phase, black, 0xFF00D230), Emu.mixColours(phase, black, 0xFFADC8BF)];
  let mixes = 0, wrong = 0, first = null;
  for (let y = 0; y < 192; y++) for (let x = 0; x < 256; x++) {
    const c = codeAt(x, y);
    let w = null;
    for (const css of [0, 1]) if (c >= V.MIX[css] && c < V.MIX[css] + 14) w = want[css][c - V.MIX[css]];
    if (c >= V.PAL_CODE0 && c < V.PAL_CODE0 + V.PAL_BLEND.length) w = V.PAL_BLEND[c - V.PAL_CODE0][2];
    if (w === null) continue;
    mixes++;
    if (rgbOf(w & 0xFFFFFF) !== mameAt(x, y)) {
      wrong++;
      const hex = (v) => '$' + v.toString(16).toUpperCase().padStart(6, '0');
      if (!first) first = `at (${x},${y}) code ${c}: MAME ${hex(mameAt(x, y))}, expected ${hex(rgbOf(w & 0xFFFFFF))}`;
    }
  }
  return { mixes, wrong, first };
}
module.exports = { compositeCheck };
