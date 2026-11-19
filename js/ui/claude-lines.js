/*
 * The small lines under Claude's turns, shared by the side panel, the phone sheet (js/ui/ask.js) and the full-screen
 * chat's card (js/ui/claude.js):
 *   - the restore line (UX ruling R12): one muted line under the latest turn that changed the machine,
 *     "↶ Restore to 23:58 · Restore points…", the second a disclosure with every point and what restoring does; while
 *     a turn runs the button is disabled: "Restore point at 23:58 · Stop first to restore";
 *   - the action lines (UX ruling R13): one muted line per acting call under the turn's reply (js/claude/actions.js),
 *     a turn with more than 3 acting calls folding its ✓ lines into one button.
 * Nodes are updated in place, never rebuilt, so focus stays on a button across re-renders and a live region
 * announces only what is new.
 */
import { actionBlock, clock } from '../claude/actions.js';

export const POINT_NOTE = 'Restore points are kept only while this chat is open, and only the last 10: reloading the page, ending the chat or switching machine loses them. Restoring also undoes your own typing since that point. Saved files (Library, DriveWire) are not rolled back, except a disk left in its drive since the point.';

const el = (tag, text, cls) => { const e = document.createElement(tag); if (text != null) e.textContent = text; if (cls) e.className = cls; return e; };
const setText = (e, t) => { if (e.textContent !== t) e.textContent = t; };
const setAttr = (e, k, v) => { if (e.getAttribute(k) !== v) e.setAttribute(k, v); };

// Keep `parent`'s children as `rows`, in order: [{ key, make: () => Node, update: (node) => void }]. A row whose key
// is already there keeps its node (updated in place); new rows are created; rows gone are removed. A node is moved
// only when it is out of place, so nothing is re-inserted needlessly (a live region would announce it again).
export function syncRows(parent, rows) {
  const have = new Map([...parent.children].map((n) => [n.dataset.key, n]));
  const keep = new Set(rows.map((r) => r.key));
  for (const [k, n] of have) if (!keep.has(k)) n.remove();
  let at = parent.firstChild;
  for (const r of rows) {
    let n = have.get(r.key);
    if (!n) { n = r.make(); n.dataset.key = r.key; }
    r.update(n);
    if (n !== at) parent.insertBefore(n, at); else at = at.nextSibling;
  }
}

// The restore line in `box` (built once, then updated). points: Session.claudePoints (newest first); busy: a turn is
// running; restore(index): restore that point; id: a prefix for the list's id (aria-controls).
export function restoreLine(box, { points, busy, restore, id }) {
  let line = box.querySelector(':scope > .restoreline');
  if (!line) {
    line = el('div', null, 'restoreline');
    const go = el('button', null, 'rl-go');
    go.append(el('span', '↶ ', 'glyph'), el('span', '', 'rl-label'));
    go.querySelector('.glyph').setAttribute('aria-hidden', 'true');
    const sep = el('span', ' · ', 'rl-sep');
    const wait = el('span', 'Stop first to restore', 'rl-wait');
    const more = el('button', 'Restore points…', 'link rl-more');
    const list = el('div', null, 'rl-list');
    list.id = `${id}PointList`;
    list.hidden = true;
    more.setAttribute('aria-controls', list.id);
    more.setAttribute('aria-expanded', 'false');
    more.onclick = () => { list.hidden = !list.hidden; more.setAttribute('aria-expanded', String(!list.hidden)); };
    const items = el('div', null, 'rl-items');
    list.append(items, el('p', POINT_NOTE, 'muted pointnote'));
    line.append(go, sep, wait, more, list);
    box.append(line);
  }
  const [go, , wait, more, list] = line.children;
  const p = points[0];
  line.hidden = !p;
  if (!p) { list.hidden = true; setAttr(more, 'aria-expanded', 'false'); return line; }
  const t = clock(p.at);
  go.disabled = !!busy;
  setText(go.querySelector('.glyph'), busy ? '' : '↶ ');
  setText(go.querySelector('.rl-label'), busy ? `Restore point at ${t}` : `Restore to ${t}`);
  setAttr(go, 'aria-label', busy ? `Restore point at ${t}: stop Claude first to restore` : `Restore the machine to ${t}, before Claude's last changes`);
  go.onclick = () => { if (!busy) restore(p.index); };
  wait.hidden = !busy;
  more.hidden = !!busy;
  if (busy) { list.hidden = true; setAttr(more, 'aria-expanded', 'false'); }
  // the list: rebuilt only when the points change, so a focused button in it keeps its focus otherwise
  const items = list.querySelector('.rl-items');
  const sig = points.map((pt) => `${pt.index}@${pt.at}`).join();
  if (items.dataset.sig !== sig) {
    items.dataset.sig = sig;
    items.replaceChildren(...points.map((pt) => {
      const b = el('button', `Restore to ${clock(pt.at)}`);
      b.setAttribute('aria-label', `Restore the machine to ${clock(pt.at)}`);
      b.onclick = () => restore(pt.index);
      return b;
    }));
  }
  return line;
}

// A turn's action lines in `box` (a div kept by the caller): the folded button when the turn folds, then each line,
// then, when nothing folds, a plain line counting the reads (text, not a button). open: whether this turn's folded
// lines are shown; toggle(): the person flips it.
export function actionLines(box, { actions, reads, open, toggle }) {
  const { lines, summary, reads: readLine } = actionBlock(actions, reads);
  let sum = box.querySelector(':scope > .act-sum');
  if (summary) {
    if (!sum) {
      sum = el('button', null, 'link act-sum');
      sum.append(el('span', '', 'act-sum-text'), el('span', '', 'glyph'));
      sum.querySelector('.glyph').setAttribute('aria-hidden', 'true');
      box.prepend(sum);
    }
    setText(sum.querySelector('.act-sum-text'), summary);
    setText(sum.querySelector('.glyph'), open ? ' ▾' : ' ▸');
    setAttr(sum, 'aria-expanded', String(!!open));
    sum.onclick = toggle;
  } else if (sum) sum.remove();
  let list = box.querySelector(':scope > .act-list');
  if (!list) { list = el('div', null, 'act-list'); box.append(list); }
  syncRows(list, lines.filter((l) => !l.folded || open).map((l) => ({
    key: String(l.seq),
    make: () => { const d = el('div', null, 'act'); d.append(el('span', '', 'glyph'), el('span', '', 'act-text')); d.firstChild.setAttribute('aria-hidden', 'true'); return d; },
    update: (d) => { setText(d.firstChild, `${l.glyph} `); setText(d.lastChild, l.text); d.dataset.outcome = l.outcome; },
  })));
  let counted = box.querySelector(':scope > .act-reads');
  if (readLine) {
    if (!counted) { counted = el('div', null, 'act-reads'); box.append(counted); }
    setText(counted, readLine);
  } else if (counted) counted.remove();
  box.hidden = !lines.length && !readLine;
  return box;
}
