<!--
Follow AGENTS.md (it applies to human and agent contributors alike). Above all: no ROM files, ever.
Give the evidence below and no claims beyond it. Delete a section's hint once you've filled it in.
-->

## What changed

Files touched and a one-paragraph design summary. Related issue, if any: #

## Commands run and their results

Short excerpts of the output, not just "passed".

- `node tests/all.js` (summary line):
- `node tests/regress.test.js`:
- `node tools/mame-diff/run.js <profile> [...]` for each affected profile (instruction count, "identical", HALT reached):
- `--video`, byte or audio comparisons (frames or bytes compared, tolerance):
- `node tools/browser-check.js`:

## New tests and firmware

What each new test file, case or firmware source covers.

## Deviations from MAME

Each with its primary source and where it is documented in docs/verification.md ("Deviations from MAME"). Write "none" if there are none.

## Not verified

Everything that couldn't be checked automatically, with the manual steps and their result. Write "none" only if that is true.

## Checklist

- [ ] No ROMs, ROM-derived data or links to ROMs are added.
- [ ] `tests/regress-hashes.json` is unchanged, or every change is justified above with the MAME comparisons for the affected profiles.
- [ ] README.md and docs/ (feature tables, docs/verification.md, the commands in docs/development.md) are updated where the change affects them.
