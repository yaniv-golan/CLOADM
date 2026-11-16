// Running MAME headless for the comparisons, and streaming its instruction trace.
// The trace goes through a named pipe, so nothing large is written to disk. Work folders come from
// lib/workdir.js (one per run). A run whose ROMs MAME can't find fails at once with MAME's list of them.
const fs = require('fs'), path = require('path'), cp = require('child_process'), readline = require('readline');
const { trackChild } = require('./workdir');

const MAME = process.env.MAME || (fs.existsSync('/usr/games/mame') ? '/usr/games/mame' : 'mame');

function baseArgs(work, system, luaFile, seconds, video) {
  return [system, '-rompath', path.join(work, 'roms'),
    ...(video ? ['-video', 'soft', '-window', '-frameskip', '0', '-noautoframeskip'] : ['-video', 'none']),
    '-sound', 'none', '-nothrottle', '-seconds_to_run', String(Math.max(1, Math.ceil(seconds))),
    '-autoboot_script', luaFile, '-autoboot_delay', '0', '-skip_gameinfo',
    '-nvram_directory', path.join(work, 'nvram'), '-cfg_directory', path.join(work, 'cfg'),
    // keep MAME's snapshots and state files inside the work dir, never in the repository
    '-snapshot_directory', path.join(work, 'snap'), '-state_directory', path.join(work, 'state')];
}
// SDL_MAC_BACKGROUND_APP: on macOS MAME stays in the background instead of taking the focus (ignored elsewhere)
function env(work, video) {
  return Object.assign({}, process.env, { XDG_RUNTIME_DIR: work, SDL_MAC_BACKGROUND_APP: '1' }, video ? { SDL_VIDEODRIVER: 'dummy' } : {});
}

class MameError extends Error {}
// MAME's own output names the missing files ("x.rom NOT FOUND (tried in ...)", then "Required files are missing")
function missingFiles(output, system, work) {
  if (!/Required files are missing|NOT FOUND/.test(output)) return null;
  const files = output.split('\n').filter((l) => /NOT FOUND/.test(l)).map((l) => l.trim());
  return new MameError(`MAME can't run ${system}: ROM files missing in ${path.join(work, 'roms')}` + (files.length ? `\n  ${files.join('\n  ')}` : ''));
}

// Run MAME to completion with a Lua script. -seconds_to_run takes whole seconds (fractions never end).
function runMame({ work, system, lua, seconds, args = [], video = false }) {
  fs.mkdirSync(work, { recursive: true });
  const luaFile = path.join(work, 'script.lua');
  fs.writeFileSync(luaFile, lua);
  const r = cp.spawnSync(MAME, [...baseArgs(work, system, luaFile, seconds, video), ...args],
    { stdio: ['ignore', 'pipe', 'pipe'], timeout: 600000, killSignal: 'SIGKILL', env: env(work, video), maxBuffer: 64 << 20 });
  const output = `${r.stdout || ''}${r.stderr || ''}`;
  const missing = missingFiles(output, system, work);
  if (missing) throw missing;
  // Stopped by a signal (the timeout): reported, and the caller decides what it compares (cart/audio.js compares
  // nothing). Any other failure (no MAME, a missing ROM set, a bad slot option) stops the comparison: the files it
  // would read are not from this run.
  if (r.signal) console.error(`MAME stopped by ${r.signal}`);
  else if (r.error) throw new MameError(`MAME failed (${r.error.code || r.error.message}): ${MAME} ${system}`);
  else if (r.status) throw new MameError(`MAME failed (exit status ${r.status}): ${MAME} ${system}: ${output.trim().split('\n').slice(-3).join(' | ')}`);
  // how MAME ended: { status, signal } (status 0 and no signal: it ran its seconds and exited normally; a signal: it
  // was stopped), and what it printed (the Lua script's output included)
  return { status: r.status, signal: r.signal || null, output };
}

// One run at a time per work directory: two runs of the same comparison would overwrite each other's files (MAME's
// recording, its images) mid-run. Takes <work>.lock (pid inside; a lock whose process is gone is taken over) and
// releases it when the process exits.
function lockWork(work) {
  const file = `${work.replace(/\/+$/, '')}.lock`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (let tries = 0; tries < 2; tries++) {
    try {
      fs.writeFileSync(file, String(process.pid), { flag: 'wx' });
      process.on('exit', () => { try { if (fs.readFileSync(file, 'utf8') === String(process.pid)) fs.unlinkSync(file); } catch (e) { /* gone */ } });
      return;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const pid = Number(fs.readFileSync(file, 'utf8'));
      let alive = false;
      try { process.kill(pid, 0); alive = true; } catch (k) { alive = k.code === 'EPERM'; }
      if (alive && pid !== process.pid) throw new Error(`${work} is in use by another run (pid ${pid}); wait for it, or remove ${file} if it is stale`);
      fs.unlinkSync(file);
    }
  }
  throw new Error(`could not lock ${work}`);
}

// Stream MAME's trace of `cpu` (debugger tracelog of the given register expressions plus totalcycles).
// onEntry({ regs: string[], cycles, pc, dis }) returns false to stop. Resolves when MAME ends or is stopped.
// waitOps: mnemonics that MAME re-logs while the CPU waits (e.g. CWAI, SYNC); repeats are dropped.
function streamTrace({ work, system, seconds, args = [], regs, luaPrelude = '', luaPostlude = '', waitOps = [], cpu = 'maincpu', onEntry }) {
  fs.mkdirSync(work, { recursive: true });
  const fifo = path.join(work, 'trace.fifo');
  try { fs.unlinkSync(fifo); } catch (e) { /* none */ }
  cp.execFileSync('mkfifo', [fifo]);
  const fmt = regs.map((r) => `%0${r.width}X`).join(' ') + ' %X ';
  const luaFile = path.join(work, 'trace.lua');
  fs.writeFileSync(luaFile, `${luaPrelude}
local d = manager.machine.debugger
d:command('trace ${fifo},${cpu},noloop,{tracelog "${fmt}",${regs.map((r) => r.mame).join(',')},totalcycles}')
d:command('go')
${luaPostlude}
`);
  const proc = cp.spawn(MAME, [...baseArgs(work, system, luaFile, seconds, false), '-debug', '-debugger', 'none', ...args],
    { stdio: ['ignore', 'pipe', 'pipe'], env: env(work, false) });
  trackChild(proc);
  let output = '';
  const keep = (d) => { output = (output + d).slice(-20000); };
  proc.stdout.on('data', keep); proc.stderr.on('data', keep);
  const waitRe = waitOps.length ? new RegExp(`: (${waitOps.join('|')})\\b`) : null;
  return new Promise((resolve, reject) => {
    const rl = readline.createInterface({ input: fs.createReadStream(fifo) });
    let stopped = false, prevPc = null, prevWait = false, got = 0;
    const stop = (err) => {
      if (stopped) return;
      stopped = true;
      try { proc.kill('SIGKILL'); } catch (e) { /* gone */ }
      // a reader still waiting for MAME to open the pipe would never return: open the other end once
      try { fs.closeSync(fs.openSync(fifo, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK)); } catch (e) { /* reader not waiting */ }
      try { fs.unlinkSync(fifo); } catch (e) { /* none */ }
      rl.close();
      if (err) reject(err); else resolve();
    };
    rl.on('line', (l) => {
      got++;
      if (stopped || !/^[0-9A-F]{4} /.test(l)) return;
      const f = l.split(' ');
      const pc = f[0], wait = waitRe ? waitRe.test(l) : false;
      if (wait && prevWait && pc === prevPc) return;
      prevPc = pc; prevWait = wait;
      const entry = { regs: f.slice(0, regs.length), cycles: parseInt(f[regs.length], 16), pc: parseInt(pc, 16), dis: l.slice(l.indexOf(':') + 1).trim() };
      if (onEntry(entry) === false) stop();
    });
    rl.on('close', () => stop());   // MAME closed the pipe: end of trace
    rl.on('error', () => stop());
    // MAME ended: missing ROMs fail the run at once; if it never wrote, the pipe never opened, so stop
    // a MAME that exits with an error before we stop it (an image it cannot load, any fatal error) fails the run
    proc.on('exit', (code) => {
      const missing = missingFiles(output, system, work);
      if (missing) stop(missing);
      else if (code && !stopped) stop(new MameError(`MAME exited with status ${code}: ${output.trim().split('\n').slice(-2).join(' | ')}`));
      else setTimeout(() => { if (!got) stop(); }, 2000);
    });
  });
}

module.exports = { MAME, MameError, baseArgs, env, runMame, streamTrace, lockWork };
