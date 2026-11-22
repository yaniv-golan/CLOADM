// What a first-time visitor without the docs meets, the Session's and the firmware's part (the page's part is the
// browser check's "first use" checks, run with the uiCopy group):
//  - the welcome menu's prompt names the menu's own range: "PRESS 1 TO N", N the highest option listed, on every build,
//    greeting, with and without the carry-on line, and after a visit to the games menu and back;
//  - a machine-code tape the drop loads and starts says where it went and where it started, and the deck says so
//    (tapeStatus started) until the tape moves on, is rewound or another goes in; nothing else of the machine changes;
//  - the install steps: Safari on a Mac has its own line, iOS its Share step;
//  - the Help page's "Claude: getting an API key": where, what it costs, and Claude without a key.
// Expected texts are the design's, written here, not read from the code under test.
// Run: node tests/first-use.test.js
const fs = require('fs'), path = require('path');
const Emu = require('./load')();

let n = 0, fail = 0;
const check = (name, cond, detail = '') => { n++; if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name} ${detail}`); };
const ROOT = path.join(__dirname, '..');
const read = (f) => new Uint8Array(fs.readFileSync(path.join(ROOT, 'examples', f)));
const frames = (s, k) => { for (let i = 0; i < k; i++) s.advance(1000 / s.shownMachine.fps + 0.01); };

// ---- the welcome prompt: its range is the menu's ----
{
  // the options listed: rows that read "<digit> <TEXT>" in the menu's area (rows 6-13)
  const listed = (t) => t.slice(6, 14).map((l) => /^\s{2,}(\d) [A-Z]/.exec(l)).filter(Boolean).map((m) => Number(m[1]));
  for (const [id, file] of [['dragon64', 'welcome.bin'], ['coco', 'welcome.bin'], ['coco3', 'welcome.bin'], ['mc10', 'welcome6803-mc10.bin'], ['alice', 'welcome6803-alice.bin']]) {
    const s = new Emu.Session({ welcomeMenu: false });
    s.switchMachine(id, undefined, { menu: false });
    for (const greeting of ['first', 'back', 'bye']) {
      for (const carryOn of [null, 'LIZA', 'MINESWEEPER']) {
        s.startWelcome(read(file), { greeting, carryOn });
        frames(s, 50);
        let t = s.screenText(), opts = listed(t);
        const want = `PRESS 1 TO ${Math.max(...opts)}`;
        check(`${id} ${greeting}${carryOn ? ` carry-on ${carryOn}` : ''}: the options are 1 to N in order, the prompt says "${want}"`,
          opts.every((v, i) => v === i + 1) && t[14].trim() === want
          && (!carryOn || t.slice(6, 14).some((l) => new RegExp(`^\\s+${Math.max(...opts)} CARRY ON WITH `).test(l))),
          JSON.stringify(t.slice(6, 15)));
        if (file === 'welcome.bin') {   // (the 6809 build has the games menu)
          // the games menu and back (0): the main menu again, its prompt still its range
          s.shownMachine.stubKeys.push(0x35); frames(s, 5);
          s.shownMachine.stubKeys.push(0x30); frames(s, 5);
          t = s.screenText(); opts = listed(t);
          check(`${id} ${greeting}${carryOn ? ` carry-on ${carryOn}` : ''}: back from the games menu, "PRESS 1 TO ${Math.max(...opts)}"`,
            opts.every((v, i) => v === i + 1) && t[14].trim() === `PRESS 1 TO ${Math.max(...opts)}`, JSON.stringify(t.slice(6, 15)));
        }
      }
    }
  }
}

// ---- a machine-code tape that loads and starts ----
{
  const block = (type, data) => { let sum = (type + data.length) & 0xFF; for (const v of data) sum = (sum + v) & 0xFF; return [0x55, 0x3C, type, data.length, ...data, sum]; };
  const code = [0x20, 0xFE, ...Array(254).fill(0x12)];   // BRA * at $3000, then 254 NOPs: $3000-$30FF
  const name = (n, type) => [...Buffer.from(n.padEnd(8)), type, 0, 0, 0x30, 0x00, 0x30, 0x00];
  // a second file after the first (a multi-part tape: the rest stays in the deck)
  const cas = new Uint8Array([...Array(128).fill(0x55), ...block(0, name('HI', 2)), ...Array(64).fill(0x55), ...block(1, code.slice(0, 255)), ...block(1, code.slice(255)), ...block(0xFF, []),
    ...Array(128).fill(0x55), ...block(0, name('MORE', 2)), ...Array(64).fill(0x55), ...block(1, [1, 2, 3]), ...block(0xFF, [])]);
  const s = new Emu.Session({ welcomeMenu: false });
  s.switchMachine('dragon64', undefined, { menu: false });
  const before = s.shownMachine.ram.slice();
  const msg = s.load('HI.CAS', cas, { remember: false });
  check('the message: "HI.CAS loaded ($3000–$30FF) and started at $3000."', msg === 'HI.CAS loaded ($3000–$30FF) and started at $3000.', msg);
  const m = s.shownMachine;
  check('...and the program is there and running', code.every((v, i) => m.ram[0x3000 + i] === v) && m.cpu.pc === 0x3000);
  frames(s, 2);
  const st = s.tapeStatus();
  check('the deck: started is the exec address while the tape stands where the load left it', st && st.started === 0x3000 && !st.motor, JSON.stringify(st));
  // the message is about the load, not more: outside the program, the stack and the stub's own work area, RAM is as it was
  const changed = [];
  for (let a = 0x0000; a < 0x8000; a++) if (m.ram[a] !== before[a] && !(a >= 0x3000 && a <= 0x30FF) && a >= 0x0800) changed.push(a);
  check('nothing else of the machine\'s memory above $0800 changes', !changed.length, changed.slice(0, 8).map((a) => a.toString(16)).join(','));
  // the motor running (the program reading the rest) ends it
  m.deck.motor = true;
  const moving = s.tapeStatus();
  m.deck.motor = false;
  check('the motor running ends it', moving.started === null && s.tapeStatus().started === null, JSON.stringify({ moving: moving.started }));
  // rewound, or another tape: none
  s.load('HI.CAS', cas, { remember: false });
  check('...again after a new load', s.tapeStatus().started === 0x3000);
  s.rewindTape();
  check('rewinding ends it', s.tapeStatus().started === null);
  s.load('HI.CAS', cas, { remember: false });
  s.insertTape('OTHER.CAS', cas);
  check('another tape in the deck ends it', s.tapeStatus().started === null);
  // a BASIC tape is not "started" (it needs RUN): no started, and its own words
  const basic = new Uint8Array([...Array(128).fill(0x55), ...block(0, [...Buffer.from('PROG    '), 0, 0, 0, 0, 0, 0, 0]), ...Array(64).fill(0x55), ...block(1, [0, 0, 0]), ...block(0xFF, [])]);
  let bm = '';
  try { bm = s.load('PROG.CAS', basic, { remember: false }); } catch (e) { bm = e.message; }
  check('a BASIC tape is not said to have started, and the deck says nothing of it', !/started at/.test(bm) && s.tapeStatus().started === null, bm);
}

// ---- install: Safari on a Mac, iOS ----
(async () => {
  const I = await import('../js/ui/install.js').catch(() => null);
  if (I) {
    const mac = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15';
    check('Safari on a Mac: "In Safari: File → Add to Dock."', I.STEPS[I.platformOf(mac, false)] === 'In Safari: File → Add to Dock.', I.platformOf(mac, false));
    check('iOS: "Tap Share, then “Add to Home Screen”."', I.STEPS[I.platformOf('iPhone', true)] === 'Tap Share, then “Add to Home Screen”.', I.STEPS[I.platformOf('iPhone', true)]);
  }

  // ---- the Help page's "Claude: getting an API key" ----
  const help = fs.readFileSync(path.join(ROOT, 'help', 'index.html'), 'utf8');
  const sec = /<section[^>]*aria-labelledby="claude-key">([\s\S]*?)<\/section>/.exec(help);
  const body = sec ? sec[1] : '';
  check('Help has a "Claude: getting an API key" section', /<h2 id="claude-key">Claude: getting an API key<\/h2>/.test(body));
  check('...with where (console.anthropic.com, API keys)', /href="https:\/\/console\.anthropic\.com\/[^"]*">console\.anthropic\.com<\/a>, under <em>API keys<\/em>/.test(body));
  check('...what it costs (billed to the Anthropic account, the pricing page) and no figures', /billed to your Anthropic account/.test(body) && /href="https:\/\/www\.anthropic\.com\/pricing[^"]*"/.test(body) && !/\$\s?\d|\d+\s?(USD|cents?)/.test(body));
  check('...and Claude without a key (Use with Claude)', /No key\?.*Use CLOADM inside Claude instead.*href="[^"]*docs\/mcp\.md#use-with-claude"/s.test(body));
  check('Help\'s install section has Safari on a Mac and iOS Safari\'s Share step', /Safari on a Mac\.<\/strong> <span>In Safari: <em>File → Add to Dock<\/em>/.test(help) && help.includes('<div><strong>iOS Safari.</strong> <span>Tap <em>Share</em> (the square with an arrow), scroll down and choose\n      <em>Add to Home Screen</em>, then <em>Add</em>.</span></div>'));

  console.log(fail ? `${fail} of ${n} FAILED` : `all ${n} passed`);
  process.exitCode = fail ? 1 : 0;
})();
