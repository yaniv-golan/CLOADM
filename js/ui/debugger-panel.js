/*
 * The Debugger screen, at /play/#debugger instead of the
 * emulator: the assembler's source, the registers (editable) with the condition codes, the machine's screen
 * (live while running and after every step), the disassembly around the program counter (click a line for a
 * breakpoint), the breakpoint and watchpoint list with a form to add one by address or label, the memory view
 * (click a byte to edit it or watch it) and the trace of the last instructions. Run F5 (Pause while running),
 * Step F11, Over F10, Out Shift+F11. Everything goes through Session.debug (js/debugger.js); a breakpoint or
 * watchpoint stops the running machine through the frame loop (Session.advance).
 *
 * Not built: "Step back" (snapshot rewind needs a per-frame history the debugger doesn't
 * keep), source-line breakpoints (the assembler gives no line-to-address map), hit counts, the beam line, and
 * the per-frame IRQ chart (the trace here is the instruction trace the debugger keeps).
 */
import { CanvasPresenter } from '../video/canvas.js';
import { $ } from './page.js';

const hex2 = (v) => '$' + (v & 0xFF).toString(16).toUpperCase().padStart(2, '0');
const hex4 = (v) => '$' + (v & 0xFFFF).toString(16).toUpperCase().padStart(4, '0');
const bare4 = (v) => (v & 0xFFFF).toString(16).toUpperCase().padStart(4, '0');
const bare2 = (v) => (v & 0xFF).toString(16).toUpperCase().padStart(2, '0');
const WIDE = new Set(['d', 'x', 'y', 'u', 's', 'pc']);
const ORDER = { '6809': ['pc', 'a', 'b', 'dp', 'x', 'y', 'u', 's'], '6803': ['pc', 'a', 'b', 'd', 'x', 's'] };
const FLAGS = { '6809': ['E', 'F', 'H', 'I', 'N', 'Z', 'V', 'C'], '6803': ['H', 'I', 'N', 'Z', 'V', 'C'] };
const DIS_LINES = 16, MEM_ROWS = 8, TRACE_LINES = 12;
// a byte as the VDG shows it on the text screen (the memory view's right-hand column)
const vdgChar = (v) => { if (v & 0x80) return '▒'; const c = v & 0x3F; return String.fromCharCode(c < 32 ? c + 64 : c); };
const el = (tag, text, cls) => { const e = document.createElement(tag); if (text != null) e.textContent = text; if (cls) e.className = cls; return e; };

export function setupDebuggerPanel(page) {
  const { session } = page;
  const view = $('debugView'), screen = new CanvasPresenter($('dbgScreen'));
  let disStart = null, memAddr = 0x400, selected = null, lastRegs = null, lastAction = null;

  // ---------------- open and close (#debugger) ----------------
  const isOpen = () => location.hash === '#debugger';
  function show() {
    const open = isOpen();
    document.body.classList.toggle('debug-open', open);
    view.hidden = !open;
    if (open) refresh();
  }
  page.onView(show);
  const close = () => page.closeView();
  $('btnDbgBack').onclick = (e) => { e.preventDefault(); close(); };
  $('navDebugger').onclick = (e) => { e.preventDefault(); page.openView('#debugger'); };

  // ---------------- addresses: $3000, 3000, 0x3000, &H3000 or a label of the assembled program ----------------
  const labels = () => session.labels || new Map();
  function parseAddr(text) {
    const t = String(text).trim();
    if (labels().has(t.toUpperCase())) return labels().get(t.toUpperCase());
    if (labels().has(t)) return labels().get(t);
    const m = /^(?:\$|0x|&h)?([0-9a-f]{1,4})$/i.exec(t);
    if (!m) throw new Error(`"${t}" is not an address ($0000 to $FFFF) or a label of the assembled program`);
    return parseInt(m[1], 16);
  }
  // LABEL or LABEL+$06 for an address near a label (within 256 bytes after it), else $3006
  function where(addr) {
    let best = null;
    for (const [name, a] of labels()) if (a <= addr && addr - a < 0x100 && (!best || a > best[1])) best = [name, a];
    return best ? (best[1] === addr ? best[0] : `${best[0]}+${hex2(addr - best[1])}`) : hex4(addr);
  }

  // ---------------- what the screen shows ----------------
  function status() {
    const d = session.debug, m = session.machine, cyc = Math.floor(m.cpu.totalCycles).toLocaleString('en-US');
    const st = $('dbgStatus');
    st.classList.toggle('stopped', d.stopped);
    if (!d.stopped) { st.textContent = `● Running · cycle ${cyc}`; return; }
    const r = d.stopReason || {}, at = where(d.pc);
    st.textContent = r.kind === 'breakpoint' ? `● Stopped at breakpoint · ${at} · cycle ${cyc}`
      : r.kind === 'watchpoint' ? `● Stopped by a ${r.access} of ${hex4(r.address)} (${hex2(r.value)}) · at ${at} · cycle ${cyc}`
        : r.kind === 'until' ? `● Stopped at ${at} (${lastAction === 'out' ? 'returned' : 'stepped over'}) · cycle ${cyc}`
          : r.kind === 'limit' ? `● Stopped after ${r.instructions.toLocaleString('en-US')} instructions without ${lastAction === 'out' ? 'returning' : 'coming back'} · at ${at} · cycle ${cyc}`
          : lastAction === 'step' ? `● Stepped to ${at} · cycle ${cyc}` : `● Paused at ${at} · cycle ${cyc}`;
  }
  function runButton() {
    const b = $('btnDbgRun'), stopped = session.debug.stopped;
    b.replaceChildren(stopped ? 'Run ' : 'Pause ', el('kbd', 'F5'));
    b.classList.toggle('primary', stopped);
  }
  function registers() {
    const d = session.debug, cpu = session.machine.config.cpu, regs = d.registers(), box = $('dbgRegs');
    box.replaceChildren();
    for (const r of ORDER[cpu]) {
      const cell = el('label', null, 'reg');
      const name = el('span', r.toUpperCase(), 'name');
      const input = el('input'); input.dataset.reg = r; input.spellcheck = false;
      input.value = WIDE.has(r) ? hex4(regs[r]) : hex2(regs[r]);
      input.setAttribute('aria-label', `Register ${r.toUpperCase()}`);
      if (lastRegs && lastRegs[r] !== regs[r]) input.classList.add('changed');
      input.onchange = () => { page.attempt(() => { d.setRegister(r, parseAddr(input.value)); }); refresh(); };
      cell.append(name, input);
      box.append(cell);
    }
    const cc = el('div', null, 'cc'); cc.append(el('span', 'CC', 'name'));
    const flags = FLAGS[cpu];
    flags.forEach((f, i) => {
      const bit = flags.length - 1 - i, on = !!((regs.cc >> bit) & 1);
      const b = el('button', f, on ? 'flag on' : 'flag'); b.setAttribute('aria-pressed', String(on)); b.dataset.flag = f;
      b.title = `${f}: ${on ? 'set' : 'clear'} (click to ${on ? 'clear' : 'set'})`;
      b.onclick = () => { d.setRegister('cc', regs.cc ^ (1 << bit)); refresh(); };
      cc.append(b);
    });
    box.append(cc);
    lastRegs = regs;
  }
  function disassembly() {
    const d = session.debug, pc = d.pc;
    // keep the listing still while the program counter moves inside it; otherwise start at the counter
    if (disStart === null || pc < disStart || pc >= disStart + 3 * DIS_LINES) disStart = pc;
    let lines = d.disassemble(disStart, DIS_LINES);
    if (!lines.some((l) => l.addr === pc)) { disStart = pc; lines = d.disassemble(pc, DIS_LINES); }
    const bps = new Set(d.breakpoints()), labelAt = new Map([...labels()].map(([n, a]) => [a, n]));
    $('dbgDis').replaceChildren(...lines.map((l) => {
      const row = el('button', null, 'dis'); row.dataset.addr = l.addr;
      if (l.addr === pc) row.classList.add('pc');
      row.append(el('span', bare4(l.addr), 'addr'), el('span', l.bytes.map(bare2).join(' ').padEnd(12), 'bytes'),
        el('span', bps.has(l.addr) ? '●' : ' ', 'bp'), el('span', (labelAt.get(l.addr) || '').padEnd(7), 'label'), el('span', l.text, 'text'));
      row.title = `${hex4(l.addr)}: click to ${bps.has(l.addr) ? 'remove the' : 'set a'} breakpoint`;
      row.onclick = () => { if (bps.has(l.addr)) d.removeBreakpoint(l.addr); else d.addBreakpoint(l.addr); refresh(); };
      return row;
    }));
    $('dbgCpu').textContent = session.machine.config.cpu;
  }
  function breakpoints() {
    const d = session.debug, rows = [];
    for (const a of d.breakpoints()) {
      const r = el('div', null, 'bprow'); r.dataset.bp = a;
      const x = el('button', '×', 'x'); x.setAttribute('aria-label', `Remove the breakpoint at ${hex4(a)}`);
      x.onclick = () => { d.removeBreakpoint(a); refresh(); };
      r.append(el('span', '●', 'mark exec'), el('span', `exec  ${where(a)}`), x);
      rows.push(r);
    }
    d.watchpoints().forEach((w, i) => {
      const kind = w.read && w.write ? 'read/write' : w.write ? 'write' : 'read';
      const r = el('div', null, 'bprow'); r.dataset.wp = w.start;
      const x = el('button', '×', 'x'); x.setAttribute('aria-label', `Remove the watchpoint on ${hex4(w.start)}`);
      x.onclick = () => { d.removeWatchpoint(d.wps[i]); refresh(); };
      r.append(el('span', w.write ? '◆' : '▲', `mark ${w.write ? 'write' : 'read'}`), el('span', `${kind}  ${hex4(w.start)}${w.size > 1 ? `-${hex4(w.start + w.size - 1)}` : ''}${labelAtName(w.start)}`), x);
      rows.push(r);
    });
    if (!rows.length) rows.push(el('div', 'None. Click a line of the disassembly, or add one below.', 'muted'));
    $('dbgBps').replaceChildren(...rows);
  }
  const labelAtName = (a) => { for (const [n, v] of labels()) if (v === a) return ` ${n}`; return ''; };
  function memory() {
    const d = session.debug, rows = [];
    for (let r = 0; r < MEM_ROWS; r++) {
      const base = (memAddr + r * 16) & 0xFFFF, row = el('div', null, 'memrow');
      row.append(el('span', bare4(base), 'addr'));
      const bytes = d.peekBytes(base, 16), cells = el('span', null, 'cells');
      bytes.forEach((v, i) => {
        const a = (base + i) & 0xFFFF, b = el('button', bare2(v), 'byte'); b.dataset.addr = a;
        if (a === selected) b.classList.add('sel');
        b.onclick = () => { selected = a; memory(); $('dbgByteValue').focus(); };
        cells.append(b);
      });
      row.append(cells, el('span', bytes.map(vdgChar).join(''), 'text'));
      rows.push(row);
    }
    $('dbgMem').replaceChildren(...rows);
    $('dbgByte').hidden = selected === null;
    if (selected !== null) {
      $('dbgByteAddr').textContent = `${hex4(selected)}${labelAtName(selected)}`;
      $('dbgByteValue').value = bare2(d.peek(selected));
    }
  }
  function trace() {
    const t = session.debug.trace().slice(-TRACE_LINES);
    $('dbgTrace').replaceChildren(...(t.length ? t.map((e) => {
      const row = el('div', null, 'trow');
      row.append(el('span', bare4(e.pc), 'addr'), el('span', e.text, 'text'), el('span', `${e.cycles}`, 'cyc'));
      return row;
    }) : [el('div', 'Step or stop at a breakpoint: the instructions the debugger ran appear here.', 'muted')]));
  }
  function refresh() {
    if (!isOpen() || !session.machine) return;
    status(); runButton(); registers(); disassembly(); breakpoints(); memory(); trace();
  }

  // ---------------- commands ----------------
  const d = () => session.debug;
  // after a step command the machine stays stopped (a step leaves it running otherwise)
  const hold = () => { if (!d().stopped) d().halt(); };
  function command(kind) {
    lastAction = kind;
    try {
      if (kind === 'run') { if (d().stopped) session.resume(); else d().halt(); }
      else if (kind === 'step') { if (!d().stopped) d().halt(); d().step(); hold(); }
      else if (kind === 'over') { if (!d().stopped) d().halt(); d().stepOver(); hold(); }
      else if (kind === 'out') { if (!d().stopped) d().halt(); d().runToReturn(); hold(); }
    } catch (e) { page.status(e.message, true); }
    refresh();
  }
  $('btnDbgRun').onclick = () => command('run');
  $('btnDbgStep').onclick = () => command('step');
  $('btnDbgOver').onclick = () => command('over');
  $('btnDbgOut').onclick = () => command('out');
  addEventListener('keydown', (e) => {
    if (!isOpen() || e.target.closest('input, textarea, select')) return;
    const k = e.key === 'F5' ? 'run' : e.key === 'F10' ? 'over' : e.key === 'F11' ? (e.shiftKey ? 'out' : 'step') : null;
    if (!k) return;
    e.preventDefault(); e.stopPropagation();
    command(k);
  }, { capture: true });

  $('dbgAddBp').onsubmit = (e) => {
    e.preventDefault();
    try {
      const a = parseAddr($('dbgBpAddr').value), kind = $('dbgBpKind').value;
      if (kind === 'exec') d().addBreakpoint(a);
      else d().addWatchpoint(a, 1, { read: kind !== 'write', write: kind !== 'read' });
      $('dbgBpAddr').value = '';
    } catch (err) { page.status(err.message, true); }
    refresh();
  };
  $('dbgMemAddr').onchange = () => {
    try { memAddr = parseAddr($('dbgMemAddr').value) & 0xFFF0; $('dbgMemAddr').value = hex4(memAddr); } catch (err) { page.status(err.message, true); }
    memory();
  };
  $('dbgByteSet').onclick = () => {
    try {
      const v = parseInt($('dbgByteValue').value.replace(/^\$/, ''), 16);
      if (!(v >= 0 && v <= 0xFF)) throw new Error('A byte is $00 to $FF');
      d().write(selected, [v]);
    } catch (err) { page.status(err.message, true); }
    refresh();
  };
  $('dbgByteValue').onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); $('dbgByteSet').click(); } };
  $('dbgByteWatch').onclick = () => { d().addWatchpoint(selected, 1, { read: false, write: true }); refresh(); };
  $('dbgByteWatchRead').onclick = () => { d().addWatchpoint(selected, 1, { read: true, write: false }); refresh(); };

  // ---------------- keeping it current ----------------
  session.on((ev) => {
    if (ev === 'machine') { disStart = null; lastRegs = null; selected = null; }
    if (ev === 'debug' || ev === 'machine' || ev === 'loaded') refresh();
  });
  // live while running: the screen every frame, the rest a few times a second
  let lastSlow = 0;
  const loop = (now) => {
    requestAnimationFrame(loop);
    if (!isOpen() || !session.machine) return;
    screen.present(session.machine.render());
    // (the registers only while none is being edited)
    if (!session.debug.stopped && now - lastSlow > 250) { lastSlow = now; status(); runButton(); if (!view.contains(document.activeElement) || !document.activeElement.dataset.reg) registers(); }
  };
  requestAnimationFrame(loop);
  show();
  return { refresh };
}
