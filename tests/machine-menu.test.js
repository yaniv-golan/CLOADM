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

  // ---- descriptions, subtitles and Help's list of machines (data in js/machines/menu.js) ----
  const { SUBTITLES, DESCRIPTIONS, describe } = await import('../js/machines/menu.js');
  const avail = Emu.availableProfiles();
  check('every profile has a description, with the MAME driver line it was checked against', profiles.every((p) => DESCRIPTIONS[p.id] && DESCRIPTIONS[p.id].text
    && /^src\/mame\/trs\/\w+\.cpp/.test(DESCRIPTIONS[p.id].source)), profiles.filter((p) => !DESCRIPTIONS[p.id]).map((p) => p.id).join(', '));
  check('no description for a model that does not exist', Object.keys(DESCRIPTIONS).every((id) => Emu.profiles[id]), Object.keys(DESCRIPTIONS).filter((id) => !Emu.profiles[id]).join(', '));
  // a maker the model's name already gives is not said again ("Codimex CD-6809: a CoCo clone, 1983.", not "... by
  // Codimex"): the name's first word, unless it is the family's own (Dragon, CoCo, MC-10)
  check('no description repeats the maker its model\'s name gives', profiles.every((p) => {
    const first = p.name.split(' ')[0];
    return ['Dragon', 'CoCo', 'MC-10'].includes(first) || !DESCRIPTIONS[p.id].text.includes(first);
  }), profiles.filter((p) => !['Dragon', 'CoCo', 'MC-10'].includes(p.name.split(' ')[0]) && DESCRIPTIONS[p.id].text.includes(p.name.split(' ')[0])).map((p) => p.id).join());
  check('describe(): "<name>: <what it is>."', describe(Emu.profiles.cd6809) === 'Codimex CD-6809: a CoCo clone, 1983.', describe(Emu.profiles.cd6809));
  const sections = groupProfiles(avail).map(([g]) => g);
  check('every section the menu shows has a subtitle, and there is none for a section it does not', sections.every((g) => SUBTITLES[g])
    && Object.keys(SUBTITLES).every((g) => sections.includes(g)), JSON.stringify({ sections, subtitles: Object.keys(SUBTITLES) }));
  check('the subtitles as the ruling words them (DRAGON, COCO, MC-10, CLONES)', SUBTITLES.DRAGON === "Dragon Data's machines and their Spanish and US versions"
    && SUBTITLES.COCO === "Tandy's Color Computers" && SUBTITLES['MC-10'] === "Tandy's MC-10 and the French Matra Alice" && SUBTITLES.CLONES === 'Brazilian copies of the CoCo');
  const kits = groupProfiles(avail).find(([g]) => g === 'KITS');
  check('KITS\'s subtitle names every model the catch-all holds (today the CP-400)', !!kits && kits[1].every((p) => SUBTITLES.KITS.includes(p.name)), kits && kits[1].map((p) => p.name).join());
  check('the MC-10 subtitle names the models in it that are not Tandy\'s', groupProfiles(avail).find(([g]) => g === 'MC-10')[1].every((p) => p.id === 'mc10' || SUBTITLES['MC-10'].includes(p.name)));
  // Help: the generated list is up to date, and lists every model the menu offers with its ROM sockets' labels
  const gen = require('../tools/gen-machine-help.js');
  const fs = require('fs');
  const help = fs.readFileSync(gen.FILE, 'utf8');
  check('help/index.html\'s list of machines is up to date (node tools/gen-machine-help.js)', help === await gen.expected());
  const block = help.slice(help.indexOf('<!-- machines:start'), help.indexOf('<!-- machines:end'));
  const inHelp = [...block.matchAll(/<dt id="machine-([\w]+)">/g)].map((m) => m[1]);
  check('help/#machines lists exactly the 17 models availableProfiles() offers', inHelp.length === avail.length && avail.length === 17 && avail.every((p) => inHelp.includes(p.id)), inHelp.join(','));
  check('each model in Help: its description and every ROM socket by the label Your ROMs uses', avail.every((p) => {
    const dd = block.slice(block.indexOf(`id="machine-${p.id}"`)).split('</dd>')[0];
    return dd.includes(DESCRIPTIONS[p.id].text.slice(1).replace(/&/g, '&amp;')) && p.roms.every((r) => dd.includes(r.label) && r.files.every((f) => dd.includes(f)));
  }));
  check('help/ has the #machines section', /<h2 id="machines">/.test(help));

  console.log(fail ? `${fail} FAILED` : 'all passed');
  process.exitCode = fail ? 1 : 0;
})();
