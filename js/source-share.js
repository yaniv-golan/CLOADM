/*
 * "Share your program and its source" (the Assembler's Share…, js/ui/share.js's Source mode; the arrival card,
 * js/ui/arrival.js): an assembly program shared as its SOURCE, never as the bytes it builds to (js/media/snapshot.js, the
 * source link: byte 0 = 4; a short link's sealed kind 4).
 *  - the sender: the source as the Assembler holds it, its file name, the machine and its options, and `crc`, the CRC-32
 *    of what it built to here (sourceCrc: the segments and the start address). Refused: a source over SOURCE_LINK_MAX, a
 *    build that holds a run of the machine's ROMs or a cartridge's ("Not shared: the built program contains bytes of
 *    your ROMs."). Too large for a short link, it goes as the long link.
 *  - the recipient: a fresh machine of the sender's model, the source in the Assembler, NOTHING run. They build it
 *    themselves (INCLUDE reads only CLOADM's examples/, as the Assembler always does): when it builds to the same crc,
 *    Run builds and starts it; when it doesn't (another CLOADM's assembler, a changed source or crc), it is never run
 *    and the code stays in the Assembler to read.
 * Browser-free: the page hands in the INCLUDE reader (js/media/includes.js loadIncludes over examples/).
 */
import { SessionError } from './errors.js';
import { assemble } from './asm/assembler.js';
import { profiles } from './machines/profiles.js';
import { romWindowIn } from './media/romrefs.js';
import { SOURCE_LINK_MAX, SnapshotError, encodeSourceLink, decodeSourceLink, isSourceLink, sourceCrc } from './media/snapshot.js';
import { SEALED_KIND, sealMoment } from './media/link-crypto.js';
import { buildUrl } from './config.js';
import { fromBase64Url, toBase64Url } from './util.js';

export const SOURCE_TEXT = Object.freeze({
  heading: 'Share your program and its source',
  note: 'They get the source and build it themselves; nothing runs until they press Run.',
  caption: (name, lines, cpu) => `${name} · ${lines} line${lines === 1 ? '' : 's'} of ${cpu} source`,
  arrival: (name, lines) => `Someone sent you a program with its source: ${name}, ${lines} line${lines === 1 ? '' : 's'}. It's open in the Assembler; press Run to build and start it.`,
  mismatch: 'This source builds differently in this CLOADM, so it won\'t run here. The code is in the Assembler to read.',
  roms: 'Not shared: the built program contains bytes of your ROMs.',
  tooBig: `Not shared: the source is larger than ${SOURCE_LINK_MAX / 1024} KB.`,
  shortTooBig: 'This source is too large for a short link, so this is the long link: it works without any server.',
});
export const sourceLines = (source) => String(source).split('\n').length;

export class SourceShares {
  constructor(session) { this.s = session; }

  // ---------------- the sender ----------------
  // why this build can't be shared, or null. res: the Assembler's result (js/asm/assembler.js) of `source` on the
  // machine on screen
  refusal({ source, res }, m = this.s.shownMachine) {
    if (new TextEncoder().encode(source).length > SOURCE_LINK_MAX) return SOURCE_TEXT.tooBig;
    const images = m.profile.roms.filter((r) => m.roms[r.id]).map((r) => ({ bytes: m.roms[r.id] }));
    const cart = m.cartPort && typeof m.cartPort.rom === 'function' ? m.cartPort.rom() : null;
    if (cart && cart.length) images.push({ bytes: cart });
    if (images.length && res.segments.some((sg) => romWindowIn(sg.data, images))) return SOURCE_TEXT.roms;
    return null;
  }
  // what the link holds -> { machine, config, name, source, crc }; SessionError (the refusal) when it can't be shared
  card({ source, name, res }, m = this.s.shownMachine) {
    if (!res || !res.ok) throw new SessionError('Assemble the source first: only a source that builds can be shared.');
    const why = this.refusal({ source, res }, m);
    if (why) throw new SessionError(why);
    const clean = String(name || 'program.asm').replace(/[/\\\x00-\x1F]/g, '').slice(0, 64) || 'program.asm';
    return { machine: m.id, config: this.s.shareConfig(m), name: clean, source, crc: sourceCrc(res.segments, res.exec) };
  }
  bytes(card) { return encodeSourceLink(card); }
  // the long link: the machine's address with the source in the fragment (#z=; nothing is uploaded)
  async link(base, card) {
    return `${buildUrl(base, { machine: card.machine, config: card.config }).split('#')[0]}#z=${toBase64Url(await this.bytes(card))}`;
  }
  // would its short link be too large? (the page then gives the long link, saying so)
  async tooBigForShort(card) { return (await this.bytes(card)).length + 30 > this.s.constructor.SHORT_SEALED_MAX; }
  // the short link: the same bytes sealed here and stored by `store`, no preview picture
  async shortLink(store, card) {
    const { key, sealed } = await sealMoment(await this.bytes(card), SEALED_KIND.source);
    if (sealed.length > this.s.constructor.SHORT_SEALED_MAX) throw new SessionError(SOURCE_TEXT.shortTooBig);
    let r;
    try { r = await store.create({ machine: card.machine, sealed, png: null }); }
    catch (e) { throw new SessionError(e.message); }
    return { url: store.url(r.id, key), id: r.id, deleteToken: r.deleteToken };
  }

  // ---------------- reading one ----------------
  // the machine and its options must be ones this CLOADM has (the program link's rule, Session.checkedProgram)
  checked(card) {
    if (!card || !Object.hasOwn(profiles, card.machine)) throw new SessionError('This source is for a machine this CLOADM doesn\'t have.');
    this.s.checkedProgram({ machine: card.machine, config: card.config, text: '' });
    return card;
  }
  async fromBytes(bytes) {
    let card;
    try { card = await decodeSourceLink(bytes); }
    catch (e) { throw e instanceof SnapshotError ? new SessionError(e.message) : e; }
    try { return this.checked(card); }
    catch (e) { throw new SessionError(/doesn't have/.test(e.message) ? e.message : 'This link\'s source is damaged: it was cut short or changed on the way.'); }
  }
  // a URL's fragment -> the source a #z= link holds, null when it holds none
  async read(hash) {
    const m = /^#?z=(.*)$/.exec(hash || '');
    if (!m) return null;
    let bytes;
    try { bytes = fromBase64Url(m[1]); } catch (e) { return null; }
    return isSourceLink(bytes) ? this.fromBytes(bytes) : null;
  }

  // ---------------- the recipient ----------------
  // the source built here: include(name) -> text | null (examples/ only) -> { ok, res, crc, same }; `same` only when it
  // assembled and built to the link's crc
  build(card, include = () => null) {
    const cpu = this.s.personMachine.config.cpu;
    const res = assemble(card.source, cpu, { include });
    const crc = res.ok ? sourceCrc(res.segments, res.exec) : null;
    return { ok: res.ok, res, crc, same: res.ok && crc === card.crc };
  }
  // A source arrives: a fresh machine of the sender's model, nothing run. include: as build's. -> arrivedFromLink's
  // `source`: { name, lines, state: 'ready' (it builds the same) | 'mismatch' (never run) }
  open(card, link, include = () => null) {
    this.checked(card);
    const s = this.s;
    s.switchMachine(card.machine, Object.keys(card.config).length ? Object.assign(s.savedConfig(card.machine), card.config) : undefined, { menu: false });
    const m = s.personMachine;
    const state = this.build(card, include).same ? 'ready' : 'mismatch';
    s.arrivedFromLink = { kind: link && link.kind === 'short' ? 'short' : 'long', id: link && link.kind === 'short' ? link.id || null : null,
      machine: m.profile.name, program: null, source: { name: card.name, lines: sourceLines(card.source), state } };
    s.emit('arrival');
    return s.arrivedFromLink.source;
  }
  // Run: the source built again here and started, only when it builds to the link's crc -> the run message;
  // SessionError (the mismatch) otherwise, and nothing runs
  run(card, include = () => null) {
    const b = this.build(card, include);
    if (!b.same) {
      const a = this.s.arrivedFromLink;
      if (a && a.source) { a.source.state = 'mismatch'; this.s.emit('arrival'); }
      throw new SessionError(SOURCE_TEXT.mismatch);
    }
    // (Run is the person's act on the machine: the arrival is over, as at their first key)
    this.s.touch(this.s.personMachine);
    return this.s.runAssembled(b.res);
  }
}
