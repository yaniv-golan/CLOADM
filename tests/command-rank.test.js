// The command box's matching (js/ui/command-box.js rankCommands): word starts in the label beat the extra words, which
// beat a word one edit from a word's start (4 letters or more, its first letter kept); ties keep the list's order;
// "Switch to <model>" rows only when a word names the model, otherwise the one "Switch machine…" row; the matched
// parts of the label for <mark>. Expected rows are written out here, from the queries the ranking was specified with.
// Run: node tests/command-rank.test.js
let fail = 0;
const check = (name, cond, detail = '') => { if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name} ${detail}`); };

(async () => {
  const { COMMANDS, rankCommands, listCommands, switchCommands, MAX_ROWS } = await import('../js/ui/command-box.js');
  const { availableProfiles } = await import('../js/machines/profiles.js');
  // a page as the commands see it: a tape in or not, a disk in or not, a recording or not
  const pageWith = ({ tape = false, disk = false, recorded = false } = {}) => ({ session: { personMachine: { deck: { tape: tape ? {} : null } },
    drives: { status: () => ({ drives: disk ? [{ drive: 0 }] : [] }) } }, tape: { recorded: () => recorded } });
  const rowsFor = (q, opts = {}) => listCommands(COMMANDS.concat(switchCommands(availableProfiles(), opts.running || 'dragon64')), q, pageWith(opts));
  const top = (q, opts) => rowsFor(q, opts).map((r) => r.c[0]);

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
  const ej = rowsFor('eject', { tape: true });
  check('"eject" with only a tape in: Eject the tape first, then Eject disk, muted ("No disk in")', ej[0].c[0] === 'Eject the tape' && !ej[0].off
    && ej[1].c[0] === 'Eject disk' && ej[1].off && ej[1].off.state === 'No disk in' && ej[1].off.why === 'No disk in any drive.', JSON.stringify(ej.map((r) => [r.c[0], r.off])));
  const ej2 = rowsFor('eject', { tape: true, disk: true });
  check('"eject" with a tape and a disk: both apply, in the list\'s order (Eject disk, Eject the tape)', JSON.stringify(ej2.map((r) => [r.c[0], !!r.off])) === JSON.stringify([['Eject disk', false], ['Eject the tape', false]]), JSON.stringify(ej2.map((r) => r.c[0])));
  const ej0 = rowsFor('eject');
  check('"eject" with nothing in: both listed, both muted, with their reasons', ej0.length === 2 && ej0.every((r) => r.off)
    && ej0.find((r) => r.c[0] === 'Eject the tape').off.why === 'No tape in the deck.', JSON.stringify(ej0.map((r) => [r.c[0], r.off])));
  const wav = rowsFor('wav'), wavR = rowsFor('wav', { recorded: true });
  check('Save the tape as .WAV: muted with no tape and nothing recorded ("No tape in and nothing recorded yet."), not with a recording',
    wav.find((r) => r.c[0] === 'Save the tape as .WAV').off.why === 'No tape in and nothing recorded yet.' && !wavR.find((r) => r.c[0] === 'Save the tape as .WAV').off);
  const rw = rowsFor('rewind');
  check('Rewind the tape with no tape: "No tape in. Insert one with "Insert a tape…"."', rw[0].c[0] === 'Rewind the tape' && rw[0].off.why === 'No tape in. Insert one with "Insert a tape…".');
  check('"xyzzy" matches no command', top('xyzzy').length === 0);
  check('"switch" names no model: the one "Switch machine…" row, no "Switch to" rows',
    top('switch').includes('Switch machine…') && !top('switch').some((l) => l.startsWith('Switch to')), JSON.stringify(top('switch')));
  check('"machine" too: "Switch machine…" and no "Switch to" rows', top('machine').includes('Switch machine…') && !top('machine').some((l) => l.startsWith('Switch to')), JSON.stringify(top('machine')));
  check('"computer" and "model" find "Switch machine…"', top('computer')[0] === 'Switch machine…' && top('model')[0] === 'Switch machine…');
  check('the running model has its row too, muted "Running now", choosing it says "You\'re using the <model> now."', availableProfiles().every((p) => {
    const r = rowsFor(p.name, { running: p.id }).find((x) => x.c[0] === `Switch to ${p.name}`);
    return r && r.off && r.off.state === 'Running now' && r.off.why === `You're using the ${p.name} now.`;
  }));
  check('every other model has its row, by name, not muted', availableProfiles().filter((p) => p.id !== 'dragon64').every((p) => { const r = rowsFor(p.name).find((x) => x.c[0] === `Switch to ${p.name}`); return r && !r.off; }));
  const d64 = rowsFor('dragon 64');
  check('"dragon 64" on the Dragon 64: the other Dragon 64s first, the running one after them, muted', d64[d64.length - 1].c[0] === 'Switch to Dragon 64' && d64[d64.length - 1].off
    && d64.slice(0, -1).every((r) => !r.off), JSON.stringify(d64.map((r) => [r.c[0], !!r.off])));
  // tiers: a label word's start before the extra words before a fuzzy match; ties in the list's order
  const fake = [['Alpha one', '', 'zebra', null, 'X'], ['Beta zebra', '', '', null, 'X'], ['Gamma zebrx', '', '', null, 'X'], ['Delta', '', 'zeb', null, 'X'], ['Eps zebra', '', '', null, 'X']];
  check('ranking: label start (in list order), then the extra words, then fuzzy', JSON.stringify(rankCommands(fake, 'zebra').map((r) => [r.c[0], r.tier])) === JSON.stringify([['Beta zebra', 0], ['Eps zebra', 0], ['Alpha one', 1], ['Gamma zebrx', 2]]),
    JSON.stringify(rankCommands(fake, 'zebra').map((r) => [r.c[0], r.tier])));
  check('3-letter words are not fuzzy: "rst" finds nothing', top('rst').length === 0, JSON.stringify(top('rst')));
  check('a fuzzy match keeps the first letter: "rset" does not find the settings', !top('rset').some((l) => /settings/i.test(l)), JSON.stringify(top('rset')));
  // marks
  const mk = (q, label) => { const r = rowsFor(q).find((x) => x.c[0] === label); return r && r.marks.map(([s, e]) => label.slice(s, e)); };
  check('marks: "coco 3" marks "CoCo" and "3" in "Switch to CoCo 3"', JSON.stringify(mk('coco 3', 'Switch to CoCo 3')) === JSON.stringify(['CoCo', '3']), JSON.stringify(mk('coco 3', 'Switch to CoCo 3')));
  check('marks: "rset" marks "Reset"', JSON.stringify(mk('rset', 'Reset')) === JSON.stringify(['Reset']), JSON.stringify(mk('rset', 'Reset')));
  check('marks: a match in the extra words marks nothing ("delete rom" marks only "ROM")', JSON.stringify(mk('delete rom', 'Your ROMs')) === JSON.stringify(['ROM']), JSON.stringify(mk('delete rom', 'Your ROMs')));

  console.log(fail ? `${fail} failed` : 'all passed');
  process.exitCode = fail ? 1 : 0;
})();
