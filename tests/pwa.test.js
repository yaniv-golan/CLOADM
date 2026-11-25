// The PWA's files: sw.js keeps the whole site for offline use, and its list must be the one
// tools/pwa-files.js computes from the files on disk (a new file the page needs would otherwise be missing
// offline); the manifest opens /play/ and its icons are the sizes it says (read from the PNG headers).
// The worker itself is exercised in Chromium by tools/browser-check.js (installs, offline reload runs).
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const os = require('os'), cp = require('child_process');
const { pwaFiles, withList } = require('../tools/pwa-files.js');

const ROOT = path.join(__dirname, '..');
let fail = 0;
const check = (name, cond, detail = '') => { if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name} ${detail}`); };

const sw = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
// the list as the worker sees it: run sw.js with a stub `self`
const ctx = { self: { addEventListener() {}, location: { origin: 'https://cloadm.dev' } } };
vm.runInNewContext(sw + '\nthis.FILES_SEEN = FILES; this.CACHE_SEEN = CACHE;', ctx);
const files = ctx.FILES_SEEN, expected = pwaFiles();
check('sw.js lists exactly the files tools/pwa-files.js finds (after adding or removing a served file run: node tools/pwa-files.js --write; tools/build-examples.js does it for you)',
  JSON.stringify(files) === JSON.stringify(expected), `${files.length} listed, ${expected.length} found`);
check('sw.js is what --write produces', withList(sw, expected) === sw);
const missing = files.filter((f) => !fs.existsSync(path.join(ROOT, f)));
check('every listed file exists', !missing.length, missing.join(' '));
for (const need of ['./', 'play/', 'play/index.html', 'js/ui/main.js', 'js/emu.js', 'examples/welcome.bin', 'examples/liza.bin', 'examples/liza.asm',
  'fonts/archivo/archivo-latin-wdth-normal.woff2', 'css/tokens.css', 'embed/cloadm.js', 'manifest.webmanifest', 'help/', 'roms/', 'credits/', 'faq/', 'about/']) {
  if (!files.includes(need)) check(`kept for offline use: ${need}`, false);
}
check('the pages, their scripts, the built-in programs and fonts are all kept', ['./', 'play/', 'examples/welcome.bin', 'embed/cloadm.js'].every((f) => files.includes(f)));
check('nothing the README alone needs, no dot files', !files.some((f) => f !== './' && /^img\/readme-|\.md$|(^|\/)\./.test(f)));
check('one cache name, versioned', /^cloadm-v\d+$/.test(ctx.CACHE_SEEN), ctx.CACHE_SEEN);

// the manifest
const man = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.webmanifest'), 'utf8'));
check('manifest: opens /play/, standalone, scope the whole site, the ground colour', man.start_url === '/play/' && man.scope === '/' && man.display === 'standalone'
  && man.background_color === '#0B0D0C' && man.theme_color === '#0B0D0C' && man.short_name === 'CLOADM');
const pngSize = (f) => { const b = fs.readFileSync(path.join(ROOT, f)); return b.toString('ascii', 1, 4) === 'PNG' ? [b.readUInt32BE(16), b.readUInt32BE(20)] : null; };
for (const icon of man.icons) {
  const file = icon.src.replace(/^\//, '');
  if (icon.type === 'image/png') {
    const [w, h] = pngSize(file) || [];
    check(`manifest icon ${icon.src}: a PNG of ${icon.sizes}${icon.purpose ? ` (${icon.purpose})` : ''}`, `${w}x${h}` === icon.sizes, `${w}x${h}`);
  } else check(`manifest icon ${icon.src} exists`, fs.existsSync(path.join(ROOT, file)));
}
check('manifest: a 192 and a 512 icon, and a maskable one (what browsers ask for to install)', ['192x192', '512x512'].every((s) => man.icons.some((i) => i.sizes === s))
  && man.icons.some((i) => i.purpose === 'maskable'));
for (const page of ['index.html', 'play/index.html']) {
  const html = fs.readFileSync(path.join(ROOT, page), 'utf8');
  check(`${page} links the manifest and the theme colour`, /<link rel="manifest" href="manifest\.webmanifest">/.test(html) && /<meta name="theme-color" content="#0B0D0C">/.test(html));
}

// tools/build-examples.js brings sw.js up to date itself: a new file under examples/ used to leave this suite failing
// until `node tools/pwa-files.js --write` was run by hand. Run the real tool in a scratch copy of the served tree
// (the real tree is only read): a file added to examples/ must be in sw.js afterwards, sw.js must then be exactly
// what --write produces, and a second run must leave it alone.
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pwa-build-'));
  try {
    const { DIRS } = require('../tools/pwa-files.js');   // every folder the site serves
    for (const d of DIRS) fs.cpSync(path.join(ROOT, d), path.join(dir, d), { recursive: true });
    for (const f of ['index.html', 'favicon.svg', 'favicon.ico', 'manifest.webmanifest', 'sw.js']) fs.copyFileSync(path.join(ROOT, f), path.join(dir, f));
    fs.mkdirSync(path.join(dir, 'tools')); fs.mkdirSync(path.join(dir, 'tests'));
    for (const f of ['build-examples.js', 'pwa-files.js']) fs.copyFileSync(path.join(ROOT, 'tools', f), path.join(dir, 'tools', f));
    fs.copyFileSync(path.join(ROOT, 'tests/load.js'), path.join(dir, 'tests/load.js'));
    fs.mkdirSync(path.join(dir, 'examples/zz-new-game'));
    fs.writeFileSync(path.join(dir, 'examples/zz-new-game/zz.bin'), Buffer.from([1, 2, 3]));
    const before = fs.readFileSync(path.join(dir, 'sw.js'), 'utf8');
    const run = () => cp.spawnSync(process.execPath, [path.join(dir, 'tools/build-examples.js')], { encoding: 'utf8', timeout: 120000 });
    const r1 = run(), after = fs.readFileSync(path.join(dir, 'sw.js'), 'utf8');
    check('build-examples adds a new example file to sw.js and says so', r1.status === 0 && !before.includes("'examples/zz-new-game/zz.bin'")
      && after.includes("'examples/zz-new-game/zz.bin'") && /sw\.js: file list updated/.test(r1.stdout), `exit ${r1.status} ${(r1.stderr || '').slice(0, 200)}`);
    check('...and leaves sw.js exactly as --write would', withList(after, pwaFiles(dir)) === after);
    const r2 = run();
    check('...and a second run changes nothing', r2.status === 0 && fs.readFileSync(path.join(dir, 'sw.js'), 'utf8') === after
      && /sw\.js: file list already up to date/.test(r2.stdout), `exit ${r2.status}`);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

console.log(fail ? `${fail} FAILED` : 'all passed');
process.exitCode = fail ? 1 : 0;
