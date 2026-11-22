// A shared helper for tests/fixture-check-times-imports.test.js: the shape the state suites use (check imported).
const check = (name, cond, detail = '') => { if (!cond) { console.log(`FAIL ${name} ${detail}`); process.exitCode = 1; } else console.log(`ok   ${name} ${detail}`); };
module.exports = { check };
