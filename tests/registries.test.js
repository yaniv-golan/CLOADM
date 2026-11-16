// Names from files and callers are looked up in the registries (machines, families, devices, CPUs, keyboards,
// instruction sets, typed arrays); an inherited name such as "constructor" or "toString" is not an entry
//. Each is refused with the message for an unknown name, never a TypeError.
(async () => {
  let fail = 0;
  const check = (name, cond, detail = '') => { if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name}`); };
  const Emu = require('./load')();
  const zlib = require('zlib');
  const kv = () => { const m = new Map(); return { get: (k) => m.get(k) ?? null, set: (k, v) => m.set(k, v), remove: (k) => m.delete(k), keys: () => [...m.keys()] }; };
  const err = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };
  for (const reg of ['profiles', 'families', 'devices', 'cpus', 'keyboards', 'positionalKeys']) {
    check(`${reg}: inherited names are not entries`, Emu[reg] && Emu[reg].constructor === undefined && Emu[reg].toString === undefined && Emu[reg].__proto__ === undefined);
  }
  const s = new Emu.Session({ store: kv() });
  s.switchMachine('coco');
  const good = JSON.parse(zlib.gunzipSync(Buffer.from((await s.snapshotFile()).bytes)).toString());
  const file = (o) => new Uint8Array(zlib.gzipSync(Buffer.from(JSON.stringify(o))));
  let e = await err(() => s.readSnapshot(file(Object.assign({}, good, { machine: 'constructor' }))));
  check('a snapshot of machine "constructor": the unknown-machine message', e instanceof Emu.SessionError && /doesn't have \(constructor\)/.test(e.message), e && `${e.constructor.name}: ${e.message}`);
  e = await err(() => s.switchMachine('constructor'));
  check('switchMachine("constructor"): falls back like any unknown id', !e && s.machine.id === 'dragon64', e && e.message);
  e = await err(() => Emu.createMachine('toString'));
  check('createMachine("toString"): unknown machine', e && /unknown machine toString/.test(e.message), e && e.message);
  e = await err(() => Emu.state.fromJSON('{"a":{"$typed":"Object","b64":"AAAA"}}'));
  check('state.fromJSON with $typed "Object": a clear error', e && /unknown typed array Object/.test(e.message), e && `${e.constructor.name}: ${e.message}`);
  const m = Emu.createMachine('coco'); m.runFrame();
  const snap = m.snapshot(); snap.state.cartridge = { type: 'toString', state: {} };
  e = await err(() => m.restore(snap));
  check('a snapshot with cartridge type "toString": a clear error', e && /unknown cartridge toString/.test(e.message), e && `${e.constructor.name}: ${e.message}`);
  e = await err(() => Emu.assemble(' NOP\n', 'constructor'));
  check('assemble for CPU "constructor": no instruction set', e && /no instruction set for CPU constructor/.test(e.message), e && e.message);
  // tables main gained since: the cartridge boards and the display settings (names from the page, settings, URLs)
  check('devices: the cartridge boards added to it are entries, inherited names are not', Emu.devices.multi && Emu.devices.orch90 && Emu.devices.constructor === undefined);
  e = await err(() => { s.cartBoard = 'constructor'; });
  check('cartBoard = "constructor": the unknown-board message', e instanceof Emu.SessionError && /unknown cartridge board "constructor"/.test(e.message), e && `${e.constructor.name}: ${e.message}`);
  e = await err(() => s.setDisplay({ constructor: 1 }));
  check('setDisplay({ constructor }): no such display setting', e instanceof Emu.SessionError && /No display setting "constructor"/.test(e.message), e && `${e.constructor.name}: ${e.message}`);
  console.log(fail ? `${fail} FAILED` : 'all passed');
  // set the code and let the loop drain rather than forcing the process down: Node 25.2.1 can deadlock in
  // process.exit(). This is the IIFE's last statement, so there is nothing after it to skip and no return needed.
  process.exitCode = fail ? 1 : 0;
})();
