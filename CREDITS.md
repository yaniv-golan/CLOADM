# Credits

CLOADM stands on the shoulders of the people who documented, preserved and emulated these machines before it.
Their work is what CLOADM was checked against and learned from. One piece of it is included: the CoCo 3 composite
monitor's colour tables in `js/chips/gime.js`, from MAME's `src/mame/trs/gime.cpp`, Copyright (c) Nathan Woods,
used under the BSD 3-Clause licence, whose notice and conditions are in `licenses/MAME-gime-BSD-3-Clause.txt`.
Nothing else of theirs is included.
The site has the same thanks at [cloadm.dev/credits](https://cloadm.dev/credits/); keep the two in step.

## Emulators

- **[MAME](https://www.mamedev.org/)**: the reference for every hardware comparison in `tools/mame-diff/`, where
  CLOADM runs its own test firmware in lockstep with MAME, instruction by instruction and pixel by pixel.
  Thanks to Nathan Woods for MAME's Color Computer and Dragon drivers, Phill Harvey-Smith for the Dragon
  Professional (Alpha) driver, and the MAME team. MAME's `imgtool` made the disk images in
  `tests/fixtures/disks`.
- **[XRoar](https://www.6809.org.uk/xroar/)** by Ciaran Anscomb: its documentation and ROM lists are where the ROM
  file names and aliases CLOADM recognises come from, and it is the second opinion for the SAM's fast-rate timing
  and picture (`tools/mame-diff/sam/run-xroar.js`).
- **[VCC](https://github.com/VCCE/VCC)** (the Virtual Color Computer, a Color Computer 3 emulator) by
  Joseph Forgione, continued by the VCCE (VCC Community Edition) maintainers.
- **[DriveWire](https://github.com/boisy/DriveWire)** by Boisy Pitre and Aaron Wolfe: the protocol CLOADM's planned
  in-browser disk server will speak.
- **The PC-Dragon emulator** by Paul Burgin, cited in MAME 0.264's Dragon disk controller
  (`src/devices/bus/coco/dragon_fdc.cpp`) and VDK format (`src/lib/formats/vdk_dsk.cpp`) sources.

## A game served with it

- **WYRMFIRE** by the WYRMFIRE contributors, a 3D game engine for the Dragon 64
  ([github.com/yaniv-golan/wyrmfire](https://github.com/yaniv-golan/wyrmfire)), under the GNU GPL version 3 or later:
  its engine and level converter are served unchanged in `examples/wyrmfire/` (`COPYING-GPL-3.0.txt`, `SOURCE.txt`),
  pinned in `js/wyrmfire/pin.js`. Its level disk is converted from map E1M1 of
  [Freedoom](https://freedoom.github.io) 0.13.0, Copyright © 2001-2024 Contributors to the Freedoom project, under the
  BSD 3-Clause licence (`examples/wyrmfire/freedoom/COPYING.txt`, with its `CREDITS.txt` and `CREDITS-MUSIC.txt`).
  Freedoom is not affiliated with id Software. DOOM is a registered trademark of ZeniMax Media Inc. CLOADM and
  WYRMFIRE are independent projects, not affiliated with or endorsed by id Software, ZeniMax Media or Microsoft. References to DOOM describe file compatibility only.

## Archives

- **[The Color Computer Archive](https://colorcomputerarchive.com/)**: software, documentation and magazines for
  the Tandy machines.
- **[The Dragon Archive](https://archive.worldofdragon.org/)**: software and documentation for the Dragon 32,
  64 and 200, built on Ross Hamilton's original Dragon Software Archive.
- **The magazine archivists**: [os9projects.com](https://www.os9projects.com/DragonTop/DragonMag/DragonUser/DragonUser.html)
  (all 69 issues of *Dragon User*), the [Centre for Computing History](https://www.computinghistory.org.uk/) and
  [Retromags](https://www.retromags.com/), who keep The Rainbow, Hot CoCo, Dragon User, INPUT and the rest readable.

## Hardware documenters

- **Graham E. Kinns**, whose notes on the DragonDOS controller, disks and file formats MAME 0.264 cites
  (`src/devices/bus/coco/dragon_fdc.cpp`), the authors of the **"Unravelled" books** (the annotated Color BASIC
  ROM listings), which MAME's `src/mame/trs/coco.cpp` names as its main reference, and everyone who measured how
  the SAM, VDG and GIME really behave.

## Documents the code cites

- **Motorola MC6883 (SAM) data sheet** (Advance Information): the CPU rates, the fast address ranges and what the
  VDG shows at the fast rate, in `js/machines/sam.js` and `tools/mame-diff/sam/`.
- **Motorola MC6801/MC6803 data sheet**: the instruction timing table in `js/cpu/cpu6803.js`.
- **Hitachi HD6301 documentation**: the double-byte write and the undefined-opcode trap noted in
  `js/cpu/cpu6803.js`.
- **Darren Atkinson's notes on the CoCo's floating data bus**: the byte read from unmapped addresses, in
  `js/machines/coco3.js` (MAME implements the same rule).
- **Published MC-10 documentation**: the Micro Color BASIC `POLCAT` and `CHROUT` entry points used by the no-ROM
  stub (`js/machines/mc10.js`, `js/machines/stub.js`).
- **MAME's driver sources and behaviour**: memory maps, timing and ROM checksums throughout `js/machines/`
  and `js/chips/`, wherever a comment says "as in MAME".

## Fonts

Self-hosted from `fonts/`, each with its licence file, so the site never asks a font service for anything:

- **[Archivo](https://github.com/Omnibus-Type/Archivo)** by Omnibus-Type (The Archivo Project Authors), SIL Open
  Font License 1.1 (`fonts/archivo/OFL.txt`): interface and headings.
- **[JetBrains Mono](https://github.com/JetBrains/JetBrainsMono)** by JetBrains (The JetBrains Mono Project
  Authors), SIL Open Font License 1.1 (`fonts/jetbrains-mono/OFL.txt`): code, registers and hex.

The WOFF2 files are the unmodified Google Fonts builds packaged by [Fontsource](https://fontsource.org/).

## Development tools

- **[Readability](https://github.com/mozilla/readability)** by Mozilla (Copyright (c) 2010 Arc90 Inc), Apache
  License 2.0: an unmodified copy in `tools/vendor/readability/`, with its licence, used only by the browser check
  as a stand-in for a browser's reading mode. The site never loads it.

## Programs on the "runs without ROMs" shelf

Only programs written for CLOADM: the welcome program, LIZA and the colour demo. No third-party homebrew is bundled. A title would be
added only with its author's written permission, recorded here, and only if it runs on CLOADM's no-ROM stub.
Homebrew authors: see [CONTRIBUTING.md](CONTRIBUTING.md) for how to offer a program and the permission text.

## The welcome program and LIZA

`examples/welcome.asm` and its tune are new, written for CLOADM.

`examples/liza.asm` is a new program written for CLOADM, after Joseph Weizenbaum's ELIZA (1966).
