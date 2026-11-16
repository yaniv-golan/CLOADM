// Run: node tests/machine-menu.test.js
// The machine menu's grouping: every model must be listed exactly once, in the section that
// claims it. This is the bug the Prológica CP-400 exposed - it matched no section, so it could not be picked
// at all. The grouping lives in js/machines/menu.js (data only), so it is checked here without a DOM.
const Emu = require('./load')();

let fail = 0;
const check = (n, c, d = '') => { if (!c) { fail++; console.log('FAIL', n, d); } else console.log('ok  ', n, d); };

(async () => {
  const { groupProfiles, caseOf } = await import('../js/machines/menu.js');
  const profiles = Object.values(Emu.profiles);
  const groups = groupProfiles(profiles);
  const listed = groups.flatMap(([, list]) => list);

  check('every model is in the menu', listed.length === profiles.length, `${listed.length} of ${profiles.length}`);
  check('no model is listed twice', new Set(listed.map((p) => p.id)).size === profiles.length);
  check('every model of the registry appears', profiles.every((p) => listed.some((x) => x.id === p.id)),
    profiles.filter((p) => !listed.some((x) => x.id === p.id)).map((p) => p.id).join(', '));
  check('no empty section is shown', groups.every(([, list]) => list.length > 0));

  const byId = new Map(groups.flatMap(([g, list]) => list.map((p) => [p.id, g])));
  check('the Dragons are under DRAGON', ['dragon32', 'dragon64', 'dragon200', 'dragon200e', 'tanodr64'].every((id) => byId.get(id) === 'DRAGON'));
  check('the CoCos are under COCO', ['coco', 'coco2b', 'coco3', 'coco3p'].every((id) => byId.get(id) === 'COCO'));
  check('the MC-10 and Alice are under MC-10', ['mc10', 'alice'].every((id) => byId.get(id) === 'MC-10'));
  check('the named clones are under CLONES', ['mx1600', 'lzcolor64', 'cd6809'].every((id) => byId.get(id) === 'CLONES'));
  check('the CP-400 (not a clone of a named model) shows under the KITS catch-all', byId.get('cp400') === 'KITS', byId.get('cp400'));

  // a model added later with no matching section still shows (the KITS catch-all)
  const ghost = { id: 'future', name: 'Some Future Machine', family: 'sam' };
  const g2 = groupProfiles([...profiles, ghost]);
  check('a model no section recognises still appears (KITS)', g2.flatMap(([, l]) => l).some((p) => p.id === 'future'));

  // the bezel choice the layout uses: Dragons get the charcoal case, the rest the Tandy monitor
  check('the bezel follows the family and the name', caseOf({ family: 'sam', name: 'Dragon 200-E' }) === 'dragon'
    && caseOf({ family: 'sam', name: 'Prológica CP-400' }) === 'coco' && caseOf({ family: 'mc10', name: 'MC-10' }) === 'mc10'
    && caseOf({ family: 'coco3', name: 'CoCo 3' }) === 'coco3');

  console.log(fail ? `${fail} FAILED` : 'all passed');
  process.exitCode = fail ? 1 : 0;
})();
