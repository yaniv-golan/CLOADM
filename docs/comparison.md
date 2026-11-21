# How CLOADM compares with XRoar, MAME and VCC

*As of November 2026. This is a snapshot: check each project for its current state.*

CLOADM is a browser-first emulator that is also usable from CI and coding agents, and it tries to match MAME on the
hardware it covers. It is young. XRoar and MAME have much longer track records, VCC is the established CoCo 3
emulator on Windows, and XRoar also runs in the browser (XRoar Online). Choose CLOADM when you want automation, MCP
and agent tools, or sharing a machine state as a link. Choose XRoar or MAME when you want maturity or the widest
hardware catalogue.

| | CLOADM | XRoar | MAME (Dragon / CoCo drivers) | VCC / OVCC |
|---|---|---|---|---|
| Runs on | Browser, installable offline app; Node CLI and MCP server | Desktop (binary packages for Windows and Mac; Linux from source or an Apt repository); can also be compiled to WebAssembly, as XRoar Online [^x1] | Desktop [^m1] | VCC: Windows [^v1]. OVCC: a portable fork with Linux, Windows and Mac builds [^o1] |
| Machines | 17 models: Dragon 32/64/200/200-E, Tano Dragon 64, Dragon Professional (Alpha), Dragon 64 Plus, CoCo 1/2, 2B, 3 (NTSC and PAL), MC-10, Matra Alice and clones (MX-1600, LZ Color64, Codimex CD-6809, Prológica CP-400) [^c1] | Dragon 32/64/200-E, CoCo 1/2/3, MC-10, Alice 4K, the Dragon Professional and Deluxe CoCo prototypes [^x1] | Dragon 32/64/200/200-E/64 Plus/Tano, CoCo 1/2/2B/3 (with 6309 variants), several clones, MC-10 and the Alice family [^m2] | VCC: CoCo 3 only. OVCC: derived from VCC, same target [^v1] [^o1] |
| Accuracy approach | Instruction-by-instruction and pixel-by-pixel comparison with MAME, using firmware written for this project [^c2] | see the project | MAME is the reference CLOADM compares against | VCC aims at "an accurate and easy-to-use emulation" of a stock 128K CoCo 3 [^v1] |
| Media | Tape (CAS, WAV), floppy (VDK, JVC/DSK, DMK, OS-9 DSK), ROM cartridges, snapshots [^c3] | Tape, floppy and block device images, snapshots; exact format list: see the project [^x1] | see the project | Floppy (FD-502), virtual hard disks (VHD), SuperIDE, SDC simulator [^v1] |
| Debugger | Breakpoints, watchpoints, stepping, registers, memory, trace [^c3] | GDB target for remote debugging; traps [^x1] | MAME's general debugger, with breakpoints and watchpoints [^m3] | see the project |
| Automation / AI | CLI scripts, JSON output, MCP server, agent skill, Claude chat terminal [^c4] | Command-line options; see the project for the rest | see the project | see the project |
| ROMs | None bundled; your own, recognised by contents, kept private in your browser | Your own | Your own | Your own [^o1] |
| Licence | MIT | GPL v3 or later (from the README in its source tree) [^x2] | GPL-2.0+ overall, with BSD-3-Clause and other parts [^m4] | VCC: GPL-3.0 [^v1]. OVCC: GPL (see the project) [^o1] |

## Where the others are stronger

* **XRoar** has a long history, a broad hardware list (DOS cartridges, IDE, RAM expansions, the Orchestra 90 and
  Games Master cartridges and more) and a GDB target; it also runs in the browser as XRoar Online [^x1].
* **MAME** is the reference: the widest catalogue of machines and cartridges, decades of verification, and a full
  debugger [^m2] [^m3].
* **VCC** is the established CoCo 3 emulator on Windows, with the Multi-Pak, hard disk and SuperIDE support CoCo 3
  users rely on [^v1]. It is a hobby project, and its authors say progress can be slow.
* **CLOADM's own gaps:** it is young; its CoCo 3 video matches MAME on 34 of 49 compared modes (see
  [Verification](verification.md)); it has no ROMs of its own, like the others.

## Sources

Checked in November 2026 against each project's own files. The XRoar website (www.6809.org.uk) could not be fetched
from the environment that prepared this page, so XRoar facts come from the README of its source tree (the official
text, read through a GitHub mirror); please check the project's site for anything newer.

[^c1]: CLOADM: `node cli/cloadm.js --list-machines` and [Machines](machines.md).
[^c2]: CLOADM: [Verification](verification.md).
[^c3]: CLOADM: [Using CLOADM](using.md) and the feature tables in the [README](../README.md).
[^c4]: CLOADM: [Automation](automation.md), [MCP](mcp.md) and [LIZA and Claude](claude.md).
[^x1]: XRoar README: <https://github.com/stahta01/xroar/blob/master/README> (mirror of the source tree; the project is at <https://www.6809.org.uk/xroar/>).
[^x2]: XRoar README, first paragraph, and `COPYING.GPL` (version 3) and `COPYING.LGPL` in the same tree.
[^m1]: MAME README: <https://github.com/mamedev/mame/blob/master/README.md> (build instructions for Windows, Linux and macOS).
[^m2]: MAME driver sources `src/mame/trs/dragon.cpp`, `coco12.cpp`, `coco3.cpp`, `mc10.cpp`: <https://github.com/mamedev/mame/tree/master/src/mame/trs>.
[^m3]: MAME debugger documentation: <https://github.com/mamedev/mame/blob/master/docs/source/debugger/index.rst>.
[^m4]: MAME README, "License" section, and `COPYING`: <https://github.com/mamedev/mame/blob/master/COPYING>.
[^v1]: VCC README: <https://github.com/VCCE/VCC/blob/main/README.md>.
[^o1]: OVCC README: <https://github.com/WallyZambotti/OVCC/blob/master/README.md>.
