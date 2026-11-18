/*
 * Ask Claude, the side panel (a bottom sheet on a phone). The machine stays live beside it: clicking the screen gives the machine the keyboard,
 * clicking the message box gives Claude the keyboard. The conversation, the backend and the state are the
 * controller's (js/ui/claude.js), shared with the full screen chat.
 *   - desktop: 420 px on the right, the left edge drags it between 320 and 560 px (remembered); the drawer's tabs
 *     fold into a 64 px icon rail, and a rail icon opens that tab over the panel (Esc closes it); minimised, a
 *     strip at the top of the drawer shows the activity and Open; below 1100 px it lies over the drawer;
 *   - phone: a bottom sheet with peek, half and full heights (the handle or the header button changes it; the
 *     message box focused makes it full; while Claude acts it drops to peek); restore points and the switch sit
 *     in its ⋯ menu;
 *   - "Claude can see": your screen, your BASIC program; reading always works, acting asks first (the consent
 *     card: Allow / Just tell me the fix; Allow turns the switch on for the visit);
 *   - while Claude acts: a pulsing ring on the screen and "Claude is typing line 120… Stop" at its top, a live
 *     log in the panel; Stop ends the turn (a key pressed on the machine does not pause Claude yet: the rules
 *     ask for it, it is not built); a restore point is made before the first change ("Restore to
 *     before Claude's changes", "All restore points": the last 10);
 *   - the API key states with the same texts as full screen: no key (the key form replaces the message box),
 *     refused (the form reopens, red), rate limited and offline (Try again; nothing retries by itself);
 *   - context openers under the machine: "Explain this error" (a BASIC error on screen, orange) and "Help with my
 *     program" (a BASIC program in memory); clicking one opens the panel and asks.
 */
import { $, ESC } from './page.js';
import { loadCardText, when } from './claude.js';
import { cpuFamily } from '../cpu/cpus.js';

const WIDTH_KEY = 'cloadm.askWidth';
const RAIL = [['Media', 'tab-media'], ['Display', 'tab-display'], ['Input', 'tab-input'], ['POKEs', 'tab-pokes'], ['Machine', 'tab-machine']];
const phone = () => matchMedia('(max-width: 700px)').matches;
const el = (tag, text, cls) => { const e = document.createElement(tag); if (text != null) e.textContent = text; if (cls) e.className = cls; return e; };

// what is on the BASIC screen worth asking about: a BASIC error ("?SN ERROR IN 120"), and the program in memory
// (Color BASIC and Dragon BASIC keep the program's start at $19 and its end at $1B; each line starts with the
// address of the next, and a zero link ends it)
export function machineContext(session, m) {
  const out = { error: null, lines: 0 };
  if (!m) return out;                     // (the page has no machine until it starts)
  let text = [];
  try { text = session.screenText(m); } catch (e) { /* not a text screen */ }
  for (const l of text) { const e = /\?([A-Z/]{2}) ERROR(?: IN (\d+))?/.exec(l); if (e) out.error = e[0]; }
  if (cpuFamily(m.config.cpu) === '6809' && m.hasRom && !m.useStub && !session.nitros9On(m)) {
    const rd = (a) => (typeof m.peek === 'function' ? m.peek(a) : m.ram[a]);
    const w = (a) => (rd(a) << 8) | rd(a + 1);
    let p = w(0x19); const end = w(0x1B);
    for (let n = 0; n < 2000 && p && p < end; n++) { const next = w(p); if (!next) break; out.lines++; p = next; }
  }
  return out;
}

export function setupAsk(page, claude) {
  const { session } = page;
  const ask = $('ask');
  let open = false, minimised = false, railTab = null, more = false;

  // ---------------- open, close, minimise ----------------
  function show() {
    open = true; minimised = false;
    ask.hidden = false;
    document.body.classList.add('ask-open');
    $('askRail').hidden = phone();
    if (phone()) setHeight('half');
    render();
    if (!phone() && !$('askInput').closest('[hidden]')) $('askInput').focus();
  }
  function hide({ keep = false } = {}) {
    open = false;
    ask.hidden = true;
    $('askRail').hidden = true;
    setRail(null);
    document.body.classList.remove('ask-open');
    if (!keep) minimised = false;
    render();
  }
  claude.registerPanel({ open: show, close: hide, get shown() { return open; } });
  // the header button: opens (full screen while the welcome menu is on screen), or closes what is open
  $('btnAsk').onclick = () => {
    if (open || session.claudeView === 'full') { claude.close(); return; }
    if (session.welcomeRunning) claude.openFull(); else claude.openPanel();
  };
  $('btnAskClose').onclick = () => { claude.close(); };
  page.onEscape(ESC.chat, () => open, () => claude.close());
  $('btnAskMin').onclick = () => { hide({ keep: true }); minimised = true; render(); page.focus(); };
  $('askStrip').onclick = () => claude.openPanel();
  $('btnAskFull').onclick = () => claude.openFull();
  $('btnAskSide').onclick = () => {};

  // ---------------- the width (desktop) and the height (phone) ----------------
  const setWidth = (w) => { const v = Math.max(320, Math.min(560, Math.round(w))); ask.style.setProperty('--ask-w', `${v}px`); return v; };
  try { const w = Number(localStorage.getItem(WIDTH_KEY)); if (w) setWidth(w); } catch (e) { /* no storage */ }
  $('askGrip').onpointerdown = (e) => {
    e.preventDefault();
    const right = ask.getBoundingClientRect().right;
    const move = (ev) => setWidth(right - ev.clientX);
    const up = (ev) => { removeEventListener('pointermove', move); removeEventListener('pointerup', up); try { localStorage.setItem(WIDTH_KEY, String(setWidth(right - ev.clientX))); } catch (x) { /* no storage */ } };
    addEventListener('pointermove', move); addEventListener('pointerup', up);
  };
  // the phone's own keyboard: how much of the window it covers (the visual viewport shrinks above it)
  const keyboardInset = () => { const v = window.visualViewport; return v ? Math.max(0, Math.round(innerHeight - v.height - v.offsetTop)) : 0; };
  function setHeight(h) {
    ask.dataset.height = h;
    // the sheet's bottom edge sits on the phone's keyboard when it is up, else on the window's bottom edge
    const inset = phone() ? keyboardInset() : 0, bottom = innerHeight - inset;
    ask.style.setProperty('--sheet-bottom', `${inset}px`);
    // half: the conversation between the screen and the bottom; full: the screen keeps its top in view. At least
    // 160 px of sheet either way, so the message box always shows
    const s = $('screen').getBoundingClientRect();
    let top = h === 'full' ? Math.max(60, s.top + s.height * 0.35) : Math.max(s.bottom + 8, 120);
    top = Math.min(top, bottom - 160);
    ask.style.setProperty('--sheet-top', `${Math.round(top)}px`);
  }
  if (window.visualViewport) {
    const follow = () => { if (open && phone() && ask.dataset.height !== 'peek') setHeight(ask.dataset.height); };
    visualViewport.addEventListener('resize', follow);
    visualViewport.addEventListener('scroll', follow);
  }
  $('askHandle').onclick = () => setHeight(ask.dataset.height === 'peek' ? 'half' : ask.dataset.height === 'half' ? 'full' : 'peek');
  $('btnAskPeekOpen').onclick = () => setHeight('half');
  $('askInput').addEventListener('focus', () => { if (phone()) setHeight('full'); });
  addEventListener('resize', () => { if (open && phone() && ask.dataset.height !== 'peek') setHeight(ask.dataset.height); $('askRail').hidden = !open || phone(); });
  $('btnAskMore').onclick = () => { more = !more; ask.classList.toggle('more', more); $('btnAskMore').setAttribute('aria-expanded', String(more)); };

  // ---------------- the rail: the drawer's tabs over the panel ----------------
  for (const [name, tab] of RAIL) {
    const b = el('button', name);
    b.setAttribute('aria-label', name);
    b.onclick = () => setRail(railTab === tab ? null : tab);
    b.dataset.tab = tab;
    $('askRail').append(b);
  }
  function setRail(tab) {
    railTab = tab;
    document.body.classList.toggle('ask-rail-drawer', !!tab);
    for (const b of $('askRail').children) b.setAttribute('aria-pressed', String(b.dataset.tab === tab));
    if (tab) $(tab).click();
  }
  addEventListener('keydown', (e) => { if (e.key === 'Escape' && railTab) { e.preventDefault(); setRail(null); } });

  // ---------------- asking ----------------
  const send = () => { const v = $('askInput').value; if (!v.trim()) return; $('askInput').value = ''; claude.ask(v); };
  $('btnAskSend').onclick = send;
  $('askInput').onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } };
  $('btnAskFix').onclick = () => claude.ask('Fix it for me');
  $('btnAskRetry').onclick = () => claude.retry();
  $('btnAskAllow').onclick = () => session.answerClaude(true);
  $('btnAskTell').onclick = () => session.answerClaude(false);
  $('btnAskLoad').onclick = () => session.answerClaude(true, { dontAsk: $('chkAskLoadNoAsk').checked });
  $('btnAskLoadNo').onclick = () => session.answerClaude(false);
  $('chkAskMachine').onchange = () => session.setClaudeAllowed($('chkAskMachine').checked);
  $('btnAskStop').onclick = () => claude.stop();
  $('btnAskResume').onclick = () => { session.resumeClaude(); page.focus(); };
  // a key the person presses on the machine Claude is using pauses Claude (before the key itself is queued, so the
  // person's key goes in and Claude's held typing does not)
  addEventListener('keydown', (e) => {
    if (e.target !== $('screen') || e.ctrlKey || e.metaKey || e.altKey || ['Shift', 'Control', 'Alt', 'Meta'].includes(e.key)) return;
    if (session.claudeBusyActing && !session.claudePaused && session.machine === session.chatTarget().machine) session.pauseClaude();
  }, true);
  // a point that can't be restored says why as an error toast; nothing changes and every point is kept
  // a disk that comes back unlinked from the Library says so after the restore's message (Session.restorePoint)
  const restore = (index) => page.attempt(() => { const r = session.restoreClaude(index); return r ? ['Restored: the machine is as it was before Claude\'s changes.', ...r.notices].join(' ') : null; });
  $('btnAskRestore').onclick = () => restore();
  $('btnAskPoints').onclick = () => { const l = $('askPointList'); l.hidden = !l.hidden; $('btnAskPoints').setAttribute('aria-expanded', String(!l.hidden)); render(); };
  // the key
  $('btnAskKeySave').onclick = () => {
    try { claude.saveKey($('askKeyInput').value); $('askKeyInput').value = ''; $('askKeyErr').textContent = ''; editingKey = false; }
    catch (e) { $('askKeyErr').textContent = e.message; }
    render();
  };
  $('askKeyInput').onkeydown = (e) => { if (e.key === 'Enter') $('btnAskKeySave').click(); };
  let editingKey = false;
  $('btnAskKeyChange').onclick = () => { editingKey = true; render(); $('askKeyInput').focus(); };
  $('btnAskKeyForget').onclick = () => claude.forgetKey();
  // the openers
  const context = () => machineContext(session, session.chatMachines ? session.chatMachines.basic : session.machine);
  $('btnOpenErr').onclick = () => claude.openPanel(`Explain this error: ${context().error}`);
  $('btnOpenProg').onclick = () => claude.openPanel('Help with my program');

  // ---------------- drawing ----------------
  let lastCtx = '';
  function render() {
    const chat = session.chat, k = claude.keyState(), st = claude.state;
    const ctx = context();
    $('btnAsk').setAttribute('aria-pressed', String(open || session.claudeView === 'full'));
    $('btnAskSide').setAttribute('aria-pressed', 'true');
    $('askStrip').hidden = !(minimised && !open && session.chat);
    // what Claude can see: the code and the registers for the Debugger's question, else the screen and the program
    const code = st.context && st.context.code != null;
    $('askSee').replaceChildren(el('span', 'Claude can see:'),
      el('span', code ? `The code at $${st.context.code.toString(16).toUpperCase().padStart(4, '0')}` : 'Your screen', 'chip'),
      el('span', code ? 'Registers and symbols' : ctx.lines ? `Your BASIC program (${ctx.lines} line${ctx.lines === 1 ? '' : 's'})` : 'Your memory', 'chip'));
    $('askInput').placeholder = code ? 'Ask about this code…' : 'Ask about your screen or program…';
    // the conversation
    const msgs = chat ? chat.messages.filter((m) => typeof m.content === 'string') : [];
    const items = msgs.map((m) => [m.role === 'user' ? 'user' : 'claude', m.content]);
    if (chat && chat.busy && st.text) items.push(['claude', st.text]);
    if (st.failed) items.push(['user', st.failed]);
    if (st.stopped) items.push(['note', '[stopped]']);
    const box = $('askMessages');
    if (box.children.length !== items.length || items.some(([r, t], i) => box.children[i].dataset.role !== r || box.children[i].textContent !== t)) {
      box.replaceChildren(...items.map(([r, t]) => { const d = el('div', t, r === 'note' ? 'msg note' : 'msg'); d.dataset.role = r; return d; }));
      $('askBody').scrollTop = $('askBody').scrollHeight;
    }
    const empty = !items.length && !(chat && chat.busy) && k !== 'none';
    $('askEmpty').hidden = !empty;
    const sug = JSON.stringify(ctx);
    if (empty && sug !== lastCtx) {
      lastCtx = sug;
      const list = [];
      if (ctx.error) { const b = el('button', 'Explain this error ', 'err'); b.append(el('span', ctx.error, 'mono')); b.onclick = () => claude.ask(`Explain this error: ${ctx.error}`); list.push(b); }
      const p = el('button', 'Help with my program '); if (ctx.lines) p.append(el('span', `(${ctx.lines} lines)`, 'muted')); p.onclick = () => claude.ask('Help with my program'); list.push(p);
      const c = el('button', 'How do I draw in colour?'); c.onclick = () => claude.ask('How do I draw in colour?'); list.push(c);
      $('askSuggest').replaceChildren(...list);
    }
    const lastUser = msgs.filter((m) => m.role === 'user').slice(-1)[0];
    $('btnAskFix').hidden = !(chat && !chat.busy && lastUser && /^Explain this error/.test(lastUser.content) && msgs.slice(-1)[0].role === 'assistant' && !session.claudeAllowed);
    // consent
    const pending = session.claudePending;
    const loading = !!(pending && pending.kind === 'load');
    $('askLoad').hidden = !loading;
    if (loading) $('askLoadText').textContent = loadCardText(pending.load);
    else $('chkAskLoadNoAsk').checked = false;
    // "Don't ask again this session" only while the switch is on: with it off every load asks, so the box is not offered
    $('chkAskLoadNoAsk').closest('label').hidden = !session.claudeAllowed;
    if (!session.claudeAllowed) $('chkAskLoadNoAsk').checked = false;
    $('askConsent').hidden = !pending || loading;
    if (pending) $('askConsentText').textContent = `To do that, Claude needs to ${pending.name === 'poke' ? 'change memory' : pending.name === 'press_break' ? 'press BREAK' : pending.name === 'assemble_and_load' ? 'load a program into memory' : pending.name === 'run' ? 'start a program' : 'type into BASIC'}. With your permission it can type, POKE, run and press BREAK. You see everything happen on the screen, Stop works at any time, and a restore point is made first so Undo puts everything back.`;
    $('chkAskMachine').checked = session.claudeAllowed;
    // the activity log and the restore point
    $('askActivity').hidden = !st.log.length;
    $('askActivity').textContent = st.log.join('\n');
    const points = session.claudePoints;
    $('askRestore').hidden = !points.length || !!(chat && chat.busy);
    if (points.length) {
      $('askRestoreWhen').textContent = `Restore point · ${when(points[0].at)}, before Claude's changes`;
      $('askPointList').replaceChildren(...points.map((pt) => { const b = el('button', `Restore point · ${when(pt.at)}`); b.onclick = () => restore(pt.index); return b; }));
    }
    // the key states
    const msg = k === 'refused' || k === 'rate-limited' || k === 'offline' || k === 'error';
    $('askKeyMsg').hidden = !msg || !!(chat && chat.busy);
    $('askKeyText').textContent = claude.keyText(k);
    $('btnAskRetry').hidden = !(k === 'rate-limited' || k === 'offline' || k === 'error');
    const form = k === 'none' || k === 'refused' || editingKey;
    $('askKeyForm').hidden = !form;
    $('askKeyForm').classList.toggle('refused', k === 'refused');
    $('askComposer').hidden = k === 'none';
    $('btnAskSend').disabled = k === 'refused' || !!(chat && chat.busy);
    $('askKeyLine').hidden = k === 'none';
    renderActing();
  }
  // the openers under the machine, the pill on the screen, the minimised strip and the phone's peek line
  function renderActing() {
    const busy = session.claudeBusyActing && session.claudeView !== 'full';
    const text = claude.activity();
    $('askActing').hidden = !busy;
    if (busy) $('askActingText').textContent = text || 'Claude is using the machine…';
    $('btnAskResume').hidden = !session.claudePaused;
    $('monitor').classList.toggle('claude-acting', !!busy);
    if (busy && phone() && open && ask.dataset.height !== 'peek') { ask.dataset.restore = ask.dataset.height; setHeight('peek'); }
    if (!busy && phone() && open && ask.dataset.restore) { setHeight(ask.dataset.restore); delete ask.dataset.restore; }
    $('askPeekText').textContent = busy ? (text || 'Claude is acting…') : 'Ask about your screen or program';
    const chatBusy = session.chat && session.chat.busy;
    $('askStripText').textContent = busy ? (text || 'Claude is acting…') : chatBusy ? 'Claude is thinking…' : 'Ready';
    // openers: not while acting, not in full screen
    if (session.claudeView === 'full') { $('askOpeners').hidden = true; return; }
    const ctx = context();
    $('btnOpenErr').hidden = !ctx.error || busy;
    if (ctx.error) $('openErrText').textContent = ctx.error;
    $('btnOpenProg').hidden = !ctx.lines || busy;
    $('askMachineNote').textContent = busy ? 'Stop on the screen ends Claude\'s turn.' : open ? 'The machine stays live while you ask.' : '';
    $('askOpeners').hidden = $('btnOpenErr').hidden && $('btnOpenProg').hidden && !$('askMachineNote').textContent;
  }
  claude.onChange(render);
  // the screen changes without an event: the openers and the pill follow it a few times a second
  let tick = 0;
  page.onFrame(() => { if (++tick % 10 === 0) renderActing(); });
  render();
  return { show, hide, get open() { return open; } };
}
