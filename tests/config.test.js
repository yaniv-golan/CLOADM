// URL configuration (js/config.js): every parameter read and checked, options against each model's
// profile.options, errors for bad values (the rest of the link still applies), and links written back
// (buildUrl) that read back to the same configuration.
const Emu = require('./load')();

let fail = 0;
const check = (name, cond, detail = '') => { if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name} ${detail}`); };
const parse = (q, fb) => Emu.parseUrlConfig(q, fb);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// an empty link: nothing set, no errors
{
  const c = parse('');
  check('empty link: nothing set', c.machine === null && same(c.config, {}) && same(c.display, {}) && !c.media.length && !c.roms.length
    && c.start === null && c.app === null && c.joy === null && c.sound === null && c.embed === null && c.storage === null && !c.errors.length);
}

// machine and options, checked against profile.options
{
  const c = parse('?machine=coco3&ram=128&cpu=6809');
  check('machine and its options', c.machine === 'coco3' && same(c.config, { cpu: '6809', ram: 128 }) && !c.errors.length, JSON.stringify(c));
  const bad = parse('?machine=coco3&ram=48');
  check('a RAM size the model does not have: error naming the sizes, option left out', !('ram' in bad.config)
    && /ram=48: the CoCo 3 has 128K or 512K/.test(bad.errors[0]), bad.errors.join());
  const unknown = parse('?machine=zx81&ram=64');
  check('an unknown machine: error, and options checked against the fallback machine', unknown.machine === null
    && /machine=zx81: no such machine/.test(unknown.errors[0]) && unknown.config.ram === 64, unknown.errors.join());
  const fb = parse('?ram=512', 'coco3');
  const bk = parse('?machine=coco&becker=1');
  check('a yes/no option: 1/0 or true/false', bk.config.becker === true && parse('?machine=coco&becker=true').config.becker === true
    && parse('?machine=coco&becker=false').config.becker === false && parse('?machine=coco&becker=0').config.becker === false
    && /becker=maybe/.test(parse('?machine=coco&becker=maybe').errors[0]), JSON.stringify(bk.config));
  check('buildUrl writes a yes/no option as 1/0', Emu.buildUrl('https://cloadm.dev/play/', { machine: 'coco', config: { becker: true } }) === 'https://cloadm.dev/play/?machine=coco&becker=1');
  check('options without machine= are checked against the fallback (the machine in use)', fb.config.ram === 512 && !fb.errors.length);
  const other = parse('?machine=dragon64&ram=32');
  check('an option value of another model: error', /ram=32: the Dragon 64 has 64K/.test(other.errors[0]) && !('ram' in other.config), other.errors.join());
  // every model's every option value reads back
  let all = true;
  for (const [id, p] of Object.entries(Emu.profiles)) {
    for (const [k, o] of Object.entries(p.options)) for (const v of o.values) {
      const r = parse(`?machine=${id}&${k}=${v}`);
      if (r.config[k] !== v || r.errors.length) { all = false; console.log(`  ${id} ${k}=${v}: ${JSON.stringify(r)}`); }
    }
  }
  check('every option value of every model reads back, no errors', all);
}

// programs, tapes and cartridges by URL; autorun; ROMs
{
  const c = parse('?load=https://example.org/games/demo.bin&tape=tapes/game.cas&cart=/c/pak.ccc&autorun&rom=https://example.org/bas12.rom&rom=r2.rom&selftest=1');
  check('media in order, with their kinds', same(c.media, [{ kind: 'load', url: 'https://example.org/games/demo.bin' }, { kind: 'tape', url: 'tapes/game.cas' }, { kind: 'cart', url: '/c/pak.ccc' }]), JSON.stringify(c.media));
  check('autorun present without a value is on; ROMs repeat; selftest', c.autorun === true && same(c.roms, ['https://example.org/bas12.rom', 'r2.rom']) && c.selftest === true && !c.errors.length);
  check('autorun=0 is off', parse('?autorun=0').autorun === false);
  check('autorun=maybe: error', /autorun=maybe: 1 or 0/.test(parse('?autorun=maybe').errors[0]));
  check('an empty media link: error', /tape=: not a link/.test(parse('?tape=').errors[0]));
  check('start=welcome and liza; anything else is an error', parse('?start=welcome').start === 'welcome' && parse('?start=liza').start === 'liza'
    && parse('?start=game').start === null && /start=game/.test(parse('?start=game').errors[0]));
  check('app=claude; anything else is an error', parse('?app=claude').app === 'claude' && !parse('?app=claude').errors.length
    && parse('?app=chat').app === null && /app=chat: claude/.test(parse('?app=chat').errors[0]));
}

// display, input, sound, speed, embed, storage
{
  const c = parse('?display=sharp&phase=2&aspect=fill&integer=1&curvature=0&glow=100&joy=mouse&sound=0&fasttape=1&turbo=1&embed=1&storage=fallback');
  check('display settings map to the Display tab keys', same(c.display, { view: 'sharp', phase: 2, aspect: 'fill', integer: true, curvature: 0, glow: 100 }), JSON.stringify(c.display));
  check('joy, sound, fast tape, turbo, embed, storage', c.joy === 'mouse' && c.sound === false && c.fastTape === true && c.turbo === true
    && c.embed === true && c.storage === 'fallback' && !c.errors.length);
  // the OTHER value each of those two accepts. joy=mouse and storage=fallback above were the only ones exercised
  // from a URL; a parser that only ever saw the first of a pair can still pass every other case here.
  const others = parse('?joy=off&storage=fsa');
  check('joy=off and storage=fsa parse as the other accepted value, not an error',
    others.joy === 'off' && others.storage === 'fsa' && !others.errors.length, JSON.stringify({ joy: others.joy, storage: others.storage, errors: others.errors }));
  // every display value DISPLAY_DEFAULTS accepts, through the link
  const s = new Emu.Session();
  s.switchMachine('coco');
  s.setDisplay(parse('?display=crt&phase=1&aspect=4:3&integer=0&curvature=35&glow=55').display);
  check('the display values the Session accepts', same(Object.assign({}, s.display), Object.assign({}, Emu.DISPLAY_DEFAULTS)));
  const bad = parse('?display=tv&phase=3&aspect=16:9&integer=yes&curvature=101&glow=-1&joy=keys&sound=loud&storage=cloud');
  check('every bad value is an error and is left out', bad.errors.length === 9 && same(bad.display, {}) && bad.joy === null && bad.sound === null && bad.storage === null,
    bad.errors.join(' | '));
  check('a fraction is not a whole number', /curvature=3\.5/.test(parse('?curvature=3.5').errors[0]));
}

// parameters that aren't settings
{
  const c = parse('?machine=dragon64&utm_source=x&ram=64');
  check('an unknown parameter is reported and ignored', c.errors.length === 1 && /utm_source: not a CLOADM setting/.test(c.errors[0]) && c.config.ram === 64);
  const o = parse('?machine=mc10&cpu=6809');
  check('a CPU the model does not have: error naming its CPU', /cpu=6809: the MC-10 has 6803/.test(o.errors[0]) && o.config.cpu === undefined, o.errors.join());
}

// buildUrl writes links that read back the same
{
  const cfgs = [
    { machine: 'coco3', config: { cpu: '6809', ram: 512 } },
    { machine: 'dragon32', config: {}, app: 'claude' },
    { machine: 'dragon64', config: { cpu: '6809', ram: 64 }, start: 'liza', display: { view: 'sharp', phase: 2, aspect: 'fill', integer: true, curvature: 10, glow: 90 } },
    { machine: 'coco', config: {}, media: [{ kind: 'tape', url: 'https://example.org/a b.cas' }, { kind: 'load', url: 'demo.bin' }], autorun: true, roms: ['https://x.org/bas12.rom'],
      joy: 'mouse', sound: false, fastTape: false, turbo: true, embed: true, selftest: true, storage: 'opfs' },
  ];
  for (const cfg of cfgs) {
    const url = Emu.buildUrl('https://cloadm.dev/play/', cfg), back = parse(new URL(url).search);
    const pick = (o) => Object.fromEntries(Object.keys(cfg).map((k) => [k, o[k]]));
    check(`buildUrl round trip: ${url}`, same(pick(back), cfg) && !back.errors.length, JSON.stringify(pick(back)));
  }
  check('links point at /play, parameters in a fixed order', Emu.buildUrl('https://cloadm.dev/play/', { machine: 'coco3', config: { ram: 128, cpu: '6809' } }) === 'https://cloadm.dev/play/?machine=coco3&cpu=6809&ram=128');
  const s = new Emu.Session();
  s.switchMachine('coco3', { ram: 128 });
  check('Session.shareUrl: the machine and its options, written by buildUrl', s.shareUrl('https://cloadm.dev/play/?x=1#y') === 'https://cloadm.dev/play/?machine=coco3&cpu=6809&ram=128&becker=0&ssc=none#y', s.shareUrl('https://cloadm.dev/play/?x=1#y'));
}

// a link's display settings are not stored
{
  const store = new Map();
  const kv = { get: (k) => store.get(k) ?? null, set: (k, v) => store.set(k, v), remove: (k) => store.delete(k), keys: () => [...store.keys()] };
  const s = new Emu.Session({ store: kv });
  s.switchMachine('coco');
  s.setDisplay({ view: 'sharp' }, { remember: false });
  check('setDisplay(remember: false): in force, not stored', s.display.view === 'sharp' && !store.has('display.settings'));
  s.setDisplay({ glow: 10 });
  check('setDisplay: stored', JSON.parse(store.get('display.settings')).glow === 10);
}

console.log(fail ? `${fail} FAILED` : 'all passed');
process.exitCode = fail ? 1 : 0;
