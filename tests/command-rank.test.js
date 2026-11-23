// The command box's matching (js/ui/command-box.js rankCommands): word starts in the label beat the extra words, which
// beat a word one edit from a word's start (4 letters or more, its first letter kept); ties keep the list's order;
// "Switch to <model>" rows only when a word names the model, otherwise the one "Switch machine…" row; the matched
// parts of the label for <mark>. Expected rows are written out here, from the ruling's queries.
// Run: node tests/command-rank.test.js
let fail = 0;
const check = (name, cond, detail = '') => { if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name} ${detail}`); };

(async () => {
  const { COMMANDS, rankCommands, switchCommands, MAX_ROWS } = await import('../js/ui/command-box.js');
  const { availableProfiles } = await import('../js/machines/profiles.js');
  // the commands a page with no tape and no disk lists (those two kinds say when they are listed)
  const tape = (on) => COMMANDS.filter((c) => !c[5] || (on ? c[5].name === 'hasTape' : false));
  const all = (running = 'dragon64', withTape = false) => tape(withTape).concat(switchCommands(availableProfiles(), running));
  const top = (q, opts) => rankCommands(all(...(opts || [])), q).slice(0, MAX_ROWS).map((r) => r.c[0]);

  check('MAX_ROWS is 8', MAX_ROWS === 8);
  check('"rset" -> Reset first', top('rset')[0] === 'Reset', JSON.stringify(top('rset')));
  check('"setings" -> a Settings command first', /settings$/i.test(top('setings')[0]), JSON.stringify(top('setings')));
  check('"setin" -> a Settings command first', /settings$/i.test(top('setin')[0]), JSON.stringify(top('setin')));
  check('"coco 3" -> Switch to CoCo 3 first', top('coco 3')[0] === 'Switch to CoCo 3', JSON.stringify(top('coco 3')));
  // (then "LZ Color64": "coco" is one edit from "colo", so it comes after them)
  check('"switch to coco" -> the CoCo models first, no "Switch machine…"', JSON.stringify(top('switch to coco')) === JSON.stringify(['Switch to CoCo 1/2', 'Switch to CoCo 2B', 'Switch to CoCo 3', 'Switch to CoCo 3 (PAL)', 'Switch to LZ Color64']),
    JSON.stringify(top('switch to coco')));
  check('"help" -> Help first', top('help')[0] === 'Help', JSON.stringify(top('help')));
  check('"guide" and "how" find Help (its other words)', top('guide')[0] === 'Help' && top('how')[0] === 'Help');
  check('"delete rom" -> Your ROMs first', top('delete rom')[0] === 'Your ROMs', JSON.stringify(top('delete rom')));
  check('"forget" and "remove rom" find Your ROMs', top('forget').includes('Your ROMs') && top('remove rom')[0] === 'Your ROMs');
  check('"eject" with a tape in (no disk) -> Eject the tape first', top('eject', ['dragon64', true])[0] === 'Eject the tape', JSON.stringify(top('eject', ['dragon64', true])));
  check('"xyzzy" matches no command', top('xyzzy').length === 0);
  check('"switch" names no model: the one "Switch machine…" row, no "Switch to" rows',
    top('switch').includes('Switch machine…') && !top('switch').some((l) => l.startsWith('Switch to')), JSON.stringify(top('switch')));
  check('"machine" too: "Switch machine…" and no "Switch to" rows', top('machine').includes('Switch machine…') && !top('machine').some((l) => l.startsWith('Switch to')), JSON.stringify(top('machine')));
  check('"computer" and "model" find "Switch machine…"', top('computer')[0] === 'Switch machine…' && top('model')[0] === 'Switch machine…');
  for (const p of availableProfiles()) {
    const rows = top(p.name, [p.id]);
    if (rows.includes(`Switch to ${p.name}`)) { check(`the running ${p.name} is never a "Switch to" row`, false); break; }
  }
  check('every other model has its row, by name', availableProfiles().filter((p) => p.id !== 'dragon64').every((p) => top(p.name).includes(`Switch to ${p.name}`)));
  // tiers: a label word's start before the extra words before a fuzzy match; ties in the list's order
  const fake = [['Alpha one', '', 'zebra', null, 'X'], ['Beta zebra', '', '', null, 'X'], ['Gamma zebrx', '', '', null, 'X'], ['Delta', '', 'zeb', null, 'X'], ['Eps zebra', '', '', null, 'X']];
  check('ranking: label start (in list order), then the extra words, then fuzzy', JSON.stringify(rankCommands(fake, 'zebra').map((r) => [r.c[0], r.tier])) === JSON.stringify([['Beta zebra', 0], ['Eps zebra', 0], ['Alpha one', 1], ['Gamma zebrx', 2]]),
    JSON.stringify(rankCommands(fake, 'zebra').map((r) => [r.c[0], r.tier])));
  check('3-letter words are not fuzzy: "rst" finds nothing', top('rst').length === 0, JSON.stringify(top('rst')));
  check('a fuzzy match keeps the first letter: "rset" does not find the settings', !top('rset').some((l) => /settings/i.test(l)), JSON.stringify(top('rset')));
  // marks
  const mk = (q, label) => { const r = rankCommands(all(), q).find((x) => x.c[0] === label); return r && r.marks.map(([s, e]) => label.slice(s, e)); };
  check('marks: "coco 3" marks "CoCo" and "3" in "Switch to CoCo 3"', JSON.stringify(mk('coco 3', 'Switch to CoCo 3')) === JSON.stringify(['CoCo', '3']), JSON.stringify(mk('coco 3', 'Switch to CoCo 3')));
  check('marks: "rset" marks "Reset"', JSON.stringify(mk('rset', 'Reset')) === JSON.stringify(['Reset']), JSON.stringify(mk('rset', 'Reset')));
  check('marks: a match in the extra words marks nothing ("delete rom" marks only "ROM")', JSON.stringify(mk('delete rom', 'Your ROMs')) === JSON.stringify(['ROM']), JSON.stringify(mk('delete rom', 'Your ROMs')));

  console.log(fail ? `${fail} failed` : 'all passed');
  process.exitCode = fail ? 1 : 0;
})();
