/*
 * The Share screen's words that need no page (tests/share-text.test.js runs them in Node):
 *  - romLines: the Share screen's one ROM line when the moment uses ROMs, a cartridge's image or both: that the link holds
 *    none of them, and what whoever opens it needs; and its compact form. True by construction:
 *    Session.shareFile takes every byte of them out (tests/share-roms.test.js proves it).
 *  - forumText: "Copy as text for a forum", the link with a one-line description as BBCode and as Markdown. Text only: no
 *    image tag, as nothing serves a picture for a link yet.
 */
// machine: the name the Share screen shows ("Dragon 64"); needs: Session.shareFile's `needs` ([{ kind, label, ... }]: 'rom' and
// 'dos' are ROMs, 'cartridge' the cartridge); cartridge: the cartridge's file or label name as the Library shows it, or
// null when it is not known (never a checksum) -> { full, brief }, or null when the moment needs nothing; the brief form is
// for where space is short. ROMs alone, a cartridge alone and both each have their own sentence.
export const romLines = (machine, needs, cartridge = null) => {
  const list = needs || [];
  const roms = list.some((x) => x.kind !== 'cartridge'), cart = list.some((x) => x.kind === 'cartridge');
  const same = cartridge ? `the same cartridge: ${cartridge}` : 'the same cartridge';
  if (roms && cart) return { full: `This link holds none of your ROMs or your cartridge. Whoever opens it needs their own ${machine} ROMs and ${same}.`,
    brief: `Needs your ${machine} ROMs and the same cartridge to open.` };
  if (cart) return { full: `This link holds none of your cartridge. Whoever opens it needs ${same}.`, brief: 'Needs the same cartridge to open.' };
  if (roms) return { full: `This link holds none of your ROMs. Whoever opens it needs their own ${machine} ROMs.`, brief: `Needs your ${machine} ROMs to open.` };
  return null;
};
// the note under Copy link when the moment is on ROMs, a cartridge or both, so the link it gives is the long one: said
// in the same plain words for each (needs as for romLines; why is Session.romCodeIn, for a moment with no needs list)
export const longLinkNote = (needs, why = null) => {
  const list = needs || [];
  const roms = list.some((x) => x.kind !== 'cartridge') || why === 'roms', cart = list.some((x) => x.kind === 'cartridge') || why === 'cartridge';
  const what = roms && cart ? 'ROMs or a cartridge' : cart ? 'a cartridge' : 'ROMs';
  return `Copy link gives a long link: short links are only for moments that run without ${what}.`;
};

// the description a forum post carries: what the link opens
// (a bundled program's own page is the program from its start, not a moment: it says so)
export const forumDescription = (name, { program = false } = {}) => (program ? `${name} in CLOADM, from the start. Opens in the browser.`
  : `The ${name} in CLOADM, exactly as I left it. Opens in the browser.`);
// [ and ] in the text would end BBCode's tag early, and Markdown's link text: they are left out of the description
const plain = (t) => String(t).replace(/[[\]]/g, '');
export function forumText(link, name, opts = {}) {
  const d = plain(forumDescription(name, opts));
  return {
    bbcode: `[url=${link}]${d}[/url]`,
    markdown: `[${d}](${link.replace(/\)/g, '%29').replace(/ /g, '%20')})`,
  };
}
