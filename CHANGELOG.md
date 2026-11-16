# Changelog

All notable changes to CLOADM are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project intends to use
[Semantic Versioning](https://semver.org/spec/v2.0.0.html) once releases are tagged.

## [Unreleased]

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
