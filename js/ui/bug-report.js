/*
 * "Copy bug report" (the command box, and Help's "Copy a bug report →", which opens play/#bug-report): a dialog that
 * shows the report before anything is copied. Session.bugReport writes it (js/bugreport.js): the version stamp, the
 * machine and its options, the browser, the file loaded last (name and SHA-256) and, only when "Include a snapshot"
 * is ticked (off by default), the moment as the Share screen's ROM-free link. Never the Claude key, a ROM's bytes or
 * file names, or a WAD. Copy puts exactly the text shown on the clipboard; nothing is sent anywhere.
 */
import { $ } from './page.js';

export function setupBugReport(page) {
  const { session } = page;
  const dlg = $('bugReport'), text = $('bugText'), snap = $('bugSnap');
  let back = null, seq = 0;
  async function fill() {
    const n = ++seq;
    text.textContent = 'Writing the report…';
    try {
      const r = await session.bugReport({ base: new URL('play/', document.baseURI).href, browser: navigator.userAgent, snapshot: snap.checked });
      if (n === seq) text.textContent = r.text;
    } catch (e) { if (n === seq) text.textContent = `The report could not be written: ${e.message}`; }
  }
  function open() {
    if (dlg.open) return;
    back = document.activeElement;
    snap.checked = false;   // off every time: a snapshot goes in only when asked for, for this report
    $('btnBugCopy').textContent = 'Copy';
    dlg.hidden = false;
    dlg.showModal();
    $('btnBugCopy').focus();
    return fill();
  }
  function close() { dlg.close(); }
  dlg.addEventListener('close', () => { dlg.hidden = true; if (back && back.isConnected) back.focus(); back = null; });
  snap.addEventListener('change', fill);
  $('btnBugClose').onclick = close;
  $('btnBugCopy').onclick = async () => {
    try { await navigator.clipboard.writeText(text.textContent); $('btnBugCopy').textContent = 'Copied'; page.toast('Bug report copied: paste it into a new issue'); }
    catch (e) { getSelection().selectAllChildren(text); $('btnBugCopy').textContent = 'Press Ctrl+C'; }
  };
  // play/#bug-report (Help's link): opens once the visit has started, and the address goes back to plain /play/
  const fromAddress = () => {
    if (location.hash !== '#bug-report') return;
    history.replaceState(history.state, '', location.pathname + location.search);
    open();
  };
  addEventListener('hashchange', fromAddress);
  return { open, close, ready: fromAddress };
}
