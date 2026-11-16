/*
 * The on-screen keyboard: phones and tablets
 * can't type otherwise. In landscape on a phone it is the design's split thumb keyboard, the screen between its
 * halves with BREAK, CLEAR, Hide keys and Menu under it; in portrait (or on a larger touch screen) a ten-column
 * keyboard under the screen. Keys go to the machine through HostInput.touch (the KeyQueue holds each press long
 * enough for the machine to see it; the no-ROM stub gets the character). SHIFT is sticky: it shifts the next key.
 *
 * Shown by itself on touch screens (a coarse pointer, touch points without hover, or a first touch); the Input tab's "On-screen keyboard" setting says
 * Automatic, Always or Never, and "Hide keys" hides it for the visit (a Keys button brings it back).
 */
import { charToKeys } from '../machines/keyboards.js';
import { $ } from './page.js';

// label -> machine key name, and the code the stub reads (ASCII; the arrows as BASIC's codes)
const SPECIAL = {
  '↑': ['UP', 94], '↓': ['DOWN', 10], '←': ['LEFT', 8], ENTER: ['ENTER', 13], SPACE: ['SPACE', 32],
  BREAK: ['BREAK', 3], CLEAR: ['CLEAR', 12],
};
// the character SHIFT + key types (the Dragon layout's shifted symbols), for the stub
const SHIFTED = {};
for (let c = 32; c < 127; c++) { const ch = String.fromCharCode(c), k = charToKeys(ch); if (k && k.shift && !SHIFTED[k.key]) SHIFTED[k.key] = ch; }

const SPLIT = {
  left: ['1 2 3 4 5 6', '↑ Q W E R T', '↓ A S D F G', 'SHIFT Z X C V B', '_'],
  right: ['7 8 9 0 : -', 'Y U I O P @', 'H J K L ; ENTER', 'N M , . / ←', '_ SHIFT'],
};
const FULL = ['1 2 3 4 5 6 7 8 9 0', 'Q W E R T Y U I O P', 'A S D F G H J K L ;', 'Z X C V B N M , . /', 'SHIFT ↑ ↓ ← _ : - @ ENTER'];

export function setupTouchKeys(page, { input }) {
  const { session } = page;
  const box = $('touchKeys');
  let shift = false, n = 0;

  function key(label) {
    const t = label === '_' ? 'SPACE' : label;
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'tk' + (t.length > 2 ? ' wide' : '') + (t === 'SPACE' ? ' space' : '');
    b.textContent = t;
    b.dataset.key = t;
    const id = `k${n++}`;
    const press = (e) => {
      e.preventDefault();
      if (t === 'SHIFT') { shift = !shift; for (const s of box.querySelectorAll('[data-key="SHIFT"]')) s.setAttribute('aria-pressed', String(shift)); return; }
      const sp = SPECIAL[t], name = sp ? sp[0] : t;
      let code = sp ? sp[1] : t.charCodeAt(0);
      if (shift && !sp && SHIFTED[name]) code = SHIFTED[name].charCodeAt(0);
      input.touch(id, shift ? ['SHIFT', name] : [name], code, true);
      b.classList.add('down');
      try { b.setPointerCapture(e.pointerId); } catch (err) { /* not a pointer we can capture */ }
      page.audio.start();
    };
    const release = () => {
      if (!b.classList.contains('down')) return;
      b.classList.remove('down');
      input.touch(id, null, 0, false);
      if (shift) { shift = false; for (const s of box.querySelectorAll('[data-key="SHIFT"]')) s.setAttribute('aria-pressed', 'false'); }
    };
    if (t === 'SHIFT') b.setAttribute('aria-pressed', 'false');
    b.addEventListener('pointerdown', press);
    for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture']) b.addEventListener(ev, release);
    b.addEventListener('contextmenu', (e) => e.preventDefault());
    return b;
  }
  const rows = (list) => list.map((r) => { const row = document.createElement('div'); row.className = 'tkrow'; for (const l of r.split(' ')) row.append(key(l)); return row; });
  $('touchLeft').append(...rows(SPLIT.left));
  $('touchRight').append(...rows(SPLIT.right));
  $('touchFull').append(...rows(FULL));
  for (const [id, label] of [['tkBreak', 'BREAK'], ['tkClear', 'CLEAR']]) $(id).replaceWith(Object.assign(key(label), { id }));

  // shown: Automatic (touch screens), Always or Never; "Hide keys" for this visit
  // a touch screen: a coarse pointer, or touch points and no hover, or a touch seen on the page
  const coarse = matchMedia('(pointer: coarse)'), noHover = matchMedia('(hover: none)');
  let touchSeen = false;
  // (once a touch screen, always one for this visit: the keyboard doesn't come and go with a passing media change)
  const touchScreen = () => (touchSeen = touchSeen || coarse.matches || (navigator.maxTouchPoints > 0 && noHover.matches));
  addEventListener('pointerdown', (e) => { if (e.pointerType === 'touch' && !touchSeen) { touchSeen = true; apply(); } }, { capture: true });
  let hidden = false;
  // standing aside: the page has a text field the person types in with the phone's own keyboard (the chat's API
  // key form), so the machine keyboard steps out of its way until the field is gone
  let aside = false;
  const mode = () => session.store.get('touchKeys') || 'auto';
  function apply() {
    const on = !hidden && !aside && (mode() === 'on' || (mode() === 'auto' && touchScreen()));
    box.hidden = !on;
    document.body.classList.toggle('touch-keys', on);
    $('btnShowKeys').hidden = !hidden;   // only after Hide keys (the Input tab has the setting)
    $('selTouchKeys').value = mode();
  }
  coarse.addEventListener('change', apply);
  noHover.addEventListener('change', apply);
  $('selTouchKeys').onchange = (e) => { session.store.set('touchKeys', e.target.value); hidden = false; apply(); };
  $('tkHide').onclick = () => { hidden = true; apply(); };
  $('btnShowKeys').onclick = () => { hidden = false; apply(); };
  // Menu opens the app bar's menu; in a phone's chat (body.chat-phone, js/ui/claude.js) the app bar gives way to the
  // chat bar, and the button is its "← Emulator"
  $('tkMenu').onclick = () => { $(document.body.classList.contains('chat-phone') ? 'btnClaudeBack' : 'btnMenu').click(); };
  apply();
  const standAside = (on) => { if (aside !== !!on) { aside = !!on; apply(); } };
  return { apply, standAside };
}
