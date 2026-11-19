/*
 * The machine: the grouped machine menu in the header (with a confirmation before a running machine is
 * switched), the monitor's bezel and nameplate, the RAM and CPU rows of the Machine tab (a select where the model
 * offers a choice; changing one power-cycles the machine).
 */
import { availableProfiles } from '../machines/profiles.js';
import { caseOf, groupProfiles } from '../machines/menu.js';
import { $, ESC } from './page.js';

// the menu's sections and the bezel/nameplate choice live in js/machines/menu.js (data only, tested in Node)
export { caseOf };
// the CPU as the Machine tab names it: the Dragons and Color Computers use the 6809E (external clock)
const cpuName = (v) => (v === '6809' ? '6809E' : v);
// a Machine tab row for one profile option: a select when the model offers a choice, else the value as text
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

export function setupMachinePanel(page) {
  const { session } = page;
  const btn = $('machineBtn'), menu = $('machineMenu'), confirm = $('switchConfirm');
  let pending = null;   // what Switch does

  function buildMenu() {
    menu.replaceChildren();
    // every profile is in exactly one section (groupProfiles is exhaustive; a new model cannot go missing)
    for (const [name, list] of groupProfiles(availableProfiles())) {
      const g = document.createElement('div');
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
        if (p.id === session.machine.id) b.setAttribute('aria-current', 'true');
        b.onclick = () => pick(p.id);
        g.append(b);
      }
      menu.append(g);
    }
    const note = document.createElement('div'); note.className = 'note';
    const left = document.createElement('span'); left.textContent = 'RAM, CPU and the CPU speed are in the Machine tab.';
    const right = document.createElement('span'), tick = document.createElement('span');
    tick.className = 'tag ready'; tick.textContent = '✓';
    right.append(tick, ' = BASIC ready');
    note.append(left, right);
    menu.append(note);
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
  // a running machine is switched only after a confirmation: `name` is what it switches to, onSwitch does it
  function confirmSwitch(name, onSwitch) {
    pending = onSwitch;
    $('switchName').textContent = name;
    $('switchFrom').textContent = session.machine.profile.name;
    confirm.hidden = false;
    $('btnSwitch').focus();
  }
  function pick(id) {
    openMenu(false);
    if (id === session.machine.id) { page.focus(); return; }
    confirmSwitch(availableProfiles().find((p) => p.id === id).name, () => {
      session.chooseMachine(id);
      page.status(`Switched to ${session.machine.profile.name}`);
    });
  }
  $('btnSwitch').onclick = () => {
    confirm.hidden = true;
    const run = pending; pending = null;
    if (run) run();
    page.focus();
  };
  $('btnSwitchCancel').onclick = () => { confirm.hidden = true; pending = null; page.focus(); };
  page.onEscape(ESC.confirm, () => !confirm.hidden, () => $('btnSwitchCancel').click());
  btn.onclick = () => openMenu(menu.hidden);
  menu.addEventListener('keydown', (e) => {
    const items = [...menu.querySelectorAll('button')], i = items.indexOf(document.activeElement);
    if (e.key === 'Escape') { e.stopPropagation(); openMenu(false); btn.focus(); }
    else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); items[(i + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length].focus(); }
  });
  document.addEventListener('pointerdown', (e) => { if (!menu.hidden && !menu.contains(e.target) && !btn.contains(e.target)) openMenu(false); });

  session.on((ev) => {
    if (ev !== 'machine') return;
    const m = session.machine;
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
    document.title = `${m.profile.name} – CLOADM`;
  });

  // a changed option power-cycles the machine with it (remembered for that model)
  const change = (key, parse, done) => (e) => {
    const m = session.machine;
    session.switchMachine(m.id, Object.assign({}, session.savedConfig(m.id), { [key]: parse(e.target.value) }));
    page.status(`${m.profile.name}: ${done(session.machine.config[key])} (switched off and on)`);
    page.focus();
  };
  $('ramSel').onchange = change('ram', Number, (v) => `${v}K RAM`);
  $('cpuSel').onchange = change('cpu', String, (v) => `${cpuName(v)} CPU`);
  $('chkBecker').onchange = (e) => change('becker', () => e.target.checked, (v) => `Becker port ${v ? 'on' : 'off'}`)(e);
  return { confirmSwitch };
}
