/*
 * Exact time for the floppy subsystem: MAME's attotime (src/emu/attotime.h, attotime.cpp, MAME 0.264) as a
 * BigInt count of attoseconds (1e-18 s), with MAME's rounding wherever MAME rounds. The disk controller and
 * the drive keep their own time this way so their events land on the same CPU cycle as MAME's.
 *
 * NEVER is MAME's attotime::never (seconds >= 1e9). Values are never negative except where MAME's own
 * arithmetic produces a negative difference (the PLL's phase error), which compare and add correctly.
 */
export const ATTO = 1000000000000000000n;            // attoseconds per second
export const NEVER = ATTO * 1000000000n;
export const ZERO = 0n;

export const isNever = (t) => t >= NEVER;
export const add = (a, b) => { if (a >= NEVER || b >= NEVER) return NEVER; const r = a + b; return r >= NEVER ? NEVER : r; };
export const sub = (a, b) => (a >= NEVER ? NEVER : a - b);
export const min = (a, b) => (a < b ? a : b);

// attotime * u32 (exact)
export function mul(a, factor) {
  if (a >= NEVER) return NEVER;
  if (!factor) return 0n;
  const r = a * BigInt(factor);
  return r >= NEVER ? NEVER : r;
}
// attotime / u32, rounded as MAME does: up when the remainder is at least factor / 2 (integer halves)
export function div(a, factor) {
  if (a >= NEVER) return NEVER;
  if (!factor) return a;
  const f = BigInt(factor);
  let q = a / f;
  const r = a % f;
  if (r >= BigInt(Math.floor(factor / 2))) q++;
  return q;
}

// HZ_TO_ATTOSECONDS(hz) for an integer frequency
export const hzToAttos = (hz) => ATTO / BigInt(hz);

// attotime::from_ticks(ticks, frequency)
export function fromTicks(ticks, freq) {
  const t = BigInt(ticks), f = BigInt(freq), apt = ATTO / f;
  if (t < f) return t * apt;
  return (t / f) * ATTO + (t % f) * apt;
}
// attotime::as_ticks(frequency), for non-negative times
export function asTicks(a, freq) {
  const f = BigInt(freq), sec = a / ATTO, atto = a % ATTO;
  return sec * f + (atto * f) / ATTO;
}
export const fromUsec = (us) => BigInt(us) * 1000000000000n;
export const fromMsec = (ms) => BigInt(ms) * 1000000000000000n;

// attotime::as_double(): double(seconds) + double(attoseconds) * 1e-18, with attoseconds in [0, 1e18)
export function asDouble(a) {
  let sec = a / ATTO, atto = a % ATTO;
  if (atto < 0n) { atto += ATTO; sec -= 1n; }
  return Number(sec) + Number(atto) * 1e-18;
}
// attotime::from_double(d): seconds = floor(d), attoseconds = (d - seconds) * 1e18 truncated
export function fromDouble(d) {
  const secs = Math.floor(d);
  const frac = d - secs;
  return BigInt(secs) * ATTO + BigInt(Math.trunc(frac * 1e18));
}

// for snapshots (JSON has no BigInt)
export const toText = (a) => a.toString();
export const fromText = (s) => BigInt(s);
