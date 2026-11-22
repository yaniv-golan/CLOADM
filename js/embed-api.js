/*
 * The embed API: what a page that embeds CLOADM (/play/?embed=1 in an iframe) can ask of it.
 * Browser-free: the page side (js/ui/embed.js) only carries messages between window.parent and this object;
 * the host side (embed/cloadm.js, CLOADM.attach(iframe)) turns them into promises and events.
 *
 * Messages, both ways, are plain objects tagged { cloadm: 1 }:
 *   host -> page   { cloadm: 1, id, method, args: [...] }      a call
 *   page -> host   { cloadm: 1, id, result } | { cloadm: 1, id, error }
 *   page -> host   { cloadm: 1, event, data }                  'ready', 'machine', 'loaded', 'reset', 'frame'
 * 'frame' events are sent only after the host asked for them (method 'watchFrames').
 *
 * Methods (EmbedApi.METHODS): info, type, loadBasic, load, insertTape, reset, powerCycle, switchMachine, peek,
 * poke, screenText, setDisplay, watchFrames. Bytes travel as arrays of numbers or Uint8Arrays.
 */
import { profiles } from './machines/profiles.js';
import { SessionError } from './session.js';

const EVENTS = ['machine', 'loaded', 'reset', 'firmware'];
const bytesOf = (b) => (b instanceof Uint8Array ? b : Array.isArray(b) ? Uint8Array.from(b) : null);
const addrOf = (a) => { if (!Number.isInteger(a) || a < 0 || a > 0xFFFF) throw new SessionError(`${a} is not an address (0 to 65535)`); return a; };

export class EmbedApi {
  // send(message): how messages reach the host (the bridge: window.parent.postMessage)
  constructor(session, send) {
    this.session = session;
    this.send = send;
    this.frames = false;
    session.on((ev) => { if (EVENTS.includes(ev)) this.send({ cloadm: 1, event: ev === 'firmware' ? 'reset' : ev, data: this.info() }); });
  }
  // what is running
  info() {
    const m = this.session.shownMachine;
    const config = {};
    for (const [k, v] of Object.entries(m.config)) if (m.profile.options[k]) config[k] = v;
    return { machine: m.id, name: m.profile.name, config, roms: m.hasRom, frame: m.frameCount };
  }
  // type text as if at the keyboard ('\n' is ENTER); -> number of characters
  type(text) {
    if (typeof text !== 'string') throw new SessionError('type: text must be a string');
    // Session.typeText pauses Claude itself (js/session.js: its first line is personInput), so this call is the same
    // one load/insertTape/poke make at this layer rather than an extra pause: defence in depth, so the embed API's
    // acting methods all state the person's input the same way.
    this.session.personInput();
    return this.session.typeText(text);
  }
  // a BASIC program listing into program memory, as a tape load would, without typing it (Session.loadBasic: needs
  // BASIC at its OK prompt) -> { lines, bytes, start, end }; a refusal is the error, e.g. "no-basic: ..."
  loadBasic(program) {
    if (typeof program !== 'string') throw new SessionError('loadBasic: program must be a string');
    return this.session.loadBasic(program);
  }
  // load and run a program, tape or cartridge, as a dropped file -> the status message
  load(name, bytes) {
    const b = bytesOf(bytes);
    if (typeof name !== 'string' || !b) throw new SessionError('load: give a file name and its bytes');
    this.session.personInput();
    return this.session.load(name, b, { remember: false });
  }
  insertTape(name, bytes) {
    const b = bytesOf(bytes);
    if (typeof name !== 'string' || !b) throw new SessionError('insertTape: give a file name and its bytes');
    this.session.personInput();
    return this.session.insertTape(name, b);
  }
  reset() { this.session.reset(); return this.info(); }
  powerCycle() { this.session.powerCycle(); return this.info(); }
  // another model or options, checked against profile.options
  switchMachine(id, config = {}) {
    const p = profiles[id];
    if (!p) throw new SessionError(`switchMachine: no machine "${id}"`);
    for (const [k, v] of Object.entries(config || {})) {
      const o = p.options[k];
      if (!o) throw new SessionError(`switchMachine: the ${p.name} has no option "${k}"`);
      if (!o.values.includes(v)) throw new SessionError(`switchMachine: ${k} on the ${p.name} is ${o.values.join(' or ')}`);
    }
    this.session.switchMachine(id, Object.assign(this.session.savedConfig(id), config));
    return this.info();
  }
  // memory as the CPU sees it (no side effects) -> array of bytes
  // memory, never while ROM code can be in it (Session.romCodeIn): the page around the iframe is someone else's
  peek(addr, length = 1) {
    const why = this.session.romCodeIn();
    if (why) throw new SessionError(`peek is not available while ${why === 'roms' ? 'the machine runs your own ROMs' : why === 'nitros9' ? 'NitrOS-9 runs from your own image' : 'a cartridge is plugged in'}: its memory can hold copies of ROM code, which CLOADM never hands out.`);
    addrOf(addr);
    if (!Number.isInteger(length) || length < 1 || addr + length > 0x10000) throw new SessionError('peek: length runs past 65535');
    const m = this.session.shownMachine, out = [];
    for (let a = addr; a < addr + length; a++) out.push(m.peek ? m.peek(a) : m.ram[a]);
    return out;
  }
  // write RAM -> number of bytes written
  poke(addr, bytes) {
    addrOf(addr);
    const b = bytesOf(typeof bytes === 'number' ? [bytes] : bytes);
    if (!b || addr + b.length > 0x10000) throw new SessionError('poke: give bytes that fit below 65536');
    // (the embedding page's calls are the person's input: Claude acting on the machine pauses first, Session.personInput)
    this.session.personInput();
    for (let i = 0; i < b.length; i++) this.session.shownMachine.poke(addr + i, b[i] & 0xFF);
    return b.length;
  }
  screenText() { return this.session.screenText(); }
  // display settings for this page only (never stored)
  setDisplay(changes) { return Object.assign({}, this.session.setDisplay(changes, { remember: false })); }
  watchFrames(on = true) { this.frames = !!on; return this.frames; }
  // after each emulated frame (the bridge calls it)
  frame() { if (this.frames) this.send({ cloadm: 1, event: 'frame', data: { frame: this.session.shownMachine.frameCount } }); }

  // one message from the host -> its reply (also sent); anything not a CLOADM call -> null
  handle(msg) {
    if (!msg || msg.cloadm !== 1 || typeof msg.method !== 'string' || msg.id === undefined) return null;
    let reply;
    if (!EmbedApi.METHODS.includes(msg.method)) reply = { cloadm: 1, id: msg.id, error: `no method "${msg.method}"` };
    else {
      try { reply = { cloadm: 1, id: msg.id, result: this[msg.method](...(Array.isArray(msg.args) ? msg.args : [])) }; }
      catch (e) { reply = { cloadm: 1, id: msg.id, error: e.message }; }
    }
    this.send(reply);
    return reply;
  }
}
EmbedApi.METHODS = ['info', 'type', 'loadBasic', 'load', 'insertTape', 'reset', 'powerCycle', 'switchMachine', 'peek', 'poke', 'screenText', 'setDisplay', 'watchFrames'];
