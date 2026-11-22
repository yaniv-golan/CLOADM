// The Session's serial byte-stream API (session.serial: device, attach, send, subscribe, flush, trace, status) and
// session.diagnostics(), on both serial chips: the Dragon 64's 6551 and the CoCo's bit-banger. The guests are
// small programs on the built-in firmware (no ROMs): a 6551 echo, docs/examples/serialrx.asm (a 1200-baud
// bit-banger receiver) and a 1200-baud bit-banger sender; the expected bytes and times are worked out here, not
// taken from the code under test. The chips themselves are MAME-verified by tools/mame-diff/run.js dragon64
// --serial and coco --serial / --printer; the last section shows a trace leaves those runs' hashes unchanged.
const fs = require('fs'), os = require('os'), path = require('path');
const Emu = require('./load')();

let fail = 0;
const check = (name, cond, detail = '') => { if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name} ${detail}`); };
const eq = (a, b) => a.length === b.length && Array.from(a).every((v, i) => v === b[i]);
const ALL = Array.from({ length: 256 }, (_, i) => i);
const refused = (fn, re) => { try { fn(); return false; } catch (e) { return e instanceof Emu.SessionError && re.test(e.message); } };

// ---------------- guests ----------------
// the 6551 at 9600 baud 8N1 (control $1E: 1.8432 MHz / 12 / 16; command $0B: DTR on, transmitter on, no
// interrupts): each byte received is kept at $4000 on (the end pointer at $31FE) and sent back
const ECHO6551 = `
        ORG     $3000
START   ORCC    #$50
        LDX     #$4000
        STX     $31FE
        LDA     #$1E
        STA     $FF07
        LDA     #$0B
        STA     $FF06
LOOP    LDA     $FF05
        BITA    #$08
        BEQ     LOOP
RXB     LDB     $FF04
        STB     ,X+
        STX     $31FE
WTX     LDA     $FF05
        BITA    #$10
        BEQ     WTX
        STB     $FF04
        BRA     LOOP
        END     START`;
// the 6551 set up as above, then a long wait (about 54 ms) before it reads the status, the data register and the
// status again, to $3100-$3102
const LATE6551 = `
        ORG     $3000
START   ORCC    #$50
        LDA     #$1E
        STA     $FF07
        LDA     #$0B
        STA     $FF06
        LDX     #6000
D       LEAX    -1,X
        BNE     D
        LDA     $FF05
        STA     $3100
        LDA     $FF04
        STA     $3101
        LDA     $FF05
        STA     $3102
HALT    BRA     HALT
        END     START`;
// the CoCo's bit-banger sending every byte 00..FF, 8N1, on PIA1 PA1; DLY sets the bit time (90: 1200 baud, about
// 746 cycles a bit at 894,886 Hz; 180: 600 baud). PA1 is made an output at mark, as serial-loopback.asm does.
const sender = (dly, bytes = 'all') => `
SHIFT   EQU     $2F00
CNT     EQU     $2F01
        ORG     $3000
START   ORCC    #$50
        LDA     #$34
        STA     $FF21
        LDA     #$02
        STA     $FF20
        LDA     #$30
        STA     $FF21
        LDA     #$FE
        STA     $FF20
        LDA     #$34
        STA     $FF21
        LDX     #20000          ; about 0.18 s: what the built-in firmware left on the line is over
W       LEAX    -1,X
        BNE     W
        LDU     #DATA
NEXT    LDA     ,U+
        BSR     SEND
        CMPU    #DATAEND
        BNE     NEXT
HALT    BRA     HALT
SEND    STA     SHIFT
        CLRB
        STB     $FF20
        LDX     #${dly}
L0      LEAX    -1,X
        BNE     L0
        LDB     #8
        STB     CNT
DBIT    LDB     #0
        LSR     SHIFT
        BCC     Z
        LDB     #2
Z       STB     $FF20
        LDX     #${dly}
L1      LEAX    -1,X
        BNE     L1
        DEC     CNT
        BNE     DBIT
        LDB     #2
        STB     $FF20
        LDX     #${dly + 2}
L2      LEAX    -1,X
        BNE     L2
        RTS
DATA    FCB     ${(bytes === 'all' ? ALL : bytes).join(',')}
DATAEND FCB     0
        END     START`;
const asm = (src) => { const r = Emu.assemble(src, '6809'); if (!r.ok) throw new Error(JSON.stringify(r.errors)); return r; };
const SERIALRX = fs.readFileSync(path.join(__dirname, '../docs/examples/serialrx.asm'), 'utf8');

function session(id, guest, { baud = null, frames = 1 } = {}) {
  const s = new Emu.Session({ welcomeMenu: false });
  s.switchMachine(id, {}, { menu: false });
  if (baud) s.serial.attach('terminal', { baud });
  s.runAssembled(asm(guest));
  s.runFrames(frames);
  return s;
}
// a subscriber that keeps everything
const keep = () => { const k = { tx: [], txAt: [], rx: [], rxAt: [], calls: 0 }; k.handlers = { tx: (b, i) => { k.calls++; k.tx.push(...b); k.txAt.push(...i.at); k.txInfo = i; }, rx: (b, i) => { k.calls++; k.rx.push(...b); k.rxAt.push(...i.at); } }; return k; };
// a terminal log as the page's serial panel keeps one: its own subscriber, only what reached the terminal
const termLog = (s) => { const log = []; s.serial.subscribe({ tx: (b, i) => { if (i.device === 'terminal') log.push(...b); } }); return log; };
const echoed = (s) => { const end = s.readByte(0x31FE) << 8 | s.readByte(0x31FF); return Array.from({ length: end - 0x4000 }, (_, i) => s.readByte(0x4000 + i)); };

(async () => {
// ---------------- the device, attach, send ----------------
{
  const s = new Emu.Session({ welcomeMenu: false });
  s.switchMachine('dragon64', {}, { menu: false });
  check('device: the Dragon 64\'s 6551 with nothing plugged in', JSON.stringify(s.serial.device) === JSON.stringify({ chip: '6551', kind: 'none', baud: 9600, kinds: ['none', 'terminal', 'loopback'] }));
  check('send needs the terminal', refused(() => s.serial.send([1]), /Plug in the terminal first/));
  s.serial.attach('terminal', { baud: 9600 });
  check('send([256]) is refused (it used to go out as $00)', refused(() => s.serial.send([256]), /Byte 0 is 256: a serial byte is 0\.\.255/));
  check('send refuses -1, 1.5, NaN and a non-number, naming the byte', refused(() => s.serial.send([0, -1]), /Byte 1 is -1/) && refused(() => s.serial.send([1.5]), /Byte 0 is 1\.5/)
    && refused(() => s.serial.send([NaN]), /Byte 0 is NaN/) && refused(() => s.serial.send(['A']), /Byte 0 is A/));
  check('a string needs { text: true }; text takes one byte a character', refused(() => s.serial.send('AB'), /send\(text, \{ text: true \}\)/) && refused(() => s.serial.send('A€', { text: true }), /Byte 1 is "€"/));
  const q = s.machine.serialPort.queue;
  check('nothing refused reaches the queue', q.length === 0, q.join());
  check('send returns the count; text newlines go as CR', s.serial.send(Uint8Array.of(0, 255)) === 2 && s.serial.send('A\nB\r\n', { text: true }) === 4 && eq(q, [0, 255, 0x41, 13, 0x42, 13]), q.join());
  check('subscribe and trace refuse bad options', refused(() => s.serial.subscribe({}), /subscribe takes/) && refused(() => s.serial.subscribe({ tx() {} }, { flush: 'never' }), /flush is 'frame' or 'instant'/)
    && refused(() => s.serial.trace({ limit: 0 }), /limit/) && refused(() => s.serial.trace({ registers: 'some' }), /registers is/));
  const coco = new Emu.Session({ welcomeMenu: false });
  coco.switchMachine('coco', {}, { menu: false });
  check('device: the CoCo\'s bit-banger with the printer; no 6551 status', JSON.stringify(coco.serial.device) === JSON.stringify({ chip: 'bit-banger', kind: 'printer', baud: 600, kinds: ['printer', 'terminal', 'loopback'] }) && coco.serial.status() === null);
  coco.switchMachine('dragon32', {}, { menu: false });
  check('the Dragon 32 has no serial port: device null, attach refused, diagnostics serial null', coco.serial.device === null && refused(() => coco.serial.attach('terminal'), /no serial port here/) && coco.diagnostics().serial === null);
}

// ---------------- every byte both ways, byte-exact: the 6551 ----------------
{
  const s = session('dragon64', ECHO6551, { baud: 9600 });
  const a = keep(), b = keep();
  s.serial.subscribe(a.handlers); s.serial.subscribe(b.handlers);
  const log = termLog(s);
  const t0 = s.machine.now(), bit = s.machine.tickHz / 9600;
  s.serial.send(ALL);
  s.serial.flush();
  check('6551: nothing has arrived at the moment it is sent', a.rx.length === 0, `${a.rx.length}`);
  s.runFrames(30);
  check('6551: the guest received 00..FF byte-exact', eq(echoed(s), ALL), `${echoed(s).length} bytes`);
  check('6551: rx delivered 00..FF byte-exact', eq(a.rx, ALL), `${a.rx.length}`);
  check('6551: tx delivered the echo, 00..FF byte-exact', eq(a.tx, ALL), `${a.tx.length}`);
  check('6551: a second subscriber and the terminal log see the same bytes', eq(b.tx, a.tx) && eq(b.rx, a.rx) && eq(log, a.tx), `${b.tx.length} ${b.rx.length} ${log.length}`);
  // each byte arrives when its stop bit ends: the n-th (from 1) at t0 + 10n bit times
  let t = t0, ok = true;
  for (let i = 0; i < 256; i++) { t += 10 * bit; if (a.rxAt[i] !== t) ok = false; }
  check('6551: each rx byte is delivered at the end of its stop bit (t0 + 10n bit times)', ok, `${a.rxAt[0] - t0} ticks for the first, ${10 * bit} expected`);
  check('6551: tx info: at for each byte, the frame, the device', a.txAt.length === 256 && a.txAt.every((v, i) => i === 0 || v > a.txAt[i - 1]) && a.txInfo.device === 'terminal' && a.txInfo.frame > 1 && a.txInfo.frame <= s.machine.frameCount);
}

// ---------------- every byte both ways, byte-exact: the bit-banger ----------------
{
  const s = session('coco', SERIALRX, { baud: 1200 });
  const a = keep(), b = keep();
  s.serial.subscribe(a.handlers); s.serial.subscribe(b.handlers);
  s.serial.send(ALL);
  s.runFrames(160);
  const got = Array.from({ length: 256 }, (_, i) => s.readByte(0x3200 + i));
  check('bit-banger: serialrx.asm received 00..FF byte-exact', eq(got, ALL) && s.readByte(0x31FF) === 0, `${s.readByte(0x31FF)}`);
  check('bit-banger: rx delivered 00..FF byte-exact, to both subscribers', eq(a.rx, ALL) && eq(b.rx, ALL), `${a.rx.length} ${b.rx.length}`);
  const t = session('coco', sender(90), { baud: 1200 });
  const c = keep(), d = keep();
  t.serial.subscribe(c.handlers); t.serial.subscribe(d.handlers);
  const tlog = termLog(t);
  t.runFrames(160);
  check('bit-banger: tx delivered 00..FF byte-exact from the sender', eq(c.tx, ALL), `${c.tx.length}: ${c.tx.slice(0, 8)}`);
  check('bit-banger: a second subscriber and the terminal log see the same bytes', eq(d.tx, c.tx) && eq(tlog, c.tx), `${d.tx.length} ${tlog.length}`);
  // the printer: tx subscribers hear what it prints; the terminal log does not
  const p = session('coco', sender(180, [0x48, 0x49, 0x0D]));
  const e = keep();
  p.serial.subscribe(e.handlers);
  const plog = termLog(p);
  p.runFrames(40);
  check('bit-banger: with the printer plugged in, tx hears what it prints and the terminal log stays empty', eq(e.tx, [0x48, 0x49, 0x0D]) && eq(p.machine.printed.slice(-3), e.tx) && plog.length === 0 && e.txInfo.device === 'printer', `${e.tx} / ${p.machine.printed}`);
}

// ---------------- unsubscribing, a subscriber that sends, one that throws ----------------
{
  const s = session('dragon64', ECHO6551, { baud: 9600 });
  const a = keep(), b = keep();
  s.serial.subscribe(a.handlers);
  const sb = s.serial.subscribe(b.handlers);
  s.serial.send(ALL);
  s.runFrames(5);
  const n = b.tx.length;
  sb.unsubscribe(); sb.unsubscribe();
  s.runFrames(25);
  check('unsubscribing mid-stream: it keeps what came before, the others get everything', n > 0 && n < 256 && eq(b.tx, ALL.slice(0, n)) && eq(a.tx, ALL), `${n} then ${b.tx.length}; ${a.tx.length}`);
  check('unsubscribe is idempotent: only the other subscriber is left', s.serial.subs.length === 1);
}
{
  const s = session('dragon64', ECHO6551, { baud: 9600 });
  const sent = [];
  s.serial.subscribe({ tx: (bytes) => { for (const x of bytes) { sent.push(x); if (x < 20) s.serial.send([x + 1]); } } });
  s.serial.send([1]);
  s.runFrames(40);
  check('a subscriber that sends from tx: the echo of each byte sends the next', eq(sent, ALL.slice(1, 21)), sent.join());
}
{
  const s = session('dragon64', ECHO6551, { baud: 9600 });
  const order = [], b = keep();
  s.serial.subscribe({ tx: () => { order.push('thrower'); throw new Error('subscriber boom'); } });
  s.serial.subscribe({ tx: (x, i) => { order.push('after'); b.handlers.tx(x, i); } });
  s.serial.send([0x41, 0x42]);
  let err = null;
  for (let f = 0; f < 10 && !err; f++) { try { s.runFrames(1); } catch (e) { err = e; } }
  check('a subscriber that throws: the error comes out after the others have run', err && err.message === 'subscriber boom' && eq(order, ['thrower', 'after']), `${err && err.message} ${order}`);
  s.serial.send([0x43]);
  s.runFrames(10);
  check('...and it is unsubscribed: later bytes reach the others, nothing more throws', eq(b.tx, [0x41, 0x42, 0x43]) && order.filter((o) => o === 'thrower').length === 1, `${b.tx} ${order}`);
}

// ---------------- 'frame' and 'instant' delivery ----------------
{
  const s = session('dragon64', ECHO6551, { baud: 9600 });
  const f = keep(), i = keep();
  s.serial.subscribe(f.handlers);
  s.serial.subscribe(i.handlers, { flush: 'instant' });
  s.serial.send([0x10, 0x20, 0x30]);
  const d = s.debug;
  for (let k = 0; k < 4000 && i.tx.length < 3; k++) d.step();
  check('\'instant\' hears bytes by the next instruction while stepping; \'frame\' waits for the end of the frame', eq(i.rx, [0x10, 0x20, 0x30]) && eq(i.tx, [0x10, 0x20, 0x30]) && f.calls === 0, `${i.rx} ${i.tx} ${f.calls}`);
  s.serial.flush();
  check('flush() hands a \'frame\' subscriber what has crossed by now', eq(f.rx, i.rx) && eq(f.tx, i.tx), `${f.rx} ${f.tx}`);
  s.runFrames(1);
  check('...and at the end of the frame \'frame\' has the same bytes, at the same ticks', eq(f.rx, i.rx) && eq(f.tx, i.tx) && eq(f.rxAt, i.rxAt) && eq(f.txAt, i.txAt));
  // a breakpoint where the guest has just read a byte: at each stop 'instant' has exactly the bytes whose stop bit
  // has ended by then (the n-th at t0 + 10n bit times), and 'frame' none of the bytes that arrived since the frame began
  const fi = keep(), ii = keep();
  s.serial.subscribe(fi.handlers); s.serial.subscribe(ii.handlers, { flush: 'instant' });
  const RXB = asm(ECHO6551).symbols.get('RXB'), m = s.machine, bit = m.tickHz / 9600, t0 = m.now(), frameStart = () => m.frameBase;
  s.serial.send([0x40, 0x41, 0x42]);
  d.addBreakpoint(RXB + 3);   // STB ,X+: the byte has been read
  let stops = 0, exact = true, ahead = false;
  for (let k = 0; k < 6 && stops < 3; k++) {
    s.runFrames(1);
    if (!s.paused) continue;
    stops++;
    const arrived = [0x40, 0x41, 0x42].filter((_, j) => t0 + 10 * (j + 1) * bit <= m.now());
    const byFrame = [0x40, 0x41, 0x42].filter((_, j) => t0 + 10 * (j + 1) * bit <= frameStart());
    if (!eq(ii.rx, arrived) || !eq(fi.rx, byFrame)) exact = false;
    if (ii.rx.length > fi.rx.length) ahead = true;
    s.resume();
  }
  check('a breakpoint stop: \'instant\' has every byte that has crossed by then, \'frame\' only those before the frame', stops === 3 && exact && ahead, `${stops} stops; ${ii.rx} / ${fi.rx}`);
  d.removeBreakpoint(RXB + 3);
  s.runFrames(2);
  s.serial.flush();
  check('then every subscriber has every byte', eq(fi.rx, [0x40, 0x41, 0x42]) && eq(ii.rx, fi.rx) && eq(fi.tx, [0x40, 0x41, 0x42]) && eq(f.rx, [0x10, 0x20, 0x30, 0x40, 0x41, 0x42]), `${fi.rx} ${fi.tx} ${f.rx}`);
}

// ---------------- subscriptions belong to the Session ----------------
{
  const s = session('dragon64', ECHO6551, { baud: 9600 });
  const a = keep();
  s.serial.subscribe(a.handlers);
  s.serial.send(ALL.slice(0, 128));
  s.runFrames(5);
  const before = a.tx.length;
  const bytes = (await s.snapshotFile()).bytes;
  check('a snapshot holds no subscription', !/subs|listeners|onTrace/.test(new TextDecoder().decode(bytes).replace(/[^\x20-\x7E]/g, '')));
  s.openSnapshot(await s.readSnapshot(bytes));
  s.serial.send(ALL.slice(128));
  s.runFrames(30);
  check('the subscription survives openSnapshot: 00..FF across it, nothing twice', before > 0 && before < 128 && eq(a.tx, ALL) && eq(a.rx, ALL), `${before} then ${a.tx.length}`);
  const t = new Emu.Session({ welcomeMenu: false });
  t.openSnapshot(await t.readSnapshot(bytes));
  check('a new Session opening it has no subscriber', t.serial.subs.length === 0 && t.serial.device.kind === 'terminal');
  s.switchMachine('coco', {}, { menu: false });
  s.serial.attach('terminal', { baud: 1200 });
  s.runAssembled(asm(sender(90, [0x55, 0xAA])));
  s.runFrames(20);
  check('...and switchMachine: the bytes of the next machine reach it', eq(a.tx.slice(-2), [0x55, 0xAA]), a.tx.slice(256).join());
}

// ---------------- the trace ----------------
{
  const s = session('dragon64', ECHO6551, { baud: 9600, frames: 0 });
  const tr = s.serial.trace({ limit: 100000, registers: 'all' });
  s.runFrames(1);
  s.serial.send(ALL);
  s.runFrames(30);
  const ev = tr.events, kinds = (k) => ev.filter((e) => e.kind === k);
  check('trace: oldest first, each with at, frame, pc, kind', ev.length > 0 && ev.every((e, i) => typeof e.at === 'number' && Number.isInteger(e.frame) && Number.isInteger(e.pc) && (i === 0 || e.at >= ev[i - 1].at)));
  check('trace: the setup writes, control then command', kinds('reg-write').slice(0, 2).map((e) => `${e.reg}=${e.value}`).join() === '3=30,2=11');
  check('trace: rx, tx-load and tx carry every byte 00..FF', eq(kinds('rx').map((e) => e.byte), ALL) && eq(kinds('tx-load').map((e) => e.byte), ALL) && eq(kinds('tx').map((e) => e.byte), ALL));
  check('trace: no overrun, framing or parity error in the echo', !kinds('overrun').length && !kinds('framing').length && !kinds('parity').length);
  const polls = kinds('reg-read').filter((e) => e.reg === 1);
  check('trace: a polling loop\'s status reads are counted, not repeated', polls.some((e) => e.count > 1) && polls.every((e, i) => i === 0 || ev.indexOf(e) !== ev.indexOf(polls[i - 1]) + 1 || e.value !== polls[i - 1].value), `${polls.length} runs, longest ${Math.max(...polls.map((e) => e.count))}`);
  check('trace: a status read records the value the read returned (RDRF set before each data read)', kinds('reg-read').filter((e, i, all) => e.reg === 0).length === 256 && ev.filter((e, i) => e.kind === 'reg-read' && e.reg === 0).every((e) => { const j = ev.indexOf(e); const prev = ev.slice(0, j).reverse().find((x) => x.kind === 'reg-read' && x.reg === 1); return prev && (prev.value & 0x08); }));
  check('trace: an rx event\'s status is peeked: RDRF set, and the read that follows is still the program\'s', kinds('rx').every((e) => e.status & 0x08));
  // byte timing, worked out by hand: a bit is 16 clocks of 1.8432 MHz / 12 (control $1E), so 16 x 12 x tickHz /
  // 1,843,200 ticks. The terminal sends back to back, so each byte the 6551 receives completes 10 bit times after
  // the one before. Sending back to back, the 6551 (MAME's mos6551 model, which this one follows state for state)
  // takes one clock more a byte: its transmitter goes back to its start state on the clock that ends the stop bit
  // and loads the next byte on the clock after.
  const clock = 12 * s.machine.tickHz / 1843200, bitTicks = 16 * clock;
  const gapsOf = (k) => { const a = kinds(k).map((e) => e.at); return a.slice(1).map((v, i) => v - a[i]); };
  const rxGaps = gapsOf('rx'), txGaps = gapsOf('tx');
  check('trace: consecutive rx bytes complete exactly 10 bit times apart (16 x 12 x tickHz / 1.8432 MHz a bit)', rxGaps.length === 255 && rxGaps.every((g) => Math.abs(g - 10 * bitTicks) < 1e-6), `${10 * bitTicks} ticks expected; ${Math.min(...rxGaps)}..${Math.max(...rxGaps)}`);
  check('trace: consecutive tx bytes are 10 bit times and one clock apart (161 clocks), back to back', txGaps.length === 255 && txGaps.every((g) => Math.abs(g - (10 * bitTicks + clock)) < 1e-6), `${10 * bitTicks + clock} ticks expected; ${Math.min(...txGaps)}..${Math.max(...txGaps)}`);
  check('trace: frame and pc where the event happened (an rx inside the guest\'s loop)', kinds('rx').every((e) => e.pc >= 0x3000 && e.pc < 0x3030 && e.frame >= 1));
  tr.stop(); tr.stop();
  const n = tr.events.length;
  s.serial.send([1, 2, 3]); s.runFrames(5);
  check('trace: stop() ends it (idempotent), and leaves the chip without a hook', tr.events.length === n && s.machine.acia.trace === null && s.machine.acia.chip.onTrace === null && s.machine.acia.traces.size === 0);
  // a small ring keeps the newest, oldest first, and counts what it dropped
  const r = s.serial.trace({ limit: 8 });
  s.serial.send([0xA0, 0xA1, 0xA2, 0xA3, 0xA4, 0xA5]); s.runFrames(5);
  const last = r.events;
  check('trace: a ring of 8 keeps the newest 8, oldest first, and counts the dropped', last.length === 8 && r.dropped > 0 && last.map((e) => e.kind + (e.byte ?? '')).slice(-2).join() === 'tx-load165,tx165' && last.every((e, i) => i === 0 || e.at >= last[i - 1].at), `${r.dropped} ${last.map((e) => e.kind + (e.byte ?? '')).join()}`);
  check('trace: \'writes\' records no reads', !last.some((e) => e.kind === 'reg-read'));
  r.stop();
}
{
  // a late read of the data register: the second byte arrives while the first is unread
  const s = session('dragon64', LATE6551, { baud: 9600 });
  const tr = s.serial.trace();
  s.serial.send([0x41, 0x42]);
  s.runFrames(6);
  const ev = tr.events;
  check('a late RDR read: exactly one overrun, for the second byte; the first is kept', ev.filter((e) => e.kind === 'overrun').length === 1 && ev.find((e) => e.kind === 'overrun').byte === 0x42 && ev.filter((e) => e.kind === 'rx').map((e) => e.byte).join() === '65', ev.map((e) => e.kind).join());
  check('...the guest sees RDRF and overrun, then the first byte, then both cleared', s.readByte(0x3100) & 0x0C && s.readByte(0x3101) === 0x41 && !(s.readByte(0x3102) & 0x0C), [0x3100, 0x3101, 0x3102].map((a) => s.readByte(a).toString(16)).join());
  const st = s.serial.status();
  check('status(): decoded, without the read\'s side effects', st && st.value === s.machine.acia.chip.peek(1) && st.tdre && !st.rdrf && !st.overrun && !st.dsr && !st.dcd && s.serial.status().value === st.value);
  const diag = s.diagnostics();
  check('diagnostics(): pc, frame, now, cycles and the serial port', diag.pc === s.machine.cpu.pc && diag.frame === s.machine.frameCount && diag.now === s.machine.now() && diag.cycles === s.machine.cpu.totalCycles
    && diag.serial.device.kind === 'terminal' && diag.serial.status.value === st.value && diag.serial.queued === 0, JSON.stringify(diag));
  s.serial.send([1, 2, 3]);
  check('diagnostics(): the bytes still to cross the wire', s.diagnostics().serial.queued === 3);
}
{
  // the bit-banger's trace: what the device decodes and what crosses the wire, with the times the API gives
  const s = session('coco', sender(90, [0x31, 0x32]), { baud: 1200, frames: 0 });
  const tr = s.serial.trace(), a = keep();
  s.serial.subscribe(a.handlers);
  s.runFrames(20);
  s.serial.send([0x99]);
  s.runFrames(2);
  const ev = tr.events;
  check('bit-banger trace: tx for each byte decoded, rx for each byte across the wire, at the same ticks the subscribers get',
    ev.map((e) => `${e.kind}${e.byte}`).join() === 'tx49,tx50,rx153' && eq(ev.filter((e) => e.kind === 'tx').map((e) => e.at), a.txAt) && ev[2].at === a.rxAt[0], ev.map((e) => `${e.kind}${e.byte}@${e.at}`).join());
  tr.stop();
  check('bit-banger trace: stop() takes its listener off the port', s.machine.serialPort.listeners.size === 1);
}

// ---------------- two traces at once ----------------
{
  const s = session('dragon64', ECHO6551, { baud: 9600 });
  const one = s.serial.trace({ registers: 'all' }), two = s.serial.trace();
  s.serial.send([0x31, 0x32]);
  s.runFrames(5);
  const bytes = (t, k) => t.events.filter((e) => e.kind === k).map((e) => e.byte).join();
  check('two traces at once on the 6551: each sees every byte', bytes(one, 'rx') === '49,50' && bytes(two, 'rx') === '49,50' && bytes(one, 'tx') === '49,50' && bytes(two, 'tx') === '49,50',
    `${bytes(one, 'rx')} / ${bytes(two, 'rx')}`);
  check('...each with its own options: reads only in the one that asked', one.events.some((e) => e.kind === 'reg-read') && !two.events.some((e) => e.kind === 'reg-read'));
  two.stop();
  s.serial.send([0x33]);
  s.runFrames(5);
  check('stopping one leaves the other running', bytes(one, 'rx') === '49,50,51' && bytes(two, 'rx') === '49,50' && s.machine.acia.traces.size === 1);
  one.stop();
  check('stopping both leaves the chip without a hook', s.machine.acia.trace === null && s.machine.acia.chip.onTrace === null);
  // a trace and a second Session-less one on the same machine, and the trace moving with the machine
  const t = s.serial.trace();
  s.switchMachine('coco', {}, { menu: false });
  s.serial.attach('terminal', { baud: 1200 });
  s.runAssembled(asm(sender(90, [0x77])));
  s.runFrames(20);
  check('a trace moves to the next machine (the bit-banger): its tx byte is there', t.events.some((e) => e.kind === 'tx' && e.byte === 0x77));
  t.stop();
}
// ---------------- a move to another machine that fails leaves the trace recording ----------------
// session.hooks moves everything or nothing: when a hook refuses the next machine, what went on it is taken off
// again and everything stays where it was. A trace must keep recording on the machine it stayed on.
for (const [id, guest, baud, feed] of [['dragon64', ECHO6551, 9600, true], ['coco', sender(90, [0x61, 0x62]), 1200, false]]) {
  const s = session(id, guest, { baud, frames: 1 });
  const tr = s.serial.trace();
  const bad = Emu.createMachine(id);
  const refuse = s.hooks.add((m) => { if (m === bad) throw new Error('this hook refuses that machine'); return () => {}; });
  let refused = null;
  try { s.hooks.attach(bad); } catch (e) { refused = e.message; }
  let crash = null;
  try {
    if (feed) s.serial.send([0x41, 0x42]);
    s.runFrames(20);
  } catch (e) { crash = e.message; }
  const got = tr.events.filter((e) => e.kind === (feed ? 'rx' : 'tx')).map((e) => e.byte).join();
  check(`${id}: a hook refusing the next machine leaves the trace recording on the machine it stayed on`, refused === 'this hook refuses that machine' && crash === null && got === (feed ? '65,66' : '97,98') && tr.events.every((e) => e.frame >= 1),
    `${refused}; ${crash}; ${got}`);
  refuse(); tr.stop();
}

// ---------------- a trace leaves the chip as it is: the IRQ ----------------
{
  // command $09: DTR on, the receive interrupt on, the transmitter on without its interrupt. A byte comes in (the
  // RDRF interrupt is pending), then the CPU writes the transmit register: a trace that read the status register
  // (instead of peeking) would clear the pending interrupt and drop the IRQ line
  const IRQ6551 = `
        ORG     $3000
START   ORCC    #$50
        LDA     #$1E
        STA     $FF07
        LDA     #$09
        STA     $FF06
W       LDA     $3100
        BEQ     W
        LDA     #$55
        STA     $FF04
HALT    BRA     HALT
        END     START`;
  const run = (traced) => {
    const s = session('dragon64', IRQ6551, { baud: 9600 });
    const tr = traced ? s.serial.trace({ registers: 'all' }) : null;
    s.serial.send([0x41]);
    s.runFrames(2);
    const before = { irq: s.machine.acia.chip.irqState, out: s.machine.acia.chip.irq, line: s.machine.interrupts.level('acia', 'irq') };
    s.pokeBytes(0x3100, [1]);   // the guest writes the transmit register now
    s.runFrames(3);
    const c = s.machine.acia.chip;
    return { before, irqState: c.irqState, irq: c.irq, line: s.machine.interrupts.level('acia', 'irq'), cpuLine: s.machine.cpu.irqLine, chip: JSON.stringify(c.saveState()), events: tr ? tr.events.map((e) => e.kind).join() : '' };
  };
  const plain = run(false), traced = run(true);
  check('the receive interrupt is pending before the transmit write (the case a status read would clear)', plain.before.irq !== 0 && plain.before.out === 0 && plain.before.line === true && plain.line === true, JSON.stringify(plain.before));
  check('with a trace on, the 6551\'s IRQ state, its IRQ output, the IRQ it drives and the CPU\'s IRQ line are what they are without', traced.irqState === plain.irqState && traced.irq === plain.irq && traced.line === plain.line && traced.cpuLine === plain.cpuLine && plain.irqState !== 0,
    JSON.stringify([plain.irqState, plain.irq, plain.line, traced.irqState, traced.irq, traced.line]));
  check('...and the whole chip state is the same', traced.chip === plain.chip);
  check('...while the trace saw the byte come in and the transmit load', /rx/.test(traced.events) && /tx-load/.test(traced.events), traced.events);
}

// ---------------- a trace changes nothing: the MAME-verified runs' hashes ----------------
{
  const hashes = JSON.parse(fs.readFileSync(path.join(__dirname, 'regress-hashes.json'), 'utf8'));
  const spec = (family) => require(path.join(__dirname, '../tools/mame-diff', family, 'spec.js'));
  const fnv = (h, v) => { h ^= v & 0xFFFFFFFF; return Math.imul(h, 0x01000193) >>> 0; };
  // as tests/regress.test.js hashes them: every instruction's registers and cycles (and, for the printer, the bytes)
  const run = (t, tr, { printer = false } = {}) => {
    const m = t.machine();
    tr.attach(m);
    const names = t.regs.map((r) => r.name);
    let h = 0x811C9DC5, n = 0, c0 = null, halted = false, after = -1;
    m.cpu.trace = (c) => {
      if (c0 === null) c0 = c.totalCycles;
      for (const r of names) h = fnv(h, c[r]);
      h = fnv(h, c.totalCycles - c0);
      if (c.pc === t.haltPc) { halted = true; if (printer) m.cpu.trace = null; }
      n++;
    };
    if (printer) {
      for (let f = 0; f < 3600 && after !== 0; f++) { m.runFrame(); if (after < 0 && m.read(t.doneAddr) === 0xFF) after = 30; else if (after > 0) after--; }
      for (const b of m.printed) h = fnv(h, b);
      return { hash: h.toString(16).padStart(8, '0'), printed: m.printed.length, halted, m };
    }
    for (let f = 0; f < 5000 && n < t.instructions; f++) m.runFrame();
    return { hash: h.toString(16).padStart(8, '0'), instructions: n, halted, m };
  };
  const acia = new Emu.SerialTrace(1000000, true), r = run(spec('sam').serial('dragon64'), acia);
  const want = hashes['acia dragon64'], ev = acia.events(), k = (x) => ev.filter((e) => e.kind === x).length;
  check('the 6551 diagnostic (acia.asm) with a full trace on: the regression hash is unchanged', r.hash === want.hash && r.instructions === want.instructions && r.halted, `${r.hash} vs ${want.hash}`);
  check('...and the trace saw it all: register reads and writes, tx-load, tx, rx, overrun and framing', ['reg-read', 'reg-write', 'tx-load', 'tx', 'rx', 'overrun', 'framing'].every((x) => k(x) > 0), ['reg-read', 'reg-write', 'tx-load', 'tx', 'rx', 'overrun', 'framing', 'parity'].map((x) => `${x} ${k(x)}`).join(', '));
  // the configuration loop keeps each byte it reads back at $7400 on ($7002: where the next goes)
  const sent = [...r.m.ram.slice(0x7400, (r.m.ram[0x7002] << 8 | r.m.ram[0x7003]))];
  check('...its first rx bytes are the ones the firmware\'s configuration loop read back, in order', sent.length > 10 && eq(ev.filter((e) => e.kind === 'rx').slice(0, sent.length).map((e) => e.byte), sent), `${sent.length}`);
  const pr = new Emu.SerialTrace(1000000), q = run(spec('sam').printer('coco'), pr, { printer: true });
  const wantP = hashes['printer coco'];
  check('the CoCo\'s serial printer firmware with a trace on: the regression hash is unchanged', q.hash === wantP.hash && q.printed === wantP.printed && q.halted, `${q.hash} vs ${wantP.hash}`);
  check('...and the trace\'s tx bytes are what the printer printed', eq(pr.events().map((e) => e.byte), q.m.printed) && pr.events().every((e) => e.kind === 'tx'));
}

// ---------------- the command line: --serial-trace and the machine in failures ----------------
{
  const cli = require('../cli/cloadm.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cloadm-serial-'));
  const prog = path.join(dir, 'send.asm'), traceFile = path.join(dir, 'trace.jsonl');
  fs.writeFileSync(prog, sender(180, [0x48, 0x49]));
  const runCli = async (argv) => { let out = ''; const code = await cli.main(argv, { out: (t) => { out += t; }, err: () => {} }); return { code, json: JSON.parse(out) }; };
  let r = await runCli(['--json', '--machine', 'coco', '--serial-trace', traceFile, '--asm', prog, '--wait-for', 'text:NEVER', '--timeout', '1']);
  const lines = fs.readFileSync(traceFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  check('--serial-trace: written although the run failed, one JSON event a line', r.code === 1 && lines.filter((e) => e.kind === 'tx').map((e) => e.byte).slice(-2).join() === '72,73' && lines.every((e) => 'at' in e && 'frame' in e && 'pc' in e), JSON.stringify(lines).slice(0, 200));
  check('a timeout\'s error gains machine { pc, frame, cycles } and serial (its device and 6551 status)', r.json.error.code === 'timeout' && r.json.error.machine.pc === r.json.machine.pc && r.json.error.machine.frame === r.json.machine.frame
    && Number.isInteger(r.json.error.machine.cycles) && r.json.error.serial.device.kind === 'printer' && r.json.error.serial.status === null, JSON.stringify(r.json.error.machine));
  const step = r.json.steps.find((x) => x.step === 'serial-trace');
  check('--serial-trace: its step result names the file, and the events and dropped are filled in at the end', step && step.file === traceFile && step.events === lines.length && step.dropped === 0, JSON.stringify(step));
  r = await runCli(['--json', '--machine', 'dragon64', '--asm', prog, '--wait-for', 'pc:$1234', '--timeout', '0.5']);
  check('a pc: wait\'s timeout too, with the 6551\'s status decoded', r.code === 1 && r.json.error.code === 'timeout' && r.json.error.machine.pc === r.json.machine.pc && r.json.error.serial.status && typeof r.json.error.serial.status.value === 'number', JSON.stringify(r.json.error.serial));
  r = await runCli(['--json', '--machine', 'dragon64', '--asm', prog, '--frames', '2', '--type', 'X', '--timeout', '0.2']);
  check('keys-not-taken gains them too', r.code === 1 && r.json.error.code === 'keys-not-taken' && r.json.error.machine && 'serial' in r.json.error, JSON.stringify(r.json.error).slice(0, 200));
  r = await runCli(['--json', '--machine', 'dragon64', '--serial-trace', traceFile, '--frames', '2']);
  check('--serial-trace: written on success too', r.code === 0 && fs.readFileSync(traceFile, 'utf8') === '' && r.json.steps[0].events === 0);
  check('--describe lists serial-trace', cli.describe().steps.some((x) => x.name === 'serial-trace'));
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(fail ? `${fail} FAILED` : 'all passed');
process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.log(`FAIL ${e.stack}`); process.exitCode = 1; });
