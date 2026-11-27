#!/usr/bin/env node
// Where the clean-room BASIC's bytes go (docs/clean-room-basic.md): the budget (occupied, reserved and free), bytes
// per module and per routine, and the JSR/JMP/LBRA/LBcc instructions whose target a short branch would reach (each
// saves a byte; JSR -> BSR saves one, JMP -> BRA one, LBRA -> BRA one, LBSR -> BSR one, LBcc -> Bcc two; each is
// faster too: JSR -> BSR and JMP -> BRA by a cycle, LBSR -> BSR and LBRA -> BRA by two, LBcc -> Bcc by two or three,
// so the time has to be made up where a path must keep its cycles). The JMPs in RAM (the two-byte calls and the vectors) are
// written at a cold start from a list of addresses (boot.inc, ZINIT).
//   node tools/basic-size.js [--routines N]     the N largest routines (default 25)
// require('./basic-size.js') -> { budget, routines } for tests/basic-size.test.js.
const ROM_AT = 0x8000, ROM_END = 0xC000;
// the published entry points (section 3): the jumps at $8006-$8029 and the table of calls at $A000-$A00D, kept
// whether or not a slot has a routine of ours, never free
const RESERVED = [[0x8006, 0x802A], [0xA000, 0xA00E]];
const VECTORS = 0xBFF0;                 // $BFF0-$BFFF: the hardware vectors (ours from $BFF2)

// The budget: occupied (the bytes the build lays down), reserved (the published entry points, RESERVED) and free
// (only the gap between the code's end, ROMEND, and the vectors: a hole elsewhere, such as $8000-$8005 or the bytes
// left below the table at $A000, gap, is not counted as room).
function budget({ used, symbols, gap = 0 }) {
  const end = symbols.get('ROMEND');
  return { occupied: used, reserved: RESERVED.reduce((n, [a, e]) => n + e - a, 0), codeEnd: end, free: VECTORS - end, gap };
}

// Routines: a routine runs from a column-0 label (one on a line of its own or on an RMB 0 counts: it emits no bytes
// but marks where the next thing starts; an EQU is not a place) to the next label or the end of its module (the
// file a line came from), whichever comes first, and its size is the bytes in that stretch. So a module's last
// routine never takes in the next module's tables (play.inc's last label once counted tokens.inc's 611 bytes).
function routines(listing) {
  const inRom = (l) => l.addr >= ROM_AT && l.addr < ROM_END;
  const isLabel = (l) => inRom(l) && /^[A-Z_][A-Z0-9_]*(\s|$)/i.test(l.src) && !/^\S+\s+(EQU|SET)\b/i.test(l.src);
  const out = [];
  let cur = null;
  for (const l of listing) {
    const file = l.file || 'd64basic.asm';
    if (isLabel(l)) {
      cur = { name: l.src.split(/\s/)[0], addr: l.addr, file, size: 0 };
      out.push(cur);
    }
    if (!l.bytes || !l.bytes.length || !inRom(l)) continue;
    // a byte outside the current routine's module, or before its label, belongs to no routine
    if (cur && cur.file === file && l.addr >= cur.addr) cur.size += l.bytes.length;
    else cur = null;
  }
  return out;
}

module.exports = { budget, routines, RESERVED, VECTORS };

if (require.main === module) {
  const { buildBasic } = require('./build-basic.js');
  const args = process.argv.slice(2), ri = args.indexOf('--routines');
  const TOP = ri >= 0 ? Number(args[ri + 1]) : 25;
  const build = buildBasic();
  const { listing, used } = build;
  const code = listing.filter((l) => l.bytes && l.bytes.length && l.addr >= ROM_AT && l.addr < ROM_END);

  const b = budget(build);
  const hx = (v) => '$' + v.toString(16).toUpperCase();
  console.log(`occupied ${b.occupied} bytes of 16384 (the code to ${hx(b.codeEnd - 1)}, and the vectors)`);
  console.log(`reserved ${b.reserved} bytes (${RESERVED.map(([a, e]) => `${hx(a)}-${hx(e - 1)}`).join(', ')}: the published entry points)`);
  console.log(`free     ${b.free} bytes (${hx(b.codeEnd)}-${hx(VECTORS - 1)}, between the code's end and the vectors)`);
  console.log(`left     ${b.gap} bytes below $A000 (the code before the table of published calls ends at a routine's end)`);

  // per module (the file a line came from)
  const perFile = new Map();
  for (const l of code) perFile.set(l.file || 'd64basic.asm', (perFile.get(l.file || 'd64basic.asm') || 0) + l.bytes.length);
  console.log(`\nper module (${used} bytes):`);
  for (const [f, n] of [...perFile].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(5)}  ${f}`);

  console.log(`\nthe ${TOP} largest routines (label to the next label or the module's end):`);
  for (const r of routines(listing).sort((a, b) => b.size - a.size).slice(0, TOP)) console.log(`  ${String(r.size).padStart(5)}  ${r.name.padEnd(8)} ${r.file}`);

  // long jumps that a short branch would reach: target within -128..127 of the next instruction (2-byte branch)
  // (only instructions count: data that happens to start with a jump's opcode is never a candidate; the JMPs in RAM
  // -- the two-byte calls and the vectors -- are a list of addresses in the ROM, boot.inc's ZINIT)
  const target = (l) => {
    const by = l.bytes;
    if (!/^(\S+)?\s+(JSR|JMP|LBRA|LB[A-Z]{2})\s/.test(l.src)) return null;
    if (by[0] === 0xBD || by[0] === 0x7E) return { kind: by[0] === 0xBD ? 'JSR' : 'JMP', to: (by[1] << 8) | by[2], save: 1, short: 2 };
    if (by[0] === 0x17) return { kind: 'LBSR', to: (l.addr + 3 + (((by[1] << 8) | by[2]) << 16 >> 16)) & 0xFFFF, save: 1, short: 2 };
    if (by[0] === 0x16) return { kind: 'LBRA', to: (l.addr + 3 + (((by[1] << 8) | by[2]) << 16 >> 16)) & 0xFFFF, save: 1, short: 2 };
    if (by[0] === 0x10 && by[1] >= 0x22 && by[1] <= 0x2F) return { kind: 'LBcc', to: (l.addr + 4 + (((by[2] << 8) | by[3]) << 16 >> 16)) & 0xFFFF, save: 2, short: 2 };
    return null;
  };
  let saves = 0, count = 0;
  const byKind = {}, sites = [];
  for (const l of code) {
    const t = target(l);
    if (!t) continue;
    const off = t.to - (l.addr + t.short);
    if (off >= -128 && off <= 127) { saves += t.save; count++; byKind[t.kind] = (byKind[t.kind] || 0) + 1; sites.push(`${l.file}:${l.line} ${l.src.trim().replace(/\s+/g, ' ').split(';')[0]}`); }
  }
  console.log(`\nlong jumps a short branch reaches as the code stands: ${count} (${Object.entries(byKind).map(([k, v]) => `${k} ${v}`).join(', ')}), saving about ${saves} bytes gross (shortening some moves others into reach)`);
  for (const s of sites) console.log(`  ${s}`);

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
}
