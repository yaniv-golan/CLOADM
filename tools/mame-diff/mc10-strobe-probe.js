// MC-10 strobe-address probe against MAME 0.264. Our firmware in the BASIC socket ($E000), recording into
// $4000+ (the MC-10's RAM; $0100-$3FFF is unmapped). It records, in RAM, what $BFFF reads with no column
// driven, with column 4 driven, with column 2 driven (BREAK's own), and what Port 1 data reads back - with
// BREAK held by the host from power-on.
//
// This is the evidence for the claim that $02 (Port 1 data) is the MC-10's keyboard strobe register: it
// produced "PROBE 5a ff fb bf ff a5" against MAME 0.264 (no column driven $ff, Port 1 read back $fb, column 2
// driven $bf, column 4 driven $ff, done $a5), which is what tests/press-break.test.js and docs/claude.md quote.
// Our own core gives the same readings.
//
// Run with MAME 0.264 on the PATH:
//   node tools/mame-diff/mc10-strobe-probe.js
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '../..');
const Emu = require(path.join(ROOT, 'tests/load.js'))();

const SRC = `
        ORG     $E000           ; fills the BASIC socket MAME expects
START   LDS     #$01FF
        LDA     #$5A
        STA     $4100           ; ran
        LDA     #$FF
        STA     $00             ; Port 1 DDR: all outputs (needed before $BFFF reads anything but $FF)
; --- $BFFF with every column HIGH (nothing strobed) ---
        LDA     #$FF
        STA     $02
        LDA     $BFFF
        STA     $4101           ; rows with no column driven
; --- strobe column 2 low via $02 (Port 1 data) ---
        LDA     #$FB
        STA     $02
        LDA     $02
        STA     $4102           ; read-back of Port 1 data (proves $02 is the register)
        LDA     $BFFF
        STA     $4103           ; rows with column 2 driven - BREAK must show here
; --- strobe column 4 low (a different column) ---
        LDA     #$EF
        STA     $02
        LDA     $BFFF
        STA     $4104           ; rows with column 4 driven - BREAK must NOT show
        LDA     #$A5
        STA     $4105           ; done
HALT    BRA     HALT
`;

const asm = Emu.assemble(SRC, '6803');
if (!asm.ok) throw new Error('probe firmware failed to assemble: ' + asm.errors.map((e) => e.message).join('; '));
const rom = new Uint8Array(0x2000).fill(0xFF);
rom.set(asm.segments[0].data, 0);

const work = fs.mkdtempSync(path.join(require('os').tmpdir(), 'cloadm-mc10-probe-'));
const romDir = path.join(work, 'roms', 'mc10');
fs.mkdirSync(romDir, { recursive: true });
fs.writeFileSync(path.join(romDir, 'mc10.rom'), rom);

// Lua: hold BREAK down for the whole run, then read the recorded bytes out of the CPU's address space.
// MAME's keyboard is eight ports pb0..pb7, one per column, a bit per row, pressed = 1 (the driver ANDs the
// ports whose column strobe is low and inverts). BREAK is the MC-10 matrix's [row 6, col 2] (our keyboards.js
// has the same position), so its field is on :pb2 with mask 1 << 6 = 0x40.
const lua = `
local n = 0
local held = false
emu.register_frame_done(function()
  n = n + 1
  if not held then
    held = true
    for _, f in pairs(manager.machine.ioport.ports[":pb2"].fields) do
      if f.mask == 0x40 then f:set_value(1) end
    end
  end
  if n == 120 then
    local space = manager.machine.devices[":maincpu"].spaces["program"]
    local out = {}
    for a = 0x4100, 0x4105 do out[#out+1] = string.format("%02x", space:read_u8(a)) end
    print("PROBE " .. table.concat(out, " "))
    manager.machine:exit()
  end
end)
`;

const script = path.join(work, 'script.lua');
fs.writeFileSync(script, lua);

const cp = require('child_process');
const r = cp.spawnSync('/usr/games/mame', [
  'mc10', '-rompath', path.join(work, 'roms'), '-video', 'none', '-sound', 'none',
  '-nothrottle', '-seconds_to_run', '8', '-autoboot_script', script, '-autoboot_delay', '0', '-skip_gameinfo',
  '-nvram_directory', path.join(work, 'nvram'), '-cfg_directory', path.join(work, 'cfg'),
], { encoding: 'utf8', timeout: 300000, maxBuffer: 64 << 20,
  env: Object.assign({}, process.env, { SDL_VIDEODRIVER: 'dummy', XDG_RUNTIME_DIR: work }) });
const out = `${r.stdout || ''}${r.stderr || ''}`;
const line = out.split('\n').filter((l) => /PROBE/.test(l)).join('\n');
console.log('work:', work);
console.log(line || out.split('\n').slice(-12).join('\n'));
process.exitCode = r.status || (line ? 0 : 1);
