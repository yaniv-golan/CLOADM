# Security policy

CLOADM is a static web page: plain ES modules, no build step, no server-side code. Everything runs in the
visitor's browser. Security problems are still possible, and we want to hear about them.

## Reporting a vulnerability

Please report privately through GitHub: on the repository's **Security** tab, choose **Report a vulnerability**
(GitHub's [private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)).
Don't open a public issue, discussion or pull request for a vulnerability before it is fixed.

Include what you can: the affected page and URL parameters, the browser and its version, steps to reproduce, and
what an attacker gains. Never attach ROM files, and never include a real API key: a placeholder is enough.

We will acknowledge the report, keep you informed while we work on a fix, and credit you in the advisory unless
you ask us not to. Only the latest code on `main` (and the site built from it) is supported.

## Scope

These areas matter most.

### The Claude chat API key

The Claude chat terminal uses the visitor's own Anthropic API key. The key lives on the host side only
(`js/host/key-store.js`): it must never reach the emulated machine's memory, a snapshot (`.cloadm` file or quick
slot), a share link, a settings export, the media store, logs or any request except the one to the Anthropic API.
Any path by which the key leaks, is sent elsewhere, or can be read by another origin or by a program running in
the emulator is in scope.

### URL parameters that load remote content

`?rom=URL` (repeatable) makes the page fetch bytes from a URL the link names, and other configuration parameters
(machine, media, autorun) may do the same. In scope: anything that turns a crafted link into
script execution, access to another origin's data, persistent changes the visitor didn't agree to (for example
overwriting stored ROMs, disks or snapshots), or a way around the rule that CLOADM never downloads ROMs from the
Color Computer Archive. Malformed images and files that crash the page are bugs; report them as ordinary issues
unless they cross one of those lines.

### The embed API

Embedding CLOADM in another page and controlling it from JavaScript (`js/embed-api.js`) is in scope:
messages from a page that shouldn't be trusted, an embedder reading data it wasn't given (stored ROMs, disks,
snapshots, the API key), or a framing page driving the emulator in ways the visitor didn't allow.

### The service worker and offline app

The Progressive Web App (`sw.js`) is in scope: cache poisoning, a worker that serves stale
or foreign code after an update, or a scope wider than the site needs.

### Also in scope

* Browser storage (OPFS, `localStorage`) and the File System Access API: reaching files the visitor didn't pick,
  or one site's data from another.
* Web Serial and DriveWire WebSocket channels: a remote endpoint or a program in the emulator escaping to the
  host page.
* The GitHub Actions workflow in `.github/workflows/`.

### Out of scope

* Programs running inside the emulated machine doing what the emulated hardware allows.
* Copyright questions about ROMs: CLOADM includes none. See [README.md](README.md#roms-bring-your-own).
* Vulnerabilities in browsers, MAME or Playwright themselves: report them upstream.
