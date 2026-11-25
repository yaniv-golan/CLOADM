// Link previews: index.html and play/index.html carry a meta description and the Open Graph and X card tags, so a
// link pasted in a chat or a post shows the picture, the name and one line. The picture is img/og.png (1200x630,
// made by tools/capture-og.js from the welcome menu with no ROMs), at an absolute URL on the site's own host (CNAME),
// and it is in the offline copy (sw.js's FILES).
const fs = require('fs'), path = require('path');

let fail = 0;
const check = (name, cond, detail = '') => { if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name}`); };
const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const DESCRIPTION = 'CLOADM: Dragon and Tandy Color Computer emulator in your browser. Runs LIZA and games with no ROMs; add yours for BASIC.';
const host = read('CNAME').trim();
const IMAGE = `https://${host}/img/og.png`;

// every <meta> in <head>: [{ name | property, content }]
const metas = (html) => {
  const head = html.slice(0, html.indexOf('</head>'));
  return [...head.matchAll(/<meta\s+(name|property)="([^"]+)"\s+content="([^"]*)"\s*>/g)].map((m) => ({ key: m[2], content: m[3] }));
};

for (const [file, url, title] of [['index.html', `https://${host}/`, 'CLOADM'], ['play/index.html', `https://${host}/play/`, 'CLOADM: play']]) {
  const m = metas(read(file));
  const one = (key) => { const all = m.filter((x) => x.key === key); return all.length === 1 ? all[0].content : `(${all.length} tags)`; };
  check(`${file}: the meta description`, one('description') === DESCRIPTION, one('description'));
  check(`${file}: og:title and twitter:title`, one('og:title') === title && one('twitter:title') === title, `${one('og:title')} / ${one('twitter:title')}`);
  check(`${file}: og:description and twitter:description`, one('og:description') === DESCRIPTION && one('twitter:description') === DESCRIPTION);
  check(`${file}: og:url is the page's own address`, one('og:url') === url, one('og:url'));
  check(`${file}: og:image and twitter:image, absolute on ${host}`, one('og:image') === IMAGE && one('twitter:image') === IMAGE, one('og:image'));
  check(`${file}: twitter:card is summary_large_image`, one('twitter:card') === 'summary_large_image', one('twitter:card'));
  check(`${file}: the picture's size is given`, one('og:image:width') === '1200' && one('og:image:height') === '630');
}

// the picture: a PNG of 1200x630 (the IHDR chunk's width and height), served from the repository
const png = fs.readFileSync(path.join(ROOT, 'img', 'og.png'));
check('img/og.png is a PNG', png.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])));
check('img/og.png is 1200x630', png.readUInt32BE(16) === 1200 && png.readUInt32BE(20) === 630, `${png.readUInt32BE(16)}x${png.readUInt32BE(20)}`);
check('img/og.png is in the offline copy (sw.js)', /^\s*'img\/og\.png',$/m.test(read('sw.js')));
// its maker captures with no ROMs, and says so by refusing otherwise
check('tools/capture-og.js refuses to capture with ROMs loaded', /if \(await page\.evaluate\(\(\) => window\.emu\.machine\.hasRom\)\) throw/.test(read('tools/capture-og.js')));

console.log(fail ? `\n${fail} FAILED` : '\nall passed');
process.exitCode = fail ? 1 : 0;
