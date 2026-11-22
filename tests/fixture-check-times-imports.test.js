// A fixture for tests/check-times.test.js: check comes from a shared module, as the state suites import it.
const { check } = require('./fixture-check-times-shared.js');
for (const w of [1, 2]) { const t = Date.now(); while (Date.now() - t < 5); check(`imported check ${w}`, true); }
console.log('\nfixture-imports: done');
