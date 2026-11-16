// The PWA's files: sw.js keeps the whole site for offline use, and its list must be the one
// tools/pwa-files.js computes from the files on disk (a new file the page needs would otherwise be missing
// offline); the manifest opens /play/ and its icons are the sizes it says (read from the PNG headers).
// The worker itself is exercised in Chromium by tools/browser-check.js (installs, offline reload runs).
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { pwaFiles, withList } = require('../tools/pwa-files.js');

const ROOT = path.join(__dirname, '..');
let fail = 0;
const check = (name, cond, detail = '') => { if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name} ${detail}`); };

const sw = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
// the list as the worker sees it: run sw.js with a stub `self`
const ctx = { self: { addEventListener() {}, location: { origin: 'https://cloadm.dev' } } };
vm.runInNewContext(sw + '\nthis.FILES_SEEN = FILES; this.CACHE_SEEN = CACHE;', ctx);
const files = ctx.FILES_SEEN, expected = pwaFiles();
check('sw.js lists exactly the files tools/pwa-files.js finds (run it with --write after adding a file)',
  JSON.stringify(files) === JSON.stringify(expected), `${files.length} listed, ${expected.length} found`);
check('sw.js is what --write produces', withList(sw, expected) === sw);
const missing = files.filter((f) => !fs.existsSync(path.join(ROOT, f)));
check('every listed file exists', !missing.length, missing.join(' '));
for (const need of ['./', 'play/', 'play/index.html', 'js/ui/main.js', 'js/emu.js', 'examples/welcome.bin', 'examples/liza.bin', 'examples/liza.asm',
  'fonts/archivo/archivo-latin-wdth-normal.woff2', 'css/tokens.css', 'embed/cloadm.js', 'manifest.webmanifest', 'help/', 'roms/', 'credits/']) {
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

console.log(fail ? `${fail} FAILED` : 'all passed');
process.exitCode = fail ? 1 : 0;
