/*
 * Install CLOADM as an app (a PWA): the Menu item, the offer card, and the steps for browsers that install from
 * their own menu.
 *
 * The card is an offer, not a demand. It appears when all of these hold: CLOADM is not already installed, the page
 * is not an embed, nor a phone in its touch layout (upright or sideways: the owner's decision with UX R30; the Menu
 * item still installs there); the emulator is shown with no view, no full-screen chat, no other card and no open Menu; a real
 * program (LIZA, a binary, a tape, a disk, BASIC) has run for 60 s this visit — never over the welcome menu; and
 * the browser can be asked (Chromium's beforeinstallprompt, held with preventDefault so its mini-infobar does not
 * appear instead, or iOS, which has no install event). At most once a visit.
 *
 * Where it sits (owner's correction 008): a floating card that never moves the page, in the first place that covers
 * none of the screen, Reset and the machine controls, the app bar or a visible on-screen key (and it never shows
 * with the machine menu open): the bottom-right corner (lifted clear of the screen), the gutter right or left of the
 * screen, or a one-line strip under the screen (a phone held upright, above its keyboard). With no such place the
 * offer waits, unspent, and comes when a resize or a settled layout makes room. It is never a modal and never a
 * history entry, never takes focus, and Esc is "Not now". A menu or a view opening takes it away without an answer:
 * the offer is owed again and returns when they close.
 *
 * Answers: "Not now" offers again after 14 days, a second "Not now" never automatically; "Don't ask again" and the
 * browser's appinstalled end it for good (appinstalled also shows a toast). With localStorage unavailable nothing is
 * remembered and no card is shown; the Menu item still works.
 *
 * The rules are exported pure functions (readAnswer, mayOffer, afterNotNow, afterDismissed, cardShows, createRunClock, platformOf, isInstalled, isIos), so Node tests pin them without a browser; setupInstall is the DOM
 * wiring around them.
 */
import { $, ESC, viewOpen, safeArea } from './page.js';

export const INSTALL_KEY = 'installAsk';
export const NOT_NOW_DAYS = 14;
export const RUN_SECONDS = 60;
const DAY = 24 * 60 * 60 * 1000;

// ---- the rules, without a DOM ----

// The stored answer, or null for "ask as usual": { until } after one "Not now" (automatic offers resume then),
// { no: true } after the second, "Don't ask again" or appinstalled. A value we cannot read counts as no answer: the
// user never said no to something we could not parse.
export function readAnswer(raw) {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
    if (v.no === true) return { no: true };
    if (Number.isFinite(v.until)) return v.n >= 1 ? { n: 1, until: v.until } : { until: v.until };
  } catch (e) { /* not ours */ }
  return null;
}
// One "Not now": automatic offers resume after 14 days. `n: 1` marks it as the card's own answer, which is what
// spends the two-offer budget (a dismissed browser dialog sets `until` without `n`).
export const notNowAt = (now) => ({ n: 1, until: now + NOT_NOW_DAYS * DAY });
// May an automatic offer be made at all? (What is on the page is cardShows' business.) An answer with a date means
// one offer was waited out already, whatever the date says now: only `no` ends them for good.
export function mayOffer(answer, now) {
  if (!answer) return true;
  if (answer.no) return false;
  return !Number.isFinite(answer.until) || now >= answer.until;
}
// One answer further: the first "Not now" waits 14 days; a second -- however long after the first -- ends the
// offers. "Don't ask again" stays "never". A dismissed browser dialog is not one of these: it has its own wait
// (afterDismissed), so the two-offer budget is only spent by the card's own button.
export function afterNotNow(answer, now) {
  if (answer && (answer.no || (answer.n || 0) >= 1)) return { no: true };
  return notNowAt(now);
}
// The browser's own install dialog was dismissed: wait the 14 days again, but do not count it as a "Not now".
// (n is kept as it was — and is absent if nothing was said before — so a later "Not now" is still the first one.)
export function afterDismissed(answer, now) {
  if (answer && answer.no) return { no: true };
  return Object.assign({}, answer || {}, { until: now + NOT_NOW_DAYS * DAY });
}
// Which browser's steps install it, from its user agent: pure, so tests can pin every case. iOS (every browser on
// it installs through the Share sheet) first; then Android's three; then a desktop that is not Chromium.
export function platformOf(ua, ios) {
  if (ios) return 'ios';
  if (/Firefox/.test(ua) && /Android/.test(ua)) return 'firefoxAndroid';
  if (/SamsungBrowser/.test(ua)) return 'samsung';
  if (/Android/.test(ua)) return 'android';
  if (/Safari/.test(ua) && !/Chrome|Chromium|Edg|Firefox/.test(ua)) return 'safariMac';
  if (/Firefox/.test(ua)) return 'desktopOther';
  return 'chromium';
}
// CLOADM running as an installed app: the browser's display mode, or iOS Safari's own flag.
export function isInstalled(win) {
  const mm = win.matchMedia && win.matchMedia('(display-mode: standalone)');
  return !!((mm && mm.matches) || (win.navigator && win.navigator.standalone));
}
// iOS and iPadOS (the iPad says "Macintosh" since 13, and has touch points a Mac has not got). Every browser on iOS
// installs through the Share sheet; none of them fires beforeinstallprompt.
export function isIos(win) {
  const nav = win.navigator || {}, ua = nav.userAgent || '';
  return /iPad|iPhone|iPod/.test(ua) || (/Macintosh/.test(ua) && (nav.maxTouchPoints || 0) > 1);
}
// Every condition for an automatic offer, in one place: the oracle's list, with no room to forget one.
export function cardShows(s) {
  return !s.installed && !s.embed && !s.storageUnavailable && !s.phone
    && mayOffer(s.answer, s.now)
    && (!!s.prompt || !!s.ios)
    && !s.view && !s.chatFull && !s.otherCard && !s.menuOpen && !s.toast
    && !!s.programRunning && !s.welcomeRunning
    && s.visitSeconds >= RUN_SECONDS;
}

// How long a program has run this visit: time spent with one running, summed over the stretches it ran. The page
// passes the clock in, so the browser check can move it instead of waiting.
export function createRunClock(now = () => Date.now()) {
  let total = 0;            // seconds of finished stretches
  let mark = null;          // when the running stretch began, on the page's clock (null: nothing runs)
  let offset = 0;           // time added by the browser check (nothing else uses it)
  const clock = () => now() + offset;
  const settle = () => { if (mark !== null) { total += Math.max(0, (clock() - mark) / 1000); mark = null; } };
  return {
    set(on) { if (on && mark === null) mark = clock(); else if (!on) settle(); },
    seconds() { return mark === null ? total : total + Math.max(0, (clock() - mark) / 1000); },
    // for tools/browser-check.js: count as if this many more seconds passed (the 60 s condition, without a wait)
    skip(seconds) { offset += seconds * 1000; },
  };
}

// ---- the page ----
// The steps a browser installs by, and what the Help page says. iOS is separate: its browsers have no event, only
// the Share sheet.
export const STEPS = Object.freeze({
  chromium: 'Open the browser menu (⋮) and choose “Install CLOADM…” (Chrome or Edge: “Apps → Install this site as an app”).',
  desktopOther: 'Open the browser menu and look for “Install this site”. Firefox on a computer installs no sites; use Chrome, Edge or Safari for this.',
  safariMac: 'In Safari: File → Add to Dock.',
  android: 'Open Chrome’s menu (⋮) and choose “Add to Home screen” — newer versions say “Install app”.',
  samsung: 'Tap ☰ and choose “Add page to”, then “Home screen”.',
  firefoxAndroid: 'Open Firefox’s menu (⋮) and choose “Install” — on older versions, “Add to Home screen”.',
  ios: 'Tap Share, then “Add to Home Screen”.',
});

export function setupInstall(page, { started = () => true, machineMenu = null } = {}) {
  const { session } = page;
  const card = $('installOffer'), steps = $('installSteps');
  const textLong = $('installText').querySelector('.long'), textShort = $('installText').querySelector('.short');
  const go = $('btnInstallGo'), notNow = $('btnInstallNotNow'), never = $('btnInstallNever');
  const menuItem = $('navInstall');
  const store = session.store;
  // With localStorage unavailable nothing can be remembered, so no card is offered (the Menu item still is). The
  // store swallows a refused write, so it is asked rather than tried: a read back says whether it kept it.
  let storageUnavailable = false;
  {
    const k = `${INSTALL_KEY}:probe`;
    try { store.set(k, '1'); storageUnavailable = store.get(k) !== '1'; store.remove(k); } catch (e) { storageUnavailable = true; }
  }
  let answer = readAnswer(storageUnavailable ? null : store.get(INSTALL_KEY));
  let deferred = null;      // Chromium's prompt event, preventDefaulted so the mini-infobar does not stand in for it
  let installed = isInstalled(window);
  const ios = isIos(window);
  let shownThisVisit = false;
  let pending = false;      // an offer deferred for want of room: still owed this visit, tried again on a size change
  let offeredByMenu = false;
  const clock = createRunClock();
  // a phone in its touch layout, upright or sideways (the owner's decision with UX R30): no offer there, the Menu item
  // installs
  const phoneSized = [matchMedia('(max-width: 700px)'), matchMedia('(orientation: landscape) and (max-height: 500px)')];
  const touchPhone = () => (document.body.classList.contains('touch-keys') || document.body.classList.contains('touch-hidden')) && phoneSized.some((q) => q.matches);

  const save = (v) => { answer = v; if (!storageUnavailable) store.set(INSTALL_KEY, JSON.stringify(v)); };
  const platform = () => platformOf(navigator.userAgent || '', ios);
  // The link sits in the app bar's nav (behind Menu on a phone); choosing it closes the machine menu if that is open
  // (through the panel's own close, so its state stays in one place), and the phone's nav menu if that showed it.
  const closeMenu = () => {
    $('appbar').classList.remove('menu-open'); $('btnMenu').setAttribute('aria-expanded', 'false');
    if (machineMenu) machineMenu.close(); else $('machineMenu').hidden = true;
  };

  // fill the card: the browser's prompt where there is one, else the steps that do it
  function fill({ offer }) {
    const p = platform();
    textLong.textContent = deferred ? 'Install CLOADM as an app on this device: it opens in its own window and works offline.'
      : ios ? 'Install CLOADM as an app on this device: tap Share, then Add to Home Screen.'
        : 'Install CLOADM as an app on this device, from your browser’s menu: it opens in its own window and works offline.';
    // the strip's one line (a phone held upright: the band between the screen and the keys has room for one)
    textShort.textContent = deferred ? 'Install CLOADM as an app?' : ios ? 'Install: Share, Add to Home Screen.' : 'Install from the browser menu.';
    // the steps below the sentence, for a browser that installs from its own menu (iOS's sentence is the step, so
    // it is not repeated)
    const list = [];
    if (!deferred && p !== 'ios') {
      for (const line of Array.isArray(STEPS[p]) ? STEPS[p] : [STEPS[p]]) {
        const li = document.createElement('li'); li.textContent = line; list.push(li);
      }
    }
    steps.replaceChildren(...list);
    steps.hidden = !list.length;
    // Chromium's offer: [Install] [Not now], with "Don't ask again" beside them. iOS's (no prompt to run): [Got it],
    // which is its "Not now", and "Don't ask again". The Menu item's card (the user asked): just what it takes.
    go.textContent = deferred ? 'Install' : 'Got it';
    go.hidden = false;
    notNow.hidden = !offer || !deferred;
    never.hidden = !offer;
  }
  // -> true when the card is up; false when this layout has no place for it and it was left for later
  function show(how) {
    offeredByMenu = how === 'menu';
    fill({ offer: how === 'offer' });
    card.hidden = false;
    card.style.setProperty('--install-lift', '0px');
    // The card goes away unshown when this size has no place that covers nothing (place() reads the real box, so a
    // card it cannot measure is not a place). An OFFER keeps the visit's one showing for a size that has room; the
    // Menu item's own card is never deferred — the user asked for it, so it stays up whatever it covers.
    const spot = how === 'menu' ? placeByBar() : place();
    if (spot === null && how === 'offer') { defer(); return false; }
    pending = false;
    // Focus only when the user asked for the card (the Menu item). The automatic offer must not take the keyboard
    // from someone typing at the machine: the next key would be lost to it, or Enter would open the install dialog.
    if (how === 'menu') ((go.hidden ? null : go) || notNow || never).focus();
    return true;
  }
  // Focus goes back to the screen only when the emulator is what is shown: with a view open the layout is hidden, so
  // focusing the canvas would fail and take the view's own focus away with it (the Library focuses its heading).
  // `focus: false` when something else took the card away (a menu, a view): focus is that thing's, and moving it to
  // the screen would take it from the menu's button (Esc would no longer close the menu).
  function close({ focus = true } = {}) {
    card.hidden = true;
    setRoom(0);
    if (focus && !viewOpen()) page.focus();
  }
  // A menu or a view took the card's place: that is no answer. The offer is owed again (pending, the visit's showing
  // unspent, nothing stored), and the pending retry brings it back once the menu or view has closed. The Menu item's
  // own card just goes: the user asked for it, and owes nothing.
  function yieldTo() {
    const wasOffer = !offeredByMenu;
    close({ focus: false });
    if (wasOffer) { pending = true; shownThisVisit = false; }
  }

  // Where the card sits. The stylesheet floats it; this decides whether, at this window, there is a place for it that
  // covers none of what the user must see or press, and says which place that was.
  //
  // Measure, don't compute: each candidate is a class the stylesheet knows, applied and then READ — the real box after
  // the class is on. No arithmetic about insets or expected sizes, so a stylesheet change cannot leave these numbers
  // stale (which is how the gutter came to do nothing above 500 px).
  // Every visible on-screen key is one (letters, BREAK, CLEAR, Menu, the Keys|Pad|Stick switch, the stick and FIRE,
  // the panel's own menu, and ⌨ after Hide keys), in every layout: the card never sits over something the user presses. (The machine menu
  // is not here: a menu opening takes the card away — onMenu below — and the card waits while one is open.)
  const OBSTACLES = () => [$('screen'), $('btnReset'), ...document.querySelectorAll('.controls'), ...document.querySelectorAll('#appbar > *'),
    ...document.querySelectorAll('#touchKeys button, #touchStick, #tkMenuSheet, #btnShowKeys')]
    .filter((e) => e && e.checkVisibility({ visibilityProperty: true }));
  const hit = (a, b) => !!a && !!b && !!b.width && !!a.width
    && !(a.bottom <= b.top || a.top >= b.bottom || a.right <= b.left || a.left >= b.right);
  // in the window less a phone's notch and home indicator (safeArea)
  const inWindow = (r) => { const a = safeArea(); return r.left >= a.left && r.top >= a.top && r.right <= a.right && r.bottom <= a.bottom; };
  const clears = (r) => inWindow(r) && !OBSTACLES().some((e) => hit(r, e.getBoundingClientRect()));
  // the strip in the room made for it lies under the monitor's bezel: that box, laid out at once, stands for the
  // screen, whose canvas takes its new size a frame later (js/ui/screen.js)
  const clearsUnder = (r) => inWindow(r) && r.top >= $('monitor').getBoundingClientRect().bottom - 0.5
    && !OBSTACLES().some((e) => e !== $('screen') && hit(r, e.getBoundingClientRect()));
  const rectOf = () => { const r = card.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height }; };
  // The corner's lift: as far as the screen and machine controls need, so the first candidate has its best chance.
  // Never so far that the card leaves the window or reaches the app bar: those buttons (Open…, Ask Claude, Menu —
  // Menu holds Install itself) are what the user must be able to press, so the lift stops under them. A card that
  // still overlaps the screen after that is one the user explicitly asked for (the Menu item) at a size with no
  // clear place; the bar is never the thing it covers.
  function liftClear() {
    const r = rectOf();
    let up = 0;
    for (const e of [$('screen'), $('btnReset'), ...document.querySelectorAll('.controls')]) {
      const o = e && e.getBoundingClientRect();
      if (o && o.width && hit(r, o)) up = Math.max(up, r.bottom - o.top + 8);
    }
    // The app bar's bottom edge (its deepest control: the bar wraps at some widths). A lift may not cross it, nor
    // the window's top: one subtraction gives the exact remainder, since both bounds move with the lift 1:1.
    const bar = [...document.querySelectorAll('#appbar, #appbar > *')].map((e) => e.getBoundingClientRect())
      .filter((o) => o.width && o.height);
    const floor = bar.length ? Math.max(...bar.map((o) => o.bottom)) : 0;
    card.style.setProperty('--install-lift', `${Math.round(up)}px`);
    const over = Math.max(safeArea().top - rectOf().top, floor + 8 - rectOf().top);
    if (over > 0) card.style.setProperty('--install-lift', `${Math.round(Math.max(0, up - over))}px`);
  }
  // Where the card can go at this size -> { rect, where } or null when no candidate is clear.
  let placements = 0;   // how many times a place was worked out (the browser check's per-frame test reads it)
  const PLACES = ['gutter', 'gutter-left', 'strip', 'by-bar'];
  // The strip's room: a phone held upright fits its screen and keys to the window with no band between them
  // (play/index.html, "a phone held upright"), so the strip asks for one: --install-room shrinks the screen by that
  // much and leaves it as a gap under it, the keys where they were; the strip goes under the monitor's bezel (its box
  // is laid out at once, where the canvas inside is resized a frame later). Elsewhere the variable changes nothing.
  let room = 0;
  const setRoom = (px) => { if (px !== room) { room = px; document.documentElement.style.setProperty('--install-room', `${px}px`); } };
  function place() {
    // the strip in the room it already has: kept as it is when still clear (no resize, so no re-placing loop)
    if (room && !card.hidden) {
      card.classList.remove('gutter', 'gutter-left'); card.classList.add('strip');
      card.style.setProperty('--install-lift', '0px');
      card.style.setProperty('--install-top', `${Math.round($('monitor').getBoundingClientRect().bottom + 6)}px`);
      if (clearsUnder(rectOf())) { placements++; return { rect: rectOf(), where: 'strip' }; }
    }
    setRoom(0);
    card.classList.remove(...PLACES);
    card.style.setProperty('--install-lift', '0px');
    if (!card.getBoundingClientRect().width) return null;   // not laid out: not measurable, so not a place
    placements++;
    liftClear();
    const cornerLift = card.style.getPropertyValue('--install-lift');
    // Each candidate is a class the stylesheet knows: applied, then the real box read back. First the corner as
    // styled (lifted clear of the screen and controls), then the gutter beside the screen on the side with room,
    // then the one-line strip under the screen (a phone held upright: the band above its keyboard). The strip's top
    // is the screen's measured bottom; whether its box then clears the keys is read back like the rest.
    const s = $('screen').getBoundingClientRect();
    card.style.setProperty('--install-top', `${Math.round(s.bottom + 6)}px`);
    const at = (cls) => {
      card.classList.remove(...PLACES);
      card.style.setProperty('--install-lift', cls ? '0px' : cornerLift);
      if (cls) card.classList.add(cls);
      return clears(rectOf()) ? { rect: rectOf(), where: cls === 'strip' ? 'strip' : cls ? 'gutter' : 'corner' } : null;
    };
    const area = safeArea();
    // the strip with room made for it: the card's height, read with the strip class on, plus its 6 px either side
    const roomy = () => {
      card.classList.remove(...PLACES); card.classList.add('strip'); card.style.setProperty('--install-lift', '0px');
      // (a multiple of 3: the monitor narrows by 4/3 of it, a whole number of pixels, so its height drops by exactly it)
      setRoom(Math.ceil((card.getBoundingClientRect().height + 12) / 3) * 3);
      card.style.setProperty('--install-top', `${Math.round($('monitor').getBoundingClientRect().bottom + 6)}px`);
      const r = clearsUnder(rectOf()) ? { rect: rectOf(), where: 'strip' } : null;
      if (!r) setRoom(0);
      return r;
    };
    const spot = at(null)
      || (s.right + 12 <= area.right ? at('gutter') : null)
      || (s.left - area.left >= 12 ? at('gutter-left') : null)
      || (s.width ? at('strip') : null)
      || (s.width && document.body.classList.contains('touch-keys') ? roomy() : null);
    // no candidate: leave the card where the corner rule puts it, LIFTED (a Menu card stays up there, and the lift is
    // what keeps it off the screen and controls — dropping it would put the card over the emulated picture)
    if (!spot) { card.classList.remove(...PLACES); card.style.setProperty('--install-lift', cornerLift); }
    return spot;
  }
  // The Install CLOADM… link's own card: under the app bar, at the link's side, whatever it covers (see place() for the
  // offer, which keeps off the screen and the controls). The user asked for it, and a link in the bar is where they look.
  function placeByBar() {
    setRoom(0);
    card.classList.remove(...PLACES); card.classList.add('by-bar');
    card.style.setProperty('--install-lift', '0px');
    card.style.setProperty('--install-bar-top', `${Math.round($('appbar').getBoundingClientRect().bottom + 6)}px`);
    return { rect: rectOf(), where: 'bar' };
  }
  // No place at this size: put the card away, but the deferral does not spend the visit's one showing — the offer is
  // still owed, and a resize (or retryPending) tries again when there is room. The Menu's own card is never deferred:
  // the user asked for it.
  function defer() {
    card.hidden = true;
    setRoom(0);
    pending = true; shownThisVisit = false;
  }
  // A size change: re-place the card that is up (or defer it if it no longer fits), or give a deferred offer its
  // chance at once (`force`: not held back by the once-a-second throttle). The Menu's own card stays up: the user
  // asked for it, and defer() would owe an offer the user never got.
  const replant = (force) => {
    if (card.hidden) { retryPending(retryNow(), force); return; }
    if (offeredByMenu) placeByBar();
    else if (place() === null) defer();
  };
  // ... measured once the layout has settled. A resize is followed by more layout: the screen's canvas is sized from
  // the frame loop after the area's ResizeObserver has run (js/ui/screen.js), so a card placed in the resize event
  // itself was placed against the old screen (1024x600 -> 900x480 left it over the new one). Two animation frames
  // later the screen has its new size; a ResizeObserver on the screen, the controls and the keys catches any later
  // change of theirs (a font arriving, the keyboard shown or hidden). Scrolling moves the screen under a fixed card
  // too (a phone's page scrolls), so it re-places the card that is up the same way, without forcing a retry.
  let settling = 0, settleForce = false;
  const settle = (force) => {
    settleForce = settleForce || force;
    if (settling) return;
    settling = requestAnimationFrame(() => { settling = requestAnimationFrame(() => {
      settling = 0; const f = settleForce; settleForce = false; replant(f);
    }); });
  };
  addEventListener('resize', () => settle(true));
  addEventListener('orientationchange', () => settle(true));
  addEventListener('scroll', () => { if (!card.hidden) settle(false); }, { passive: true });
  {
    const ro = new ResizeObserver(() => settle(true));
    for (const e of [$('screen'), $('touchKeys'), ...document.querySelectorAll('.controls')]) if (e) ro.observe(e);
  }
  // A pending offer (deferred for want of room) is retried at most once a second, and a card that is up is checked
  // at most once a second (the frame hook below): the size may change without any event this module hears (an
  // embed's parent, a zoom), and this is far cheaper than re-placing on every frame. The throttles' clock can be
  // held by the browser check (holdRetryClock), so a test can tell the forced path from the throttled one.
  let retryAt = 0, checkAt = 0, retryHeld = false;
  const retryNow = () => (retryHeld ? Math.max(retryAt, checkAt) : Date.now());
  function retryPending(now, force = false) {
    if (!pending || !card.hidden || installed || shownThisVisit) return;
    if (!force && now - retryAt < 1000) return;
    retryAt = now;
    if (cardShows({
      installed, embed: document.body.classList.contains('embed'), storageUnavailable,
      answer, now: Date.now(), prompt: deferred, ios, view: viewOpen(), chatFull: session.claudeView === 'full',
      otherCard: otherCard(), menuOpen: menuOpen(), toast: !!page.feedback.current,
      programRunning: programRunning(), welcomeRunning: session.welcomeRunning, visitSeconds: clock.seconds(), phone: touchPhone(),
    }) && show('offer')) shownThisVisit = true;
  }
  // A view (Library, Share, Add ROMs, Debugger) takes the page: the card would be hidden under it with the layout, so
  // it closes rather than linger invisible.
  page.onView(() => { if (viewOpen() && !card.hidden) yieldTo(); });
  // A menu opening over the card: the machine menu (which holds this item) or the phone's nav. The card is an offer
  // over the emulator, never over a menu the user is reading, so it goes — the menu is what the user asked for, and
  // the card is above it (z-index 61 against 20), so left up it would cover the menu's own rows.
  // Focus stays where the user put it (on the menu's button, so Esc closes the menu), and the offer is owed again.
  const onMenu = () => { if (!card.hidden && menuOpen()) yieldTo(); };
  $('machineBtn').addEventListener('click', onMenu);
  $('btnMenu').addEventListener('click', onMenu);
  // A toast at the same time: nothing to do here. js/ui/feedback.js places the toast each frame and keeps it off
  // #installOffer (it is in its CONTROLS list), so the two never overlap; the card therefore never moves for a toast.

  // ---- the answers ----
  async function runPrompt() {
    const p = deferred;
    deferred = null;               // the browser's prompt is good for one call
    if (!p) return;
    try {
      p.prompt();
      const choice = await p.userChoice;
      // dismissed: the offers wait 14 days again, but this is not the card's "Not now" (its two-offer budget is not
      // spent by a dialog the browser showed)
      if (!choice || choice.outcome !== 'accepted') save(afterDismissed(answer, Date.now()));
    } catch (e) { page.status(`Install: ${e.message}`, true); }
  }
  // [Install]: Chromium's own prompt. [Got it] (iOS, and a browser with no event): the same as "Not now", so the
  // offer waits its 14 days; from the Menu item, it just closes.
  go.onclick = () => {
    close();
    if (deferred) return runPrompt();
    if (!offeredByMenu) save(afterNotNow(answer, Date.now()));
  };
  notNow.onclick = () => { save(afterNotNow(answer, Date.now())); close(); };
  never.onclick = () => { save({ no: true }); close(); };
  // Esc on the card, or anywhere off the screen, is "Not now" (iOS: "Got it", its answer). The automatic offer is
  // ESC.offer, a rank the screen's Esc never reaches: someone typing at the machine who presses Esc means the
  // machine's BREAK, and an offer they did not ask for must neither swallow that key nor spend a "Not now" on it.
  // The Menu item's own card (the user opened it) is an ordinary card, ESC.card: Esc closes it from anywhere, and
  // that answers nothing.
  page.onEscape(ESC.offer, () => !card.hidden && !viewOpen() && !offeredByMenu, () => {
    if (!notNow.hidden) notNow.click();
    else go.click();                     // "Got it" (iOS, no event): the same as "Not now"
  });
  page.onEscape(ESC.card, () => !card.hidden && !viewOpen() && offeredByMenu, () => close());
  if (menuItem) menuItem.onclick = (e) => {
    e.preventDefault();
    closeMenu();                                    // (the phone's nav it sits in, and the machine menu)
    if (installed) return;
    pending = false;                                                         // (the user asked: nothing is owed now)
    if (deferred) { shownThisVisit = true; close(); runPrompt(); return; }   // Chromium: the browser's own dialog
    shownThisVisit = true;
    show('menu');                                                            // iOS and the rest: the steps
  };

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferred = e;
  });
  window.addEventListener('appinstalled', () => {
    installed = true;
    deferred = null;
    save({ no: true });
    if (!card.hidden) close();
    if (menuItem) menuItem.hidden = true;
    page.status('Installed. Open CLOADM from your home screen or apps.');
  });
  if (menuItem) menuItem.hidden = installed;

  // A tab in the background runs no frames (page.tickUi is skipped while document.hidden), so the clock must settle
  // there: otherwise a program "runs" for every minute the user is away and the 60 s is met without it running.
  document.addEventListener('visibilitychange', () => { if (document.hidden) clock.set(false); });
  // A program is in use: not the welcome menu, not the stub's bare prompt, not a paused or debugger-stopped machine.
  // BASIC at its prompt counts (it is the machine the user came for), and so do a tape in the deck and a disk in a
  // drive: the brief lists "LIZA, a binary, a tape, a disk, or BASIC with ROMs", and a tape or disk is something to
  // come back to even before it has been read.
  function programRunning() {
    // ONE machine throughout: the person's (the getters below - welcomeRunning, nitros9Running - are person-framed,
    // so asking this.machine for the deck and the drives mixed the two, review 0.1.9 round 2)
    const m = session.personMachine;
    // nothing has run before the visit's own program has started: the first frame or two are the page setting up
    if (!m || !started() || session.paused || document.body.classList.contains('paused')) return false;
    if (session.welcomeRunning) return false;
    if (session.nitros9Running) return true;   // the person's machine (as the getter now says)
    if (m.deck && m.deck.tape) return true;                                  // a tape in the deck
    if (m.diskController && session.diskStatus().drives.length) return true;  // a disk in a drive (only when one is fitted)
    return !m.atStubPrompt();
  }
  // A menu is open: the machine menu (where the item lives) or the phone's nav (which shows the same links). The card
  // is an offer over the emulator, never over a menu the user has open.
  const menuOpen = () => !$('machineMenu').hidden || $('appbar').classList.contains('menu-open');
  // Another card is up. #attention and #switchConfirm are surfaces the user must read too: the card waits for them.
  function otherCard() {
    return ['welcome', 'mediaOffer', 'lizaOffer', 'snapNeeds', 'bootHelp', 'switchConfirm', 'attention']
      .some((id) => { const e = $(id); return e && !e.hidden; });
  }
  // The offer's turn: asked once per frame the page already runs (no timer of its own).
  page.onFrame(() => {
    clock.set(programRunning());
    const now = retryNow();
    // the card that is up, checked at most once a second against what it must not cover (a layout can change under
    // it with no event this module hears): still clear, or re-placed, or deferred unspent
    if (!card.hidden && now - checkAt >= 1000) {
      checkAt = now;
      if (!clears(rectOf())) replant(false);
    }
    // nothing can be offered until a program has run its minute, and never again this visit: the common frame
    // costs one clock read and this test, and no DOM query (the offer is a one-in-a-visit moment)
    retryPending(now);
    // pending: retryPending() above owns the card this frame (it is rate-limited); re-deciding here would place it
    // on every frame
    if (shownThisVisit || pending || installed || !card.hidden || clock.seconds() < RUN_SECONDS) return true;
    if (cardShows({
      installed, embed: document.body.classList.contains('embed'), storageUnavailable,
      answer, now: Date.now(), prompt: deferred, ios, view: viewOpen(), chatFull: session.claudeView === 'full',
      otherCard: otherCard(), menuOpen: menuOpen(), toast: !!page.feedback.current,
      programRunning: programRunning(), welcomeRunning: session.welcomeRunning, visitSeconds: clock.seconds(), phone: touchPhone(),
    })) {
      // shownThisVisit is spent only when the card really appears: a size with no room defers it, and the offer stays
      // pending for this visit (retryPending above tries again, at most once a second, or at once on a resize)
      if (show('offer')) shownThisVisit = true;
    }
    return true;
  });
  return { clock, get installed() { return installed; }, platform, answer: () => answer, get prompt() { return deferred; },
    // for tools/browser-check.js: hold the once-a-second throttles' clock still (true), so only a forced retry (a
    // resize, a settled layout) can bring a deferred offer; false lets it run again
    holdRetryClock(on) { retryHeld = !!on; },
    // the conditions as the frame loop sees them, for the browser check (it does not re-decide anything)
    state: () => ({
      programRunning: programRunning(), welcomeRunning: session.welcomeRunning, visitSeconds: clock.seconds(),
      view: viewOpen(), chatFull: session.claudeView === 'full', otherCard: otherCard(),
      menuOpen: menuOpen(), toast: !!page.feedback.current,
      embed: document.body.classList.contains('embed'), installed, ios, prompt: !!deferred, storageUnavailable, answer,
      // what the placement decided for the card as it is now (for the browser check): where, and which of the things
      // it must keep clear of it would cover
      placement: () => {
        const r = rectOf();
        if (!r.width) return { where: 'unmeasured', rect: null, covered: [] };
        return { where: card.classList.contains('by-bar') ? 'bar' : card.classList.contains('strip') ? 'strip' : card.classList.contains('gutter') || card.classList.contains('gutter-left') ? 'gutter' : 'corner',
          rect: [Math.round(r.left), Math.round(r.top), Math.round(r.right), Math.round(r.bottom)],
          covered: OBSTACLES().filter((e) => hit(r, e.getBoundingClientRect())).map((e) => e.id || e.className || e.tagName) };
      },
      pending,
      // the app bar's own controls must be among the things the card keeps clear of: the browser check names a few
      obstacles: () => OBSTACLES().map((e) => e.id || e.className || e.tagName),
      placements: () => placements,
    }) };
}
