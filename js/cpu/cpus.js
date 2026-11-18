/*
 * CPU cores by type, as named in machine configs (config.cpu). Also the debugger's registry: it asks for a
 * core class by the same name. The 7000 is the Speech/Sound Pak's own processor, used by
 * the SSC cartridge (js/machines/ssc.js); it is registered here so the assembler, the disassembler and the
 * CPU are reachable by the same name.
 */
import { CPU6809 } from './cpu6809.js';
import { CPU6309 } from './cpu6309.js';
import { registry } from '../util.js';
import { CPU6803 } from './cpu6803.js';
import { CPU7000 } from './cpu7000.js';

export const cpus = registry({ '6809': CPU6809, '6309': CPU6309, '6803': CPU6803, '7000': CPU7000 });

// Instruction-set family of a machine's CPU: the 6309 runs the 6809's instruction set (and every 6809
// program in emulation mode), so the 6809 and 6309 are one family for choosing builds written for the 6809.
// The 6803 is its own family; the 7000 (the Speech/Sound Pak's own chip) maps to itself, so it never matches
// a 6809 or 6803 build. The values are what a machine's config.cpu is, so a UI gate must compare the family,
// not the config.
export const CPU_FAMILY = Object.freeze({ '6809': '6809', '6309': '6809', '6803': '6803', '7000': '7000' });
export const cpuFamily = (cpu) => CPU_FAMILY[cpu] || null;
