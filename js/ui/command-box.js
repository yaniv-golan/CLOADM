/*
 * The "Ask Claude or find a command" box:
 * Ctrl+K (Cmd+K on a Mac) anywhere opens it. As you type, the page's commands that match come first, and
 * "Ask Claude: …" is always last; ↑↓ choose, Enter runs the command or asks, Esc closes. A command runs on the page
 * and is never sent to Claude. Asking opens the side panel, or full screen while the welcome menu is on screen.
 * With nothing typed it lists every command, by group, with no row chosen until the first ↓. It also opens from the
 * app bar's "Commands…" (and the touch keys' menu). The command list is the page's own buttons: each entry clicks one, so
 * a command does exactly what its button does; "Take snapshot" (the Glossary's word) saves the snapshot file the
 * Share screen's "Download snapshot" saves.
 */
import { $, ESC, safeArea } from './page.js';

// [label, what it does, more words it answers to, the button it presses (or what it does, for one with no button), group]
// In the order the empty box lists them (the groups in GROUPS' order). A command with a keyboard shortcut would
// show it in its row's .hint; none has one yet.
export const GROUPS = ['Claude', 'Files', 'Views', 'Settings', 'Machine'];
export const COMMANDS = [
  ['Chat with Claude, full screen', 'the machine becomes Claude', 'chat claude full screen', null, 'Claude'],
  ['What is this code doing?', 'asks Claude about the code at the program counter', 'debugger disassembly code explain routine', (page, claude) => claude.askAboutCode(), 'Claude'],
  ['Take snapshot', 'saves everything, including your program, as a file', 'snapshot save state program keep', takeSnapshot, 'Files'],
  ['Open a program, tape, disk or cartridge…', 'opens a file', 'load open file insert program tape disk cartridge cas bin', 'btnLoad', 'Files'],
  ['Insert a disk…', 'a disk image into the first free drive', 'disk drive mount vdk dsk floppy', (page) => page.drives.pick(), 'Files'],
  ['New blank disk', 'an empty disk in the first free drive', 'disk drive new blank empty format floppy', (page) => page.drives.blank(), 'Files'],
  ['Eject disk', 'takes the disk out of its drive', 'disk drive eject remove floppy', (page) => page.drives.eject(), 'Files'],
  ['Save the tape as .WAV', 'the tape in the deck, or the last recording', 'save tape wav cassette record', 'btnTapeWav', 'Files'],
  ['Record to tape', 'CSAVE becomes a .CAS file', 'record tape cas csave save', 'btnRecord', 'Files'],
  ['Share', 'a share link, a clip, a screenshot', 'share link clip screenshot capture embed', 'btnShare', 'Files'],
  ['Open the Library', 'your tapes, disks and programs', 'library tapes disks programs files', 'navLibrary', 'Views'],
  ['Open the Debugger', 'assembler and disassembly', 'debugger assembler disassemble debug', 'navDebugger', 'Views'],
  ['Your ROMs', 'see, add or remove ROMs', 'basic firmware add', 'btnManageRoms', 'Settings'],
  ['Display settings', 'the CRT look, colours, size', 'display crt colour color artifact screen look', 'tab-display', 'Settings'],
  ['Input settings', 'keyboard, joysticks, mouse', 'input keyboard joystick gamepad mouse keys', 'tab-input', 'Settings'],
  ['POKEs', 'cheats and memory pokes', 'pokes poke cheats memory', 'tab-pokes', 'Settings'],
  ['Machine settings', 'ROMs, RAM, options, settings file', 'machine settings ram cpu options', 'tab-machine', 'Settings'],
  ['Pause or resume', 'stops the machine where it is', 'pause resume stop freeze', 'btnPause', 'Machine'],
  ['Turbo', 'runs as fast as possible', 'turbo fast speed', 'btnTurbo', 'Machine'],
  ['Fullscreen', 'the screen fills the window', 'fullscreen full screen big', 'btnFull', 'Machine'],
  ['Reset', 'like the reset button', 'reset restart', 'btnReset', 'Machine'],
  ['Switch off and on', 'clears memory; the tape and cartridge stay in', 'switch off on power cycle hard reset clear', 'btnHardReset', 'Machine'],
];
const CLAUDE_NOTE = "Claude reads this emulated machine's screen text and memory, and acts on it only with your permission.";

const FILLER = new Set(['a', 'an', 'the', 'my', 'me', 'to', 'of', 'it', 'this', 'please', 'for', 'in', 'on']);

async function takeSnapshot(page) {
  try {
    const f = await page.session.snapshotFile();
    page.download(f.name, f.bytes, 'application/gzip');
    // with the chat full screen the file is the BASIC session behind it, and the message says so (Session.snapshotFile)
    page.status(f.saved ? `Saved ${f.saved} as ${f.name}: the chat is what is on screen, and the chat is not in a snapshot. Drop it on CLOADM to restore it.`
      : `Saved ${f.name}. Drop it on CLOADM to restore it.`);
  } catch (e) { page.status(e.message, true); }
}

export function setupCommandBox(page, claude) {
  const { session } = page;
  const box = $('cmdBox'), input = $('cmdInput'), list = $('cmdList');
  let options = [], selected = -1, back = null;
  const mac = /Mac|iPhone|iPad/.test(navigator.platform || '');
  $('askKbd').textContent = mac ? '⌘K' : 'Ctrl K';
  $('navCmdKbd').textContent = mac ? '⌘K' : 'Ctrl K';
  $('askEmptyKbd').textContent = mac ? '⌘K' : 'Ctrl K';

  // the commands matching the text: every word (but the little ones: "save my prog") starts a word of the label or
  // of its other words
  const available = ([, , , id]) => !(typeof id === 'string' && !$(id));
  function matches(q) {
    const words = q.toLowerCase().split(/\s+/).filter((w) => w && !FILLER.has(w));
    if (!q) return COMMANDS.filter(available);   // the empty box lists every command there is
    if (!words.length) return [];
    return COMMANDS.filter((c) => {
      if (!available(c)) return false;
      const [label, , more] = c;
      const hay = `${label} ${more}`.toLowerCase().split(/[^a-z0-9.]+/);
      return words.every((w) => hay.some((h) => h.startsWith(w)));
    }).slice(0, 6);
  }
  const div = (cls, text, id) => Object.assign(document.createElement('div'), { className: cls, textContent: text, ...(id ? { id } : {}) });
  function optionRow(o, i) {
    const row = document.createElement('div');
    row.setAttribute('role', 'option');
    row.id = `cmdOpt${i}`;
    row.setAttribute('aria-selected', String(i === selected));
    const a = document.createElement('span'), h = document.createElement('span');
    h.className = 'hint';
    if (o.kind === 'ask') {
      row.className = 'ask';
      a.textContent = `Ask Claude: "${o.q}"`;
      h.textContent = session.welcomeRunning ? 'opens full screen' : 'opens the side panel';
    } else { a.textContent = o.c[0]; h.textContent = o.c[1]; }
    row.append(a, h);
    row.onmousemove = () => { if (selected !== i) { selected = i; draw(); } };
    row.onclick = () => { selected = i; run(); };
    return row;
  }
  function draw() {
    const q = input.value.trim();
    const cmds = matches(q);
    options = [...cmds.map((c) => ({ kind: 'cmd', c })), ...(q ? [{ kind: 'ask', q }] : [])];
    selected = Math.min(selected, options.length - 1);   // -1: nothing chosen yet (the empty box)
    const out = [];
    if (!q) {
      // every command, by group; no row is chosen until the first ↓
      for (const g of GROUPS) {
        const rows = options.filter((o) => o.c[4] === g);
        if (!rows.length) continue;
        const box = div('cmdgroup', '');
        box.setAttribute('role', 'group');
        box.setAttribute('aria-labelledby', `cmdGrp${g}`);
        box.append(div('group', g, `cmdGrp${g}`));
        if (g === 'Claude') box.append(div('cmdnote', CLAUDE_NOTE));
        for (const o of rows) box.append(optionRow(o, options.indexOf(o)));
        out.push(box);
      }
    } else {
      if (cmds.length) out.push(div('group', 'Commands'));
      options.forEach((o, i) => {
        if (o.kind === 'ask') out.push(div('group claude', 'Claude'));
        out.push(optionRow(o, i));
      });
    }
    list.replaceChildren(...out);
    input.setAttribute('aria-activedescendant', selected >= 0 ? `cmdOpt${selected}` : '');
    const cur = selected >= 0 && $(`cmdOpt${selected}`);
    if (cur) cur.scrollIntoView({ block: 'nearest' });
  }
  // on a phone the app bar is taller than the box's usual place (its Ask Claude and Menu sit where the box would):
  // there the box opens just under the bar, or at the top when the bar has scrolled away 
  const phone = matchMedia('(max-width: 700px), (orientation: landscape) and (max-height: 500px)');
  function place() {
    const bar = $('appbar').getBoundingClientRect();
    const top = phone.matches ? Math.max(Math.round(safeArea().top) + 12, Math.round(bar.bottom) + 8) : 90;
    box.style.top = phone.matches ? `${top}px` : '';
    box.style.setProperty('--cmd-top', `${top}px`);
  }
  // the polite count under the box (R15b): said once the typing has paused, not at every key
  const live = $('cmdLive');
  let liveTimer = null;
  const announce = () => {
    clearTimeout(liveTimer);
    liveTimer = setTimeout(() => {
      const n = options.filter((o) => o.kind === 'cmd').length;
      live.textContent = n ? `${n} command${n === 1 ? '' : 's'}` : 'No command matches. Enter asks Claude.';
    }, 300);
  };
  function openBox() {
    back = document.activeElement;
    live.textContent = '';
    place();
    box.hidden = false;
    input.value = '';
    selected = -1;
    list.scrollTop = 0;
    draw();
    input.focus();
  }
  // Esc with the focus outside the box (its own input takes Esc first, below)
  page.onEscape(ESC.menu, () => !box.hidden, () => closeBox());
  function closeBox({ refocus = true } = {}) {
    box.hidden = true;
    clearTimeout(liveTimer);
    // back to the opener; one that can no longer take the focus (a link behind the phone's Menu, which closed) gives
    // it to the screen
    if (refocus) {
      if (back && back.isConnected) back.focus();
      if (document.activeElement !== back || back === document.body) page.focus();
    }
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
  // the app bar's "Commands…" (on a phone it sits behind Menu, which closes again)
  $('navCommands').onclick = () => {
    $('appbar').classList.remove('menu-open');
    $('btnMenu').setAttribute('aria-expanded', 'false');
    openBox();
  };
  input.addEventListener('input', () => { selected = input.value.trim() ? 0 : -1; draw(); announce(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); selected = Math.min(options.length - 1, selected + 1); draw(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); selected = Math.max(options.length ? 0 : -1, selected - 1); draw(); }
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
  // a press outside closes it, and the focus goes back to the opener unless the press gave it to something
  page.outsidePress(() => !box.hidden, (t) => box.contains(t), (refocus) => closeBox({ refocus }));
  return { open: openBox, close: closeBox };
}
