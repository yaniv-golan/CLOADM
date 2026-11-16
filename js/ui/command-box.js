/*
 * The "Ask Claude or find a command" box:
 * Ctrl+K (Cmd+K on a Mac) anywhere opens it. As you type, the page's commands that match come first, and
 * "Ask Claude: …" is always last; ↑↓ choose, Enter runs the command or asks, Esc closes. A command runs on the page
 * and is never sent to Claude. Asking opens the side panel, or full screen while the welcome menu is on screen.
 * The command list is the page's own buttons: each entry clicks one, so
 * a command does exactly what its button does; "Take snapshot" (the Glossary's word) saves the snapshot file the
 * Share screen's "Download snapshot" saves.
 */
import { $, ESC } from './page.js';

// [label, what it does, more words it answers to, the button it presses (or what it does, for one with no button)]
const COMMANDS = [
  ['Take snapshot', 'saves everything, including your program, as a file', 'snapshot save state program keep', takeSnapshot],
  ['Share', 'a share link, a clip, a screenshot', 'share link clip screenshot capture embed', 'btnShare'],
  ['Open a program, tape, disk or cartridge…', 'opens a file', 'load open file insert program tape disk cartridge cas bin', 'btnLoad'],
  ['Save the tape as .WAV', 'the tape in the deck, or the last recording', 'save tape wav cassette record', 'btnTapeWav'],
  ['Record to tape', 'CSAVE becomes a .CAS file', 'record tape cas csave save', 'btnRecord'],
  ['Reset', 'like the reset button', 'reset restart', 'btnReset'],
  ['Switch off and on', 'clears memory; the tape and cartridge stay in', 'switch off on power cycle hard reset clear', 'btnHardReset'],
  ['Pause or resume', 'stops the machine where it is', 'pause resume stop freeze', 'btnPause'],
  ['Turbo', 'runs as fast as possible', 'turbo fast speed', 'btnTurbo'],
  ['Fullscreen', 'the screen fills the window', 'fullscreen full screen big', 'btnFull'],
  ['Open the Library', 'your tapes, disks and programs', 'library tapes disks programs files', 'navLibrary'],
  ['Open the Debugger', 'assembler and disassembly', 'debugger assembler disassemble debug', 'navDebugger'],
  ['Display settings', 'the CRT look, colours, size', 'display crt colour color artifact screen look', 'tab-display'],
  ['Input settings', 'keyboard, joysticks, mouse', 'input keyboard joystick gamepad mouse keys', 'tab-input'],
  ['POKEs', 'cheats and memory pokes', 'pokes poke cheats memory', 'tab-pokes'],
  ['Machine settings', 'ROMs, RAM, options, settings file', 'machine settings roms ram options', 'tab-machine'],
  ['Chat with Claude, full screen', 'the machine becomes Claude', 'chat claude full screen', null],
  ['What is this code doing?', 'asks Claude about the code at the program counter', 'debugger disassembly code explain routine', (page, claude) => claude.askAboutCode()],
];

const FILLER = new Set(['a', 'an', 'the', 'my', 'me', 'to', 'of', 'it', 'this', 'please', 'for', 'in', 'on']);

async function takeSnapshot(page) {
  try {
    const f = await page.session.snapshotFile();
    page.download(f.name, f.bytes, 'application/gzip');
    page.status(`Saved ${f.name}. Drop it on CLOADM to restore it.`);
  } catch (e) { page.status(e.message, true); }
}

export function setupCommandBox(page, claude) {
  const { session } = page;
  const box = $('cmdBox'), input = $('cmdInput'), list = $('cmdList');
  let options = [], selected = 0, back = null;
  const mac = /Mac|iPhone|iPad/.test(navigator.platform || '');
  $('askKbd').textContent = mac ? '⌘K' : 'Ctrl K';

  // the commands matching the text: every word (but the little ones: "save my prog") starts a word of the label or
  // of its other words
  function matches(q) {
    const words = q.toLowerCase().split(/\s+/).filter((w) => w && !FILLER.has(w));
    if (!words.length) return [];
    return COMMANDS.filter(([label, , more, id]) => {
      if (typeof id === 'string' && !$(id)) return false;
      const hay = `${label} ${more}`.toLowerCase().split(/[^a-z0-9.]+/);
      return words.every((w) => hay.some((h) => h.startsWith(w)));
    }).slice(0, 6);
  }
  function draw() {
    const q = input.value.trim();
    const cmds = matches(q);
    options = [...cmds.map((c) => ({ kind: 'cmd', c })), ...(q ? [{ kind: 'ask', q }] : [])];
    selected = Math.min(selected, Math.max(0, options.length - 1));
    const out = [];
    if (cmds.length) out.push(Object.assign(document.createElement('div'), { className: 'group', textContent: 'Commands' }));
    options.forEach((o, i) => {
      if (o.kind === 'ask') out.push(Object.assign(document.createElement('div'), { className: 'group claude', textContent: 'Claude' }));
      const row = document.createElement('div');
      row.setAttribute('role', 'option');
      row.id = `cmdOpt${i}`;
      row.setAttribute('aria-selected', String(i === selected));
      if (o.kind === 'ask') {
        row.className = 'ask';
        const a = document.createElement('span'); a.textContent = `Ask Claude: "${o.q}"`;
        const h = document.createElement('span'); h.className = 'hint'; h.textContent = session.welcomeRunning ? 'opens full screen' : 'opens the side panel';
        row.append(a, h);
      } else {
        const a = document.createElement('span'); a.textContent = o.c[0];
        const h = document.createElement('span'); h.className = 'hint'; h.textContent = o.c[1];
        row.append(a, h);
      }
      row.onmousemove = () => { if (selected !== i) { selected = i; draw(); } };
      row.onclick = () => { selected = i; run(); };
      out.push(row);
    });
    list.replaceChildren(...out);
    input.setAttribute('aria-activedescendant', options.length ? `cmdOpt${selected}` : '');
  }
  // on a phone the app bar is taller than the box's usual place (its Ask Claude and Menu sit where the box would):
  // there the box opens just under the bar, or at the top when the bar has scrolled away 
  const phone = matchMedia('(max-width: 700px), (orientation: landscape) and (max-height: 500px)');
  function place() {
    const bar = $('appbar').getBoundingClientRect();
    box.style.top = phone.matches ? `${Math.max(12, Math.round(bar.bottom) + 8)}px` : '';
  }
  function openBox() {
    back = document.activeElement;
    place();
    box.hidden = false;
    input.value = '';
    selected = 0;
    draw();
    input.focus();
  }
  // Esc with the focus outside the box (its own input takes Esc first, below)
  page.onEscape(ESC.menu, () => !box.hidden, () => closeBox());
  function closeBox({ refocus = true } = {}) {
    box.hidden = true;
    if (refocus && back && back.isConnected) back.focus();
    back = null;
  }
  function run() {
    const o = options[selected];
    if (!o) return;
    closeBox({ refocus: o.kind !== 'ask' });
    if (o.kind === 'ask') {
      // the welcome menu on screen: full screen; otherwise the side panel
      if (session.welcomeRunning) claude.openFull().then((c) => { if (c) claude.ask(o.q); });
      else claude.openPanel(o.q);
      return;
    }
    const id = o.c[3];
    if (!id) { claude.openFull(); return; }
    if (typeof id === 'function') { id(page, claude); return; }
    $(id).click();
  }
  input.addEventListener('input', () => { selected = 0; draw(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); selected = Math.min(options.length - 1, selected + 1); draw(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); selected = Math.max(0, selected - 1); draw(); }
    else if (e.key === 'Enter') { e.preventDefault(); run(); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeBox(); }
  });
  // Ctrl+K / Cmd+K anywhere, before the machine's keyboard sees it
  addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && (e.key === 'k' || e.key === 'K')) {
      e.preventDefault(); e.stopPropagation();
      if (box.hidden) openBox(); else closeBox();
    }
  }, true);
  addEventListener('pointerdown', (e) => { if (!box.hidden && !box.contains(e.target)) closeBox({ refocus: false }); }, true);
  return { open: openBox, close: closeBox };
}
