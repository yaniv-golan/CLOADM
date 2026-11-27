// Run: node tests/basic-sound-joystk.test.js
//
// The clean-room BASIC's JOYSTK (docs/clean-room-basic-p2.md section 7), typed into a Dragon 64 running the image
// assembled from basic/ at test time: JOYSTK(0)-(3) against the joystick values set in the machine, what JOYSTK(1) to
// (3) read without JOYSTK(0), the DAC steps and sound switch while it reads, and the ?FC errors (the shared code is
// tests/basic/basic-sound-lib.js).
const { check, tally, boot, typeAll, last, wav } = require('./basic/basic-sound-lib.js');

// ---- JOYSTK ----
{
  const b = boot();
  let bad = null;
  for (let v = 0; v < 64 && !bad; v++) {
    const want = [0, 1, 2, 3].map((a) => (v + 16 * a) & 63);
    b.m.joy[0][0] = want[0]; b.m.joy[0][1] = want[1]; b.m.joy[1][0] = want[2]; b.m.joy[1][1] = want[3];
    typeAll(b, ['PRINT JOYSTK(0);JOYSTK(1);JOYSTK(2);JOYSTK(3)']);
    const got = last(b).trim().split(/\s+/).map(Number);
    if (got.join() !== want.join()) bad = `set ${want.join()}, read ${got.join()}`;
  }
  check('JOYSTK(0)-(3): every axis at every value 0-63, read back exactly', !bad, bad || '');
  b.m.joy[0][1] = 7; b.m.joy[1][1] = 9;
  typeAll(b, ['PRINT JOYSTK(1);JOYSTK(3)']);
  check('JOYSTK(1) and (3) without JOYSTK(0): what JOYSTK(0) last read', last(b).trim().split(/\s+/).join() === [(63 + 16) & 63, (63 + 48) & 63].join(), last(b));
  typeAll(b, ['PRINT JOYSTK(0);JOYSTK(1);JOYSTK(3)']);
  check('after JOYSTK(0): the new values', last(b).trim().split(/\s+/).slice(1).join() === '7,9', last(b));
  typeAll(b, ['SOUND 100,1']);
  const m = wav(b, 'X=JOYSTK(0)');
  check('JOYSTK(0) after SOUND is not heard (sound off after SOUND), 6 DAC steps an axis, sound still off after', m.heard === 0 && m.writes === 24 && !m.end.enabled && m.end.mux === 0, `${m.writes} writes, ${m.heard} heard`);
  for (const line of ['PRINT JOYSTK(4)', 'PRINT JOYSTK(-1)']) { typeAll(b, [line]); check(`${line}: ?FC ERROR`, last(b) === '?FC ERROR', last(b)); }
}

const total = tally();
console.log(`\n${total.n - total.fail}/${total.n} passed`);
process.exitCode = total.fail ? 1 : 0;
