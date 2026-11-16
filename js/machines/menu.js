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
