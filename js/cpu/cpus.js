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
