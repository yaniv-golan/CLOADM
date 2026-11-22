/*
 * "Ask Claude ↗": where the chat can't run, a link that opens CLOADM top-level in a new tab with the chat.
 *
 * A page shown inside another site's page has no chat (js/config.js claudeOffered: the key card would be on someone
 * else's page). Two places offer the link instead:
 *   - the full page in a frame (no embed=1): the app bar's Ask button becomes this link (#btnAskPop; on a phone it
 *     sits where Ask does, beside Menu);
 *   - an embed (embed=1) whose snippet opted in with askclaude=1: a small chip in the screen's corner (#embedAsk).
 *     Without the parameter an embed draws nothing.
 * The link is made when someone points at it, focuses it or presses it, and when the machine changes or is restored; never
 * on a timer, and not again until the machine has run since the last one (a snapshot costs work).
 * The link is the Share screen's link for this moment (Session.claudeLink: the snapshot in the fragment) with
 * app=claude, never embed=1, opened with target=_blank and rel="noopener noreferrer": the new tab is its own top-level
 * page with no handle back to this one, so it reads the key saved in this browser and the framing page never sees it.
 * The new tab never starts a turn by itself: app=claude opens the chat and waits for the person to type.
 * Where the moment can't be carried (NitrOS-9 runs, as the Share screen detects) the link opens a fresh CLOADM on the
 * same machine with app=claude, and its description says so.
 */
import { $ } from './page.js';

export const POPOUT_TEXT = Object.freeze({
  carried: "Opens CLOADM in a new tab with this machine as it is now. Claude can't run inside another site.",
  fresh: "Opens a fresh CLOADM in a new tab (this program can't be carried over). Claude can't run inside another site.",
});
// -> the link element in use, or null where neither place applies (a top-level page, or an embed without the opt-in)
export function setupAskPopout(page, { link, framed }) {
  const { session } = page;
  const where = link.embed ? (link.askClaude ? 'chip' : null) : framed ? 'appbar' : null;
  if (!where) return null;
  const a = $(where === 'chip' ? 'embedAsk' : 'btnAskPop');
  document.body.classList.add(where === 'chip' ? 'ask-chip' : 'claude-popout');
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  // the page's own address, without its query or fragment: buildUrl writes the machine and app=claude onto it
  const base = () => `${location.origin}${location.pathname}`;
  let pending = null, settled = true;
  // the machine and the frame its last link was made at: a link is made again only once the machine has run since
  // (nothing is snapshotted while the page sits idle or the machine is paused)
  let madeFor = null, madeAt = -1;
  const draw = ({ href, carried }) => {
    a.href = href;
    const text = carried ? POPOUT_TEXT.carried : POPOUT_TEXT.fresh;
    a.title = text;
    a.setAttribute('aria-description', text);
    a.dataset.carried = carried ? '1' : '0';
  };
  // the link for the moment as it is now; one at a time (a press while one runs waits for it, then takes a new one).
  // force: make it even if the machine has not run (a machine switch or a restore changed the moment without frames)
  function refresh(force = false) {
    const m = session.shownMachine;
    if (!m) return Promise.resolve();
    if (!force && m === madeFor && m.frameCount === madeAt) return pending || Promise.resolve();
    madeFor = m; madeAt = m.frameCount;
    settled = false;
    const run = (pending || Promise.resolve()).then(() => session.claudeLink(base())).then(draw)
      .catch((e) => console.warn(`Ask Claude link: ${e.message}`))
      .finally(() => { if (pending === run) { pending = null; settled = true; } });
    pending = run;
    return run;
  }
  // (a hover, focus or press, and the ways a link is opened that do not go through a plain click: the context menu's "Open in new tab", a
  // middle click and a ctrl-click, which the browser takes the href of after these events)
  for (const ev of ['pointerenter', 'focus', 'pointerdown', 'contextmenu', 'auxclick']) a.addEventListener(ev, () => { refresh(); });
  a.addEventListener('keydown', (e) => { if (e.key === 'Enter') refresh(); });
  // a click before the press's link is ready: wait for it, then open the same way the link would (a new top-level
  // tab with no opener and no referrer). The browser keeps the click's activation for a few seconds, so the tab opens.
  a.addEventListener('click', (e) => {
    if (settled || e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    pending.then(() => { window.open(a.href, '_blank', 'noopener,noreferrer'); });
  });
  session.on((ev) => { if (ev === 'machine' || ev === 'restored') refresh(true); });
  refresh(true);
  return { element: a, refresh };
}
