/*
 * The machine: the grouped machine menu in the header (with a confirmation before a running machine is
 * switched or its RAM changed, naming what comes out), the monitor's bezel and nameplate, the RAM and CPU rows of Machine settings (a select where the model
 * offers a choice; changing one power-cycles the machine).
 */
import { availableProfiles } from '../machines/profiles.js';
import { caseOf, groupProfiles, SUBTITLES, describe } from '../machines/menu.js';
import { $, ESC } from './page.js';

// the menu's sections and the bezel/nameplate choice live in js/machines/menu.js (data only, tested in Node)
export { caseOf };
// the CPU as Machine settings names it: the Dragons and Color Computers use the 6809E (external clock)
const cpuName = (v) => (v === '6809' ? '6809E' : v);
// a Machine settings row for one profile option: a select when the model offers a choice, else the value as text
function showOption(m, key, field, sel, fixed, fmt) {
  const opt = m.profile.options[key], s = $(sel), choice = !!opt && opt.values.length > 1;
  $(field).hidden = !opt;
  s.hidden = !choice; $(fixed).hidden = choice;
  s.replaceChildren();
  if (!opt) return;
  for (const v of opt.values) {
    const o = document.createElement('option');
    o.value = v; o.textContent = fmt(v);
    s.appendChild(o);
  }
  s.value = m.config[key];
  $(fixed).textContent = fmt(m.config[key]);
}

// showRoms(): opens Your ROMs for the machine in use (js/ui/rom-sockets.js reveal)
export function setupMachinePanel(page, { showRoms }) {
  const { session } = page;
  const btn = $('machineBtn'), menu = $('machineMenu'), confirm = $('switchConfirm');
  let pending = null;   // what Switch does

  // the footer's line for the model under the pointer or the focus: visual only (the item carries the same words as its
  // aria-description, so a screen reader hears them once, with the item)
  let about = null, list = null;   // list: the models' box, which scrolls above the footer
  const say = (p) => { if (about) about.textContent = p ? describe(p) : ''; };
  function buildMenu() {
    menu.replaceChildren();
    list = document.createElement('div'); list.className = 'menulist';
    menu.append(list);
    // With no ROMs stored at all, no tags (every row would say "needs ROMs": the welcome menu's key 3 says it once);
    // the tags (and the ✓ legend) once any are stored
    const none = session.storedRoms().count === 0;
    // every profile is in exactly one section (groupProfiles is exhaustive; a new model cannot go missing)
    for (const [name, members] of groupProfiles(availableProfiles())) {
      const g = document.createElement('div'); g.className = 'machines';
      const h = document.createElement('div'); h.className = 'group-name'; h.textContent = name;
      const sub = document.createElement('div'); sub.className = 'group-sub'; sub.textContent = SUBTITLES[name];
      g.append(h, sub);
      for (const p of members) {
        const b = document.createElement('button');
        b.setAttribute('role', 'menuitem');
        b.dataset.machine = p.id;
        b.setAttribute('aria-description', describe(p));
        const n = document.createElement('span'); n.textContent = p.name;
        b.append(n);
        if (!none) {
          const ready = session.machineRoms(p.id).bootable;
          const t = document.createElement('span'); t.className = ready ? 'tag ready' : 'tag'; t.textContent = ready ? '✓' : 'needs ROMs';
          if (ready) { t.setAttribute('aria-label', 'BASIC ready'); t.setAttribute('title', 'BASIC ready'); }
          b.append(t);
        }
        if (p.id === session.shownMachine.id) b.setAttribute('aria-current', 'true');
        b.onclick = () => pick(p.id);
        b.addEventListener('focus', () => say(p));
        b.addEventListener('pointerenter', () => say(p));
        g.append(b);
      }
      list.append(g);
    }
    // the footer: two menu items after a separator, in the menu's arrow and Tab order like the machines
    const sep = document.createElement('div'); sep.className = 'sep machines'; sep.setAttribute('role', 'separator');
    const foot = document.createElement('div'); foot.className = 'footer machines'; foot.setAttribute('role', 'none');
    const item = (id, text, fn) => { const b = document.createElement('button'); b.id = id; b.setAttribute('role', 'menuitem'); b.textContent = text; b.onclick = fn; return b; };
    // the tick's legend, after the two items: a note, not a menu item (the arrows and Tab pass it by)
    const legend = document.createElement('span'), tick = document.createElement('span');
    legend.className = 'legend'; tick.className = 'tag ready'; tick.textContent = '✓';
    tick.setAttribute('aria-label', 'BASIC ready'); tick.setAttribute('title', 'BASIC ready');
    legend.append(tick, ' = BASIC ready');
    legend.hidden = none;
    // "Which one is mine? ↗": Help's list of the machines, what each is and the ROMs it needs (a new tab)
    const mine = document.createElement('a');
    mine.id = 'menuWhich'; mine.setAttribute('role', 'menuitem'); mine.href = 'help/#machines'; mine.target = '_blank'; mine.rel = 'noopener';
    mine.textContent = 'Which one is mine? ↗';
    mine.onclick = () => openMenu(false);
    about = document.createElement('p'); about.id = 'menuAbout'; about.setAttribute('aria-hidden', 'true');
    foot.append(item('menuRoms', 'Add or see ROMs…', () => { openMenu(false); showRoms(); }),
      item('menuSettings', 'RAM, CPU and speed…', () => { openMenu(false); machineSettings(); }), mine, legend, about);
    menu.append(sep, foot);
    list.addEventListener('scroll', moreBelow);
  }
  function openMenu(open) {
    if (open) buildMenu();
    menu.hidden = !open;
    btn.setAttribute('aria-expanded', String(open));
    if (open) {
      // as tall as the window allows below the button (a phone showed it cut short at the MC-10), and
      // a faded bottom edge while more models are below
      menu.style.maxHeight = `${Math.max(200, innerHeight - menu.getBoundingClientRect().top - 12)}px`;
      const cur = menu.querySelector('[aria-current="true"]') || menu.querySelector('button');
      cur.focus({ preventScroll: true });
      centre(cur);
      moreBelow();
    }
  }
  // the machine in use, scrolled to the middle of the list (as far as the list scrolls), its selected fill on. The list's
  // top edge then never runs through a row (which reads as an empty band above the first whole one): a row it would cut
  // is shown whole, and a gap between two groups moves on to the next group's heading.
  function centre(cur) {
    if (!list.contains(cur)) return;
    const l = list.getBoundingClientRect(), c = cur.getBoundingClientRect();
    list.scrollTop += (c.top + c.height / 2) - (l.top + list.clientHeight / 2);
    if (list.scrollTop <= 0) return;
    const top = l.top + list.clientTop;
    const rows = [...list.querySelectorAll('#menuNoRoms, .group-name, .group-sub, button')].filter((e) => e.checkVisibility()).map((e) => e.getBoundingClientRect());
    const cut = rows.find((r) => r.top < top - 0.5 && r.bottom > top + 0.5);
    if (cut) list.scrollTop -= top - cut.top;
    else if (!rows.some((r) => r.top <= top + 0.5 && r.bottom > top + 0.5)) {
      const next = rows.find((r) => r.top > top);
      if (next) list.scrollTop += next.top - top;
    }
  }
  const moreBelow = () => menu.classList.toggle('more-below', list.scrollTop + list.clientHeight < list.scrollHeight - 2);
  // ---- the switch confirmation: it names what the switch takes out, built from the old machine before the
  // switch (Session.takenOut), says which of those stay in the Library, and offers to save a snapshot's own disk ----
  let cancelled = null;   // what Cancel does besides closing (a RAM change puts the select back)
  // the control that asked (the RAM select, a menu item): Cancel and Esc give the focus back to it when it stands in an
  // open phone sheet, where the screen behind the modal cannot take the focus (js/ui/phone-sheets.js)
  let asker = null;
  // "a, b and c"
  const and = (l) => (l.length < 2 ? l.join('') : `${l.slice(0, -1).join(', ')} and ${l[l.length - 1]}`);
  const what = (t) => (t.kind === 'tape' ? `the tape ${t.name}` : t.kind === 'cartridge' ? (t.name ? `the cartridge ${t.name}` : 'the cartridge') : `the disk ${t.name} in drive ${t.drive}`);
  const short = (t) => (t.kind === 'disk' ? `${t.name} (drive ${t.drive})` : t.name || 'the cartridge');
  // " Took out: GAME.CAS, WORK.VDK (drive 0)." after a switch (empty when nothing came out)
  const tookOut = (taken) => (taken.length ? ` Took out: ${taken.map(short).join(', ')}.` : '');
  // which items stay in the Library: a disk linked to it (stored), a tape or cartridge whose file is there
  async function inLibrary(items) {
    let names = [];
    if (items.some((t) => t.kind !== 'disk' && t.name)) {
      try { names = (await session.library.listMedia()).map((x) => x.name.split('/').pop()); } catch (e) { names = []; }
    }
    return items.filter((t) => (t.kind === 'disk' ? t.stored : !!t.name && names.some((n) => session.library.sameName(n, t.name))));
  }
  // to: { name: what it switches to (null for a RAM change), id, config, purpose (optional words after the name) };
  // onSwitch(taken, said) does it, taken being
  // what came out and said its " Took out: …." for the message; onCancel: what Cancel undoes. A running machine is
  // switched only after this.
  // It shows at once; which items stay in the Library (a look in the store) is added to it when known.
  let asking = 0;
  function confirmSwitch(to, onSwitch, onCancel = null) {
    const from = session.shownMachine.profile.name, items = session.takenOut(to.id, to.config), mine = ++asking;
    asker = document.activeElement;
    const snap = items.filter((t) => t.kind === 'disk' && !t.stored);
    const text = $('switchText');
    text.replaceChildren();
    if (to.name) {
      const n = document.createElement('strong'); n.id = 'switchName'; n.textContent = to.name;
      const f = document.createElement('span'); f.id = 'switchFrom'; f.textContent = from;
      // to.purpose: why it switches (" to play WYRMFIRE": js/ui/wyrmfire.js)
      text.append('Switching to ', n, to.purpose || '', ' resets the ', f);
    } else {
      const f = document.createElement('span'); f.id = 'switchFrom'; f.textContent = from;
      text.append('Changing RAM switches the ', f, ' off and on');
    }
    // a switch or a RAM change also loses the machine's printout (one with text to see: Session.printoutLines)
    const printout = session.printoutLines() > 0;
    text.append(items.length ? ` and takes out ${and(items.map(what))}.${printout ? ' The printout will be lost.' : ''}`
      : printout ? '. The running program and the printout will be lost.' : '. The running program will be lost.');
    const keptAt = document.createElement('span');   // "They stay in your Library.", once known
    text.append(keptAt);
    inLibrary(items).then((kept) => {
      if (mine !== asking || !kept.length) return;
      keptAt.textContent = ` ${kept.length === items.length ? (kept.length === 1 ? 'It stays in your Library.' : 'They stay in your Library.')
        : `${and(kept.map(short))} ${kept.length === 1 ? 'stays' : 'stay'} in your Library.`}`;
    });
    if (snap.length) text.append(' ', snap.length === 1 ? 'The disk that came with the snapshot is not kept; save it to the Library first.'
      : 'The disks that came with the snapshot are not kept; save them to the Library first.');
    $('btnSwitch').textContent = 'Switch'; confirm.setAttribute('aria-label', 'Switch machine');
    const save = $('btnSwitchSaveDisk');
    save.hidden = !snap.length; save.disabled = false; save.textContent = 'Save to Library';
    save.onclick = async () => {
      save.disabled = true;
      try {
        // (said on the button itself, the control it is about: no toast)
        // (a retry after a failure skips the disks already saved: their drives are linked now)
        for (const t of snap) { const now = session.drives.status().drives.find((x) => x.drive === t.drive); if (now && !now.stored) await session.drives.keepSnapshot(t.drive); }
        save.textContent = 'Saved to Library';
      } catch (e) { save.disabled = false; page.status(e.message, true); }
    };
    pending = () => onSwitch(items, tookOut(items));
    cancelled = onCancel;
    confirm.hidden = false;
    place();
    $('btnSwitch').focus();
  }
  // The same question box for another question (the programs' "Starting LIZA restarts the Dragon 64, and the BASIC program in
  // memory will be lost"): text, the confirming button's label (and the box's name), what confirming does and what Cancel
  // undoes. Shown at once, as a switch's is.
  function ask({ text, label, name = label, onYes, onCancel = null }) {
    ++asking;
    asker = document.activeElement;
    $('switchText').textContent = text;
    $('btnSwitch').textContent = label; confirm.setAttribute('aria-label', name);
    $('btnSwitchSaveDisk').hidden = true;
    pending = onYes;
    cancelled = onCancel;
    confirm.hidden = false;
    place();
    $('btnSwitch').focus();
  }
  // The question stands under the button that asked it: the machine button, the confirmation's left edge at the
  // button's (kept inside the bar); on a phone the stylesheet puts it directly under the bar, edge to edge
  function place() {
    confirm.style.left = '';
    if (matchMedia('(max-width: 700px)').matches) return;
    const bar = confirm.offsetParent;
    if (!bar) return;
    const left = Math.max(8, Math.min(btn.offsetLeft, bar.clientWidth - confirm.offsetWidth - 8));
    confirm.style.left = `${left}px`;
  }
  addEventListener('resize', () => { if (!confirm.hidden) place(); });
  // after a switch: what it switched to, what came out, and (a "needs ROMs" row) that it needs ROMs, with Add ROMs
  const switched = (taken) => {
    const needs = !session.machineRoms().bootable;
    page.toast(`Switched to ${session.shownMachine.profile.name}.${tookOut(taken)}${needs ? ' It needs ROMs for BASIC.' : ''}`,
      needs ? { action: { label: 'Add ROMs', run: showRoms } } : {});
  };
  function pick(id) {
    openMenu(false);
    if (id === session.shownMachine.id) { if (page.machineAnswered) page.machineAnswered(); page.focus(); return; }
    confirmSwitch({ name: availableProfiles().find((p) => p.id === id).name, id }, (taken) => {
      session.chooseMachine(id);
      switched(taken);
    });
  }
  // the menu's "RAM, CPU and speed…": the Machine settings tab, with the focus on its heading (on a phone, its top
  // scrolled into view)
  function machineSettings() {
    // (on a phone: the Settings sheet, open on the tab, its heading focused in it)
    if (page.openSettings('tab-machine')) { $('machineHeading').focus(); return; }
    const h = $('machineHeading'), phone = matchMedia('(max-width: 700px)').matches;
    h.focus({ preventScroll: phone });
    if (phone) h.scrollIntoView({ block: 'start' });
  }
  $('btnSwitch').onclick = () => {
    confirm.hidden = true; asker = null;
    const run = pending; pending = null; cancelled = null;
    if (run) run();
    page.focus();
  };
  $('btnSwitchCancel').onclick = () => {
    confirm.hidden = true; pending = null;
    const undo = cancelled, back = asker; cancelled = null; asker = null;
    if (undo) undo();
    if (back && back.isConnected && back.closest('dialog[open]') && back.checkVisibility()) back.focus(); else page.focus();
  };
  page.onEscape(ESC.confirm, () => !confirm.hidden, () => $('btnSwitchCancel').click());
  btn.onclick = () => openMenu(menu.hidden);
  // closed, with the focus back on the button (refocus) or left where something else took it
  const closeMenu = (refocus) => { openMenu(false); if (refocus) btn.focus(); };
  // open only while it shows: the app bar it sits in gives way to the Debugger, Add ROMs and a phone's chat, and a
  // menu left open under them must not take their Esc (or the screen's BREAK)
  const menuOpen = () => !menu.hidden && menu.checkVisibility();
  // Esc wherever the focus is (on the screen too: the menu takes it before the machine's BREAK)
  page.onEscape(ESC.menu, menuOpen, () => closeMenu(true));
  page.outsidePress(menuOpen, (t) => menu.contains(t) || btn.contains(t), closeMenu);
  menu.addEventListener('keydown', (e) => {
    const items = [...menu.querySelectorAll('[role="menuitem"]')], i = items.indexOf(document.activeElement);
    // Tab leaves the menu: it closes, and the Tab moves on from its button
    if (e.key === 'Tab') closeMenu(true);
    else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); items[(i + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length].focus(); }
  });

  session.on((ev) => {
    if (ev !== 'machine') return;
    const m = session.shownMachine;
    showOption(m, 'ram', 'ramField', 'ramSel', 'ramFixed', (v) => `${v}K`);
    showOption(m, 'cpu', 'cpuField', 'cpuSel', 'cpuFixed', cpuName);
    $('beckerField').hidden = !m.profile.options.becker;
    $('chkBecker').checked = !!m.config.becker;
    $('machineName').textContent = m.profile.name;
    $('machineSpec').textContent = m.config.ram ? `${m.config.ram}K` : '';
    // the app bar's tight mode hides the RAM size (js/ui/main.js): the button's name still says it
    const label = `${m.profile.name}${m.config.ram ? ` ${m.config.ram}K` : ''}`;
    btn.title = label;
    btn.setAttribute('aria-label', label);
    $('monitor').dataset.family = caseOf(m.profile);
    $('badge').textContent = m.profile.name.replace(/ \(.*\)$/, '').toUpperCase();   // the case badge: no (PAL) or (Alpha)
    $('emuHeading').textContent = m.profile.name;   // the emulator's heading (for assistive technology and reader views)
    document.title = `${m.profile.name} – CLOADM`;
    // the page's title metas say the same once it runs (a reading mode takes og:title before the document's title, and
    // drops the heading that matches it); a link preview reads the static ones in play/index.html, before any script
    for (const meta of document.querySelectorAll('meta[property="og:title"], meta[name="twitter:title"]')) meta.content = document.title;
  });

  // a changed option power-cycles the machine with it (remembered for that model)
  const change = (key, parse, done) => (e) => {
    const m = session.shownMachine;
    session.switchMachine(m.id, Object.assign({}, session.savedConfig(m.id), { [key]: parse(e.target.value) }));
    page.status(`${m.profile.name}: ${done(session.shownMachine.config[key])} (switched off and on)`);
    page.focus();
  };
  // RAM: asked first, as a machine switch is, naming what comes out; Cancel puts the select back
  $('ramSel').onchange = (e) => {
    const m = session.shownMachine, ram = Number(e.target.value), config = Object.assign({}, session.savedConfig(m.id), { ram });
    confirmSwitch({ name: null, id: m.id, config }, (taken) => {
      session.switchMachine(m.id, config);
      page.status(`${m.profile.name}: ${session.shownMachine.config.ram}K RAM (switched off and on).${tookOut(taken)}`);
    }, () => { e.target.value = String(session.shownMachine.config.ram); });
  };
  $('cpuSel').onchange = change('cpu', String, (v) => `${cpuName(v)} CPU`);
  $('chkBecker').onchange = (e) => change('becker', () => e.target.checked, (v) => `Becker port ${v ? 'on' : 'off'}`)(e);
  // `close` is openMenu(false): the item js/ui/install.js keeps in the menu closes it through this, rather than
  // setting the same two attributes a second time
  // (the command box's "Switch machine…" opens the menu; its "Switch to <model>" picks one, through the confirmation)
  return { confirmSwitch, ask, close: () => openMenu(false), open: () => openMenu(true), pick };
}
