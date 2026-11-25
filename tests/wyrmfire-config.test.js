// ?start=wyrmfire (js/config.js): it opens the Dragon 64 (the one machine WYRMFIRE runs on), and it conflicts with
// machine=<another model> (an error, the machine ignored) and with app=claude (an error, as start= with the chat always
// is: the chat opens). A share link made while WYRMFIRE runs reads back to it.
const Emu = require('./load')();
const { WYRMFIRE_PIN } = require('../js/wyrmfire/pin.js');
const { WYRMFIRE_MACHINE } = require('../js/config.js');

let fail = 0;
const check = (name, cond, detail = '') => { if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name} ${detail}`); };
const parse = (q, fb = 'coco3') => Emu.parseUrlConfig(q, fb);
const J = JSON.stringify;

check('the pin and the link agree on the machine', WYRMFIRE_MACHINE === WYRMFIRE_PIN.machine.id && WYRMFIRE_MACHINE === 'dragon64');
{
  const c = parse('?start=wyrmfire');
  check('start=wyrmfire: the Dragon 64, WYRMFIRE, no errors (whatever the machine in use was)', c.machine === 'dragon64' && c.start === 'wyrmfire' && !c.errors.length, J(c));
  const same = parse('?start=wyrmfire&machine=dragon64');
  check('start=wyrmfire with machine=dragon64: fine', same.machine === 'dragon64' && same.start === 'wyrmfire' && !same.errors.length);
}
{
  const c = parse('?start=wyrmfire&machine=coco3');
  check('start=wyrmfire with machine=coco3: an error, the CoCo 3 ignored, WYRMFIRE on the Dragon 64', c.machine === 'dragon64' && c.start === 'wyrmfire'
    && J(c.errors) === J(['machine=coco3 is ignored: start=wyrmfire runs on the Dragon 64']), J(c.errors));
  const opt = parse('?start=wyrmfire&machine=coco3&ram=512');
  check('... and the other model\'s options are checked against the Dragon 64', opt.errors.length === 2 && /ram=512: the Dragon 64 has 64K/.test(opt.errors[1]) && !('ram' in opt.config), J(opt.errors));
  const cpu = parse('?start=wyrmfire&cpu=6309');
  check('start=wyrmfire with cpu=6309: an error, the 6809 kept', !('cpu' in cpu.config) && J(cpu.errors) === J(['cpu=6309 is ignored: WYRMFIRE runs on the 6809']), J(cpu.errors));
}
{
  const c = parse('?start=wyrmfire&app=claude');
  check('start=wyrmfire with app=claude: an error, the chat opens and WYRMFIRE does not', c.app === 'claude' && c.start === null
    && J(c.errors) === J(['start=wyrmfire is ignored: app=claude opens instead']), J(c));
  const both = parse('?start=wyrmfire&app=claude&machine=coco3');
  check('... and the machine asked for is not overridden then', both.machine === 'coco3' && both.errors.length === 1, J(both));
}
check('an unknown start still names the starts, wyrmfire among them', /start=doom isn't a start CLOADM has \(welcome, liza, 2048, minesweeper, wyrmfire\)/.test(parse('?start=doom').errors[0]), parse('?start=doom').errors[0]);
{
  const url = Emu.buildUrl('https://cloadm.dev/play/', { start: 'wyrmfire' });
  check('buildUrl writes start=wyrmfire alone, and it reads back', url === 'https://cloadm.dev/play/?start=wyrmfire' && parse(new URL(url).search).start === 'wyrmfire');
}

console.log(fail ? `${fail} FAILED` : 'all passed');
process.exitCode = fail ? 1 : 0;
