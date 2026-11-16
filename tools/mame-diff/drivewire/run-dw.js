#!/usr/bin/env node
// DriveWire over the Becker port, compared with MAME. dw.asm runs in place of BASIC:
//  - in MAME 0.264 with its Becker port on (coco_dwsock, set in the run's cfg file), which connects over TCP to
//    127.0.0.1:65504, where this script serves our DriveWire server (js/drivewire/server.js) with the fixture of
//    spec.js;
//  - on our machine (option becker), with the same server set-up in-process.
// Two comparisons from one MAME run:
//  1. instruction lockstep to HALT: every register and cycle count. MAME's link to the server has real latency, so
//     on its own MAME's polls would see the answer sooner or later from run to run. To pin it, the server writes
//     to a file how many bytes it has taken and answered (after its answer is on the socket), and a Lua write tap
//     on SYNC, which dw.asm writes before each status poll, holds MAME's CPU until that count covers every byte
//     written to $FF42 (counted by a second tap). Then every poll sees what our in-process server, which answers
//     at once, shows ours. (Linux delivers loopback TCP data to the receiving socket within the sender's write.)
//  2. what the run left behind: the log of everything the server sent, the disks and named objects it wrote, its
//     printout and what the guest sent on its channels, byte for byte.
//   node tools/mame-diff/drivewire/run-dw.js [profile ...] [--no-trace]     (default: coco coco2b coco3)
const fs = require('fs'), path = require('path'), net = require('net'), cp = require('child_process');
const spec = require('./spec');
const { writeRoms } = require('../lib/firmware');
const { MAME, baseArgs, env } = require('../lib/mame');
const { lockstep, hx } = require('../lib/lockstep');
const { REGS } = require('../sam/spec');

const PORT = 65504;   // coco_dwsock's default server port
const argv = process.argv.slice(2);
const noTrace = argv.includes('--no-trace');
let fail = 0;
const check = (name, ok, detail = '') => { if (!ok) fail++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name} ${detail}`); };
const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

// serve `server` on the port for one connection; bytes in go to it, its output goes back as it appears; after
// each chunk is answered (on the socket), the count of bytes taken so far goes to `ackFile`
function serve(server, ackFile) {
  let taken = 0;
  fs.writeFileSync(ackFile, '0');
  const tcp = net.createServer((sock) => {
    sock.setNoDelay(true);
    let chain = Promise.resolve();
    sock.on('data', (buf) => {
      chain = chain.then(async () => {
        for (const b of buf) { server.receive(b); while (server.busy) await server.busy; }
        taken += buf.length;
        if (server.available) await new Promise((resolve) => sock.write(Buffer.from(server.output.splice(0)), resolve));
        fs.writeFileSync(ackFile, String(taken));
      });
    });
    sock.on('error', () => {});
  });
  return new Promise((resolve) => tcp.listen(PORT, '127.0.0.1', () => resolve(tcp)));
}

// our run, its trace kept compactly (10 numbers an instruction) for the lockstep
async function ourRun(id) {
  const names = REGS.map((r) => r.name);
  let buf = new Uint32Array(1 << 20), n = 0;
  const r = await spec.runOurs(id, { onMachine: (m) => {
    m.cpu.trace = (c) => {
      if ((n + 1) * 10 > buf.length) { const b = new Uint32Array(buf.length * 2); b.set(buf); buf = b; }
      for (let k = 0; k < 9; k++) buf[n * 10 + k] = c[names[k]];
      buf[n * 10 + 9] = c.totalCycles;
      n++;
    };
  } });
  r.trace = { buf, n };
  return r;
}

async function mameRun(id, ours) {
  const fw = spec.firmware(id);
  const work = `/tmp/mame-diff/${id}-drivewire`;
  fs.rmSync(work, { recursive: true, force: true });
  writeRoms(work, fw.system, fw.files);
  fs.mkdirSync(path.join(work, 'cfg'), { recursive: true });
  fs.writeFileSync(path.join(work, 'cfg', `${fw.system}.cfg`), `<?xml version="1.0"?>
<mameconfig version="10">
  <system name="${fw.system}">
    <input>
      <port tag=":beckerport" type="CONFIG" mask="1" defvalue="0" value="1" />
    </input>
  </system>
</mameconfig>
`);
  const dump = path.join(work, 'mem.bin'), ack = path.join(work, 'dw-ack');
  const sync = fw.asm.symbols.get('SYNC');
  // the hold point, and the memory dump at HALT (then MAME exits, which ends the trace)
  const lua = `
local cpu = manager.machine.devices[':maincpu']
local space = cpu.spaces['program']
local written, answered = 0, 0
local function readAck() local f = io.open('${ack}', 'r'); if not f then return 0 end; local v = tonumber(f:read('a')) or 0; f:close(); return v end
dwCountTap = space:install_write_tap(0xFF42, 0xFF42, 'dwcount', function(offset, data, mask) written = written + 1 end)
dwSyncTap = space:install_write_tap(${sync}, ${sync}, 'dwsync', function(offset, data, mask)
  while answered < written do answered = readAck() end
end)
emu.register_frame_done(function()
  local pc = cpu.state['PC'].value
  if pc >= ${fw.haltPc} and pc <= ${fw.haltPc} + 2 then
    local f = io.open('${dump}', 'wb')
    for a = 0x5F00, 0x6FFF do f:write(string.char(space:read_u8(a))) end
    f:close()
    manager.machine:exit()
  end
end)
`;
  const { store, server, out } = await spec.fixture();
  const tcp = await serve(server, ack);
  let lock = null;
  if (noTrace) {
    const luaFile = path.join(work, 'script.lua');
    fs.writeFileSync(luaFile, lua);
    await new Promise((resolve) => {
      const p = cp.spawn(MAME, [...baseArgs(work, fw.system, luaFile, 60, false), '-ext', ''], { stdio: 'ignore', env: env(work, false) });
      const timer = setTimeout(() => p.kill('SIGKILL'), 600000);
      p.on('exit', () => { clearTimeout(timer); resolve(); });
    });
  } else {
    const { buf, n } = ours.trace;
    let i = 0;
    lock = await lockstep({
      label: `${id} DriveWire`, system: fw.system, work, seconds: 60, args: ['-ext', ''], regs: REGS, waitOps: [],
      haltPc: fw.haltPc, luaPrelude: lua,
      ours: () => {
        if (i >= n) return null;
        const o = i * 10; i++;
        return [REGS.map((r, k) => hx(buf[o + k], r.width)), buf[o + 9]];
      },
    });
  }
  tcp.close();
  const r = fs.existsSync(dump) ? await spec.outcome((a) => fs.readFileSync(dump)[a - 0x5F00], store, out) : null;
  fs.rmSync(work, { recursive: true, force: true });
  return { r, lock };
}

(async () => {
  const ids = argv.filter((a) => !a.startsWith('--'));
  for (const id of ids.length ? ids : ['coco', 'coco2b', 'coco3']) {
    const ours = await ourRun(id);
    const { r: theirs, lock } = await mameRun(id, ours);
    check(`${id}: our machine runs dw.asm to the end`, ours.done, `(${ours.log.length} bytes logged, ${ours.trace.n} instructions)`);
    if (lock !== null) check(`${id}: instruction lockstep with MAME to HALT`, lock === 0);
    check(`${id}: MAME runs dw.asm to the end over its Becker port`, !!theirs && theirs.done, theirs ? `(${theirs.log.length} bytes logged)` : '(no memory dump)');
    if (!theirs) continue;
    let firstDiff = -1;
    for (let i = 0; i < Math.max(ours.log.length, theirs.log.length) && firstDiff < 0; i++) if (ours.log[i] !== theirs.log[i]) firstDiff = i;
    check(`${id}: every byte the server sent is the same`, firstDiff < 0, firstDiff < 0 ? `(${ours.log.length} bytes)` : `(first difference at log byte ${firstDiff})`);
    const names = [...new Set([...Object.keys(ours.files), ...Object.keys(theirs.files)])].sort();
    for (const nm of names) {
      const a = ours.files[nm], b = theirs.files[nm];
      check(`${id}: ${nm} identical`, !!a && !!b && same(a, b), `(${a ? a.length : 'missing'} / ${b ? b.length : 'missing'} bytes)`);
    }
    check(`${id}: the printout is the same`, same(ours.printed, theirs.printed), `(${ours.printed.length} bytes)`);
    check(`${id}: the channel bytes are the same`, same(ours.channels, theirs.channels), `(${ours.channels.length / 2} bytes)`);
  }
  console.log(fail ? `${fail} FAILED` : 'all identical');
  process.exitCode = fail ? 1 : 0;
})();
