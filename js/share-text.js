/*
 * The Share screen's words that need no page (tests/share-text.test.js runs them in Node):
 *  - romLines: the Share screen's one ROM line when the moment uses ROMs (or a cartridge's image): that the link holds
 *    none of them, and that whoever opens it needs their own; and its compact form. True by construction:
 *    Session.shareFile takes every byte of them out (tests/share-roms.test.js proves it).
 *  - forumText: "Copy as text for a forum", the link with a one-line description as BBCode and as Markdown. Text only: no
 *    image tag, as nothing serves a picture for a link yet.
 */
// machine: the name the Share screen shows ("Dragon 64") -> { full, brief }; the brief form is for where space is short
export const romLines = (machine) => ({
  full: `This link holds none of your ROMs. Whoever opens it needs their own ${machine} ROMs.`,
  brief: `Needs your ${machine} ROMs to open.`,
});
// the note under Copy link when the moment is on ROMs, so the link it gives is the long one
export const LONG_LINK_NOTE = 'Copy link gives a long link: short links are only for moments that run without ROMs.';

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
