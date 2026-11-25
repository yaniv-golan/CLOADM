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

// What the clip and the GIF may record, from the file loaded last (Session.lastLoaded): nothing while it is a WAD of
// the person's own (their game data is not ours to put in a recording), and a Freedoom WAD with its credit: in the
// file name (suffix) and in the GIF's comment extension. -> { refuse: reason | null, suffix, comment }
export const FREEDOOM_CREDIT = 'Contains Freedoom (freedoom.github.io), BSD licence.';
const WAD_RE = /\.wad$/i, isWadFile = (f) => !!f && (WAD_RE.test(f.name || '') || (!!f.bytes && f.bytes.length >= 4 && /^[IP]WAD$/.test(String.fromCharCode(...f.bytes.subarray(0, 4)))));
export function recordingGuard(last) {
  if (!isWadFile(last)) return { refuse: null, suffix: '', comment: 'Recorded in CLOADM' };
  if (/^freedoom\d?\.wad$/i.test(last.name || '')) return { refuse: null, suffix: '-Freedoom', comment: `Recorded in CLOADM. ${FREEDOOM_CREDIT}` };
  return { refuse: 'A WAD of your own is loaded: CLOADM doesn\'t record it', suffix: '', comment: '' };
}
