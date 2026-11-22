# Changelog

All notable changes to CLOADM are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project intends to use
[Semantic Versioning](https://semver.org/spec/v2.0.0.html) once releases are tagged.

## [Unreleased]

Next version: 0.1.8-pre (the plugin and extension manifests carry it; `tests/plugin.test.js` keeps them in step).

### Added

- **Claude's side panel shows Claude's hand on the machine.** While one of Claude's calls acts on the machine (any
  tool that is not read-only: typing, keys, loading, switching, reset), the bezel takes Claude's colour and a chip at
  its top left says what it does, "Claude is typing: DIR↵" with the keys in Claude's colour as they reach the
  machine; it stays 2 s after the call, and the status line keeps "Claude typed DIR↵ · 12:04". A call that only reads
  shows a quiet "Claude read the screen" or "Claude read memory" for 1.5 s. Your own keys never show a chip. Each call
  is announced once to screen readers. The tools and their approvals are unchanged.
- **The side panel's toolbar:** **Programs** (the programs this machine runs without ROMs, its own builds of LIZA and
  the Welcome menu included, and Add ROMs for BASIC… while it has none), **Machine** (every model, marked "✓ BASIC
  ready" or "needs ROMs", then Reset, Switch off and on, Add ROMs…), **Sound** and **⋯** (Open in side panel, Details,
  Copy details). The menus work from the keyboard. The Welcome menu's own keys now run what they offer in the panel.

### Changed

- **The side panel's sound has a switch:** "Sound off" until you click it (or the screen); that click starts the
  sound, and the switch turns it off and on again.
- **The side panel's screen fills the panel**, 4:3, each pixel drawn crisp at the display's resolution, in a thin
  bezel: inline across the full width, and in the side panel or fullscreen within the room left by the toolbar and the
  status line. The status line is one line ("LIZA is running · Dragon 64 · no ROMs"); the diagnostics and the raw load
  message moved behind **Details** (closed at first; [the deploy guide](docs/deploy-connector.md#verify) reads them
  there), and an error you must act on stays on the status line. **Open in side panel** (in ⋯) shows only while the
  view is inline and the host offers it. The view's contract with the site changed (`PANEL_API` 2): deploy the
  connector's Worker again after the site has this release.

### 0.1.8-pre

#### Added

- **The play page reads as a document: for screen readers and a browser's reading mode.** On a phone, Chrome's
  reading mode showed every panel's text in a jumble. The emulator is now the one `<main>`, with a heading naming the
  machine; the app bar, the ports under the screen, the settings drawer and the footer are landmarks; each view
  (Library, Share, the Debugger, Add ROMs) is the main landmark while it is open, with one h1; and what is not drawn
  is hidden for real, not only by the stylesheet: the emulator behind a view, the phone's folded Menu links, the drawer
  and ports in the touch layout are `inert` and `aria-hidden`, and the Multi-Pak's slots are `hidden` while it is
  folded. The screen canvas is an application with a text alternative: the screen's text, as Claude's `screen_text`
  reads it, refreshed at most once a second (`Session.screenAlternative()`). The landing page gains its `<header>` and
  `<main>`. Nothing looks different. The browser check's new group `semantics` checks all of it at desktop, phone
  (portrait and landscape) and tablet size, with Mozilla's Readability (an unmodified copy in `tools/vendor/`,
  development only) as the stand-in for a reading mode.

- **CLOADM in Claude's side panel on claude.ai: a remote connector.** Add `https://mcp.cloadm.dev/mcp` as a custom
  connector (no sign-in) and ask Claude to open CLOADM: the emulator runs in an MCP Apps view, in your browser, which
  you can open in the side panel and type on; from the next message Claude uses the machine tools the MCP server has
  (the same names, arguments, results and `untrusted` wrapping) on the machine on screen, each call approved by you.
  The view is `connector/view/`: a bridge that shakes hands with Claude before the emulator loads and tells it when
  the tools are ready, and the toolbox on the panel's own machine. One machine (`m1`); `load` runs the bundled
  programs; no files, tapes, disks or snapshots (the panel has neither files nor downloads). ROMs are added in the
  panel and stay in its browser storage; while they run, `peek`, `find_bytes` and `disassemble` are refused, so no
  tool returns ROM memory directly (a program run on the machine can still read it, so a determined agent can infer
  ROM contents through execution). `add_roms` and `remove_roms` are not offered there either. Results over Claude's
  100,000 characters are refused with `too-long`. Two views: the default loads the emulator from cloadm.dev (its CSP
  declares that origin only), and a self-contained one (about 1 MiB) loads nothing; the glue the default view loads
  comes from the same release of the site as `js/`, and a version number (`PANEL_API`) makes a connector out of step
  with the site say so (`out-of-step`) instead of half working. The server (`connector/worker/`, a Cloudflare Worker)
  is stateless and stores and logs nothing, takes one JSON-RPC message per request (no batches) of at most 64 KiB, and
  reports the build's `git describe` as its version; its build refuses to run until cloadm.dev serves the same
  `PANEL_API`. Deploying it: `docs/deploy-connector.md`. Tested in `tests/connector.test.js` (the server, the views,
  the folded emulator against the plain modules, the bridge's protocol) and the browser check's `connector` group
  (both views nested as Claude nests them, under the spec's CSP, with and without CORS, and out of step). Guide:
  `docs/mcp.md`, "Claude on the web: side panel".
  `docs/mcp.md` now opens with "Which way should I install CLOADM for Claude?" (the connector, the plugin, the `.mcpb`
  extension, other agents, and what each has been tested on), the desktop app's plugin steps are the ones the app
  shows, the README says it in four lines, and the skill tells the agent which of the two routes it is on.

- **The MCP server's `load` runs the games too:** `program` takes `2048` and `minesweeper` as well as `welcome`,
  `liza` and `demo` (refused, as on the page, where the machine cannot run them).

- **The MCP server takes your own ROMs from the chat: `add_roms` and `remove_roms`.** `add_roms` stores ROM dumps you
  give the agent, from a file, ZIP or folder in the media root, an https URL, or a file you uploaded (base64), in the
  server's own store (`~/.config/cloadm/roms/`, `%APPDATA%\cloadm\roms\` on Windows), merged with `--roms` and the
  config file at every start. A URL must be https to a public address: every resolved address is checked, loopback,
  link-local, private, CGNAT, documentation and IPv4-mapped ones are refused, also after a redirect (at most 3); 20 s,
  1 MiB a file and 4 MiB a ZIP (8 MiB unpacked a call), no cookies, credentials or proxy. Only what CLOADM recognises
  as a ROM is stored (`not-a-rom` otherwise), no result carries the bytes, and a client with MCP elicitation asks you
  to confirm first: for a URL before anything is contacted, showing the whole URL (a decline downloads and stores
  nothing). Machines already open keep running; the result names the models that now have BASIC. `list_models` gives
  each model's `basic` and, for each ROM, the file and its source (`cli`, `config`, `stored`); `remove_roms` forgets
  stored ones; `--read-only` hides both. CLOADM itself still ships and links to no ROMs, and fetches only a URL you
  give `add_roms`. `docs/mcp.md`, "Adding your ROMs"; `tests/mcp-roms.test.js`, with stand-in ROMs and a local https
  server.

- **The CoCo 3's vertical fine scroll (`$FF9C`) in the GIME modes.** With rows of 2, 8, 9, 10 or 11 scanlines, a
  value below the row height now moves the picture up by that many lines, and the next row of the buffer comes in at
  the bottom, as Sock Master's GIME reference and Tepolt's *Assembly Language Programming for the CoCo3* describe:
  smooth-scrolling text and double-height graphics show as on the real machine. Claude's `screen_text` counts the row
  the scroll brings in. MAME 0.264 does not scroll; the `mameCompat` option (for the MAME comparisons) keeps its
  behaviour. Snapshots are now format version 4 (the GIME's latched scroll); older files still open. Checked with
  `node tools/mame-diff/run.js coco3 --vsc` and `tests/gime-vsc.test.js`; what the sources leave open is listed in
  `docs/verification.md`.

- **The tape in view while it loads.** A tape that starts (dropped on the screen, opened, from a link, `CLOAD`) shows a
  compact line on the screen's border, under the picture's text and never on it, at every size from a phone held
  sideways to the desktop: the tape's name, BASIC's S (searching) or F (found), the block, the progress, playing or
  stopped, End of tape, a Tape sound switch and **Deck**, which brings the cassette panel into view. It goes a few
  seconds after the tape stops or ends, and is not shown where there is no room off the text (the phone's Claude
  chat). Screen readers hear once when a tape starts and when it ends. The cassette panel can be folded (**Hide the
  deck**).

- **Tape sound.** The tape heard as it plays, as a cassette recorder's own speaker plays it: the tape's signal mixed
  on the page's side, rounded off (a low-pass at 3.2 kHz, not the raw square), at a modest level, silent as soon as the
  tape stops. On by default; its switch is in the tape line and the Media tab, and it is remembered; the page's
  **Sound** switch silences it too. With fast loading
  you hear what passes the head at its real pitch, in real time (played 30-60 times faster the tones would be far
  above hearing). It is not the machine's sound: it is not in the machine's audio state or in snapshots, and
  "Load .CAS straight into memory" plays no tape, so there is nothing to hear.

- **A comparison with XRoar, MAME and VCC/OVCC** ([docs/comparison.md](docs/comparison.md)), dated November 2026, with a
  source for every claim about the other projects, where each is stronger, and "see the project" wherever a claim
  could not be checked in a primary source. Linked from the README FAQ and the "See also" line of `docs/using.md`.

#### Changed

- The README opens with "Try it" and has a short "Use it from code or an agent" section; the Games and Tools
  cells of the feature tables are one line each; the MAME instruction counts are refreshed (Dragon 64 1,028,112,
  CoCo 32K / CP 400 1,043,371, CoCo 3 88,797).

- **A tape in the deck costs nothing while it sits there.** The Cassette slot under the screen was rewritten every
  frame while a tape was in, playing or not; it, the cassette panel and the tape line now write only what changes.

- **One deck moves.** Only the cassette panel's reels turn, and only while the tape really moves: not at the end of
  the tape, nor with the motor on and the tape still. The small deck in the Cassette slot is a still picture. The end
  of the tape is stamped on the cassette.

- Mounting a disk is faster: about four times, 590 ms down to 150 ms for a 180K JVC image in Node. To learn
  whether a snapshot must carry the image as mounted (only a single-density DMK needs it), the drive used to
  decode the image twice more and encode it once at every mount. That check now runs in the background just
  after the mount, so neither the mount nor the next snapshot (a restore point, a share) waits for it. A snapshot
  taken before the check has run still gets the same answer, by doing the check then. What is saved, exported and
  snapshotted is byte for byte the same, and a bad image is still refused at mount with the same message.

- The CLI no longer accepts the undocumented step aliases `expect-text`, `png` and `regs` (in scripts and as
  `--expect-text`, `--png`, `--regs`); use `expect-screen`, `screenshot` and `registers`. `-m` and `-o` stay.

- **The games' sounds are musical cues, not a buzz on every move.** 2048 played a burst of noise on every move
  and Minesweeper one on every square opened, which is why they read as noise rather than as game sounds. 2048 now
  plays one short tone per move, its pitch stepping up with the join it makes (C major pentatonic, C5 to D6), about
  60 ms instead of a rumble; Minesweeper plays an E5 tick when a square opens, a rising C5-G5 pair when a flag goes
  on (falling when it comes off), a rising arpeggio for a win and a falling one for a loss, and a single short noise
  burst for the mine (about 170 ms, where there were three). Each pitch is checked against the recorded sound; the
  recording is not committed (media files are refused by the repository's pre-push guard), so
  `tests/fixtures/games/minesweeper-sounds.sha256.json` holds the SHA-256 of its PCM samples and the test compares
  that. Set `CLOADM_KEEP_WAV` to a path outside the repository to write the recording out and listen to it.

- **The Media tab's "Recent on this machine" no longer lists one file twice.** The list's identity was the
  content hash alone, compared exactly, so two reachable cases showed the same name twice: an entry an older build
  stored with a lower-case CRC was not matched by the upper-case one a later load makes, and a file of the same name
  with different bytes (a rebuilt program) was a second row that read exactly like the first. Identity is now the
  NAME (by the store's own case rule) plus the content hash, and stored CRCs are normalised as the list is read, so
  an existing list heals. Two files of one name with different bytes are still both shown - each keeps and loads
  its own bytes - and the older one is labelled (2nd, 3rd, "older copy") so the rows can be told apart.

- **Sound comes back in seconds after the page stalls, not tens of seconds.** The output stage keeps the
  worklet's queue near 40 ms by resampling each frame by a fraction more or fewer samples, but that correction was a
  fixed 0.5% just outside the 10-80 ms band: the queue moved 5 ms of sound a second however far outside it was, so a
  stall that left 135-140 ms queued (measured in Chromium after a 0.8 s stall: 141 ms) took 15-18 s to come back into
  the band and most of a minute to settle. The correction now grows with the distance from the band's middle, up to
  2% (34 cents) while recovering - transient, and only outside the band - and is exactly 1 inside it, as before, so a
  steady queue is still played untouched. The same 140 ms queue is back inside the band in 4-5 s, with no sample
  step (the no-pop checks are unchanged and pass), and the 15-minute clock-drift runs still drop no frame and never
  run the card dry. `tests/audio.test.js` holds both.

#### Fixed

- **Dragon 64 Plus: `$FFE2` = `$04` is the motherboard RAM, and the 32-column screen never shows a bank.** Following
  P. Harvey-Smith's traced Eagle schematic of his DragonPlus board (World of Dragon forum, 7 June 2017; known drawing
  errors; not verified on hardware), bit 2 of `$FFE2` only picks bank A or B, so `$04` (and `$05`, with the video RAM)
  now selects the motherboard RAM instead of leaving the previous bank; and the MC6847 now always fetches from the
  motherboard RAM, whatever bank or video RAM the CPU has selected. MAME 0.264 never applies `$FFE2` to memory, so its
  outcome equals the schematic's for these two points (`run.js d64plus --paging [--video]`, identical to HALT and in
  every pixel); this proves the MAME-equal outcome only, not the banks themselves; under `config.mameCompat` the
  register keeps MAME's decode. `tests/d64plus.test.js`.

- **The built-in firmware sets the SAM's memory size for the fitted RAM, as BASIC does.** On the Dragons and the
  CoCo 1/2 family it left M at 00 (4K), so a program run without ROMs that showed a screen above `$0FFF` (any
  graphics page from `$0600`) saw the first 4K again unless it set M itself. It now leaves M = 01 on 16K and 10 on
  32K and 64K (4K stays 00). `tests/stub-sam.test.js` checks every model and RAM option, and that a text screen at
  `$2000` shows its own bytes; `docs/game-development.md` and the agent skill no longer tell programs the firmware
  leaves 4K.

- **The sound mux on the cassette input.** With the cassette selected and sound enabled (BASIC's `AUDIO ON`), the
  Dragons and CoCos now sit at the sound chip's bias, half the DAC's range, as MAME 0.264 does, instead of at 0 (a
  click when `AUDIO ON` switched it). MAME mixes no tape signal there and neither does the machine; Tape sound is how
  the tape is heard. Compared with MAME's `-wavwrite`: `run.js <dragon64|dragon32|coco> --cass-sound`.

- **The on-screen keyboard fits a phone held upright, and a drag on it no longer types.** On an iPhone in Chrome or
  Safari (and on smaller phones) the row with ENTER was under the browser's bottom toolbar, with nothing to say it
  was there. Upright, the app bar now tightens ("Add ROMs" without "No BASIC ·"), the Keys | Joystick switch shares
  one row with BREAK, CLEAR and Menu between the screen and the keys, the keys are 40 px, Joystick mode's strip is one
  row, and the screen takes the height left in the window with the toolbars up (`100svh`, `100vh` where it is not
  known; on Safari 26 and later the panel also stops above the floating toolbar it draws over the page), so the whole
  panel is on screen at load. The screen's focus pill no longer says "Tab leaves the screen" on a touch screen.
  A key now types when the finger lifts, or after it has rested 100 ms (holds still work for games); a finger that
  moves more than 10 px first, or a touch the browser takes for a scroll, types nothing (it used to type on touching
  down; SHIFT held while another key is tapped still shifts it), and upright a drag on the panel no longer scrolls
  the page. The install offer's one-line strip, which sat in the band that used to be between the screen and the
  keys, now has the screen make room for it while it is up (the keys stay put). Checked in the browser check at nine
  phone sizes and toolbars, with real touch events.

- **A refused file is named once, not twice.** The two real media backends word a failure with the stored path in
  front of it (`disks/work.vdk: permission was refused`), and the Session put the disk's name in front of that, so a
  refused import or save read `work.vdk: disks/work.vdk: permission was refused`. Each caller now hands `mediaError`
  the stored name it just used, and a reason that leads with exactly that name has the leading copy dropped before
  the person's name goes in front. Any other path a reason carries is kept: a rename that fails at its destination
  still says where, and a name with a space or a file dropped under a path (`dir/work.vdk`, Windows separators) is
  named once by its own file name - and a library file dropped under a path reports the name the Library lists
  (`dir/prog.bin`, not just the leaf). The page's background-write notice takes its wording from the Session too
  (`Session.indexWriteError`), so a failed ROM write is named once. One rule for the library import, a new blank
  disk, a mount and the DriveWire box. The quota and not-found messages already wrote their own sentence and are
  unchanged. `tests/store-error-names.test.js`.

- **A disk rename's new name is held to the same rule as any new disk name, and a name already stored is still
  read back.** A rename to `" "` stored `disks/ ` and a rename to `sub/x.vdk` stored `disks/sub/x.vdk`, names no
  mount could then read back; both are refused now, saying what is wrong with the name. And a store from an earlier
  build that already holds such a name (`disks/ `, `disks/sub/x.vdk`) still mounts it: the rule decides what CLOADM
  may create, never what it can read. `tests/store-error-names.test.js`.

- **A disk name that is not a file name is refused.** `disks/` was stored as a blob named `disks/`, and so were
  `disks/a/`, `' '`, `disks/..` and `x/..` - names a folder store or OPFS cannot hold, and a `..` that must not
  reach the store. Every door (a library import, a new blank disk, a mount of a stored name) refuses a name that is
  empty, whitespace ONLY, has a trailing separator, or is the segment `.` or `..`, as `A disk image needs a name.`
  (a file that is not a disk image, dropped with such a path, as `A file needs a name.`). Spaces AROUND a name are
  part of it and are kept: a store that already holds `" a.vdk"` still mounts it, and a name that starts with a dot
  (`.vdk`) is a real name. `tests/store-error-names.test.js`.

- **A rename and a new disk or import can no longer write over each other's image.** A disk creation checks its name,
  then waits for the drives' own writes before writing, and a rename was not ordered with it at all: a rename landing
  in that wait took the name first (the creation's write then replaced the renamed file, and the image was gone), and
  a rename asked first could be overtaken the same way (the creation had picked the name from a listing that could not
  see the queued move). A disk rename now runs as one creation, like a new disk or an import: one at a time, in the
  order each was asked, and after the creations queued before it have ended. A rename onto a name a creation is making
  is refused (`... a disk is being made under that name: try again once it is done.`), and a creation asked behind a
  queued rename lists after it has run and takes a free name. `tests/mount-rename-races.test.js`.

- **A rename and an import of the same name can no longer overwrite each other.** A rename runs as a creation like a
  new disk or an import, but it did not record the name it took, so an import queued behind it read the name as a
  deliberate replace and wrote its own bytes over the renamed image. Every creation now records what it stored - a
  rename only when it succeeds - and the one queued behind it refuses as a second creation of that name.

- **A name a rename moved an image away from is free again.** `A.vdk` renamed to `X.vdk`, then `X.vdk` to `Y.vdk`,
  left `x.vdk` recorded as taken, so an import of that name queued behind both was refused ("There is already a disk
  named x.vdk") although the name was free. A rename now records the name it vacated, and the creation queued behind
  takes it. (Safe before - nothing was overwritten - but wrong.)

- **A guest's DriveWire mount can no longer take a second drive on an image another mount is taking.** The named
  object's duplicate scan ran before it claimed the name and never again inside the claim, so a guest mount
  overlapping the user's mount left two drives writing one file (this had passed before the claim was added). Every
  arm re-scans inside the claim now; the claim lives on the drives map, so servers that share drives (a real CoCo
  over Web Serial, the chat) wait on each other; and its key is the store's case rule, so two spellings of one file
  wait too.

- **Moving the library takes every DriveWire server with it.** The Becker port's server was retargeted by a move;
  the one serving a real CoCo over Web Serial and the full-screen chat's kept reading and writing the old place.
  All of them now follow the session. `tests/mount-rename-races.test.js`.

- **Two DriveWire drives can no longer end up on one image when their mounts overlap.** The duplicate check and the
  drive it claims were apart by the store's stat, so a guest's named-object mount and the user's mount of one image
  in that window left two drives writing the same file. Each mount claims the image's name for as long as it is
  deciding, and a second mount of it waits for that answer. `tests/mount-rename-races.test.js`.

- Booting NitrOS-9 from a Library image whose storage fails (not just a missing image) now reports the storage error
  instead of "There is no image called ...".

- **A row in the Media tab's "Recent on this machine" loads the file it names.** The rows were drawn from one copy
  of the list and the click looked its index up in a second copy, which never matched: the index was always -1, so
  every row answered "That file is no longer stored in this browser; load it again." even when it was. The index is
  carried with the row now. `tests/recent-rows.test.js` pins the arithmetic and the browser check clicks a row and
  requires the load.

- **Opening the page directly at `play/#share` no longer shows "Cannot read properties of null (reading 'render')".**
  The Share screen captured its moment as soon as its view was set up, before the visit had a machine. It now shows
  the view at once and captures when the page has started, so the link opens the Share screen filled in, on the
  machine the link chose. The browser check opens `#share` directly and requires no error toast, no page error and a
  running screen.

- **The Speech/Sound Pak's ROM no longer looks required on the Add ROMs screen.** On the Dragon 64 and the CoCos its
  PIC ROM card carried the same "required" tag as BASIC, so a first visit read it as something the machine needs.
  The Pak is an optional cartridge: its cards are now titled "Speech/Sound Pak (optional cartridge): ...", tagged
  optional like the disk card, and listed after the machine's sockets and the disk card. The Pak still needs its PIC
  ROM to be inserted, and says so. Checked in the browser check's `sscBoard` group.

### 0.1.7-pre

#### Added

- **A command-line tool and a Node API guide, for CI and coding agents.** `node cli/cloadm.js` runs any model
  headless: choose the machine and its options, give your own ROMs (a file, a ROM pack or a directory; without them
  the built-in firmware runs machine code), load a program, tape, disk, cartridge, snapshot or assembler source, type
  (with BREAK, CLEAR and the arrows), run frames or emulated seconds, wait until text is on the screen, a byte holds a
  value or the PC reaches an address, read the screen (Claude's `screen_text` readers), peek and poke, save a PNG of
  the frame and snapshots. Steps run in order from the command line or a script file; `--json` gives one object with
  every step's result; exit codes 0 success, 1 a condition failed, 2 usage, 3 media or ROM, 4 internal. It runs in
  emulated time with no clock, so the same inputs give the same frames. `Session.runFrames(n)` is that frame loop for
  your own scripts. The guide, with the stable API, a GitHub Actions example and the ROM situation in CI:
  `docs/automation.md`; its examples run in `tests/cli.test.js`, with the tool as a child process.

- **The command-line tool for coding agents: the interface as data, error codes and debugger steps.** `--describe`
  prints every step, exit code and error code as JSON; every error has a stable `code` (`timeout`, `missing-roms`,
  `untypable`, …). New steps: `registers`, `set-register`, `disasm`, `step` (exact instructions), `reset`,
  `power-cycle`, and `view` (the Dragon 64 Plus's 80-column screen, read as text); `asm` reports the program's symbols.
  The frame loops wait for the media store when a DriveWire read stalls the machine. `tests/cli-agent.test.js` checks
  the debugger steps against the Session's debugger, the special keys on both input paths and the script quoting rule.

- **Testing games from the command line: pictures, sound and held keys, with a guide and a starter game.**
  `--expect-screenshot FILE` compares the frame with a reference PNG pixel for pixel (any non-interlaced PNG of up
  to 8 bits a sample: grey and palette at 1, 2, 4 or 8 bits, RGB, with or without alpha) and fails with exit 1, the count of differing pixels and the first one (position,
  expected and actual colour); `--tolerance N` allows N pixels and `--diff FILE` writes the differences in red.
  `--wav FILE` (to `--wav-stop` or the end of the run) records the machine's sound as a 16-bit 44.1 kHz WAV through
  the page's own output stage, without its DC filter, in emulated time: DAC value d is the sample 320 x d, and the same
  run gives the same file byte for byte. `--hold KEYS[:N]` holds keys in the keyboard matrix for N frames, for programs
  that scan it themselves. The guide, `docs/game-development.md`, covers running with and without ROMs, the memory
  map, the formats CLOADM loads, the assembler, the keyboard matrix, the VDG and SAM modes, DAC sound and frame
  timing, and testing with a GitHub Actions example; its programs run in `tests/game-guide.test.js`. The starter game,
  `examples/starter-game/catch.asm` (one binary for the Dragon and the CoCo, no ROMs needed), comes with its play
  script and its picture and sound references (`tests/starter-game.test.js`). `tests/cli-wav.test.js` checks the WAV
  against firmware playing a known DAC pattern: every level exact and every interval between DAC writes the cycle
  count from the MC6809 data sheet, within 0.01 cycle. `run.js <dragon64|dragon32|coco> --sound` compares that path
  with MAME's `-wavwrite` (pitch, swing and mean level of DAC and single-bit square waves).

- **A faster start for contributors and coding agents.** `AGENTS.md` opens with "Start here": the ten commands
  you'll use and the rules most often broken; section 4 gains a table of which proof levels apply to which kind of
  change, what to do without MAME (run everything else and list the exact `run.js` commands under "Not verified"),
  and a checklist for adding an example program or game. `docs/development.md` has "The fast loop": which suites and
  browser-check groups to run for what you changed, and when the full gates are still required
  (`tests/fastloop.test.js` keeps its names real). `node tests/all.js --only <part>[,...]` runs a subset, marked
  `SUBSET RUN ... not the full gate`; a failing run now ends with `FAILED: <suites>`. `tools/build-examples.js`
  brings `sw.js`'s offline file list up to date, so a new example no longer fails `tests/pwa.test.js`.
  `docs/game-development.md` adds where a game goes in memory and two patterns that settle a test (wait for the
  byte, then a frame before a screenshot; wait for a key's release), each run in `tests/game-guide.test.js`.

- **Two games, 2048 and Minesweeper, on the welcome menu.** Written for CLOADM in 6809 assembly
  (`examples/2048.asm`, `examples/minesweeper.asm`, their shared `examples/games.inc`), they draw on the VDG's
  128x192 four-colour screen with their own font, play their sounds on the DAC, and read the keys through the
  firmware's POLCAT, so they run without ROMs (or with BASIC) on every Dragon, CoCo 1/2/3 and clone with 32K or more,
  the 6309 option included (a 4K or 16K CoCo is refused, saying why: the games set the SAM for 64K chips). BREAK
  leaves a game, on its title page too, putting the SAM back as it was: without ROMs for the menu, with BASIC back to
  BASIC, started cold (a BASIC program in memory is not kept: the game draws over it). The welcome menu's new
  **5 PLAY A GAME** opens "NEW GAMES FOR AN OLD MACHINE" (1 2048, 2 Minesweeper, 0 back); the carry-on line is now
  option 6, and offers the last game too. Also `?start=2048`,
  `?start=minesweeper`, the Media tab's "Runs without ROMs" and `--program 2048|minesweeper`. Minesweeper's first
  square is always safe, its flood fill uses a queue (the stack stays within 32 bytes), and at most ten flags.
  `tests/games.test.js` plays both against models of their rules and random numbers, and checks their screens
  (`--expect-screenshot`) and Minesweeper's sounds (`--wav`) against references; the browser check opens them from
  the menu. `docs/game-development.md` uses them as worked examples.

- **Direct links to LIZA, the Claude chat and the games.** `?start=liza`, `?app=claude`, `?start=2048` and
  `?start=minesweeper` open their program straight away, with no welcome menu first (the browser check counts the
  menu's starts to show it); a game link on an MC-10 or Alice says the game is 6809 code. `?start=` stays in the
  address while its program runs and goes once the program is left, as `?app=claude` does for the chat, so a reload
  after that is a plain visit. With both `app=claude` and `start=`, the chat opens and the link says `start=` was
  ignored. The Media tab's "Runs without ROMs" entries (the welcome menu, LIZA, the games, the
  chat) are real links to these addresses on the machine in use: right-click or long-press, Copy link.

- **An MCP server for coding agents.** `node cli/cloadm.js --mcp [--roms PATH] [--media-root DIR] [--read-only]`
  serves the emulator to Claude Code, Cursor, Claude Desktop and any MCP client (`docs/mcp.md`): boot up to 8
  machines, each addressed by the `machine_id` boot returns; the in-page Claude's own tools (`machine_info`,
  `screen_text`, `peek`, `disassemble`, `poke`, `type_text`, `load_basic`, `press_break`, `assemble_and_load`, `run`)
  with their schemas, results and refusals, run through the page's own code; and `run_frames` (it answers "not-yet"
  with the screen rather than blocking: about 25 s at most, cancellable, with progress; `until` text on the screen as
  a plain substring (no pattern waits), a byte in memory, the PC, the tape stopped or at its end, or the screen
  changed), `press_keys` (keys held together, the arrows and other named keys included, and the joystick, for some
  frames: for games), `find_bytes` (a hex pattern with `??` anywhere in memory), `step`, `registers`, `screenshot`
  (the only tool that returns an image; always a whole frame, `mid_frame` when the machine stopped inside one; `scale`
  up to 3), `reset`, `power_cycle`, `set_display`, `load` (a listing with or without RUN, saying what the keyboard
  changed or dropped), `insert_tape`, `insert_disk`, `save_snapshot` (only `.cloadm-state` files, never over a file
  that is not a snapshot or over the config file), `restore_snapshot`, `switch_machine`, `close_machine`,
  `list_machines` and `list_models`. A tape in the deck shows in every machine summary (motor, position, block, end);
  a machine booted without the user's ROMs says which files BASIC needs. When a condition on the screen is met,
  `run_frames` finishes one more frame, so a screenshot shows what the condition saw (the picture follows video memory
  by up to a frame). Errors have the in-page `{ code, remedy, detail }` shape; the program's own output comes labelled
  as untrusted; files are read and written only under `--media-root` (resolved with realpath and opened without
  following a link, so no `..` or link leads out, also one that leads nowhere yet; regular files only, at most 64 MB,
  so a FIFO or a device never blocks the server); every tool is annotated read-only or destructive, and `--read-only`
  offers only those that touch no input, memory or file (the others are hidden, and the server's instructions name
  none of them). With no media root given, it is `~/CLOADM` (made on the first write). `--roms` and `--media-root` can
  also come from `~/.config/cloadm/config.json` (`%APPDATA%\cloadm\config.json` on Windows); an empty value or an
  unfilled `${...}` placeholder counts as not given. Both protocol eras on stdio: the `initialize` handshake
  (2025-11-25 and earlier) and stateless 2026-07-28 (`server/discover`); lines of at most 4 MB, no batches, and a
  cancellation reaches a queued call too. `--serve` gives the same tools over JSON lines. The tools are one
  transport-neutral table (`js/mcp/tools.js`) that an HTTP transport or an MCP Apps view can mount later.
  `tests/mcp.test.js` drives the real server over stdio.

- **An agent skill for the MCP server.** `skills/cloadm/` (with a copy at `.agents/skills/cloadm/` for Codex, Cursor
  and Gemini CLI) teaches an agent to use the tools: boot, wait until the machine is ready, act, and check what
  happened; what runs with and without ROMs; tapes, games and `press_keys` against `type_text`; debugging with
  breakpoints, stepping, `disassemble` and `find_bytes`; snapshots as checkpoints; and the VDG and SAM mode bits from the
  data sheets. It stops if the tools are absent. The plugin ships it, and a release attaches it as a zip.
  `tests/skill.test.js` keeps the copy identical, the frontmatter valid, the tool table equal to the server's, and runs
  the skill's own claims and its PMODE 4 recipe on the server. `tests/skill-evals/` holds seven evals and
  `run.js`, which runs them with and without the skill (real model runs, outside `tests/all.js`).

- **CLOADM as a Claude Code and Cowork plugin and a Claude Desktop extension.** The repository is its own
  plugin marketplace (`.claude-plugin/marketplace.json`, `.claude-plugin/plugin.json`): `/plugin marketplace add
  yaniv-golan/CLOADM` then `/plugin install cloadm` starts the MCP server with no configuration. `mcpb/manifest.json`
  describes the Claude Desktop extension (`cloadm.mcpb`), asking for the media folder and an optional ROM folder; a
  tag `v*` packs it and attaches it to a GitHub Release (`.github/workflows/release.yml`, which fetches the packer in
  CI only: the repository still has no build step and no `package.json`). Install steps for Claude Code, Cowork,
  Claude Desktop, Cursor, Gemini CLI and Codex are in `docs/mcp.md`. `tests/plugin.test.js` checks the manifests: valid
  JSON, one version everywhere (this file's "Next version"), every path resolves, no placeholder but the ones each
  host defines, the extension's tool list is the server's, and the server starts as each manifest starts it.

#### Changed

- **The CoCo 3 keeps its bus log only while a device that can assert HALT is attached.** The log (the accesses of
  the instruction under way, so one HALT suspended can be run again and replay them) was kept on every machine.
  Only the CoCo FDC drives HALT here (its drive select latch's "HALT enable", `js/machines/fdc.js`), so a machine
  with anything else, or nothing, in its cartridge port now logs nothing and runs faster: measured on a CoCo 3
  without the controller, a median of five paired runs (46,000 frames each, a fresh process per run, alternating
  builds; every run is in the report), **+4.4% frames/s**; with the controller attached, where the log still runs,
  within noise of before (-1.2%). A device declares that it can, with `Device.canHalt`; a Multi-Pak answers for the
  cartridges in its slots, so a Multi-Pak rebuilt with a controller in one slot and put in over the old one settles
  it at once (the page's own path; there is no other). Nothing changes for machines with the controller, for the
  disk interface built into the Dragon Alpha, or for any snapshot: a held instruction keeps its own log and
  restores with it.

- **The log is kept honest.** A device that drives HALT without declaring `Device.canHalt` is refused at the first
  HALT, naming it, rather than suspending an instruction against a log that is not carried; and a cartridge asked
  to go in or come out from inside an instruction is refused the same way. Both are programmer errors, not states a
  person can reach (every page, Session and debugger path attaches between frames). A HALT from a source with no log
  behind it - in shipped code, only a test hook, since the slot's line timer is the only event that asserts HALT -
  halts the CPU between instructions instead of suspending one it could not replay. A snapshot loaded over a machine
  holding a different cartridge announces the port either way, so the log follows the file.
  `tests/coco3-buslog.test.js`, and the CoCo 3, FDC, halt-replay, halt-held and state suites.

- **The floppy-disk suite is split in four.** `tests/disks.test.js` had grown to about 150 s (v0.1.6 added about 900
  lines of mount-race and new-disk-race cases, each importing and mounting 40-track images, and a mount is about
  1.3 s of flux encoding, as it was in v0.1.5), close to and on CI over `tests/all.js`'s 240 s per-suite cap. Its cases, unchanged, now run in
  `disks.test.js`, `disks-mount-race.test.js`, `disks-mount-case.test.js` and `disks-newdisk.test.js`, with the shared
  firmware and store fixtures in `tests/disks-common.js`. No check was removed or loosened (206 passing checks before
  and after); the disk code itself is unchanged.

- **The home page's Dragon 64 looks like the real one.** The hero and the machine card draw it in inline SVG from a
  3D model of the real case's side contour, seen from the front left: the low front, the sloping keyboard deck, the
  raised rear plateau with its ventilation grooves (cut through the side edges, as on the real case) and the rear
  chamfer. On it are the black badge with a red dragon
  glyph, rainbow DRAGON and a white 64, the red power LED, and the black keyboard in its real layout with legends
  (shifted symbols hidden at phone width). The browser check makes sure the art is drawn, fits the page and is
  aria-hidden.

- **Docs: Dragon 64 Plus citations.** The HD6845S R8 interlace and skew decline and the 80-column character mapping
  (`$20`-`$7E` as ASCII) now cite their primary sources (Hitachi HD6845S data sheet R8 tables, P. Mooney's IC22 dump,
  the Dragon Archive's Compusense ROM dump, P. Harvey-Smith's traced schematic) instead of "as recalled" and
  "assumed"; `docs/verification.md` lists the schematic-derived findings, two of which (SAM P1 and the MC6847's bank)
  differ from current behaviour and are open items. The schematic wiring is marked "from a traced schematic with known
  drawing errors; not verified on hardware" in the docs and code comments. Comments and docs only; no behaviour
  change, except that `SCREEN_TEXT_DESCRIPTION`, the tool description Claude sees at run time, is reworded (the ASCII
  mapping now cites its sources; the wording change is all).

- **The creation-landing tests behind the Library's import.** `tests/importmedia-finally.test.js` holds an import
  inside its store write, queues a second creation of the same name behind it, and makes the case probe that follows
  the write throw: the first import reports that error and its bytes stay stored, and the queued second is refused
  with the Library's own message rather than replacing it - the `finally` around `refreshCase` in `importMedia` and
  `importDiskStored`. The same shape with the probe succeeding, and an import asked after the first finished taking
  the name as a deliberate replace. It also holds the probe itself and asks a second creation inside it, which proves
  the name lands at the END rather than straight after the write: a landing made after the write would let that
  second creation count as a replace and take the name. No product change.

- **Menus and boxes give the focus back** (UX rulings R15–R18). The machine menu closes on `Esc` wherever the focus
  is (on the screen too, where it used to stay open and `Esc` went to the machine as BREAK), on `Tab` out of it,
  and on a press outside it, and the focus goes back to its button unless the press landed on something that
  takes the focus. The same for the phone's **Menu** links (`Esc` and a tap outside, back to **Menu**; open only
  while they show, so a leftover open state at desktop width no longer swallows BREAK), a drive's menu (the focus
  stays on the drive's button while the menu opens and comes back to it on `Esc` or a press outside, not to the
  screen) and Ctrl+K (a press outside gives the focus back to what had it, not to the page). The touch keys' Menu
  is a disclosure button for a labelled group ("Keys menu") instead of a menu with no items: it opens with the
  focus on its first button, and `Esc` or a tap outside gives it back to **Menu**. A menu counts as open only while
  it shows: one hidden with the app bar or the machine keyboard (under the Debugger, Add ROMs or a phone's chat)
  no longer takes the `Esc` meant for what is on top. Ctrl+K says politely how many commands match
  once the typing pauses, and the Library's "N selected" is a polite live region written only when the count
  changes. `js/ui/page.js` `outsidePress` is the one press-outside rule.

- **Every toast is visible** (UX ruling R24). A toast that finds no place on the emulator page where it covers
  neither a control nor the screen's text no longer waits unseen: it takes a fixed slot at the top of the viewport,
  above everything but the dialogs, keeps that slot until it goes, and its time starts there ("never invisible" wins
  over "never covers a control"). A disk dropped without a disk ROM used to say nothing visible, at desktop and phone
  sizes alike. An error toast is red (`--error`, 4.76:1 on the toast), no longer the orange of a warning.

- **A switch names what comes out** (UX ruling R25). The question before a machine switch now says what the
  switch takes out of the machine in use ("Switching to Dragon 32 resets the Dragon 64 and takes out the tape
  GAME.CAS and the disk WORK.VDK in drive 0. They stay in your Library."); a disk that came with a snapshot is named as
  not kept, with **Save to Library** (`Session.keepSnapshotDisk`: stored, and the drive linked to it, as one Library
  operation that a Library move waits for; a retry saves only the disks still unsaved). DriveWire disks
  (they stay mounted) and a Speech/Sound Pak the new machine puts back are not listed. A RAM change asks the same
  question ("Changing RAM switches the CoCo 1/2 off and on and takes out …"); it used to ask nothing. After the
  switch a message says "Switched to Dragon 32. Took out: GAME.CAS, WORK.VDK (drive 0)." (`Session.takenOut`), as does
  a switch made by opening a snapshot.

- **The disk ROM is findable** (UX ruling R26). **Your ROMs** shows a card for the disk ROM on every machine whose
  cartridge port takes a disk cartridge ("Disk drives (optional): DragonDOS or Delta DOS"; "Disk BASIC (RS-DOS)" on
  the CoCos), none on the Dragon Alpha (its own drives) or the MC-10. A drive's **Add ROMs…** opens Your ROMs on
  that card instead of a bare file chooser. The card is not one of the machine's sockets, which are counted as before.

- **The machine menu and the palette lead to the ROMs** (UX rulings R28, R28b). The machine menu's footer is two
  menu items after a separator, in its arrow and `Tab` order, with the "✓ = BASIC ready" legend beside them: **Add or see ROMs…** (Your ROMs for this machine, the
  focus on its heading) and **RAM, CPU and speed…** (Machine settings, the focus on its heading; on a phone its top
  scrolled into view). Choosing a machine that needs ROMs ends with "Switched to Dragon 64. It needs ROMs for
  BASIC." and **Add ROMs**. Ctrl+K has **Your ROMs** ("see, add or remove ROMs"), first under Settings, for rom,
  roms, basic, firmware, add roms and your roms; **Machine settings** no longer answers "roms". The ROMs row is the
  first in Machine settings, which now has that heading, and its button reads **Add ROMs →** without BASIC and
  **See or add ROMs →** with it. The page says "Machine settings", never "Machine tab".

- **ROMs in the Library** (UX ruling R19 A+). A **ROMs** chip after Snapshots shows one card, not tiles: "Your ROMs:
  2 stored, used by Dragon 32 and Dragon 64. Manage them in Your ROMs →", or "No ROMs yet. CLOADM never includes
  ROMs; add your own dumps in Your ROMs →" (`Session.storedRoms`); with ROMs stored the chip is there even when the
  Library holds nothing else. A ROM dropped on the Library says "added to Your ROMs" with **Open Your ROMs**.

- **Copy** (UX ruling R27). The page no longer says "stub": the ROMs row reads "BASIC ready" or "Not added · running
  without ROMs", and Share says the person opening a link "runs it without ROMs". One term, **disk ROM**, replaces
  "DOS ROM" and "disk cartridge ROM" ("Disks need a disk ROM: …"). A file for the other family is described once:
  "dgame.dgn is a Dragon cartridge; the CoCo 1/2 may not run it." with **Open on Dragon 64** and **Load anyway**.
  Share and the Snapshots list say "A snapshot reopens on the same machine, RAM and ROMs."

- **BREAK and CLEAR work in LIZA.** Its line reader used to ignore every control key but backspace and ENTER. Now,
  on the 6809 build and both 6803 builds (MC-10, Alice), BREAK (POLCAT code 3) leaves exactly as `BYE` does, the
  same goodbye and the same end loop, so without ROMs the welcome menu comes back; CLEAR (code 12) drops the half
  typed line, clears the screen to the title and a fresh `>` prompt, and the conversation goes on. The MC-10 and
  Alice have no CLEAR key: on the built-in firmware `Home`, `Delete` and the on-screen CLEAR still send 12. Without
  ROMs, every host key the keyboard maps to BREAK or CLEAR now gives the program that key's code (`Delete`, and in
  positional mode `End` and the MC-10's `]`, gave nothing or the character before). `tests/liza6803.test.js`,
  `tests/returning.test.js`, `tests/keyboard-symbols.test.js` and the browser check cover it.

- **The welcome menu's lines are tapped by their number.** A tap on a menu line presses the inverse-video number at
  its start, whichever row it is on, so the games menu and the carry-on line can be tapped too (before, rows 9-12
  were taken as 1-4 whatever the menu showed).

- **The assembler takes a comment after an instruction with no operand without a `;`**, as Motorola's assemblers do:
  `LSRA   shift the row bit` assembles (it was "LSRA takes no operand"); text that starts like an operand (`ABX 1`,
  `LSRA ,X`) is still an error. After an operand a comment still needs `;`
  (operands may hold spaces, as in `LDA #1 + 2`), and the error now says so. 6809, 6309 and 6803.

- **Claude's `peek` returns hex rows** of 16 bytes with their address (`"$0400: 4C 49 5A …"`), not an array of
  numbers, and `disassemble` each instruction's bytes as hex (`"31 3F"`): far fewer tokens for the same bytes.

- **Claude's `screen_text` counts semigraphics blocks** on the VDG's text screen (`semigraphics`, with a `note`): a
  picture made of blocks read as an empty screen before.

#### Fixed

- **A write from outside the CPU no longer runs in the middle of a held I/O access.** On the CoCo 3 an instruction
  the disk controller's HALT suspended asks the scheduler to pump its events at the held access's time; the
  debugger's memory write made from a host handler reaching the bus in that window ran in a machine state no instruction
  may see. A write to `$FFD6`-`$FFD9` there ended the suspended instruction from inside its own event, before its
  cycle count was charged: the same write made while the CPU was parked charged 34,724 CPU cycles over a frame,
  and made one tick inside the window charged 4,856. An outside write made in the window is now queued and made between
  instructions, at the machine's own time, exactly where one made while parked lands - the same write, the same run
  afterwards, cycle for cycle. Only an event handler is ever in the window (it is open only inside the machine's
  own event run); a UI POKE or a debugger-panel write, which arrive between frames, never finds it - though while a
  queue is still waiting (after a stall) such a write joins it and lands when the machine next runs.
  `poke` (no bus cycle) is not queued - unless a queued write is still waiting, which it follows, so the later call's
  value is final; a read is serviced in the window at the held access's time, side effects included - a read that
  releases HALT is what a halted loop waits for. A save taken while one waits carries it, so a
  restore does not drop a debugger's write; it is an optional key in the snapshot at the same format version, so a
  file from this build still opens in an older one, and a file from before it restores owing no such write, and a
  file whose queue holds a poke at `$FF00` or above is refused, as `poke` itself refuses the I/O page. The queue is
  made in order: the entry being made stays at its head until it has landed, so a write an event handler makes
  meanwhile (its I/O sync pumps events) lands after it, and a flushed write that stalls the machine (a DriveWire
  write) ends the run before any instruction runs under the stall. `tests/held-writeio.test.js`.

- **Reset after a game no longer says CLOADM failed.** Many machine-code games set BASIC's warm-start flag and
  vector ($71 = $55, $72-$73 pointing at a NOP of their own), so **Reset** goes back into the game with RAM kept,
  as on a real machine. The boot box then counted 5 seconds from the Reset, saw no OK and said "No OK after 5
  seconds … a problem in CLOADM". The watchdog now arms only on a power-on (a new machine, **Switch off and on**,
  ROMs changed). After a Reset that a program took over, the box says "A program took over Reset" and offers
  **Switch off and on** for a clean BASIC (`Session.bootStatus` answers `reset`, with `takeover`).

- **Add ROMs no longer keeps old offers to switch machine.** A ROM drop's "Switch to …" offers stayed for the
  whole visit, so opening Add ROMs later (from the boot box, say) still offered "Switch to Tano Dragon 64" after a
  drop of Dragon 64 ROMs. Offers now show only with the drop that made them: they go when Add ROMs closes and on a
  machine change, power-on or Reset. A machine whose sockets hold the same ROMs as the one in use (the Dragon 64 and
  the Tano Dragon 64) is not offered, and **Switch to …** asks first, as the machine menu does.

- **Reset keeps the 6809's flags, and a CoCo's Reset latches no serial edge, as MAME's.** A Reset (not a power-on)
  sets only CC's I and F, leaving the others as they were (the 6309 too), and leaves PIA1's CA1 line as it is
  instead of latching a new edge from the serial port. Found by the new lockstep comparison of the Reset button
  (`run.js <profile> --reset`, `tools/mame-diff/sam/reset.asm`): every instruction identical through two Resets on
  every SAM machine compared and on the 6309 (dragon64h, tanodr64h), and four cases in the regression gate.

- The **Switch off and on** button's tooltip said it ejects the tape and cartridge; they stay in, and it says so.

- **Opening a snapshot no longer says CLOADM failed.** Opening a snapshot (a file or a quick-save slot), or putting
  a moment back with Claude's **↶ Restore to …**, no longer brings up the boot-failure box ("No OK after 5 seconds …
  a problem in CLOADM"), whenever in its run the moment was saved: before, one taken more than five seconds into its
  run showed the box the instant it opened, and an earlier one showed it after the rest of the five seconds. A
  loaded moment is not a power-on; it is now marked as such (`bootStatus` answers `restored`). A **Reset** leaves a
  loaded moment on the Reset rules (RAM kept, no "the boot failed"; a program holding BASIC's warm-start vector gets
  "A program took over Reset"); **Switch off and on**, or a ROM change, arms the boot check again. The browser check
  opens a snapshot of a game, waits 6 s of the machine's own frames, and requires no box.

- **A failed import or new disk now names the file it was for.** When the case probe that follows a disk image's
  write throws, `importDisk` reported the store's own message with no file name, where `importMedia` reports
  `<name>: <reason>`. The wrap now happens once, in the creation both callers use (`importDiskStored`), so
  `importDisk` and `newDisk` report the same form: `work.vdk: the store's reason`. A message the creation already
  phrases itself (`… was saved to your Library but not put in drive N`) keeps its exact wording, because `mediaError`
  hands a `SessionError` on unchanged. (A backend message that itself carries the path therefore reads
  `work.vdk: disks/work.vdk: …`, which is what `importMedia` has always done with the same message: the rule is one
  name in front of the store's text, not a rewrite of the text.) `newDisk`'s own check, before it writes anything,
  was the same gap (it lists the Library to see whether the name is taken) and is named the same way; with no name
  asked, the name is chosen from that listing, so a failed listing there reports as "A new disk: ..." (there is no
  name to use yet). `tests/importmedia-finally.test.js` cases 4, 9, 10, 11 and 12 hold the red-first copy, the second
  caller's copy, the exact-wording rule, the pre-write listing, and the unnamed, empty-label and path-bearing shapes.

- **The browser check's busy-page audio test supplies the audio it tests for, instead of racing a queue that a
  stall empties, and the Help says what a busy page really does.** The check demanded that some block played during
  a page stall take queued samples (`queued > 0`). That is not a property of the audio thread: measured, it is the
  queue's depth divided into blocks (`blocks with samples >= floor(buffered / 128)` in every case), so it is whether
  the queue happened to be non-empty when the stall began. A page stall longer than the queue empties it, and a
  loaded machine failed the check (`{"queued":0}`). The test now puts a known 100 ms into the queue itself, through
  the page's own output path (`AudioOutput.push` -> `sink.write`), in the same task as a 500 ms block of the page's
  thread - and nothing can add to the queue while the page is blocked. It then asserts three things, each derived
  or fail-closed: that the page really was blocked (no machine frame ran, the spin lasted its 500 ms, and the
  AUDIO clock - which the window is measured on, because the worklet stamps its blocks with `currentTime`, not wall
  time - advanced past the window's end before the page woke, so nothing can have been rendered late and counted);
  that the worklet kept rendering, at least `floor(0.35 s * rate / 128)` blocks, the number a half-open window of
  that length holds at any phase (the old `- 2` allowed two quanta the window cannot miss); and that the fill was
  really played and kept being pulled - the window reaches the fill's own last sample, which old audio alone cannot
  do, and from there every block takes its whole 128-sample quantum until the fill is spent; the short-block rule
  must also have examined a fill block at all (`blocksInFill > 0`), which the reach does not imply - a thread that
  threw its queue away before the window's first block would reach the fill's end with nothing to check. So a thread
  that skips quanta fails either way: one that skips three in four never reaches the fill's end inside the window,
  and one that skips one in four reaches it but takes short blocks while the fill is still queued. Neither can hide
  behind audio that was already queued. Consecutive blocks must also run on with no gap, so
  no sample is dropped: this is not an in-order check (it is self-consistent by construction and cannot see a
  reorder). The window is 350 ms: as much as `MAX_MS` (150 ms) plus a frame (~20 ms) can already be queued when the
  fill goes in, so ~170 ms can pass before the fill is touched and ~270 ms before it is spent (nearer ~282 ms in
  practice, because the page's own lateness estimate reads low by design) - 350 ms covers that with ~68 ms to spare
  while still ending 150 ms inside the spin. It is a margin, not a proof. The fill
  is 100 ms and no more because the queue holds 300 ms (`CAPACITY_MS`) and drops the oldest samples on overflow.
  A page-side `buffered()` comparison was written and then rejected: it reads the processor's last report, up to
  ~12 ms stale, and in a probe it read 0 while the worklet then played 705 samples, so it can pass a starved queue.
  The Help's "a busy page doesn't make it stutter" is corrected to what happens: sound keeps playing for as long as
  its queue lasts (a few tens of milliseconds), then fades to silence. `tools/browser-check.js` and `docs/using.md`
  only; no page behaviour changed.

- **What the ROM privacy text says about Claude.** The README, the Using guide, the front page, the **/roms** page, the
  Help page and the ROM panel said ROMs are "never uploaded". That is true of CLOADM itself, but Claude's `peek` and
  `disassemble` tools read whatever the machine has mapped, ROM areas included, and what Claude reads goes to Anthropic
  with the conversation. The copy now says both: CLOADM never uploads your ROMs and never puts them in share links or
  exported settings; if you use Claude, what it reads from the machine's memory (ROM areas included) is sent to
  Anthropic as part of your conversation. The Ask Claude panel's footer line, `docs/claude.md` (the Consent and tools
  paragraphs) and the Help page's "What Claude can do" say the same. Wording only: no tool behaviour changed, and the
  browser check asserts the new text.

- **A phone held sideways keeps the whole control row in view.** On a short landscape screen (an iPhone in Safari,
  about 1000x461 or less) the row under the screen cut BREAK and CLEAR to "BRE" and "CLEA", and in Safari its lower
  part fell behind the bottom edge, as the panel and the screen were sized with `vh`, which counts the height behind
  the browser's toolbar. The row (BREAK, CLEAR, Keys | Joystick, Menu) is now centred along the bottom, as wide as its
  labels need and at least as wide as the screen, under the keyboard's halves as well; the panel and screen are sized
  with `dvh` (where the browser has it) and keep clear of `env(safe-area-inset-*)`, the page now covering the display
  (`viewport-fit=cover`). The keyboard's rows share the height above the row (56 px, never under 40), and a window
  over 900 px wide no longer pulls the panel off centre. In Joystick mode the row is the same; the strip goes to two
  rows of four, with SPC, ENT and BRK as short labels (named "SPACE (SPC)" and so on, so the label shown is in the
  name), where it clipped SPACE, ENTER and BREAK; on the shortest windows (653x280) the keys close up so each keeps
  40 px without running into the top padding. As the page now reaches under a notch and the home indicator, every
  overlay keeps inside the safe area as well: the toasts (also where `js/ui/feedback.js` places them), the install
  card (and `js/ui/install.js`'s placement), the command box, the Ask Claude panel and sheet, the status pill over a
  page view and the chat's turn status, all through one `safeArea()` (`js/ui/page.js`) and the `--safe-*` insets.
  The browser check's input-screen group loads six short landscape sizes (the iPhone 15 and SE in landscape, 844x390
  and 932x430 with emulated notch insets, 667x375 and 653x280) in both modes and requires every control whole,
  inside the safe viewport, clear of the screen and of each other, and puts each overlay inside the emulated safe
  area sideways and upright.

- **The on-screen ← key reads as backspace.** The Dragon's and CoCo's ← (backspace) key on the touch keyboard, upright
  and in the split keyboard sideways, keeps its arrow with a small DEL under it, and its accessible name is
  "DEL (Backspace)", beginning with the word shown (WCAG 2.5.3). The browser check's input-screen group asserts the
  name in both layouts.

- **Tapes that load over BASIC's own memory now start.** A machine-code tape dropped on the page (or opened, or
  loaded from the Library or a link) went in with `CLOADM:EXEC` typed on one line; a tape that loads over BASIC's
  line buffer (from $0150, as many commercial tapes do) overwrote the `:EXEC`, and its program never ran. The page
  now types `CLOADM`, waits for the tape, and types `EXEC` on a line of its own only once BASIC is back at its
  prompt; a tape that starts itself gets no keys at all (`Session.loadMedia`, `Typist.typeWhen`).

- **A tape loads on a clean machine.** Before a tape loads through BASIC the machine is restarted, as on a machine
  just switched on (the deck and the cartridge stay); what ran before (a `CLEAR`, 64K mode, a crashed program)
  no longer moves BASIC's stack and memory under a tape that relies on them. The status line says "Restarted for a
  clean load".

- **`.CAS` files with short leaders load.** A `.CAS` file has no silence and often shortened leaders; BASIC waits
  half a second after starting the motor before it looks for a block, so the first data block of such a file was
  missed and the program loaded 255 bytes low. Tapes are now played with silence around each namefile and a full
  128-byte leader in front of the blocks BASIC looks for, the amounts MAME uses (measured with
  `tools/mame-diff/tape/run-playback.js`, our own firmware in MAME and here: the same silences and the same blocks
  read on the Dragon 64 and the CoCo). Snapshot format version 3 records a tape's position in the new signal;
  version 1 and 2 files restore their tape at the same place.

- **A tape dropped while the machine runs without ROMs uses your stored ROMs.** The welcome menu, LIZA, the colour
  demo and **Run without ROMs** take the machine's ROMs out for the rest of the visit; a tape dropped then went
  straight into memory on the stub firmware, which has no BASIC for the program to call, and a commercial game
  crashed with its data on the screen. If the machine's ROMs are stored, the tape now uses them again and loads
  through BASIC ("Using your ROMs again to load … through BASIC"); without stored ROMs, or with **Load .CAS straight
  into memory** ticked, it goes into memory as before, and so it does if the stored ROMs do not start BASIC (the
  page says so). The Claude chat's own machine never takes them.

- **The Dragon's and CoCo's single-bit sound is 32 DAC steps loud, as in MAME** (it was 31.5: 1.5% quiet against
  the DAC). The Tandy service manual's resistor values (as MAME's `coco12.cpp` cites them) make it the weight of the
  DAC's top bit; `run.js <dragon64|dragon32|coco> --sound` measures it against MAME's `-wavwrite`, and
  `tests/cli-wav.test.js` pins it.

- **Claude's `machine_info` named the MC6847 graphics modes wrongly from GM2 on**: PMODE 4 (GM7, $F8) read as
  "256x192 4-colour" instead of 2-colour, and every mode from GM2 one step off. The names now come from the VDG's own
  mode table (`js/chips/mc6847.js`), with the data sheet's names (CG1 … RG6), and the CoCo 3's legacy VDG modes name
  their graphics mode too.

### 0.1.6-pre

#### Added

- **Claude reads the Dragon 64 Plus's 80-column screen.** `screen_text` (and `machine_info`'s `video.readable`) used
  to decline the HD6845S screen; now, while the Display tab shows it, it reads the board's 2K video RAM as the CRTC
  walks it (start address R12/R13, R1 columns, R6 rows, the 2K wrapping), the same walk the picture is drawn from,
  with `screenRows`, `startAddress` and `base`. Codes `$20`-`$7E` are read as ASCII, an assumption no source could
  confirm; it declines, rather than guess, an interlace mode, inconsistent or oversized registers, rows under the
  board's 10-line character and any other code. No character
  generator ROM is needed. Verified with our own firmware (`tools/mame-diff/d64plus/plustext.asm`): in lockstep
  with MAME 0.264 to HALT, and six screens identical to MAME's pixel for pixel (`run.js d64plus --plustext
  [--video]`); `tests/d64plus-screen-text.test.js` and the browser check's Ask Claude on a d64plus.

#### Changed

- **The welcome demo's sound is one short clean tone.** "2 COLOUR AND SOUND" used to write one DAC value per frame, a
  staircase that ticked at the field rate and popped from full scale to zero about once a second. It now plays a
  single tone as the colour bars start: a square wave around the DAC's centre `$80` (high `$B0`, low `$50`, about 37 %
  of full scale), 659.9 Hz (a cycle-counted loop: 1356 cycles a period at 0.894886 MHz) for 264 periods, 0.40 s, ending
  on `$80`, and then nothing more is written to the DAC. The bars, their scrolling, the colour-set flip and the key
  that returns are unchanged; the first bar frame comes 0.4 s later. `tests/demo-tone.test.js` runs the demo on the
  Dragon 64, CoCo and CoCo 3 and checks pitch, length, amplitude, the first and last value, the largest step, 200+
  silent frames afterwards and the picture against the bars' definition.

- **Every DriveWire server the Session builds reads the store's case rule, and now each one is pinned.** The
  Session creates three servers on the same media: the Becker port's, the one a real CoCo is served from over Web
  Serial (`serveRealCoco`), and the chat's. Each is given the store's name comparison at construction (GAME.DSK and
  game.dsk are one file on a folder that does not tell cases apart), but only the Becker one was tested, so
  dropping that wiring from either of the other two left every suite green. `tests/drivewire-samename-servers.test.js`
  checks all three: on a case-insensitive store a named-object mount of the other spelling resolves to the drive
  that already holds the file and adds no drive, and a second drive on that file is refused naming the first; on a
  case-sensitive store the same calls are two files, so the mount takes a free drive with its own bytes and the
  second drive is allowed (the control that stops these checks passing on a server which refuses everything). The
  real CoCo is served over a stub serial port, not Web Serial. No product change: `js/` is untouched, and the
  wiring was already right, just untested (on the commit before this one, with both non-Becker wirings removed, the
  three suites that cover those servers still passed).

#### Fixed

- **A new blank disk and an import of its name racing each other.** Both check the library for the name and then
  write it, with a listing and the wait for the drives' writes in between, so two of them could both pass the
  check: the later write replaced the earlier image under its own name, and the drive then read back the other
  image's bytes (a new blank disk could end up holding the imported image's bytes, and the imported bytes were
  gone with no error at all). A new disk, a drive import and a Library import are now made one at a time: a
  second one waits for the first to have written and then checks again, so it is refused as it would have been
  had it come second -- the second new disk with "There is already a disk named … in your library", an import of
  the name with the drive it is in, and a new disk's first free name skips a disk a queued import has just made.
  Names compare the way the store does, so `GAME.DSK` and `game.dsk` are one name on a case-insensitive store and
  two on a case-sensitive one. A second creation of a name -- in another drive or the same one, under the same
  spelling or another case, and including a name a new disk picks for itself -- is refused and the first one's
  bytes are kept; a disk already in the library is replaced only by an import asked for after its creation
  finished, which is how a disk in a drive takes a newer copy of itself (and if the first creation fails, nothing
  is refused). A Library import waiting its turn when the library starts moving is refused rather than written
  into the folder it is leaving. There is no deadline: a creation whose store write never answers holds the later
  ones until it does, as a hung store write already holds a mount or a library move, so nothing runs alongside it.

- **Moving your library no longer loses (or strands) what was being saved.** **Where your library is kept** copies
  every file to the new place, and it could copy the library out from under a Library operation already under way:
  an import, a rename, a delete, a quick-save slot or a DriveWire image started just before the move landed in the
  old place after it began, so it was either dropped or missing from the moved library. The move now waits for
  those operations to finish first (theirs or their failure, which stays theirs to report), and refuses a new one
  while it copies, saying "The library is being moved: try again once it is done" - the same answer the Library's
  own changes already gave. The wait is bounded: an operation that never ends (a folder whose permission went, a
  store that stopped answering) does not hang the move for good - after 30 seconds in all, the drives' last writes
  and the Library's operations waiting together under the one limit, it stops with a message and your library stays
  where it was. The Undo of a save, a ROM drop or ROM pack restore (which write the library's own index), and a
  DriveWire mount or named-object create on the emulated machine's Becker port (a mount hands the drives the store
  they then write in, and so did a NitrOS-9 boot) are covered too. A mount begun while the copy runs is
  refused. A guest's create (the stat, the write of the new object and handing the guest its drive) is one Library
  operation: begun while the move copies it is refused (answered 0); under way when the move starts, the move waits
  for it, then finds the guest's new drive mounted and is refused itself ("Eject the disks first"), with nothing
  copied and the session on the place that drive writes to. A NitrOS-9 boot is refused before it changes the machine
  if a move began during its reads; past them, a move that begins during its mount waits for it and is refused the
  same way, so a boot is never left half done; an image added in the NitrOS-9 slot whose boot a move then refuses
  says it was kept ("… was saved to your Library but not booted: …"). This covers the Becker-port server; serving a
  real CoCo over Web Serial and the Claude chat's own DriveWire server are not covered here (`js/session.js`,
  `js/drivewire/server.js`, `tests/move-inflight.test.js`).
- **DriveWire's Save drive 0 threw when its image list could not be read.** With no drive chosen, **Save drive 0**
  asks the store for the first image; a refused listing (a folder whose permission was revoked, a store that would
  not answer) made that a promise nothing handled, and with no image at all it read a name off an empty list
  ("Cannot read properties of undefined"). It now says what the Library says, on the status line ("the DriveWire
  images: the folder's permission was revoked", or "No DriveWire image to save: add one first."), and the box
  renders empty rather than aborting (`js/ui/drivewire-panel.js`; the browser check refuses the listing and clicks Save with no drive chosen,
  counting unhandled rejections).

- **A background save that fails can no longer stop the media library saving anything again.** The page's
  handler for a failed background write (a full browser, a permission that went away) draws the status line; if
  that handler itself threw, the media index's write queue took the exception and every later write was dropped
  for the rest of the session (the ROM images of a program loaded afterwards, the recent list, the name map), and
  waiting for the queue rejected with the handler's error. The index now catches its handler's error and reports
  the failed write itself (`console.error`: always when no handler is set, as an embedder may leave it, and when
  the handler threw), and the queue goes on (`js/media/library.js`).
- **A disk image no longer fails to go into a drive when another drive is writing.** Mounting a stored disk reads
  it once every queued change has reached storage; when a change was queued while it read, it read again, and after
  four reads it gave up with "the drives kept writing while it was read". The check counted every change to every
  stored disk, so writes on another drive (or a long transfer to a slow store) could use the four up and make a
  perfectly good mount fail with no data lost. The mount now reads again only for changes to the image it is
  mounting, and which names are that image follows the store's case rule (the same measured rule the Library's
  guards use): on a store that keeps `A.VDK` and `a.vdk` apart only its exact name counts, and on one that holds
  them as one file either spelling does. A store whose rule is not measured yet is taken as case-insensitive, so
  the mount reads again rather than keep bytes that may be stale. An image that really keeps changing under the
  read still ends with the same message after four reads (`js/session.js`).
- **A NitrOS-9 floppy image added to the Library is written through the disk queue.** Picking or dropping a
  NitrOS-9 floppy image stored it with a direct write, outside the queue the drives and the Library's disk changes
  use, so a mount of the same name reading at that moment could take the bytes from before the write without
  reading again (a torn read). The write is now queued like every other change to a stored disk, so such a mount
  waits for it or reads again (`js/session.js`).

- **The browser check drives Stop in both orders, and reads the translated key as the exact set.** The ask check
  clicked **Stop** as soon as the pill said "Claude is typing line …", and the pill takes its line number from
  the typist queue before any key has been read (`js/ui/claude.js`). Stop could then land with nothing typed,
  and the page correctly said "– stopped before typing" (`js/claude/actions.js`: it says "while" only when keys
  were delivered) while the check demanded "while": a one-frame race. Measured on a Mac with a probe in a copy:
  Stop was clicked with 0 keys read and the line still said "while" in 6 of 6 runs, and the same code failed the
  phone case on a loaded full run. The check now waits, fail-closed, until the typing job has read a key and is
  still typing, asserts that state at the click, and then asserts "– stopped while typing 40 lines" exactly. A
  new case holds the machine with the page **Pause** (which pauses the machine, not Claude), asserts the job is
  typing with 0 keys read, and asserts "– stopped before typing 40 lines" exactly; it runs last because its turn
  makes a restore point. The translated Shift+2 check asserted that the character's key was among those held, so
  a page bug leaving SHIFT down with `@` would pass; it now asserts the whole held set from the matrix
  (`js/machines/keyboards.js`): `2, SHIFT` for `"` and `@` for `@` (this host's Chromium reports `@` for
  Shift+2, so only that branch runs; the `"` case is asserted but unexercised here). `tools/browser-check.js`
  only; no page behaviour changed.

- **The browser check is host-independent, and its keyboard checks no longer race the machine.** Several of
  its checks only passed on a PC or on an idle machine. The desktop "Commands…" check expected `Ctrl K`, but
  the page chooses that hint when `navigator.platform` is not a Mac or an iOS device (`js/ui/command-box.js`)
  and a Mac renders `⌘K`. That block now pins the platform to a PC before the page loads and asserts the
  literal `Ctrl K`, the Mac block keeps its own, and a new table pins Mac, iPhone, iPad, Windows and Linux and
  asserts each one's literal hint, so the page's own platform test is exercised on every branch and a wrong or
  missing hint fails. The input checks read the keyboard matrix at fixed moments: `heldNow` ran a fixed 3
  emulated frames (translated Shift+2 and positional Q), and the joystick "does not type" check read it with
  no wait at all. A held key goes through `KeyQueue`, which applies one change a frame and holds a key 3
  frames, so on a loaded machine the read could see the previous step's release and not yet the new state. The
  two `heldNow` checks now wait for the queue itself to drain (`session.keys.pending`), and the joystick check
  drains the queue and the matrix before reading. Measured on a Mac with `--only input,commands`: the old
  checks failed `input` in 2 of 3 runs, and this code passed all 45 checks in 3 of 3. `tools/browser-check.js`
  only; no page behaviour changed.

- **The test gate's summary check, closed where it could still pass a suite that failed** (the follow-ups from that
  change's review). A suite that stopped part-way could still print its summary from a `beforeExit` or `exit`
  handler, and the gate read that as a pass; every write made while the process is shutting down is now marked and
  not read as a summary (`tests/no-exit.js`, `tests/suite-verdict.js`). A suite whose summary it reached while
  running and which then printed a line at exit was FAILED on main; that healthy suite now passes. A suite that
  printed `FAIL <what>` to stdout and then a passing summary, or reset its own exit code, passed; any line starting
  `FAIL ` now fails it whatever it exits with (no suite here prints one on a passing run: they were all run and
  scanned, and `tests/allsummary.test.js` holds that). The static check that every suite prints exactly one readable
  summary now reads double-quoted strings, `console.info`/`console.debug`, `%d` formats and a concatenation of
  three or more literals, which it missed before. Every summary pattern's `^` and `$` is held by a rejected line
  only that anchor rejects, so no anchor is unpinned. `tests/asm.test.js`'s
  comment claimed the LIZA conversation was counted in its tally; it is not, and its failures now print in the
  gate's one `FAIL ` shape rather than only in the summary's last word.
- **A regression count that never answers fails the gate instead of hanging it.** `tests/all.js` asks the
  regression suite for its case count with `--count`; that call had no timeout, so a child that never exited left the
  gate waiting for ever. It now runs under a 10 s cap (about 180x the measured 55 ms, so a slow machine is never
  mistaken for a hang), kills the whole process group on timeout, and fails the run naming the child. The test's own
  bound is a hard one with the group kill, so a regression there hangs nothing.

### 0.1.5-pre

#### Added

- **Install CLOADM as an app.** **Install CLOADM…**, at the foot of the **machine menu**, runs the browser's own install prompt where there
  is one (Chromium, with its mini-infobar suppressed and the page's own card asked instead) and shows the steps
  that install it elsewhere (Firefox Android, Samsung Internet) and on iOS, which has no install event (Share →
  Add to Home Screen). Once a program has run for a minute on a visit, the page offers it in a card that
  covers nothing you look at or press (the screen, the machine controls, the app bar, any on-screen key):
  bottom-right over the page, beside the screen, or a one-line strip between the screen and the keys on a phone
  held upright. With no such room it is deferred unspent and comes when a resize makes room; a menu or a view
  opening takes it away unanswered and it returns when they close. It never takes the keyboard from the machine
  (Esc on the screen stays BREAK); Esc elsewhere or **Not now** to wait 14 days (a
  second **Not now** ends the offers), **Don't ask again** to end them at once, and the browser's `appinstalled`
  shows "Installed." and stops asking. The card, the Menu item and their state are `js/ui/install.js` (the rules
  are pure functions, pinned in `tests/install.test.js`); the Help page has the steps for every browser.

#### Changed

- **Restore points: one small line instead of a card after every message** (UX ruling R12). Under the latest turn
  that changed the machine: "↶ Restore to 23:58 · Restore points…", the second opening every point (the last 10)
  and what restoring does and doesn't roll back; while a turn runs, "Restore point at 23:58 · Stop first to restore".
  The same line in the side panel, the phone sheet and the full-screen chat; after a restore it moves to the
  previous point's turn. The "✓ restore point made" log line is gone, and nothing calls it Undo.
- **What Claude did, one line per action under each turn** (UX ruling R13), replacing the activity log: "✓ typed
  "DIR"", "– didn't type "DIR": you said no", "– typed "DIR", but the machine didn't read the keys", "✗ couldn't
  …", partial pokes and loads, " · undone at 00:02" after a restore; a turn of more than 3 actions folds its ✓ lines
  into one button with the reads counted; a turn that only read says so on a plain line ("read the screen 2×,
  memory 1×") and a read that failed is a ✗ line. A reset of the machine under Claude's typing is reported as
  `machine-restarted` ("– typed "1", then the machine restarted"), not as a Stop. Never printed on
  the full-screen chat's own screen
  (`js/claude/actions.js`, `js/ui/claude-lines.js`, `tests/claude-actions.test.js`).
- **A released CHANGELOG section can no longer be edited by accident.** `tests/changelog.test.js` compares each
  `### <version>` section with the same section in its release tag (`git show v<version>:CHANGELOG.md`), byte for
  byte, except for three named copy corrections kept in `tests/changelog-guard.js` with a reason each; new entries
  go under `## [Unreleased]`. It also fails if the newest tagged heading has no `## [Unreleased]` above it. CI's
  suites job now checks out with `fetch-depth: 0` so the tags are there; a checkout without them prints a SKIP
  line naming each missing tag and does not claim a comparison.
- **The browser check's `ask` group no longer fails now and then on "Ask Claude opens the side panel again".** The race
  was in the test: a machine switch fetches the welcome menu's program and starts it when the bytes arrive, and the
  test's `stubPrompt` (which ends the menu) could run first, so the menu started after it and the Ask button, which
  opens the full screen chat while the menu runs, did not open the side panel. The test now waits for the menu to
  start before ending it. The product behaves as designed (the menu starts, then the button follows it).
- **Tests for the welcome menu's offer on a 6309.** `tests/cpu6309-offer.test.js`: on every model with a 6309 option,
  switching to it offers the menu (`'menu', 'back'`), `offerMenu()` offers it after a link's `menu: false` switch, the
  file it fetches is `examples/welcome.bin` (the 6809 build, the same one the 6809 gets, and it exists), and an
  embedded session or a machine with ROMs is not offered it. The browser check's `cpu6309` group opens the literal
  `?machine=coco3&cpu=6309` link: the menu is on screen, no error toast, no 404, no page error, and the Debugger
  shows E, F, W, Q, V and MD. Each check turns red when the lookups go back to the CPU name instead of its family
  (the old "Welcome: examples/undefined: HTTP 404"), or when the link's `cpu` is dropped.

#### Fixed

- **Claude no longer forgets what it did, and no longer claims more than the machine shows.** Claude in the Ask
  panel said it had typed DIR and PROCS, and later that it could find no record of doing so. The chat kept only
  each reply's text, so the next request held Claude's claims without the tool calls and results behind them; a
  turn that failed after its tools ran (Stop, a network error, a stall) was dropped whole although the machine had
  changed. A turn is now recorded whole (the line, every `tool_use` with its `tool_result` as sent, the reply); a
  failed turn keeps the rounds that completed, with a note from the page saying how it ended; the oldest turns are
  dropped whole, never half a tool pair. What the views show is unchanged. `press_break` and `run "RUN"` now go
  through the paced typist and say whether the machine read the keys (`press_break` answered `{pressed:true}` at
  once, and `run` `{started:true}` with RUN only queued); every keyboard tool's description says that *consumed*
  means the keyboard was scanned with the key down, not that the program acted on it. The brief tells Claude to
  check a change with `screen_text`, `peek` or `machine_info` before saying it happened, and to call it unverified
  when it can't; it no longer assumes BASIC (a machine with NitrOS-9 running, or without ROMs, is described as it
  is) and gives the machine's own screen size rather than the chat firmware's, which only the full-screen chat is
  told (`js/claude/chat.js`, `js/claude/backend.js`, `js/claude/history.js`, `js/claude/brief.js`,
  `js/machines/typist.js`, `tests/claude-history.test.js`).
- **Disk names that differ only in case on a folder that does not tell them apart.** In a library kept in a folder on
  macOS or Windows, `GAME.DSK` and `game.dsk` are one file, so putting both in drives (or importing one over the
  other) had two drives writing one file. Every Library and drive guard — mount, import, rename, delete, new blank
  disk and its first-free name, and the drives card's "Disks in your library" list — now compares names the way the
  store does, and the shown name stays the one the disk was stored with. The store's rule is measured, not assumed,
  from a listing and one stat: nothing is written to the user's folder. (It differs by file system, not by backend:
  for example, Chromium's Origin Private File System tells `GAME.DSK` from `game.dsk`, while a folder on a default
  (case-insensitive) APFS or NTFS volume does not.) A store with no name to ask about yet is treated as
  case-insensitive until it has one. A case-only rename (`GAME.DSK` to `game.dsk`) is refused where it would replace
  the file and then delete it. A store that does tell cases apart keeps behaving exactly as before.
- **DriveWire: one image in two drives.** The same disk image could be mounted on two DriveWire drives, or put
  there while a drive already had it; both drives read and write the stored image in place, a sector at a time, so
  they overwrote each other's sectors. Mounting an image a DriveWire drive already holds is now refused, naming
  that drive, and the drives panel no longer offers it for another drive. Mounting it again in the drive that
  already has it still works, as changing its write-protect box does. A DriveWire image and a floppy cannot be the
  same stored file, so nothing changes between the two kinds.

### 0.1.4-pre

#### Added

- **Claude reads the CoCo 3's GIME text screens.** `screen_text` now reads every GIME text mode on the CoCo 3
  (6809 or 6309): 32, 40, 64 and 80 columns, with or without attribute bytes - NitrOS-9's 80-column screen and
  BASIC's `WIDTH 40`/`WIDTH 80` included - where it used to answer that it only handled the 32-column VDG screen.
  The GIME itself walks the screen from the emulator's own state (video start, row pitch, horizontal offset, lines
  per row and the rows shown), never the registers a program can't read back. Attribute bytes come back as runs
  of colour, underline and blink, never as characters; the GIME's international characters as the letters they
  show (`Ç ü é …`). A GIME bitmap, or rows too short to show a character, is still declined with a reason. Checked
  against MAME 0.264 on `coco3` and `coco3h` with new firmware (`run.js coco3 --video --text`): 14 screens, every
  pixel outside the glyph shapes of our own font identical, and MAME's glyphs where the expected text says.
- **The Ctrl/⌘K command box is discoverable.** With nothing typed it lists every command, grouped (Claude, Files, Views,
  Settings, Machine), with no row chosen until the first ↓ (so Enter on the empty box does nothing); the list scrolls
  inside the window and keeps the chosen row in view. A **Commands…** link in the app bar (behind Menu on a phone,
  and in the touch keys' Menu) opens it on every screen size, the Ask panel's empty state mentions the key on
  desktop, and Help has a **Commands and shortcuts** section and a **What Claude can do** section. When the
  one-row app bar (1200 px and up) would not fit in a wide fallback font, the key hints and the RAM size give way
  before anything wraps (the machine button's title and accessible name still say the RAM size).

#### Fixed

- **Time between instructions: an outside I/O access no longer runs the machine ahead.** `ioTime()` answers "the
  tick at which the current instruction touches the bus", but between instructions it returned the end of the
  *last* step, because the CPU keeps its cycle count after a step. A tool that looked at the machine between
  steps — a debugger's write, a stub hook — therefore fired scheduler events up to a whole instruction early
  (a 6309 `TFM` is tens of thousands of cycles, ~3.3 frames on the CoCo 3), and a machine restored from a
  snapshot answered differently from the original for the same access. The same fault in the CoCo 3's
  `accessStart()`, reachable between steps through the MAME-compat interrupt sync. Between instructions both now
  answer `now()`, which also moves the exact-time clock (`clockUnits()`/`tickAt()`) back to the machine's own
  time for every family. A CoCo 3 instruction suspended by the disk controller's HALT is the one between-step
  state that keeps the held access's time while its events run, and takes `now()` again once parked. Inside an
  instruction nothing changed (`tests/iotime.test.js`). One regression hash moved — the CoCo 3's SSC trace, from
  24,298 to 24,301 instructions — because its card is caught up between steps: on all three models the catch-up
  was early, but only the CoCo 3's step lengths are multiplied by `div`, so only there did the early answer
  cross a card instruction (counted on the card, the CoCo 1/2 and 2B run it 3,932 steps either way and the
  CoCo 3 56,541 before, 56,545 after). Its device-write rows and work RAM are identical.
- **Symbols typed on the keyboard are the ones you typed.** In translated mode (the default) the host's Shift went
  through to the machine, so a character the host types with Shift but the machine has unshifted came out
  SHIFTed: `:` typed `*` on every machine, `@` typed SHIFT+@ (a pause in Color BASIC) and `^` SHIFT+UP; on a
  layout that shifts other characters (the digits on AZERTY, for one) many more were wrong. The character now
  decides the machine's SHIFT, whatever the host's Shift is doing; letters and the named keys (BREAK, CLEAR, the
  arrows) still take the host's Shift. Typing fast also lost SHIFT: when the keys queued up behind the host,
  letting go of Shift could reach the machine before the shifted keys typed with it (`!"#` typed `!23`).
  Positional mode keeps the host's Shift as the key at its position, so the MC-10's and Alice's left Shift is
  CONTROL there, as the positional map always said.
- **The Mac's CLEAR is documented.** The Keys help and `docs/using.md` now say that on a Mac keyboard without
  `Home` or forward `Delete`, CLEAR is `Fn`+`←` or `Fn`+`Delete`, and that `Option` and `Cmd` stay with the Mac.
- **The docs, the page and two messages sent NitrOS-9 users to the wrong place.** The project's GitHub releases page
  has only "Source code" archives, no disk images. Everything that said to get a NitrOS-9 release there
  (`docs/using.md`, the NitrOS-9 slot's note under the screen, the "no image" messages) now names the v3.3.0
  SourceForge page, the two archives (`nos96809l2v030300coco3.zip`, `nos96309l2v030300coco3.zip`) and the file inside
  each to use (`..._becker.dsk` for DriveWire, `..._40d_1.dsk` for the floppy drive). The pins in
  `tools/nitros9/fetch.js` are unchanged (checked: both archives download from that page and the images match their SHA-256).
- NitrOS-9 card: the image list no longer sticks out past the card (it is capped to the card's width, and its title
  shows the whole name). A long file name in a Drives tile now stays on one line with the ellipsis in the middle, so
  the ending (`coco3_40d_1.dsk`) stays visible, and the full name is the tile's title. The browser check measures
  both at 1280, 1440, 1920 and 390 px wide.
- **Dragon 200-E: positional keyboard mode typed nothing.** `positionalKeys` had no layout for the 200-E's keyboard,
  so every physical key was dropped. The layout is the Dragon's with one binding changed, as in MAME 0.264's
  `dragon200e` ports (read from a running MAME): the physical `;` key is the 200-E's N-tilde. `tests/input.test.js`
  checks all 55 physical keys against MAME's rows and bits, and the browser check types in positional mode on a
  200-E.

### 0.1.3-pre

#### Fixed

- **CoCo 3: a memory write from outside the CPU left the CPU at the old clock.** The Debugger's memory write
  (which goes through the bus) to `$FFD8`/`$FFD9` set the GIME's fast bit but not the machine's clock divider,
  which only a following instruction could update: the GIME was at 1.79 MHz while the CPU still spent 4 clocks per
  cycle (about 14,934 instead of 29,867 cycles per frame). Writing the rate the GIME already held never corrected
  it (`js/chips/gime.js` reports no change then) and only a later write that changed the bits did. An outside write
  now takes the new divider at once; a program's own write keeps the instruction-timed path unchanged
  (`js/machines/coco3.js`, `tests/coco3.test.js`). A snapshot taken while the bug was live (a quick slot, a saved
  file) holds the GIME fast with the divider at 4; restoring it now derives the divider from the GIME, so the
  machine runs at the rate it reports instead of staying slow for good. An outside rate write while the disk
  controller's HALT holds an instruction drops that instruction (as any outside change does: its halted time counts
  at the old rate) so the CPU runs on at the new one; a snapshot of an instruction held after its own speed change
  keeps its saved divider.
- **Ask Claude no longer goes silent during a turn.** While Claude thought or wrote a long tool call (a `load_basic`
  program streams no text), the side panel showed nothing and had no Stop until Claude acted on the machine. Every
  view (the side panel, the phone sheet, the full-screen chat, and the page views: Share, the Library, Add ROMs and
  the Debugger) now shows the turn's status with **Stop**:
  *Thinking…*, *Using <tool>…* or *Waiting for your OK*, with the card scrolled into view. Stop at a card or while
  a tool runs ends the turn without another request. A stream that sends nothing for 60 seconds ends the turn
  with "Claude stopped answering", and an error event in the stream reads as the error it stands for (an
  overloaded API says so).
  Stop now also ends a turn while `assemble_and_load` waits for an `INCLUDE` file that never arrives (the read is
  aborted, and on its own gives up after 15 seconds with the new tool error `include-unreadable`). A pause made by
  pressing a key on the machine ends with its turn, so the next turn no longer starts paused with no Resume; the
  full-screen chat now has **Resume** beside Stop while paused (on a phone held sideways too, above its keyboard),
  the side panel's status line has Resume too (where the open panel covers the screen), the pill on the screen
  fits a phone's screen (its buttons were cut off), a later turn that only answers in text is no longer paused by a
  key, and a key pressed while a card waits for your answer pauses Claude without hiding the card (see "Allow and
  resume"). While Claude is
  paused, **Esc stops Claude** in every view (the side panel at any width, the phone sheet, minimised, the
  full-screen chat in its chat and BASIC views, a phone held sideways with its keyboard); it is Stop only, not
  also BREAK to BASIC, and a confirmation, menu or card open during the pause takes the first Esc. The pause's
  status says so ("Paused: you pressed a key · Claude's next action waits · Esc stops Claude"); before, Esc there was BREAK, Claude stayed
  paused and a later Resume typed everything it held. The browser's Fullscreen hid every Stop and Resume: the
  fullscreen screen now shows Claude's status with Stop (and Resume while paused), leaving Fullscreen while paused
  (Esc there) stops Claude, and a card waiting for your answer ends Fullscreen. A Reset or a power cycle while
  Claude acts on that machine or is paused stops Claude ("[stopped: you reset the machine]"), and so does any other
  restart of it (a program or cartridge that starts, the welcome menu, LIZA, ROMs cleared) and any program you
  load or run on it; a snapshot load or a
  machine switch closes the conversation; a later Resume never types held keys or runs a stopped action. The page
  views hid every Stop (Claude's own "3" at the welcome menu opens Add ROMs): they now show Claude's status at the
  bottom of the window with Stop, Resume while paused and Answer while a card waits, and a card raised while a view
  is open closes the view so the card shows. Wherever no other Stop can be reached (a phone held sideways with its
  touch keyboard and the panel closed or minimised), the same status with Stop shows over the screen. Every way you send input to
  the machine Claude is using now pauses Claude as a key on the screen does: a key with the focus on the page,
  Shift (and Ctrl or Alt on a CoCo 3), an on-screen key, a paste, the type-in panel, a tap on the welcome menu
  and a POKE from the book (before, those went in unpaused and counted as
  Claude's, so your "1" at the welcome menu started LIZA as if Claude had chosen it). A "[stopped]" note no longer
  stays in the side panel after a turn the full-screen chat starts. With a drawer tab open from the Ask panel's
  rail, Esc closes the tab first (as a menu) and is no longer also BREAK; a page view closes the tab. A card waiting
  for your answer makes the touch keyboard step aside in every layout. A reply
  with no text is no longer kept as an empty message, which made the API refuse every later request of the chat: a
  turn of tool calls only is kept as a note of the tools used (for the model, not shown), a refused question is dropped (and shown with
  "Claude declined to answer this one."), and requests are always sent as a conversation the API accepts (one that cannot be made valid fails the turn with
  an error instead of being sent; a blank line starts no turn).
- Claude no longer asks in prose before loading a long program and then has the page ask again: the policy now
  tells it to call `load_basic`, whose card is the question.
- **The app bar stays one row from 1200 px wide up, in any system font.** On a machine whose fallback font is wider
  than the developer's (CI's: Library, Debugger, Help and GitHub wrapped onto a second row, 116 px against 68 at
  1280 x 720) the status text now gives way with an ellipsis before anything wraps; below 1200 px the bar wraps as
  before. The browser check measures it with `getBoundingClientRect` at 1280 x 720, in the page's font and in a wide one. The status text's `title` holds the whole text, so what the bar clips
  can be read on hover.

#### Changed

- **"Allow and resume".** While Claude is paused by your key, a card waiting for your answer says so, and its
  accept button reads **Allow and resume** (**Load and resume** on the load card): one click gives consent and lets
  Claude go on. The decline button never resumes. The status shows the pause (with Resume) rather than *Waiting for
  your OK*. Turning "Let Claude use the emulator" off while Claude is paused now withdraws consent for what the pause
  holds: on Resume the waiting action is refused, even one you had allowed on its card (before, it still ran), and
  typing held back is dropped instead of typed. Turning the switch on while paused does not resume.
  Esc while paused with a card up stops Claude. A card that ends the browser's Fullscreen is no longer taken for your
  Esc (which stops Claude) when a key paused Claude just before the browser reported it.
- **More of your input pauses Claude.** An edit in the Debugger (a byte, a register, a flag), the embed API's `poke`,
  `loadBasic`, `load` and `insertTape`, and a gamepad, the mouse as joystick or the on-screen touch stick and its
  FIRE (a fire press, or a push out of the dead zone; not a stick resting with noise or jittering at the dead zone's
  edge) now pause Claude acting on that machine, as a key does. On a phone, a card taller than the room the sheet
  leaves it now scrolls so its buttons show (with the key and privacy lines below the message box, Allow was hidden
  under the status line). Paused at a card you then decline, Claude is no longer shown as acting while it only writes
  its reply; every paused state says "Paused: you pressed a key · Claude's next action waits · Esc stops Claude".
- **The Ask panel's pause and the acting tools' gate are one mechanism.** The pause made by your input
  (`Session.personInput`) is the one the acting tools' gate and pre-act re-check wait on, and it ends with its turn
  (`endClaudePause`), refusing the waiting call. Your input pauses an acting call from its gate onwards (a card
  waiting, its `INCLUDE` read), even before Claude's first change of the turn; nothing is written and no restore point
  is taken while paused. `include-unreadable` is in `assemble_and_load`'s description and in the codes table of
  `docs/claude.md`. New `tests/claude-ask-acting.test.js`, and the browser check's `askEsc` group covers Stop on the
  page views' pill while a call waits at its gate.
- Test follow-ups: `tests/restore-points.test.js` proves the chat's "Restore to before Claude's changes" keeps the
  point when the restore throws; `tests/allsummary.test.js` proves `tests/all.js` fails a run whose regression gate
  is missing or ran fewer cases than `--count`; `tests/claude-acting-contract.test.js` proves every acting tool's
  description names "Let Claude use the emulator".

### 0.1.2-pre

#### Added

- **A touch joystick in the on-screen panel.** A **Keys | Joystick** switch (on machines with a joystick port, so
  not the MC-10 or Alice, and not with a Hi-Res interface or The Rat in that port) turns the phone or tablet panel
  into an analogue stick on the right joystick — the one the first gamepad drives — with the pads' own dead zone,
  a floating base and about 56 px of travel, plus a large FIRE on the same button bit a stick's fire button uses,
  a key strip (SPACE, ENTER, BREAK, 1, 2, Y, N, ABC) and one-press ABC for the full keyboard. The stick and FIRE can
  be held at once; a gamepad connecting stands the stick down; the mode is remembered per machine and
  `?touch=joystick|keys` sets it for the visit. Keys mode is unchanged, with Hide keys moved into the panel's Menu.
- **NitrOS-9 from a floppy:** the release's `_40d_1.dsk` (35/40-track NitrOS-9 floppies) boots the same way with
  CLOADM's own floppy loader and the CoCo disk controller, no Disk BASIC ROM needed.
- **The Speech/Sound Pak on the Dragon 64.** The cartridge port's board menu now offers the Pak on the Dragon 64
  as it does on the CoCo 1/2, CoCo 2B and CoCo 3, music only (speech is still not implemented). The Dragon 64's
  run of this project's diagnostic firmware matches MAME 0.264 instruction for instruction to HALT, which is what
  offering it rests on; the other Dragon-family models (Dragon 32, Dragon 200, Dragon 200-E, Tano Dragon 64, Dragon Professional (Alpha)
  and Dragon 64 Plus) have not been run, so they do not offer it.

#### Fixed

- **The Debugger works on an HD6309.** On a machine with the CPU option set to 6309 the Debugger screen threw
  `ORDER[cpu] is not iterable`: its register order and flag tables had no 6309 entry. It now shows the full 6309
  register set (PC A B E F D W Q V MD X Y U S DP, with the condition codes as on the 6809) in the order the core
  has them, and the fields edit the core as the 6809's do; Q, the 32-bit accumulator, is shown and edited as eight
  hex digits. The tables live in `js/debugger.js` (`REGISTER_ORDER`, `REGISTER_DIGITS`, `FLAGS`) and the panel
  reads them, so a CPU is added, and a register's width set, in one place. A register field still takes a label
  (a program's `START`) as it does on the 6809. A direct operand is now disassembled against the CPU's real DP on a
  6309, where it used DP 0 (`js/debugger.js`). `Session.codeAt` (Ask's "What is this code doing?") had the same two
  faults on a 6309 - it read 6309-only opcodes with the 6809's table (LDQ shown as data) and left E F W Q V MD out
  of the registers it sent; both come from one helper now (`codeDisassembly`, also used by the Claude
  `disassemble` tool), so the debugger, the trace and Ask cannot disagree.
- **CoCo 3 disk controller HALT:** a sector read with the CPU halted could read the data register before its byte
  (NitrOS-9's floppy booter read LSN 0 one byte off, and every byte twice at 1.78 MHz). HALT now suspends the CPU
  inside an instruction as MAME's does, and the cartridge slot's line delays follow the CPU rate. A halted read whose
  DRQ never comes (an empty drive) holds the CPU across frames instead of the page: the screen and timers run on, and
  a disk in the drive or a Force Interrupt releases it. Changing the CPU's registers while it is held (a program
  loaded and started, a jump, the debugger) drops the held instruction, as does writing over its code: the CPU
  goes on from the new state when HALT is released. A held instruction runs again with exactly the bytes it had
  read (a 6309 TFM whose source overlaps its destination copied its own new bytes), however long it is. The debugger counts no instruction while the CPU is halted: Step waits a frame and reports
  "Halted", Over/Out/Run-to wait two seconds, and Run keeps the frames going without stopping.
- **Ask Claude's restore points:** a restore that can't happen (the ROMs changed since the point was taken: Forget
  ROMs, Run without ROMs) no longer throws the points away and stops Claude first: it says why, changes nothing and
  keeps every point. After a restore, a disk still in the same drive since the point (the same mount, not ejected
  or changed in the Library) goes on saving its writes to the Library (before, later writes were silently not
  saved), and if the machine wrote to it since the point its stored image is first put back to the image the drive
  holds, so the undone turn's writes are not left mixed in; a disk not written since is not rewritten. Any other
  disk (ejected, replaced, mounted again or moved since the point, write-protected, or a file that can't be written)
  is not rolled back: the Library's file is left alone and the restore says the restored disk isn't saved. In the
  full-screen chat the Library now also refuses to replace, rename or delete a disk in the BASIC session's drives, and
  the BASIC session's drives are saved when the page is hidden. A disk mounted again in the drive it is in is read
  only once no write to the Library is in flight (a restore's put-back, an import, another drive's write), so a
  drive and its file no longer end up as two versions, and two mounts of one image at once can't both go in.
  Moving the library waits for the disks' last writes, and while it moves no disk goes in and the Library
  changes nothing (an import, rename or delete then would have been lost from the moved library).
  Every acting tool, `load_basic` included, takes the turn's restore point through
  one shared path, so a new tool can't miss it. The restore control now says that points live in memory only (a
  reload, ending the chat or switching machine loses them) and that other saved files are not rolled back.
- **The HD6309 now runs the 6809 programs.** Choosing the 6309 (Machine tab, or `?machine=dragon64&cpu=6309`)
  opened on "Welcome: examples/undefined: HTTP 404": the Session's welcome-menu, LIZA, colour-demo and Claude-chat
  lookups were keyed by the literal CPU and had no 6309 entry, so the page fetched a missing file, the screen kept
  the bare stub, the Media tab lost the colour demo, and the choice stuck for later visits. The lookups now go by
  CPU family (`js/cpu/cpus.js`), and the 6309 — which runs every 6809 instruction in emulation mode — gets the 6809
  welcome build, LIZA and demo, and the 6809 chat firmware. The stored 6309 choice is unchanged.
- Opening the full-screen chat from a view no longer forgets that the Ask panel reopens when the view closes if the
  chat fails to open (for example, its firmware does not load).
- The browser's Back from a view leaves the focus on the screen, as "← Emulator" and Esc do (it landed on the page or on
  the opener's button), also when the Ask panel reopens over the conversation.
- After a reload while a view was open over the chat, Back no longer leaves `?app=claude` in the emulator's address: a
  page loaded on `?app=claude` now keeps the emulator's own entry, without the parameter, under the chat.
- "What is this code doing?" asked from the full screen chat (Ctrl+K) disassembled the chat firmware and its
  registers; it now reads the BASIC session, as the read tools do (`Session.codeAt`).

#### Changed

- **Claude's acting tools follow the read tools' contract.** `poke`, `type_text`, `load_basic`, `press_break`,
  `assemble_and_load` and `run` are entries of one table in `js/claude/chat.js`, and `ChatSession.runTool` runs each
  the same way: the consent gate (`ChatSession.gate`, which the Session now sets instead of wrapping the backend),
  the tool's read-only checks, a Stop check, then the change inside the turn's restore point
  (`ChatSession.withRestorePoint`); the offered schemas and the gated names both come from that table. Anything
  uncoded inside a tool is the new code `tool-failed`, never a raw exception (`asToolError`, applied in `runTool` and
  in the backend). Stop while the consent card is up is `stopped` (it was `consent-declined`). Every schema states
  its ranges and defaults from the constants the code applies (`POKE_MIN`, `BYTE_MIN`/`BYTE_MAX`,
  `ASSEMBLE_DEFAULT_ORG`, `RUN_DEFAULT_TARGET` are new) and every description names the codes the tool returns and
  its whole result. The brief states the contract (`TOOL_CONTRACT`), and `docs/claude.md` lists every code with its
  remedy. New `tests/claude-acting-contract.test.js`: every acting tool against every outcome through the backend
  with a mocked API, the schemas against the constants, and the gate and restore point for every tool. Just before
  the change a synchronous re-check (`ChatSession.recheck`, set by the Session) catches what happened while a card
  waited or a check ran (an INCLUDE read): Claude paused waits for Resume (Stop or Esc: `stopped`), and a call that
  relied on the "Let Claude use the emulator" switch is `no-consent` once it is off; nothing lands while paused. A
  `ChatSession` built without a gate now refuses every acting tool (`no-consent`) instead of allowing it. `run.target`'s
  schema is `anyOf` an integer `ADDRESS_MIN`-`ADDRESS_MAX` or a string.
- **Sound plays through an AudioWorkletNode** (`js/host/audio-worklet.js`) instead of the deprecated
  ScriptProcessorNode, so the console no longer warns on every page load and sound is played on the audio thread,
  away from the page's work. The samples are unchanged (the emulation core is untouched): the output stage makes
  them on the page as before and sends each frame through the worklet's MessagePort as a transferred chunk (no
  SharedArrayBuffer, which GitHub Pages can't enable). The worklet's queue is bounded (300 ms, the oldest dropped on
  overrun) and runs dry into silence, faded over 5 ms, never repeating old samples. The latency targets are
  unchanged (10 to 80 ms queued, frames dropped past 150 ms); measured from a frame's samples being made to their
  being rendered (Chromium, headless, five runs each) the median latency went from 80 to 144 ms to 33 to 67 ms.
  Where AudioWorklet is missing (an old browser, plain `http://` other than `localhost`), its module can't load (or
  hasn't loaded within 3 s) or its processor fails, a ScriptProcessorNode plays the same queue, so sound keeps working; with AudioWorklet working none is created.
  The worklet is in the service worker's list, so offline sound works too.
- **Test gates (tooling): a green run means what it says.** `node tools/browser-check.js`: an unknown or empty
  `--only` group list is an error (exit 2) listing the valid groups, where it used to run nothing and pass; each group
  runs on its own, so one that throws is that group's FAIL with its stack and the rest still run; every wait's
  timeout is a FAIL where it was called unless the wait is marked optional with its reason, and a page that crashed,
  closed or navigated away is a FAIL in every wait, optional or not (a negative check passes only on a live page); fixed sleeps are replaced
  by condition waits wherever a condition exists (the windows that remain are listed in `docs/development.md`); the
  NitrOS-9 release-image checks are a counted `SKIP` when the images are not cached (never fetched in CI); and the
  run ends with groups run / passed / failed and the ok / FAIL / SKIP counts (`tools/browser-check-lib.js`,
  `tests/browser-check-lib.test.js`). `node tests/all.js` prints `regress 146/146 included` and fails if its regression
  shards did not cover every case (`node tests/regress.test.js --count`).
- CI runs the gates on every push to `main`, `claude/**` and `ds/**`: `node tests/all.js` and the browser check in
  4 parallel shards, then a `gates` job that fails unless all passed and reports the commit, its tree hash, the run attempt (flagging a re-run) and the
  counts. A check fails the run if any browser-check group (as `node tools/browser-check.js --list-groups` prints its
  `GROUPS` table) is in no shard, in two, or a shard names a group that isn't one. A newer push to a branch
  cancels the older run there; runs on `main` are never cancelled.
- CI installs Playwright more robustly: the chromium download is cached on the Playwright version and runner image, and the OS packages install with up to 3 tries with `apt-get update` between (a flaky apt mirror no longer fails a browser-check shard before any test runs).
- AGENTS.md: a green CI run on the exact commit is the definition of done; `regress.test.js` needn't run separately
  where `all.js` ran; nothing else runs beside the browser check; a review section (verify the run's SHA and tree,
  replay mutations, re-run gates only for non-additive changes to tests, tools or CI); the report gives the CI run.
- **Snapshots are format version 2:** a CoCo 3 instruction held by the disk controller's HALT is saved with the
  machine. Version 1 files still open; a page from before this change refuses version 2 files as newer.
- **Esc in the full-screen chat escalates.** On the chat screen Esc is BREAK while a reply streams (it stops the reply)
  or while a line is typed (the firmware drops it); on an empty, idle prompt it leaves the chat, exactly as
  "← Emulator" does. The focus pill there reads "Esc stops a reply, clears the line, then leaves the chat".
- **The hints under the screen are one line of fixed height**, one note at a time: "No ROMs needed · click anywhere
  for sound" until sound starts, then the key hint until it is done, then an empty line that keeps its height. The
  monitor leaves a little more room (100vh − 260px), so on a first visit the Reset row is inside a 1280 × 720 window
  and nothing under the screen moves. The key hint now reads "Esc = BREAK · Home = CLEAR · Backspace = ←" (it no longer
  says "keys type what they say", which is wrong in positional mode) and always fits: one line when the column is at least
  360 px wide, otherwise a fixed two-line box.
- **Link errors say what to do:** `app=bogus isn't something CLOADM has (try app=claude)` (likewise `start=`), the
  unknown-`machine=` error lists the machine picker's names rather than ids, and a `load=`, `tape=` or `cart=` the
  other site won't let CLOADM fetch says "Couldn't download it: the site may not allow other sites to load its files."
  instead of "Failed to fetch".
- In the BASIC-session view (Ctrl+B from the chat) the corner label reads "The chat · live", so it is no longer a
  second "Back to the chat" beside the button.
- **Ask Claude says what it reads, and that it is only the emulator.** The panel's header is "Claude can read
  (emulator only):" with the chips "Screen text" and "Memory"; the placeholder and the phone peek say "Ask about this
  machine"; the empty state says "Claude reads only this emulated <model> (its screen text and memory), never your
  computer" and follows a machine switch, on phones too; a new footer line says "Your messages and what Claude
  reads go to Anthropic with your key." The full screen card names the BASIC session's model. The switch is "Let
  Claude use the emulator" everywhere (page, docs, README).
- The test gate (`tests/all.js`) fails a suite that exits 0 without printing its summary, so a suite that stops
  part-way on a promise that never settles can no longer count as a pass (found by this: `tests/allsignal.test.js`
  had been exiting silently), and `tests/machine.test.js` now ends with the summary line every suite prints.

### 0.1.1-pre

#### Added

- **`load_basic`**, a new acting tool for Claude: a BASIC program is tokenized for the machine's BASIC (Dragon,
  CoCo Color/Extended/Disk/Super Extended, MC-10) and put straight into program memory, as a load from tape or disk
  would, with coded errors. Claude types programs of 3 lines or fewer and offers `load_basic` for longer ones,
  and checks the result (LIST and the screen) before saying it worked. Loading asks on every call with its own card
  ("Don't ask again this session" stops it for the visit). The same load is `Session.loadBasic(program)` and the
  embed API's `loadBasic`, for automation, with no card.
  "Don't ask again this session" is offered only while "Let Claude use the emulator" is on: with the switch off
  every load asks, and Stop while the card is up ends the call as `stopped` rather than `load-declined`.

- **Booting NitrOS-9 from the page:** on the CoCo 3 (6809 or HD6309), NitrOS-9 Level 2 boots from the user's own
  DriveWire image (the release's `_becker.dsk`) with no ROM: CLOADM's own loader (`js/machines/nitros9.js`) takes
  the internal ROM's place and boots drive 0 over the Becker port. The NitrOS-9 slot under the screen, a dropped
  image's offer, `?nitros9=` links (never carrying the image), and clear refusals for images that can't boot
  this way (`js/media/os9.js`). The loader moved from `tools/nitros9/bootdw3.asm` to the page.

#### Fixed

- "← Emulator" (and Esc, and the browser's Back) now always return to the emulator. Opened from
  `/play/?app=claude`, the Debugger, Library and Share went back to the full-screen chat instead, and after a reload
  on a view, Back and the chat's "← Emulator" could land on the Debugger again. The views and the full-screen chat
  now share one history model (`page.openStep` / `page.toEmulator` in js/ui/page.js): at most one is above the
  emulator, in one history entry marked with the page load that added it, and the views follow `popstate` as well
  as `hashchange`. A view opened from the full-screen chat moves the conversation to the side panel, and coming back to the
  emulator (by "← Emulator", Esc or Back) reopens the Ask panel on that conversation, so a waiting question or a reply
  in progress is not left unseen.

- **Claude's `type_text` dropped keys** while BASIC was busy (storing a line, scrolling) and still reported
  success. Typing is now paced by what the machine consumes: each key is held until the CPU has read its keyboard
  column, released until it has seen the key go, and after Enter nothing more is pressed until the machine reads
  the keyboard again. The result says what the machine took (`requested`, `consumed`, `lines_requested`,
  `lines_delivered`); a machine that stops reading the keyboard ends the call with `not-consumed` and how far it
  got, and a character the keyboard has no key for is `not-typable`.

#### Changed

- AGENTS.md: an item's scope comes from its brief or issue; contributors don't edit a roadmap.

### 0.1.0 (first public release, not tagged yet)

Everything on `main` so far. Hardware behaviour is checked against MAME 0.264 in instruction lockstep (and pixel
by pixel for video) with firmware written for this project; docs/verification.md lists each
comparison and every known difference. No ROMs are included: users supply their own.

#### Added

- **Machines:** Dragon 32, Dragon 64, Dragon 200-E (its character generator, rewired VDG and Spanish keyboard),
  Dragon Professional (Alpha: boot ROM bank, AY-3-8912, built-in WD2797 with two drives, modem registers),
  Tandy Color Computer 1/2 (4K, 16K, 32K or 64K RAM), Color Computer 3 with the GIME (NTSC verified; PAL as our
  own 312-line model), MC-10 (4K/20K), Matra Alice and Prológica CP-400. A built-in stub firmware runs programs
  without any ROMs; the MC6845 CRTC chip is in place for later models.
- **Video:** scanline-accurate VDG, T1 and GIME drawing, including mid-frame mode and palette changes; composite
  NTSC/PAL artifact colours with a phase switch (CoCo 3 compatibility modes included); CRT shader, scaling,
  integer scaling and aspect options.
- **CPU timing:** the SAM CPU rates (the "speed POKEs") timed per bus cycle from the MC6883 data sheet, with the
  Machine and POKEs tabs.
- **Storage:** a media layer on browser-private storage (OPFS) and local files (File System Access API), with an
  import/download fallback; ROMs, recent programs, disks and snapshots live on it. The Library page with shelves,
  filters, the type-in card and the magazine rack.
- **Floppy disks:** WD2797, WD2791 and WD1773; DragonDOS, Premier/Delta and RS-DOS controller cartridges; VDK, DSK,
  JVC and DMK images, read and write, up to four drives, write-protect and download; the drives card under the
  screen. Disk images written by MAME and by CLOADM from the same firmware are byte-identical.
- **Cartridges (CoCo 1/2):** bank-switched ROM cartridges, Games Master Cartridge (SN76489), Orchestra-90 and the
  Multi-Pak, with sound compared against MAME's recorded audio; the cartridge port menu.
- **Cassette:** CSAVE/CSAVEM capture to downloadable `.CAS`, WAV loading (noise, drift, inverted phase and DC
  offset tolerated) and WAV export, on the Dragons, CoCo 1/2/3, MC-10 and Alice; the tape screen.
- **Printer, serial and DriveWire:** printer output with download; the Dragon 64's 6551 ACIA and the bit-banger
  serial port to an in-page terminal, a loopback plug or Web Serial; an in-browser DriveWire 4 server on the
  Becker port with WebSocket channels, and serving a real CoCo over Web Serial (tested with a mocked port only).
- **Snapshots:** `.cloadm` files (versioned gzip JSON) for every model, capture and share, opening by drag and
  drop, and three quick-save slots.
- **Debugger core:** 6809/6803 disassembler; breakpoints, watchpoints, single step, step over, run to return or
  address, instruction trace and memory and register access through the Session.
- **Input:** translated and positional keyboard modes for every family, keyboard joystick, gamepads, the CoCo
  Max Hi-Res module and the CoCo 3 mouse.
- **Programs that need no ROMs:** the welcome program, the colour demo, and LIZA (after ELIZA), for the 6809 and,
  on the MC-10 and Alice, the 6803.
- **Claude chat terminal (core):** the Messages API backend with streaming and tools, the chat firmware with its
  own 42×24 upper and lower case font, a host-side key store that keeps the API key out of the machine, and the
  DriveWire chat channel. The page that exposes it is not there yet.
- **Site:** the landing page at `/`, the emulator at `/play`, the `/roms` page, Help and Credits, with a light
  variant for reading pages and a phone layout.
- **Development:** the MAME lockstep, video, raster, byte and audio comparison tools in `tools/mame-diff/`, the
  regression hash gate, the headless browser check, and a CI workflow running both on every push.
