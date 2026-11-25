/*
 * LIZA postcards ("Send it as a postcard", js/ui/share.js; the arrival card, js/ui/arrival.js): a chat with LIZA shared
 * as the lines the person typed, and nothing else (js/media/snapshot.js, the postcard link: byte 0 = 3).
 *
 * LIZA is deterministic: which reply it gives next is kept in its own RAM (each reply list's rotation, the last line
 * for "you said that already"), and a fresh start of LIZA (Session.runLiza: its bytes loaded again) resets all of it.
 * So the same lines typed into a fresh LIZA give the same answers, and a postcard needs nothing but the lines:
 *  - the sender's side: the Session hears each line LIZA answers (session.postcards, started by runLiza): at NOTBYE,
 *    where every line that is not a goodbye goes on, LIZA's INBUF holds it as READLN kept it. A line that ends the chat
 *    (BYE, BREAK) is not heard, so a postcard never ends LIZA. A LIZA started any other way (a moment opened from a link
 *    or a file, a Reset that runs it again with its rotation where it was) is not a chat that can be replayed: no
 *    postcard. A postcard holds the last POSTCARD_LINES lines; a longer chat starts at a later line (`from`).
 *  - the picture: the postcard replayed off-screen, on the built-in firmware in a Session of its own, from the link's
 *    own bytes (picture()), so the picture and the link never disagree, even when the chat was trimmed and so answers
 *    differently from the live one.
 *  - the recipient's side (open()): LIZA started afresh on the sender's model, waiting; Replay types the lines at
 *    POSTCARD_CPS characters a second, each line once LIZA asks for it; Skip (or a key, js/ui/arrival.js) types the
 *    rest at once. Then it is their turn.
 * Never for the Claude chat (its machine is not LIZA's), never a snapshot or a byte of memory, never an upload
 * without a tap (the Share screen's Copy link), and the lines are never edited.
 * Browser-free.
 */
import { SessionError } from './errors.js';
import { cpuFamily } from './cpu/cpus.js';
import { profiles, resolveConfig } from './machines/profiles.js';
import { POSTCARD_LINES, SnapshotError, encodePostcardLink, decodePostcardLink, isPostcardLink } from './media/snapshot.js';
import { SEALED_KIND, sealMoment } from './media/link-crypto.js';
import { buildUrl } from './config.js';
import { fromBase64Url, toBase64Url } from './util.js';

export const POSTCARD_CPS = 25;      // the replay's typing, characters a second (of the machine's time)
// LIZA's own addresses, per build (examples/liza.asm and liza6803.asm; tests/liza-postcard.test.js checks them against
// the assembled sources' symbols): its entry (START), the line it answers (NOTBYE), its goodbye (BYENOW), the prompt's
// line reader (READLN, called once per line) and the line READLN fills (INBUF, zero-terminated)
export const LIZA_AT = Object.freeze({
  '6809': Object.freeze({ start: 0x3000, heard: 0x3035, bye: 0x302A, readln: 0x3253, inbuf: 0x3C95 }),
  '6803': Object.freeze({ start: 0x5000, heard: 0x5029, bye: 0x5033, readln: 0x5398, inbuf: 0x5E10 }),
});
export const POSTCARD_FILE = 'liza-postcard.png';

// what the Share screen and the note say (fixed wordings)
export const POSTCARD_TEXT = Object.freeze({
  note: (n) => `Opens LIZA and replays this chat: your ${n} line${n === 1 ? '' : 's'} and LIZA's answers. Anyone with the link can read what you typed.`,
  trimmed: (from) => `Postcards hold ${POSTCARD_LINES} lines: this one starts at your line ${from}.`,
  offer: 'Send this chat as a postcard…',
  arrival: (n) => `A postcard from LIZA · ${n} line${n === 1 ? '' : 's'}`,
  yourTurn: 'Your turn: type to LIZA.',
});

// the LIZA build a model runs (Session.LIZA's table), or null for a model without one
export function lizaFileFor(LIZA, machine, config = {}) {
  if (!Object.hasOwn(profiles, machine)) return null;
  let cpu;
  try { cpu = resolveConfig(machine, config).cpu; } catch (e) { return null; }
  const fam = cpuFamily(cpu);
  if (fam === '6809') return LIZA['6809'];
  return fam === '6803' ? LIZA['6803'][machine] || null : null;
}

// the line LIZA's READLN left in INBUF (zero-terminated, at most its 60 characters)
function readLine(m, at) {
  let s = '';
  for (let a = at.inbuf; s.length < 61; a++) { const b = typeof m.peek === 'function' ? m.peek(a & 0xFFFF) : m.ram[a & 0xFFFF]; if (!b) break; s += String.fromCharCode(b); }
  return s;
}

export class LizaPostcards {
  constructor(session) {
    this.s = session;
    this.chat = null;        // the chat being heard: { m, at, lines, ended, broken, remove }
    this.replay = null;      // the arrival's replay: { m, at, lines, line, char, readlns, heard, paced, t0, remove }
  }

  // ---------------- the sender: hearing a chat ----------------
  // LIZA has just been loaded on m (Session.runLiza), from its entry: a new chat
  started(m) {
    this.drop();
    const at = LIZA_AT[cpuFamily(m.config.cpu)];
    if (!at) return;
    const chat = { m, at, lines: [], ended: false, broken: false, remove: null };
    chat.remove = m.addProbe((pc) => {
      if (pc === at.heard) { chat.lines.push(readLine(m, at)); this.s.emit('postcard'); }
      else if (pc === at.bye) { if (!chat.ended && chat.lines.length) { chat.ended = true; this.s.emit('postcard', 'ended'); } }
      // LIZA from its entry again (a Reset runs a stub program again) keeps its rotation where it was: not replayable
      else if (pc === at.start && chat.lines.length) chat.broken = true;
    });
    this.chat = chat;
  }
  drop() { if (this.chat) { this.chat.remove(); this.chat = null; } }

  // The chat that can be sent now -> { machine, lines (the last POSTCARD_LINES), all (how many were typed), from (the
  // first one's number, 1-based), trimmed, ended } or null: LIZA (started by runLiza) running on the machine on screen,
  // or the chat it has just ended there with BYE or BREAK (while its goodbye, then the welcome menu, is on screen),
  // with at least one line answered. Never the Claude chat's machine.
  current() {
    const s = this.s, c = this.chat, m = s.shownMachine;
    if (!c || c.broken || !c.lines.length || c.m !== m || m !== s.personMachine) return null;
    if (s.chatMachines && s.chatMachines.chat === m) return null;
    // (after BYE the welcome menu comes back: the chat just ended can still be sent from there, until something else runs)
    const running = s.bundledRunning;
    if (!(running === 'liza' || (c.ended && running === 'welcome'))) return null;
    const all = c.lines.length, lines = c.lines.slice(-POSTCARD_LINES);
    return { machine: m.id, lines, all, from: all - lines.length + 1, trimmed: all > lines.length, ended: c.ended };
  }
  // the postcard's link bytes (js/media/snapshot.js encodePostcardLink)
  bytes(card = this.current()) {
    if (!card) throw new SessionError('There is no chat with LIZA to send.');
    return encodePostcardLink({ machine: card.machine, lines: card.lines });
  }
  // the long link: the machine's address with the postcard in the fragment (#z=; nothing is uploaded)
  async link(base, card = this.current()) {
    const bytes = await this.bytes(card);
    return `${buildUrl(base, { machine: card.machine }).split('#')[0]}#z=${toBase64Url(bytes)}`;
  }
  // the short link: the same bytes sealed here and stored by `store` (js/host/link-store.js), no preview picture
  async shortLink(store, card = this.current()) {
    const { key, sealed } = await sealMoment(await this.bytes(card), SEALED_KIND.postcard);
    if (sealed.length > this.s.constructor.SHORT_SEALED_MAX) throw new SessionError('This postcard is too large for a short link. The long link works.');
    let r;
    try { r = await store.create({ machine: card.machine, sealed, png: null }); }
    catch (e) { throw new SessionError(e.message); }
    return { url: store.url(r.id, key), id: r.id, deleteToken: r.deleteToken };
  }

  // ---------------- reading one ----------------
  // a postcard as a link held it -> { machine, lines }, SessionError when this CLOADM can't open it (a model it lacks,
  // or one without LIZA)
  checked(card) {
    if (!card || !Object.hasOwn(profiles, card.machine)) throw new SessionError('This postcard is for a machine this CLOADM doesn\'t have.');
    if (!lizaFileFor(this.s.constructor.LIZA, card.machine)) throw new SessionError(`This postcard is for the ${profiles[card.machine].name}, which can't run LIZA here.`);
    return card;
  }
  // the payload's bytes -> { machine, lines }
  async fromBytes(bytes) {
    let card;
    try { card = await decodePostcardLink(bytes); }
    catch (e) { throw e instanceof SnapshotError ? new SessionError(e.message) : e; }
    return this.checked(card);
  }
  // a URL's fragment -> the postcard a #z= link holds, null when it holds none (no #z=, or another kind)
  async read(hash) {
    const m = /^#?z=(.*)$/.exec(hash || '');
    if (!m) return null;
    let bytes;
    try { bytes = fromBase64Url(m[1]); } catch (e) { return null; }
    return isPostcardLink(bytes) ? this.fromBytes(bytes) : null;
  }

  // ---------------- the picture: replayed off-screen ----------------
  // A fresh Session of its own (no ROMs: the built-in firmware, nothing of this browser's), LIZA started afresh on the
  // postcard's model and its lines typed, run until LIZA asks for the next -> the machine's frame. bytes: that model's
  // LIZA build (lizaFileFor). The same replay as the recipient's, so the picture is what the link opens to.
  replayFrame(card, bytes) {
    this.checked(card);
    const S = this.s.constructor;
    const off = new S({ welcomeMenu: false });
    off.switchMachine(card.machine, this.lizaConfig(card.machine), { menu: false });
    off.runLiza(bytes);
    const m = off.shownMachine, at = LIZA_AT[cpuFamily(m.config.cpu)];
    let readlns = 0, heard = 0;
    const remove = m.addProbe((pc) => { if (pc === at.readln) readlns++; else if (pc === at.heard) heard++; });
    off.queueText(card.lines.map((l) => `${l}\n`).join(''), m);
    for (let i = 0; i < 600 * card.lines.length + 600 && !(heard >= card.lines.length && readlns > card.lines.length); i++) off.runFrames(1);
    remove();
    off.runFrames(2);
    return m.render();
  }
  // the LIZA build the page fetches for a model (examples/<file>), or null for a model without one
  fileFor(machine) { return lizaFileFor(this.s.constructor.LIZA, machine, this.lizaConfig(machine)); }
  // the model's config for LIZA: the one this browser keeps for it, with the RAM the 6803 build needs
  lizaConfig(machine) {
    const c = Object.assign({}, this.s.savedConfig ? this.s.savedConfig(machine) : {});
    const S = this.s.constructor;
    let cpu;
    try { cpu = resolveConfig(machine, c).cpu; } catch (e) { return {}; }
    if (cpuFamily(cpu) === '6803' && !(c.ram >= S.LIZA.ram)) c.ram = S.LIZA.ram;
    return c;
  }

  // ---------------- the recipient ----------------
  // A postcard arrives: LIZA started afresh on the sender's model (bytes: its build, lizaFileFor), waiting at its
  // prompt; arrivedFromLink holds it with `postcard`: { lines, state: 'ready' | 'replaying' | 'done' } for the arrival
  // card. link: { kind: 'long' | 'short', id }.
  open(card, link, bytes) {
    this.checked(card);
    const s = this.s;
    this.stop();
    s.switchMachine(card.machine, this.lizaConfig(card.machine), { menu: false });
    s.runLiza(bytes);
    const m = s.personMachine, at = LIZA_AT[cpuFamily(m.config.cpu)];
    const r = { m, at, lines: card.lines.slice(), line: 0, char: 0, readlns: 0, heard: 0, paced: false, due: 0, remove: null };
    r.remove = m.addProbe((pc) => { if (pc === at.readln) r.readlns++; else if (pc === at.heard) r.heard++; });
    this.replay = r;
    // on the built-in firmware it arrives quietly, as a shared moment does (no no-ROM card or pill beside its card)
    s.sharedMoment = !m.hasRom;
    // (after the load: runLiza counts as the person's input, which would end an arrival recorded first)
    s.arrivedFromLink = { kind: link && link.kind === 'short' ? 'short' : 'long', id: link && link.kind === 'short' ? link.id || null : null,
      machine: m.profile.name, program: null, postcard: { lines: card.lines.length, state: 'ready' } };
    s.emit('arrival');
    return { lines: card.lines.length };
  }
  // is a postcard's replay still to finish (its card asks Replay or Skip, or it is typing)? A key goes to it then
  get pending() { const a = this.s.arrivedFromLink; return !!this.replay && !!a && !!a.postcard && a.postcard.state !== 'done'; }
  setState(state) {
    const a = this.s.arrivedFromLink;
    if (a && a.postcard && a.postcard.state !== state) { a.postcard.state = state; this.s.emit('arrival'); }
  }
  // Replay: the lines typed at POSTCARD_CPS, each once LIZA asks for it (step, every frame)
  play() { if (!this.pending) return; this.replay.paced = true; this.replay.due = 0; this.setState('replaying'); }
  // Skip to the end (or a key during the replay): what is still to type, typed at once
  skip() {
    const r = this.replay;
    if (!this.pending) return;
    const rest = r.lines.slice(r.line);
    if (rest.length) rest[0] = rest[0].slice(r.char);
    this.s.queueText(rest.map((l) => `${l}\n`).join(''), r.m);
    r.line = r.lines.length; r.char = 0; r.paced = false;
    this.setState('replaying');
  }
  stop() { if (this.replay) { this.replay.remove(); this.replay = null; } }
  // every frame of machine m (Session.oneFrame)
  step(m) {
    const r = this.replay;
    if (!r) return;
    // its machine is no longer the person's (a switch, a snapshot): the replay goes with it
    if (r.m !== this.s.personMachine) { this.stop(); return; }
    if (r.m !== m) return;
    const a = this.s.arrivedFromLink;
    // the arrival is over (the person typed, switched, reset): the replay with it
    if (!a || !a.postcard) { this.stop(); return; }
    if (r.paced && r.line < r.lines.length) {
      r.due += POSTCARD_CPS / m.fps;
      // a line is typed only once LIZA asks for it (its READLN for that line has begun)
      while (r.due >= 1 && r.line < r.lines.length && r.readlns > r.line) {
        const l = r.lines[r.line];
        if (r.char < l.length) { this.s.queueText(l[r.char], m); r.char++; } else { this.s.queueText('\n', m); r.line++; r.char = 0; }
        r.due -= 1;
      }
      if (r.readlns <= r.line) r.due = Math.min(r.due, 1);
    }
    if (r.line >= r.lines.length && r.heard >= r.lines.length && r.readlns > r.lines.length) {
      this.stop();
      this.setState('done');
    }
  }
}
