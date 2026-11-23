/*
 * A Debugger stop, seen from the emulator. Leaving the Debugger keeps the machine stopped (the
 * Session's debugger stays stopped until something resumes it), and the page says so in one place each:
 *   - the strip directly above the monitor (#dbgStrip, outside the canvas; between the header and the screen on a
 *     phone): why it stopped and where ("Stopped at breakpoint $C0F3."), with Resume and Open Debugger. role=status,
 *     its text written once per stop (a step is a stop of its own), so it is announced once; only a Debugger stop
 *     shows it (the page's Pause does not), and Esc does not dismiss it: it goes when the machine runs again.
 *   - the Pause button and the status line (js/ui/screen.js): "Resume", and "Stopped in the Debugger".
 *   - a launch (Run again, the shelf, Open, a drop, Reset, Switch off and on, a machine switch) releases the stop in
 *     the Session (Session.launch); its toast adds "The Debugger's stop at $C0F3 was released." (the launch's own
 *     toast when it raises one in the same turn, else a toast of its own).
 *   - typing while stopped is refused in the Session (refuseTyping): one toast per stop.
 */
import { $ } from './page.js';

const hex4 = (n) => `$${(n & 0xFFFF).toString(16).toUpperCase().padStart(4, '0')}`;
export const TYPING_REFUSED = 'The machine is stopped: press Resume, then type.';
export const releasedText = (pc) => `The Debugger's stop at ${hex4(pc)} was released.`;
// the strip's sentence for a stop: its reason (Debugger.stopReason) and the PC it stopped at
export function stopText(reason, pc) {
  const r = reason || {}, at = hex4(pc);
  if (r.kind === 'breakpoint') return `Stopped at breakpoint ${at}.`;
  if (r.kind === 'watchpoint') return `Stopped: the watchpoint on ${hex4(r.address)} was ${r.access === 'read' ? 'read' : 'written'} at ${at}.`;
  if (r.kind === 'limit') return `Stopped in the Debugger: the run limit was reached at ${at}.`;
  return `Stopped in the Debugger at ${at}.`;   // Pause in the Debugger (halt), a step, and the rest
}

export function setupDebuggerStop(page) {
  const { session } = page;
  const strip = $('dbgStrip'), text = $('dbgStripText');
  let shownFor = null;   // the stop (its reason object, new for every stop) the strip was written for
  // per animation frame, cheap: a stop is made by the Debugger's commands, a breakpoint in the frame loop, or MCP
  page.onFrame(() => {
    const d = session.debugger;
    if (!d || !d.stopped) {
      if (shownFor) { shownFor = null; strip.hidden = true; text.textContent = ''; }
      return;
    }
    if (shownFor === d.stopReason) return;
    shownFor = d.stopReason;
    text.textContent = stopText(d.stopReason, d.pc);
    strip.hidden = false;
  });
  $('btnStripResume').onclick = () => { page.resumeAll(); page.focus(); };
  $('btnStripDebugger').onclick = () => { location.hash = '#debugger'; };
  // the released sentence rides on the launch's own toast (page.status, page.toast); a launch that raises none in
  // this turn (Reset, Switch off and on) gets it as a toast of its own
  session.on((ev, arg) => {
    if (ev === 'released') {
      const note = releasedText(arg);
      page.releasedNote = note;
      setTimeout(() => { if (page.releasedNote === note) { page.releasedNote = null; page.status(note); } }, 0);
    } else if (ev === 'typing-refused') page.status(TYPING_REFUSED);
  });
}
