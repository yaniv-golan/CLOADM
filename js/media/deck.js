/*
 * Cassette deck: the tape in the machine's cassette port, its motor relay and play position.
 * The tape only moves while the motor runs; the deck catches up lazily (sync) whenever the
 * machine reads the input level or switches the motor. Time is in machine ticks.
 *
 * Recording: while armed (startRecording), what the machine writes to the cassette output is kept as
 * [tick, level] pairs (level 0..1; null when the motor stops) while the motor runs, or all the time on a
 * machine without motor control (motorless). stopRecording returns them; js/media/cassette.js turns them
 * into a signal, a WAV or .CAS bytes.
 */
import { Tape } from './tape.js';

class CassetteDeck {
  constructor(now) {
    this.now = now;            // () -> current tick
    this.tape = null;
    this.motor = false;
    this.time = 0;             // tick the tape position was last brought up to date
    this.onInsert = null;      // family hook (the MC-10's motor follows reads, not a relay)
    this.out = 0;              // the cassette output level the machine drives (0..1)
    this.recording = null;     // [[tick, level|null]] while armed
    this.motorless = false;    // record whatever the motor does (the MC-10 has no motor relay)
  }
  // the machine drives the cassette output
  output(level) {
    if (level === this.out) return;
    this.out = level;
    if (this.recording && (this.motor || this.motorless)) this.recording.push([this.now(), level]);
  }
  startRecording() { this.recording = this.motor || this.motorless ? [[this.now(), this.out]] : []; }
  // -> the events recorded since startRecording; disarms
  stopRecording() {
    const r = this.recording || [];
    if (r.length && (this.motor || this.motorless)) r.push([this.now(), null]);
    this.recording = null;
    return r;
  }
  sync() {
    const now = this.now();
    if (this.tape && this.motor) this.tape.advance(now - this.time);
    this.time = now;
  }
  setMotor(on) {
    if (on === this.motor) return;
    this.sync();
    this.motor = on;
    if (this.recording && !this.motorless) this.recording.push([this.now(), on ? this.out : null]);
  }
  level() {
    if (!this.tape) return false;
    this.sync();
    return this.tape.level();
  }
  insert(tape) {
    this.sync();
    this.tape = tape;
    if (this.onInsert) this.onInsert();
  }
  eject() { this.insert(null); }
  get playing() { return this.motor && !!this.tape && !this.tape.atEnd(); }
  saveState() {
    return { motor: this.motor, time: this.time, tape: this.tape ? this.tape.saveState() : null,
      out: this.out, recording: this.recording ? this.recording.map((e) => e.slice()) : null };
  }
  loadState(s) {
    this.motor = s.motor; this.time = s.time;
    this.out = s.out; this.recording = s.recording ? s.recording.map((e) => e.slice()) : null;
    this.tape = s.tape ? Tape.fromState(s.tape) : null;
  }
}

export { CassetteDeck };
