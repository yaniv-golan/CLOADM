// The ROM pickers (Add ROMs: files and folder, and the side panel's) take the same accept list, js/roms.js ROM_PICKER_ACCEPT:
// the extensions a dump comes with, every extension the models' own ROM file names carry, a pack's .zip, and
// application/octet-stream so a phone still offers a file whose name it does not know. None may name image/* or video/*
// (iOS then offers the Photo Library and the camera next to Files) or carry `capture`. The page's pickers are the
// browser check's "audit of every file input"; this holds the lists to the data and to each other.
const fs = require('fs'), path = require('path'), { pathToFileURL } = require('url');
const Emu = require('./load')();

let fail = 0;
const check = (name, cond, detail = '') => { if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name}`); };
const ROOT = path.join(__dirname, '..');
const imp = (p) => import(pathToFileURL(path.join(ROOT, p)).href);

(async () => {
  const { ROM_PICKER_ACCEPT } = await imp('js/roms.js');
  const build = await imp('connector/build.js');
  const html = fs.readFileSync(path.join(ROOT, 'play', 'index.html'), 'utf8');
  const input = (src, id) => new RegExp(`<input[^>]*id="${id}"[^>]*>`).exec(src);
  const attr = (tag, name) => { const m = new RegExp(`\\s${name}(?:="([^"]*)")?[\\s>]`).exec(tag); return m ? (m[1] === undefined ? '' : m[1]) : null; };
  const tokens = ROM_PICKER_ACCEPT.split(',');

  check('the list has no image/*, video/* or audio/* type, and names application/octet-stream and application/zip',
    !tokens.some((t) => /^(image|video|audio)\//.test(t)) && tokens.includes('application/octet-stream') && tokens.includes('application/zip'), ROM_PICKER_ACCEPT);
  const romExt = new Set();
  for (const p of Object.values(Emu.romOwners())) for (const r of p.roms || []) for (const f of r.files || []) romExt.add(f.split('.').pop());
  const missing = [...romExt].filter((e) => !tokens.includes(`.${e}`));
  check(`every extension of the models' ROM file names is in the list (${[...romExt].sort().join(' ')})`, romExt.size > 0 && !missing.length, missing.join(' '));
  check('the dump extensions .rom .bin .zip .ccc .dat .a .b .0 .1 .2 are in it', ['.rom', '.bin', '.zip', '.ccc', '.dat', '.a', '.b', '.0', '.1', '.2'].every((e) => tokens.includes(e)));

  for (const id of ['fileRom', 'folderRom']) {
    const tag = input(html, id);
    check(`play/index.html: #${id} carries exactly the list, and no capture`, !!tag && attr(tag[0], 'accept') === ROM_PICKER_ACCEPT && attr(tag[0], 'capture') === null, tag && tag[0]);
  }
  const panelHtml = String(build.views().site);
  const panelTag = /<input[^>]*id=\\?"rom\\?"[^>]*>/.exec(panelHtml);
  check('the side panel\'s #rom carries exactly the list, and no capture', !!panelTag && panelTag[0].replace(/\\"/g, '"').includes(`accept="${ROM_PICKER_ACCEPT}"`) && !/capture/.test(panelTag[0]), panelTag && panelTag[0]);

  console.log(fail ? `\n${fail} FAILED` : '\nall passed');
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.error('test crashed:', e); process.exitCode = 1; });
