/*
 * The Share screen: a view of /play/ at #share, like the Library. The app bar's Share button captures the moment (the
 * snapshot and the picture at that instant) and opens it. Its one job: send this exact moment to someone.
 *
 * Top: the picture as a link preview, one line saying what the link does, a ROM line (what the person opening it must add,
 * or that it runs without ROMs: the snapshot holds no byte of a ROM or cartridge, Session.shareFile names them), then
 * the two links:
 *  - the short link (Session.shortLink): made only when asked ("Make a short link"), the moment sealed in this browser
 *    and stored on s.cloadm.dev (js/host/link-store.js), its key only in the link's fragment; with its QR code
 *    (js/media/qr.js), the "Show a preview picture" switch (on by default; the picture is public) and "Delete this link"
 *    (its delete token kept in this browser, localStorage cloadm.shortLinks). Where it can't be made (offline, a moment
 *    on ROMs, a cartridge, NitrOS-9: Session.shortLinkRefusal) the button is switched off and the reason is beside it.
 *  - the long link, headed "Works offline, never expires" and labelled "Exact moment (long link)" (Session.snapshotLink: the snapshot rides in the URL's
 *    fragment, which never reaches a server; js/ui/snapshot-panel.js opens it), with Share... (navigator.share, the URL
 *    only, where canShare allows it) and Copy link.
 * "More ways to share" (collapsed): a 6-second clip of the screen (MediaRecorder: MP4 where the browser records it, WebM
 * otherwise, and the button says which), the screenshot at true pixels, the snapshot file.
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

  // ---------------- share this moment ----------------
  async function capture() {
    const m = session.shownMachine, frame = m.render();
    // the picture at true pixels, captured with the snapshot so both show the same instant
    const c = document.createElement('canvas');
    new CanvasPresenter(c).present(frame);
    // the shared snapshot: no byte of a ROM or cartridge, only their names (Session.shareFile, AGENTS rule 1).
    // NitrOS-9's memory is the user's own NitrOS-9: its link boots NitrOS-9 from the recipient's image instead.
    // The SHOWN machine's NitrOS-9, not the person's: the picture above is the shown machine's and shareUrl builds the
    // link for it, so with the chat full screen this must ask about the chat, as shareUrl does.
    const n9 = session.nitros9OnScreen;
    const file = n9 ? null : await session.shareFile();
    const link = n9 ? session.shareUrl(location.href) : await session.snapshotLink(location.href, file);
    const png = await new Promise((ok) => c.toBlob(ok, 'image/png'));
    captured = { at: Date.now(), file, png, link, base: file ? file.name.replace(/\.cloadm$/, '') : `${m.profile.name.replace(/[^A-Za-z0-9]+/g, '')}-NitrOS-9` };
    const dl = $('btnShareDownload');
    dl.disabled = !file;
    dl.textContent = file ? `Download snapshot (${(file.bytes.length / 1024).toFixed(0)} KB)` : 'Download snapshot';
    const pic = $('sharePicture');
    pic.width = c.width; pic.height = c.height;
    pic.getContext('2d').drawImage(c, 0, 0);
    const name = m.profile.name.replace(/^Tandy /, '');
    $('shareTitle').textContent = `${name} · CLOADM`;
    $('shareWhen').textContent = capturedAgo(captured.at);
    $('shareLink').value = link;
    $('longWhy').textContent = session.longLinkRefusal(m) || '';
    short = null; refused = null;
    $('shortMade').hidden = true; $('shareShort').value = ''; $('sharePreview').disabled = false;
    // the snapshot's link holds the whole moment, so it is long; NitrOS-9's only starts NitrOS-9
    $('shareLinkLabel').textContent = file ? 'Exact moment (long link)' : 'Link';
    syncShort();   // (it calls syncPrimary() itself, after the short-link bits)
    // one line under the picture, what the link does; then, only as needed, what the person opening it needs
    const rom = $('shareRom'), extra = $('shareExtra');
    rom.textContent = ''; rom.classList.remove('warn'); extra.textContent = '';
    const note = (text) => { const p = document.createElement('p'); p.textContent = text; extra.append(p); };
    if (!file) {
      $('shareNote').textContent = `The link starts NitrOS-9 fresh on the ${name}; it can't hold this exact moment.`;
      note('They need their own NitrOS-9 DriveWire image in their library: the link boots NitrOS-9 on the CoCo 3 from it, and holds no part of yours.');
      syncEmbed(m.id);
      return;
    }
    $('shareNote').textContent = `Opens on the ${name} exactly as it is now. A snapshot reopens on the same machine, RAM and ROMs.`;
    if (file.needs.length) { rom.textContent = needsLine(file.needs); rom.classList.add('warn'); }
    else rom.textContent = 'Runs without ROMs, so it opens for anyone.';
    // a tape being recorded is not in the link (its pulse timings could carry ROM code: js/media/romrefs.js)
    if (file.dropped.includes('deck.recording')) note('The tape being recorded is not in the link: it opens with the recorder stopped.');
    syncEmbed(m.id);
  }
  // ---------------- the short link ----------------
  let short = null;   // { url, id, deleteToken } once made for this capture
  let refused = null;  // what the server or the Session said the last time a short link couldn't be made
  // why the short link can't be made now, or null
  const shortWhy = () => {
    if (!captured || !captured.file) return session.shortLinkRefusal() || 'Not for this moment.';
    if (!navigator.onLine) return 'You are offline: a short link needs the internet. The long link below works offline.';
    return session.shortLinkRefusal();
  };
  function syncShort() {
    const why = short ? null : shortWhy();
    $('btnShortMake').disabled = !!why;
    $('btnShortMake').hidden = !!short;
    $('shortWhy').textContent = why || refused || '';
    syncPrimary();
  }
  function drawQr(url) {
    const q = qrEncode(url, { ecl: 'M' }), quiet = 4, scale = 4, n = q.size + quiet * 2, c = $('shareQr');
    c.width = n * scale; c.height = n * scale;
    const g = c.getContext('2d');
    g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); g.fillStyle = '#000';
    for (let r = 0; r < q.size; r++) for (let k = 0; k < q.size; k++) if (q.modules[r * q.size + k]) g.fillRect((k + quiet) * scale, (r + quiet) * scale, scale, scale);
    c.dataset.text = url;
  }
  $('btnShortMake').onclick = async () => {
    const btn = $('btnShortMake');
    btn.disabled = true; btn.textContent = 'Making the short link…';
    try {
      short = await session.shortLink(linkStore, { preview: $('sharePreview').checked, file: captured.file });
      keepToken(short.id, short.deleteToken);
      $('shareShort').value = short.url;
      drawQr(short.url);
      $('shortPicNote').textContent = short.picture ? 'With its preview picture.' : (short.pictureNote || 'Without a preview picture.');
      $('sharePreview').disabled = true;
      $('shortMade').hidden = false;
      refused = null;
    } catch (e) { refused = e.message; }
    btn.textContent = 'Make a short link';
    syncShort();
    if (short) $('btnShortCopy').focus();
  };
  $('btnShortCopy').onclick = async () => {
    try { await navigator.clipboard.writeText($('shareShort').value); page.toast('Short link copied'); }
    catch (e) { $('shareShort').select(); page.toast('Press Ctrl+C to copy the link'); }
  };
  $('btnShortDelete').onclick = async () => {
    if (!short) return;
    const token = tokens()[short.id] || short.deleteToken;
    try { await linkStore.remove(short.id, token); }
    catch (e) { page.status(e.message, true); return; }
    keepToken(short.id, null);
    short = null;
    $('shortMade').hidden = true; $('shareShort').value = ''; $('sharePreview').disabled = false;
    syncShort();
    page.toast('Short link deleted', { details: 'Copies already cached on the way may still open for up to a day.' });
  };
  window.addEventListener('online', syncShort);
  window.addEventListener('offline', syncShort);

  // Share… (the system sheet, the URL only) where the browser can share it; in an embed only if the frame allows web-share
  // (the short link once it is made, else the long link)
  const sharedUrl = () => $('shareShort').value || $('shareLink').value;
  const canNative = () => {
    const url = sharedUrl();
    if (typeof navigator.share !== 'function' || !navigator.canShare?.({ url })) return false;
    return !document.body.classList.contains('embed') || document.featurePolicy?.allowsFeature?.('web-share') === true;
  };
  // one primary button: Make a short link where it can be made (the default) or its Copy once made, else Share… or Copy link
  const syncPrimary = () => {
    // (the short link once made: its Copy is the primary)
    const native = canNative(), shortFirst = !!short || !$('btnShortMake').disabled;
    $('btnShareNative').hidden = !native;
    $('btnShareNative').classList.toggle('primary', native && !shortFirst);
    $('btnShareCopy').classList.toggle('primary', !native && !shortFirst);
  };
  $('btnShareNative').onclick = async () => {
    try { await navigator.share({ url: sharedUrl() }); }
    catch (e) { if (e && e.name === 'AbortError') return; page.toast('Could not open the share sheet: copy the link instead'); }
  };
  $('btnShareCopy').onclick = async () => {
    const url = $('shareLink').value;
    try { await navigator.clipboard.writeText(url); page.toast('Share link copied'); }
    catch (e) { $('shareLink').select(); page.toast('Press Ctrl+C to copy the link'); }
  };
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
