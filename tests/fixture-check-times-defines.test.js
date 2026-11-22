// A fixture for tests/check-times.test.js: three checks and nothing else, a few ms each. Not a suite of this project.
const check = (name, cond, detail = '') => { if (!cond) { console.log(`FAIL ${name} ${detail}`); process.exitCode = 1; } else console.log(`ok   ${name} ${detail}`); };
for (const w of [1, 2, 3]) { const t = Date.now(); while (Date.now() - t < 5); check(`fixture check ${w}`, true); }
console.log('\nfixture-defines: done');
