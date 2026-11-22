// Claude's consent to act on the person's machine, for one visit: the "Let Claude use the emulator" switch,
// load_basic's own card and its "Don't ask again this session", the card waiting for an answer, and the pause the
// person's own input makes. The Session owns one (session.consent) and wires it into each ChatSession it opens
// (Session.gateTools: chat.gate and chat.recheck decide here). Nothing here is saved: no snapshot, no settings
// export, no store, and never the API key. The machine side of a pause (holding back and re-queueing Claude's
// typing) stays in the Session (pauseClaude, resumeClaude, endClaudePause), which calls pause, resume and endPause.
import { ToolError, TOOL_CODES } from './toolerrors.js';

// the answer a card gets when the turn is stopped (Stop, the turn's abort): the tool fails stopped, not declined
export const STOPPED = Symbol('stopped');

export class Consent {
  // onChange: () => void, the page's cue to redraw (the Session's emit('chat'));
  // onResume: () => void, the Session's resumeClaude (a card's "Allow and resume")
  constructor({ onChange = () => {}, onResume = () => {} } = {}) {
    this.onChange = onChange;
    this.onResume = onResume;
    this.allowed = false;     // "Let Claude use the emulator" (off until the person allows it)
    this.asker = null;        // (name, input) => void: the page asks the person (answer gives the answer)
    this.loadNoAsk = false;   // "Don't ask again this session" on load_basic's card (for the visit only)
    this.pending = null;      // the card waiting for an answer: { name, input, resolve, kind, load? }
    this.pauses = 0;          // pauses made so far (a ticket taken before a pause no longer holds)
    this.paused = null;       // a key the person pressed paused Claude: { held (keys not yet typed), wake, revoked? }
  }

  // the switch. Turning it off also brings load_basic's card back and refuses a card waiting for an answer.
  // (On never resumes a pause: it gives consent only. Off during a pause refuses the call waiting on it: wait)
  setAllowed(on) {
    this.allowed = !!on;
    if (!on && this.paused) this.paused.revoked = true;
    if (!on) { this.loadNoAsk = false; if (this.pending) this.pending.resolve(false); }
    this.onChange();
  }
  // answer the card on screen: the consent card (Allow / Just tell me the fix) or load_basic's card (Load it /
  // Don't load), whose "Don't ask again this session" is dontAsk. resume: the card's accept button read "Allow and
  // resume" / "Load and resume" (Claude paused when the card was drawn; the page passes what it drew, never
  // `paused` at click time, so a key pressed just before a click on plain Allow is not resumed unseen): yes and
  // Resume in one synchronous step. A no never resumes: the pause stays until Resume, Stop or the turn's end.
  answer(allow, { dontAsk = false, resume = false } = {}) {
    const p = this.pending;
    if (!p) return;
    // "Don't ask again" is offered only while the switch is on; with it off the page hides the box and it counts for nothing
    if (p.kind === 'load' && allow && dontAsk && this.allowed) this.loadNoAsk = true;
    p.resolve(!!allow);
    if (allow && resume) this.onResume();
  }

  // The card: the page shows the question (asker tells it); without a page nobody can say yes. The turn's abort
  // (Stop, or Esc/BREAK, which abort the request without stopClaude) also ends it: left waiting it would hold the
  // turn until someone answered it. -> a promise of true, false or STOPPED
  ask(name, input, extra, signal) {
    return (!this.asker ? Promise.resolve(false) : new Promise((resolve) => {
      if (signal) { if (signal.aborted) resolve(STOPPED); else signal.addEventListener('abort', () => resolve(STOPPED), { once: true }); }
      this.pending = { name, input, resolve, ...extra };
      this.asker(name, input);
      this.onChange();
    })).then((ok) => { this.pending = null; this.onChange(); return ok; });
  }
  // the answer as the code the tool fails with: Stop is stopped; no (or nobody to ask) is the card's own code
  refuse(ok, declined) {
    if (ok === STOPPED) throw new ToolError(TOOL_CODES.STOPPED);
    if (ok !== true) throw new ToolError(this.asker ? declined : TOOL_CODES.NO_CONSENT);
  }

  // The consent an acting call needs, before its check: null when nobody has to be asked, else the card's promise
  // (it rejects to refuse). call.consent records what the call relied on: 'card' (the person answered a card for
  // it) or 'switch'. how: { load: () => the card's load summary (load_basic only: its program is checked first, so a
  // load that cannot happen is refused with its own code without asking anyone), acting: () => void (the call is
  // allowed: the Session marks Claude acting), signal: the turn's abort signal }.
  decide(name, input, call, { load, acting, signal }) {
    if (name === 'load_basic') {
      // load_basic replaces the program in memory, so every call has its own card, whatever the switch says, until
      // the person ticks "Don't ask again this session" (loadNoAsk, offered only while the switch is on)
      const summary = load();
      // ("Don't ask again" holds only while the switch is on: with it off every load asks)
      if (!(this.loadNoAsk && this.allowed)) {
        return this.ask(name, input, { kind: 'load', load: summary }, signal)
          .then((ok) => { this.refuse(ok, TOOL_CODES.LOAD_DECLINED); call.consent = 'card'; acting(); });
      }
    } else if (!this.allowed) {
      return this.ask(name, input, { kind: 'consent' }, signal)
        .then((ok) => { this.refuse(ok, TOOL_CODES.CONSENT_DECLINED); this.allowed = true; call.consent = 'card'; acting(); });
    }
    call.consent = 'switch';
    acting();
    return null;
  }
  // The pre-act re-check, synchronous with the change (ChatSession.runTool): the person may have paused Claude
  // (their input while the card waited or the tool's check ran, an INCLUDE read: Session.personInput) or turned the
  // switch off. Paused: wait for Resume as the gate does (the caller runs this again after); the turn's end or abort
  // ends the pause and the call is stopped, with no restore point. A call that relied on the switch (call.consent
  // 'switch') is refused no-consent once it is off; a card answered for this very call ('card') still holds for it.
  recheck(name, call) {
    if (this.paused) return this.wait();
    if (call.consent === 'switch' && !(this.allowed && (name !== 'load_basic' || this.loadNoAsk))) throw new ToolError(TOOL_CODES.NO_CONSENT);
    return null;
  }

  // The pause: pause(held) starts one (held: what Claude had not yet typed, which the Session holds back);
  // resume() and endPause() end it and return it (null when there was none), waking what waits on it to go on
  // (resume) or refused (endPause). The Session puts the held typing back, or ends it, itself.
  pause(held) {
    this.paused = { held, wake: [] };
    this.pauses++;
  }
  resume() {
    const p = this.paused;
    if (!p) return null;
    this.paused = null;
    for (const w of p.wake) w(true);
    return p;
  }
  endPause() {
    const p = this.paused;
    if (!p) return null;
    this.paused = null;
    for (const f of p.wake) f(false);
    return p;
  }
  // the pause's own wait: resume wakes it to go on; endPause (Stop, the turn's abort or end) wakes it refused, and
  // the call fails stopped. The switch turned off during the pause (setAllowed marks the pause revoked) refuses the
  // waiting call no-consent on Resume, whatever consent it relied on (a card answered for it included): the person
  // withdrew it while the call could not act.
  wait() {
    const p = this.paused;
    return new Promise((resolve) => { p.wake.push(resolve); }).then((go) => {
      if (!go) throw new ToolError(TOOL_CODES.STOPPED);
      if (p.revoked) throw new ToolError(TOOL_CODES.NO_CONSENT);
    });
  }
}
