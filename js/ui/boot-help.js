/*
 * Boot help: when ROMs are in use and BASIC hasn't printed OK within a few seconds of power-on, a box
 * over the screen explains why, from the socket status (Session.bootStatus reads the screen), with
 * "Add ROMs" and "Run without ROMs". It never says the boot FAILED after a Reset (RAM is kept and a program may
 * hold BASIC's warm-start vector): when a program does hold it, the box says "A program took over Reset" instead
 * and offers "Switch off and on". Nor does it show for a snapshot opened from a file or a slot, or for a point
 * put back by Claude's undo - a loaded moment was not a power-on, and the program it holds may be a game.
 * It never blocks the machine and can be dismissed.
 */
import { $ } from './page.js';

export const BOOT_SECONDS = 5;

// What the box does when the Session announces something: 'restart' (re-check and watch again: the machine, its
// firmware or a Reset; the answer may go back to 'booting'), 'recheck' (a restore: check once, so a box raised by
// the run it replaced goes, without treating the restore as a boot), or null (anything else: nothing to do). Pure
// and exported so a Node test can hold the rule the page relies on, without a DOM.
export function bootHelpOn(ev) {
  if (ev === 'machine' || ev === 'firmware' || ev === 'reset') return 'restart';
  if (ev === 'restored') return 'recheck';
  return null;
}

export function setupBootHelp(page, sockets) {
  const { session } = page;
  let dismissedFor = null;   // the power-on the user dismissed the box for
  const box = $('bootHelp');
  function check() {
    const st = session.bootStatus(BOOT_SECONDS), m = session.machine;
    const resetAt = m.resetAt;
    const takeover = st.state === 'reset' && st.takeover;
    const show = (st.state === 'failed' || takeover) && dismissedFor !== `${m.id}@${resetAt}`;
    if (show) {
      $('bootHelpTitle').textContent = takeover ? 'A program took over Reset' : `No OK after ${BOOT_SECONDS} seconds`;
      $('bootHelpText').textContent = takeover ? "It set BASIC's warm-start vector, so Reset goes back into it. Switch off and on for a clean BASIC." : st.cause;
    }
    $('btnBootSockets').hidden = $('btnBootStub').hidden = takeover;
    $('btnBootPower').hidden = !takeover;
    box.hidden = !show;
    box.dataset.state = st.state;
  }
  // The box must appear on its own when BASIC never prints OK. bootStatus() goes booting -> failed on its
  // own as frames pass (and booting -> ok when the OK appears), and no session event announces either, so
  // while it is booting it is watched once per frame. Once it is stub, ok, restored, reset or failed the answer
  // only changes on a machine, firmware or reset event, all of which call check() directly, so the watcher stops.
  // This replaces a 500 ms setInterval that ran for the whole session.
  let unwatch = null;
  function startWatch() {
    if (unwatch) return;
    unwatch = page.onFrame(() => {
      if (!session.machine) return;
      check();
      if (session.bootStatus(BOOT_SECONDS).state !== 'booting') { unwatch(); unwatch = null; }
    });
  }
  startWatch();
  // a new machine, power-on or reset: at once (and watch again if it is booting), so the box never shows
  // the previous machine's cause. A restore ('restored': an opened snapshot, or Claude's undo through
  // Session.restorePoint) is not one of those and must not be treated as one: it only re-checks, so a box raised by
  // the run the restore replaced goes, and a box for a moment that is itself a boot failure stays (bootStatus
  // answers 'failed' for it, and the check shows it again).
  session.on((ev) => {
    const what = bootHelpOn(ev);
    if (what === 'restart') { check(); startWatch(); }
    else if (what === 'recheck') check();
  });
  $('btnBootSockets').onclick = () => { sockets.reveal(); };
  $('btnBootStub').onclick = () => { sockets.runWithoutRoms(); check(); };
  $('btnBootPower').onclick = () => { session.powerCycle({ reason: 'you power cycled the machine' }); page.focus(); };
  $('btnBootDismiss').onclick = () => { const m = session.machine; dismissedFor = `${m.id}@${m.resetAt}`; check(); };
  return { check };
}
