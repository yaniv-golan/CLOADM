#!/usr/bin/env node
// Where the clean-room BASIC's bytes go (docs/clean-room-basic.md): bytes per module and per routine (a routine runs
// from one column-0 label to the next), and the JSR/JMP/LBRA/LBcc instructions whose target a short branch would
// reach (each saves a byte; JSR -> BSR saves one, JMP -> BRA one, LBRA -> BRA one, LBcc -> Bcc two). The JMPs in
// RAM (the two-byte calls and the vectors) are written at a cold start from a list of addresses (boot.inc, ZINIT).
//   node tools/basic-size.js [--routines N]     the N largest routines (default 25)
const { buildBasic } = require('./build-basic.js');

const args = process.argv.slice(2), ri = args.indexOf('--routines');
const TOP = ri >= 0 ? Number(args[ri + 1]) : 25;
const { listing, symbols, used } = buildBasic();
const code = listing.filter((l) => l.bytes && l.bytes.length && l.addr >= 0x8000 && l.addr < 0xC000);

// per module (the file a line came from)
const perFile = new Map();
for (const l of code) perFile.set(l.file || 'd64basic.asm', (perFile.get(l.file || 'd64basic.asm') || 0) + l.bytes.length);
console.log(`total ${used} bytes of 16384\n\nper module:`);
for (const [f, n] of [...perFile].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(5)}  ${f}`);

// per routine: column-0 labels (not local-looking ones that follow a branch? all labels count)
const labels = code.filter((l) => /^[A-Z_][A-Z0-9_]*\b/.test(l.src) && !/^\s/.test(l.src)).map((l) => ({ name: l.src.split(/\s/)[0], addr: l.addr, file: l.file }));
const routines = [];
for (let i = 0; i < labels.length; i++) {
  const end = i + 1 < labels.length ? labels[i + 1].addr : symbols.get('ROMEND');
  routines.push({ ...labels[i], size: end - labels[i].addr });
}
console.log(`\nthe ${TOP} largest stretches between labels:`);
for (const r of routines.sort((a, b) => b.size - a.size).slice(0, TOP)) console.log(`  ${String(r.size).padStart(5)}  ${r.name.padEnd(8)} ${r.file || ''}`);

// long jumps that a short branch would reach: target within -128..127 of the next instruction (2-byte branch)
// (only instructions count: data that happens to start with a jump's opcode is never a candidate; the JMPs in RAM
// -- the two-byte calls and the vectors -- are a list of addresses in the ROM, boot.inc's ZINIT)
const target = (l) => {
  const b = l.bytes;
  if (!/^(\S+)?\s+(JSR|JMP|LBRA|LB[A-Z]{2})\s/.test(l.src)) return null;
  if (b[0] === 0xBD || b[0] === 0x7E) return { kind: b[0] === 0xBD ? 'JSR' : 'JMP', to: (b[1] << 8) | b[2], save: 1, short: 2 };
  if (b[0] === 0x16) return { kind: 'LBRA', to: (l.addr + 3 + (((b[1] << 8) | b[2]) << 16 >> 16)) & 0xFFFF, save: 1, short: 2 };
  if (b[0] === 0x10 && b[1] >= 0x22 && b[1] <= 0x2F) return { kind: 'LBcc', to: (l.addr + 4 + (((b[2] << 8) | b[3]) << 16 >> 16)) & 0xFFFF, save: 2, short: 2 };
  return null;
};
let saves = 0, count = 0;
const byKind = {};
for (const l of code) {
  const t = target(l);
  if (!t) continue;
  const off = t.to - (l.addr + t.short);
  if (off >= -128 && off <= 127) { saves += t.save; count++; byKind[t.kind] = (byKind[t.kind] || 0) + 1; }
}
console.log(`\nlong jumps a short branch reaches as the code stands: ${count} (${Object.entries(byKind).map(([k, v]) => `${k} ${v}`).join(', ')}), saving about ${saves} bytes (shortening some moves others into reach)`);

// repeated 6-byte windows: candidates for a shared routine
const seen = new Map();
for (let i = 0; i + 1 < code.length; i++) {
  const w = [...code[i].bytes, ...code[i + 1].bytes];
  if (w.length < 5) continue;
  const k = `${code[i].src.trim().replace(/\s+/g, ' ').split(';')[0]} / ${code[i + 1].src.trim().replace(/\s+/g, ' ').split(';')[0]}`;
  seen.set(k, (seen.get(k) || 0) + 1);
}
console.log('\nthe most repeated instruction pairs of 5 bytes or more (as source):');
for (const [k, n] of [...seen].filter(([, n]) => n > 3).sort((a, b) => b[1] - a[1]).slice(0, 15)) console.log(`  ${String(n).padStart(3)} x  ${k}`);
