// Run: node tests/version.test.js
//
// The version stamp "v<version> · <short commit>" (js/version.js): its version is CHANGELOG.md's "Next version"
// (tools/version.js --write copies it), the repository's copy holds no commit, and the Pages deploy stamps the
// commit it publishes into its staged copy (tools/version.js --stamp, a line in .github/workflows/pages.yml that runs
// before tools/ is removed from the staged site). Help, About and the settings drawer show it (data-version-stamp).
const fs = require('fs'), path = require('path'), os = require('os'), cp = require('child_process');
const ROOT = path.join(__dirname, '..');
const { nextVersion, read, withVersion, withCommit, FILE } = require('../tools/version.js');

let fail = 0;
const check = (name, cond, detail = '') => { if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name} ${detail}`); };
const run = (args) => cp.spawnSync(process.execPath, [path.join(ROOT, 'tools/version.js'), ...args], { encoding: 'utf8' });

(async () => {
  const src = fs.readFileSync(FILE, 'utf8'), cur = read(src);
  check('js/version.js holds CHANGELOG.md\'s "Next version" (after changing it run: node tools/version.js --write)', cur.version === nextVersion(), `${cur.version} vs ${nextVersion()}`);
  check('the repository\'s js/version.js holds no commit (only the deploy stamps one)', cur.commit === '');
  check('tools/version.js --check agrees', run(['--check']).status === 0);
  check('nextVersion reads the [Unreleased] line, not a released one', nextVersion('## [Unreleased]\n\nNext version: 9.8.7-pre (x).\n\n### 1.0.0\n\nNext version: 0.0.1\n') === '9.8.7-pre');

  const { versionStamp, VERSION, COMMIT } = await import('../js/version.js');
  check('unstamped, the stamp says so', versionStamp() === `v${VERSION} · unstamped` && COMMIT === '', versionStamp());
  check('stamped, the stamp is the version and the 7-character commit', versionStamp('0.2.0', '1b890e51d74a14d4d52e5be4ebd2683eb3062e8d') === 'v0.2.0 · 1b890e5');

  // --stamp on a staged copy, as the deploy runs it; then the module, loaded from there, names the commit
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'version-'));
  try {
    const staged = path.join(dir, 'version.mjs');
    fs.writeFileSync(staged, src);
    const sha = 'd5220433797b48f0377964693d63b52beb8edf3e';
    const r = run(['--stamp', staged, sha]);
    const m = await import(staged);
    check('--stamp writes the commit into the staged copy, and its stamp names it', r.status === 0 && m.COMMIT === sha && m.versionStamp() === `v${VERSION} · d522043`, r.stderr);
    check('--stamp refuses anything that is not a commit hash', run(['--stamp', staged, 'main; rm -rf /']).status !== 0);
    check('--stamp never writes the repository\'s own js/version.js', run(['--stamp', FILE, sha]).status !== 0 && fs.readFileSync(FILE, 'utf8') === src);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  check('withVersion / withCommit change only their own line', withCommit(withVersion(src, '1.2.3'), 'abcdef1').split('\n').filter((l, i) => l !== src.split('\n')[i]).length === 2);

  // the deploy: stamps the gated SHA into the staged copy, after archiving and before tools/ is removed
  const pages = fs.readFileSync(path.join(ROOT, '.github/workflows/pages.yml'), 'utf8');
  const at = (t) => pages.indexOf(t);
  const STAMP = 'node tools/version.js --stamp site/js/version.js "$PUBLISHED_SHA"';
  check('pages.yml stamps the published commit into the staged js/version.js', at(STAMP) > 0 && at('git archive HEAD | tar -x -C site') < at(STAMP) && at(STAMP) < at('rm -rf site/.github site/.git site/tests site/tools'));

  // the pages that show it
  for (const [file, id] of [['help/index.html', 'helpVersion'], ['about/index.html', 'aboutVersion'], ['play/index.html', 'drawerVersion']]) {
    const html = fs.readFileSync(path.join(ROOT, file), 'utf8');
    check(`${file} has a version stamp (#${id})`, new RegExp(`id="${id}" data-version-stamp`).test(html));
  }
  for (const file of ['help/index.html', 'about/index.html']) check(`${file} loads the stamp`, fs.readFileSync(path.join(ROOT, file), 'utf8').includes('<script type="module" src="js/ui/version-stamp.js"></script>'));
  check('the emulator loads the stamp (js/ui/main.js)', /import '\.\/version-stamp\.js';/.test(fs.readFileSync(path.join(ROOT, 'js/ui/main.js'), 'utf8')));
  check('the stamp is not on the main chrome (the app bar has none)', !/data-version-stamp/.test((/<header[^>]*id="appbar"[\s\S]*?<\/header>/.exec(fs.readFileSync(path.join(ROOT, 'play/index.html'), 'utf8')) || [''])[0]));
  process.exitCode = fail ? 1 : 0;
  console.log(fail ? `${fail} FAILED` : 'all passed');
})();
