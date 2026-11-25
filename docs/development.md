# Development

[CLOADM](../README.md) › Development

## Running it locally

Run it locally with any static server: `python3 -m http.server`, then open `http://localhost:8000/play/`
(`http://localhost:8000/` is the landing page). Opening the files straight from disk shows how instead: browsers
don't load ES modules from `file://`.

The tests, tools and browser check need Node 22.12 or later; CI runs Node 22. On a newer Node an unhandled rejection
would end the process, so the browser check records one as a FAIL in the group that was running (with its reason) and
goes on to the next group; the run still exits 1.

## The command line and the Node API

`node cli/cloadm.js` runs any model headless from a script or CI: load a program, type, wait for text on the screen,
a byte or the PC, read the screen, memory and registers, step and disassemble, save PNGs and snapshots, with `--json`
output, exit codes and error codes; `--describe` gives the whole interface as JSON. `node cli/cloadm.js --mcp` is the
MCP server for coding agents ([mcp.md](mcp.md)): the tools in `js/mcp/tools.js`, transport-neutral, mounted on stdio
by `cli/mcp.js`.
[automation.md](automation.md) is the guide, with the Node API under it and what of it is stable.

## The fast loop

The full gates are slow (`node tests/all.js` about 5-6 minutes, the whole browser check 15-20), so while you work run the
suites and groups for what you changed: `node tests/all.js --only <part of a name>[,...]` runs the suites whose file
names contain one of the parts, and `node tools/browser-check.js --only <group>[,...]` the browser-check groups
(`--list-groups` lists them).

| You changed | Suites (`tests/all.js --only ...`) | Browser-check groups (`--only ...`) |
|---|---|---|
| `js/cpu/` (6809, 6309, 6803) | `cpu,opcodes,disasm,asm,nmi-arm,regress` | `models,cpu6309` |
| Video: `js/chips/` VDG, SAM, GIME, 6845, `js/video/` | `video,mc6847,mc6845,coco3,gime-vsc,composite,sammem,samrate,regress,state` | `models,display,glLoss` |
| Machines and profiles (`js/machines/`) | `machine,models,bus,coco3,mc10,alpha,d64plus,stub-sam,state,snapshot,regress` | `models,powerOn` |
| Floppy disks, `js/media/` | `fdc,disk,detect,state` (`disk` also selects the `disks*` suites) | `disk,media` |
| Cassette | `tape` (also `tape-sound`) | `tape,tapePanel,tapeHud` |
| Cartridges and sound chips | `bus,carts,ssc,sp0256,ay8910,audio` | `cartridge,sscBoard,audio` |
| Serial, printer, DriveWire | `serial,serial-api,acia,drivewire,web-serial` | `driveWire,webSerial,printer` |
| The assembler (`js/asm/`) | `asm,includes,disasm` | `debugger` |
| Debugger | `debugger,debug-session,halt,probes,writewatch` | `debugger,debuggerScreen` |
| Keyboard and input | `input,keyqueue,keyboard-symbols,touch-joystick,press-break` | `input,inputScreen,touchJoystick,keyboardSymbols,typing` |
| `js/session.js`, snapshots | `session,snapshot,state,restore-points,writewatch` | `snapshot,state` |
| `js/drives.js` (the floppy drives) | `session-drives,disks,disks-newdisk,disk-bare,disks-mount-case,disks-mount-race,restore-points` | `disk,driveWire` |
| `js/library.js` (the media library) | `session-library,storage-move,move-inflight,library-case,recent,store-error-names,media-store,media-index-settled,media-multitab,store-races` | `library,librarySelect,mediaBackend` |
| The Claude chat and Ask Claude | `claude,chat-firmware` | `claude,ask,commands,chatScreen` |
| `cli/` (the command line and the MCP server) | `cli,mcp,game-guide,starter-game` | none |
| `connector/` (the side-panel connector) | `connector,mcp,skill` | `connector` |
| `examples/` (a program or game) | `pwa,starter-game,game-guide,welcome` and the example's own suite | `pwa` (and the group that offers it) |
| `js/ui/`, `play/`, `css/`, `index.html` | `session,readme,screen-alternative` | the panel's groups, `semantics` and `menuWords` (a label's words, in every menu and sheet; CI attempt 1 runs every group) |
| Docs (`README.md`, `docs/`) | `readme,romdocs,game-guide,dev-docs-headless,disk-read-example` | none |
| `CHANGELOG.md` | `changelog` | none |
| The test runner (`tests/all.js`, `suite-verdict.js`, `no-exit.js`) | `allsummary,allsignal,allsched,suite-shards,exitguard,exitcode` | none |
| `tools/browser-check*.js`, `.github/` | `browser-check` | the groups it touches |

A subset run says `SUBSET RUN (--only ...), not the full gate` on its summary line: it is never the proof. The full
gates are still required:

* **before every push (the local gate):** `git fetch --tags` and `node tests/all.js` in full (the regression hashes
  included), plus `node tools/browser-check.js --only <groups>` for the groups in the table's row(s) for what you
  changed, with nothing else running on the machine. Look at their screenshots (`--screenshots DIR`);
* **a change touching NitrOS-9, disks or CoCo 3 boot:** also `node tools/nitros9/fetch.js`, then `--only nitros9` with
  the images present (CI has none and only SKIPs it); say in the report that it ran;
* **before you call the change done:** a green CI run, attempt 1, on the exact commit you report (AGENTS.md section 4).
  Attempt 1 runs every browser-check group: it is the full browser gate, and it is never re-run;
* **the whole check in one process** runs daily in CI (`browser-daily.yml`, on `claude/v0.2-stage` and `main`; not a
  gate). Run it locally when you want that coverage before CI, e.g. after a change to shared page code.

When a full run fails, its last line names the failing suites (`FAILED: a.test.js, b.test.js`); rerun just those with
`--only` while you fix them, then the full gate again.

### Before you push

`node tools/affected.js [<base>]` prints the two `--only` commands for the files changed since `<base>` (default
`origin/main`): this table, as data. A page file no row knows (`js/ui/`, `css/`, `play/`) adds a fixed smoke set of
groups (`models,semantics,pwa,uiQa,layout`). `node tools/prepush.js [--base <ref>]` is the author's checklist in one
go: those suites and groups, then the full `node tests/all.js`; `sw.js`'s file list in step; `CHANGELOG.md` changed
only under `[Unreleased]`; the two skill copies identical; a noreply `user.email`; the release tags present (fetched if
not); and a report skeleton with the levels the change doesn't need marked not applicable. Neither is the gate.

## Tests and tools

Contributors follow [AGENTS.md](../AGENTS.md): the rules, where code goes, and the proof required before a change
counts as done.

CI (`.github/workflows/tests.yml`) runs the gates on every push to `main` and to contributor branches (`claude/**`,
`ds/**`) on the pushed commit, and on every pull request into `main` on the merge result GitHub builds for it
(`refs/pull/N/merge`, so that run's SHA is a merge commit, not the branch head). Other branches: Actions → tests →
Run workflow. The gates are `node tests/all.js`, run as three parts on three runners (`--shard i/n`, planned from
`tests/suite-times.json`), and the browser check split into parallel shards (`--only <groups>`, listed in
`.github/browser-check-shards.json`). The run's jobs are `browser-check shards are complete` (and the matrix it plans),
one `node tests/all.js <part>` per part, one `browser check <shard>` per shard, and `gates`, which is green only if
every other job passed. `gates` also runs `node .github/scripts/suite-shards.js` on the parts' logs: every part
reported, the parts' suite lines are every suite `node tests/all.js --list` names, each once, the counts sum to the
total, and the regression gate's completeness was checked once. Its summary lists every FAIL line of every job.

The browser shards are generated: `node .github/scripts/browser-check-shards.js --write` plans them from the group
times in `.github/browser-check-timings.json` (longest group first onto the least-loaded shard; `"shards"` there sets
how many). Without arguments the script fails if a group is in no shard, in two, isn't a group, has no time, or if the
shard file is not the plan (stale or edited by hand); it reads the groups from `node tools/browser-check.js
--list-groups`, the `GROUPS` table itself. After adding a group: `node tools/browser-check.js --only <group> --timings
t.json`, then `node .github/scripts/browser-check-shards.js --merge t.json`. Every CI run publishes its own times as
the `browser-check-timings` artifact (merge it to rebalance: `--merge` keeps a smoothed average per group, weighted by the timings file's `"smoothing"`, so one noisy run cannot swing the plan), and `node tests/all.js --record-times` rewrites
`tests/suite-times.json` from a passing whole run (`--timings FILE` writes one run's or one part's times elsewhere). A green run's `gates` summary (commit SHA, tree hash, each job's counts) is the
definition of done; see AGENTS.md section 4.

The browser shards install chromium's OS packages with `.github/scripts/install-browser-deps.sh`. The .deb files are
cached per runner image (`playwright-debs-<playwright>-<ImageOS>-<ImageVersion>`). On a new image the step restores
the newest cache of an earlier image of the same OS, and it saves the cache right after a good install. On a cache
miss, each try asks a different apt mirror (azure.archive.ubuntu.com, the image's own, archive.ubuntu.com), each
under its own time limit, so a stalled mirror costs one try rather than failing the shard. Playwright's
`install-deps --dry-run` check still decides whether the step passes.

Every action in the workflows is pinned to a commit SHA with its release tag beside it, and `pull_request_target` is
never used; `node tests/workflows.test.js` holds both, and that an action used in more than one workflow carries the
same SHA in each (so a bump cannot be applied to one file and not another). `.github/dependabot.yml` proposes the
bumps weekly.
`node tests/workflows-release.test.js` holds `release.yml`'s shape: it runs the gates (`release.yml` calls
`tests.yml` in place) before anything is packed; the unpinned `npx` code runs in a job with no write scope; the
attestation covers the assets and runs no third-party code; and the notes are the tagged version's CHANGELOG section,
checked before anything is signed.

**The site** is deployed by `pages.yml`, on a `workflow_run` of the gates: when `tests` finishes successfully for a
push to `main`, it deploys exactly the SHA those gates ran on (`github.event.workflow_run.head_sha`), and nothing else
does -- not a branch, a pull request or a tag. A red `main` never publishes, and an older commit cannot overwrite a
newer deploy (it refuses unless `main` still points at the commit it gated). It is a separate workflow because a
CALLED workflow's jobs may not request more than the caller grants, and `release.yml` calls `tests.yml` with
`contents: read`; a deploy job inside `tests.yml` would be refused at load time and every tag release would die.

**It does nothing until you switch Pages over.** The job's guard includes `vars.PAGES_VIA_ACTIONS == 'true'`, a
repository variable that does not exist yet, so every run skips and legacy Pages keeps serving `main` as it does today.
Merging it therefore changes nothing, and merge order does not matter. (The `github-pages` environment allows `main`,
so once a deploy does run, a `main` push's deploy is accepted.)

**Publishing the site: the procedure, in this order.**
1. **Settings -> Pages -> Source = "GitHub Actions"**. The legacy build stops publishing `main` from this point.
2. **Settings -> Secrets and variables -> Actions -> Variables -> New variable**: `PAGES_VIA_ACTIONS` = `true`. From
   here a successful `main` push deploys.
3. **Re-run the latest green `tests` run on `main`** (Actions -> tests -> the run -> *Re-run all jobs* on its first
   attempt), or push any commit; then open <https://cloadm.dev> and check the site is the new build.
   Expect a short gap between steps 1 and 3 -- from the source switch until the first deploy lands, nothing publishes
   the site -- so do steps 1 and 3 back to back.

The version stamp (Help, About, the settings drawer, bug reports) names the commit only on a site published this way:
the deploy stamps it into its staged `js/version.js` (`node tools/version.js --stamp`). Until the switch above, the
legacy build serves the repository as committed, and the stamp reads "v<version> · unstamped".

**A dry run of the release, after this lands on `main`**: GitHub -> Actions -> **release** -> *Run workflow* -> branch
**main**, leave `dry_run` **checked** (it is the default) -> *Run workflow*. Dispatching it from a TAG with `dry_run`
unchecked PUBLISHES that tag -- the dry run is only a dry run because it is started from a branch with the box on.
It runs the gates, packs the extension, checks the artifact hand-off, and checks the notes for `CHANGELOG.md`'s current
"Next version" line -- and skips `attest` and `publish` by their own `if:` conditions, so no Release is created and no
write scope is used.

Don't run anything else on the machine while the browser check runs: it is timing-sensitive under load.

```
node tests/all.js            # every suite below in a worker pool (--jobs N to cap it; each regress shard is a slot; started longest first from tests/suite-times.json, which --record-times rewrites after a passing full run), one line each, the regression gate included (exit 0 = all passed, and every suite must also have printed its summary line: one that exits 0 half done is a failure); a failing run ends with FAILED: <the suites>; --only <part>[,...] runs a subset, marked as not the gate
node tools/browser-check.js  # the real pages in Chromium: the landing page (desktop and phone) and /play/: every model, LIZA end to end, the file:// notice, Share and opening snapshots, the favicon and no missing file requested by any page; the feedback model (toasts on the page the user is on, cleared by the next action, Undo, Details, desktop and phone). Every "← Emulator", Esc and Back return to the emulator, from `/play/` and `?app=claude`, after a reload and from a page loaded on a view (`--only emulatorBack`). `--only feedback,library` runs just those groups (an unknown group is an error); see "What the gates' results mean" below
node tools/capture-images.js # recapture img/*.png (site and README pictures) from the emulator, with no ROMs
node tools/program-cards.js  # the program pages 2048/, liza/, minesweeper/ and their 1200x630 cards (img/card-*.png), on the built-in firmware; updates sw.js
node tools/capture-og.js     # recapture img/og.png, the 1200x630 link preview (og:image), from the welcome menu with no ROMs, through js/video/bezel.js
node tools/capture-gif.js    # recapture img/readme-demo.gif (the README's looping picture), with no ROMs; tools/gif.js is its encoder
node tests/cpu.test.js       # 6809 instruction tests, scripted (all tests load js/emu.js via tests/load.js)
node tests/opcodes.test.js   # 126 instructions table-driven from the MC6809 data sheet: result, flags and cycles
node tests/machine.test.js   # headless machine test with the stub firmware and demo
node tests/asm.test.js       # assembler encodings + scripted LIZA conversation
node tests/disasm.test.js    # disassembler: every 6809/6803 opcode against the data sheet, round-trip, data lengths
node tests/debugger.test.js  # debugger core: breakpoints, watchpoints, stepping, trace, against a free run
node tests/debug-session.test.js  # the debugger through the Session: lifetime, symbols, errors, snapshots
node tests/probes.test.js    # probes and bus taps: order, removal in any order, the debugger as a client, the CoCo 3 held instruction once, Session hooks across snapshots and switches
node tests/writewatch.test.js # the memory-write observer (watchWrites): events against the trace, delivery points, input, 'stop', the CoCo 3 held instruction
node tests/profiler.test.js  # hot-spot profiler: cycles per routine against hand counts (6809, 6803), total = cpu.totalCycles delta, spin vs compute, FDC HALT, samples, buckets, snapshots, the CLI; node tools/profile-cost.js measures its slowdown
node tests/debugger-catchup.test.js  # frames after a long Over, Out or Step: Run goes on at once, identical to a free run
node tests/halt-held.test.js # CoCo 3 instruction held by HALT: CPU redirected while held; debugger steps, stops, counts
node tests/halt-replay.test.js # CoCo 3 held instruction run again: exact reads (6309 TFM, all forms), malformed snapshot state
node tests/halt-replay-split.test.js # machine.halt (js/machines/halt-replay.js): held snapshots, traces, frames and restored runs identical to before the move (fixtures)
node tests/coco3-buslog.test.js # CoCo 3 bus log: carried only with a HALT-capable device (logBus), hot-plug, snapshots, the guards
node tests/held-writeio.test.js # a write from outside during a held access: queued, made between instructions, same machine either way
node tests/coco3.test.js     # CoCo 3: MMU, GIME interrupts, timer, speed, video
node tests/gime-vsc.test.js  # CoCo 3: the GIME's vertical fine scroll ($FF9C), line by line against rows worked out from the sources
node tests/mc10.test.js      # MC-10: 6803 core, assembler plugin, machine
node tests/sp0256.test.js    # SP0256 speech chip: bit order, every instruction, handshake, timing, our assembler, the filter and output
node tests/liza6803.test.js  # LIZA for the 6803: same conversation as the 6809 build on mc10 and alice; BREAK, CLEAR, backspace
node tests/state.test.js     # snapshots: save mid-run and part-way along a swept line, restore, identical frames
node tests/state-fdc.test.js # the same for floppy controllers mid-transfer, one machine per controller (the slow part of the old state suite)
node tests/state-carts.test.js  # the same for cartridges, a Multi-Pak and the Speech/Sound Pak mid-activity
node tests/state-tape.test.js   # the same for the cassette deck: a recording in progress, a tape being played
node tests/snapshot.test.js  # snapshot files: format and version, defective files, every model opened elsewhere, ROMs by CRC, switching, slots
node tests/long-link.test.js # share links' #z= form: hand-built vectors, every model opened from a link, pre-launch #s= links refused, refusals
node tests/program-pages.test.js # the program pages and cards are what tools/program-cards.js makes; PNG and card vectors
node tests/short-link.test.js # short links on the page's side: sealing, the store over a mocked fetch, the key never sent, guardrails
node tests/share-one-link.test.js # the Share screen's "one link": an untouched bundled program gives its page; every way in (a key, a typed line, a poke, an assembled program, a tape, a disk, BREAK) makes it a moment, its own running does not
node tests/basic-share.test.js   # "Share your program": the card's condition, the LIST round trip (Dragon, CoCo, MC-10) through long and short links, the arrival with and without ROMs, the limits, the program link format
node tests/share-card.test.js     # the share card (Save picture, a short link's preview): 1200x630, every picture pixel frameToRGBA's, the name drawn glyph by glyph
node tests/shortlink-worker.test.js # the short-link Worker in Node against an in-memory bucket: every check, limit, kill switch and count
node tests/qr.test.js         # the QR encoder against ISO 18004's worked example and tables, every symbol read back
node tests/press-break.test.js # BREAK delivery: our own firmware scans the matrix on dragon64, coco3 and mc10
node tests/video.test.js     # scanline video: beam position, SAM display counter, mid-line mode splits
node tests/serial.test.js    # serial line receiver and port devices, PIA output callback, printer paths, the Session's terminal
node tests/serial-api.test.js # session.serial on the 6551 and the bit-banger: every byte both ways, subscribers, delivery times, the trace (its hashes against the MAME-verified runs), diagnostics, --serial-trace
node tests/disk-trace.test.js  # session.disk on the WD2797, WD2791 and WD1773: a full read, a late byte loop, a wrong length bit, rnf, write protect, status() without side effects, the trace's hashes against the MAME-verified runs, --disk-trace
node tests/acia.test.js      # the 6551 alone: registers, data sheet rates, frames in every format both ways, errors, interrupts, state
node tests/drivewire.test.js # the DriveWire server against the DW4 specification, the Becker port, the Session, a WebSocket channel
node tests/claude-chat-drivewire.test.js # the Claude chat end to end over DriveWire channel 14 on the Becker port (mocked fetch)
node tests/restore-points.test.js # Ask Claude's restore points: one path for every acting tool, exact restores on 6809/6803/CoCo 3, a failed restore keeps everything, a disk rolls back only for the same mount and only when written
node tests/claude-acting-contract.test.js # Claude's acting tools: every tool x every outcome as the model receives it (mocked fetch), schemas vs constants, the consent gate and restore point for every tool
node tests/claude-ask-acting.test.js     # the person's input pauses an acting call at its gate (a card, an INCLUDE read): nothing acts, no restore point; Resume, Stop and the turn's end
node tests/web-serial.test.js # DriveWire to a real CoCo over Web Serial, against a mocked serial port
node tests/drivewire-samename-servers.test.js # the store's case rule reaches all three DriveWire servers (Becker, serveRealCoco over a stub port, the chat's), with a case-sensitive control
node tests/composite.test.js # composite colour: NTSC artifact colours per phase and PAL line blending on known patterns
node tests/display.test.js   # Display tab settings (validated, remembered, applied per machine) and picture size
node tests/bus.test.js       # expansion bus: cartridge ROM/I-O, CART autostart, NMI/HALT lines, interrupt hub, the floating bus
node tests/carts.test.js     # cartridges: SN76489A, banked ROM, Orchestra-90, Multi-Pak, board choice, CART tied to Q, Session
node tests/session.test.js   # Session: model switching, ROM sockets, loading every file kind, pacing
node tests/reset.test.js     # Reset: never changes the machine, keeps RAM for a program's warm start, the boot watchdog arms only on a power-on, ROM-drop offers
node tests/snapshot-boot.test.js   # a snapshot opened is not a power-on: no boot failure after it, while a real power-on still has one
node tests/cli.test.js       # cli/cloadm.js as a child process: exit codes, --json, wait-for, typing, screen text, PNG pixels, snapshots, scripts, the guide's examples
node tests/skill.test.js     # the agent skill: the .agents copy identical, frontmatter, its tool table equal to the server's, its claims and PMODE 4 recipe run on the server
node tests/skill-evals/run.js # the skill's evals with and without it: real, billed Claude runs (needs the claude CLI), not in tests/all.js; a case with `server: panel` runs on the side panel's stand-in, tests/skill-evals/panel-server.mjs (`panel_state: stopped` starts its machine stopped in the Debugger)
node tests/plugin.test.js    # the plugin, marketplace and Claude Desktop extension manifests: one version, paths, placeholders, the tool list, the server starting as each starts it
node tests/mcp.test.js       # the MCP server over stdio: both protocol eras, every tool's results and errors against the in-page tools, handles, --read-only, the media root, cancellation, --serve
node tests/mcp-roms.test.js  # add_roms / remove_roms with stand-in ROMs: a local https server (a CA made for the run), every URL refusal (http, private/loopback/CGNAT/link-local, redirects, size, timeout, not a ROM), data, the media root, consent (elicitation), the store across restarts, --read-only, no ROM bytes in results
node tests/rom-store.test.js  # the add_roms store: a URL kept as origin + path (no query or fragment), two processes adding at once lose no entry, a stale lock is broken
node tests/connector.test.js # the side-panel connector (connector/): the Worker over HTTP, both views and their CSP, the folded emulator identical to the plain modules, the panel's tools equal to the server's, the 100k limit, the bridge's protocol in a vm
node tools/connector-check.js # the connector's two views in Chromium, nested as Claude nests them under the spec's CSP, with a host stub: handshake first, list_changed, the tools, keys, storage, ROMs kept and read by memory reads, no CORS, out of step, and the view's controls (Details, the screen's fit inline and in the side panel, ⋯'s side-panel item, the menus, sound, Claude's chip), and on a phone (the size it reports inline, the host's insets, the on-screen keys in their three modes and the choice remembered, a host that asks before each call) (the browser check's `connector` group)
node connector/build.js      # build the connector's views into connector/worker/src/views.gen.js (wrangler deploy runs it; docs/deploy-connector.md)
node tests/cli-agent.test.js # cli/cloadm.js beyond the basics: --describe, error codes, the debugger steps against the Session's debugger, DriveWire stalls, special keys, script quoting, --view
node tests/cli-wav.test.js   # --wav: a known DAC pattern's levels and timing, determinism, snapshots mid-sound, the box filter of the level events
node tests/cli-record.test.js   # --record / --record-dir: an independent AVI reader against frameToRGBA and --wav, the exact rate on every model, mutants, limits, ffprobe if installed
node tests/cli-screenshot.test.js  # --expect-screenshot (tolerance, diff, PNG layouts, errors) and --hold
node tests/starter-game.test.js    # the starter game: its build, play script, picture and sound references, and mutants that must fail
node tests/game-guide.test.js      # docs/game-development.md's programs and commands, run (the settling patterns too, each shown to matter)
node tests/dev-docs-headless.test.js  # docs/automation.md's per-model table (rebuilt from the machines), the example docs/examples/headless-frame.mjs run from outside the repository, the recipe and the serial-peer note
node tests/disk-read-example.test.js  # the disk-read example (docs/examples/disk-read.mjs and diskread.asm: a Dragon reads two sectors through the controller's registers with no DOS ROM), against a hand-built VDK and three broken guests; what the guide says of --disk with no ROMs
node tests/config.test.js    # URL parameters: every one checked (options against each model), bad values reported, links written and read back
node tests/embed.test.js     # the embed API through its message protocol: calls, errors, events, frames
node tests/pwa.test.js       # the service worker keeps every file the site serves (and build-examples.js keeps the list current); the manifest and its icons
node tests/install.test.js   # the install offer's rules: stored answers, Not now twice, a dismissed prompt, who is offered, the 60 s clock, each browser's steps
node tests/settings.test.js  # settings export and import round trip; ROMs and programs never in it, ignored if added
node tests/session-drives.test.js  # session.drives (js/drives.js): what it moved from the Session is byte-identical to before (fixtures: mounts, a restore point, writes, a snapshot), none of the old names is left, and the Session's mount key
node tests/session-library.test.js  # session.library (js/library.js): what it moved from the Session is byte-identical to before (fixtures), none of the old names is left, and its wiring (DriveWire, a store change, a move)
node tests/storage-move.test.js  # moving the library to another store: what is copied, kept, merged (ROM sockets and names), refused; reconnecting a folder copies only this visit's files
node tests/media-store.test.js  # storage layer: the MediaStore contract, random access, quota, localStorage migration
node tests/media-multitab.test.js  # two tabs on one store: interleaved index writes lose nothing, the same socket ends as the last change, collect and recent files are safe, and the channel between two Sessions
node tests/mame-lib.test.js    # the MAME runner: a failed start or exit status stops a comparison; the timeout only warns
node tests/audio.test.js     # audio output stage: sound unchanged, no pop at unlock, reset, machine switch, pause and resume; the bounded catch-up after a stall on a mocked clock
node tests/audio-worklet.test.js  # the AudioWorklet path: queue order, underrun to silence, the re-prime after a gap, bounded drop-oldest, the MessagePort sink, the processor
node tests/keyqueue.test.js  # fast typing: bursts read back from the keyboard matrix on every family and typed into LIZA, in order and complete
node tests/roms.test.js      # ROM identification across machines (synthetic images only), library, offers
node tools/gen-rom-docs.js   # regenerate docs/roms.md from the profiles (tests/romdocs.test.js checks it)
node tools/gen-machine-help.js   # regenerate Help's list of machines from the menu data (tests/machine-menu.test.js checks it)
node tools/version.js --write    # copy CHANGELOG.md's "Next version" into js/version.js, the version stamp (tests/version.test.js checks it)
node tools/gen-page-preload.js  # regenerate the <link rel="modulepreload"> list in play/index.html (tests/pagepreload.test.js checks it)
node tools/page-load.js      # how long /play/ takes to start over a throttled link: modulepreload's effect (see below)
node tools/flicker-measure.js # a .cas dropped on stored ROMs, first visit vs repeat: DOM mutations, layout shifts, canvas
                              # replacements, service-worker events and reloads per second, and #toastRegion's inline-style
                              # writes (the toast placement loop's cost: see "the page's per-frame work" below)
node tests/readme.test.js    # README.md and docs/*.md: only what GitHub renders; links, anchors and pictures resolve; no private or ROM-folder links
node tests/tape.test.js      # cassette: WAV files, decoding impaired recordings, capturing csave.asm's output on every SAM model and the MC-10, Session
node tests/tape-sound.test.js  # Tape sound: the tape's signal per frame tick for tick, silence when it stops, the low-pass, not machine state; the mux's cassette bias
node tools/mame-diff/run.js dragon64 --cass-sound   # the sound mux on the cassette input while a tape plays, against MAME's -wavwrite (dragon32, coco too)
node tests/tape-load.test.js # a tape dropped on the page: restarted, CLOADM, EXEC only when BASIC is back, a self-starting tape left alone (BASIC stand-in)
node tests/input.test.js     # input: both keyboard modes on every family, the keyboard joystick, gamepads, the CoCo Max module
node tools/mame-diff/tape/run-tape.js [profile ...]   # MAME records our writer firmware; MAME reads our .CAS and WAVs with our reader firmware
node tools/mame-diff/tape/run-playback.js [profile ...]   # how a .CAS is played: the same silences and the same blocks read as MAME (--ours: ours only)
node tests/tokens.test.js    # design tokens: agreed values, WCAG contrast, self-hosted WOFF2 fonts and licences
node tests/zip.test.js       # ZIP reader and inflate (hand-built archives; zlib as the oracle)
node tests/rompack.test.js   # ROM pack round trip; ROMs never in settings export or share links
node tests/detect.test.js    # media detection; disk fixtures made with MAME's imgtool (tests/fixtures/disks)
node tests/disk.test.js      # disk images: VDK, JVC and DMK to and from flux, hand-derived MFM cells and CRCs, round trips
node tests/fdc.test.js       # floppy controller cartridges register by register: commit delays, step rates, index, CRCs, NMI/HALT
node tests/nmi-arm.test.js   # when a CPU starts taking NMI: on the 6809 LDS, LEAS and TFR r,S arm it and EXG does not; on the 6309 only LDS and LEAS do; an earlier edge is lost
node tests/disks.test.js     # disks through the Session: stored, mounted and written back by range on the media store, write-protect, download, errors
node tests/disk-bare.test.js # a disk without a disk ROM: the controller alone, a program on the built-in firmware reading it, the ROM put in later, a snapshot mid-read, the CLI note
node tests/disks-mount-race.test.js   # a Library rename, import or delete of the image a mount is reading: it reads again or fails clearly
node tests/disks-mount-case.test.js   # writes to the image being mounted under its own name or another case spelling, on case-sensitive, case-insensitive and unmeasured stores
node tests/disks-newdisk.test.js      # a new blank disk formatted by our firmware; newDisk against an import of the same name
node tests/importmedia-finally.test.js # the creation landing behind the Library's import: it lands only at the end, so a second creation asked inside the case probe is refused, and one queued behind a probe that throws still refuses
node tests/ay8910.test.js    # AY-3-8910/8912 against its data manual: tone, noise, the 16 envelope shapes, mixer, ports
node tests/alpha.test.js     # the Dragon Alpha's wiring: ROM banks, PIA2, the AY as the drive latch, NMI through PIA2 CA2
node tools/build-demo.js     # rebuild examples/demo.bin
node tools/build-examples.js # rebuild examples/liza.bin, liza6803-{mc10,alice}.bin, welcome.bin, welcome6803-{mc10,alice}.bin, chat.bin and starter-game/catch.bin from their .asm sources, then bring sw.js's offline file list up to date
node tests/welcome.test.js   # welcome program on every 6809 model: screen, menu keys and events, the tune on the DAC
node tests/welcome-tune.test.js   # when the welcome tune plays: the visit and Programs play it; a switch, Reset, a power cycle and a return are silent; both builds
node tests/demo-tone.test.js # the welcome demo plays one short clean tone (440-880 Hz, 0.3-0.5 s, $80 +/- amp), then nothing on the DAC; the bars are as defined (Dragon 64, CoCo, CoCo 3)
node tests/privacy-copy.test.js # the ROM privacy copy (README, docs, front, /roms, Help, play) says both halves: CLOADM never uploads ROMs; what Claude reads from memory, ROM areas included, goes to Anthropic
node tests/cpu6309-offer.test.js   # the welcome menu is offered on every 6309 model ('menu', 'back'), and the file it fetches is the 6809 build (welcome.bin), as the 6809 gets
node tests/cpu6309-session.test.js # the HD6309 runs the 6809 builds: welcome menu, LIZA, the demo and the chat firmware on every 6309 model, each ending in the same state as on the 6809
node tests/returning.test.js # returning visits: greetings, carry-on (option 6; 5 on the 6803 build), what ran last, back to the menu from LIZA (BYE or BREAK) and the demo
node tests/welcome-on-screen.test.js # "on screen now" (Session.welcomeOnScreen: the menu loaded on the machine shown, not stopped by the Debugger, and its prompt drawn; Session.lastRunOnScreen: the last-run program still the one on screen; Session.isLastRun: a recent entry is the last run by name and bytes) and 'lastrun', which "Last time" follows; the page side is the browser check's returning group (onScreenChecks)
node tests/debugger-stop.test.js # a Debugger stop in the Session: Reset, a power cycle, a load and a switch release a Debugger stop (breakpoints kept, 'launch' and 'released' emitted), typing while stopped is refused once per stop, the status line says Stopped or Paused; the page side is the browser check's debugger group (debuggerStopChecks)
node tests/menu-return.test.js # a program's return to the menu survives the chat: BYE in LIZA and the demo's key after the full-screen chat opened and closed, the watch waiting while the chat machine is on screen, Reset restarting what ran on each machine
node tests/power-on.test.js  # without ROMs: Reset restarts what runs; power-on, a machine switch and a snapshot of the stub's prompt bring the welcome menu (6809 and 6803)
node tests/welcome6803.test.js # the 6803 welcome on mc10 and alice: raw screen cells, per-machine subtitle, keys, the two builds differ only at the HALT
node tests/regress.test.js                # the trace and frame hashes of the diagnostic firmware, against their recorded values (no MAME needed; about a minute of work on one core, and tests/all.js runs it in parallel shards; --count prints the number of cases, --only <name or /regex/> runs some of them, e.g. --only dragon64 while changing one thing)
node tools/check-times.js --times tests/tape-load.test.js   # per-check times of one suite (a copy is timed, biggest first is the caller's job): name, ms, share of the suite
node tools/measure-regress-cost.js        # re-measure the regress shard constants on this machine (every case alone, then a fit): prints TRACE_S and FRAME_S for tests/regress-shards.js; --limit N for a quick check that it runs
node tests/allsummary.test.js             # the gate itself: the FAILED: line and --only subset runs; a suite that exits 0 without printing its summary (a pending promise, or one printed only from an exit handler) fails; a suite that prints a "FAIL " line and exits 0 fails; normal suites pass; summaries printed from every writer and quote style are read; fixtures stay out
node tests/fastloop.test.js               # the fast-loop table above: every suite pattern selects a suite, every group exists; AGENTS.md's Start-here scripts exist
node tests/allsignal.test.js              # a signal to the gate stops every suite and exits 128+n; nothing survives
node tests/changelog.test.js              # a released CHANGELOG section equals the same section in its git tag (named corrections aside, internal labels removed from both sides), and every release uses Keep a Changelog headings (Added/Changed/Fixed); needs the tags (CI fetches them, `git fetch --tags` locally: without them it prints a SKIP line per tag)
node tests/internal-labels.test.js        # no tracked file carries the maintainers' internal process labels (review and ruling IDs, old branch names); each pattern on cases of its own
node tests/private-paths.test.js          # no tracked file names a Claude session, the private repo, a local path, worktree or work folder, the local instructions file, a worker, a planning or inbox item, a personal email address, or a branch outside the CI globs; its patterns are built from parts, so it scans itself
node tests/workflows-release.test.js      # release.yml packs in a read-only job, checks the notes before attesting, checks the artifact hand-off on every run, and its dry run cannot publish; pages.yml publishes main only after the gates, on a main push, once PAGES_VIA_ACTIONS is set
node tests/exitcode.test.js               # no suite or tool forces process.exit() (the Node 25 deadlock), by static scan
node tests/exitguard.test.js              # the same rule at run time, against every spelling a static scan cannot see
node tests/screen-alternative.test.js     # the screen canvas's text alternative: screen_text's rows, blank and block screens, a graphics mode, 80-column GIME
node tests/screen-text-readers.test.js    # screen_text and Session.screenText on our firmware's Dragon 64 Plus 80 columns, GIME 40/80 columns on an MMU-mapped page, a CoCo 3 32-column page the MMU hides; text against the rendered frame
node tools/mame-diff/run.js <profile>     # lockstep trace comparison with MAME (needs mame; exit 0 = identical)
node tools/mame-diff/run.js <profile> --video [--artifact N]   # pixel comparison of every display mode with MAME
node tools/mame-diff/run.js coco3 --video --attr   # the GIME's text attributes, exactly (blank glyphs, so the fonts never show)
node tools/mame-diff/run.js coco3 --video --text [--cpu 6309]   # the GIME text screens, and Claude's screen_text on them
node tools/mame-diff/run.js d64plus --video      # the Dragon 64 Plus's 80-column screen, every pixel (d64plus/run-video.js)
node tools/mame-diff/run.js d64plus --plustext [--video]   # the Dragon 64 Plus's 80-column text screens (lockstep; --video: every pixel)
node tools/mame-diff/run.js d64plus --paging [--video]   # the Dragon 64 Plus's $FFE2 paging: $04 is the motherboard RAM, the VDG never sees a bank (lockstep; --video: every pixel)
node tools/mame-diff/run.js coco3 --video --composite [--artifact N]   # the CoCo 3 on MAME's composite monitor (BPI, MOCH, artifact colours)
node tools/mame-diff/run.js <profile> --raster  # mid-line video changes swept across every beam position, against MAME
node tools/mame-diff/run.js coco3 --vsc   # the GIME's vertical fine scroll ($FF9C): lockstep, every case's pixels, our scroll against MAME's pictures
node tools/mame-diff/run.js <profile> --printer # printer output byte for byte against MAME's printer file
node tools/mame-diff/run.js coco --printer --stub-init # the same, with PIA1 set up as the no-ROM stub sets it up: nothing printed before the first byte
node tools/mame-diff/run.js mc10 --printer --stub-init # the MC-10 (or alice) the same way: port 2 set up as its stub sets it up
node tools/mame-diff/run.js mc10 --printer --glitch     # a glitch on the printer line (coco, mc10, alice): the one $FF MAME prints for it, then the print
node tools/mame-diff/run.js <profile> --serial  # the bit-banger (or the Dragon 64's 6551) in lockstep with MAME's loopback plug
node tools/mame-diff/drivewire/run-dw.js [profile ...] [--no-trace]  # DriveWire over the Becker port: lockstep with MAME (TCP to our server), and byte for byte
node tools/nitros9/fetch.js && node tests/nitros9.test.js   # NitrOS-9 boot test (images fetched to a cache, never committed; tests/os9.test.js, tests/nitros9-session.test.js and the browser check's nitros9 group use them too, and skip without them)
node tools/nitros9/boot-floppy-mame.js <_40d_1.dsk> --cpu 6809 --record tests/fixtures/nitros9/coco3-6809-floppy.json   # the floppy boot's MAME reference (controller register writes)
node tools/mame-diff/run.js coco3 --fdc cocofdc --halt   # the controller's HALT and NMI in halted sector reads at 0.89 and 1.78 MHz, with MAME
node tools/mame-diff/run.js coco3 --fdc cocofdc --halt --empty   # a halted read on a drive with no disk: the CPU held for good, as in MAME
node tools/mame-diff/run.js coco3 --fdc cocofdc --nitros9 [--cpu 6309]   # the NitrOS-9 floppy loader on a hand-built boot floppy, with MAME
node tools/mame-diff/run.js dragon64 --fdc --bare   # the controller with an empty ROM socket, driven by a program reading track 0 sector 1 (also coco), with MAME
node tools/browser-check.js --only nitros9   # Boot NitrOS-9 from the page (the release images when fetched)
node tools/browser-check.js --only semantics # landmarks, headings, closed surfaces hidden for real, the screen's text alternative, a reading mode (Readability)
node tools/nitros9/boot-mame.js <image> --cpu 6809 --seconds 30 --type 'dir\r' --at 15 --record tests/fixtures/nitros9/coco3-6809-becker.json   # its MAME reference (also boot.js: the same boot on ours)
node tools/mame-diff/run.js <profile> --rate    # SAM CPU rate firmware (sam/rate.asm) in lockstep with MAME (mameCompat)
node tools/mame-diff/run.js <profile> --ops     # every instruction class at the SAM rates (sam/ops.asm), with MAME
node tools/mame-diff/ssc/speech.js <profile>    # the Speech/Sound Pak's SP0256 timing: address loads and status reads against MAME (coco, coco2b, coco3, dragon64)
node tools/mame-diff/ssc/speech-audio.js <profile>   # the SP0256's sound on our own image (gen-voice.js) against MAME's -wavwrite at 9,285 Hz, within 1 LSB
node tools/mame-diff/run.js <profile> --pia1b   # PIA1 port B's input pins (RAM size sense, serial in), with MAME (SAM machines, the Alpha and CoCo 3)
node tools/mame-diff/run.js <profile> --reset [--cpu 6309]   # the Reset button (sam/reset.asm): MAME's soft reset and ours, RAM kept, BASIC's warm-start vector taken and refused (SAM machines; the 6309 on dragon64h, tanodr64h)
node tools/mame-diff/run.js dragon64 --fdc --images   # floppy controllers in lockstep with MAME, then the disk images byte for byte (also --fdc premierfdc, coco, coco3, dgnalpha --fdc alphafdc; --write: the mounting tests' firmware; --nmi: when the 6809 starts taking NMI; --multi: in a Multi-Pak's slot 4 with the Multi-Pak firmware; --blank vdk:40x1: a new blank disk formatted, add --no-trace for images only)
node tools/mame-diff/run.js dgnalpha --board          # the Dragon Alpha's own hardware in lockstep (alpha/board.asm)
node tools/mame-diff/run.js dgnalpha --sound          # the Alpha's AY-3-8912 and DAC against MAME's -wavwrite
node tools/mame-diff/run.js dragon64 --sound          # the DAC and single-bit sound (dragon32, coco too) against -wavwrite, through --wav's path
node tools/mame-diff/run.js <coco|coco3|dragon64|dragon32> --cart <banked|bankedshort|gmc|orch90|multi> [--audio]   # cartridges in lockstep with MAME, then their sound against MAME's -wavwrite
node tools/mame-diff/sam/run-fastvid.js <profile>   # fast-rate video: MAME keeps the screen, ours loses it (see above)
node tools/mame-diff/sam/run-samv.js [<profile> ...]  # SAM display counter at V=0 and V=1 (sam/samv.asm), every pixel against MAME
node tools/mame-diff/sam/run-hires.js <profile> [max3|rat]   # Hi-Res interfaces and the CoCo 3 Rat mouse, in lockstep with MAME
XROAR=/path/to/xroar node tools/mame-diff/sam/run-xroar.js [rate|ops|diag]   # per-instruction timing against XRoar
node tests/buscycles.test.js # 6809 bus cycles: count for every opcode, addresses of sample sequences
node tests/samrate.test.js   # SAM rate: instruction times per rate and address range, worked out by hand
node tests/tape-rate.test.js # a cassette load at rate 01 succeeds or fails by the loader's own timing
```

**What the gates' results mean.** `node tests/all.js` includes the regression gate: `regress.test.js` is one of its
suites (sharded on 4 or more cores), and the run prints `regress 146/146 included` from what the shards reported
against `node tests/regress.test.js --count`. A run in which the shards did not cover every case fails, even if each
shard exited 0, so a separate `node tests/regress.test.js` adds nothing.

`node tools/browser-check.js` runs its groups (`models`, `romUi`, … in the order of `GROUPS` in the file, plus a
final `missing files` check) one at a time, each on its own (`tools/browser-check-lib.js`):

* `--only g1,g2` (or `--only=g1,g2`) runs those groups. A name that is no group, or an empty list, is a usage error: the valid groups
  are listed, nothing runs, and the exit code is 2. `--list-groups` prints the group names, one per line, and runs
  nothing (no browser needed).
* A group that throws is that group's `FAIL`, printed with the stack; what it left open (its pages and contexts) is
  closed, and the next group runs. A browser that went away is started again for the next group.
* Every wait is checked. `waitFor` and `waitForFrames` wait on a condition, with a limit (30 s, or the frames of
  machine time a step is given) that only stops a page that hangs; a wait that reaches its limit is a
  `FAIL wait timed out (limit) at browser-check.js:line: condition`, even when nothing else looks at its result.
  The one exception is `maybeWaitFor(why, …)`: a wait whose timeout is the expected outcome (a check that something
  does not happen), with the reason in the call. A page that is gone is a FAIL in every wait, optional or not: an
  evaluate that fails because the page crashed, closed or navigated away is a `FAIL wait: the page is gone …` where
  the wait was called. In `maybeWaitFor` any evaluate that throws is a FAIL, and the page must still be the same
  document when its time is up; it then returns `null`, so a negative check passes only on `false`. A few loops poll outside these helpers (downloads arriving, requests
  reaching a mocked API, the embed API's calls from its host page); what they wait for is asserted by the check that
  follows them. A check given a Promise (a missing `await`) is a FAIL.
* Fixed sleeps are gone where a condition exists. What is left is a window in which something must *not* happen, or
  a fixture: a toast's 4 s that must not run out while it waits for room (feedback model, 5 s), "Reset says nothing"
  and "a typed POKE says nothing" (0.5 and 0.8 s), the embedded page that must not show its welcome menu (1.5 s and at
  least 60 emulated frames each), calls from a sibling frame that must be ignored (1 s), the rate-limited chat that
  must not retry by itself (0.5 s), a network response held back 1.5 s to start the welcome program late, and the
  page-loop group's replaced `requestAnimationFrame`. Windows where the page's own loop is what would act are counted
  in its animation frames (`ticks`), not in wall time.
* A check that cannot run here is a `SKIP` with its reason, counted in the summary, never silent. The NitrOS-9
  release images are the case: they are never fetched in CI, so there the two release-image checks are `SKIP`;
  locally, after `node tools/nitros9/fetch.js`, they run. A cached image that does not match its pinned SHA-256 is a
  `FAIL`, not a `SKIP`.
* The run ends with `FAILED group <name>: …` for each failed group, then
  `groups: N run, P passed, F failed · checks: n ok, n FAIL, n SKIP`, then `browser check passed` (with the SKIP
  count, if any) or `browser check FAILED`. Exit code: 0 only if every check, wait and group passed; 1 otherwise;
  2 for a usage error.

**Measuring a check's failure rate.** A check that fails once in CI and passes locally is not diagnosed by reading
it: measure it. `tools/flaky-n.sh` runs one `--only` group N times and writes one line per run - the exit code, the
1-minute load average at the start, the group summary, and the target check's own detail line (so a failure names
the bound that broke rather than just "red") - and keeps the log of any run that failed while deleting the passing
ones.

```
# run one group 20 times, recording the line of the check being investigated
./tools/flaky-n.sh semantics 20 /tmp/flaky-semantics.txt "text alternative follows the screen"
./tools/flaky-n.sh audio     20 /tmp/flaky-audio.txt     "no pop across power cycle"
```

Use `node tools/browser-check.js --list-groups` for the group names. Run it **alone, on a quiet machine, from the
checkout you mean to measure** - the browser check is CPU-bound and a concurrent run, or a run started from a
different checkout, measures something other than what you are asking about. Load matters: a shared machine can be
busier than a CI runner or quieter, so record the load average each line carries and compare like with like. A rate
measured under one load does not establish another's - a check that passes 20/20 under load 19 on a 14-core laptop
may still fail on a 4-core runner at full tilt, and a mechanism found in the code is what settles it.

Two probes reproduce, outside the gate, the two conditions behind the flaky checks, and both carry their own
controls so a null result means something:

```
# the no-pop check under a forced stall: control (must give ~0.0078/0.0165), a planted pop (must be caught),
# then the real measurement - 20 stalls of 500 ms at 20 phases
node tools/audio-stall-probe.js control 1
node tools/audio-stall-probe.js plant   2 500
node tools/audio-stall-probe.js stall  20 500
# the text alternative's mirror under a starved CPU: samples screenAlternative() and #screenAlt every 20 ms
node tools/semantics-race-probe.js /tmp/race.txt 4     # 4 = CDP CPU throttling, a slow runner
```
`audio-stall-probe.js`'s `plant` mode writes a chunk at the opposite level into the sink on resume: if that is not
caught, the probe cannot see a pop and its stall numbers prove nothing. `semantics-race-probe.js` prints every
transition and how many samples the live screen differed from the 1 Hz mirror, which is the race the check now
retries.

**How /play/ starts.** The page's module graph is 100 modules and about 815 KB of plain ES modules with no
build step, and it is six imports deep (the page → the Session → the machine families → the chips → the CPUs).
Left to itself the browser learns about a module only when the module that imports it has arrived, so the
deepest files are not even requested until several round trips in. `play/index.html` therefore carries a
generated `<link rel="modulepreload">` for every module the page's static imports reach
(`tools/gen-page-preload.js`; `tests/pagepreload.test.js` fails when it is stale). Nothing about what runs
changes, only when each file is requested. Measured with `node tools/page-load.js` (Chromium, 200 ms
round-trip, 100 Mbit/s, so the link is latency-bound as a phone on mobile data is): the last module was
requested at **3,821 ms without the list and 218 ms with it**, and the page reached "started" at 4,287 ms and
4,225 ms.

The "started" figure barely moves, and the tool prints why: it breaks the time into the first module (216 ms),
the modules in flight, and what happens after the last one (about 250 ms, mostly the emulated machine booting).
What is left in the middle is not the waterfall any more but the transfer itself: 100 modules over HTTP/1.1's
six connections a host is about 17 round trips, so at 200 ms of latency it costs about 3.4 s however early all
the requests are made. Getting past that needs fewer modules or fewer bytes on the startup path (or HTTP/2),
not a preload list. On a 1,500 kbit/s link, where bandwidth dominates, the list changes nothing (6,137 ms and
6,154 ms to the last module), which is why the latency-bound profile is the one to measure.

A module reached only through `import()` is deliberately not preloaded: that would undo the lazy import.

**Testing the storage layer.** `/play/?storage=opfs|fsa|fallback` picks the media backend for that page
load, so a browser that has OPFS can still be made to take the fallback path (and the download and import
buttons with it). Without the parameter the page uses the best the browser offers. It is a testing and
diagnostic switch, not a setting: it overrides the choice made in the Library for that load.
The folder choice is tested in the browser check with a mocked picker returning a real directory handle (headless
Chromium has no folder picker); with the real picker it was checked by hand in desktop Chrome on macOS: picking a
folder, the link surviving a full Chrome restart, an incognito window (no crash on reload, the choice enabled), and
dragging a spine onto the screen with a mouse. Dragging by touch is not verified; on a touch screen a tap loads.

**Disks and storage.** Disk images are stored in the media store under `disks/` and used through its random
access (`readRange` to mount, `writeRange` for what the machine writes, only the bytes that changed, when the
drive's motor stops, on eject, and before the machine or the page goes away), never through the media index.
A disk that comes back with a snapshot is the snapshot's own copy: it is not linked to the stored image, and
Download saves it.

**The page's per-frame work.** A toast is placed once per animation frame while it is up, so it keeps clear of a
control that grows under it (`js/ui/feedback.js`; `follow` → `place`). That is one chain for the page, cancelled when
the toast goes, and `place` writes the region's inline style and its class only when the placement changes. The
browser check measures that directly: a stationary toast writes `#toastRegion`'s style **0 times in 60 frames** on
desktop and phone (a per-frame writer gives ~60, and main gave ~180), and after a pinned toast has come and gone a
placed toast queues **0 class mutations** on the region (a `classList.remove` of an absent class queues one per frame
in Chromium; `toggle(c, false)` does not). The same check still requires the toast to follow a layout change, and
`tests/toast-follow.test.js` pins the chain count, the stationary cost, the class churn and the follow in Node.

(`node tools/flicker-measure.js` measures a page load, not a toast's placement: its window waits on the machine
booting and usually holds no toast, so its `#toastRegion` count does not isolate the placement loop. It is useful for
the load's DOM mutations and layout shifts, which is what the figures it prints are for.)

## Pictures

The README's pictures are PNGs in [`img/`](../img/), captured from the emulator with no ROMs loaded
(`node tools/capture-images.js`).

## Headless MAME

These need MAME (`apt install mame`) and run headless. Three quirks of headless MAME are handled in the scripts:

* its screen buffer is only refreshed on mode changes, so the older `run-vdg.js` scripts capture each phase one frame
  late; the raster comparison and the MC-10 `--video` run avoid this by recording with `-aviwrite`. It keeps two
  bitmaps and redraws only when the fetched bytes change, so a still picture can leave a capture holding the other,
  stale one: `samv.asm` flips a byte that draws black either way every field to force a redraw
* its display start address ignored the SAM F bits in these runs, so the video test keeps its display data at `$0000`
* MAME's Lua API has no `read_u16be`; scripts read two bytes instead.

---

See also: [Architecture](architecture.md) · [Verification](verification.md) · [CONTRIBUTING.md](../CONTRIBUTING.md) · [AGENTS.md](../AGENTS.md)
