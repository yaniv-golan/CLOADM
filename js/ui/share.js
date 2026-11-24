/*
 * The Share screen: a view of /play/ at #share, like the Library. The app bar's Share button captures the moment (the
 * snapshot and the picture at that instant) and opens it. Its one job: send this exact moment to someone.
 *
 * Top: the picture as a link preview, one line saying what the link does (the snapshot's clarity copy), a ROM line (what
 * the person opening it must add, or that it runs without ROMs: the snapshot holds no byte of a ROM or cartridge,
 * Session.shareFile names them), then ONE primary link, [Copy link] (+ [Share…]) (the "one link" layout):
 *  - a bundled program nobody has touched since it started (Session.untouchedBundledProgram) has nothing of its own to
 *    share yet: the primary gives its program page (/2048/ etc.), and nothing is uploaded;
 *  - otherwise the primary makes the short link on the tap (Session.shortLink: sealed in this browser, stored on
 *    s.cloadm.dev, js/host/link-store.js, its key only in the link's fragment), copies it, shows the field with a QR
 *    toggle, and toasts "Short link copied"; "Show a preview picture (public)" is on by default;
 *  - a bundled program that HAS been played keeps the short-link primary, and "More ways to share" offers "Link to
 *    <program> from the start" (its program page).
 * Where the short link can't be made (offline, a moment on ROMs, a cartridge, NitrOS-9, the server's kill switch:
 * Session.shortLinkRefusal, or the store refusing) the same tap copies the LONG link and the note says why. "Always use
 * long links" (this browser, localStorage) makes every tap copy the long one. A clipboard write that rejects leaves the
 * field selected with a press-Ctrl/⌘+C note: Copy never leaves the person with nothing.
 * "More ways to share" (collapsed): the long link, "Long link (works offline; nothing is uploaded)" with its field,
 * Copy and the "Always use long links" switch; then a 6-second clip of the screen (MediaRecorder: MP4 where the browser
 * records it, WebM otherwise, and the button says which), the screenshot at true pixels, the snapshot file.
 * "Embed in a web page" (collapsed): the iframe and script for a blog post, written by js/config.js (buildUrl) from the
 * machine, program and options chosen here ("Offer 'Ask Claude ↗'" adds askclaude=1: the embed's corner chip).
 * (The settings export/import lives on the Machine tab: js/ui/settings-file.js.)
 */
import { profiles } from '../machines/profiles.js';
import { buildUrl } from '../config.js';
import { needsLine } from '../media/romrefs.js';
import { CanvasPresenter } from '../video/canvas.js';
import { qrEncode } from '../media/qr.js';
import { $, showView } from './page.js';

// when the moment was captured, said relative to now: "captured just now", then minutes, hours or days ago (the card
// under the picture; refreshed while the Share screen is open)
export function capturedAgo(then, now = Date.now()) {
  const s = Math.max(0, Math.floor((now - then) / 1000));
  const n = (k, unit) => `captured ${k} ${unit}${k === 1 ? '' : 's'} ago`;
  if (s < 60) return 'captured just now';
  if (s < 3600) return n(Math.floor(s / 60), 'minute');
  if (s < 86400) return n(Math.floor(s / 3600), 'hour');
  return n(Math.floor(s / 86400), 'day');
}
const AGO_MS = 15000;   // how often the card's time is said again while the screen is open
const CLIP_SECONDS = 6;
// what the browser can record, best first
const clipType = () => {
  if (typeof MediaRecorder === 'undefined') return null;
  for (const [type, ext, label] of [['video/mp4;codecs=avc1', 'mp4', 'MP4'], ['video/mp4', 'mp4', 'MP4'], ['video/webm;codecs=vp9', 'webm', 'WebM'], ['video/webm', 'webm', 'WebM']]) {
    if (MediaRecorder.isTypeSupported(type)) return { type, ext, label };
  }
  return null;
};

// the delete tokens of the short links made in this browser: { id: token }
const TOKENS = 'cloadm.shortLinks';
const tokens = () => { try { return JSON.parse(localStorage.getItem(TOKENS) || '{}') || {}; } catch (e) { return {}; } };
const keepToken = (id, token) => { try { const t = tokens(); if (token) t[id] = token; else delete t[id]; localStorage.setItem(TOKENS, JSON.stringify(t)); } catch (e) { /* no storage: no Delete later */ } };

export function setupShare(page, { linkStore }) {
  const { session } = page;
  const view = $('share');
  let started = false;   // the visit has started (ready()): until then there is no machine to capture
  let captured = null;   // { file: { name, bytes } | null, png: Blob, link | null, base: file name without extension }

  // ---------------- the view (#share) ----------------
  const isOpen = () => location.hash === '#share';
  function show() {
    const open = isOpen();
    document.body.classList.toggle('share-open', open);
    showView(view, open);
    // opened by address (play/#share) the page is still starting: the view shows, and ready() captures once there is a machine
    if (open && !captured && started) capture().catch((e) => page.status(e.message, true));
    if (open && captured) $('shareWhen').textContent = capturedAgo(captured.at);   // the time said again, now
    if (open) window.scrollTo(0, 0);
  }
  page.onView(show);
  setInterval(() => { if (captured && isOpen()) $('shareWhen').textContent = capturedAgo(captured.at); }, AGO_MS);
  $('shareBack').onclick = (e) => { e.preventDefault(); page.closeView(); };
  $('btnShare').onclick = async () => {
    try { await capture(); } catch (e) { page.status(e.message, true); return; }
    page.openView('#share');
  };

  // a closed disclosure's body is `hidden` for real (not only folded by <details>), so a reading mode and assistive
  // technology see what the screen shows
  for (const d of view.querySelectorAll('details.disc')) {
    const body = d.querySelector(':scope > :not(summary)');
    d.addEventListener('toggle', () => { body.hidden = !d.open; });
  }

  let fallbackWhy = ''; // a tap that tried the short link and fell back to the long one: why, said under the button
  // the snapshot's clarity copy (fixed wording): what a link opens, and that later changes are not in it. One function,
  // so capture() and the mode switch cannot say it differently.
  const snapshotNote = (machine) => `Opens a copy of this ${machine} exactly as it is now: the screen, the program and everything in memory, including anything you typed. Changes you make later aren't in it.`;

  // ---------------- share this moment ----------------
  async function capture() {
    const m = session.shownMachine, frame = m.render();
    const name = m.profile.name.replace(/^Tandy /, '');
    // the picture at true pixels, captured with the snapshot so both show the same instant
    const c = document.createElement('canvas');
    new CanvasPresenter(c).present(frame);
    // the shared snapshot: no byte of a ROM or cartridge, only their names (Session.shareFile, AGENTS rule 1).
    // NitrOS-9's memory is the user's own NitrOS-9: its link boots NitrOS-9 from the recipient's image instead.
    // The SHOWN machine's NitrOS-9, not the person's: the picture above is the shown machine's and shareUrl builds the
    // link for it, so with the chat full screen this must ask about the chat, as shareUrl does.
    const n9 = session.nitros9OnScreen;
    // A moment a guardrail forbids encoding at all (Session.shareFile refusing): the view still opens, so the person
    // sees why, with Copy dark. NitrOS-9 is not that: its link boots NitrOS-9 from the recipient's own image.
    let file = null, refusal = '';
    if (!n9) { try { file = await session.shareFile(); } catch (e) { refusal = e.message; } }
    const link = refusal ? '' : n9 ? session.shareUrl(location.href) : await session.snapshotLink(location.href, file);
    const png = await new Promise((ok) => c.toBlob(ok, 'image/png'));
    // the bundled program, when it is one nobody has touched: its own page is the primary link (nothing is uploaded)
    const untouched = n9 || refusal ? null : session.untouchedBundledProgram(location.href);
    captured = { at: Date.now(), file, png, link, untouched, refusal, machine: name, base: file ? file.name.replace(/\.cloadm$/, '') : `${m.profile.name.replace(/[^A-Za-z0-9]+/g, '')}-${n9 ? 'NitrOS-9' : 'moment'}` };
    const dl = $('btnShareDownload');
    dl.disabled = !file;
    dl.textContent = file ? `Download snapshot (${(file.bytes.length / 1024).toFixed(0)} KB)` : 'Download snapshot';
    const pic = $('sharePicture');
    pic.width = c.width; pic.height = c.height;
    pic.getContext('2d').drawImage(c, 0, 0);
    $('shareWhen').textContent = capturedAgo(captured.at);
    $('shareLink').value = link;
    short = null; fallbackWhy = '';
    $('shortMade').hidden = true; $('shareShort').value = ''; $('sharePreview').disabled = false;
    syncLongNote();   // (it calls syncPrimary())
    // one line under the picture, what the link does; then, only as needed, what the person opening it needs
    const rom = $('shareRom'), extra = $('shareExtra');
    rom.textContent = ''; rom.classList.remove('warn'); extra.textContent = '';
    const note = (text) => { const p = document.createElement('p'); p.textContent = text; extra.append(p); };
    if (refusal) {
      // nothing to encode: the reason is said ONCE, inline under Copy (syncPrimary's #primaryWhy, in the guardrail's
      // own words), and Copy stays dark. #shareNote is syncPrimary's, and holds nothing here.
      $('shortTerms').hidden = true; $('previewSwitch').hidden = true;
      syncEmbed(m.id);
      return;
    }
    if (!file) {
      note('They need their own NitrOS-9 DriveWire image in their library: the link boots NitrOS-9 on the CoCo 3 from it, and holds no part of yours.');
      syncEmbed(m.id);
      return;
    }
    // (the line under the picture is syncPrimary's: called just above through syncLongNote, it sets the snapshot's
    // clarity copy, or, for an untouched bundled program, the program-page note. One owner, so the two cannot differ.)
    if (file.needs.length) { rom.textContent = needsLine(file.needs); rom.classList.add('warn'); }
    else rom.textContent = 'Runs without ROMs, so it opens for anyone.';
    // a tape being recorded is not in the link (its pulse timings could carry ROM code: js/media/romrefs.js)
    if (file.dropped.includes('deck.recording')) note('The tape being recorded is not in the link: it opens with the recorder stopped.');
    syncEmbed(m.id);
  }

  // ---------------- the primary link: one link ----------------
  let short = null;     // { url, id, deleteToken } once made for this capture (its field and Delete under the button)
  const ALWAYS_LONG = 'cloadm.alwaysLongLinks';   // this browser: every tap copies the long link
  const alwaysLong = () => { try { return localStorage.getItem(ALWAYS_LONG) === '1'; } catch (e) { return false; } };
  const setAlwaysLong = (on) => { try { if (on) localStorage.setItem(ALWAYS_LONG, '1'); else localStorage.removeItem(ALWAYS_LONG); } catch (e) { /* no storage: for this visit */ } $('shareAlwaysLong').checked = on; };
  const OFFLINE_LONG = "You're offline, so this is the long link: it works without any server.";
  const UNAVAILABLE_LONG = "Short links aren't available right now, so this is the long link: it works without any server.";
  // why the short link can't be made for this capture, or null: the Session's own refusals (ROMs, a cartridge,
  // NitrOS-9: Session.shortLinkRefusal), then the browser's office. 'offline' is its own answer, for the note.
  const shortWhy = () => {
    const own = session.shortLinkRefusal();
    if (own) return own;
    if (!captured || !captured.file) return 'Not for this moment.';
    if (!navigator.onLine) return 'offline';
    return null;
  };
  // what the primary gives now, for this capture: 'program' (an untouched bundled program's page, nothing uploaded),
  // 'long' (the switch, or the short link can't be made), 'short' (made on the tap), or 'none' (nothing captured)
  function primaryMode() {
    if (!captured) return 'none';
    if (captured.untouched) return 'program';
    if (alwaysLong() || fallbackWhy) return 'long';
    return shortWhy() ? 'long' : 'short';
  }
  // Share…: the system sheet, the URL only, where the browser can share it (in an embed only if the frame allows
  // web-share); its URL is what a tap would copy (the program page, the short link once made, else the long link)
  const canNative = () => {
    const url = captured && captured.untouched ? captured.untouched.page : short ? short.url : $('shareLink').value || 'https://cloadm.dev/play/';
    if (typeof navigator.share !== 'function' || !navigator.canShare?.({ url })) return false;
    return !document.body.classList.contains('embed') || document.featurePolicy?.allowsFeature?.('web-share') === true;
  };

  // the long link's own note under "More ways to share": what it holds, or, with the switch on, that taps use it
  function syncLongNote() {
    $('longNote').textContent = alwaysLong() ? 'Long link: nothing is uploaded.' : 'Holds the whole moment in the address; nothing is uploaded.';
    syncPrimary();
  }
  // One note per mode:
  //  - program-page mode: #shareNote (the line under the picture) holds the program-page note; #primaryNote, the
  //    primary's own second line, is empty, so the same thought is not said twice. The note's second sentence promises
  //    the snapshot link, so it comes only when such a link IS in the view: a moment's link exists (captured.link) and
  //    "More ways to share" offers it. Untouched, that is the long link — the moment's link — so it is promised.
  //  - snapshot mode: #shareNote keeps the snapshot's clarity copy (capture() sets it), and #primaryNote says the
  //    always-long note when that switch is what the tap gives.
  // The caption is a prefix plus the name, the prefix its own span so it is never the part that is ellipsised, and the
  // prefix is shown only in snapshot mode: "<program> · <machine>" in program-page mode, as the picture there is that
  // page. " · CLOADM" is gone from every mode (it was the first thing to give way, and the page is CLOADM everywhere).
  function syncPrimary() {
    const mode = primaryMode(), why = mode === 'long' && !alwaysLong() ? shortWhy() : null;
    const native = canNative();
    // a guardrail that leaves nothing to copy at all (Session.shareFile refused the moment: capture() keeps the view
    // open with `refusal` set): Copy goes dark, and the reason is inline. Every guardrail today still leaves the
    // machine's own link (NitrOS-9's boots NitrOS-9 from the recipient's image), so this is the rule kept real.
    const nothingToCopy = !!captured && (!!captured.refusal || (!captured.link && !captured.untouched));
    $('btnShareCopy').disabled = !captured || nothingToCopy;
    $('btnShareCopy').classList.toggle('primary', !native);
    $('btnShareNative').hidden = !native || !captured || nothingToCopy;
    $('btnShareNative').classList.toggle('primary', native);
    const program = mode === 'program' && captured.untouched;
    // the program-page note, said once, in the line under the picture. Its second sentence promises the moment's link,
    // and in this mode that link always exists: a program page is only the primary when nothing was refused, so
    // capture() built the long link (the moment's link, under "More ways to share") for it. Said unconditionally:
    // a "when a link is offered" branch would be dead code.
    if (program) {
      $('shareNote').textContent = `Opens ${captured.untouched.name} from the start, for anyone. The snapshot link below keeps this exact moment.`;
      $('primaryNote').textContent = '';
      $('sharePrefix').hidden = true;
      $('shareName').textContent = `${captured.untouched.name} · ${captured.machine}`;
    } else {
      // the line under the picture, one owner for every capture: a refusal says nothing there (its reason is the
      // inline #primaryWhy, said once); NitrOS-9 says its own sentence; a file says the snapshot's clarity copy
      $('shareNote').textContent = !captured ? '' : captured.refusal ? '' : captured.file ? snapshotNote(captured.machine) : `The link starts NitrOS-9 fresh on the ${captured.machine}; it can't hold this exact moment.`;
      $('primaryNote').textContent = mode === 'long' && alwaysLong() ? 'Long link: nothing is uploaded.' : '';
      $('sharePrefix').hidden = false;
      $('shareName').textContent = captured ? captured.machine : '';
    }
    // a tap that fell back (fallbackWhy) has already made the choice, even though primaryMode said 'short' before it;
    // the reason it fell back is what the person needs to see, not the state before the tap
    $('primaryWhy').textContent = captured && captured.refusal ? captured.refusal : fallbackWhy || (nothingToCopy ? 'This moment can\'t be put in a link.' : why === 'offline' ? OFFLINE_LONG : why && why !== 'Not for this moment.' ? why : '');
    $('shortTerms').hidden = mode !== 'short' || !!fallbackWhy;
    $('previewSwitch').hidden = mode !== 'short' || !!fallbackWhy;
    syncMore();
  }
  // "More ways to share" gains "Link to <program> from the start" when a bundled program that HAS been played is on
  // screen: the primary shares it as a moment, and this offers its page as it was on the program card.
  function syncMore() {
    const p = captured && !captured.untouched ? session.bundledProgram(location.href) : null;
    let item = $('btnShareProgramPage');
    if (!p) { if (item) item.remove(); return; }
    if (!item) { item = document.createElement('button'); item.id = 'btnShareProgramPage'; item.onclick = () => copyText(item.dataset.href, 'Link copied'); $('longSet').before(item); }
    item.textContent = `Link to ${p.name} from the start`;
    item.dataset.href = p.page;
  }
  // a clipboard write that never leaves the person with nothing: a rejection puts the link in its field (shown if it
  // was folded away), selected, with the note that says how to copy it. -> true when the clipboard took it.
  async function copyText(url, okText, fieldId) {
    if (fieldId === 'shareLink') openLongField();   // the copied thing is on the page, in a field the person can see
    try { await navigator.clipboard.writeText(url); page.toast(okText); return true; }
    catch (e) {
      const f = fieldId && $(fieldId);
      if (f) { f.focus(); f.select(); }
      page.toast('Press Ctrl+C to copy the link');
      return false;
    }
  }
  function openLongField() {
    const d = $('shareMore'), body = d.querySelector(':scope > :not(summary)');
    d.open = true; body.hidden = false;
  }
  // the primary: one tap gives what primaryMode says it gives. The program page and the long link are copied as
  // they are; the short link is made first (the moment sealed here, stored on s.cloadm.dev) and its address copied.
  $('btnShareCopy').onclick = async () => {
    if (!captured) return;
    const mode = primaryMode();
    if (mode === 'program') { await copyText(captured.untouched.page, 'Program link copied'); return; }
    if (mode === 'long') { await copyText(captured.link, 'Long link copied', 'shareLink'); return; }
    const btn = $('btnShareCopy');
    btn.disabled = true; btn.textContent = 'Making the short link…';
    try {
      short = await session.shortLink(linkStore, { preview: $('sharePreview').checked, file: captured.file });
      keepToken(short.id, short.deleteToken);
      $('shareShort').value = short.url;
      drawQr(short.url);
      $('shortPicNote').textContent = short.picture ? 'With its preview picture.' : (short.pictureNote || 'Without a preview picture.');
      $('sharePreview').disabled = true;
      $('shortMade').hidden = false;
      await copyText(short.url, 'Short link copied', 'shareShort');
    } catch (e) {
      // the server answered nothing or refused (offline is caught above by shortWhy; a kill switch, a limit, a store
      // that isn't there land here): the long link instead, and the note says why it is that one, never the server's words
      const ok = await copyText(captured.link, 'Long link copied', 'shareLink');
      fallbackWhy = UNAVAILABLE_LONG;
      if (!ok) page.toast('Press Ctrl+C to copy the link');
    } finally {
      btn.textContent = 'Copy link';
      btn.disabled = false;
      syncPrimary();
    }
  };
  // Share…: the system sheet, the URL only, where the browser can share it (an embed only if its frame allows web-share)
  $('btnShareNative').onclick = async () => {
    const url = captured && captured.untouched ? captured.untouched.page : short ? short.url : $('shareLink').value;
    try { await navigator.share({ url }); }
    catch (e) { if (e && e.name === 'AbortError') return; page.toast('Could not open the share sheet: copy the link instead'); }
  };
  function drawQr(url) {
    const q = qrEncode(url, { ecl: 'M' }), quiet = 4, scale = 4, n = q.size + quiet * 2, c = $('shareQr');
    c.width = n * scale; c.height = n * scale;
    const g = c.getContext('2d');
    g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); g.fillStyle = '#000';
    for (let r = 0; r < q.size; r++) for (let k = 0; k < q.size; k++) if (q.modules[r * q.size + k]) g.fillRect((k + quiet) * scale, (r + quiet) * scale, scale, scale);
    c.dataset.text = url;
  }
  $('btnShortCopy').onclick = async () => {
    const ok = await copyText($('shareShort').value, $('btnShortCopy'), 'shareShort');
    page.toast(ok ? 'Short link copied' : 'Press Ctrl+C to copy the link');
  };
  $('btnShortQr').onclick = () => {
    const w = $('shortQrWrap'), b = $('btnShortQr');
    w.hidden = !w.hidden;
    b.setAttribute('aria-pressed', String(!w.hidden));
    b.title = w.hidden ? 'Show the QR code' : 'Hide the QR code';
  };
  $('btnShortDelete').onclick = async () => {
    if (!short) return;
    const token = tokens()[short.id] || short.deleteToken;
    try { await linkStore.remove(short.id, token); }
    catch (e) { page.status(e.message, true); return; }
    keepToken(short.id, null);
    short = null;
    $('shortMade').hidden = true; $('shareShort').value = ''; $('sharePreview').disabled = false;
    syncPrimary();
    page.toast('Short link deleted', { details: 'Copies already cached on the way may still open for up to a day.' });
  };
  window.addEventListener('online', syncPrimary);
  window.addEventListener('offline', syncPrimary);
  // the long link's own Copy, and "Always use long links"
  $('btnShareCopyLong').onclick = async () => {
    const ok = await copyText($('shareLink').value, $('btnShareCopyLong'), 'shareLink');
    page.toast(ok ? 'Long link copied' : 'Press Ctrl+C to copy the link');
  };
  // the switch and what each tap gives change together: both notes are re-said at once, not only on the next capture
  $('shareAlwaysLong').onchange = () => { setAlwaysLong($('shareAlwaysLong').checked); syncLongNote(); };
  $('shareAlwaysLong').checked = alwaysLong();
  $('btnShareDownload').onclick = () => {
    page.download(captured.file.name, captured.file.bytes, 'application/gzip');
    page.toast(`Saved ${captured.file.name}`, { details: 'Drop it on CLOADM to restore it.' });
  };
  $('btnShareShot').onclick = () => page.download(`${captured.base}.png`, captured.png);

  // the clip: the screen as it plays (from now), recorded for CLIP_SECONDS
  const kind = clipType();
  const clipBtn = $('btnShareClip');
  if (!kind) { clipBtn.disabled = true; clipBtn.textContent = 'Clip: this browser can\'t record video'; }
  else clipBtn.textContent = `Save ${CLIP_SECONDS}-second clip (${kind.label})`;
  clipBtn.onclick = () => {
    // drawn from the machine's own frames at true pixels (the screen canvas is hidden behind this view)
    const canvas = document.createElement('canvas'), presenter = new CanvasPresenter(canvas);
    presenter.present(session.shownMachine.render());
    let drawing = true;
    const draw = () => { if (!drawing) return; presenter.present(session.shownMachine.render()); requestAnimationFrame(draw); };
    requestAnimationFrame(draw);
    const stream = canvas.captureStream(30), rec = new MediaRecorder(stream, { mimeType: kind.type }), parts = [];
    rec.ondataavailable = (e) => { if (e.data.size) parts.push(e.data); };
    rec.onstop = () => {
      drawing = false;
      stream.getTracks().forEach((t) => t.stop());
      const blob = new Blob(parts, { type: kind.type.split(';')[0] });
      const name = `${captured ? captured.base : 'CLOADM'}.${kind.ext}`;
      page.download(name, blob);
      clipBtn.disabled = false; clipBtn.textContent = `Save ${CLIP_SECONDS}-second clip (${kind.label})`;
      page.status(`Saved ${name}: ${CLIP_SECONDS} seconds of the screen.`);
    };
    clipBtn.disabled = true;
    let left = CLIP_SECONDS;
    clipBtn.textContent = `Recording… ${left} s`;
    const tick = setInterval(() => { left--; if (left > 0) clipBtn.textContent = `Recording… ${left} s`; else clearInterval(tick); }, 1000);
    rec.start(500);
    setTimeout(() => rec.stop(), CLIP_SECONDS * 1000);
  };

  // ---------------- embed ----------------
  const sel = $('embedMachine');
  for (const [id, p] of Object.entries(profiles)) {
    const o = document.createElement('option'); o.value = id; o.textContent = p.name.replace(/^Tandy /, ''); sel.append(o);
  }
  const embedBase = () => new URL('play/', document.baseURI).href;
  const scriptUrl = () => new URL('embed/cloadm.js', document.baseURI).href;
  // the link the iframe opens: a tape loads through the deck (autorun or not); anything else loads and runs
  function embedSrc() {
    const url = $('embedProgram').value.trim(), cfg = { machine: sel.value, media: [], display: { view: $('embedCrt').checked ? 'crt' : 'sharp' }, embed: true };
    if (url) cfg.media.push({ kind: /\.(cas|wav|c10|k7)(\?|#|$)/i.test(url) ? 'tape' : 'load', url });
    if (url && $('embedAutorun').checked) cfg.autorun = true;
    // the corner chip that opens this moment with Claude in a new tab (off unless asked for: js/ui/ask-popout.js)
    if ($('embedAskClaude').checked) cfg.askClaude = true;
    return buildUrl(embedBase(), cfg);
  }
  function renderEmbed() {
    const src = embedSrc();
    $('embedFrame').textContent = `<iframe src="${src}"\n  width="640" height="480"\n  allow="gamepad; fullscreen"></iframe>`;
    $('embedScript').textContent = `<script src="${scriptUrl()}"></script>\n<script type="module">\n  const m = await CLOADM.attach(document.querySelector('iframe'));\n  await m.type('POKE 65495,0\\n');\n  m.on('frame', (f) => { /* … */ });\n</script>`;
    $('embedAutorun').disabled = !$('embedProgram').value.trim();
  }
  function syncEmbed(id) { sel.value = id; renderEmbed(); }
  for (const id of ['embedMachine', 'embedProgram', 'embedAutorun', 'embedCrt', 'embedAskClaude']) $(id).addEventListener('input', renderEmbed);
  const copy = (id, btn) => async () => {
    try { await navigator.clipboard.writeText($(id).textContent); $(btn).textContent = 'Copied'; }
    catch (e) { getSelection().selectAllChildren($(id)); $(btn).textContent = 'Press Ctrl+C'; }
    setTimeout(() => { $(btn).textContent = 'Copy'; }, 2000);
  };
  $('btnEmbedFrameCopy').onclick = copy('embedFrame', 'btnEmbedFrameCopy');
  $('btnEmbedScriptCopy').onclick = copy('embedScript', 'btnEmbedScriptCopy');
  // the builder starts on the machine in use
  session.on((ev) => { if (ev === 'machine' && !isOpen()) syncEmbed(session.shownMachine.id); });
  if (session.shownMachine) syncEmbed(session.shownMachine.id); else renderEmbed();

  show();
  return {
    open: () => $('btnShare').click(), embedSrc,
    // the visit has started (main.js): a page opened at #share captures its moment now
    ready() { started = true; if (isOpen() && !captured) show(); },
  };
}
