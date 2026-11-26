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
 * After a tap the field it made (the short link's, or the long link's under "More ways to share") is scrolled into view
 * and focused.
 * "Save picture" (the share card: the picture at true pixels in a CRT monitor, the program's or machine's name beside
 * it and "cloadm.dev" on it, 1200 x 630, js/video/bezel.js; the same renderer as the short link's preview picture) and
 * "Save clip" (6 seconds of the screen: MediaRecorder, MP4 where the browser records it, WebM otherwise, its title says
 * which) sit beside Copy on a desktop, and under "More ways to share" on a phone and a short landscape screen.
 * "More ways to share" (collapsed): "Link to <program> from the start" when there is one, the long link, "Long link
 * (works offline; nothing is uploaded)" with its field, Copy and the "Always use long links" switch; then (phone, short
 * landscape) Save picture and Save clip, and the snapshot file.
 * A short landscape screen (a phone on its side, at most 420px tall) has its own layout (play/index.html): the picture
 * on the left, the right column scrolling on its own, the ROM line in one line (its full sentence the line's title and
 * what assistive technology reads).
 * Launch-prep additions: with ROMs in use, the ROM line is one sentence, "This link holds none of your ROMs. Whoever
 * opens it needs their own <machine> ROMs." (js/share-text.js romLines; its compact form, "Needs your <machine> ROMs to
 * open.", is the short-landscape layout's one line), the caption reads "This moment · <machine>", and the note under
 * Copy link says why that link is a long one. "Save GIF" (the machine's own frames at true pixels scaled 2x, no CRT look, GIF_SECONDS long,
 * looping: js/media/gif.js) is first in "More ways to share"'s save row. The GIF follows the stage's WYRMFIRE rules as the
 * picture and the clip do (setShots): off, its reason beside it, for the person's own WAD's level; a GIF of the Freedoom
 * level carries "-freedoom" in its name and the level's credit in its comment. "Copy as text for a forum" (collapsed, before "Embed in a web page"): the
 * link with a one-line description as BBCode and as Markdown (js/share-text.js forumText), text only; its link never
 * uploads (forumUrl): the short link a Copy-link tap made, else an untouched program's page, else the long link.
 * "Embed in a web page" (collapsed): the iframe and script for a blog post, written by js/config.js (buildUrl) from the
 * machine, program and options chosen here ("Offer 'Ask Claude ↗'" adds askclaude=1: the embed's corner chip).
 * (The settings export/import lives on the Machine tab: js/ui/settings-file.js.)
 *
 * "Share your program": when a BASIC program is in memory (Session.sharedProgram), a card above Copy says "Your BASIC
 * program · N lines · [Share the program instead]". The moment stays the default; the card's switch puts the screen in
 * program mode: the heading "Share your program", the preview the first lines LIST shows in the machine's font
 * (js/chips/mc6847.js textScreenFrame), captioned "What they'll see first · LIST", and the switch "Share the whole moment
 * instead" back. The one link is the program's: the short link holds only the program's text, sealed
 * (Session.programShortLink), the long link carries it (Session.programLink; both are js/media/snapshot.js's program
 * link). "More ways to share" then offers "Copy as text for a forum" (a ``` or [code] block, then the link), "Download
 * .bas" and the long link. A program that can't be shared as text (over load_basic's limit, or bytes that don't type
 * back the same) says so in the card, with the switch back, and Copy stays dark.
 */
import { profiles } from '../machines/profiles.js';
import { buildUrl } from '../config.js';
import { romLines, LONG_LINK_NOTE, forumText } from '../share-text.js';
import { gifFromFrames } from '../media/gif.js';
import { CanvasPresenter } from '../video/canvas.js';
import { textScreenFrame } from '../chips/mc6847.js';
import { listingRows } from '../media/basic.js';
import { qrEncode } from '../media/qr.js';
import { $, showView } from './page.js';
import { WYRMFIRE_TEXT } from '../session.js';
import { WYRM_TEXT } from './wyrmfire.js';
import { crc32 } from '../util.js';

// a PNG with a tEXt chunk (keyword, text) put in after its header chunk: the picture's own credit line (PNG 1.2, 4.2.3.1)
async function pngWithText(blob, keyword, text) {
  const png = new Uint8Array(await blob.arrayBuffer());
  const data = new TextEncoder().encode(`${keyword}\0${text}`), type = new TextEncoder().encode('tEXt');
  const chunk = new Uint8Array(12 + data.length), dv = new DataView(chunk.buffer);
  dv.setUint32(0, data.length);
  chunk.set(type, 4); chunk.set(data, 8);
  dv.setUint32(8 + data.length, crc32(new Uint8Array([...type, ...data])) >>> 0);
  const at = 8 + 25;   // the signature and IHDR (13 bytes of data)
  return new Blob([png.subarray(0, at), chunk, png.subarray(at)], { type: 'image/png' });
}

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
const CLIP_SECONDS = 6, GIF_SECONDS = 6;
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
  let captured = null;   // { file: { name, bytes } | null, card: the share card's PNG bytes, cardName, link | null, base: file name without extension, ... }
  let programMode = false;   // sharing the BASIC program's text instead of the moment (the program card's switch)

  // ---------------- the view (#share) ----------------
  const isOpen = () => location.hash === '#share';
  function show() {
    const open = isOpen();
    document.body.classList.toggle('share-open', open);
    showView(view, open);
    // opened by address (play/#share) the page is still starting: the view shows, and ready() captures once there is a machine
    if (open && !captured && started) capture().catch((e) => page.status(e.message, true));
    if (open && captured) $('shareWhen').textContent = whenText(captured);   // the time said again, now (a WYRMFIRE moment keeps its credit)
    if (open) window.scrollTo(0, 0);
    place();
  }
  // what the line under the picture says: a WYRMFIRE moment names its level (the credit the branch's card carries),
  // every other moment says how long ago it was captured (the stage's card). One element, two meanings, decided by
  // what was captured -- and the periodic refresh below must not overwrite the credit with a time.
  // The person's OWN WAD says nothing here: the credit names Freedoom, and that level is not Freedoom's (id Software's
  // game data, which is also why it carries no picture). `wyrmfire` is the level kind, so 'user' is not the credit.
  const whenText = (c) => (c && c.wyrmfire === 'freedoom' ? WYRM_TEXT.level : c && !c.wyrmfire ? capturedAgo(c.at) : '');
  page.onView(show);
  // where Save picture and Save clip sit (beside Copy on a desktop, under "More ways to share" on a phone and a short
  // landscape screen), and where the view starts (--share-top: a short landscape screen's two columns fill the rest)
  const SHORT_LANDSCAPE = matchMedia('(orientation: landscape) and (max-height: 420px)'), DESKTOP = matchMedia('(min-width: 861px)');
  function place() {
    const beside = DESKTOP.matches && !SHORT_LANDSCAPE.matches, to = beside ? $('shareSaveBeside') : $('shareSaveMore');
    const at = beside ? null : $('btnShareDownload');
    // each control moves WITH its reason (the .why span beside it), so a reason is never left under a bar its button
    // has left. The reason is a sibling of the button, not a wrapper: an insert point -- btnShareDownload -- has to be
    // a sibling of what is inserted, and a wrapper would also put the button out of reach of place()'s own lookup.
    for (const [id, whyId] of [['btnShareShot', 'shareShotWhy'], ['btnShareClip', 'shareClipWhy']]) {
      const b = $(id), w = $(whyId);
      to.insertBefore(b, at);
      if (w) to.insertBefore(w, at);
    }
    fitCaption();
    if (isOpen()) view.style.setProperty('--share-top', `${Math.max(0, Math.round(view.getBoundingClientRect().top + window.scrollY))}px`);
  }
  for (const q of [SHORT_LANDSCAPE, DESKTOP]) q.addEventListener('change', place);
  window.addEventListener('resize', place);
  // the stage says the moment's age here; a WYRMFIRE moment says its level's credit instead (whenText), so the refresh
  // must go through whenText on both sides rather than writing capturedAgo itself
  setInterval(() => { if (captured && isOpen()) $('shareWhen').textContent = whenText(captured); }, AGO_MS);
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
    // WYRMFIRE: the link starts it afresh with the Freedoom level (Session.shareUrl), never this moment; with the
    // person's own WAD, no picture and no clip (id Software's game data)
    const wyrm = session.wyrmfireOn(m) || session.romCodeIn(m) === 'userdata';
    const own = session.romCodeIn(m) === 'userdata';
    if (wyrm) { await captureWyrmfire(m, frame, own); return; }
    const name = m.profile.name.replace(/^Tandy /, '');
    // the picture at true pixels, captured with the snapshot so both show the same instant
    const c = document.createElement('canvas');
    new CanvasPresenter(c).present(frame);
    // the shared snapshot: no byte of a ROM or cartridge, only their names (Session.shareFile, AGENTS rule 1).
    // NitrOS-9's memory is the user's own NitrOS-9: its link boots NitrOS-9 from the recipient's image instead.
    // The SHOWN machine's NitrOS-9, not the person's: the picture above is the shown machine's and shareUrl builds the
    // link for it, so with the chat full screen this must ask about the chat, as shareUrl does.
    const n9 = session.nitros9OnScreen;
    // the share card ("Save picture") of this same frame, drawn now (sharePicture renders before its first await)
    const cardName = session.shareCardName(location.href, m);
    const card = session.sharePicture(cardName, m);
    // A moment a guardrail forbids encoding at all (Session.shareFile refusing): the view still opens, so the person
    // sees why, with Copy dark. NitrOS-9 is not that: its link boots NitrOS-9 from the recipient's own image.
    let file = null, refusal = '';
    if (!n9) { try { file = await session.shareFile(); } catch (e) { refusal = e.message; } }
    const link = refusal ? '' : n9 ? session.shareUrl(location.href) : await session.snapshotLink(location.href, file);
    // WYRMFIRE's own buttons are handled in captureWyrmfire; for every other moment all three are live
    setShots(false);
    why('shareDownloadWhy', '');
    // the bundled program, when it is one nobody has touched: its own page is the primary link (nothing is uploaded)
    const untouched = n9 || refusal ? null : session.untouchedBundledProgram(location.href);
    // the BASIC program in memory, when there is one: shared as its text in program mode (the default stays the moment)
    const program = session.sharedProgram(m);
    const programLink = program && !program.refusal ? await session.programLink(location.href, program) : '';
    captured = { at: Date.now(), file, card: await card, cardName, link, untouched, refusal, machine: name, shot: c, program, programLink, base: file ? file.name.replace(/\.cloadm$/, '') : `${m.profile.name.replace(/[^A-Za-z0-9]+/g, '')}-${n9 ? 'NitrOS-9' : 'moment'}` };
    programMode = false;
    const dl = $('btnShareDownload');
    dl.disabled = !file;
    dl.textContent = file ? `Download snapshot (${(file.bytes.length / 1024).toFixed(0)} KB)` : 'Download snapshot';
    const pic = $('sharePicture');
    pic.width = c.width; pic.height = c.height;
    pic.getContext('2d').drawImage(c, 0, 0);
    setPicture('');
    $('shareWhen').textContent = whenText(captured);
    $('shareLink').value = link;
    short = null; fallbackWhy = '';
    $('shortMade').hidden = true; $('shareShort').value = ''; $('sharePreview').disabled = false;
    syncProgram();    // (the program card, and the moment's heading and picture; it calls syncLongNote, then syncPrimary)
    // one line under the picture, what the link does; then, only as needed, what the person opening it needs
    const rom = $('shareRom'), extra = $('shareExtra');
    // the ROM line: the full sentence, and its one line for a short landscape screen (play/index.html shows one)
    const romLine = (full, brief) => { $('shareRomFull').textContent = full; $('shareRomBrief').textContent = brief; if (full) rom.title = full; else rom.removeAttribute('title'); };
    romLine('', ''); extra.textContent = '';
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
    // with ROMs in use, one line: the link holds none of them (Session.shareFile takes every byte out) and whoever opens it
    // needs their own, named by the machine, not by the slots; one sentence in normal text, never the orange of a warning
    if (file.needs.length) { const l = romLines(name); romLine(l.full, l.brief); }
    else romLine('Runs without ROMs, so it opens for anyone.', 'Runs without ROMs.');
    // a tape being recorded is not in the link (its pulse timings could carry ROM code: js/media/romrefs.js)
    if (file.dropped.includes('deck.recording')) note('The tape being recorded is not in the link: it opens with the recorder stopped.');
    syncEmbed(m.id);
  }
  // An option that is off stays listed, disabled, with its reason beside it (never hidden)
  function why(id, text) { const w = $(id); w.textContent = text || ''; w.hidden = !text; }
  // the picture area: a moment with no picture of its own (the person's own WAD) says so in the frame, and the frame
  // stops showing an empty dark box under a caption that claims a captured picture. Every other capture clears it.
  function setPicture(note = '') {
    const f = $('shareFrame'), n = $('shareNoPicture');
    if (!f || !n) return;
    f.classList.toggle('nopic', !!note);
    n.textContent = note;
    n.hidden = !note;
    if (note) $('sharePicture').setAttribute('aria-hidden', 'true');
    else $('sharePicture').removeAttribute('aria-hidden');
  }
  function setShots(off, reason = '') {
    $('btnShareShot').disabled = off;
    why('shareShotWhy', off ? reason : '');
    if (kind) { clipBtn.disabled = off; why('shareClipWhy', off ? reason : ''); }
    gifBtn.disabled = off; why('shareGifWhy', off ? reason : '');
    $('forumGifHint').hidden = off;   // (the forum disclosure's "Attach the GIF from Save GIF": not while there is none)
  }
  // A WYRMFIRE moment, on the ONE-LINK layout (js/ui/share.js's primary is Copy link): its link only starts the
  // game from the start with the Freedoom level (Session.shareUrl), never this moment, so there is no short link to
  // make and no snapshot in it -- the primary says what it gives, in #primaryWhy, and #shareWhen carries the level's
  // credit (Freedoom's) or nothing at all (the person's own WAD: that level is not Freedoom's).
  async function captureWyrmfire(m, frame, own) {
    const c = document.createElement('canvas');
    if (!own) new CanvasPresenter(c).present(frame);
    else { c.width = frame.width; c.height = frame.height; }
    // the stage's screenshot button downloads captured.CARD (the one-link layout's name for the moment's picture), so a
    // WYRMFIRE moment sets it too: null for the person's own WAD (no picture of their game data), the credited PNG
    // otherwise
    const card = own ? null : await pngWithText(await new Promise((ok) => c.toBlob(ok, 'image/png')), 'Comment', `WYRMFIRE ${WYRM_TEXT.level}`);
    const link = session.shareUrl(location.href);
    // the files say whose level it is: "-freedoom" on the name, and the PNG carries the credit line
    captured = { at: Date.now(), file: null, card, cardName: null, link, refusal: '', machine: m.profile.name.replace(/^Tandy /, ''),
      base: `WYRMFIRE-${m.profile.name.replace(/[^A-Za-z0-9]+/g, '')}-freedoom`, wyrmfire: own ? 'user' : 'freedoom' };
    short = null; fallbackWhy = '';
    $('shortMade').hidden = true; $('shareShort').value = ''; $('sharePreview').disabled = false;
    const dl = $('btnShareDownload');
    dl.disabled = true; dl.textContent = 'Download snapshot';
    why('shareDownloadWhy', WYRMFIRE_TEXT.snapshots);
    const pic = $('sharePicture');
    pic.width = c.width; pic.height = c.height;
    // the person's own WAD has no picture of its own (id Software's game data): the frame says so rather than showing
    // an empty dark rectangle under a caption that claims a captured picture
    setPicture(own ? WYRMFIRE_TEXT.userPicture : '');
    if (!own) pic.getContext('2d').drawImage(c, 0, 0);
    $('shareLink').value = link;
    $('shareWhen').textContent = whenText(captured);
    syncLongNote();   // (it calls syncPrimary(), which sets the primary's own note)
    const rom = $('shareRom'), extra = $('shareExtra');
    // (the ROM line's two spans are cleared, not the line: the next ordinary capture writes into them)
    $('shareRomFull').textContent = ''; $('shareRomBrief').textContent = ''; rom.removeAttribute('title');
    extra.textContent = '';
    setShots(own, WYRMFIRE_TEXT.userClips);
    syncEmbed(m.id);
  }

  // ---------------- the primary link: one link ----------------
  let short = null;     // { url, id, deleteToken } once made for this capture (its field and Delete under the button)
  const ALWAYS_LONG = 'cloadm.alwaysLongLinks';   // this browser: every tap copies the long link
  const alwaysLong = () => { try { return localStorage.getItem(ALWAYS_LONG) === '1'; } catch (e) { return false; } };
  const setAlwaysLong = (on) => { try { if (on) localStorage.setItem(ALWAYS_LONG, '1'); else localStorage.removeItem(ALWAYS_LONG); } catch (e) { /* no storage: for this visit */ } $('shareAlwaysLong').checked = on; };
  // the caption's words before the machine's name: a moment with no ROMs shows what the person opening it sees first;
  // one on ROMs says only that it is a moment (what they see first is up to their own ROMs)
  const CAPTION_PREFIX = "What they'll see first ·", ROM_CAPTION_PREFIX = 'This moment ·';
  const OFFLINE_LONG = "You're offline, so this is the long link: it works without any server.";
  const UNAVAILABLE_LONG = "Short links aren't available right now, so this is the long link: it works without any server.";
  // why the short link can't be made for this capture, or null: the Session's own refusals (ROMs, a cartridge,
  // NitrOS-9: Session.shortLinkRefusal), then the browser's office. 'offline' is its own answer, for the note.
  const shortWhy = () => {
    // a program's short link holds only its text: the moment's refusals (ROMs, a cartridge) are not about it
    if (programMode) return !captured || !captured.programLink ? 'Not for this moment.' : !navigator.onLine ? 'offline' : null;
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
    if (programMode) return !captured.programLink ? 'none' : alwaysLong() || fallbackWhy ? 'long' : shortWhy() ? 'long' : 'short';
    if (captured.untouched) return 'program';
    if (alwaysLong() || fallbackWhy) return 'long';
    return shortWhy() ? 'long' : 'short';
  }
  // Share…: the system sheet, the URL only, where the browser can share it (in an embed only if the frame allows
  // web-share); its URL is what a tap would copy (the program page, the short link once made, else the long link)
  const canNative = () => {
    const url = captured && captured.untouched && !programMode ? captured.untouched.page : short ? short.url : $('shareLink').value || 'https://cloadm.dev/play/';
    if (typeof navigator.share !== 'function' || !navigator.canShare?.({ url })) return false;
    return !document.body.classList.contains('embed') || document.featurePolicy?.allowsFeature?.('web-share') === true;
  };

  // the long link's own note under "More ways to share": what it holds, or, with the switch on, that taps use it
  function syncLongNote() {
    $('longNote').textContent = alwaysLong() ? 'Long link: nothing is uploaded.' : programMode ? '' : 'Holds the whole moment in the address; nothing is uploaded.';
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
    $('sharePrefix').textContent = CAPTION_PREFIX;   // (the prefix of a moment on ROMs is its own, set below)
    const native = canNative();
    // a guardrail that leaves nothing to copy at all (Session.shareFile refused the moment: capture() keeps the view
    // open with `refusal` set): Copy goes dark, and the reason is inline. Every guardrail today still leaves the
    // machine's own link (NitrOS-9's boots NitrOS-9 from the recipient's image), so this is the rule kept real.
    const nothingToCopy = !!captured && (programMode ? !captured.programLink : (!!captured.refusal || (!captured.link && !captured.untouched)));
    $('btnShareCopy').disabled = !captured || nothingToCopy;
    $('btnShareCopy').classList.toggle('primary', !native);
    $('btnShareNative').hidden = !native || !captured || nothingToCopy;
    $('btnShareNative').classList.toggle('primary', native);
    const program = mode === 'program' && captured.untouched;
    // the program-page note, said once, in the line under the picture. Its second sentence promises the moment's link,
    // and in this mode that link always exists: a program page is only the primary when nothing was refused, so
    // capture() built the long link (the moment's link, under "More ways to share") for it. Said unconditionally:
    // a "when a link is offered" branch would be dead code.
    if (programMode) {
      // program mode: the card above Copy says what is shared; the moment's lines (its clarity copy, the ROM line) are not about it
      $('shareNote').textContent = '';
      $('shareRom').hidden = true;
      $('primaryNote').textContent = mode === 'long' && alwaysLong() ? 'Long link: nothing is uploaded.' : '';
      $('shareName').textContent = captured.programLink ? 'LIST' : captured.machine;
      fitCaption();
    } else if (program) {
      $('shareNote').textContent = `Opens ${captured.untouched.name} from the start, for anyone. The snapshot link below keeps this exact moment.`;
      // a program page never needs ROMs, and "for anyone" is said once (in the note above), not again in the ROM line
      $('shareRom').hidden = true;
      $('primaryNote').textContent = '';
      $('sharePrefix').hidden = true;
      $('shareName').textContent = `${captured.untouched.name} · ${captured.machine}`;
    } else if (captured && captured.wyrmfire) {
      // a WYRMFIRE moment: its link starts the game from the start with the Freedoom level, so it is said the way a
      // program page's is. No short link (Session.shortLinkRefusal refuses 'userdata', and this moment has no snapshot
      // file for any other), so #primaryNote is empty and the switch is hidden by mode !== 'short' below.
      $('shareNote').textContent = WYRM_TEXT.share;
      $('primaryNote').textContent = '';
      $('sharePrefix').hidden = true;
      $('shareName').textContent = `WYRMFIRE · ${captured.machine}`;
    } else {
      // the line under the picture, one owner for every capture: a refusal says nothing there (its reason is the
      // inline #primaryWhy, said once); NitrOS-9 says its own sentence; a file says the snapshot's clarity copy
      $('shareNote').textContent = !captured ? '' : captured.refusal ? '' : captured.file ? snapshotNote(captured.machine) : `The link starts NitrOS-9 fresh on the ${captured.machine}; it can't hold this exact moment.`;
      $('primaryNote').textContent = mode === 'long' && alwaysLong() ? 'Long link: nothing is uploaded.' : '';
      $('sharePrefix').hidden = false;
      if (captured && captured.file && captured.file.needs.length) $('sharePrefix').textContent = ROM_CAPTION_PREFIX;
      $('shareRom').hidden = false;
      $('shareName').textContent = captured ? captured.machine : '';
    }
    // a tap that fell back (fallbackWhy) has already made the choice, even though primaryMode said 'short' before it;
    // the reason it fell back is what the person needs to see, not the state before the tap
    // A WYRMFIRE moment says NOTHING here, because a moment shared like a program page (its ?start= link) shows no
    // reason: the Session's refusal still guards the short link (Session.shortLinkRefusal, 'userdata' and all), but
    // what it would say is wrong on screen -- "not with a cartridge plugged in" names a cartridge nobody plugged in
    // (it is WYRMFIRE's own disk controller), and the own-WAD sentence explains a choice this view never offers.
    // (the stage's program mode says its own reason in #programWhy; a WYRMFIRE moment is never in program mode --
    // captureWyrmfire returns before any program text exists -- so the two rules cannot both apply.)
    // A moment on the person's own ROMs is the one refusal that is no warning: Copy link simply gives the long link, said
    // in the neutral note under the buttons, not in orange. (NitrOS-9, a cartridge and the rest keep their own reasons.)
    const onRoms = !!why && !programMode && !fallbackWhy && !!captured && !captured.wyrmfire && !captured.refusal && !session.longLinkRefusal() && session.romCodeIn() === 'roms';
    if (onRoms) $('primaryNote').textContent = LONG_LINK_NOTE;
    $('primaryWhy').textContent = captured && captured.wyrmfire ? ''
      : onRoms ? ''
      : programMode ? fallbackWhy || (why === 'offline' ? OFFLINE_LONG : '')
      : captured && captured.refusal ? captured.refusal : fallbackWhy || (nothingToCopy ? 'This moment can\'t be put in a link.' : why === 'offline' ? OFFLINE_LONG : why && why !== 'Not for this moment.' ? why : '');
    $('shortTerms').hidden = mode !== 'short' || !!fallbackWhy;
    $('previewSwitch').hidden = mode !== 'short' || !!fallbackWhy;
    syncMore();
    syncForum();
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
  // the field a tap made (the short link's, or the long link's): in view and focused, so the person sees what was copied
  // (in a short landscape screen's own scrolling column, too) and the keyboard is on it
  function showMade(fieldId) {
    const f = $(fieldId), side = $('shareSide'), own = getComputedStyle(side).display !== 'contents';
    const b = f.getBoundingClientRect(), top = own ? side.getBoundingClientRect().top : 0, bottom = own ? Math.min(side.getBoundingClientRect().bottom, innerHeight) : innerHeight;
    // scrolled only when it is not already wholly on screen, and then to the middle: a toast at the foot stays clear of it
    if (b.top < top || b.bottom > bottom) f.scrollIntoView({ block: 'center' });
    f.focus({ preventScroll: true });
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
    const longLink = programMode ? captured.programLink : captured.link;
    if (mode === 'long') { await copyText(longLink, 'Long link copied', 'shareLink'); showMade('shareLink'); return; }
    const btn = $('btnShareCopy');
    btn.disabled = true; btn.textContent = 'Making the short link…';
    try {
      // the program's short link holds only its text (no preview picture); the moment's, the moment
      short = programMode ? await session.programShortLink(linkStore, captured.program)
        : await session.shortLink(linkStore, { preview: $('sharePreview').checked, file: captured.file, name: captured.cardName });
      keepToken(short.id, short.deleteToken);
      $('shareShort').value = short.url;
      drawQr(short.url);
      $('shortPicNote').textContent = programMode ? '' : short.picture ? 'With its preview picture.' : (short.pictureNote || 'Without a preview picture.');
      $('sharePreview').disabled = true;
      $('shortMade').hidden = false;
      await copyText(short.url, 'Short link copied', 'shareShort');
      showMade('shareShort');
    } catch (e) {
      // the server answered nothing or refused (offline is caught above by shortWhy; a kill switch, a limit, a store
      // that isn't there land here): the long link instead, and the note says why it is that one, never the server's words
      const ok = await copyText(longLink, 'Long link copied', 'shareLink');
      fallbackWhy = UNAVAILABLE_LONG;
      if (!ok) page.toast('Press Ctrl+C to copy the link');
    } finally {
      btn.textContent = 'Copy link';
      btn.disabled = false;
      syncPrimary();
    }
    if (!short) showMade('shareLink');
  };
  // the link "Copy as text for a forum" carries, and it never uploads: the short link if a Copy-link tap has made one, else
  // an untouched bundled program's page, else the long link. The upload, and its consent next to the cloadm.dev note, stay
  // on Copy link alone.
  const forumUrl = () => (short ? short.url : captured.untouched ? captured.untouched.page : captured.link);
  // Share…: the system sheet, the URL only, where the browser can share it (an embed only if its frame allows web-share)
  $('btnShareNative').onclick = async () => {
    const url = captured && captured.untouched && !programMode ? captured.untouched.page : short ? short.url : $('shareLink').value;
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
    syncForum();
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
  // the share card of the captured frame (capture() drew it)
  $('btnShareShot').onclick = () => { if (captured && captured.card) page.download(`${captured.base}.png`, captured.card, 'image/png'); };

  // the clip: the screen as it plays (from now), recorded for CLIP_SECONDS
  const kind = clipType();
  const clipBtn = $('btnShareClip');
  const clipLabel = () => { clipBtn.textContent = 'Save clip'; clipBtn.title = `Save ${CLIP_SECONDS}-second clip (${kind.label})`; };
  if (!kind) { clipBtn.disabled = true; clipBtn.textContent = 'Clip: this browser can\'t record video'; }
  else clipLabel();
  clipBtn.onclick = () => {
    // never of the person's own WAD's level (id Software's game data): the button is off then, and so is this
    if (session.romCodeIn(session.shownMachine) === 'userdata') { page.status(WYRMFIRE_TEXT.userClips, true); return; }
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
      clipBtn.disabled = false; clipLabel();
      // a clip of the Freedoom level says so in its name and here; the person's own WAD's clip is never made (the
      // button is off), so the own case cannot reach this line
      page.status(`Saved ${name}: ${CLIP_SECONDS} seconds of the screen.${captured && captured.wyrmfire === 'freedoom' ? ` ${WYRM_TEXT.level}.` : ''}`);
    };
    clipBtn.disabled = true;
    let left = CLIP_SECONDS;
    clipBtn.textContent = `Recording… ${left} s`;
    const tick = setInterval(() => { left--; if (left > 0) clipBtn.textContent = `Recording… ${left} s`; else clearInterval(tick); }, 1000);
    rec.start(500);
    setTimeout(() => rec.stop(), CLIP_SECONDS * 1000);
  };

  // Save GIF: the machine's own frames at true pixels, scaled 2x, no CRT look, GIF_SECONDS long and looping
  // (js/media/gif.js). The stage's WYRMFIRE rules hold for it as for the clip: never of the person's own WAD's level
  // (setShots turns it off, its reason beside it), and the Freedoom level's GIF says so in its name and its comment.
  const gifBtn = $('btnShareGif');
  const gifLabel = () => { gifBtn.textContent = 'Save GIF'; gifBtn.title = `Save ${GIF_SECONDS}-second GIF`; };
  gifLabel();
  gifBtn.onclick = () => {
    if (session.romCodeIn(session.shownMachine) === 'userdata') { page.status(WYRMFIRE_TEXT.userClips, true); return; }
    const freedoom = !!captured && captured.wyrmfire === 'freedoom';
    gifBtn.disabled = true;
    const frames = [], t0 = performance.now(), STEP = 40;   // 25 frames a second: a 4 cs delay each
    let next = t0, left = GIF_SECONDS;
    gifBtn.textContent = `Recording… ${left} s`;
    const take = (now) => {
      while (now >= next && frames.length < GIF_SECONDS * 25) {
        const f = session.shownMachine.render();
        frames.push({ width: f.width, height: f.height, data: Uint8Array.from(f.data), table: Uint32Array.from(f.table) });
        next += STEP;
      }
      const sec = GIF_SECONDS - Math.floor((now - t0) / 1000);
      if (sec !== left && sec > 0) { left = sec; gifBtn.textContent = `Recording… ${left} s`; }
      if (frames.length < GIF_SECONDS * 25) { requestAnimationFrame(take); return; }
      try {
        // the comment: CLOADM's, and for the Freedoom level the same credit line its PNG carries
        const gif = gifFromFrames(frames, { scale: 2, delay: 4, comment: freedoom ? `Recorded in CLOADM. WYRMFIRE ${WYRM_TEXT.level}` : 'Recorded in CLOADM' });
        const name = `${captured ? captured.base : 'CLOADM'}.gif`;
        page.download(name, new Blob([gif.bytes], { type: 'image/gif' }));
        page.status(`Saved ${name}: ${GIF_SECONDS} seconds, ${(gif.bytes.length / 1024).toFixed(0)} KB.${freedoom ? ` ${WYRM_TEXT.level}.` : ''}`);
      } catch (e) { page.status(`Could not make the GIF: ${e.message}`, true); }
      gifBtn.disabled = false; gifLabel();
    };
    requestAnimationFrame(take);
  };

  // ---------------- copy as text for a forum ----------------
  // the link with a one-line description, as BBCode and as Markdown (js/share-text.js forumText); text only, no image tag.
  // Its link is forumUrl(): what the preview shows is exactly what its Copy copies.
  // (in program mode the stage's own "Copy as text for a forum", the program's text in a code block, is the forum text:
  // this disclosure, the moment's link, steps aside)
  function syncForum() {
    $('shareForum').hidden = programMode;
    if (!captured || captured.refusal || (!captured.link && !captured.untouched)) {
      for (const id of ['forumBbcode', 'forumMarkdown']) $(id).textContent = '';
      for (const id of ['btnForumBbcodeCopy', 'btnForumMarkdownCopy']) $(id).disabled = true;
      return;
    }
    // a WYRMFIRE moment's link starts the game afresh (Session.shareUrl), so it is described the way a program page is
    const wyrm = !!captured.wyrmfire, program = wyrm || (!short && !!captured.untouched);
    const url = forumUrl(), name = wyrm ? 'WYRMFIRE' : program ? captured.untouched.name : captured.machine;
    const f = forumText(url, name, { program });
    $('forumBbcode').textContent = f.bbcode; $('forumMarkdown').textContent = f.markdown;
    for (const id of ['btnForumBbcodeCopy', 'btnForumMarkdownCopy']) $(id).disabled = false;
  }
  const forumCopy = (which, btn) => async () => {
    if (!captured) return;
    const b = $(btn);
    syncForum();
    const text = $(which === 'bbcode' ? 'forumBbcode' : 'forumMarkdown').textContent;
    try { await navigator.clipboard.writeText(text); b.textContent = 'Copied'; }
    catch (e) { getSelection().selectAllChildren($(which === 'bbcode' ? 'forumBbcode' : 'forumMarkdown')); b.textContent = 'Press Ctrl+C'; }
    setTimeout(() => { b.textContent = 'Copy'; }, 2000);
  };
  $('btnForumBbcodeCopy').onclick = forumCopy('bbcode', 'btnForumBbcodeCopy');
  $('btnForumMarkdownCopy').onclick = forumCopy('markdown', 'btnForumMarkdownCopy');
  // ---------------- share your program ----------------
  // In program mode the caption's name is "LIST", which is never cut: where the prefix and it don't both fit (a short
  // landscape screen's narrow column), the prefix gives way, as a program page's caption has none. Measured on the laid
  // out caption, so it is decided again whenever the layout can change (place(): a resize, the view opening).
  function fitCaption() {
    if (!programMode || !captured || !captured.programLink) return;
    const prefix = $('sharePrefix'), name = $('shareName');
    prefix.hidden = false;
    if (name.scrollWidth > name.clientWidth + 0.5) prefix.hidden = true;
  }
  // The program card (only with a BASIC program in memory) and what program mode changes: the heading, the picture
  // (the first lines LIST shows, in the machine's font), the long link's field, and "More ways to share". One owner for
  // all of it, so a capture and the switch cannot leave the screen half in one mode.
  function syncProgram() {
    const p = captured && captured.program, on = !!p && programMode;
    $('programCard').hidden = !p;
    if (p) {
      $('programLines').textContent = `${p.lines} line${p.lines === 1 ? '' : 's'}`;
      $('btnProgramMode').textContent = on ? 'Share the whole moment instead' : 'Share the program instead';
      $('programWhy').textContent = on && p.refusal ? p.refusal : '';
    }
    view.classList.toggle('program-mode', on);
    $('shareHeading').textContent = on ? 'Share your program' : 'Share this moment';
    $('programMore').hidden = !on || !captured.programLink;
    $('shareExtra').hidden = on;
    $('shareLink').value = !captured ? '' : on ? captured.programLink : captured.link;
    // the picture: the listing as LIST shows it first, or the moment's own frame
    const pic = $('sharePicture');
    if (on && captured.programLink) new CanvasPresenter(pic).present(textScreenFrame(listingRows(p.text)));
    else if (captured) { pic.width = captured.shot.width; pic.height = captured.shot.height; pic.getContext('2d').drawImage(captured.shot, 0, 0); }
    pic.setAttribute('aria-label', on && captured.programLink ? `The first lines LIST shows: ${listingRows(p.text).join(' / ')}` : 'Captured picture: link preview, rendered from the real frame');
    syncLongNote();
  }
  $('btnProgramMode').onclick = () => {
    if (!captured || !captured.program) return;
    programMode = !programMode;
    // a link made in the other mode is not this one's: the made field goes, and the next tap makes this mode's
    short = null; fallbackWhy = '';
    $('shortMade').hidden = true; $('shareShort').value = ''; $('sharePreview').disabled = false;
    syncProgram();
  };
  // the program's text for a forum post: a ``` (Markdown) or [code] (BBCode) block, then the link (the short link when
  // one was made here, else the long link: nothing is uploaded for it)
  $('btnProgramForum').onclick = () => {
    if (!captured || !captured.programLink) return;
    const link = short ? short.url : captured.programLink, text = captured.program.text;
    const bb = view.querySelector('input[name="forumStyle"]:checked').value === 'bb';
    copyText(bb ? `[code]\n${text}\n[/code]\n${link}\n` : `\`\`\`\n${text}\n\`\`\`\n${link}\n`, 'Program text copied');
  };
  // the listing as a text file (one "NUMBER TEXT" line per program line), which CLOADM and BASIC's own loaders read
  $('btnProgramBas').onclick = () => {
    if (!captured || !captured.programLink) return;
    page.download(`${captured.base}.bas`, new TextEncoder().encode(`${captured.program.text}\n`), 'text/plain');
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
