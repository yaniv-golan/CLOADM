/*
 * "This program needs BASIC": a program the person loaded, running without BASIC's ROM, calls a BASIC routine the
 * built-in firmware does not have. The firmware's RTS filler returns at once, the program carries on with nothing
 * done, and the screen fills with junk. The page says why, once, in its attention card (js/ui/needs-basic.js).
 *
 * WHEN it is armed (Session.load arms it, for the machine the load went to):
 *  - a program the person loaded is running (not one of ours: the welcome menu, LIZA, the demo, the games), there is
 *    no bootable BASIC for the machine (no ROMs stored that boot it), and the built-in firmware runs;
 *  - while the Debugger has the machine stopped, or runs one of its commands (Step, Over, Out, Run to), it looks away.
 * WHAT fires it: the first instruction fetched from BASIC's ROM space as the CPU sees it then (Machine.basicRomAt: not
 * the all-RAM map, not CoCo 3 RAM mode, not a cartridge's pages) at an address the firmware does not implement (its
 * stubRom result: every byte its source assembles and every entry point it hooks, POLCAT and CHROUT among them).
 * ONCE per load: it fires at most once, the next load arms it again, and a reset or power-on clears it (and what it
 * found). The address and the frame (counted from the load) are kept for the card's details.
 *
 * Host state, like the Session's probes: no snapshot holds it.
 */
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

// Would the instruction at pc on m fire the detector now? (the rule alone, without the arming)
export function callsMissingBasic(m, pc) {
  return !!m.stubFirmware && m.useStub && m.basicRomAt(pc) && !m.stubFirmware.implemented(pc);
}

export class NeedsBasic {
  // emit(found): told once, after the run of instructions it fired in has ended
  constructor(emit) {
    this.emit = emit;
    this.m = null;          // the machine it is armed on
    this.file = null;       // the program's name (the file the person loaded)
    this.since = 0;         // m.frameCount at the load
    this.found = null;      // { file, machine, plural, roms, address, frame, id } once it fired
    this.off = null;        // removes the probe
    this.holding = false;   // keep(): a power-on that leaves what was found
  }
  get armed() { return !!this.off; }
  // a program the person loaded runs on m: watch it (a load before replaced what this watched)
  arm(m, file, bytes) {
    this.clear();
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
  // a reset or a power-on of m, or m gone (a switch, a snapshot opened): nothing is armed, nothing found -> whether a
  // finding went
  clear(m = null) {
    if (m && m !== this.m) return false;
    if (this.holding && this.found) return false;
    const had = !!this.found;
    this.disarm();
    this.m = null; this.file = null; this.found = null;
    return had;
  }
}
