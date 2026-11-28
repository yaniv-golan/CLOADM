// The printout as text (js/printout.js) and the Session's printout accessors: the text the Machine tab's Printer box
// shows, its line count ("nothing yet" when there is nothing to see: a CoCo's start-bit NUL, a Dragon's reset $FF),
// the .txt "Save printout" writes (the text as shown, CR LF line ends, plain ASCII), the raw .prn kept for the command
// line, MCP and tests, and the reader the box appends with (only what is new; a cleared or replaced printout starts
// over). Expected values are written out by hand from the rules, not computed by the code under test.
// Run: node tests/printout.test.js
const Emu = require('./load')();

let fail = 0, n = 0;
const check = (name, cond, detail = '') => { n++; if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name} ${detail}`); };
const bytes = (s) => Array.from(s, (c) => c.charCodeAt(0));

(async () => {
  const { printoutText, printoutLines, printoutTxt, PrintoutReader } = await import('../js/printout.js');

  // ---- the text ----
  const T = (b) => printoutText(b).text;
  check('text: CR, LF and CR LF each end one line', T(bytes('A\rB\nC\r\nD')) === 'A\nB\nC\nD', JSON.stringify(T(bytes('A\rB\nC\r\nD'))));
  check('text: LF CR is two line ends, CR CR LF two', T(bytes('A\n\rB\r\r\nC')) === 'A\n\nB\n\nC');
  check('text: TAB kept; NUL, $FF, ESC, $80 and DEL left out', T([0x00, 0xFF, 0x41, 0x09, 0x1B, 0x80, 0x7F, 0x42]) === 'A\tB');
  check('text: a CR, then a NUL, then LF: two line ends (the LF does not follow the CR)', T([0x41, 13, 0, 10, 0x42]) === 'A\n\nB');
  {
    // read in pieces, a CR LF split across two reads: the same text as read at once
    const all = bytes('LINE ONE\r\nLINE TWO\r\n\tTABBED\r');
    let text = '', afterCR = false;
    for (let cut = 0; cut < all.length;) {
      const next = Math.min(all.length, cut + 3);
      const r = printoutText(all.slice(0, next), cut, afterCR);
      text += r.text; afterCR = r.afterCR; cut = next;
    }
    check('text: read three bytes at a time, it is the text read at once', text === 'LINE ONE\nLINE TWO\n\tTABBED\n', JSON.stringify(text));
  }

  // ---- the line count ----
  check('lines: nothing printed is 0', printoutLines('') === 0);
  check('lines: line ends alone, spaces and TABs are 0 (nothing to see)', printoutLines('\n\n \t\n') === 0);
  check('lines: one line without an end is 1', printoutLines('HELLO') === 1);
  check('lines: a line with its end is 1, and the next unended line 2', printoutLines('HELLO\n') === 1 && printoutLines('HELLO\nWO') === 2);
  check('lines: a blank line between two counts as shown', printoutLines('A\n\nB\n') === 3);

  // ---- the .txt bytes ----
  {
    const b = printoutTxt('TITLE\n\tX\n');
    const want = [0x54, 0x49, 0x54, 0x4C, 0x45, 0x0D, 0x0A, 0x09, 0x58, 0x0D, 0x0A];
    check('txt: CR LF line ends, TAB kept, nothing else added', b.length === want.length && want.every((v, i) => b[i] === v), [...b].join(','));
  }

  // ---- the reader: what is new since the last read ----
  {
    const r = new PrintoutReader(), p = [];
    let got = r.read(p);
    check('reader: an empty printout reads as fresh, nothing added, 0 lines', got.fresh && got.added === '' && r.lines === 0);
    p.push(...bytes('AB\r'));
    got = r.read(p);
    check('reader: new bytes give only their text', !got.fresh && got.added === 'AB\n' && r.lines === 1, JSON.stringify(got));
    p.push(10, ...bytes('CD'));   // the LF of the CR LF, in the next read
    got = r.read(p);
    check('reader: an LF after a CR read last time ends no second line', got.added === 'CD' && r.text === 'AB\nCD' && r.lines === 2, JSON.stringify(r.text));
    got = r.read(p);
    check('reader: nothing new reads as nothing', !got.fresh && got.added === '');
    p.length = 0; p.push(0x5A);
    got = r.read(p);
    check('reader: a cleared printout (shorter) starts over, its new text added', got.fresh && !got.replaced && got.added === 'Z' && r.text === 'Z' && r.lines === 1, JSON.stringify(got));
    {
      // another printout (a snapshot's, another machine's) was printed before: its text is the reader's, but nothing was added
      const r3 = new PrintoutReader(), first = [];
      r3.read(first);
      const restored = bytes('OLD TEXT\r');
      const g = r3.read(restored);
      check('reader: another printout (another array) starts over with its text, and adds nothing', g.fresh && g.replaced && g.added === '' && r3.text === 'OLD TEXT\n' && r3.lines === 1, JSON.stringify(g));
      restored.push(0xFF);
      const g2 = r3.read(restored);
      check('reader: ...a $FF after it adds nothing to see', !g2.fresh && g2.added === '' && r3.lines === 1, JSON.stringify(g2));
      const r4 = new PrintoutReader(), g3 = r4.read(bytes('FIRST'));
      check('reader: a new reader\'s first read is not another printout: its text is added', g3.fresh && !g3.replaced && g3.added === 'FIRST', JSON.stringify(g3));
    }
    const other = [0xFF];
    got = r.read(other);
    check('reader: another printout (another array) starts over; a $FF alone is 0 lines', got.fresh && r.text === '' && r.lines === 0 && !r.visible);
    other.push(0x00, 0x0D);
    r.read(other);
    check('reader: $FF, NUL and a line end still have nothing to see', r.lines === 0 && r.text === '\n');
    // many small reads give the text of one read
    const big = [], r2 = new PrintoutReader();
    let out = '';
    for (let i = 0; i < 400; i++) { big.push(...bytes(`LINE ${i}\r\n`)); out += r2.read(big).added; }
    check('reader: 400 reads add up to the whole text', out === printoutText(big).text && r2.lines === 400, `${r2.lines} lines`);
  }

  // ---- the Session's accessors ----
  {
    const s = new Emu.Session({ store: Emu.memoryStore() });
    s.switchMachine('dragon64');
    const m = s.shownMachine;
    m.printed.length = 0;
    check('Session: nothing printed: 0 lines', s.printoutLines() === 0);
    let threw = null;
    try { s.printoutTextFile(); } catch (e) { threw = e; }
    check('Session: no text file of an empty printout', threw instanceof Emu.SessionError, String(threw));
    m.printed.push(0xFF);   // a Dragon's reset
    threw = null;
    try { s.printoutTextFile(); } catch (e) { threw = e; }
    check('Session: a $FF-only printout is 0 lines and has no text file', s.printoutLines() === 0 && threw instanceof Emu.SessionError);
    check('Session: ...but its raw file has the byte', s.printoutFile().bytes.length === 1 && s.printoutFile().bytes[0] === 0xFF);
    m.printed.push(...bytes('TITLE\r\n\tTAB\r'), 0x00, 0x80);
    const f = s.printoutTextFile();
    check('Session: the text file is <id>-printout.txt', f.name === 'dragon64-printout.txt', f.name);
    check('Session: its bytes are the text as shown, CR LF line ends, no $FF, NUL or $80',
      Buffer.from(f.bytes).toString('latin1') === 'TITLE\r\n\tTAB\r\n', JSON.stringify(Buffer.from(f.bytes).toString('latin1')));
    check('Session: the line count is 2', s.printoutLines() === 2, String(s.printoutLines()));
    const raw = s.printoutFile();
    check('Session: the raw file is <id>-printout.prn, every byte as received', raw.name === 'dragon64-printout.prn'
      && raw.bytes.length === 1 + 12 + 2 && raw.bytes[0] === 0xFF && raw.bytes[raw.bytes.length - 1] === 0x80, `${raw.name} ${raw.bytes.length}`);
    s.clearPrintout();
    check('Session: Clear leaves 0 lines', s.printoutLines() === 0 && s.printoutText() === '');
  }

  console.log(fail ? `${fail} FAILED (of ${n})` : `${n}/${n} printout checks passed`);
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.log('FAIL', e.stack); process.exitCode = 1; });
