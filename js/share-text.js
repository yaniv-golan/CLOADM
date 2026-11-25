/*
 * The Share screen's words that need no page (tests/share-text.test.js runs them in Node):
 *  - romFreeLine: the line above the needs line when the moment uses ROMs (or a cartridge's image). It is true by
 *    construction: Session.shareFile takes every byte of them out (tests/share-roms.test.js proves it).
 *  - forumText: "Copy as text for a forum", the link with a one-line description as BBCode and as Markdown. Text only: no
 *    image tag, as nothing serves a picture for a link yet.
 */
// needs: Session.shareFile's `needs` ([{ label, ... }]) -> the line, or '' when the moment needs none
export const romFreeLine = (needs) => (needs && needs.length
  ? `This link holds no part of your ROMs. Whoever opens it needs their own: ${needs.map((x) => x.label).join(' and ')}.` : '');

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
