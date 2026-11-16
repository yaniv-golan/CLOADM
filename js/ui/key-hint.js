/*
 * One-time keyboard hint over the screen. It goes after the first BREAK (Esc) or 30 seconds after the
 * first key typed into the machine, and never comes back (remembered in the Session store). The keyboard
 * stays in translated mode: keys type what they say.
 */
import { $ } from './page.js';

export const HINT_SECONDS = 30;

export function setupKeyHint(page) {
  const { session } = page;
  const hint = $('keyHint');
  const done = () => session.store.get('keyHintDone') !== null;
  let started = false, timer = null, finishHook = null;
  function finish() {
    session.store.set('keyHintDone', '1');
    hint.hidden = true;
    if (timer) clearTimeout(timer);
    if (finishHook) finishHook();
  }
  hint.hidden = done();
  window.addEventListener('keydown', (e) => {
    if (done()) return;
    const t = e.target;
    if (t && ((t.tagName === 'INPUT' && t.type === 'text') || t.tagName === 'TEXTAREA')) return;   // not typing into the machine
    if (e.key === 'Escape') { finish(); return; }
    if (!started) { started = true; timer = setTimeout(finish, HINT_SECONDS * 1000); }
  });
  // The boot help has the screen's attention when it shows, so the keyboard hint yields to it. The boot
  // help's visibility changes on a machine, firmware or reset event or as the boot resolves; rather than
  // poll for it, watch it per frame while the keyboard hint is still live, and stop once it is finished.
  let unwatch = null;
  if (!done()) {
    unwatch = page.onFrame(() => {
      if (done()) { unwatch(); unwatch = null; return; }
      hint.hidden = !$('bootHelp').hidden;
    });
  }
  finishHook = () => { if (unwatch) { unwatch(); unwatch = null; } };
  return { finish };
}
