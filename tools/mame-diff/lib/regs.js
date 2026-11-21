// The register lists the lockstep comparison reads from the CPU trace, one per CPU family.
// `mame` is the name MAME's trace prints for the register.
'use strict';

const regs = (list, mame) => list.map((r) => { const [name, w] = r.split(':'); return { name, width: +w, mame: mame(name) }; });
const same = (n) => n;

const BASE_6809 = ['pc:4', 'a:2', 'b:2', 'x:4', 'y:4', 'u:4', 's:4', 'dp:2', 'cc:2'];

module.exports = {
  REGS: regs(BASE_6809, same),                                                        // 6809
  REGS_6309: regs([...BASE_6809, 'e:2', 'f:2', 'w:4', 'q:8', 'v:4', 'md:2'], (n) => n.toUpperCase()),
  REGS_6803: regs(['pc:4', 'a:2', 'b:2', 'x:4', 's:4', 'cc:2'], same),                // MC-10's MC6803
};
