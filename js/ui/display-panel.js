/*
 * The Display tab: CRT · composite or Sharp · RGB, the CRT's curvature
 * and phosphor glow, the NTSC artifact colours, integer scaling and the picture's shape. The settings live in
 * the Session (Session.display, setDisplay); this panel shows them and changes them.
 */
import { $ } from './page.js';

export function setupDisplayPanel(page) {
  const { session } = page;
  function show() {
    const d = session.display;
    $('btnCrt').setAttribute('aria-pressed', String(d.view === 'crt'));
    $('btnSharp').setAttribute('aria-pressed', String(d.view === 'sharp'));
    $('monitor').classList.toggle('crt', d.view === 'crt');
    for (const k of ['curvature', 'glow']) {
      const input = $(`rng-${k}`);
      input.value = d[k];
      $(`val-${k}`).textContent = `${d[k]}%`;
      input.disabled = d.view !== 'crt' || !page.crtAvailable;
    }
    $('selPhase').value = String(d.phase);
    $('lblPhase').hidden = !session.machine || !session.hasArtifactPhase;
    $('selPhase').disabled = d.view !== 'crt';
    $('chkInteger').checked = d.integer;
    $('selAspect').value = d.aspect;
    // the second screen (the Dragon 64 Plus's 80-column board); hidden on a machine with only one
    $('lblScreen').hidden = !session.hasTwoScreens;
    $('selScreen').value = d.screen;
    $('crtNote').hidden = page.crtAvailable;
  }
  const set = (changes) => { page.attempt(() => session.setDisplay(changes)); };
  $('btnCrt').onclick = () => set({ view: 'crt' });
  $('btnSharp').onclick = () => set({ view: 'sharp' });
  for (const k of ['curvature', 'glow']) $(`rng-${k}`).oninput = (e) => set({ [k]: Number(e.target.value) });
  $('selPhase').onchange = (e) => set({ phase: Number(e.target.value) });
  $('chkInteger').onchange = (e) => set({ integer: e.target.checked });
  $('selAspect').onchange = (e) => set({ aspect: e.target.value });
  $('selScreen').onchange = (e) => set({ screen: e.target.value });
  session.on((ev) => { if (ev === 'display' || ev === 'machine') show(); });
  show();
}
