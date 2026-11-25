// The reader firmware's halt, as MAME's Lua sees it, and what it reports there (run-tape.js, run-program-tape.js).
// The halt test used to be `pc >= haltPc && pc <= haltPc + 2`, to allow for MAME leaving the PC up to two bytes
// into the `BRA *` when a frame callback runs. That window is wrong: haltPc+2 is a real instruction in every one
// of these firmwares - it is the entry of LEADER in the two writers and of RDBYTE in the two readers - so a
// frame that happened to land on a JSR to that subroutine counted as a halt, mid-tape. It reported whatever the
// registers and counters held at that moment, which is how the MC-10 .cas case came to look like "no signal
// reaches the machine". The halt is now three conditions together:
//   1. pc is haltPc, haltPc+1 or haltPc+2. All three are readings MAME gives for `BRA *`: it can catch the CPU
//      with the PC at the opcode, at the operand, or past the whole instruction. haltPc+1 is safe to accept and
//      haltPc+2 is not, and the difference matters: haltPc+1 is the operand byte, where no instruction can start,
//      while haltPc+2 is the first byte of the NEXT instruction - the entry of LEADER or RDBYTE. That is why
//      condition 3, not the address, has to carry the weight.
//   2. the opcode at haltPc is really $20 $FE (`BRA *`), not because we assumed it;
//   3. pc is the SAME value on three consecutive frame callbacks.
// Condition 3 is the one that does the work: at a real halt the CPU never leaves `BRA *`, so pc is identical
// on every frame. At RDBYTE entry pc equals haltPc+2 for the ~112 us the subroutine takes - about half a
// percent of a frame - so catching it on three frames in a row does not happen, while a single stray frame
// could. Two frames would also be enough in principle but leave less margin, and the check costs nothing.
const HALT_FRAMES = 3;
const haltLua = (haltPc, out, is6803) => `
local cpu = manager.machine.devices[':maincpu']
local space = cpu.spaces['program']
for tag, c in pairs(manager.machine.cassettes) do c:play() end
local op1, op2 = space:read_u8(${haltPc}), space:read_u8(${haltPc} + 1)
local bra = (op1 == 0x20 and op2 == 0xFE)
local prev, streak = nil, 0
emu.register_frame_done(function()
  local pc = cpu.state['PC'].value
  local at = bra and (pc == ${haltPc} or pc == ${haltPc} + 1 or pc == ${haltPc} + 2)
  if at and prev == pc then streak = streak + 1 else streak = at and 1 or 0 end
  prev = at and pc or nil   -- only a run of consecutive frames at one halt address counts
  if streak >= ${HALT_FRAMES} then
    local f = io.open('${out}', 'w')
    ${is6803 ? `
    local s = cpu.state
    -- the reader reports the 16-bit sum with A the low byte, so the printed value is A | B << 8; the two counters
    -- at $0088/$008A are 16-bit words in memory, high byte first (the 6803's big-endian order)
    f:write(string.format('X=%d A:B=%d NBLK=%d NBAD=%d', s['X'].value, s['A'].value | (s['B'].value << 8),
      (space:read_u8(0x88) << 8) | space:read_u8(0x89), (space:read_u8(0x8A) << 8) | space:read_u8(0x8B)))` : `
    f:write(string.format('X=%d Y=%d U=%d B=%d', cpu.state['X'].value, cpu.state['Y'].value, cpu.state['U'].value, cpu.state['B'].value))`}
    f:close()
    manager.machine:exit()
  end
end)
`;

module.exports = { HALT_FRAMES, haltLua };
