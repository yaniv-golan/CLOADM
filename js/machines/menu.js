/*
 * The machine menu's sections. Data only, no DOM: js/ui/machine-panel.js renders these and
 * tests/machine-menu.test.js checks them in Node.
 *
 * A profile is listed in the first section that claims it, and the last section takes whatever is left, so a
 * new model can never fall out of the menu (the bug the Prológica CP-400 exposed: it matched no section and
 * could not be picked at all). KITS is that catch-all - it holds CoCo-compatible machines that are neither
 * Tandy's nor a clone of a named model.
 */

// which bezel and nameplate: Dragons plugged into a TV (charcoal), Tandy monitors (light)
export const caseOf = (p) => (p.family === 'coco3' ? 'coco3' : p.family === 'mc10' ? 'mc10' : /^(Dragon|Tano)/.test(p.name) ? 'dragon' : 'coco');

export const GROUPS = [
  ['DRAGON', (p) => caseOf(p) === 'dragon'],
  ['COCO', (p) => /^CoCo /.test(p.name)],
  ['MC-10', (p) => p.family === 'mc10'],
  ['CLONES', (p) => !!p.clone],
  ['KITS', () => true],
];

// Each section's subtitle, under its name in the menu. KITS is whatever the catch-all holds: today the CP-400, and
// tests/machine-menu.test.js requires its subtitle to name every model in it.
export const SUBTITLES = {
  DRAGON: "Dragon Data's machines and their Spanish and US versions",
  COCO: "Tandy's Color Computers",
  'MC-10': "Tandy's MC-10 and the French Matra Alice",
  CLONES: 'Brazilian copies of the CoCo',
  KITS: 'A CoCo compatible with its own BASIC: the Prológica CP-400',
};

// What each model is, in a few words: the menu's footer line for the model under the pointer or the focus ("Codimex
// CD-6809: a CoCo clone, 1983."), each item's aria-description, and Help's list of machines. Data, and each states
// only what MAME 0.264's driver lines in its `source` say (the COMP() entry's year, maker, name and parent, or the
// driver's notes); a maker the model's name already gives is not repeated. tests/machine-menu.test.js requires one for
// every profile.
export const DESCRIPTIONS = {
  dragon32: { text: 'by Dragon Data, 1982', source: 'src/mame/trs/dragon.cpp:701 (COMP 1982, "Dragon Data Ltd", "Dragon 32")' },
  dragon64: { text: 'by Dragon Data, with two BASIC ROMs, 1983', source: 'src/mame/trs/dragon.cpp:702 (COMP 1983, "Dragon Data Ltd", parent dragon32); dragon.cpp:661-664 (ROM_START(dragon64): two BASIC ROMs, d64_1 and d64_2)' },
  dragon200: { text: 'a Dragon 64 by Eurohard, 1985', source: 'src/mame/trs/dragon.cpp:704 (COMP 1985, "Eurohard S.A.", machine config dragon64)' },
  dragon200e: { text: 'by Eurohard, its screen drawn from a character ROM, 1985', source: 'src/mame/trs/dragon.cpp:705 (COMP 1985, "Eurohard S.A."); dragon.cpp:595-600 (dragon200e: the VDG reads a character ROM)' },
  tanodr64: { text: 'the NTSC Dragon 64, 1983', source: 'src/mame/trs/dragon.cpp:707 (COMP 1983, "Dragon Data Ltd / Tano Ltd", "Tano Dragon 64 (NTSC)", parent dragon32; its machine config, tanodr64, in dragon.cpp)' },
  dgnalpha: { text: 'a prototype from when Dragon Data went bust: a Dragon 64 with a built-in disk system and a graphical boot ROM, 1984', source: 'src/mame/trs/dgnalpha.cpp header notes ("a prototype in development when Dragon Data went bust ... an enhanced Dragon 64, with built in modem, disk system, and graphical boot rom"); dgnalpha.cpp:388 (COMP 1984)' },
  d64plus: { text: 'a Dragon 64 with a second, 640-pixel screen from an HD6845S, by Dragon Data and Compusense, 1985', source: 'src/mame/trs/dragon.cpp:706 (COMP 1985, "Dragon Data Ltd / Compusense", "Dragon 64 Plus"); dragon.cpp:603-609 (d64plus: dragon64 plus a second, 640-pixel screen from an HD6845S)' },
  coco: { text: "Tandy Radio Shack's CoCo 1 and 2", source: 'src/mame/trs/coco12.cpp:767 (COMP, "Tandy Radio Shack", "Color Computer 1/2")' },
  coco2b: { text: 'a CoCo 2 with the MC6847T1 video chip, by Tandy Radio Shack', source: 'src/mame/trs/coco12.cpp:770 ("Tandy Radio Shack", "Color Computer 2B", parent coco); coco12.cpp:616-620 (coco2b: MC6847T1 VDG)' },
  coco3: { text: 'by Tandy Radio Shack, NTSC, 1986', source: 'src/mame/trs/coco3.cpp:383 (COMP 1986, "Tandy Radio Shack", "Color Computer 3 (NTSC)")' },
  coco3p: { text: 'by Tandy Radio Shack, PAL, 1986', source: 'src/mame/trs/coco3.cpp:384 (COMP 1986, "Tandy Radio Shack", "Color Computer 3 (PAL)")' },
  mc10: { text: 'by Tandy Radio Shack, 1983', source: 'src/mame/trs/mc10.cpp:626 (COMP 1983, "Tandy Radio Shack", "MC-10")' },
  alice: { text: 'a version of the MC-10, 1983', source: 'src/mame/trs/mc10.cpp:627 (COMP 1983, parent mc10, "Matra & Hachette", "Alice")' },
  mx1600: { text: 'a CoCo clone, 1984', source: 'src/mame/trs/coco12.cpp:774 (COMP 1984, parent coco, machine config coco, "Dynacom", "MX-1600")' },
  lzcolor64: { text: 'a CoCo clone, 1983', source: 'src/mame/trs/coco12.cpp:776 (COMP 1983, parent coco, machine config coco, "Novo Tempo / LZ Equipamentos", "Color64")' },
  cd6809: { text: 'a CoCo clone, 1983', source: 'src/mame/trs/coco12.cpp:777 (COMP 1983, parent coco, "Codimex", "CD-6809")' },
  cp400: { text: 'a CoCo compatible with its own BASIC, 1983', source: 'src/mame/trs/coco12.cpp:772 (COMP 1983, parent coco, "Prológica", "CP400"); coco12.cpp:713-715 (ROM_START(cp400): its own cp400bas.rom)' },
};
// "Codimex CD-6809: a CoCo clone, 1983."
export const describe = (p) => `${p.name}: ${DESCRIPTIONS[p.id].text}.`;

// profiles grouped as the menu shows them: [[section, [profile, ...]], ...], empty sections dropped, each
// profile in exactly one section
export const groupProfiles = (profiles) => {
  const out = [], taken = new Set();
  for (const [name, test] of GROUPS) {
    const list = profiles.filter((p) => !taken.has(p.id) && test(p));
    for (const p of list) taken.add(p.id);
    if (list.length) out.push([name, list]);
  }
  return out;
};
