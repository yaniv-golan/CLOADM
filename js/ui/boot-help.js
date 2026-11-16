/*
 * Boot help: when ROMs are in use and BASIC hasn't printed OK within a few seconds of power-on, a box
 * over the screen explains why, from the socket status (Session.bootStatus reads the screen), with
 * "Check the sockets" and "Run without ROMs". It never blocks the machine and can be dismissed.
 */
import { $ } from './page.js';

export const BOOT_SECONDS = 5;

export function setupBootHelp(page, sockets) {
  const { session } = page;
  let dismissedFor = null;   // the power-on the user dismissed the box for
  const box = $('bootHelp');
  function check() {
    const st = session.bootStatus(BOOT_SECONDS), m = session.machine;
    const resetAt = m.frameCount - m.framesSinceReset;
    const show = st.state === 'failed' && dismissedFor !== `${m.id}@${resetAt}`;
    if (show) {
      $('bootHelpTitle').textContent = `No OK after ${BOOT_SECONDS} seconds`;
      $('bootHelpText').textContent = st.cause;
    }
    box.hidden = !show;
    box.dataset.state = st.state;
  }
  // The box must appear on its own when BASIC never prints OK. bootStatus() goes booting -> failed on its
  // own as frames pass (and booting -> ok when the OK appears), and no session event announces either, so
  // while it is booting it is watched once per frame. Once it is stub, ok or failed the answer only changes
  // on a machine, firmware or reset event, all of which call check() directly, so the watcher stops. This
  // replaces a 500 ms setInterval that ran for the whole session.
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
  // the previous machine's cause
  session.on((ev) => { if (ev === 'machine' || ev === 'firmware' || ev === 'reset') { check(); startWatch(); } });
  $('btnBootSockets').onclick = () => { sockets.reveal(); };
  $('btnBootStub').onclick = () => { sockets.runWithoutRoms(); check(); };
  $('btnBootDismiss').onclick = () => { const m = session.machine; dismissedFor = `${m.id}@${m.frameCount - m.framesSinceReset}`; check(); };
  return { check };
}
