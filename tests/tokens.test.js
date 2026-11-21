// Design tokens and self-hosted fonts : every token has its agreed value,
// the documented colour pairs meet WCAG AA (contrast computed here from the WCAG 2.x formula), the font files
// are real WOFF2 with their SIL OFL licences, and no page or stylesheet loads anything from a font service.
const fs = require('fs'), path = require('path');

let fail = 0;
const check = (name, cond, detail = '') => { if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name} ${detail}`); };
const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const css = read('css/tokens.css');

// the :root block of the dark (default) theme
const rootBlock = css.slice(css.indexOf(':root {'), css.indexOf('}', css.indexOf(':root {')));
const tokens = {};
for (const m of rootBlock.matchAll(/--([a-z0-9-]+):\s*([^;]+);/g)) tokens[m[1]] = m[2].trim();

// the agreed design values: a change to a token must change it here too
const DESIGN = {
  ground: '#0B0D0C', panel: '#141816', 'panel-deep': '#101311', line: '#263029', 'line-strong': '#3A4540',
  text: '#E8EDE6', 'text-2': '#C9D2C8', 'text-3': '#B4BEB3', muted: '#9AA59C', phosphor: '#3DF55A',
  'on-phosphor': '#062A06', orange: '#FF9A2E', error: '#C42B23', 'on-orange': '#2B1600', 'warn-panel': '#2B1A08',
  'screen-green': '#39E83F', 'screen-ink': '#0A3D0A', 'dragon-badge': '#F06A5F',
  'vdg-green': '#30D82B', 'vdg-yellow': '#F2EA4A', 'vdg-blue': '#2A35E8', 'vdg-red': '#D8202A',
  'vdg-buff': '#EDE6C8', 'vdg-cyan': '#2BD8D8', 'vdg-magenta': '#D02BD8', 'vdg-orange': '#F08A1F',
  'r-8': '8px', 'r-10': '10px', 'r-14': '14px', 'r-18': '18px', 'r-22': '22px', pill: '999px', touch: '44px', 'text-min': '14px',
};
const wrong = Object.entries(DESIGN).filter(([k, v]) => (tokens[k] || '').toUpperCase() !== v.toUpperCase()).map(([k, v]) => `${k}=${tokens[k]} (want ${v})`);
check('every design token is defined with its value', !wrong.length, wrong.join(', '));
const stripe = ['green', 'yellow', 'blue', 'red', 'buff', 'cyan', 'magenta', 'orange'].map((c) => `var(--vdg-${c})`);
const order = stripe.map((s) => (tokens['vdg-stripe'] || '').indexOf(s));
check('the signature stripe has the eight VDG colours in order', order.every((p, i) => p >= 0 && (i === 0 || p > order[i - 1])));

// WCAG 2.x contrast
const lum = (hex) => {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
};
const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
// [foreground, background, minimum, ratio written in the stylesheet comment]
const PAIRS = [
  ['text', 'ground', 4.5, '16.42'], ['text', 'panel', 4.5, '15.09'], ['text-2', 'panel', 4.5, '11.55'], ['text-3', 'panel', 4.5, '9.35'],
  ['muted', 'panel', 4.5, '7.03'], ['muted', 'ground', 4.5, '7.65'], ['muted', 'panel-deep', 4.5, '7.33'],
  ['phosphor', 'panel', 4.5, '12.29'], ['phosphor', 'ground', 4.5, '13.38'], ['on-phosphor', 'phosphor', 4.5, '10.74'],
  ['orange', 'panel', 4.5, '8.46'], ['orange', 'warn-panel', 4.5, '7.91'], ['on-orange', 'orange', 4.5, '8.14'],
  ['text', 'warn-panel', 4.5, '14.11'], ['screen-ink', 'screen-green', 4.5, '7.59'],
  ['error', 'text', 3, '4.76'],   // the error toast's red bar on the toast's paper (#toast's background, #E8EDE6: the dark variant's --text)
];
for (const [fg, bg, min, doc] of PAIRS) {
  const r = ratio(tokens[fg], tokens[bg]);
  check(`contrast ${fg} on ${bg} >= ${min}, as recorded`, r >= min && r.toFixed(2) === doc, r.toFixed(2));
}
// independent spot check of the formula: black on white is 21:1, a colour on itself 1:1
check('contrast formula: black/white 21, same colour 1', ratio('#000000', '#FFFFFF').toFixed(2) === '21.00' && ratio('#3DF55A', '#3DF55A') === 1);

// the light variant (reading pages only): every text pair AA, UI borders 3:1, as recorded in the stylesheet
const lightBlock = css.slice(css.indexOf(':root.reading {'), css.indexOf('}', css.indexOf(':root.reading {')));
const light = Object.assign({}, tokens);
for (const m of lightBlock.matchAll(/--([a-z0-9-]+):\s*([^;]+);/g)) light[m[1]] = m[2].trim();
light.green = light.green.startsWith('var(') ? light.phosphor : light.green;
check('light variant: inside a prefers-color-scheme: light query, for :root.reading only', /@media \(prefers-color-scheme: light\) \{\s*:root\.reading \{/.test(css)
  && /color-scheme: light;/.test(lightBlock));
check('light variant: light ground and panel, dark text, phosphor kept for buttons', lum(light.ground) > 0.8 && lum(light.panel) > 0.8 && lum(light.text) < 0.02
  && light.phosphor === tokens.phosphor && light['on-phosphor'] === tokens['on-phosphor']);
const LIGHT = [
  ['text', 'ground', 4.5, '16.01'], ['text', 'panel', 4.5, '17.92'], ['text-2', 'panel', 4.5, '12.44'], ['text-2', 'panel-deep', 4.5, '10.25'],
  ['text-3', 'panel', 4.5, '9.62'], ['text-3', 'panel-deep', 4.5, '7.93'], ['muted', 'panel', 4.5, '6.32'], ['muted', 'ground', 4.5, '5.65'],
  ['muted', 'panel-deep', 4.5, '5.21'], ['green', 'panel', 4.5, '6.70'], ['green', 'ground', 4.5, '5.98'], ['green', 'panel-deep', 4.5, '5.52'],
  ['link-hover', 'ground', 4.5, '8.63'], ['on-phosphor', 'phosphor', 4.5, '10.74'], ['orange', 'panel', 4.5, '5.83'], ['orange', 'warn-panel', 4.5, '5.25'],
  ['text', 'warn-panel', 4.5, '16.12'], ['line-strong', 'panel', 3, '3.58'],
];
for (const [fg, bg, min, doc] of LIGHT) {
  const r = ratio(light[fg], light[bg]);
  check(`light: contrast ${fg} on ${bg} >= ${min}, as recorded`, r >= min && r.toFixed(2) === doc && css.includes(doc), r.toFixed(2));
}

check('light: primary buttons get an edge of --green (>= 3:1 against the ground)', /:root\.reading \.btn-primary[^{]*\{ box-shadow: inset 0 0 0 1\.5px var\(--green\); \}/.test(css)
  && ratio(light.green, light.ground) >= 3);

// fonts: WOFF2 signature, referenced by the stylesheet, licence next to them
const faces = [...css.matchAll(/url\(\.\.\/(fonts\/[^)]+\.woff2)\)/g)].map((m) => m[1]);
check('the stylesheet uses self-hosted WOFF2 files only', faces.length >= 4 && !/https?:/.test(css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/xmlns='http:\/\/www\.w3\.org\/2000\/svg'/g, '')));
for (const f of new Set(faces)) {
  const b = fs.readFileSync(path.join(ROOT, f));
  check(`${f} is a WOFF2 file`, b.slice(0, 4).toString('latin1') === 'wOF2' && b.length > 10000, `${b.length} bytes`);
}
for (const [dir, family] of [['fonts/archivo', 'Archivo'], ['fonts/jetbrains-mono', 'JetBrains Mono']]) {
  const lic = read(`${dir}/OFL.txt`);
  check(`${family}: SIL OFL 1.1 licence with the copyright line`, /SIL OPEN FONT LICENSE Version 1\.1/.test(lic) && new RegExp(`Copyright 20\\d\\d The ${family} Project Authors`).test(lic));
  check(`${family}: declared in the stylesheet`, css.includes(`font-family: '${family}'`));
}
check('Archivo covers the width axis 62-125 % and weights 400-800', /font-family: 'Archivo';[\s\S]*?font-weight: 100 900;\s*font-stretch: 62% 125%;/.test(css));

// no page loads fonts or styles from elsewhere
// every page of the site: index.html files in the root and its first-level folders (play/, roms/, ...)
const pages = ['index.html', ...fs.readdirSync(ROOT, { withFileTypes: true }).filter((d) => d.isDirectory() && fs.existsSync(path.join(ROOT, d.name, 'index.html'))).map((d) => `${d.name}/index.html`)]
  .map((f) => [f, read(f)]);
check('the site has the landing page and the emulator', pages.some(([f]) => f === 'index.html') && pages.some(([f]) => f === 'play/index.html'));
for (const [f, html] of pages) {
  check(`${f}: links css/tokens.css first`, /<link rel="stylesheet" href="(\.\.\/)?css\/tokens\.css">/.test(html) && (html.indexOf('<style') < 0 || html.indexOf('tokens.css') < html.indexOf('<style')));
  check(`${f}: no font service`, !/fonts\.(googleapis|gstatic)\.com|use\.typekit|fonts\.bunny/.test(html));
}

console.log(fail ? `${fail} FAILED` : 'all token checks passed');
process.exitCode = fail ? 1 : 0;
