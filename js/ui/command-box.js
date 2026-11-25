/*
 * The "Ask Claude or find a command" box:
 * Ctrl+K (Cmd+K on a Mac) anywhere opens it. As you type, the page's commands that match come first, and
 * "Ask Claude: …" is always last; ↑↓ choose, Enter runs the command or asks, Esc closes. A command runs on the page
 * and is never sent to Claude. Asking opens the side panel, beside the person's machine, whatever is on it.
 * With nothing typed it lists every command, by group, with no row chosen until the first ↓. It also opens from the
 * app bar's "Commands…" (and the touch keys' menu). The command list is the page's own buttons: each entry clicks one, so
 * a command does exactly what its button does; "Take snapshot" (the Glossary's word) saves the snapshot file the
 * Share screen's "Download snapshot" saves.
 */
import { $, ESC, safeArea } from './page.js';
import { availableProfiles } from '../machines/profiles.js';

// [label, what it does, more words it answers to, the button it presses (or what it does, for one with no button), group,
//  and, for a command that only works some of the time, notNow(page): null when it applies now, else { state: the muted
//  line its row shows ("No tape in"), why: what choosing it says instead of running ("No tape in the deck.") }]
// Every command is always listed: one that doesn't apply now is a muted row (aria-disabled, still focusable), and
// choosing it says why, in the box, which stays open; nothing runs.
// (a function is called with the page, the Claude panel and the machine menu)
// In the order the empty box lists them (the groups in GROUPS' order). A command with a keyboard shortcut would
// show it in its row's .hint; none has one yet.
export const GROUPS = ['Claude', 'Files', 'Views', 'Settings', 'Machine'];
export const COMMANDS = [
  ['Chat with Claude, full screen', 'the machine becomes Claude', 'chat claude full screen', null, 'Claude'],
  ['What is this code doing?', 'asks Claude about the code at the program counter', 'debugger disassembly code explain routine', (page, claude) => claude.askAboutCode(), 'Claude'],
  ['Take snapshot', 'saves everything, including your program, as a file', 'snapshot save state program keep', takeSnapshot, 'Files',
    (page) => (page.session.wyrmfireRunning || page.session.romCodeIn(page.session.personMachine) === 'userdata' ? { state: 'Off while WYRMFIRE runs', why: 'Snapshots are off while WYRMFIRE runs.' } : null)],
  ['Open a program, tape, disk or cartridge…', 'opens a file', 'load open file insert program tape disk cartridge cas bin', 'btnLoad', 'Files'],
  ['Insert a disk…', 'a disk image into the first free drive', 'disk drive mount vdk dsk floppy', (page) => page.drives.pick(), 'Files'],
  ['New blank disk', 'an empty disk in the first free drive', 'disk drive new blank empty format floppy', (page) => page.drives.blank(), 'Files'],
  ['Eject disk', 'takes the disk out of its drive', 'disk drive eject remove floppy', (page) => page.drives.eject(), 'Files', noDisk],
  ['Insert a tape…', 'a .cas or .wav tape into the deck', 'tape cassette insert cas wav load', 'btnTape', 'Files'],
  ['Rewind the tape', 'back to the start of the tape', 'tape cassette rewind start', 'btnRewind', 'Files',
    noTape('No tape in. Insert one with "Insert a tape…".')],
  ['Eject the tape', 'takes the tape out of the deck', 'tape cassette eject remove', 'btnEjectTape', 'Files', noTape('No tape in the deck.')],
  ['Save the tape as .WAV', 'the tape in the deck, or the last recording', 'save tape wav cassette record', 'btnTapeWav', 'Files',
    (page) => (hasTape(page) || (page.tape && page.tape.recorded()) ? null : { state: 'No tape in', why: 'No tape in and nothing recorded yet.' })],
  ['Record to tape', 'CSAVE becomes a .CAS file', 'record tape cas csave save', 'btnRecord', 'Files'],
  ['Share', 'a share link, a clip, a screenshot', 'share link clip screenshot capture embed', 'btnShare', 'Files'],
  ['Programs', 'the welcome menu, LIZA, the games; what ran here before', 'programs games demos liza run', (page) => page.openPrograms(), 'Views'],
  ['WYRMFIRE', 'a 3D game for the Dragon 64, with the Freedoom level', 'doom game 3d freedoom wyrmfire', (page) => page.wyrmfire.start(), 'Views'],
  ['Open the Library', 'your tapes, disks and programs', 'library tapes disks programs files', 'navLibrary', 'Views'],
  ['Open the Debugger', 'assembler and disassembly', 'debugger assembler disassemble debug', 'navDebugger', 'Views'],
  ['Your ROMs', 'see, add or remove ROMs', 'basic firmware add delete remove forget', 'btnManageRoms', 'Settings'],
  ['Display settings', 'the CRT look, colours, size', 'display crt colour color artifact screen look', 'tab-display', 'Settings'],
  ['Input settings', 'keyboard, joysticks, mouse', 'input keyboard joystick gamepad mouse keys', 'tab-input', 'Settings'],
  ['POKEs', 'cheats and memory pokes', 'pokes poke cheats memory', 'tab-pokes', 'Settings'],
  ['Machine settings', 'ROMs, RAM, options, settings file', 'machine settings ram cpu options', 'tab-machine', 'Settings'],
  ['Pause or resume', 'stops the machine where it is', 'pause resume stop freeze', 'btnPause', 'Machine'],
  ['Turbo', 'runs as fast as possible', 'turbo fast speed', 'btnTurbo', 'Machine'],
  ['Fullscreen', 'the screen fills the window', 'fullscreen full screen big', 'btnFull', 'Machine'],
  ['Reset', 'like the reset button', 'reset restart', 'btnReset', 'Machine'],
  ['Switch off and on', 'clears memory; the tape and cartridge stay in', 'switch off on power cycle hard reset clear', 'btnHardReset', 'Machine'],
  ['Switch machine…', 'the machine menu: another model', 'switch machine computer model', (page, claude, machines) => machines.open(), 'Machine'],
  ['Copy bug report', 'the version, machine and browser, shown before copying', 'bug report problem issue copy version', (page) => page.bugReport.open(), 'Machine'],
  ['Help', 'the guide, in a new tab', 'help guide how', () => { window.open(new URL('help/', document.baseURI).href, '_blank', 'noopener'); }, 'Machine'],
];
// "Switch to <model>": one per model (built when the box draws: the models are the page's), each through the machine
// menu's confirmation; the one running is listed muted ("Running now"). Listed only when a word typed names the model;
// a query that says "switch" or "machine" and names none gets the one "Switch machine…" row instead.
const SWITCH = 'Switch machine…';
export const switchCommands = (models, running) => models
  .map((p) => [`Switch to ${p.name}`, 'asks first: the machine is reset', 'switch machine computer model', (page, claude, machines) => machines.pick(p.id), 'Machine',
    p.id === running ? () => ({ state: 'Running now', why: `You're using the ${p.name} now.` }) : null, p.name]);
// The box shows at most this many commands, Ask Claude after them.
export const MAX_ROWS = 8;
const split = (t) => t.toLowerCase().split(/[^a-z0-9.]+/).filter(Boolean);
// edits between two short words (Levenshtein), stopping early past 1
function within1(a, b) {
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0, j = 0, edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++edits > 1) return false;
    if (a.length > b.length) i++; else if (b.length > a.length) j++; else { i++; j++; }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}
// How a query word meets a word of a command -> the length of the word's prefix it matched, or 0. A word starts it;
// a word of 4 letters or more may also be one edit from one of its prefixes (one letter more, less or different),
// keeping its first letter: "rset" finds "reset", "setings" and "setin" find "settings".
function prefixMatch(w, h) {
  if (h.startsWith(w)) return w.length;
  if (w.length < 4 || h[0] !== w[0]) return 0;
  for (const k of [w.length, w.length - 1, w.length + 1]) if (k <= h.length && within1(w, h.slice(0, k))) return k;
  return 0;
}
// The commands matching a query, best first -> [{ c: the entry, tier, marks: [[start, end]] in its label }].
// Every word (but the little ones) must match: at the start of a word of the label (tier 0), of its other words
// (tier 1), or within one edit of a word's start (tier 2); a command's tier is its worst word's, and the order within a
// tier is the list's. marks: the parts of the label the words matched, for <mark>.
// The rows the box shows for a query -> [{ c, tier, marks, off }]: rankCommands' matches, with off (notNow) for the
// page as it is; the ones that apply now first, each part in its match order; at most MAX_ROWS.
export function listCommands(entries, q, page) {
  const found = rankCommands(entries, q).map((r) => Object.assign(r, { off: r.c[5] ? r.c[5](page) : null }));
  return found.filter((m) => !m.off).concat(found.filter((m) => m.off)).slice(0, MAX_ROWS);
}
export function rankCommands(entries, q) {
  const words = split(q).filter((w) => !FILLER.has(w));
  if (!words.length) return [];
  const out = [];
  for (const c of entries) {
    const [label, , more, , , , model] = c;
    // label words with their offsets in the label
    const lw = [];
    for (const m of label.toLowerCase().matchAll(/[a-z0-9.]+/g)) lw.push({ w: m[0], at: m.index });
    const ew = split(more), modelWords = model ? split(model) : null;
    let tier = 0, ok = true, named = false;
    const marks = [];
    for (const w of words) {
      const exact = lw.find((x) => x.w.startsWith(w));
      if (exact) { marks.push([exact.at, exact.at + w.length]); if (modelWords && modelWords.some((m) => m.startsWith(w))) named = true; continue; }
      if (ew.some((h) => h.startsWith(w))) { tier = Math.max(tier, 1); continue; }
      const fz = lw.map((x) => ({ x, k: prefixMatch(w, x.w) })).find((f) => f.k);
      if (fz) { tier = 2; marks.push([fz.x.at, fz.x.at + Math.min(fz.k, fz.x.w.length)]); if (modelWords && modelWords.some((m) => prefixMatch(w, m))) named = true; continue; }
      if (ew.some((h) => prefixMatch(w, h))) { tier = 2; continue; }
      ok = false; break;
    }
    // a model's row needs a word that names the model, not only "switch" or "machine"
    if (ok && (!modelWords || named)) out.push({ c, tier, marks });
  }
  const models = out.filter((r) => r.c[6]);
  const rows = models.length ? out.filter((r) => r.c[0] !== SWITCH) : out;
  return rows.map((r, i) => ({ r, i })).sort((a, b) => (a.r.tier - b.r.tier) || (a.i - b.i)).map((x) => x.r);
}
function noDisk(page) { return page.session.drives.status().drives.length ? null : { state: 'No disk in', why: 'No disk in any drive.' }; }
function hasTape(page) { return !!page.session.personMachine.deck.tape; }
function noTape(why) { return (page) => (hasTape(page) ? null : { state: 'No tape in', why }); }
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

// machines: the machine menu (js/ui/machine-panel.js): open() it, or pick(id) a model through its confirmation
export function setupCommandBox(page, claude, machines) {
  const { session } = page;
  const box = $('cmdBox'), input = $('cmdInput'), list = $('cmdList');
  let options = [], selected = -1, back = null;
  let refused = null;   // the command just chosen while it doesn't apply: its row says why until the query changes
  const mac = /Mac|iPhone|iPad/.test(navigator.platform || '');
  $('askKbd').textContent = mac ? '⌘K' : 'Ctrl K';
  $('navCmdKbd').textContent = mac ? '⌘K' : 'Ctrl K';
  $('askEmptyKbd').textContent = mac ? '⌘K' : 'Ctrl K';

  // the commands matching the text: every word (but the little ones: "save my prog") starts a word of the label or
  // of its other words
  // (a command whose button the page lacks is left out; one that doesn't apply now is listed, muted: notNow)
  // (and with Settings -> Claude features Off, no Claude row: js/ui/claude-features.js)
  const available = ([, , , id, group]) => !(typeof id === 'string' && !$(id)) && !(group === 'Claude' && !session.claudeFeatures);
  // (split as the labels are, so a label typed with its punctuation ("Chat with Claude, full screen") finds it)
  function matches(q) {
    if (!q) return COMMANDS.filter(available).map((c) => ({ c, marks: [], off: c[5] ? c[5](page) : null }));   // the empty box: every command, in place
    return listCommands(COMMANDS.filter(available).concat(switchCommands(availableProfiles(), session.shownMachine.id)), q, page);
  }
  // overlapping or touching ranges, sorted and joined
  const merge = (r) => r.slice().sort((x, y) => x[0] - y[0]).reduce((out, [s, e]) => {
    const last = out[out.length - 1];
    if (last && s <= last[1]) last[1] = Math.max(last[1], e); else out.push([s, e]);
    return out;
  }, []);
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
      h.textContent = 'opens the side panel';
    } else {
      // the parts the query matched in <mark>; the option's name stays the plain label (aria-label), and its second
      // line its description. A command that doesn't apply now: muted, its state as the second line (after it was
      // chosen: why), and aria-disabled but still focusable and selectable
      const label = o.c[0], marks = merge(o.marks || []);
      let at = 0;
      for (const [s, e] of marks) { a.append(label.slice(at, s), Object.assign(document.createElement('mark'), { textContent: label.slice(s, e) })); at = e; }
      a.append(label.slice(at));
      h.textContent = o.off ? (o.refused ? o.off.why : o.off.state) : o.c[1];
      if (o.off) { row.setAttribute('aria-disabled', 'true'); row.classList.add('off'); if (o.refused) h.classList.add('why'); }
      row.setAttribute('aria-label', label);
      row.setAttribute('aria-description', h.textContent);
    }
    row.append(a, h);
    row.onmousemove = () => { if (selected !== i) { selected = i; draw(); } };
    row.onclick = () => { selected = i; run(); };
    return row;
  }
  function draw() {
    const q = input.value.trim();
    const cmds = matches(q);
    // A question (it ends in "?") is for Claude: its row comes first and is the one Enter runs, the commands it
    // matches listed beneath, so "reset?" asks rather than resets. Only a command's whole label typed with its own
    // "?" ("What is this code doing?") still runs the command.
    const label = q.toLowerCase();
    const question = /\?\s*$/.test(q) && !COMMANDS.some(([l]) => l.toLowerCase() === label);
    const cmdRows = cmds.map((m) => ({ kind: 'cmd', c: m.c, marks: m.marks, off: m.off, refused: refused === m.c[0] })), askRow = q && session.claudeFeatures ? [{ kind: 'ask', q }] : [];
    options = question ? [...askRow, ...cmdRows] : [...cmdRows, ...askRow];
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
      options.forEach((o, i) => {
        if (o.kind === 'ask') out.push(div('group claude', 'Claude'));
        else if (o === cmdRows[0]) out.push(div('group', 'Commands'));
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
  // the polite count under the box: said once the typing has paused, not at every key
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
    selected = -1; refused = null;
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
    // a command that doesn't apply now: the box stays open and nothing runs; its row says why, and the live region
    // says it once
    if (o.kind === 'cmd' && o.off) {
      refused = o.c[0];
      draw();
      clearTimeout(liveTimer);
      live.textContent = o.off.why;
      return;
    }
    closeBox({ refocus: o.kind !== 'ask' });
    if (o.kind === 'ask') {
      // the side panel, beside the person's machine whatever is on it (only "Chat with Claude, full screen" and the
      // welcome menu's chat item go full screen)
      claude.openPanel(o.q);
      return;
    }
    const id = o.c[3];
    if (!id) { claude.openFull(); return; }
    if (typeof id === 'function') { id(page, claude, machines); return; }
    // (a settings tab: shown through openSettings, which opens the Settings sheet on a phone)
    if (id.startsWith('tab-')) page.openSettings(id); else $(id).click();
  }
  // the app bar's "Commands…" (on a phone it sits behind Menu, which closes again)
  $('navCommands').onclick = () => {
    $('appbar').classList.remove('menu-open');
    $('btnMenu').setAttribute('aria-expanded', 'false');
    openBox();
  };
  input.addEventListener('input', () => { refused = null; selected = input.value.trim() ? 0 : -1; draw(); announce(); });
  input.addEventListener('keydown', (e) => {
    // ↓ on the last row goes to the first; ↑ with nothing chosen goes to the last
    if (e.key === 'ArrowDown') { e.preventDefault(); selected = selected >= options.length - 1 ? (options.length ? 0 : -1) : selected + 1; draw(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); selected = selected < 0 ? options.length - 1 : Math.max(0, selected - 1); draw(); }
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
