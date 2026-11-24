/*
 * The arrival card: someone opened a shared moment (a long link, #z=, or a short link, #l=; js/ui/snapshot-panel.js
 * opens it with its `link`). While the Session says the person has just arrived (Session.arrivedFromLink), a card
 * docked at the foot of the screen says, in these exact words:
 *   "Someone sent you this <machine>, exactly as they left it. It's running now. It's your copy: nothing you do
 *    changes theirs."
 * with [Start from the beginning] (startOver: the bundled program the moment is of, from its beginning; else a power
 * cycle into the same machine) and [Send it back] (the Share screen on the recipient's moment as it is now, exactly as
 * Share opens it: nothing is uploaded until they tap Copy). A short link's card ends with a small "Report this link"
 * (reportUrl). The card never takes the focus: the machine keeps running and the first key goes to it, which ends the
 * arrival (Session.touch), as a load, a switch, a Reset or a power cycle do; the card goes with it ('arrival').
 * A program page (?start=) opens no moment, so it never shows the card.
 */
import { $ } from './page.js';

export const arrivalText = (machine) => `Someone sent you this ${machine}, exactly as they left it. It's running now. It's your copy: nothing you do changes theirs.`;

// openShare: the Share screen's open (js/ui/share.js); startOver(program): as the snapshot toast's Start over;
// reportUrl(id): the address "Report this link" opens for a short link, or null for none
export function setupArrival(page, { openShare, startOver, reportUrl }) {
  const { session } = page;
  const card = $('arrival'), report = $('arrivalReport');
  function show() {
    const a = session.arrivedFromLink;
    card.hidden = !a;
    if (!a) return;
    $('arrivalText').textContent = arrivalText(a.machine);
    const href = a.kind === 'short' && a.id ? reportUrl(a.id) : null;
    report.hidden = !href;
    if (href) report.href = href; else report.removeAttribute('href');
  }
  session.on((ev) => { if (ev === 'arrival') show(); });
  $('btnArrivalStart').onclick = () => { const a = session.arrivedFromLink; startOver(a ? a.program : null); };
  $('btnArrivalBack').onclick = () => openShare();
  show();
  return { show };
}
