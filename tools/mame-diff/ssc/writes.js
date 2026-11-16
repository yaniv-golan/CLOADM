// Ordered write sequence of the SSC's two output devices, recorded on both emulators from the same rule.
//
// The board's decode lives in MAME's coco_ssc.cpp (ssc_port_c_w, line 390 onwards) and is mirrored in
// js/machines/ssc.js writePortC. Each side is captured where its decode lands: on MAME by tapping the PIC's
// peripheral writes (port C >0108, port D >010A) and applying the decode in Lua; here by wrapping the three
// calls the decode ends in (AY address, AY data, SP0256 address load), which is the same point in each - the
// board has already decided what the chips are told, and neither side re-derives it from the other's state.
// The rule either side's decode implements:
//   port C bit 5 (C_ALD) falling edge, port D < 64        -> SP0256 loads that allophone number
//   port C bit 6 (C_ACS) clear, bits 3 (BDIR) and 0 (BC1) -> AY latches an address (both set) or writes data
//   (BDIR set, BC1 clear)
// Each $FF7E write from the 6809 starts a new command, so the log is grouped by command and ordered within it.
const C_ALD = 0x20, C_ACS = 0x40, C_BDR = 0x08, C_BC1 = 0x01;

// ---- our emulator: install on a SpeechSoundPak; returns { log, format(), uninstall() } ----
function recordCardWrites(pak) {
  const log = [];
  const origAddress = pak.ay.addressW.bind(pak.ay);
  const origData = pak.ay.dataW.bind(pak.ay);
  const origLoad = pak.sp0256.loadAddress.bind(pak.sp0256);
  const origWriteIO = pak.writeIO.bind(pak);
  let cmd = 0;

  pak.writeIO = (a, v) => { if (a === 0xFF7E) cmd++; return origWriteIO(a, v); };
  pak.ay.addressW = (v) => { log.push({ cmd, dev: 'ay', op: 'addr', value: v & 0xff }); return origAddress(v); };
  pak.ay.dataW = (v) => { log.push({ cmd, dev: 'ay', op: 'data', value: v & 0xff }); return origData(v); };
  pak.sp0256.loadAddress = (v) => { log.push({ cmd, dev: 'sp0256', op: 'load', value: v & 0xff }); return origLoad(v); };

  return {
    log,
    uninstall() {
      pak.writeIO = origWriteIO;
      pak.ay.addressW = origAddress;
      pak.ay.dataW = origData;
      pak.sp0256.loadAddress = origLoad;
    },
  };
}

// group a {cmd, dev, op, value} log into one line per command, in order
function formatWrites(log) {
  const by = new Map();
  for (const e of log) {
    if (!by.has(e.cmd)) by.set(e.cmd, []);
    by.get(e.cmd).push(`${e.dev}:${e.op}=${e.value.toString(16).toUpperCase().padStart(2, '0')}`);
  }
  return [...by.keys()].sort((a, b) => a - b).map((c) => `${c} ${by.get(c).join(' ')}`);
}

// ---- MAME 0.264: a Lua script that records the same sequence and prints it at stop ----
// Taps the PIC's peripheral writes (P8 = port C at >0108, P10 = port D at >010A, Table 3-8) and the 6809's
// command writes at $FF7E. Rows are collected and printed from register_stop: printing inside a tap does not
// reach MAME's console.
function mameWritesLua() {
  return `
local m = manager.machine
local pic = m.devices[":ext:ssc:pic7040"]
local space9 = m.devices[":maincpu"].spaces["program"]
local spacep = pic.spaces["program"]
local ncmd, portd, prevc = 0, 0, 0
local rows = {}
local function tag() return tostring(ncmd) end
space9:install_write_tap(0xFF7E, 0xFF7E, "cmd", function(off, data, mask) ncmd = ncmd + 1 end)
spacep:install_write_tap(0x010A, 0x010A, "portd", function(off, data, mask) portd = data & 0xff end)
spacep:install_write_tap(0x0108, 0x0108, "portc", function(off, data, mask)
  local d = data & 0xff
  if (d & ${C_ACS}) == 0 then
    local bdir = (d & ${C_BDR}) ~= 0
    local bc1  = (d & ${C_BC1}) ~= 0
    if bdir and bc1 then rows[#rows+1] = string.format("%d ay:addr=%02X", ncmd, portd)
    elseif bdir and not bc1 then rows[#rows+1] = string.format("%d ay:data=%02X", ncmd, portd) end
  end
  if (prevc & ${C_ALD}) ~= 0 and (d & ${C_ALD}) == 0 and portd < 64 then
    rows[#rows+1] = string.format("%d sp0256:load=%02X", ncmd, portd)
  end
  prevc = d
end)
emu.register_stop(function() for _, r in ipairs(rows) do print("WSEQ " .. r) end end)
`;
}

module.exports = { recordCardWrites, formatWrites, mameWritesLua, C_ALD, C_ACS, C_BDR, C_BC1 };
