// Run: node tests/claude-readtools.test.js
//
// The read-only machine tools: machine_info, screen_text, peek. What this
// proves, and why each check is here:
//  * they are the read-only half of the split, and they run WITHOUT consent - the Session's gate asks only
//    for names in ACTING_TOOLS, and none of these is one;
//  * they cannot change the machine, including when handed write-shaped arguments ({address, bytes} to a
//    read tool): the machine's full saved state is byte-identical before and after every call;
//  * peek reads the machine's own memory map (ROM and cartridge as the CPU fetches them), side-effect-free;
//  * machine_info reports the video mode the GIME actually implements on a CoCo 3, from its registers.
const Emu = require('./load')();

let fail = 0, n = 0;
const check = (name, cond, detail = '') => { n++; if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name} ${detail}`); };

const boot = (id, cfg) => { const s = new Emu.Session(); s.switchMachine(id, cfg); for (let i = 0; i < 50; i++) s.advance(1000 / s.machine.fps + 0.01); return s; };
// A target shaped like Session.chatTarget(): the read tools take this, not a Session, so they can be tested
// without a chat.
const targetOf = (s) => {
  const basic = () => s.machine;
  return {
    get machine() { return basic(); },
    show: () => {},
    screenText: () => s.screenText(),
    readByte: (a) => s.readByte(a),
    bootStatus: () => (s.machine.hasRom ? { state: 'ok' } : { state: 'stub' }),
  };
};

// the whole machine, serialised: any change to any chip shows up here
const stateOf = (s) => JSON.stringify(s.machine.saveState());

(async () => {
  // ---- 1. the split: the read-only names, and no acting name among them ----
  check('the read-only set is exactly the read tools',
    JSON.stringify([...Emu.READ_ONLY_TOOLS].sort()) === JSON.stringify(['disassemble', 'machine_info', 'peek', 'screen_text']),
    Emu.READ_ONLY_TOOLS.join(','));
  check('the read-only schemas match the read-only names',
    JSON.stringify(Emu.readOnlyTools().map((t) => t.name).sort()) === JSON.stringify([...Emu.READ_ONLY_TOOLS].sort()));
  // The split is only real if the two sets are complete and disjoint: together they must name every tool the
  // build offers, and no name may sit on both sides. Without this, a tool added to one list alone would be
  // silently ungated (acting) or unreachable (read-only).
  {
    const offered = Emu.machineTools().map((t) => t.name);
    const read = [...Emu.READ_ONLY_TOOLS], acting = [...Emu.ACTING_TOOL_NAMES];
    check('read-only and acting together name every offered tool, once',
      offered.length === read.length + acting.length
      && [...read, ...acting].sort().join() === [...offered].sort().join(),
      `offered ${offered.join(',')} | read ${read.join(',')} | acting ${acting.join(',')}`);
    check('no tool is in both the read-only and the acting set', read.every((n) => !acting.includes(n)));
    // the acting set is derived from the schemas, not restated: a name added to actingTools() is in it
    check('the acting names are exactly the names in actingTools()',
      JSON.stringify(acting) === JSON.stringify(Emu.actingTools().map((t) => t.name)));
  }

  // ---- 1b. every integer parameter is typed "integer" with the range the code actually enforces ----
  // A model reads the schema, not the source. "number" invites a fraction, and a missing range invites an address
  // or a length the tool will reject. The point of this check is the DRIFT: the schema and the call site both
  // come from the named constants, so a change to one bound cannot leave the other stale. It asserts equality
  // against the exported constants, so if someone edits a literal at a call site instead, this fails.
  {
    const tools = Emu.readOnlyTools();
    const byName = (n) => tools.find((t) => t.name === n);
    const props = (n) => byName(n).input_schema.properties;
    const isInt = (p) => p && p.type === 'integer' && Number.isInteger(p.minimum) && Number.isInteger(p.maximum) && typeof p.description === 'string' && p.description.length > 0;
    check('peek: address and length are integers bounded by the exported constants',
      isInt(props('peek').address) && isInt(props('peek').length)
      && props('peek').address.minimum === Emu.ADDRESS_MIN && props('peek').address.maximum === Emu.ADDRESS_MAX
      && props('peek').length.minimum === Emu.PEEK_LENGTH_MIN && props('peek').length.maximum === Emu.PEEK_LENGTH_MAX,
      JSON.stringify(props('peek')));
    check('disassemble: address and count are integers bounded by the exported constants',
      isInt(props('disassemble').address) && isInt(props('disassemble').count)
      && props('disassemble').address.minimum === Emu.ADDRESS_MIN && props('disassemble').address.maximum === Emu.ADDRESS_MAX
      && props('disassemble').count.minimum === Emu.DISASSEMBLE_MIN && props('disassemble').count.maximum === Emu.DISASSEMBLE_MAX,
      JSON.stringify(props('disassemble')));
    // the descriptions state the units: bytes for a length, instructions for a count, the address range
    check('the descriptions state units and the address range',
      /\$0000-\$FFFF/.test(props('peek').address.description) && /bytes/.test(props('peek').length.description)
      && /\$0000-\$FFFF/.test(props('disassemble').address.description) && /instructions/.test(props('disassemble').count.description),
      JSON.stringify([props('peek').address.description, props('peek').length.description]));
    // and the descriptions state the DEFAULT for the optional parameter, from the same constant the call site
    // applies: a model that omits `length`/`count` is told what it will get, and one side cannot go stale alone.
    // The default is a promise made in the schema, so the check below makes the call site honour it.
    check('the optional parameters state their default, from the constant the call site applies',
      new RegExp(`omit for ${Emu.PEEK_DEFAULT_LENGTH}\\b`).test(props('peek').length.description)
      && new RegExp(`omit for ${Emu.DISASSEMBLE_DEFAULT_COUNT}\\b`).test(props('disassemble').count.description),
      JSON.stringify([props('peek').length.description, props('disassemble').count.description]));
    {   // the stated default is the one actually served, with the parameter omitted in each case
      const s = boot('dragon64');
      const t = targetOf(s);
      const noLen = await Emu.runReadOnlyTool(t, 'peek', { address: 0x3000 });
      const noCount = await Emu.runReadOnlyTool(t, 'disassemble', { address: 0x3000 });
      check('omitting the optional parameter serves exactly the stated default',
        noLen.length === Emu.PEEK_DEFAULT_LENGTH && noLen.truncated === false && noCount.count === Emu.DISASSEMBLE_DEFAULT_COUNT,
        JSON.stringify({ peekLength: noLen.length, disassembleCount: noCount.count }));
    }
    // and the enforcement really uses those bounds: a value just outside each is refused, just inside accepted
    const s = boot('dragon64');
    const t = targetOf(s);
    const code = (name, input) => { try { Emu.runReadOnlyTool(t, name, input); return null; } catch (e) { return e.code; } };
    check('the enforced peek bounds match the schema bounds at both ends',
      code('peek', { address: Emu.ADDRESS_MAX + 1 }) === Emu.TOOL_CODES.BAD_ADDRESS
      && code('peek', { address: Emu.ADDRESS_MIN, length: Emu.PEEK_LENGTH_MAX + 1 }) === Emu.TOOL_CODES.BAD_LENGTH
      && code('peek', { address: Emu.ADDRESS_MIN, length: Emu.PEEK_LENGTH_MIN - 1 }) === Emu.TOOL_CODES.BAD_LENGTH);
    check('the enforced disassemble count bounds match the schema bounds at both ends',
      code('disassemble', { address: 0, count: Emu.DISASSEMBLE_MAX + 1 }) === Emu.TOOL_CODES.BAD_COUNT
      && code('disassemble', { address: 0, count: Emu.DISASSEMBLE_MIN - 1 }) === Emu.TOOL_CODES.BAD_COUNT
      && code('disassemble', { address: Emu.ADDRESS_MAX + 1, count: 1 }) === Emu.TOOL_CODES.BAD_ADDRESS);
  }

  // ---- 2. none of them changes the machine, even given write-shaped arguments ----
  // The property is tested by diffing machine state:
  // the full saveState() is compared, not a sample of memory.
  {
    const s = boot('dragon64');
    const t = targetOf(s);
    const writes = [
      ['machine_info', { address: 0x3000, bytes: [0x99], count: 4, text: 'X' }],
      ['screen_text', { address: 0x3000, bytes: [0x99], text: 'X' }],
      ['peek', { address: 0x3000, bytes: [0x99, 0x88], length: 8 }],
      ['disassemble', { address: 0x3000, bytes: [0x99, 0x88], count: 4, text: 'X' }],
      ];
    for (const [name, input] of writes) {
      const before = stateOf(s);
      await Emu.runReadOnlyTool(t, name, input);
      check(`${name}: the machine is byte-identical after the call`, stateOf(s) === before, `${before.length} bytes of state`);
    }
    // and a read of a PIA/ACIA address must not clear a flag: compare those chips' own state too
    const before = stateOf(s);
    await Emu.runReadOnlyTool(t, 'peek', { address: 0xFF00, length: 32 });
    check('peeking the I/O page changes no register', stateOf(s) === before);
    // the cap is stated, not silent: ask for more than PEEK_MAX and the result says so
    const capped = await Emu.runReadOnlyTool(t, 'peek', { address: 0x3000, length: Emu.PEEK_MAX + 100 });
    check('a read over the cap is truncated and says so', capped.truncated === true && capped.length === Emu.PEEK_MAX && capped.max === Emu.PEEK_MAX,
      JSON.stringify({ length: capped.length, truncated: capped.truncated, max: capped.max }));
    // disassembling ACROSS THE I/O PAGE must touch no register either: that is the case a peek that took the
    // bus would fail, so it is the one worth stepping over rather than a quiet RAM address
    const beforeIo = stateOf(s);
    const io = await Emu.runReadOnlyTool(t, 'disassemble', { address: 0xFF00, count: 16 });
    check('disassembling across the I/O page changes no register', stateOf(s) === beforeIo && io.count === 16,
      `count ${io.count}`);
  }

  // ---- 2b. disassemble: the machine's own CPU, from a program this project assembled ----
  // The bytes are assembled by js/asm (the project's own assembler), so the expected mnemonics come from a
  // source written for this test, not from running the disassembler and copying its output.
  {
    const cases = [
      ['dragon64', '6809', ' ORG $3000\nSTART LDA #$12\n STA $4000\n RTS\n', 0x3000, ['LDA #$12', 'STA >$4000', 'RTS']],
      ['mc10', '6803', ' ORG $4100\nSTART LDAA #$12\n STAA $4000\n RTS\n', 0x4100, ['LDAA #$12', 'STAA >$4000', 'RTS']],
    ];
    for (const [id, cpu, src, at, want] of cases) {
      const s = boot(id);
      const r = Emu.assemble(src, cpu);
      if (!r.ok) throw new Error(`assembling the ${cpu} fixture failed: ${JSON.stringify(r.errors)}`);
      for (const seg of r.segments) for (const [i, b] of [...seg.data].entries()) s.machine.poke(seg.addr + i, b);
      const out = await Emu.runReadOnlyTool(targetOf(s), 'disassemble', { address: at, count: 3 });
      check(`disassemble on a ${cpu} machine decodes the assembled program`,
        out.cpu === cpu && JSON.stringify(out.instructions.map((i) => i.text)) === JSON.stringify(want),
        `${out.cpu} ${JSON.stringify(out.instructions.map((i) => i.text))}`);
      check(`disassemble on a ${cpu} machine: the bytes of each instruction are returned with it`,
        out.instructions.every((i) => Array.isArray(i.bytes) && i.bytes.length === i.size && i.size > 0),
        JSON.stringify(out.instructions.map((i) => i.size)));
    }
    // the 6309: its own instruction set, from the machine's config (not from the request)
    const s = boot('dragon64', { cpu: '6309' });
    const r = Emu.assemble(' ORG $3000\nSTART LDQ #$11223344\n AIM #$80,<$10\n', '6309');
    if (!r.ok) throw new Error(`assembling the 6309 fixture failed: ${JSON.stringify(r.errors)}`);
    for (const seg of r.segments) for (const [i, b] of [...seg.data].entries()) s.machine.poke(seg.addr + i, b);
    const out = await Emu.runReadOnlyTool(targetOf(s), 'disassemble', { address: 0x3000, count: 2 });
    check('disassemble on a 6309 machine uses the 6309 instruction set',
      out.cpu === '6309' && JSON.stringify(out.instructions.map((i) => i.text)) === JSON.stringify(['LDQ #$11223344', 'AIM #$80,<$10']),
      `${out.cpu} ${JSON.stringify(out.instructions.map((i) => i.text))}`);
    // The CPU comes from the MACHINE, never from the request. A model that has just read machine_info must not be
    // able to decode one machine's bytes with another's instruction set: the result would misreport every
    // instruction, and it would look authoritative. Pass a conflicting cpu and require the machine's to win, with
    // bytes that really do decode differently (LDQ #$11223344 is one instruction on the 6309, four on the 6809).
    const conflicting = await Emu.runReadOnlyTool(targetOf(s), 'disassemble', { address: 0x3000, count: 2, cpu: '6809' });
    check('a cpu in the REQUEST is ignored: the machine\'s own 6309 set decodes the bytes',
      conflicting.cpu === '6309' && conflicting.instructions[0].text === 'LDQ #$11223344',
      JSON.stringify({ cpu: conflicting.cpu, first: conflicting.instructions[0] && conflicting.instructions[0].text }));
    // and the other way round: a 6809 machine given cpu:'6309' must still decode as a 6809
    const s6809 = boot('dragon64');
    const r6809 = Emu.assemble(' ORG $3000\nSTART LDA #$12\n RTS\n', '6809');
    for (const seg of r6809.segments) for (const [i, b] of [...seg.data].entries()) s6809.machine.poke(seg.addr + i, b);
    const as6309 = await Emu.runReadOnlyTool(targetOf(s6809), 'disassemble', { address: 0x3000, count: 2, cpu: '6309' });
    check('a 6809 machine given cpu:"6309" in the request still decodes as a 6809',
      as6309.cpu === '6809' && as6309.instructions[0].text === 'LDA #$12',
      JSON.stringify({ cpu: as6309.cpu, first: as6309.instructions[0] && as6309.instructions[0].text }));
    // A direct-mode operand is resolved against the MACHINE's own DP, on a 6309 as on a 6809 - the tool uses the
    // same helper the debugger does (codeDisassembly). With DP $40, `LDA <$10` names $4010, not $0010; a tool that
    // worked the DP out itself, or passed 0, would report the wrong address.
    const sDp = boot('dragon64', { cpu: '6309' });
    const rDp = Emu.assemble(' ORG $3000\nSTART LDA <$10\n RTS\n', '6309');
    if (!rDp.ok) throw new Error(`assembling the 6309 DP fixture failed: ${JSON.stringify(rDp.errors)}`);
    for (const seg of rDp.segments) for (const [i, b] of [...seg.data].entries()) sDp.machine.poke(seg.addr + i, b);
    sDp.machine.cpu.dp = 0x40;
    const dpOut = await Emu.runReadOnlyTool(targetOf(sDp), 'disassemble', { address: 0x3000, count: 1 });
    check('disassemble resolves a direct operand against the machine\'s own DP on a 6309',
      dpOut.instructions[0] && dpOut.instructions[0].target === 0x4010,
      JSON.stringify(dpOut.instructions[0]));
  }

  // ---- 2c. disassemble: the cap, and a count of zero ----
  {
    const s = boot('dragon64');
    const t = targetOf(s);
    const atCap = await Emu.runReadOnlyTool(t, 'disassemble', { address: 0, count: Emu.DISASSEMBLE_MAX });
    check('disassemble returns exactly the cap when asked for it', atCap.count === Emu.DISASSEMBLE_MAX && atCap.instructions.length === Emu.DISASSEMBLE_MAX,
      `${atCap.count}`);
    const code = async (input) => { try { await Emu.runReadOnlyTool(t, 'disassemble', input); return null; } catch (e) { return e.code; } };
    check('disassemble over the cap is bad-count, not a silent shorter listing',
      await code({ address: 0, count: Emu.DISASSEMBLE_MAX + 1 }) === Emu.TOOL_CODES.BAD_COUNT);
    check('disassemble with a count of 0 is bad-count', await code({ address: 0, count: 0 }) === Emu.TOOL_CODES.BAD_COUNT);
    // its remedy must be true at both ends, like peek's
    let remedy = null;
    try { await Emu.runReadOnlyTool(t, 'disassemble', { address: 0, count: 999 }); } catch (e) { remedy = e.tool; }
    check('disassemble\'s bad-count remedy names both bounds', remedy && remedy.code === Emu.TOOL_CODES.BAD_COUNT
      && /at least 1/.test(remedy.remedy) && /at most 64/.test(remedy.remedy), JSON.stringify(remedy));
    // the listing runs up the address space and does not wrap: reaching $FFFF stops it, and that is SAID, not
    // silently short (the same rule as the peek cap). At $FFFF there is room for one instruction.
    const top = await Emu.runReadOnlyTool(t, 'disassemble', { address: 0xFFFF, count: 8 });
    check('disassemble at the top of memory stops and says the listing reached the end',
      top.count === 1 && top.truncated === true && /end of the address space/.test(top.reason) && top.instructions.length === 1,
      JSON.stringify({ count: top.count, truncated: top.truncated, reason: top.reason }));
    const normal = await Emu.runReadOnlyTool(t, 'disassemble', { address: 0x3000, count: 8 });
    check('a listing that fits does not claim truncation', normal.count === 8 && normal.truncated === undefined,
      JSON.stringify({ count: normal.count, truncated: normal.truncated }));
    // a direct-page operand's target follows THIS machine's dp, which is what makes the address usable: the text
    // keeps the symbolic <$10, so `target` is the only place the real address appears
    const seg = Emu.assemble(' ORG $3000\n LDA <$10\n', '6809');
    for (const s2 of seg.segments) for (const [i, b] of [...s2.data].entries()) s.machine.poke(s2.addr + i, b);
    s.machine.cpu.dp = 0x42;
    const dpOut = await Emu.runReadOnlyTool(t, 'disassemble', { address: 0x3000, count: 1 });
    check('disassemble resolves a direct-page target with the machine\'s dp',
      dpOut.instructions[0].text === 'LDA <$10' && dpOut.instructions[0].target === 0x4210, JSON.stringify(dpOut.instructions[0]));
  }

  // ---- 3. peek reads the machine's map, not raw RAM ----
  {
    const s = boot('dragon64');
    const t = targetOf(s);
    const rom = s.machine.currentRom ? s.machine.currentRom() : null;
    if (rom) {
      // put something different in the RAM behind the ROM's address, then peek: the ROM must win
      s.machine.ram[0x8000] = 0x00; s.machine.ram[0x8001] = 0x00;
      const p = await Emu.runReadOnlyTool(t, 'peek', { address: 0x8000, length: 2 });
      check('peek at $8000 returns the ROM bytes, not the RAM behind them',
        p.address === 0x8000 && p.length === 2 && p.truncated === false
        && p.bytes[0] === rom[0] && p.bytes[1] === rom[1],
        `${JSON.stringify(p)} (rom ${rom[0].toString(16)} ${rom[1].toString(16)})`);
    }
  }

  // ---- 4. input validation ----
  {
    const s = boot('dragon64');
    const t = targetOf(s);
    // the errors carry a CODE, not just a sentence: a model can branch on the code
    const code = async (name, input) => { try { await Emu.runReadOnlyTool(t, name, input); return null; } catch (e) { return e.code; } };
    check('peek: an address out of range has code bad-address', await code('peek', { address: 70000 }) === Emu.TOOL_CODES.BAD_ADDRESS);
    check('peek: a length running past the end has code past-end', await code('peek', { address: 0xFFFF, length: 2 }) === Emu.TOOL_CODES.PAST_END);
    check('peek: a non-number address has code not-a-number', await code('peek', { address: '3000' }) === Emu.TOOL_CODES.NOT_A_NUMBER);
    check('peek: a length below 1 has code bad-length', await code('peek', { address: 0, length: 0 }) === Emu.TOOL_CODES.BAD_LENGTH);
    check('peek: a length beyond the address space has code bad-length', await code('peek', { address: 0, length: 0x10001 }) === Emu.TOOL_CODES.BAD_LENGTH);
    // asking for more than the cap is NOT an error: it truncates, so no code's remedy is contradicted
    const big = await Emu.runReadOnlyTool(t, 'peek', { address: 0, length: 4096 });
    check('peek: a large length truncates instead of throwing', big.truncated === true && big.length === Emu.PEEK_MAX, JSON.stringify({ l: big.length, t: big.truncated }));
    // the past-end check is on the bytes READ, not the bytes ASKED FOR. At $F800 an over-long request is
    // served by the 256-byte read it truncates to; at $FF00 that read ends exactly at $FFFF. Only a read that
    // still runs past $FFFF after truncation is refused. This is the case the old asked-length check got wrong.
    for (const [addr, len] of [[0xF800, 4096], [0xFF00, 4096]]) {
      let served = null;
      try { served = await Emu.runReadOnlyTool(t, 'peek', { address: addr, length: len }); } catch (e) { served = e.code; }
      check(`peek: $${addr.toString(16).toUpperCase()} + ${len} is served by its truncated read, not refused as past-end`,
        served && served.truncated === true && served.length === Emu.PEEK_MAX && served.address === addr, JSON.stringify(served));
    }
    check('peek: a truncated read that would still run past $FFFF is past-end', await code('peek', { address: 0xFF01, length: 4096 }) === Emu.TOOL_CODES.PAST_END);
    check('an unknown name is a programming error', await (async () => { try { await Emu.runReadOnlyTool(t, 'format_disk', {}); return false; } catch (e) { return /not a read-only tool/.test(e.message); } })());
    // every code has a remedy the model can act on, and the ToolError carries both
    let remedyOk = true;
    try { await Emu.runReadOnlyTool(t, 'peek', { address: 70000 }); } catch (e) {
      remedyOk = e.tool && e.tool.code === Emu.TOOL_CODES.BAD_ADDRESS && /0 to 65535/.test(e.tool.remedy) && e.tool.detail === '70000';
    }
    check('a coded error carries its code, remedy and the offending value', remedyOk);
    // bad-length throws for both ends of its range, so its remedy has to be true at both ends: a length above
    // 65536 is over the address space, not "below 1"
    let upper = null;
    try { await Emu.runReadOnlyTool(t, 'peek', { address: 0, length: 0x10001 }); } catch (e) { upper = e.tool; }
    check('bad-length\'s remedy is true for a length above the address space as well as below 1',
      upper && upper.code === Emu.TOOL_CODES.BAD_LENGTH && /65536/.test(upper.remedy) && !/at least 1 byte/.test(upper.remedy), JSON.stringify(upper));
    // past-end must not read as "just truncate": the cap already does that, and a read past $FFFF cannot be
    // truncated towards anything, so the remedy has to say to start lower
    let pastEnd = null;
    try { await Emu.runReadOnlyTool(t, 'peek', { address: 0xFFF0, length: 0x20 }); } catch (e) { pastEnd = e.tool; }
    check('past-end says to start lower and that reads do not wrap, not to ask for fewer bytes',
      pastEnd && pastEnd.code === Emu.TOOL_CODES.PAST_END && /start at a lower address/.test(pastEnd.remedy)
      && /do not wrap/.test(pastEnd.remedy) && !/fewer bytes/.test(pastEnd.remedy), JSON.stringify(pastEnd));
  }

  // ---- 5. machine_info: the CoCo 3 video mode, from the GIME's own bits ----
  // The GIME meanings this reads (js/chips/gime.js): $FF90 bit 7 LCOM SET = legacy; in native mode $FF98
  // bit 7 HRES SET = bitmap; $FF99 bit 4 H50 and bit 2 wide give the column count.
  {
    const s = boot('coco3');
    const t = targetOf(s);
    const g = s.machine.gime;
    const info = (regs) => { Object.assign(g.regs, regs); return Emu.runReadOnlyTool(t, 'machine_info', {}); };

    g.regs[0] = 0x00; g.regs[8] = 0x00; g.regs[9] = 0x00;   // native text, 32 columns
    const v = async (regs, ff22) => { Object.assign(g.regs, regs); if (ff22 != null) g.ff22 = ff22; return (await info({})).video; };
    let d = await v({ 0: 0x00, 8: 0x00, 9: 0x00 });
    check('coco3 native text 32 columns', d.kind === 'text' && /32 columns/.test(d.mode), JSON.stringify(d));
    d = await v({ 9: 0x04 });
    check('coco3 native text 40 columns', d.kind === 'text' && /40 columns/.test(d.mode), JSON.stringify(d));
    d = await v({ 9: 0x14 });
    check('coco3 native text 80 columns', d.kind === 'text' && /80 columns/.test(d.mode), JSON.stringify(d));
    d = await v({ 8: 0x80, 9: 0x00 });
    check('coco3 native bitmap is graphics, not a text screen', d.kind === 'graphics' && /bitmap/.test(d.mode), JSON.stringify(d));
    d = await v({ 0: 0x80 }, 0x00);
    check('coco3 legacy text', d.kind === 'text' && /legacy/.test(d.mode), JSON.stringify(d));
    d = await v({}, 0x80);
    check('coco3 legacy graphics', d.kind === 'graphics' && /legacy/.test(d.mode), JSON.stringify(d));
  }

  // ---- 5b. machine_info.video.readable agrees with what screen_text does, from ONE rule ----
  // A model should be able to skip screen_text when machine_info already says the screen cannot be read. That is
  // only useful if the two agree, so this does not restate the rule: it calls BOTH tools on each mode and requires
  // `video.readable === true` exactly when screen_text returned a text screen. If the rule is duplicated, one
  // copy drifts and this fails. A graphics mode is readable:false too (no character cells to read), which is why
  // the field is not simply "is a text mode" - `kind` still says text/graphics separately.
  {
    const s = boot('coco3');
    const t = targetOf(s);
    const g = s.machine.gime;
    const cases = [
      ['GIME native text, 32 columns', { 0: 0x00, 8: 0x00, 9: 0x00 }, null],
      ['GIME native text, 80 columns', { 0: 0x00, 8: 0x00, 9: 0x14 }, null],
      ['GIME native bitmap', { 0: 0x00, 8: 0x80, 9: 0x00 }, null],
      ['GIME legacy text', { 0: 0x80 }, 0x00],
      ['GIME legacy graphics', { 0: 0x80 }, 0x80],
    ];
    for (const [label, regs, ff22] of cases) {
      Object.assign(g.regs, regs); if (ff22 != null) g.ff22 = ff22;
      const info = await Emu.runReadOnlyTool(t, 'machine_info', {});
      const scr = await Emu.runReadOnlyTool(t, 'screen_text', {});
      check(`${label}: machine_info.video.readable matches what screen_text did`,
        typeof info.video.readable === 'boolean' && info.video.readable === (scr.text === true),
        JSON.stringify({ readable: info.video.readable, kind: info.video.kind, screenText: scr.text }));
    }
    // and a text mode that cannot be read is still reported as a TEXT mode: the model must not be told there are
    // no characters, only that this reader cannot decode them
    Object.assign(g.regs, { 0: 0x00, 8: 0x00, 9: 0x00 });
    const nativeText = await Emu.runReadOnlyTool(t, 'machine_info', {});
    check('GIME native text: kind is still "text" while readable is false',
      nativeText.video.kind === 'text' && nativeText.video.readable === false, JSON.stringify(nativeText.video));
  }

  // ---- 6. screen_text says so in a graphics mode ----
  {
    const s = boot('coco3');
    const t = targetOf(s);
    s.machine.gime.regs[0] = 0x00; s.machine.gime.regs[8] = 0x80;   // native bitmap
    const out = await Emu.runReadOnlyTool(t, 'screen_text', {});
    check('screen_text reports no text screen in a graphics mode', out.text === false && out.rows === 0 && out.lines.length === 0 && /bitmap/.test(out.mode), JSON.stringify(out));
  }

  // ---- 7. a wide text mode is refused, not misread ----
  // The reader walks a fixed 32-byte row stride (the VDG's own geometry). A CoCo 3 GIME text mode can be 40, 64
  // or 80 columns, where the real stride is wider - so a fixed-stride walk returns ROW 0 again as every later
  // row. Rather than hand back a screen that repeats row 0, the tool declines and names the mode, the same shape
  // and meaning as a graphics mode. The test writes DISTINCT A/B/C rows at the TRUE stride, so a fixed-stride
  // reader would visibly repeat row 0.
  {
    const s = boot('coco3');
    const t = targetOf(s);
    const g = s.machine.gime;
    g.regs[0] = 0x00; g.regs[8] = 0x00; g.regs[9] = 0x14;   // native text, 80 columns
    const base = s.machine.profile.textScreen || 0x400;
    for (let i = 0; i < 80; i++) s.machine.ram[(base + i) & 0xFFFF] = 0x41;        // row 0 'A'
    for (let i = 0; i < 80; i++) s.machine.ram[(base + 80 + i) & 0xFFFF] = 0x42;   // row 1 'B'
    for (let i = 0; i < 80; i++) s.machine.ram[(base + 160 + i) & 0xFFFF] = 0x43;  // row 2 'C'
    const wide = await Emu.runReadOnlyTool(t, 'screen_text', {});
    check('80 columns: the answer declines (no repeated row 0), names the mode and says why',
      wide.text === false && wide.rows === 0 && wide.lines.length === 0 && /80 columns/.test(wide.mode)
      && /cannot be read faithfully/.test(wide.reason || ''),
      JSON.stringify(wide));
    g.regs[9] = 0x00;                                        // 32 columns: still GIME native text, still declined
    const narrow = await Emu.runReadOnlyTool(t, 'screen_text', {});
    check('32 columns in GIME native text: also declined, because that page holds ASCII, not VDG codes',
      narrow.text === false && narrow.rows === 0 && /32 columns/.test(narrow.mode) && /ASCII/.test(narrow.reason || ''),
      JSON.stringify(narrow));
    // atPrompt obeys the SAME readability rule, not merely "is it a text mode": GIME native text IS a text mode,
    // so a guard written as `mode.text === false` would run the OK-line test against rows this reader decodes
    // wrongly and could answer true. The OK row here is in the page AS THIS READER SEES IT (VDG codes), which is
    // exactly the trap: the bytes are not what is on the screen. A booted machine must still answer null.
    {
      const okNative = {
        get machine() { return s.machine; }, show: () => {},
        screenText: () => { const l = new Array(16).fill(' '.repeat(32)); l[0] = 'OK' + ' '.repeat(30); return l; },
        readByte: (a) => s.readByte(a), bootStatus: () => ({ state: 'ok' }),
      };
      const nativeOk = await Emu.runReadOnlyTool(okNative, 'machine_info', {});
      check('GIME native 32-column text: even with OK in the page, atPrompt is null because this reader cannot decode it',
        nativeOk.atPrompt === null && nativeOk.video.kind === 'text' && nativeOk.video.readable === false,
        JSON.stringify({ atPrompt: nativeOk.atPrompt, video: nativeOk.video }));
      check('that same answer never says readable with atPrompt true: the fields of ONE answer agree',
        !(nativeOk.video.readable === true && nativeOk.atPrompt === true), JSON.stringify(nativeOk));
    }
  }

  // ---- 7b. the readability rule itself: every way a mode can be unreadable ----
  // screenReadable is exported and is the ONE rule both tools use, so its contract is tested directly rather than
  // only through the modes videoMode happens to produce today. Each case is a mode shape the rule must refuse, and
  // the last is the only shape it must accept, so deleting any single branch fails here. The width case is the one
  // no current machine reaches - every wide mode today is GIME native, refused a branch earlier - but the rule
  // states the stride limit, and a future readable wide mode must still meet it.
  {
    const R = Emu.screenReadable;
    const gfx = R({ text: false, name: 'MC6847 graphics, 256x192 4-colour' });
    check('screenReadable: a graphics mode is not readable, and the reason says there are no character cells',
      gfx.readable === false && /character cells/.test(gfx.reason || ''), JSON.stringify(gfx));
    const ascii = R({ text: true, readable: false, name: 'GIME native text', reason: 'holds ASCII' });
    check('screenReadable: a text mode flagged unreadable is refused and keeps its own reason',
      ascii.readable === false && ascii.reason === 'holds ASCII', JSON.stringify(ascii));
    const wide = R({ text: true, cols: 40, name: 'wide' });
    check('screenReadable: a text mode wider than the reader can walk is refused, naming both widths',
      wide.readable === false && /40/.test(wide.reason || '') && /32/.test(wide.reason || ''), JSON.stringify(wide));
    const vdg = R({ text: true, cols: 32, name: 'MC6847 text' });
    check('screenReadable: a 32-column text mode IS readable (the one accept, so the rule cannot be "always no")',
      vdg.readable === true, JSON.stringify(vdg));
  }

  // ---- 8. the d64plus Plus display: named, and not read as the VDG page ----
  // The Dragon Plus shows a Hitachi HD6845S display when the person picks it, and this repo has no character-cell
  // reader for it. The tool must name that display and decline, not hand back the VDG text page - which would be
  // a screen the person is not looking at. The screen is switched through the Session's own setter
  // (setDisplay({screen:'plus'}) -> applyScreen -> machine.view), the path the page uses, not by assigning
  // machine.view directly: a test that bypassed the setter would not prove the answer follows what the person did.
  {
    const s = boot('d64plus');
    const t = targetOf(s);
    check('d64plus offers a second screen, so this test is exercising a real one', s.hasTwoScreens === true);
    const vdgInfo = await Emu.runReadOnlyTool(t, 'machine_info', {});
    const vdgScreen = await Emu.runReadOnlyTool(t, 'screen_text', {});
    check('d64plus (screen main): the VDG text screen is read as before', vdgInfo.video.kind === 'text' && vdgScreen.text === true,
      JSON.stringify({ kind: vdgInfo.video.kind, text: vdgScreen.text }));
    s.setDisplay({ screen: 'plus' });
    check('the Plus screen is selected through the setter', s.machine.view === 'plus');
    const info = await Emu.runReadOnlyTool(t, 'machine_info', {});
    const scr = await Emu.runReadOnlyTool(t, 'screen_text', {});
    check('d64plus (screen plus): machine_info names the HD6845S display',
      /HD6845S/.test(info.video.mode) && /Dragon Plus/.test(info.video.mode), JSON.stringify(info.video));
    check('d64plus (screen plus): screen_text declines with the graphics shape, naming the display',
      scr.text === false && scr.rows === 0 && scr.lines.length === 0 && /HD6845S/.test(scr.mode), JSON.stringify(scr));
    s.setDisplay({ screen: 'main' });
    const back = await Emu.runReadOnlyTool(t, 'screen_text', {});
    check('d64plus back on the main screen: the text screen is read again (the answer follows the screen, not a one-way latch)',
      back.text === true && back.cols === 32, JSON.stringify({ text: back.text, mode: back.mode }));
    // atPrompt must not be inferred from the hidden VDG page: on the Plus screen there is no readable text screen
    // to find an OK line on, so the answer is null ("cannot be told"), not a value read off a page nobody sees.
    s.setDisplay({ screen: 'plus' });
    const plusInfo = await Emu.runReadOnlyTool(t, 'machine_info', {});
    check('d64plus on the Plus screen: atPrompt is null, not inferred from the hidden VDG page',
      plusInfo.atPrompt === null, JSON.stringify({ atPrompt: plusInfo.atPrompt }));
    s.setDisplay({ screen: 'main' });
    const mainInfo = await Emu.runReadOnlyTool(t, 'machine_info', {});
    // This machine has no BASIC ROMs, so atPrompt is null on the main screen too (a stub has no prompt) - that is
    // the bootStatus answer, not the screen's. What the Plus case proves is the ORDER: the unreadable screen is
    // checked first and gives null even when bootStatus would have something to say. Assert that directly by
    // making bootStatus say 'ok' through the target, which is what a booted machine looks like to this function.
    check('d64plus on the main screen: atPrompt comes from the bootStatus answer, not the screen', mainInfo.atPrompt === null && mainInfo.video.kind === 'text',
      JSON.stringify({ atPrompt: mainInfo.atPrompt, kind: mainInfo.video.kind }));
    // A booted machine whose screen says OK: this is what makes the ORDER visible. With a readable screen the
    // answer is true; with the unreadable Plus screen it must be null even though bootStatus says 'ok'.
    const okTargetOf = () => ({
      get machine() { return s.machine; }, show: () => {},
      screenText: () => { const l = new Array(16).fill(' '.repeat(32)); l[0] = 'OK' + ' '.repeat(30); return l; },
      readByte: (a) => s.readByte(a), bootStatus: () => ({ state: 'ok' }),
    });
    s.setDisplay({ screen: 'plus' });
    const plusOk = await Emu.runReadOnlyTool(okTargetOf(), 'machine_info', {});
    check('d64plus on the Plus screen: even a booted machine answers atPrompt null, because the screen is unreadable',
      plusOk.atPrompt === null && /HD6845S/.test(plusOk.video.mode), JSON.stringify({ atPrompt: plusOk.atPrompt, mode: plusOk.video.mode }));
    s.setDisplay({ screen: 'main' });
    const mainOk = await Emu.runReadOnlyTool(okTargetOf(), 'machine_info', {});
    check('d64plus back on the main screen with the same booted machine: atPrompt is true again',
      mainOk.atPrompt === true, JSON.stringify({ atPrompt: mainOk.atPrompt }));
  }

  // ---- 8b. the d64plus RAM banks: peek must be the CPU's own view ----
  // D64PlusMachine overrides read/write for the plus board's two 32K banks and a 2K video bank; inheriting the
  // SAM's peek read the WRONG memory. Measured: with a bank selected, CPU read($0100)=AA but
  // peek($0100)=11. The test selects a bank, writes distinct bytes through the CPU's own write, and requires
  // peek to equal read at every address it checks, in BOTH banks and in the video bank, with the machine's
  // state byte-identical either side of the peeks.
  {
    const s = boot('d64plus');
    const t = targetOf(s);
    const m = s.machine;
    const stateOfM = () => JSON.stringify(m.saveState());
    for (const [bank, value] of [[1, 0xAA], [6, 0xBB]]) {          // MAME's $FFE2: 1 = bank A, 6 = bank B
      m.writeBank(bank);
      m.write(0x0100, value);
      m.write(0x4000, value ^ 0xFF);
      check(`d64plus bank ${bank}: peek($0100) is what the CPU reads`, m.peek(0x0100) === m.read(0x0100),
        `cpu ${m.read(0x0100).toString(16)} peek ${m.peek(0x0100).toString(16)}`);
      check(`d64plus bank ${bank}: the two banks really hold different bytes`, m.read(0x0100) === value, `cpu ${m.read(0x0100).toString(16)}`);
      // and the tool reads it the same way, through the Session
      const p = await Emu.runReadOnlyTool(t, 'peek', { address: 0x0100, length: 1 });
      check(`d64plus bank ${bank}: the peek TOOL reports the banked byte`, p.bytes[0] === m.read(0x0100), JSON.stringify(p.bytes));
    }
    // the CRTC page at $FFE0-$FFE2 must be answered without a side effect: read() advances the CRTC, peek does not
    const before = stateOfM();
    const crtc = [m.peek(0xFFE0), m.peek(0xFFE1), m.peek(0xFFE2)];
    check('d64plus: peeking the CRTC page changes no state', stateOfM() === before, JSON.stringify(crtc));
    check('d64plus: peeking the CRTC page answers like a read where the value is knowable without a clock',
      crtc[0] === m.read(0xFFE0), `peek ${crtc[0].toString(16)} read ${m.read(0xFFE0).toString(16)}`);
    // $FFE2 is the display-enable level, which is only ever 0xFF (on) or 0xFE (blanking): a look must return one
    // of those two, not a fabricated or stale-from-somewhere byte
    check('d64plus: peeking the DE port gives one of its two real values', crtc[2] === 0xFF || crtc[2] === 0xFE,
      crtc[2].toString(16));
  }

  // ---- 9. no machine: every read tool says so with the code, not by crashing ----
  // A fresh Session has no machine until switchMachine; a tool called in that state must answer the model with
  // no-machine (and a remedy telling it to open one), not throw a TypeError from reading .config of null.
  {
    const fresh = new Emu.Session();
    check('a fresh Session has no machine', fresh.machine === null);
    const t = targetOf(fresh);
    const code = (name, input) => { try { Emu.runReadOnlyTool(t, name, input); return null; } catch (e) { return e.code; } };
    for (const [name, input] of [['machine_info', {}], ['screen_text', {}], ['peek', { address: 0 }], ['disassemble', { address: 0 }]]) {
      check(`${name} with no machine is no-machine, not a crash`, code(name, input) === Emu.TOOL_CODES.NO_MACHINE, String(code(name, input)));
    }
    let remedy = null;
    try { Emu.runReadOnlyTool(t, 'peek', { address: 0 }); } catch (e) { remedy = e.tool; }
    check('no-machine carries a remedy telling the model to open a machine',
      remedy && /open a machine first/.test(remedy.remedy), JSON.stringify(remedy));
  }

  // ---- 8c. the CoCo 3's moved video base is followed (in legacy text, the readable GIME text mode) ----
  // Session.screenText reads a fixed $400. The GIME moves the text page with $FF9D-$FF9F, so a fixed base reports
  // a screen the person is not looking at. The tool reads from the GIME's own videoBase(). GIME NATIVE text is
  // declined (it holds ASCII, not VDG codes), so the reachable, readable case is LEGACY text - and in that branch
  // it is $FF9E (regs[14]) that moves the base. Distinct bytes at the OLD and the NEW page make a fixed-base read
  // visible: it would return '.' where the real screen has 'Z'.
  {
    const s = boot('coco3');
    const t = targetOf(s);
    const g = s.machine.gime;
    g.regs[0] = 0x80; g.ff22 = 0x00;                         // legacy, and A/G clear: MC6847 text
    g.regs[14] = 0x20;                                       // legacy base = $400 + regs[14]*8 = $500
    for (let i = 0; i < 2; i++) s.advance(1000 / s.machine.fps + 0.01);
    // The two pages must not overlap: a 32x16 screen is $200 bytes, so $400-$5FF and $500-$6FF would share
    // half their bytes and the markers would clobber each other. Put the decoy far away instead.
    for (let i = 0; i < 32 * 16; i++) s.machine.ram[(0x500 + i) & 0xFFFF] = 0x5A;     // real page: 'Z'
    for (let i = 0; i < 32 * 16; i++) s.machine.ram[(0x2000 + i) & 0xFFFF] = 0x2E;    // decoy elsewhere: '.'
    const out = await Emu.runReadOnlyTool(t, 'screen_text', {});
    check('coco3 with the GIME legacy base at $500: the answer reads THAT page, not the fixed $400',
      out.text === true && out.base === 0x500 && out.lines[0] === 'Z'.repeat(32),
      JSON.stringify({ base: out.base, row0: out.lines[0] && out.lines[0].slice(0, 4) }));
    // and back at the power-on base: the answer follows it back (the same decoy is still at $2000, so a read at
    // $400 must NOT see it)
    g.regs[14] = 0x00;
    for (let i = 0; i < 2; i++) s.advance(1000 / s.machine.fps + 0.01);
    for (let i = 0; i < 32 * 16; i++) s.machine.ram[(0x400 + i) & 0xFFFF] = 0x51;     // 'Q' at the base now
    const back = await Emu.runReadOnlyTool(t, 'screen_text', {});
    check('coco3 with the GIME legacy base back at $400: the answer follows it back',
      back.base === 0x400 && back.lines[0] === 'Q'.repeat(32),
      JSON.stringify({ base: back.base, row0: back.lines[0] && back.lines[0].slice(0, 4) }));
  }

  // ---- 8d. a legacy base ABOVE 64K is masked to the 16-bit page the CPU addresses ----
  // videoBase()'s legacy branch adds SAM bits and can exceed 16 bits: at power-on on a 512K CoCo 3 it is
  // 0x70400, because $FF9F (regs[13]) is $E0 and contributes $70000. The reader returns a CPU ADDRESS and reads
  // through the machine's map, so the answer must report $0400 rather than a value no CPU address can hold.
  //
  // This is the test the gate runner's mutation needed: the mask used to be applied twice (once in videoMode and
  // again in textBase), so removing EITHER one alone changed nothing and both survived. There is now one mask,
  // in textBase; removing it makes the first check report 0x70400 and fail.
  //
  // THE PRECONDITION, asserted rather than assumed: `base` is a CPU address, so it is only the page the display
  // shows when the map routes CPU $0400 to physical videoBase(). That holds under the power-on DEFAULT map
  // (physAddr($0400) === 0x70400, the first check below) - but NOT once the MMU is enabled and slot 0 is
  // remapped, where the two part company and this reader would show a different page from the one displayed.
  // The mask is right for the case tested here, and the follow-up report records the MMU case as a known limit
  // rather than something this test pretends to cover.
  {
    const s = boot('coco3');
    const t = targetOf(s);
    const g = s.machine.gime;
    g.regs[0] = 0x80; g.ff22 = 0x00;                         // legacy, A/G clear: MC6847 text
    g.regs[13] = 0xE0; g.regs[14] = 0x00;                    // legacy base = $70000 + $400 = 0x70400
    for (let i = 0; i < 2; i++) s.advance(1000 / s.machine.fps + 0.01);
    const raw = g.videoBase();
    check('the fixture really has a base above 64K, so this test is exercising the mask',
      raw > 0xFFFF, `videoBase() = 0x${raw.toString(16)}`);
    // the precondition: under this (default) map, CPU $0400 IS the displayed page
    check('the mask is meaningful here: the default map routes CPU $0400 to the displayed physical page',
      g.physAddr(0x400) === raw && raw === 0x70400,
      `physAddr(0x400)=0x${g.physAddr(0x400).toString(16)} videoBase=0x${raw.toString(16)}`);
    // write through the machine's own map at the CPU address, which is what a program would do
    for (let i = 0; i < 32 * 16; i++) s.machine.poke(0x400 + i, 0x4B);   // 'K'
    const out = await Emu.runReadOnlyTool(t, 'screen_text', {});
    check('coco3 legacy base 0x70400: the reported base is masked to the 16-bit page ($0400)',
      out.text === true && out.base === 0x400,
      JSON.stringify({ raw: `0x${raw.toString(16)}`, base: out.base == null ? null : `0x${out.base.toString(16)}` }));
    check('coco3 legacy base 0x70400: the rows come from that page (the mask is not just cosmetic)',
      out.lines[0] === 'K'.repeat(32), JSON.stringify({ row0: out.lines[0] && out.lines[0].slice(0, 4) }));
  }

  // ---- 8e. when the MMU moves that page away, decline rather than show a screen nobody is looking at ----
  // The reader returns a CPU ADDRESS and reads through the machine's map; the display reads PHYSICAL memory at
  // videoBase(). 8d above proves those agree under the power-on default map. Turn the MMU on and remap slot 0,
  // and they part company: the display still shows physical 0x70400, while CPU $0400 now lands on physical
  // $000400. Reading on regardless would report a different page from the one on screen - the same defect as
  // on the Plus screen, one layer down - so the mode is declined, naming the two addresses.
  //
  // The fixture puts DIFFERENT letters at the two pages so a wrong answer is visible as well as countable: the
  // display shows 'S', and a reader that ignored the map would return 'T'.
  {
    const s = boot('coco3');
    const t = targetOf(s);
    const g = s.machine.gime;
    const m = s.machine;
    g.regs[0] = 0x80; g.ff22 = 0x00; g.regs[13] = 0xE0; g.regs[14] = 0x00;   // legacy text, base 0x70400
    for (let i = 0; i < 2; i++) s.advance(1000 / m.fps + 0.01);
    // the power-on default map agrees, and the tool reads - the control for the case below
    const before = await Emu.runReadOnlyTool(t, 'screen_text', {});
    check('8e control: under the default map the base is readable and agrees', before.text === true && before.base === 0x400,
      JSON.stringify({ text: before.text, base: before.base }));
    // now move that page: MMU on, CPU slot 0 ($0000-$1FFF) -> RAM block 0 = physical 0x0000
    g.regs[0] |= 0x40; g.mmu[0] = 0; g.mapSlot(0);
    for (let i = 0; i < 512; i++) { g.ram[(0x70400 + i) & 0x7FFFF] = 0x53; g.ram[(0x400 + i) & 0x7FFFF] = 0x54; }
    // state the premise rather than trust it: the display and the CPU address really have diverged
    check('8e fixture: the MMU has moved the page, so the display and CPU $0400 now differ',
      g.physAddr(0x400) !== g.videoBase() && g.physAddr(0x400) === 0x400 && g.videoBase() === 0x70400,
      `physAddr(0x400)=0x${g.physAddr(0x400).toString(16)} videoBase=0x${g.videoBase().toString(16)}`);
    const out = await Emu.runReadOnlyTool(t, 'screen_text', {});
    check('8e: screen_text declines, naming both addresses - the CPU route and the displayed page',
      out.text === false && out.rows === 0 && out.lines.length === 0
      && /MMU/.test(out.reason || '')
      // the two DIFFERENT addresses, in the reason's own order: "routes $0400 to $0400, but the display reads $70400"
      && /\$0400 to \$0400/.test(out.reason || '') && /display reads \$70400/.test(out.reason || ''),
      JSON.stringify(out.reason));
    // the same rule must reach machine_info: readable false, and atPrompt null because the screen cannot be
    // decoded (a machine that answered readable:true here would let a model trust rows that are not on screen)
    const info = await Emu.runReadOnlyTool(t, 'machine_info', {});
    check('8e: machine_info.video.readable is false from the same rule, kind stays text, atPrompt is null',
      info.video.readable === false && info.video.kind === 'text' && info.atPrompt === null,
      JSON.stringify(info));
    // ...and putting the map back makes it readable again: the decline follows the map, not a latch
    g.regs[0] &= ~0x40; g.mapSlot(0);
    const back = await Emu.runReadOnlyTool(t, 'screen_text', {});
    check('8e: with the MMU off again the same page is readable, so the decline follows the map',
      back.text === true && back.base === 0x400, JSON.stringify({ text: back.text, base: back.base }));
    // a page the map sends to ROM is a disagreement too, and physAddr reports it as -1 rather than an address.
    // Without this the `mapped !== raw` test can be weakened to `mapped !== raw && mapped >= 0` and still pass,
    // which would read ROM bytes and call them the screen.
    g.regs[0] |= 0x40; g.mmu[0] = 0x3C; g.mapSlot(0);      // block $3C is cartridge/ROM territory
    const romOut = await Emu.runReadOnlyTool(t, 'screen_text', {});
    check('8e: a base the map routes to ROM is declined too, and the reason says ROM',
      romOut.text === false && /ROM/.test(romOut.reason || '') && /display reads \$70400/.test(romOut.reason || ''),
      JSON.stringify(romOut.reason));
  }

  // ---- 9b. chatTarget().bootStatus() agrees with Session.bootStatus() ----
  // They are two views of ONE machine. The bug: chatTarget's had no bootOk latch and no 'failed' state, so
  // after the watchdog elapsed Session said 'failed' while chatTarget said 'booting' for ever - and once OK
  // scrolled away Session stayed 'ok' (latched) while chatTarget dropped back to 'booting'. Both states are
  // tested here, with a ROM in the socket built by this project that never prints OK.
  {
    const s = new Emu.Session(); s.switchMachine('dragon64');
    const m = s.machine;
    const r = Emu.assemble(' ORG $8000\nSTART BRA START\n ORG $BFFE\n FDB START\n', '6809');
    if (!r.ok) throw new Error(`assembling the F10 fixture failed: ${JSON.stringify(r.errors)}`);
    const rom = new Uint8Array(0x4000);
    for (const seg of r.segments) rom.set(seg.data, seg.addr - 0x8000);
    m.setRoms({ basic: rom, basic64: rom });
    m.reset(true);
    for (let i = 0; i < 60 * 12; i++) s.advance(1000 / s.machine.fps + 0.01);   // past the 5 s watchdog
    const a = s.bootStatus(), b = s.chatTarget().bootStatus();
    check('a ROM that never prints OK: Session says failed, and the chat target agrees',
      a.state === 'failed' && b.state === 'failed' && b.cause === a.cause, JSON.stringify({ session: a.state, target: b.state }));
    // the latch: make OK visible, both say ok; then clear the screen, both must STAY ok. The row is filled with
    // spaces first: bootStatus matches a line that trims to exactly "OK", and $00 decodes to '@', not a space.
    for (let i = 0; i < 32; i++) m.ram[(0x400 + i) & 0xFFFF] = 0x20;
    for (let i = 0; i < 2; i++) m.ram[(0x400 + i) & 0xFFFF] = i === 0 ? 0x4F : 0x4B;   // 'O','K'
    const okA = s.bootStatus(), okB = s.chatTarget().bootStatus();
    check('OK on screen: both say ok', okA.state === 'ok' && okB.state === 'ok', JSON.stringify({ a: okA.state, b: okB.state }));
    for (let i = 0; i < 32 * 16; i++) m.ram[(0x400 + i) & 0xFFFF] = 0x20;             // OK scrolls away
    const latchedA = s.bootStatus(), latchedB = s.chatTarget().bootStatus();
    check('after OK scrolls away: both stay ok (the latch is shared, not lost)',
      latchedA.state === 'ok' && latchedB.state === 'ok', JSON.stringify({ session: latchedA.state, target: latchedB.state }));
    // and the latch must not leak between MACHINES: frameCount and framesSinceReset are per-machine, so a
    // freshly made machine and a BASIC machine at power-on can both compute resetAt = 0. One machine's 'ok' must
    // not satisfy the other's check - this machine never printed OK, so it must not report 'ok'.
    const fresh = Emu.createMachine('dragon64', {});
    const freshRom = new Uint8Array(0x4000);
    for (const sg of r.segments) freshRom.set(sg.data, sg.addr - 0x8000);
    fresh.setRoms({ basic: freshRom, basic64: freshRom });
    fresh.reset(true);                                        // never runs, so never shows OK; framesSinceReset 0
    const freshState = s._bootStatusOf(fresh);
    check('the ok latch does not leak to another machine that shares its reset count',
      freshState.state !== 'ok', JSON.stringify({ state: freshState.state, resetAt: fresh.frameCount - fresh.framesSinceReset }));
  }

  console.log(`\n${n - fail}/${n} read-only tool checks passed`);
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.error('test crashed:', e); process.exitCode = 1; });
