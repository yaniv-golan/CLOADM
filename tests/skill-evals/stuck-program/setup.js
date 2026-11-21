// Builds stuck.bin (a DragonDOS binary) from stuck.asm with CLOADM's own assembler, into the directory given.
// Run: node setup.js <media dir>
'use strict';
const fs = require('fs'), path = require('path');
const Emu = require('../../load')();
const dir = process.argv[2] || '.';
const src = fs.readFileSync(path.join(__dirname, 'files', 'stuck.asm'), 'utf8');
fs.writeFileSync(path.join(dir, 'stuck.bin'), Emu.toBinary(Emu.assemble(src, '6809')));
