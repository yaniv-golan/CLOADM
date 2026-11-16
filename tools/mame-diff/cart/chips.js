// The chip models the audio comparison renders with: our own (js/chips), loaded as CommonJS for the tools.
const path = require('path');
const Emu = require(path.join(__dirname, '../../../tests/load.js'))();
module.exports = { SN76489: Emu.SN76489 };
