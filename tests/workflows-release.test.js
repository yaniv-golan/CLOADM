// The release workflow: what it must keep true.
//
// tests/workflows.test.js holds the pins, the triggers and the permissions of every workflow. This suite holds the
// SHAPE release.yml needs, which a pin check cannot see: nothing publishes before the gates are green on the tagged
// commit, the unpinned third-party npm code runs in a job with no write scope, the attestation covers the assets and
// runs no third-party code, the notes are the tagged version's CHANGELOG section and are checked before anything is
// attested, and a hand-started dry run can reach NO publishing step at all.
//
// Every check below is mutation-tested: the shape it guards was broken once, by hand, and the check went red.
// Run: node tests/workflows-release.test.js
const cp = require('child_process'), fs = require('fs'), path = require('path');

let fail = 0;
const check = (name, cond, detail = '') => { if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name} ${detail}`); };

const ROOT = path.join(__dirname, '..');
const WF = path.join(ROOT, '.github', 'workflows');
const read = (f) => fs.readFileSync(path.join(WF, f), 'utf8');
// comments stripped per line: a `# needs: gates` must never satisfy a check that the key is present
const code = (f) => read(f).split('\n').map((l) => l.replace(/\s+#.*$/, '')).join('\n');
const release = code('release.yml'), tests = code('tests.yml');

// The jobs of a workflow, as { key: { needs, if, uses, steps, perms, text } }.
function jobs(text) {
  const out = {}, lines = text.split('\n');
  let inJobs = false, jobIndent = null, cur = null, inPerms = false, folding = 0;
  for (let li = 0; li < lines.length; li++) {
    const l = lines[li];
    if (!l.trim()) { inPerms = false; continue; }
    if (/^jobs\s*:\s*$/.test(l)) { inJobs = true; continue; }
    if (!inJobs) continue;
    const ind = /^\s*/.exec(l)[0].length;
    if (ind === 0) { inJobs = false; continue; }
    if (jobIndent === null) jobIndent = ind;
    if (ind === jobIndent) {
      const m = /^\s*(["']?)([\w-]+)\1\s*:\s*$/.exec(l);
      cur = m ? m[2] : null;
      if (cur) out[cur] = { needs: [], if: null, uses: null, perms: {}, steps: [], text: '' };
      inPerms = false;
      continue;
    }
    if (!cur) continue;
    out[cur].text += l + '\n';
    if (/^\s*permissions\s*:\s*$/.test(l)) { inPerms = true; continue; }
    if (inPerms) {
      const pm = /^\s*([\w-]+)\s*:\s*([\w-]+)\s*$/.exec(l);
      if (pm) { out[cur].perms[pm[1]] = pm[2]; continue; }
      inPerms = false;
    }
    const n = /^\s*needs\s*:\s*(.+)$/.exec(l);
    if (n) out[cur].needs = n[1].replace(/[[\]]/g, '').split(',').map((s) => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
    const u = /^\s*uses\s*:\s*(.+)$/.exec(l);
    if (u) out[cur].uses = u[1].trim();
    const f = /^\s*if\s*:\s*(.*)$/.exec(l);
    if (f) {
      let val = f[1].trim();
      // a folded or literal block (">-", "|") continues on the more-indented lines below
      if (/^[|>][-+]?$/.test(val)) {
        const base = ind;
        val = '';
        for (let k = li + 1; k < lines.length; k++) {
          if (!lines[k].trim()) continue;
          if (/^\s*/.exec(lines[k])[0].length <= base) break;
          val += (val ? ' ' : '') + lines[k].trim();
        }
      }
      out[cur].if = val.trim();
    }
    const s = /^\s*-\s+name:\s*(.+)$/.exec(l);
    if (s) out[cur].steps.push(s[1].trim());
  }
  return out;
}
const J = jobs(release), T = jobs(tests);

// ---------------- release.yml ----------------
{
  check('release.yml has exactly the jobs gates, pack, verify-assets, attest and publish',
    Object.keys(J).sort().join() === 'attest,gates,pack,publish,verify-assets', Object.keys(J).join(', '));

  // the gates are the branch gate, not a second copy of it
  check('release.yml runs the gates by calling tests.yml in place (one gate, not a second copy of it)',
    /^\.\/\.github\/workflows\/tests\.yml$/.test((J.gates || {}).uses || ''), (J.gates || {}).uses);

  // and nothing downstream starts before them
  for (const job of ['pack', 'attest', 'publish']) {
    check(`${job} runs only after the gates (needs includes gates)`, ((J[job] || {}).needs || []).includes('gates'), JSON.stringify((J[job] || {}).needs));
  }
  check('publish runs only after the attestation (needs includes attest)', ((J.publish || {}).needs || []).includes('attest'), JSON.stringify((J.publish || {}).needs));

  // ...and BOTH read the artifact only once verify-assets has confirmed it unpacks where they look. Without the
  // dependency verify-assets still runs and still fails, but a red job nothing needs does not stop a release: a
  // multi-path upload would take the tag down with it instead of the dry run catching it.
  for (const job of ['attest', 'publish']) {
    check(`${job} runs only after verify-assets (needs includes it)`,
      ((J[job] || {}).needs || []).includes('verify-assets'), JSON.stringify((J[job] || {}).needs));
  }

  // THE SPLIT: unpinned npm code in a read-only job
  check('pack is the only job that runs npx', /\bnpx\b/.test(J.pack.text) && !/\bnpx\b/.test(J.attest.text) && !/\bnpx\b/.test(J.publish.text) && !/\bnpx\b/.test(J.gates.text));
  check('pack holds no write permission (the unpinned dependencies cannot reach a token that writes)',
    Object.values(J.pack.perms).every((v) => v === 'read') && !Object.keys(J.pack.perms).some((k) => k === 'contents' && J.pack.perms[k] === 'write'),
    JSON.stringify(J.pack.perms));
  check('attest runs no third-party code (no npx, no run: scripts touching the sources)', !/\bnpx\b/.test(J.attest.text) && !/gh release/.test(J.attest.text));
  check('attest holds the attestation scopes and nothing else that writes',
    J.attest.perms.attestations === 'write' && J.attest.perms['id-token'] === 'write' && J.attest.perms.contents !== 'write',
    JSON.stringify(J.attest.perms));
  check('publish holds contents: write and no attestation scope', J.publish.perms.contents === 'write' && !J.publish.perms.attestations, JSON.stringify(J.publish.perms));
  check('...and the workflow level itself grants only read (no job inherits a write it does not ask for)',
    /^permissions:\n  contents: read$/m.test(release));

  // the attestation covers what is published
  check('attest attests the packed assets', /actions\/attest-build-provenance@[0-9a-f]{40}/.test(J.attest.text) && /subject-path:.*mcpb/.test(J.attest.text),
    (J.attest.text.match(/subject-path:.*/) || [''])[0].trim());
  // BOTH files, not just the first: the extension AND the skill are what `gh release create` uploads, so an
  // attestation naming only the mcpb leaves the zip it publishes unattested. The globs are compared as a set, so
  // dropping either one is red rather than merely "mentions a .mcpb somewhere".
  {
    const globs = ((/subject-path:\s*'?([^'\n]+)/.exec(J.attest.text) || [])[1] || '')
      .split(',').map((s) => s.trim()).filter(Boolean).sort();
    check('attest\'s subject-path names BOTH the extension and the skill zip',
      globs.length === 2 && globs.includes('dist/*.mcpb') && globs.includes('dist/*.zip'), JSON.stringify(globs));
  }

  // verify-assets runs on EVERY run -- a dry run's as well as a tag's. It carries no `if:`, and it must not grow one:
  // a dry run is the only place this hand-off can be caught before a tag, so gating it to tags would restore exactly
  // the blind spot the job was added to remove.
  check('verify-assets has no if: (a dry run checks the artifact hand-off too)',
    (J['verify-assets'] || {}).if === null, JSON.stringify((J['verify-assets'] || {}).if));

  // the notes: from the tag's CHANGELOG section, and checked BEFORE attestation
  check('release.yml takes the notes from the tag\'s CHANGELOG section', /node \.github\/scripts\/release-notes\.js/.test(J.pack.text));
  check('...and that check runs in pack, which is before attest and publish (a bad tag never gets as far as a signature)',
    !/release-notes\.js/.test(J.attest.text) && !/release-notes\.js/.test(J.publish.text));
  check('publish uses --notes-file, never an inline --notes body', /--notes-file\s+\S+/.test(J.publish.text) && !/--notes\s+["']/.test(J.publish.text));

  // THE ARTIFACT'S SHAPE: ONE directory uploaded, and the download plus the file names must equal exactly what attest
  // and publish read. A multi-path upload roots the artifact at the workspace, so downloading into dist/ yields
  // dist/dist/... and both later jobs find nothing -- a bug the gates cannot see and only a dry run or a tag would.
  {
    const upload = (/path:\s*(.+)/.exec(J.pack.text.split('upload-artifact')[1] || '') || [])[1] || '';
    check('the artifact upload is ONE directory (not a multi-path list)', upload.trim() === 'dist/', JSON.stringify(upload.trim()));
    // Step ids are wiring: an `id:` with no `steps.<id>` reader is dead, and AGENTS.md forbids leaving it. THREE YAML
    // spellings count, and a reader that knew only one of them called a mutant green twice: `- id: x` (the step opened
    // by its id), `  id: x` (the id after name:/uses:), and the flow mapping `- { id: x, uses: ... }`. The last has no
    // `id:` at the start of a line at all, so it needs its own pass over every `{...}` -- and since none of the
    // workflows uses flow style today, a check that cannot see one would pass a dead id written that way for good.
    const blockIds = [...release.matchAll(/^(\s*)(?:-\s+|\s)id:\s*(\S+)\s*$/gm)].map((m) => m[2]);
    const flowIds = [...release.matchAll(/^[^\n{]*\{([^}]*)\}/gm)]
      .flatMap((m) => [...m[1].matchAll(/(?:^|,)\s*id:\s*(\S+?)\s*(?:,|$)/g)].map((x) => x[1].replace(/^["']|["']$/g, '')));
    const ids = [...new Set([...blockIds, ...flowIds])];
    const dead = ids.filter((id) => !new RegExp(`steps\\.${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.`).test(release));
    check('every step id in release.yml is read somewhere (no dead wiring)', dead.length === 0, dead.join(', ') || `${ids.length} ids`);
    const dl = [...release.matchAll(/download-artifact[\s\S]{0,200}?path:\s*(\S+)/g)].map((m) => m[1]);
    check('every download unpacks into dist/', dl.length >= 2 && dl.every((p) => p === 'dist'), dl.join(', '));
    // the names attest and publish read must be the names inside that one directory
    const read = [/(subject-path:\s*'?)([^'\n]+)/.exec(J.attest.text), /--notes-file\s+(\S+)/.exec(J.publish.text),
      /gh release create[\s\S]{0,200}/.exec(J.publish.text)].filter(Boolean);
    const names = [...(read[1] ? [read[1][1]] : []), ...((read[2] || [''])[0].match(/dist\/[\w.-]+/g) || [])];
    // each name must be WRITTEN into dist/ by pack -- as a shell redirect (the notes) or as an argument to the tool
    // that makes it (mcpb pack, zip). A notes file at the workspace root, dist-notes.md, would pass a basename-only
    // test and still be missed by the download: that is the bug this block exists for.
    // a path may be written as itself or relative to a `cd skills` subshell (`../dist/x.zip`), so both spellings count
    const esc = (n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const written = (n) => new RegExp(`>\\s*${esc(n)}\\s*$`, 'm').test(J.pack.text)
      || new RegExp(`(?:^|\\s)${esc(n)}(?:\\s|$)`, 'm').test(J.pack.text)
      || new RegExp(`(?:^|\\s)\\.\\./${esc(n)}(?:\\s|$)`, 'm').test(J.pack.text);
    check('attest and publish read files under dist/ that the pack really wrote there',
      names.length >= 3 && names.every((n) => n.startsWith('dist/')) && names.every(written),
      names.map((n) => `${n}:${written(n)}`).join(', '));
  }

  // the ref is passed through env, never interpolated into a shell script
  const runBlocks = release.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
  check('no ${{ }} is interpolated inside a script (the ref reaches a step through env:)',
    !/run:\s*\|[\s\S]*?\$\{\{/.test(runBlocks.replace(/env:\n(?:\s+\w+:.*\n)*/g, '')),
    (release.match(/.*\$\{\{.*/) || [''])[0].trim().slice(0, 90));

  // THE DRY RUN: the only publishing step is in a job a dry run skips. EXACT expressions, not a substring: a guard
  // that is `tag || inputs.dry_run != true` contains "inputs.dry_run != true" and would pass a substring test while
  // running on a dry run (which is the bug this replaces).
  const DRY_GUARD = "github.ref_type == 'tag' && (github.event_name == 'push' || inputs.dry_run != true)";
  check('the publish job is skipped on a dry run, as one exact expression', (J.publish.if || '').replace(/\s+/g, ' ').trim() === DRY_GUARD,
    `got: ${J.publish.if}`);
  check('the attest job is skipped on a dry run too (nothing is signed for a run that publishes nothing)',
    (J.attest.if || '').replace(/\s+/g, ' ').trim() === DRY_GUARD, `got: ${J.attest.if}`);
  check('`gh release create` appears in publish and in NO other job',
    /gh release create/.test(J.publish.text) && !/gh release create/.test(J.pack.text) && !/gh release create/.test(J.attest.text) && !/gh release create/.test(J.gates.text));
  check('a dry run is the default (dispatching by hand without choosing does not publish)',
    /dry_run:[\s\S]*?default:\s*true/.test(release));
  // TWO independent reasons a dry run cannot publish: publish's own guard is false, AND it needs attest, which is
  // skipped. Either alone would do it; both are kept, so removing one guard does not quietly make a dry run publish.
  check('publish also depends on attest, so a dry run skips it transitively as well as by its own guard',
    ((J.publish || {}).needs || []).includes('attest') && ((J.attest || {}).needs || []).includes('pack'), JSON.stringify((J.publish || {}).needs));
  // and the dry-run version comes from CHANGELOG's Next-version line, so it works from main (no tag to name)
  check('the dry-run version comes from CHANGELOG\'s Next-version line (a dry run works from main, with no tag)',
    /nextVersion/.test(J.pack.text), (J.pack.text.match(/.*nextVersion.*/) || [''])[0].trim().slice(0, 80));
}

// ---------------- the notes extractor ----------------
{
  const { notesFor } = require('../.github/scripts/release-notes.js');
  const text = ['# Changelog', '', '## [Unreleased]', '', 'Next version: 9.9.9', '',
    '### Fixed', '', '- a fix waiting for release', '',
    '### 9.9.9', '', '#### Added', '', '- the released feature', '', '#### Changed', '', '- the released change', '',
    '### 9.9.8', '', '#### Added', '', '- an older one', ''].join('\n');
  const notes = notesFor(text, '9.9.9');
  check('notes: the section is the version\'s own, with nothing from [Unreleased] above it or the older release below it',
    /the released feature/.test(notes) && /the released change/.test(notes) && !/a fix waiting/.test(notes) && !/an older one/.test(notes),
    JSON.stringify(notes.slice(0, 80)));
  check('notes: they do not repeat the version heading (the Release page has its own title)', !/^###\s+9\.9\.9/m.test(notes));
  check('notes: "#### Added" is demoted to "### Added" (one level, under the release title)', /^### Added$/m.test(notes) && !/^#### /m.test(notes),
    notes.split('\n').filter((l) => /^#+ /.test(l)).join(' | '));
  // a "### Fixed" INSIDE a released section is part of its notes and must not truncate them
  const withTail = ['### 2.0', '', '#### Added', '', '- a', '', '### Fixed', '', '- b', '', '### 1.9', '', '- older'].join('\n');
  const tailNotes = notesFor(withTail, '2.0');
  check('notes: a "### Fixed" inside a section does not truncate the notes (the guard\'s boundary, not "any ###")',
    /- b/.test(tailNotes) && !/older/.test(tailNotes), JSON.stringify(tailNotes));

  let threw = null;
  try { notesFor(text, '1.2.3'); } catch (e) { threw = e.message; }
  check('notes: a version with no section throws (it is the tag and CHANGELOG.md disagreeing)',
    !!threw && /no "### 1\.2\.3" section/.test(threw), String(threw));
  let emptyThrew = null;
  try { notesFor('### 5.5.5\n\n### 5.5.4\n\n- older\n', '5.5.5'); } catch (e) { emptyThrew = e.message; }
  check('notes: a version whose section is empty throws (not an empty release)', !!emptyThrew && /section is empty/.test(emptyThrew), String(emptyThrew));
  const paren = notesFor('### 7.7.7 (a note after the version)\n\n- hello\n', '7.7.7');
  check('notes: a version heading with a note after it is found by its version', /hello/.test(paren), JSON.stringify(paren));

  const okRun = cp.spawnSync(process.execPath, [path.join(ROOT, '.github', 'scripts', 'release-notes.js'), '0.1.8-pre'], { encoding: 'utf8' });
  check('notes: the script prints the real 0.1.8-pre section and exits 0',
    okRun.status === 0 && !/^#### /m.test(okRun.stdout) && /^### Added$/m.test(okRun.stdout) && okRun.stdout.length > 200,
    `exit ${okRun.status}, ${okRun.stdout.length} bytes`);
  const badRun = cp.spawnSync(process.execPath, [path.join(ROOT, '.github', 'scripts', 'release-notes.js'), '1.2.3-nope'], { encoding: 'utf8' });
  check('notes: the script exits non-zero for a version that does not exist', badRun.status !== 0, `exit ${badRun.status}`);
}

// ---------------- the site, deployed by workflow_run ----------------
{
  const pages = code('pages.yml');
  const P = jobs(pages);
  check('pages.yml has exactly one job, deploy', Object.keys(P).join() === 'deploy', Object.keys(P).join(', '));
  // THE GUARD, as one exact expression: anything else (an ||, an always() &&, a missing clause) must fail here.
  const want = "github.event.workflow_run.conclusion == 'success' && github.event.workflow_run.event == 'push' && github.event.workflow_run.head_branch == 'main' && github.event.workflow_run.head_repository.full_name == github.repository && vars.PAGES_VIA_ACTIONS == 'true'";
  const got = (P.deploy.if || '').replace(/\s+/g, ' ').trim().replace(/^>-? ?/, '');
  check('pages.yml deploys only a successful main push, as one exact expression', got === want, `got: ${got}`);
  // the workflow name must match tests.yml's `name:` exactly, or the trigger never fires
  const testsName = (/^name:\s*(.+)$/m.exec(tests) || [])[1] || '';
  const watched = (/workflows:\s*\[([^\]]+)\]/.exec(pages) || [])[1] || '';
  check('pages.yml watches tests.yml by its exact name (a wrong name never fires)',
    watched.split(',').map((x) => x.trim()).join() === testsName.trim(), `watches [${watched}] vs name "${testsName}"`);
  check('pages.yml deploys the gates\' own SHA, checked out by that SHA',
    /ref:\s*\$\{\{\s*github\.event\.workflow_run\.head_sha\s*\}\}/.test(P.deploy.text));
  check('...and refuses to publish a tree that is not that SHA', /git rev-parse HEAD.*=.*PUBLISHED_SHA/s.test(P.deploy.text));
  check('...with the SHA passed through env:, never inside a run: block',
    /PUBLISHED_SHA:\s*\$\{\{\s*github\.event\.workflow_run\.head_sha\s*\}\}/.test(P.deploy.text));
  check('pages.yml holds pages/id-token write, and nothing else does',
    P.deploy.perms.pages === 'write' && P.deploy.perms['id-token'] === 'write');
  // tests.yml stays READ-ONLY end to end: no pages or id-token anywhere in it (the reason the deploy moved out)
  check('tests.yml requests no pages or id-token scope at all',
    !/\bpages:\s*write/.test(tests) && !/id-token:\s*write/.test(tests));
  check('tests.yml has no deploy job (the deploy is not hosted there)', !T['pages-deploy'] && !Object.keys(T).some((k) => /deploy/i.test(k)), Object.keys(T).join(', '));
  check('pages.yml keeps the two files a Pages deploy needs, and checks them before uploading',
    /test -f site\/\.nojekyll/.test(pages) && /test -f site\/CNAME/.test(pages) && /test -f site\/index\.html/.test(pages));
  check('pages.yml deploys with GitHub\'s own Pages actions, pinned',
    /actions\/upload-pages-artifact@[0-9a-f]{40}/.test(pages) && /actions\/deploy-pages@[0-9a-f]{40}/.test(pages));
  // ONE deploy at a time, not cancelled half way -- and the concurrency is on the JOB, not the workflow: at workflow
  // level a branch's queued run would cancel a PENDING main deploy and then skip, deploying nothing.
  check('ONE deploy at a time, not cancelled half way, and the concurrency is on the JOB',
    /^jobs:\n(?:.*\n)*?    concurrency:\n      group: pages\n      cancel-in-progress: false/m.test(pages)
    && !/^concurrency:/m.test(pages), (/^concurrency:/m.test(pages) ? 'workflow-level concurrency present' : ''));
  // a re-run of an older main, or an out-of-order completion, must not put stale bytes over a newer deploy -- and it
  // SKIPS cleanly (notice + exit 0 + publish=false), it does not fail: a superseded run is not a broken one
  check('it refuses to publish when main has moved on (an older commit cannot overwrite a newer deploy)',
    /git ls-remote origin refs\/heads\/main/.test(P.deploy.text) && /main_now" != "\$PUBLISHED_SHA/.test(P.deploy.text));
  check('...and a superseded run SKIPS (::notice:: and publish=false), it does not fail',
    /::notice::.*skips/.test(P.deploy.text) && /echo "publish=false" >> "\$GITHUB_OUTPUT"/.test(P.deploy.text)
    && /echo "publish=true" >> "\$GITHUB_OUTPUT"/.test(P.deploy.text) === true);
  // ...and "skips, rather than fails" is the EXIT CODE inside that same branch, not a property of the job. A bare
  // `publish=false; exit 1` would leave every string above intact and fail the run it was supposed to let through, so
  // the branch is read as one block and its exit code asserted there: 0 for a superseded run, and the HEAD-mismatch
  // guard above it still 1.
  {
    const m = /if \[ "\$main_now" != "\$PUBLISHED_SHA" \]; then\n([\s\S]*?)\n\s*fi\n/.exec(P.deploy.text);
    const branch = m ? m[1] : '';
    check('...and that branch exits 0, so a superseded run is a SKIP and not a failure',
      /echo "publish=false"/.test(branch) && /^\s*exit 0\s*$/m.test(branch), m ? 'branch found' : 'branch not found');
  }
  check('...while a checkout that is not the gated SHA IS a hard failure',
    /test "\$\(git rev-parse HEAD\)" = "\$PUBLISHED_SHA" \|\| \{ echo "checked out/.test(P.deploy.text));
  // the upload and the deploy run only when the stage step said so
  {
    const conds = [...P.deploy.text.matchAll(/- if:\s*(.+)\n(?:\s+\w+:.*\n)*?\s+uses: actions\/(upload-pages-artifact|deploy-pages)/g)].map((m) => m[2] + ' <- ' + m[1].trim());
    check('the upload and the deploy are gated on steps.stage.outputs.publish == \'true\'',
      conds.length === 2 && conds.every((c) => /steps\.stage\.outputs\.publish == 'true'$/.test(c)), conds.join(' | '));
  }
  // an injected head_branch must not reach a shell: the ref values stay in env: and out of run: blocks
  {
    const runBlocks = [...P.deploy.text.matchAll(/run:\s*[|>][\s\S]*?(?=\n\s{6}- |\n\s{4}\w|$)/g)].map((m) => m[0]);
    const injected = runBlocks.filter((b) => /\$\{\{\s*github\.event\.workflow_run\./.test(b));
    check('no run: block interpolates a workflow_run value (an injected head_branch cannot reach a shell)', injected.length === 0,
      injected.map((b) => b.slice(0, 70)).join(' | '));
  }
}

// Read-only means nothing but read, in this file's own terms (tests/workflows.test.js has the full reader with its
// self-checks; this suite only needs the verdict for the callee's workflow-level block).
const readOnlyPerms = (perms) => !!perms && Object.entries(perms).every(([k, v]) => (k === '*' ? v === 'read-all' : v === 'read'));
const workflowLevelPerms = (text) => {
  const ls = text.split('\n');
  const i = ls.findIndex((l) => /^permissions\s*:/.test(l));
  if (i < 0) return null;
  const body = [ls[i]];
  for (let k = i + 1; k < ls.length && !/^\S/.test(ls[k]); k++) body.push(ls[k]);
  const map = {};
  for (const l of body.slice(1)) { const m = /^\s*([\w-]+)\s*:\s*([\w-]+)/.exec(l); if (m) map[m[1]] = m[2]; }
  const inline = /^permissions\s*:\s*(\w+)\s*$/.exec(ls[i]);
  if (inline) map['*'] = inline[1];
  return map;
};

// ---------------- a callee may not ask for more than its caller grants ----------------
// GitHub refuses a called workflow at load time when any of its jobs requests a permission the call site does not
// grant, BEFORE any `if:` is looked at. This is the check that would have caught a deploy job inside tests.yml being
// called by release.yml with contents: read only.
{
  const scope = (v) => (v === 'write' ? 2 : v === 'read' ? 1 : 0);
  // every `uses: ./...` call: the caller's job block, and the callee's job blocks
  const calls = [];
  for (const f of fs.readdirSync(WF)) {
    if (!/\.ya?ml$/.test(f)) continue;
    const text = code(f), J = jobs(text);
    for (const [name, j] of Object.entries(J)) {
      if (!j.uses || !j.uses.startsWith('./')) continue;
      calls.push({ caller: f, job: name, callee: j.uses.replace('./', ''), grant: j.perms });
    }
  }
  check('there is at least one reusable call to check', calls.length > 0, `${calls.length}`);
  for (const c of calls) {
    const calleeText = code(path.relative(WF, path.join(ROOT, c.callee)));
    const CJ = jobs(calleeText);
    const over = [];
    // every job's block, AND the callee's workflow-level block: a workflow-level `pages: write` is granted to every job
    // that does not override it, and a caller that reduced its own grant would be refused at load time all the same
    const blocks = [...Object.entries(CJ).map(([n, j]) => [`job ${n}`, j.perms]), ['workflow', workflowLevelPerms(calleeText) || {}]];
    for (const [where, perms] of blocks) {
      for (const [k, v] of Object.entries(perms)) {
        const granted = k === '*' ? (c.grant['*'] === 'write' ? 2 : 1) : scope(c.grant[k]);
        if (scope(v) > granted) over.push(`${where}.${k}=${v} (caller grants ${c.grant[k] || 'none'})`);
      }
    }
    check(`${c.caller}: ${c.job} -> ${c.callee} requests nothing above the caller's grant`, over.length === 0, over.join('; '));
  }
  // the check bites both ways: a callee asking for more than the caller grants, and a caller whose grant was REDUCED
  {
    const overGrant = [[{ contents: 'read' }, { contents: 'read', pages: 'write' }], [{ contents: 'read' }, { 'id-token': 'write' }]]
      .filter(([grant, perms]) => Object.entries(perms).some(([k, v]) => scope(v) > scope(grant[k])));
    check('a callee asking above the caller is caught (pages: write, id-token: write)', overGrant.length === 2, `${overGrant.length} of 2`);
    // a REDUCED grant: contents: none or a deleted block, against a callee that reads contents
    const reduced = [[{ contents: 'read' }, { contents: 'read' }, false], [{ contents: 'none' }, { contents: 'read' }, true]]
      .filter(([grant, perms, expect]) => Object.entries(perms).some(([k, v]) => scope(v) > scope(grant[k])) === expect);
    check('a caller whose grant is reduced below the callee\'s need is caught (contents: none, or no block)', reduced.length === 2, `${reduced.length} of 2`);
  }
}

// ---- `gh` needs to know the repository ----
// A job with no checkout has no git repository, so `gh release create` (and every other gh command) fails with "not a
// git repository" unless GH_REPO is in the step's env or the command says --repo. The publish job went to a tag without
// it: a dry run skips publish (its `if` wants a tag), so nothing ran that gh invocation. This reads the workflow files
// instead, and runs inside `gates` (tests.yml runs every suite), which a dry run does run.
// -> the [job, step] pairs whose run block calls `gh` in a job with no checkout and no GH_REPO / --repo
function ghWithoutRepo(text) {
  const bad = [];
  for (const [name, j] of Object.entries(jobs(text))) {
    if (/uses\s*:\s*actions\/checkout@/.test(j.text)) continue;
    // steps: split at the "- " that starts each one (the first key may be on that line)
    const steps = j.text.split(/^(?=\s*-\s)/m);
    for (const st of steps) {
      const run = /^\s*(?:-\s+)?run\s*:\s*([\s\S]*)$/m.exec(st) || /^\s+run\s*:\s*([\s\S]*)$/m.exec(st);
      if (!run || !/(^|[\s;&|(`$])gh\s+[a-z]/.test(run[1])) continue;
      if (/^\s*GH_REPO\s*:\s*\S/m.test(st) || /--repo[\s=]|\s-R\s/.test(run[1])) continue;
      bad.push(name);
    }
  }
  return bad;
}
{
  const files = fs.readdirSync(WF).filter((f) => /\.ya?ml$/.test(f));
  const ghFiles = files.filter((f) => /(^|[\s;&|(`$])gh\s+[a-z]/.test(code(f)));
  check('(set-up) release.yml calls gh, so the check below has something to look at', ghFiles.includes('release.yml'), ghFiles.join(' '));
  for (const f of files) {
    const bad = ghWithoutRepo(code(f));
    check(`${f}: every job that runs gh checks out, or sets GH_REPO, or says --repo`, bad.length === 0, bad.join(', '));
  }
  // the check bites: synthetic workflows (a job's text is all it reads)
  const wf = (steps, checkout = false) => `name: x\non: push\njobs:\n  publish:\n    runs-on: ubuntu-24.04\n    steps:\n${checkout ? '      - uses: actions/checkout@abc\n' : ''}${steps}`;
  const noRepo = `      - name: Publish\n        env:\n          GH_TOKEN: x\n        run: |\n          gh release create "$T" a.zip\n`;
  const withEnv = `      - name: Publish\n        env:\n          GH_TOKEN: x\n          GH_REPO: \${{ github.repository }}\n        run: |\n          gh release create "$T" a.zip\n`;
  const withFlag = `      - name: Publish\n        run: |\n          gh release create "$T" a.zip \\\n            --repo "$R"\n`;
  const noGh = `      - name: Build\n        run: |\n          echo "ghost story" > x\n`;
  check('a job with no checkout and a bare gh is caught', ghWithoutRepo(wf(noRepo)).length === 1, JSON.stringify(ghWithoutRepo(wf(noRepo))));
  check('... it is fine with a checkout', ghWithoutRepo(wf(noRepo, true)).length === 0);
  check('... fine with GH_REPO in the step\'s env', ghWithoutRepo(wf(withEnv)).length === 0);
  check('... fine with --repo on the command', ghWithoutRepo(wf(withFlag)).length === 0);
  check('... a step with no gh command (a word that merely starts with gh) is not flagged', ghWithoutRepo(wf(noGh)).length === 0);
  check('... GH_REPO in ANOTHER step does not cover this one', ghWithoutRepo(wf(withEnv.replace('gh release', 'echo') + noRepo)).length === 1);
}

console.log(fail ? `${fail} FAILED` : 'all release-workflow checks passed');
process.exitCode = fail ? 1 : 0;
