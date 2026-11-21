# Readability (development only)

`Readability.js` is Mozilla's Readability 0.6.0 (the npm package `@mozilla/readability`, the standalone version of
the library behind Firefox Reader View), copied unmodified (SHA-256
`34dcab3d0832d0019f02990eed6b6124e029e8c32b9f0c6f2550544ff8dff174`). Copyright (c) 2010 Arc90 Inc, under the
Apache License 2.0 (`LICENSE.md`, and the header of the file itself).

It is a development tool, like Playwright: the browser check (`tools/browser-check.js`, group `semantics`) adds it
to the play page it is testing, as a stand-in for a browser's reading mode, and checks what it extracts. The site
never loads it, nothing under `js/` imports it, and it is not in the offline file list (`sw.js`).
