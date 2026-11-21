// Settings export and import: a round trip carries every setting into a fresh browser
// profile; ROMs and stored programs never leave and never come back in this way; files that aren't CLOADM
// settings, or are from a newer version, are refused with a message.
const Emu = require('./load')();

let fail = 0;
const check = (name, cond, detail = '') => { if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name} ${detail}`); };
const kvStore = () => { const m = new Map(); return { map: m, get: (k) => m.get(k) ?? null, set: (k, v) => m.set(k, String(v)), remove: (k) => m.delete(k), keys: () => [...m.keys()] }; };
const fake = (size, seed) => { const b = new Uint8Array(size); let x = seed >>> 0; for (let i = 0; i < size; i++) { x = (x * 1103515245 + 12345) >>> 0; b[i] = x >>> 24; } return b; };

(async () => {
  // a profile with settings, ROMs and recent programs
  const st = kvStore(), media = new Emu.MemoryMediaStore();
  const a = new Emu.Session({ store: st, media });
  await a.ready();
  a.switchMachine('coco3', { ram: 128 });
  a.setDisplay({ view: 'sharp', glow: 20, aspect: 'fill' });
  a.switchMachine('dragon64');
  st.set('keyHintDone', '1');
  const rom = fake(0x4000, 7);
  a.addRoms([{ name: 'mine.rom', bytes: rom }]);
  a.load('p.bin', Emu.toBinary(Emu.assemble(' ORG $3000\nL BRA L\n END', '6809')));
  await a.index.flush();

  const exp = a.exportSettings(), text = JSON.stringify(exp);
  check('export: format and version', exp.format === 'cloadm-settings' && exp.version === 1);
  check('export: the settings are there', JSON.parse(exp.settings['config.coco3']).ram === 128 && JSON.parse(exp.settings['display.settings']).view === 'sharp'
    && exp.settings.machine === 'dragon64' && exp.settings.keyHintDone === '1', Object.keys(exp.settings).join());
  // ROMs are excluded: no ROM key, and none of the ROM's bytes in any form
  const romHex = Buffer.from(rom.subarray(0, 32)).toString('hex'), romB64 = Buffer.from(rom.subarray(0, 48)).toString('base64');
  check('export: no ROM keys, no ROM bytes (hex or base64), no stored programs', !Object.keys(exp.settings).some((k) => /^(rom|romdata|romname|media)\./.test(k))
    && !text.includes(romHex) && !text.includes(romB64.slice(0, 40)) && !/recent\/|roms\//.test(text) && !text.includes('mine.rom'));
  check('the store does hold ROM data (so excluding it is a real check)', st.keys().some((k) => /^rom/.test(k)) || (await media.list('')).some((f) => /rom/.test(f.name || f)),
    st.keys().join());

  // into a fresh profile
  const st2 = kvStore(), b = new Emu.Session({ store: st2, media: new Emu.MemoryMediaStore() });
  await b.ready();
  b.switchMachine('coco');
  const r = b.importSettings(text);
  check('import: every exported setting applied, none ignored', r.applied.length === Object.keys(exp.settings).length && !r.ignored.length, JSON.stringify(r));
  check('round trip: export of the imported profile equals the original export', JSON.stringify(b.exportSettings()) === text);
  check('import: the display settings are in force at once', b.display.view === 'sharp' && b.display.glow === 20 && b.display.aspect === 'fill');
  check('import: the machine and its options come back', b.startMachine === 'dragon64' && b.savedConfig('coco3').ram === 128);
  check('import: no ROMs arrive', !b.machinesWithRoms().length && !st2.keys().some((k) => /^rom/.test(k)));

  // only the allowed settings, with valid values, come in (or go out)
  const evil = { format: 'cloadm-settings', version: 1, settings: {
    'romdata.basic': 'AAAA', 'rom.coco.basic': 'x', 'media.x': 'y', glow: 3, ok: 'fine', 'bad key': 'v', 'claude.apiKey': 'sk-ant-secret',
    machine: 'zx81', 'config.coco3': '{"ram":48}', 'config.constructor': '{}', 'config.zx81': '{}', 'config.coco': 'not json',
    'display.settings': '{"view":"tv"}', keyboardMode: 'qwerty', visited: 'yes', keyHintDone: '1', keyboardJoystick: '1', 'config.mc10': '{"ram":4}',
    tapeSound: '0',
  } };
  const r2 = b.importSettings(evil);
  check('import: only allowed settings with valid values are applied (unknown keys, ROM/media keys, an API key, bad values ignored)',
    JSON.stringify(r2.applied.sort()) === JSON.stringify(['config.mc10', 'keyHintDone', 'keyboardJoystick', 'tapeSound']) && r2.ignored.length === Object.keys(evil.settings).length - 4
    && st2.get('romdata.basic') === null && st2.get('ok') === null && st2.get('claude.apiKey') === null && b.savedConfig('coco3').ram === 128 && b.startMachine === 'dragon64', JSON.stringify(r2));
  // and nothing outside the list leaves in an export, even when the store holds it
  st2.set('claude.apiKey', 'sk-ant-secret'); st2.set('somethingElse', '1'); st2.set('machine', 'dragon64');
  const out = JSON.stringify(b.exportSettings());
  check('export: an API key or any other key outside the list never leaves', !/sk-ant|claude\.apiKey|somethingElse/.test(out) && /"keyboardJoystick":"1"/.test(out), out);
  st2.set('config.coco', '{"ram":7}');
  check('export: a stored setting with a bad value is left out', !/"config\.coco"/.test(JSON.stringify(b.exportSettings())));

  // the Claude chat's Anthropic API key (localStorage cloadm.anthropicKey; the page's store adds the cloadm. prefix): never
  // exported, never imported
  {
    const st3 = kvStore(), c = new Emu.Session({ store: st3, media: new Emu.MemoryMediaStore() });
    await c.ready();
    c.switchMachine('coco');
    st3.set('anthropicKey', 'sk-ant-api03-TESTKEY');
    const outText = JSON.stringify(c.exportSettings());
    check('anthropicKey: never exported', !/anthropicKey|sk-ant/.test(outText) && st3.get('anthropicKey') === 'sk-ant-api03-TESTKEY', outText);
    st3.remove('anthropicKey');
    const r3 = c.importSettings({ format: 'cloadm-settings', version: 1, settings: { anthropicKey: 'sk-ant-api03-EVIL', visited: '1' } });
    check('anthropicKey: never imported', st3.get('anthropicKey') === null && r3.ignored.includes('anthropicKey') && r3.applied.join() === 'visited', JSON.stringify(r3));
  }

  // refused files
  const refused = (data, re) => { try { b.importSettings(data); return false; } catch (e) { return e instanceof Emu.SessionError && re.test(e.message); } };
  check('import: not JSON', refused('PK\x03\x04', /not a CLOADM settings file \(not JSON\)/));
  check('import: another JSON file', refused('{"name":"x"}', /not a CLOADM settings file/));
  check('import: a newer version', refused({ format: 'cloadm-settings', version: 2, settings: {} }, /newer CLOADM \(version 2\)/));
  check('import: no settings', refused({ format: 'cloadm-settings', version: 1 }, /no settings/) && refused({ format: 'cloadm-settings', version: 1, settings: [] }, /no settings/));

  console.log(fail ? `${fail} FAILED` : 'all passed');
  process.exitCode = fail ? 1 : 0;
})();
