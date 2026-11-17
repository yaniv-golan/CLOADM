# Changelog

All notable changes to CLOADM are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project intends to use
[Semantic Versioning](https://semver.org/spec/v2.0.0.html) once releases are tagged.

## [Unreleased]

### 0.1.1-pre

#### Added

- **`load_basic`**, a new acting tool for Claude: a BASIC program is tokenized for the machine's BASIC (Dragon,
  CoCo Color/Extended/Disk/Super Extended, MC-10) and put straight into program memory, as a load from tape or disk
  would, with coded errors. Claude types programs of 3 lines or fewer and offers `load_basic` for longer ones,
  and checks the result (LIST and the screen) before saying it worked. Loading asks on every call with its own card
  ("Don't ask again this session" stops it for the visit). The same load is `Session.loadBasic(program)` and the
  embed API's `loadBasic`, for automation, with no card.
  "Don't ask again this session" is offered only while "Let Claude use the machine" is on: with the switch off
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
