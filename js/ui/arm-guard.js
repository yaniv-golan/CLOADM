/*
 * The arm guard: the controls that give Claude a key or a say over the machine take no press until their card has been
 * on screen for ARM_MS. A press that lands the moment a card appears was aimed at whatever was there before (a second
 * click of a double click, a key held through the change), not at the card.
 *
 * Guarded: the consent card's Allow, the key card's Save key and Forget, and the "Let Claude use the emulator" switch,
 * in the side panel and in the full-screen chat.
 *
 * The window starts when the card becomes visible (shown again after being hidden counts as new) and starts again when
 * the page comes back (pageshow, and visibilitychange to visible). It does NOT start again on window focus, and the
 * card needs no pointer movement or key press to arm: the time alone does it, so a touch tap at 600 ms works.
 * During the window the controls are aria-disabled, never `disabled`: a press on one does nothing and the focus stays
 * on it, so pressing again after the window works. The card fades in over about 300 ms; the controls take presses at
 * ARM_MS with nothing about them changing on screen (no flash). Once armed, the card is announced (a polite live region).
 * Every way of pressing (a click, a tap, Enter or Space on the control, a label of the switch, a script's .click()) is
 * a click event on the control, and the guard takes those in the capture phase on the card, before the control's own
 * handler.
 */

export const ARM_MS = 500;

// cards: [{ card: element, controls: [elements] }]. -> { armed(card), shownAt(card), rearm(), sync() } (the browser check)
export function setupArmGuard(cards, { now = () => performance.now(), announce = null } = {}) {
  const state = new Map();   // card -> { shown, since, timer }
  const shown = (el) => !!el.isConnected && el.checkVisibility();
  function start(entry) {
    const st = state.get(entry.card);
    st.since = now();
    clearTimeout(st.timer);
    for (const c of entry.controls) c.setAttribute('aria-disabled', 'true');
    // the fade is restarted with the window: taken off, then put back on the next frame
    entry.card.classList.remove('arming');
    void entry.card.offsetWidth;
    entry.card.classList.add('arming');
    st.timer = setTimeout(() => arm(entry), ARM_MS);
  }
  function arm(entry) {
    const st = state.get(entry.card);
    st.timer = null;
    for (const c of entry.controls) c.removeAttribute('aria-disabled');
    if (announce && shown(entry.card)) announce(entry.label());
  }
  // a card that has just come on screen starts its window; one that went away forgets it
  function sync() {
    for (const entry of cards) {
      const st = state.get(entry.card), on = shown(entry.card);
      if (on && !st.shown) start(entry);
      if (!on && st.shown) { clearTimeout(st.timer); st.timer = null; entry.card.classList.remove('arming'); }
      st.shown = on;
    }
  }
  for (const entry of cards) {
    state.set(entry.card, { shown: false, since: 0, timer: null });
    entry.label = entry.label || (() => {
      const head = entry.card.querySelector('strong, h2, label');
      return `${head ? head.textContent.trim() : ''}${head ? ': ' : ''}${entry.controls.map((c) => c.textContent.trim() || (c.closest('label') ? c.closest('label').textContent.trim() : '')).filter(Boolean).join(', ')} ready.`;
    });
    entry.card.addEventListener('click', (e) => {
      const hit = entry.controls.find((c) => c === e.target || c.contains(e.target) || (e.target.control === c));
      if (!hit) return;
      sync();   // (a card that came on screen since the last mutation callback counts as just shown)
      const st = state.get(entry.card);
      if (st.shown && now() - st.since >= ARM_MS) return;
      // too soon: nothing happens (a checkbox keeps its state), and the focus stays where it is
      e.preventDefault();
      e.stopImmediatePropagation();
    }, true);
  }
  // visibility follows the DOM: hidden attributes, classes and styles anywhere above a card
  new MutationObserver(sync).observe(document.body, { subtree: true, attributes: true, attributeFilter: ['hidden', 'class', 'style'] });
  addEventListener('resize', sync);
  // the page came back: every card on screen starts its window again (window focus is not one of these)
  const rearm = () => { for (const entry of cards) { const st = state.get(entry.card); st.shown = shown(entry.card); if (st.shown) start(entry); } };
  addEventListener('pageshow', rearm);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') rearm(); });
  sync();
  return {
    armed: (card) => { const st = state.get(card); return !!st && st.shown && now() - st.since >= ARM_MS; },
    // when the card's window started (now()'s clock), null while it is off screen
    shownAt: (card) => { const st = state.get(card); return st && st.shown ? st.since : null; },
    rearm,
    sync,
  };
}
