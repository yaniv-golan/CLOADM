// WYRMFIRE's thumb stick (js/ui/touch-layout.js thumbKeys): which arrow keys a finger holds, from where it is on the stick.
//
// Oracle: the ruling's own terms, worked out by hand here: eight directions, each a 45° sector centred on its arrow or
// diagonal (so the boundaries are at 22.5° + k·45°), and a dead zone of 20% of the radius where nothing is pressed.
// Screen y grows downwards, so a finger above the centre (dy < 0) is UP. The browser check (phone group) drives the
// same function through the page's pointer events and the machine's held keys.
const path = require('path');
const { pathToFileURL } = require('url');
const { PROGRAM_CONTROLS } = require('./load')();

(async () => {
const { thumbKeys, THUMB_DEAD, programMode } = await import(pathToFileURL(path.join(__dirname, '..', 'js/ui/touch-layout.js')).href);

let fail = 0;
const check = (name, cond, detail = '') => { if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log('ok   ', name, detail); };
const R = 60;
const at = (deg, frac) => [Math.cos(deg * Math.PI / 180) * frac * R, -Math.sin(deg * Math.PI / 180) * frac * R];
const keys = (deg, frac) => thumbKeys(...at(deg, frac), R).join('+');

check('the dead zone is 20% of the radius', THUMB_DEAD === 0.2, String(THUMB_DEAD));
// the eight directions, at their centres and near both edges of their sectors (±20°)
const DIRS = [[0, 'RIGHT'], [45, 'UP+RIGHT'], [90, 'UP'], [135, 'UP+LEFT'], [180, 'LEFT'], [225, 'DOWN+LEFT'], [270, 'DOWN'], [315, 'DOWN+RIGHT']];
for (const [deg, want] of DIRS) {
  const got = [-20, 0, 20].map((d) => keys(deg + d, 0.6));
  check(`${deg}°: ${want} across its sector (centre and ±20°)`, got.every((g) => g === want), got.join(', '));
}
// just past a boundary the next direction takes over: 22.5° + 1° is UP+RIGHT, 22.5° - 1° RIGHT
check('the sector boundary at 22.5°: RIGHT below it, UP+RIGHT above it', keys(21.5, 0.6) === 'RIGHT' && keys(23.5, 0.6) === 'UP+RIGHT', `${keys(21.5, 0.6)} / ${keys(23.5, 0.6)}`);
check('the sector boundary at 67.5°: UP+RIGHT below it, UP above it', keys(66.5, 0.6) === 'UP+RIGHT' && keys(68.5, 0.6) === 'UP', `${keys(66.5, 0.6)} / ${keys(68.5, 0.6)}`);
// the dead zone, in every direction, and its edge
check('inside the dead zone nothing is held, in every direction (19% of the radius)', DIRS.every(([deg]) => keys(deg, 0.19) === ''));
check('the centre holds nothing', thumbKeys(0, 0, R).length === 0);
check('just past the dead zone the direction holds (21% of the radius)', DIRS.every(([deg, want]) => keys(deg, 0.21) === want));
check('past the rim (150%) the direction still holds', DIRS.every(([deg, want]) => keys(deg, 1.5) === want));
check('a stick with no size holds nothing', thumbKeys(10, 0, 0).length === 0);
// a fresh array each time: a caller's change cannot reach the next answer
const a = thumbKeys(R, 0, R); a.push('X');
check('each answer is a fresh array', thumbKeys(R, 0, R).join() === 'RIGHT');
// WYRMFIRE's controls open on the pad, with the stick
check('WYRMFIRE opens on Pad, with the thumb stick', programMode(PROGRAM_CONTROLS.wyrmfire) === 'pad' && PROGRAM_CONTROLS.wyrmfire.thumb === true);
check('no other program has the thumb stick', Object.entries(PROGRAM_CONTROLS).every(([id, c]) => (id === 'wyrmfire') === !!c.thumb));

console.log(fail ? `${fail} FAILED` : 'all thumb stick checks passed');
process.exitCode = fail ? 1 : 0;
})();
