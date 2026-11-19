// Run: node tests/install.test.js
// The install offer's rules (js/ui/install.js), without a browser: what each answer means, who may be offered, when
// the card may appear, how long a program must have run, and how the steps read per browser. The page part is
// exercised in tools/browser-check.js (installChecks); this pins the decisions it makes.
const Emu = require('./load')();

let fail = 0;
const check = (n, c, d = '') => { if (!c) { fail++; console.log('FAIL', n, d); } else console.log('ok  ', n, d); };
const DAY = 24 * 60 * 60 * 1000;
const copyOf = (v) => JSON.parse(JSON.stringify(v));   // (a stored answer is read back from storage: a fresh object)

(async () => {
  const I = await import('../js/ui/install.js');

  // ---- what is stored ----
  check('nothing stored: ask as usual', I.readAnswer(null) === null && I.readAnswer('') === null);
  check('a stored answer we cannot read is no answer (the user never said no to it)',
    I.readAnswer('{') === null && I.readAnswer('[]') === null && I.readAnswer('"no"') === null && I.readAnswer('{"until":"soon"}') === null);
  check('a stored "don\'t ask again"', I.readAnswer('{"no":true}').no === true);
  check('a stored "not now" keeps its date and its mark', I.readAnswer(`{"until":${5 * DAY},"n":1}`).until === 5 * DAY
    && I.readAnswer(`{"until":${5 * DAY},"n":1}`).n === 1);
  check('a stored dismissed-dialog wait has a date but no "Not now" mark', I.readAnswer(`{"until":${5 * DAY}}`).until === 5 * DAY
    && I.readAnswer(`{"until":${5 * DAY}}`).n === undefined);

  // ---- "Not now" ----
  const t0 = 1_000_000_000_000;
  const first = I.afterNotNow(null, t0);
  check('the first "Not now" waits 14 days and is marked as the card\'s own answer', first.until === t0 + 14 * DAY && !first.no && first.n === 1);
  check('a second "Not now" ends the automatic offers', I.afterNotNow(first, t0 + 3 * DAY).no === true);
  check('a "Not now" given after the 14 days ended is still the second: it ends the offers', I.afterNotNow(first, t0 + 15 * DAY).no === true);
  check('a stored "don\'t ask again" stays answered "never"', I.afterNotNow({ no: true }, t0).no === true);

  // ---- a dismissed browser dialog is its own wait, not a "Not now" ----
  // from no answer at all: a dialog dismissed before anything was said
  const dismissedOnly = I.afterDismissed(null, t0);
  check('a dismissed dialog waits 14 days', dismissedOnly.until === t0 + 14 * DAY);
  check('a dismissed dialog does not spend the "Not now" budget: a dismissal then a "Not now" is still the first',
    !I.afterNotNow(copyOf(dismissedOnly), t0).no);
  // after a real "Not now", a dismissal keeps that one answer and just moves the wait
  check('a dismissed dialog after a "Not now" moves the wait and keeps the "Not now" mark',
    I.afterDismissed(first, t0 + DAY).until === t0 + DAY + 14 * DAY && I.afterNotNow(first, t0 + DAY).no === true);
  check('"don\'t ask again" is not undone by a dismissed dialog', I.afterDismissed({ no: true }, t0).no === true);

  // ---- may the offer be made at all ----
  check('no answer: yes', I.mayOffer(null, t0));
  check('14 days are not yet up: no', !I.mayOffer(first, t0 + 14 * DAY - 1));
  check('14 days up: yes', I.mayOffer(first, t0 + 14 * DAY));
  check('after a second "Not now": never, however long', !I.mayOffer({ no: true }, t0 + 3650 * DAY));

  // ---- installed, and who has an install event ----
  const win = (o) => ({ navigator: Object.assign({ userAgent: '', maxTouchPoints: 0 }, o.nav), matchMedia: o.mm });
  check('installed: the standalone display mode', I.isInstalled(win({ mm: () => ({ matches: true }), nav: {} })));
  check('installed: iOS Safari\'s own flag', I.isInstalled({ navigator: { standalone: true }, matchMedia: null }));
  check('not installed: a browser tab', !I.isInstalled(win({ mm: () => ({ matches: false }), nav: {} })));
  check('iOS: an iPhone', I.isIos(win({ nav: { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15' } })));
  check('iOS: an iPad that calls itself a Mac (touch points say otherwise)', I.isIos(win({ nav: { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', maxTouchPoints: 5 } })));
  check('not iOS: a desktop Mac (no touch points)', !I.isIos(win({ nav: { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', maxTouchPoints: 0 } })));
  check('not iOS: Chrome on Windows', !I.isIos(win({ nav: { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120' } })));

  // ---- the card's conditions, one at a time ----
  const ok = { installed: false, embed: false, storageUnavailable: false, answer: null, now: t0, prompt: {}, ios: false,
    view: false, chatFull: false, otherCard: false, menuOpen: false, toast: false, programRunning: true, welcomeRunning: false, visitSeconds: 60 };
  check('every condition met: the card shows', I.cardShows(ok));
  for (const [k, v] of [['installed', true], ['embed', true], ['storageUnavailable', true], ['view', true], ['chatFull', true],
    ['otherCard', true], ['menuOpen', true], ['toast', true], ['welcomeRunning', true], ['programRunning', false]]) {
    check(`no card with ${k}`, !I.cardShows({ ...ok, [k]: v }));
  }
  check('no card without a prompt, unless it is iOS', !I.cardShows({ ...ok, prompt: null }) && I.cardShows({ ...ok, prompt: null, ios: true }));
  check('no card under 60 s, and a card at exactly 60 s', !I.cardShows({ ...ok, visitSeconds: 59.9 }) && I.cardShows({ ...ok, visitSeconds: 60 }));
  check('no card after "don\'t ask again"', !I.cardShows({ ...ok, answer: { no: true } }));
  check('no card within 14 days of "Not now"', !I.cardShows({ ...ok, answer: { until: t0 + DAY }, now: t0 }));

  // ---- how long a program has run ----
  let clockNow = t0;
  const clock = I.createRunClock(() => clockNow);
  clock.set(false);
  clockNow = t0 + 500_000;
  check('no program: nothing counts, however long the page is open', clock.seconds() === 0);
  clock.set(true);
  clockNow = t0 + 530_000;
  check('a program running counts its seconds', clock.seconds() === 30);
  clock.set(false);
  clockNow = t0 + 600_000;
  check('the count stops when the program does', clock.seconds() === 30);
  clock.set(true);
  clockNow = t0 + 630_000;
  check('and starts again with the next one', clock.seconds() === 60);

  // ---- the steps ----
  for (const p of ['chromium', 'desktopOther', 'android', 'samsung', 'firefoxAndroid', 'ios']) {
    check(`the steps for ${p} say what to do`, typeof I.STEPS[p] === 'string' && I.STEPS[p].length > 20);
  }
  check('the iOS steps are Share, then Add to Home Screen', /Share/.test(I.STEPS.ios) && /Add to Home Screen/.test(I.STEPS.ios));
  check('names the browsers the brief lists: Chrome/Edge desktop, Android Chrome, Samsung, Firefox Android, iOS Safari',
    /Chrome or Edge/.test(I.STEPS.chromium) && /Chrome/.test(I.STEPS.android) && /☰/.test(I.STEPS.samsung) && /Firefox/.test(I.STEPS.firefoxAndroid));
  // platformOf: every browser to its own steps, from the user agent alone (plus "this is iOS")
  const UA = {
    chrome: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
    edge: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36 Edg/120.0',
    firefoxDesktop: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:120.0) Gecko/20100101 Firefox/120.0',
    safariDesktop: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
    chromeAndroid: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36',
    samsung: 'Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/23.0 Chrome/115.0 Mobile Safari/537.36',
    firefoxAndroid: 'Mozilla/5.0 (Android 14; Mobile; rv:120.0) Gecko/120.0 Firefox/120.0',
    iphoneSafari: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    iphoneChrome: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/120.0 Mobile/15E148 Safari/604.1',
  };
  for (const [what, ua, ios, want] of [
    ['Chrome on Windows', UA.chrome, false, 'chromium'],
    ['Edge on Windows (Chrome in its UA)', UA.edge, false, 'chromium'],
    ['Firefox on Windows', UA.firefoxDesktop, false, 'desktopOther'],
    ['Safari on macOS', UA.safariDesktop, false, 'desktopOther'],
    ['Chrome on Android', UA.chromeAndroid, false, 'android'],
    ['Samsung Internet', UA.samsung, false, 'samsung'],
    ['Firefox on Android', UA.firefoxAndroid, false, 'firefoxAndroid'],
    ['Safari on an iPhone', UA.iphoneSafari, true, 'ios'],
    ['Chrome on an iPhone (the Share sheet, as Safari)', UA.iphoneChrome, true, 'ios'],
  ]) check(`platform: ${what} → ${want}`, I.platformOf(ua, ios) === want, I.platformOf(ua, ios));
  check('platform: each browser has steps of its own', new Set(Object.keys(I.STEPS).map((k) => I.STEPS[k])).size === Object.keys(I.STEPS).length);

  console.log(fail ? `${fail} FAILED` : 'all passed');
  process.exitCode = fail ? 1 : 0;
})();
