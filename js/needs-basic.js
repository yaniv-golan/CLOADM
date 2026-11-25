/*
 * "This program needs BASIC": a program the person loaded, running without BASIC's ROM, calls a BASIC routine the
 * built-in firmware does not have. The firmware's RTS filler returns at once, the program carries on with nothing
 * done, and the screen fills with junk. The page says why, once, in its attention card (js/ui/needs-basic.js).
 *
 * WHEN it is armed (Session.load arms it, for the machine the load went to):
 *  - a program the person loaded is running (not one of ours: the welcome menu, LIZA, the demo, the games), there is
 *    no bootable BASIC for the machine (no ROMs stored that boot it), and the built-in firmware runs;
 *  - while the Debugger has the machine stopped, or runs one of its commands (Step, Over, Out, Run to), it looks away.
 * WHAT fires it: the first instruction fetched from BASIC's ROM space as the CPU sees it then (basicRomAt below: not
 * the all-RAM map, not CoCo 3 RAM mode, not a cartridge's pages) at an address the firmware does not implement (its
 * stubRom result: every byte its source assembles and every entry point it hooks, POLCAT and CHROUT among them).
 * ONCE per load: it fires at most once, the next load arms it again, and a reset or power-on clears it (and what it
 * found). The address and the frame (counted from the load) are kept for the card's details.
 *
 * Host state, like the Session's probes: no snapshot holds it. The side panel (connector/) has no card for it and folds
 * connector/view/needs-basic-off.js in its place.
 */
import { SessionError } from './errors.js';

// What the built-in firmware implements: every byte its source assembles (code, the vector tables) and every named entry
// point it hooks (POLCAT, CHROUT ... are EQUs onto the RTS filler, run by the Machine's PC hooks). The rest of its image
// is filler: a program that executes there called a BASIC routine the firmware does not have. firmware: stubRom's
// result ({ base, size, segments, symbols }) -> (address) -> boolean, made once per firmware.
const implementedFor = new WeakMap();
export function implementedBy(firmware) {
  let f = implementedFor.get(firmware);
  if (f) return f;
  const { base, size } = firmware, mask = new Uint8Array(size);
  for (const s of firmware.segments) for (let i = 0; i < s.data.length; i++) {
    const a = s.addr + i - base;
    if (a >= 0 && a < size) mask[a] = 1;
  }
  for (const a of firmware.symbols.values()) if (a >= base && a < base + size) mask[a - base] = 1;
  f = (a) => a >= base && a < base + size && mask[a - base] === 1;
  implementedFor.set(firmware, f);
  return f;
}
// The words the card says, from the profile's sockets: the machine's name, and "ROMs" when more than one ROM is
// needed: the required BASIC sockets, and the socket whose space the program called into (a CoCo's Extended Color
// BASIC, for a call at $8000-$9FFF, as well as its Color BASIC).
export function needsBasicWords(profile, address) {
  const sockets = profile.roms.filter((s) => !s.chip && s.at != null && s.bank === 0);
  const needed = new Set(sockets.filter((s) => s.required));
  const into = sockets.find((s) => address >= s.at && address < s.at + s.size);
  if (into) needed.add(into);
  const plural = needed.size > 1;
  return { machine: profile.name, plural, roms: plural ? 'ROMs' : 'ROM' };
}

// the card's text for what was found (Session.needsBasic.found): { lead, body, details }
export function needsBasicText(found) {
  const { file, machine, plural, address, frame } = found;
  const rom = plural ? "BASIC ROMs, which aren't added yet." : "BASIC ROM, which isn't added yet.";
  return {
    lead: `${file} needs the ${machine}'s ${rom}`,
    body: "It tried to use BASIC, and there's nothing there yet, so the screen fills with junk.",
    details: `It called $${address.toString(16).toUpperCase().padStart(4, '0')}, in the BASIC ROM's space, at frame ${frame}.`,
  };
}

// Is an instruction at pc fetched from BASIC's ROM space as m's CPU sees it now (the built-in firmware mapped there, not
// RAM and not a cartridge)? The detector's own knowledge of the families' maps:
//  - the MC-10 and Alice: $E000-$FFFF, always ROM;
//  - the CoCo 3: $8000-$FDFF while the GIME maps ROM there (not RAM mode, not a RAM block from the MMU), and not
//    cartridge space ($C000 up) when a cartridge is in the port;
//  - the SAM machines: $8000-$BFFF while the map shows ROM there (map type 0; the all-RAM map, TY=1, shows RAM).
export function basicRomAt(m, pc) {
  if (m.profile.family === 'mc10') return pc >= 0xE000;
  if (m.gime) return pc >= 0x8000 && pc < (m.cartPort ? 0xC000 : 0xFE00) && m.gime.wr[pc >> 13] === m.gime.sink;
  return !!m.sam && pc >= 0x8000 && pc < 0xC000 && m.stubActive();
}

// Would the instruction at pc on m fire the detector now? (the rule alone, without the arming)
export function callsMissingBasic(m, pc) {
  return !!m.stubFirmware && m.useStub && basicRomAt(m, pc) && !implementedBy(m.stubFirmware)(pc);
}

export class NeedsBasic {
  // the Session's (Session.needsBasic): what it finds is the Session's event 'needs-basic', told once, after the run of
  // instructions it fired in has ended (and 'needs-basic' with null when that is over)
  constructor(session) {
    this.session = session;
    this.emit = (found) => session.emit('needs-basic', found);
    this.m = null;          // the machine it is armed on
    this.file = null;       // the program's name (the file the person loaded)
    this.since = 0;         // m.frameCount at the load
    this.found = null;      // { file, machine, plural, roms, address, frame, id } once it fired
    this.off = null;        // removes the probe
    this.holding = false;   // keep(): a power-on that leaves what was found
  }
  get armed() { return !!this.off; }
  // Session.load: a program started on m. Watched when the person loaded it (not one of ours: ours) and the machine has
  // no bootable BASIC (the built-in firmware runs, no stored ROMs boot it)
  loaded(m, file, bytes, ours) {
    this.clear();
    if (!ours && m.useStub && !this.session.machineRoms(m.id).bootable) this.arm(m, file, bytes);
  }
  // the Session adopted m (a switch, a snapshot opened): a machine it did not watch means what it watched is gone
  adopted(m) { if (m !== this.m) this.clear(); }
  // The card's "Run <file> again with ROMs" (Session.needsBasic.runAgain()), once the machine's ROMs are added: the
  // machine is switched off and on with them, and the same file loads through the same path as before (Session.load)
  // -> its message
  runAgain() {
    const session = this.session, f = this.found, m = session.personMachine;
    if (!f) throw new SessionError('There is no program to run again.');
    if (m.profile.id !== f.id) throw new SessionError(`${f.file} ran on the ${f.machine}; this is the ${m.profile.name}.`);
    if (!session.machineRoms(m.id).bootable) throw new SessionError(`The ${m.profile.name}'s BASIC ${f.roms} ${f.plural ? "aren't" : "isn't"} added yet.`);
    session.stubChosen.delete(m.id);
    session.loadSavedRoms(m);
    session.powerCycle({ menu: false, reason: 'you ran the program again with ROMs', on: m });
    return session.load(f.file, f.bytes);
  }
  // a program the person loaded runs on m: watch it (a load before replaced what this watched)
  arm(m, file, bytes) {
    this.disarm();
    this.m = m; this.file = file; this.since = m.frameCount;
    const probe = (pc) => {
      const d = m.debugger;
      if (d && (d.stopped || d.commanding)) return;
      if (!callsMissingBasic(m, pc)) return;
      this.found = { file, bytes, address: pc, frame: m.frameCount - this.since, id: m.profile.id, ...needsBasicWords(m.profile, pc) };
      this.disarm();
      // said once the instructions running now are done (the page draws the card, outside the CPU's loop)
      const done = m.addRunEnd(() => { done(); if (this.found && this.m === m) this.emit(this.found); });
    };
    this.off = m.addProbe(probe);
  }
  disarm() { if (this.off) { this.off(); this.off = null; } }
  // fn() switches the machine on with the ROMs the program needed (Session.addRoms): what was found stays, for the
  // card's "Run <file> again with ROMs"
  keep(fn) {
    this.holding = true;
    try { fn(); } finally { this.holding = false; }
  }
  // a reset or a power-on of m, or m gone (a switch, a snapshot opened): nothing is armed, nothing found; a finding that
  // goes is said (emit(null): the page's card goes with it)
  clear(m = null) {
    if (m && m !== this.m) return;
    if (this.holding && this.found) return;
    const had = !!this.found;
    this.disarm();
    this.m = null; this.file = null; this.found = null;
    if (had) this.emit(null);
  }
}
