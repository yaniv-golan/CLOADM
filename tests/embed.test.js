// The embed API (js/embed-api.js) on a Session, through its message protocol: calls answered by id, errors as
// messages (never thrown at the page), events for machine changes, loads and resets, frame events only when asked.
const fs = require('fs');
const path = require('path');
const Emu = require('./load')();

let fail = 0;
const check = (name, cond, detail = '') => { if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name} ${detail}`); };

const s = new Emu.Session();
s.switchMachine('dragon64');
const sent = [];
const api = new Emu.EmbedApi(s, (m) => sent.push(m));
let id = 0;
const call = (method, ...args) => api.handle({ cloadm: 1, id: ++id, method, args });
const frames = (n) => { for (let i = 0; i < n; i++) s.advance(1000 / s.machine.fps + 0.01); };

// info, and a reply for every call, by id
{
  const r = call('info');
  check('info: machine, name, options, ROMs, frame', r.id === id && r.result.machine === 'dragon64' && r.result.name === 'Dragon 64'
    && JSON.stringify(r.result.config) === '{"cpu":"6809","ram":64,"hires":"none"}' && r.result.roms === false && Number.isInteger(r.result.frame), JSON.stringify(r));
  check('the reply is also sent to the host', sent[sent.length - 1] === r);
  check('not a CLOADM call: no reply', api.handle({ hello: 1 }) === null && api.handle({ cloadm: 1, method: 'info' }) === null && api.handle(null) === null);
  const bad = call('format');
  check('an unknown method: an error reply', bad.error === 'no method "format"' && !('result' in bad));
}

// running a program and reading the screen and memory
{
  const prog = Emu.toBinary(Emu.assemble(' ORG $3000\n LDA #$41\n STA $0400\n LDA #$7E\n STA $3100\nL BRA L\n END', '6809'));
  sent.length = 0;
  const r = call('load', 'p.bin', [...prog]);
  frames(2);
  check('load: bytes as an array of numbers, runs', /binary/.test(r.result) && s.machine.ram[0x400] === 0x41, r.result || r.error);
  check('load sends a "loaded" event with the info', sent.some((m) => m.event === 'loaded' && m.data.machine === 'dragon64'));
  const u8 = call('load', 'p.bin', prog);
  check('load: a Uint8Array too', !u8.error);
  frames(2);
  check('peek: one byte, and several', JSON.stringify(call('peek', 0x400).result) === '[65]' && JSON.stringify(call('peek', 0x3100, 1).result) === '[126]'
    && call('peek', 0x3000, 4).result.length === 4);
  s.machine.setRoms({ basic: new Uint8Array(0x4000).fill(0x39) });
  check('peek: refused while the user\'s ROMs are loaded (memory can hold ROM code)', /not available while the machine runs your own ROMs/.test(call('peek', 0x400).error)
    && !('result' in call('peek', 0x400)));
  s.machine.setRoms({ basic: null });
  check('peek: allowed again on the built-in stub', JSON.stringify(call('peek', 0x400).result) === '[65]');
  {
    const c = new Emu.Session();
    c.switchMachine('coco');
    c.load('pak.ccc', new Uint8Array(0x2000).fill(0x12));
    const capi = new Emu.EmbedApi(c, () => {});
    check('peek: refused while a cartridge is plugged in', /a cartridge is plugged in/.test(capi.handle({ cloadm: 1, id: 1, method: 'peek', args: [0xC000] }).error));
  }
  check('poke: bytes written, read back', call('poke', 0x5000, [1, 2, 3]).result === 3 && JSON.stringify(call('peek', 0x5000, 3).result) === '[1,2,3]');
  check('poke: a single number', call('poke', 0x5010, 0x1FF).result === 1 && s.machine.ram[0x5010] === 0xFF);
  check('peek/poke: addresses checked', /not an address/.test(call('peek', 70000).error) && /not an address/.test(call('poke', -1, [1]).error)
    && /runs past 65535/.test(call('peek', 0xFFFF, 2).error) && /fit below 65536/.test(call('poke', 0xFFFF, [1, 2]).error));
  check('load: bad arguments are an error reply', /file name and its bytes/.test(call('load', 'x').error) && /file name and its bytes/.test(call('load', 5, [1]).error));
  check('load: a file the machine cannot use is an error reply', /BASIC listing needs/.test(call('load', 'p.bas', [...Buffer.from('10 PRINT 1\n')]).error), call('load', 'p.bas', [...Buffer.from('10 PRINT 1\n')]).error);
}

// typing into LIZA, reading the screen
{
  s.load('liza.bin', new Uint8Array(fs.readFileSync(path.join(__dirname, '../examples/liza.bin'))), { remember: false });
  frames(60);
  check('type: returns the number of characters', call('type', 'I AM HAPPY\n').result === 11);
  frames(120);
  const screen = call('screenText').result;
  check('screenText: what LIZA answered', screen.some((l) => l.includes('> I AM HAPPY')), screen.join('|'));
  check('type: text must be a string', /must be a string/.test(call('type', 42).error));
}

// machines, resets and their events
{
  sent.length = 0;
  const r = call('switchMachine', 'coco3', { ram: 128 });
  check('switchMachine: another model with options', r.result.machine === 'coco3' && r.result.config.ram === 128 && s.machine.id === 'coco3');
  check('switchMachine sends a "machine" event', sent.some((m) => m.event === 'machine' && m.data.machine === 'coco3'));
  check('switchMachine: options checked against profile.options', /ram on the CoCo 3 is 128 or 512/.test(call('switchMachine', 'coco3', { ram: 64 }).error)
    && /no option "turbo"/.test(call('switchMachine', 'coco', { turbo: 1 }).error) && /no machine "c64"/.test(call('switchMachine', 'c64').error));
  sent.length = 0;
  call('reset');
  call('powerCycle');
  check('reset and power cycle: "reset" events', sent.filter((m) => m.event === 'reset').length === 2, sent.map((m) => m.event).join());
  const d = call('setDisplay', { view: 'sharp' });
  check('setDisplay: in force for this page', d.result.view === 'sharp' && s.display.view === 'sharp');
  check('setDisplay: a bad value is an error reply', /not a valid value/.test(call('setDisplay', { view: 'tv' }).error));
}

// frame events only when watched
{
  sent.length = 0;
  frames(3); api.frame();
  check('no frame events until watched', !sent.some((m) => m.event === 'frame'));
  call('watchFrames', true);
  const f0 = s.machine.frameCount;
  api.frame();
  const ev = sent.find((m) => m.event === 'frame');
  check('frame events once watched, with the frame number', ev && ev.data.frame === f0);
  call('watchFrames', false); sent.length = 0; api.frame();
  check('watchFrames(false) stops them', !sent.length);
}

// tapes
{
  s.switchMachine('dragon64');
  const r = call('insertTape', 'x.cas', [0x55, 0x55, 0x3C, 0x00, 0x00, 0x00]);
  check('insertTape: a tape in the deck', !r.error && s.machine.deck.tape && s.machine.deck.tape.name === 'x.cas', r.error || r.result);
  check('insertTape: bad arguments', /file name and its bytes/.test(call('insertTape', 'x.cas').error));
}

console.log(fail ? `${fail} FAILED` : 'all passed');
process.exitCode = fail ? 1 : 0;
