/*
 * The machine: the grouped machine menu in the header (with a confirmation before a running machine is
 * switched or its RAM changed, naming what comes out), the monitor's bezel and nameplate, the RAM and CPU rows of Machine settings (a select where the model
 * offers a choice; changing one power-cycles the machine).
 */
import { availableProfiles } from '../machines/profiles.js';
import { caseOf, groupProfiles } from '../machines/menu.js';
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

  function buildMenu() {
    menu.replaceChildren();
    // every profile is in exactly one section (groupProfiles is exhaustive; a new model cannot go missing)
    for (const [name, list] of groupProfiles(availableProfiles())) {
      const g = document.createElement('div'); g.className = 'machines';
      const h = document.createElement('div'); h.className = 'group-name'; h.textContent = name;
      g.append(h);
      for (const p of list) {
        const b = document.createElement('button');
        b.setAttribute('role', 'menuitem');
        b.dataset.machine = p.id;
        const ready = session.machineRoms(p.id).bootable;
        const n = document.createElement('span'); n.textContent = p.name;
        const t = document.createElement('span'); t.className = ready ? 'tag ready' : 'tag'; t.textContent = ready ? '✓' : 'needs ROMs';
        if (ready) t.setAttribute('aria-label', 'BASIC ready');
        b.append(n, t);
        if (p.id === session.shownMachine.id) b.setAttribute('aria-current', 'true');
        b.onclick = () => pick(p.id);
        g.append(b);
      }
      menu.append(g);
    }
    // the footer (R28): two menu items after a separator, in the menu's arrow and Tab order like the machines
    const sep = document.createElement('div'); sep.className = 'sep machines'; sep.setAttribute('role', 'separator');
    const foot = document.createElement('div'); foot.className = 'footer machines'; foot.setAttribute('role', 'none');
    const item = (id, text, fn) => { const b = document.createElement('button'); b.id = id; b.setAttribute('role', 'menuitem'); b.textContent = text; b.onclick = fn; return b; };
    // the tick's legend, after the two items: a note, not a menu item (the arrows and Tab pass it by)
    const legend = document.createElement('span'), tick = document.createElement('span');
    legend.className = 'legend'; tick.className = 'tag ready'; tick.textContent = '✓';
    legend.append(tick, ' = BASIC ready');
    foot.append(item('menuRoms', 'Add or see ROMs…', () => { openMenu(false); showRoms(); }),
      item('menuSettings', 'RAM, CPU and speed…', () => { openMenu(false); machineSettings(); }), legend);
    menu.append(sep, foot);
  }
  function openMenu(open) {
    if (open) buildMenu();
    menu.hidden = !open;
    btn.setAttribute('aria-expanded', String(open));
    if (open) {
      // as tall as the window allows below the button (a phone showed it cut short at the MC-10), and
      // a faded bottom edge while more models are below
      menu.style.maxHeight = `${Math.max(200, innerHeight - menu.getBoundingClientRect().top - 12)}px`;
      moreBelow();
      const cur = menu.querySelector('[aria-current="true"]') || menu.querySelector('button'); cur.focus();
    }
  }
  const moreBelow = () => menu.classList.toggle('more-below', menu.scrollTop + menu.clientHeight < menu.scrollHeight - 2);
  menu.addEventListener('scroll', moreBelow);
  // ---- the switch confirmation (R25): it names what the switch takes out, built from the old machine before the
  // switch (Session.takenOut), says which of those stay in the Library, and offers to save a snapshot's own disk ----
  let cancelled = null;   // what Cancel does besides closing (a RAM change puts the select back)
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
      try { names = (await session.listMedia()).map((x) => x.name.split('/').pop()); } catch (e) { names = []; }
    }
    return items.filter((t) => (t.kind === 'disk' ? t.stored : !!t.name && names.some((n) => session.sameName(n, t.name))));
  }
  // to: { name: what it switches to (null for a RAM change), id, config }; onSwitch(taken, said) does it, taken being
  // what came out and said its " Took out: …." for the message; onCancel: what Cancel undoes. A running machine is
  // switched only after this.
  // It shows at once; which items stay in the Library (a look in the store) is added to it when known.
  let asking = 0;
  function confirmSwitch(to, onSwitch, onCancel = null) {
    const from = session.shownMachine.profile.name, items = session.takenOut(to.id, to.config), mine = ++asking;
    const snap = items.filter((t) => t.kind === 'disk' && !t.stored);
    const text = $('switchText');
    text.replaceChildren();
    if (to.name) {
      const n = document.createElement('strong'); n.id = 'switchName'; n.textContent = to.name;
      const f = document.createElement('span'); f.id = 'switchFrom'; f.textContent = from;
      text.append('Switching to ', n, ' resets the ', f);
    } else {
      const f = document.createElement('span'); f.id = 'switchFrom'; f.textContent = from;
      text.append('Changing RAM switches the ', f, ' off and on');
    }
    text.append(items.length ? ` and takes out ${and(items.map(what))}.` : '. The running program will be lost.');
    const keptAt = document.createElement('span');   // "They stay in your Library.", once known
    text.append(keptAt);
    inLibrary(items).then((kept) => {
      if (mine !== asking || !kept.length) return;
      keptAt.textContent = ` ${kept.length === items.length ? (kept.length === 1 ? 'It stays in your Library.' : 'They stay in your Library.')
        : `${and(kept.map(short))} ${kept.length === 1 ? 'stays' : 'stay'} in your Library.`}`;
    });
    if (snap.length) text.append(' ', snap.length === 1 ? 'The disk that came with the snapshot is not kept; save it to the Library first.'
      : 'The disks that came with the snapshot are not kept; save them to the Library first.');
    const save = $('btnSwitchSaveDisk');
    save.hidden = !snap.length; save.disabled = false; save.textContent = 'Save to Library';
    save.onclick = async () => {
      save.disabled = true;
      try {
        // (said on the button itself, the control it is about: no toast)
        // (a retry after a failure skips the disks already saved: their drives are linked now)
        for (const t of snap) { const now = session.diskStatus().drives.find((x) => x.drive === t.drive); if (now && !now.stored) await session.keepSnapshotDisk(t.drive); }
        save.textContent = 'Saved to Library';
      } catch (e) { save.disabled = false; page.status(e.message, true); }
    };
    pending = () => onSwitch(items, tookOut(items));
    cancelled = onCancel;
    confirm.hidden = false;
    $('btnSwitch').focus();
  }
  // after a switch: what it switched to, what came out, and (a "needs ROMs" row) that it needs ROMs, with Add ROMs
  const switched = (taken) => {
    const needs = !session.machineRoms().bootable;
    page.toast(`Switched to ${session.shownMachine.profile.name}.${tookOut(taken)}${needs ? ' It needs ROMs for BASIC.' : ''}`,
      needs ? { action: { label: 'Add ROMs', run: showRoms } } : {});
  };
  function pick(id) {
    openMenu(false);
    if (id === session.shownMachine.id) { page.focus(); return; }
    confirmSwitch({ name: availableProfiles().find((p) => p.id === id).name, id }, (taken) => {
      session.chooseMachine(id);
      switched(taken);
    });
  }
  // the menu's "RAM, CPU and speed…": the Machine settings tab, with the focus on its heading (on a phone, its top
  // scrolled into view)
  function machineSettings() {
    $('tab-machine').click();
    const h = $('machineHeading'), phone = matchMedia('(max-width: 700px)').matches;
    h.focus({ preventScroll: phone });
    if (phone) h.scrollIntoView({ block: 'start' });
  }
  $('btnSwitch').onclick = () => {
    confirm.hidden = true;
    const run = pending; pending = null; cancelled = null;
    if (run) run();
    page.focus();
  };
  $('btnSwitchCancel').onclick = () => {
    confirm.hidden = true; pending = null;
    const undo = cancelled; cancelled = null;
    if (undo) undo();
    page.focus();
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
    const items = [...menu.querySelectorAll('button')], i = items.indexOf(document.activeElement);
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
  });

  // a changed option power-cycles the machine with it (remembered for that model)
  const change = (key, parse, done) => (e) => {
    const m = session.shownMachine;
    session.switchMachine(m.id, Object.assign({}, session.savedConfig(m.id), { [key]: parse(e.target.value) }));
    page.status(`${m.profile.name}: ${done(session.shownMachine.config[key])} (switched off and on)`);
    page.focus();
  };
  // RAM: asked first, as a machine switch is, naming what comes out (R25); Cancel puts the select back
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
  return { confirmSwitch, close: () => openMenu(false) };
}
