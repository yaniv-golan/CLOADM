/*
 * The Share screen: a view of /play/ at #share, like the
 * Library. "Capture & share" captures the moment (the snapshot and the picture at that instant) and opens it.
 *
 * Share this moment: the picture as a link preview; a link that opens exactly here (Session.snapshotLink: the
 * snapshot rides in the URL's fragment, which never reaches a server; js/ui/snapshot-panel.js opens it). The
 * snapshot holds no byte of a ROM or cartridge (Session.shareFile): it names them, and the person opening it needs
 * their own; the card under the link says which;
 * a 6-second clip of the screen (MediaRecorder: MP4 where the browser records it, WebM otherwise, and the button
 * says which); the screenshot at true pixels; the snapshot file; and what someone without the ROMs will see.
 * Embed: the iframe and script for a blog post, written by js/config.js (buildUrl) from the machine, program
 * and options chosen here. Your settings: export and import (js/ui/settings-file.js), never ROMs.
 */
import { profiles } from '../machines/profiles.js';
import { buildUrl } from '../config.js';
import { CanvasPresenter } from '../video/canvas.js';
import { $ } from './page.js';

const time = (d) => d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const CLIP_SECONDS = 6;
// what the browser can record, best first
const clipType = () => {
  if (typeof MediaRecorder === 'undefined') return null;
  for (const [type, ext, label] of [['video/mp4;codecs=avc1', 'mp4', 'MP4'], ['video/mp4', 'mp4', 'MP4'], ['video/webm;codecs=vp9', 'webm', 'WebM'], ['video/webm', 'webm', 'WebM']]) {
    if (MediaRecorder.isTypeSupported(type)) return { type, ext, label };
  }
  return null;
};

export function setupShare(page) {
  const { session } = page;
  const view = $('share');
  let captured = null;   // { file: { name, bytes } | null, png: Blob, link | null, base: file name without extension }

  // ---------------- the view (#share) ----------------
  const isOpen = () => location.hash === '#share';
  function show() {
    const open = isOpen();
    document.body.classList.toggle('share-open', open);
    view.hidden = !open;
    if (open && !captured) capture().catch((e) => page.status(e.message, true));
    if (open) window.scrollTo(0, 0);
  }
  page.onView(show);
  $('shareBack').onclick = (e) => { e.preventDefault(); page.closeView(); };
  $('btnShare').onclick = async () => {
    try { await capture(); } catch (e) { page.status(e.message, true); return; }
    page.openView('#share');
  };

  // ---------------- share this moment ----------------
  async function capture() {
    const m = session.machine, frame = m.render();
    // the picture at true pixels, captured with the snapshot so both show the same instant
    const c = document.createElement('canvas');
    new CanvasPresenter(c).present(frame);
    // the shared snapshot: no byte of a ROM or cartridge, only their names (Session.shareFile, AGENTS rule 1).
    // NitrOS-9's memory is the user's own NitrOS-9: its link boots NitrOS-9 from the recipient's image instead
    const n9 = session.nitros9Running;
    const file = n9 ? null : await session.shareFile();
    const link = n9 ? session.shareUrl(location.href) : await session.snapshotLink(location.href, file);
    const png = await new Promise((ok) => c.toBlob(ok, 'image/png'));
    captured = { file, png, link, base: file ? file.name.replace(/\.cloadm$/, '') : `${m.profile.name.replace(/[^A-Za-z0-9]+/g, '')}-NitrOS-9` };
    $('btnShareDownload').disabled = !file;
    const pic = $('sharePicture');
    pic.width = c.width; pic.height = c.height;
    pic.getContext('2d').drawImage(c, 0, 0);
    $('shareTitle').textContent = `${m.profile.name.replace(/^Tandy /, '')} · CLOADM`;
    $('shareWhen').textContent = `${location.host || 'cloadm.dev'} · link preview, rendered from the real frame · captured at ${time(new Date())}`;
    $('shareLink').value = link;
    $('shareCopied').textContent = file ? `The link holds a ${(file.bytes.length / 1024).toFixed(0)} KB snapshot.` : 'The link boots NitrOS-9; it holds no snapshot.';
    if (!file) {
      $('shareRecipient').textContent = 'They need their own NitrOS-9 DriveWire image in their library: the link boots NitrOS-9 on the CoCo 3 from it, and holds no part of yours.';
      syncEmbed(m.id);
      return;
    }
    // what the person opening it needs: their own copies of the ROMs and cartridge it names, or nothing
    const needs = file.needs.map((x) => x.label);
    $('shareRecipient').innerHTML = '';
    if (needs.length) {
      const b = document.createElement('strong'); b.textContent = `They need their own ${needs.join(' and ')}.`;
      $('shareRecipient').append(b, ' The link holds none of them, only which ones (and which version) this snapshot used. With the same ones it opens exactly here; without them CLOADM says what to add.');
    } else $('shareRecipient').textContent = 'It ran without ROMs, so it opens anywhere.';
    // a tape being recorded is not in the link (its pulse timings could carry ROM code: js/media/romrefs.js)
    if (file.dropped.includes('deck.recording')) $('shareRecipient').append(' The tape being recorded is not in the link: it opens with the recorder stopped.');
    syncEmbed(m.id);
  }
  $('btnShareCopy').onclick = async () => {
    const url = $('shareLink').value;
    // a toast on this page ("Share link copied"); the line under the link keeps saying what it holds
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
    presenter.present(session.machine.render());
    let drawing = true;
    const draw = () => { if (!drawing) return; presenter.present(session.machine.render()); requestAnimationFrame(draw); };
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
    return buildUrl(embedBase(), cfg);
  }
  function renderEmbed() {
    const src = embedSrc();
    $('embedFrame').textContent = `<iframe src="${src}"\n  width="640" height="480"\n  allow="gamepad; fullscreen"></iframe>`;
    $('embedScript').textContent = `<script src="${scriptUrl()}"></script>\n<script type="module">\n  const m = await CLOADM.attach(document.querySelector('iframe'));\n  await m.type('POKE 65495,0\\n');\n  m.on('frame', (f) => { /* … */ });\n</script>`;
    $('embedAutorun').disabled = !$('embedProgram').value.trim();
  }
  function syncEmbed(id) { sel.value = id; renderEmbed(); }
  for (const id of ['embedMachine', 'embedProgram', 'embedAutorun', 'embedCrt']) $(id).addEventListener('input', renderEmbed);
  const copy = (id, btn) => async () => {
    try { await navigator.clipboard.writeText($(id).textContent); $(btn).textContent = 'Copied'; }
    catch (e) { getSelection().selectAllChildren($(id)); $(btn).textContent = 'Press Ctrl+C'; }
    setTimeout(() => { $(btn).textContent = 'Copy'; }, 2000);
  };
  $('btnEmbedFrameCopy').onclick = copy('embedFrame', 'btnEmbedFrameCopy');
  $('btnEmbedScriptCopy').onclick = copy('embedScript', 'btnEmbedScriptCopy');
  // the builder starts on the machine in use
  session.on((ev) => { if (ev === 'machine' && !isOpen()) syncEmbed(session.machine.id); });
  if (session.machine) syncEmbed(session.machine.id); else renderEmbed();

  show();
  return { open: () => $('btnShare').click(), embedSrc };
}
