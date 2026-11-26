/*
 * The Menu's one definition: the phone's dropdown under the app bar (held upright, js/ui/main.js) and the touch panel's
 * sheet held sideways (js/ui/touch-keys.js) list the same rows in the same order, in four groups with a thin rule
 * between them. A row is shown only where it is not already on screen: `sideways` rows are the ones the upright app bar
 * has as buttons of its own (Open…, Ask Claude…, the machine) or that only the sideways panel needs (Hide keys); the
 * others are the upright Menu's own elements (`nav`, an id in play/index.html), which each layout shows or hides as it
 * always has (Add ROMs… while the machine has no BASIC, the ports and Power where the chips are not shown, Install
 * CLOADM… while it is offered). `state`: a second line with what is in the ports, or whether the machine runs
 * (js/ui/phone-sheets.js). `href`: a link (the sheet draws an <a>, as the upright Menu does); `ext`: another site's, marked ↗.
 */
export const MENU = Object.freeze([
  [
    { item: 'programs', nav: 'navPrograms', label: 'Programs…' },
    { item: 'open', label: 'Open…', sideways: true },
    { item: 'ask', label: 'Ask Claude…', sideways: true },
    { item: 'share', nav: 'navShare', label: 'Share…' },
  ],
  [
    { item: 'machine', label: 'Machine…', sideways: true },
    { item: 'ports', nav: 'navPorts', label: 'Tape, disks and cartridge…', state: true },
    { item: 'power', nav: 'navPower', label: 'Power…', state: true },
    { item: 'roms', nav: 'navRoms', label: 'Add ROMs…' },
    { item: 'settings', nav: 'navSettings', label: 'Settings…' },
  ],
  [
    { item: 'snapTake', nav: 'navSnapTake', label: 'Take snapshot' },
    { item: 'snapRestore', nav: 'navSnapRestore', label: 'Restore snapshot…' },
  ],
  [
    { item: 'commands', nav: 'navCommands', label: 'Commands…' },
    { item: 'library', nav: 'navLibrary', label: 'Library', href: 'play/#library' },
    { item: 'debugger', nav: 'navDebugger', label: 'Debugger', href: 'play/#debugger' },
    { item: 'help', nav: 'navHelp', label: 'Help', href: 'help/' },
    { item: 'install', nav: 'navInstall', label: 'Install CLOADM…' },
    { item: 'github', nav: 'navGithub', label: 'GitHub', href: 'https://github.com/yaniv-golan/cloadm', ext: true },
    { item: 'hide', label: 'Hide keys', sideways: true },
  ],
].map((g) => Object.freeze(g.map((r) => Object.freeze(r)))));

// The open Menu's height (either one): the box scrolls, and its bottom edge never runs through a row's text, nor does
// its 24 px fade (play/index.html) lie over the last row that shows: the edge falls in the gap between two rows' texts,
// at least FADE below the one (less the few px of its line's leading) and at most at the top of the next. Given the room it may take (from its top), it takes the
// lowest such edge that fits, or what it needs where everything fits. box: the scroller; rows: its row elements.
export const FADE = 24, SLACK = 4;
export function fitMenu(box, rows, room) {
  box.style.maxHeight = '';
  const r = box.getBoundingClientRect(), cs = getComputedStyle(box);
  const bb = parseFloat(cs.borderBottomWidth) || 0;
  let h = Math.max(0, Math.floor(room));
  if (box.scrollHeight + (r.height - box.clientHeight) > h) {
    const st = box.scrollTop;
    // each row's text, top and bottom, from the box's top edge at scrollTop 0 (the text is what must stay whole, not
    // the row's padding)
    const texts = rows.filter((e) => e.checkVisibility()).map((e) => {
      const range = document.createRange(); range.selectNodeContents(e);
      const t = range.getBoundingClientRect();
      return { top: t.top - r.top + st, bottom: t.bottom - r.top + st };
    });
    // (the fade may lie over a line's leading below its letters: SLACK px)
    let edge = 0;
    texts.forEach((t, k) => {
      const next = texts[k + 1], at = Math.min(h - bb, next ? next.top : Infinity);
      if (at >= t.bottom + FADE - SLACK) edge = at;
    });
    h = Math.floor(edge + bb);
  }
  box.style.maxHeight = `${h}px`;
  moreBelow(box);
}
// the bottom fades (24 px, play/index.html .more-below) while the box can scroll further, and only then
export function moreBelow(box) {
  box.classList.toggle('more-below', box.scrollTop + box.clientHeight < box.scrollHeight - 1);
}
