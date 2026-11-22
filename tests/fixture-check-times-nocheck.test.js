// A fixture for tests/check-times.test.js: no check() shape at all, so the tool must refuse rather than report 0.
const t = Date.now(); while (Date.now() - t < 5);
console.log('fixture-nocheck: done');
