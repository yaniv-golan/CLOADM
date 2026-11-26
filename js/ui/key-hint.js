/*
 * One-time keyboard hint over the screen. It goes after the first BREAK (Esc) or 30 seconds after the
 * first key typed into the machine, and never comes back (remembered in the Session store). It reads
 * "Esc = BREAK · Home = CLEAR · Backspace = ←": those three mean the same in translated and positional mode.
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

/*
 * The typing line under the screen on a computer, "Typing goes to the machine · Tab leaves the screen", shows while the
 * screen has the keyboard focus and the sound note and the key hint are done (play/index.html: one line at a time). It
 * retires once learned: after the person has pressed Tab (or Shift+Tab) out of the screen once, or has typed into it
 * for TYPING_SECONDS in all (each second in which a key went to the screen counts once). Remembered per browser in the
 * store under typingLineDone, a display preference that is not a setting (no settings export carries it). Learned, the
 * body has the class typing-learned and the line's place is the Ask panel's example questions, focused or not.
 */
export const TYPING_SECONDS = 30;

export function setupTypingLine(page) {
  const { session } = page;
  const screen = $('screen');
  const learned = () => session.store.get('typingLineDone') !== null;
  const show = () => document.body.classList.toggle('typing-learned', learned());
  const seconds = new Set();
  const learn = () => { session.store.set('typingLineDone', '1'); show(); };
  screen.addEventListener('keydown', (e) => {
    if (learned()) return;
    if (e.key === 'Tab') { learn(); return; }
    seconds.add(Math.floor(Date.now() / 1000));
    if (seconds.size >= TYPING_SECONDS) learn();
  });
  show();
}
