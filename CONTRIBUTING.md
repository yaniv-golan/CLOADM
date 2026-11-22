# Contributing to CLOADM

Thank you for helping. CLOADM is plain JavaScript with no build step and no runtime dependencies.

## Code

Everyone, human or coding agent, follows [AGENTS.md](AGENTS.md): the hard rules (above all, no copyrighted ROMs,
ever), where code goes, and the proof a change needs before it counts as done (`node tests/all.js`, the
regression hashes, the comparison with MAME for anything the hardware does, and `node tools/browser-check.js`).

Found a problem? [Open an issue](https://github.com/yaniv-golan/cloadm/issues). Missing a name in the credits?
A pull request adding it to [CREDITS.md](CREDITS.md) is always welcome.

Everyone here follows the [Code of Conduct](CODE_OF_CONDUCT.md). Security problems are reported privately, never in
an issue: use GitHub's **Report a vulnerability** button (see [SECURITY.md](SECURITY.md)).

### What CI runs, and what it does not

Every push to `main`, `claude/**` or `ds/**` runs the gates on the pushed commit. A pull request into `main` runs
them too, on the merge result GitHub builds for it (`refs/pull/N/merge`), not on the branch head: the push run is
the proof for the branch, and the PR run is the proof that merging it keeps `main` green. Either way the gates are
`node tests/all.js` (every suite, the regression hashes included) and `node tools/browser-check.js` (the real pages in
headless Chromium), with the browser check split over four parallel shards, all on a pinned `ubuntu-24.04` image.

The run's jobs are `browser-check shards are complete` (every browser-check group is in exactly one shard),
`node tests/all.js`, `browser check <shard>` (one per shard), and `gates`, which is green only if every other job
passed; its summary is where the commit, its tree hash and each job's counts are read.

Other branches run on demand (Actions → tests → Run workflow). The workflows are read like any other code, and every
action in them is pinned to a commit SHA: `tests/workflows.test.js` checks that, and that `pull_request_target` is
never used.

CI has **no MAME and no ROMs**. That is deliberate and should stay that way: nothing in CI needs a copyrighted ROM and
nothing downloads one. So the comparisons with MAME (`tools/mame-diff/run.js`,
`run-tape.js`, the video, sound and disk-image checks) do **not** run there. They are the local gate, described in
[AGENTS.md](AGENTS.md) §4.4; run them with a MAME install before a hardware change counts as done. A green
badge means the suites and the pages pass; it does not mean the hardware verification was run.

## Homebrew: put your program on the shelf

CLOADM opens with programs that run without any ROMs: today the welcome program, LIZA and the colour demo, all
written for the project. We'd love to add yours: a game, a demo, a tool, new or from 1984.

What a program needs:

* **It runs without ROMs.** Without BASIC ROMs, CLOADM runs a small built-in firmware that provides only the
  ROM's keyboard (`POLCAT`) and character output (`CHROUT`) entry points. Programs that call other ROM routines
  won't run on it. Load your program on the page with no ROMs added to check.
* **It's yours to give.** You wrote it, or you hold the rights to it.
* **Written permission and a licence that allows redistribution.** CLOADM is redistributed in many places (the
  website and copies people host themselves), so the program's licence has to allow that.
  Any licence that permits copying and redistribution works: MIT (CLOADM's own), BSD, CC BY, CC BY-SA, or the
  text below.

Open an issue or a pull request with the program (source if you're willing, the binary in any case) and this
permission, filled in. It is recorded in [CREDITS.md](CREDITS.md) with your name.

```
I, [your name], am the author and rights holder of [program name] ([year]),
written for the [Dragon 32 / Dragon 64 / Color Computer / MC-10 ...].

I give the CLOADM project permission to include [program name] in CLOADM and to
redistribute it, unchanged, as part of CLOADM and of copies of it, under this licence:
[MIT / CC BY 4.0 / another licence that allows redistribution].

Credit it as: [how you'd like to be named, and a link if you like].

[signature or GitHub account] [date]
```

We bundle nothing without this. Programs from magazines and commercial titles are copyrighted by their
publishers or authors: please don't send them unless you hold the rights.
