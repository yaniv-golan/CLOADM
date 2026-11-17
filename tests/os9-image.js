// Hand-built OS-9 disk images for the NitrOS-9 tests (no NitrOS-9 bytes): laid out from the NitrOS-9 v3.3.0
// definitions themselves, not from js/media/os9.js, so the detection is tested against an independent layout.
//   defs/rbf.d   LSN 0: DD.TOT $00 (3), DD.TKS $03, DD.MAP $04 (2), DD.BIT $06 (2), DD.DIR $08 (3), DD.FMT $10,
//                DD.SPT $11 (2), DD.BT $15 (3), DD.BSZ $18 (2), DD.NAM $1F; FD.ATT $00 of a directory has $80
//   defs/os9.d   module: $87 $CD, M$Size (2), M$Name (2), M$Type, M$Revs, M$Parity; a descriptor's M$FMgr $09 (2),
//                M$PDev $0B (2)
//   rel.asm      the boot track (LSN 612-629) starts "OS" and is entered at $2602
// makeOs9Disk(Emu, opts) -> Uint8Array
//   cpu: '6809' | '6309' | null (no CPU in Init)   driver: DD's driver ('rbdw', 'rb1773', 'rbsuper')
//   bootTrack: true | false   port: 'becker' | 'bitbanger' (what the boot track's Boot module touches)
//   vtio: true (false: a headless build)   sectors: 630 (at least)   label: the volume name
//   code: 6809 source run at the boot track's entry (after the modules); default: STATUS2 ($0102) := $5A, then loop
const SECTOR = 256;

// an OS-9 name: the last character with bit 7 set
const name = (s) => [...s].map((c, i) => c.charCodeAt(0) | (i === s.length - 1 ? 0x80 : 0));
// a module of `body` bytes (after the 9-byte header) with its name at the end; `fields` patches body offsets
function os9Module(nm, type, body = []) {
  const n = name(nm), size = 9 + body.length + n.length + 3;   // + 3: the CRC OS-9 puts at the end
  const m = [0x87, 0xCD, size >> 8, size & 0xFF, (9 + body.length) >> 8, (9 + body.length) & 0xFF, type, 0x81, 0];
  let parity = 0;
  for (let i = 0; i < 8; i++) parity ^= m[i];
  m[8] = ~parity & 0xFF;
  return m.concat(body, n, [0, 0, 0]);
}
// a device descriptor naming its file manager and driver (M$FMgr at $09, M$PDev at $0B, both offsets in the module)
function descriptor(nm, fmgr, driver) {
  const body = [0, 0, 0, 0];                 // M$FMgr, M$PDev: patched below
  const fm = name(fmgr), dv = name(driver);
  const fmAt = 9 + body.length, dvAt = fmAt + fm.length;
  body[0] = fmAt >> 8; body[1] = fmAt & 0xFF; body[2] = dvAt >> 8; body[3] = dvAt & 0xFF;
  return os9Module(nm, 0xF1, body.concat(fm, dv));
}
const text = (s) => [...s].map((c) => c.charCodeAt(0));

function makeOs9Disk(Emu, { cpu = '6809', driver = 'rbdw', bootTrack = true, port = 'becker', vtio = true, sectors = 630, label = 'TEST DISK', code = null } = {}) {
  const b = new Uint8Array(sectors * SECTOR);
  // the boot file at LSN 2: Init (the CPU in its text, as init.asm:96 writes it), the DD descriptor, VTIO
  const boot = [].concat(
    os9Module('Init', 0xC0, text(cpu ? `NitrOS-9/${cpu} Level 2 V3.3.0` : 'Level 2')),
    descriptor('DD', 'RBF', driver),
    vtio ? os9Module('VTIO', 0xE1, [0x39]) : os9Module('SCF', 0xD1, [0x39]));
  b.set(boot, 2 * SECTOR);
  const put24 = (a, v) => { b[a] = v >> 16; b[a + 1] = (v >> 8) & 0xFF; b[a + 2] = v & 0xFF; };
  put24(0x00, sectors);          // DD.TOT
  b[0x03] = 18;                  // DD.TKS
  b[0x04] = 0; b[0x05] = 0x4F;   // DD.MAP
  b[0x06] = 0; b[0x07] = 1;      // DD.BIT
  put24(0x08, 1);                // DD.DIR: the root's descriptor at LSN 1
  b[0x10] = 0x02;                // DD.FMT
  b[0x11] = 0; b[0x12] = 18;     // DD.SPT
  put24(0x15, 2);                // DD.BT
  b[0x18] = boot.length >> 8; b[0x19] = boot.length & 0xFF;   // DD.BSZ
  b.set(name(label), 0x1F);      // DD.NAM
  b[1 * SECTOR] = 0xBF;          // FD.ATT: a directory, every permission
  if (bootTrack) {
    // the boot track: "OS", a branch over the Boot module to the code. The module's code reads the port's
    // registers as dwread.asm does (Becker $FF41/$FF42; the bit-banger $FF20/$FF22)
    const regs = port === 'becker' ? ['$FF41', '$FF42'] : ['$FF20', '$FF22'];
    const src = `
        ORG     $2600
        FCC     "OS"
        BRA     START
BOOTM   FCB     $87,$CD
        FDB     BOOTE-BOOTM,BOOTN-BOOTM
        FCB     $C1,$81,$00
        LDB     ${regs[0]}
        LDA     ${regs[1]}
        RTS
BOOTN   FCC     "Boo"
        FCB     $F4
        FCB     0,0,0
BOOTE
START
${code || `        LDA     #$5A
        STA     $0102
LOOP    BRA     LOOP`}
`;
    const r = Emu.assemble(src, '6809');
    if (!r.ok) throw new Error('boot track: ' + r.errors.map((e) => `line ${e.line}: ${e.message}`).join('; '));
    for (const s of r.segments) b.set(s.data, 612 * SECTOR + (s.addr - 0x2600));
  }
  return b;
}

module.exports = { makeOs9Disk };
