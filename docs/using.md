# Using CLOADM

[CLOADM](../README.md) › Using CLOADM

How to load programs, tapes, disks and cartridges, the keys, snapshots, sharing and embedding. The site's own [Help page](https://cloadm.dev/help/) has the short version.

## Quick fixes

* **Black screen, or no `OK`:** if BASIC hasn't started 5 seconds after power-on, a box over the screen says why,
  from the ROMs: usually a file CLOADM doesn't recognise (another revision, a damaged copy, or a ROM for
  another machine). **Add ROMs** shows them; **Run without ROMs** runs the machine without them.
* **No sound:** browsers only allow sound after a click or a key press. Click the screen, and check **Sound** is
  ticked (Input tab). Sound plays on the browser's audio thread (an AudioWorklet), so a busy page doesn't make it
  stutter; a browser without AudioWorklet, or a copy served over plain `http://` from an address other than
  `localhost`, falls back to the older ScriptProcessorNode, which still plays. So does a browser whose AudioWorklet
  module hasn't loaded within 3 s (seen with Chromium 140 in automated testing): the fallback starts the sound then.
* **A tape won't load:** loading through `CLOAD`/`CLOADM` needs the machine's BASIC ROM; watch the tape counter
  on the cassette panel under the screen (**Fast tape loading** speeds it up). Without ROMs, tick **Load .CAS straight into memory** to load a
  machine-code tape straight into memory. An MC-10 tape (`.c10`, `.k7`) needs the MC-10, and CLOADM offers to
  switch.
* **Wrong disk type:** CLOADM tells a DragonDOS disk from an RS-DOS one by its directory track and says which
  machine it is for. A disk needs the machine's disk ROM (the DragonDOS or Delta cartridge, or Disk BASIC); the
  drives under the screen say which one is missing.
* **Wrong symbols when typing:** the keyboard has two modes (Input tab). **Translated** types what you type, so
  the shifted symbols follow your PC keyboard: `Esc` is BREAK, `Home` is CLEAR, `Backspace` is ←. **Positional**
  sends each key's position instead, so the letters printed on the machine are the ones your fingers find, even
  on an AZERTY keyboard.
* **ROMs gone in a new browser:** ROMs are kept per browser. Use **Save ROM pack…** in the old one and drop the
  file on CLOADM in the new one.

## ROMs

> [!TIP]
> Drop whatever you have onto the page: single files, a folder or a ZIP, with any file names. CLOADM recognises
> each ROM by its contents, puts it in the right socket for every machine it fits, and tells you which ones it
> verified as good dumps.

The BASIC, DOS and character-generator ROMs are copyrighted by their owners (Microsoft, Tandy, Dragon Data and
others). CLOADM doesn't include them, doesn't download them and doesn't fetch them from anywhere on your behalf,
and its tests never use them.

* **Own the machine?** Dumping the ROMs from your own hardware is the cleanest route (an EPROM reader, or a
  program that sends the ROM out of the cassette or serial port). A dump that comes out as one combined file is
  fine: CLOADM splits it.
* **Looking for the files?** [Where to get ROMs](https://cloadm.dev/roms/) says where the ROM sets XRoar uses are
  kept. That site isn't part of this project, CLOADM never contacts it, and whether you may download from it
  depends on the law where you live and on the copyright holders' terms.
* **Drop the files on the page.** CLOADM checks each one's CRC32 against the ROMs it recognises and keeps it in your
  browser's storage only. It is never uploaded, never put in share links and never included in exported
  settings. **Save ROM pack…** carries your ROMs to another browser.
* **See what went where.** **Add ROMs** (the orange **No BASIC · Add ROMs** in the header, **Add ROMs** in the
  Machine tab, or key 3 on the Welcome menu) shows **Your ROMs**: what each one takes (size and usual
  file names), whether it is required, and what it holds or what you miss without it. It lists what each dropped
  file turned out to be, explains a file that loaded but isn't recognised (with its CRC32 to compare), offers to
  switch to other machines your files set up, and has **Switch on** once BASIC can boot. A dropped ROM that
  couldn't be used (the wrong size for its name, say) opens it to say why.

The early CoCo ROMs (`bas10`, `bas11`, `extbas10`) have known bugs, so prefer later revisions. Disk BASIC
(RS-DOS, DragonDOS) lives in the disk-controller cartridge, not the computer; CLOADM recognises those ROMs and keeps
them for the disk cartridges. The Alice 32 and Alice 90 are different machines from the Matra
Alice. Every socket, alias and the CRC32 of every known-good dump are in [roms.md](roms.md).

## Storage

ROMs, the Library and the last few programs you loaded live in browser-private storage
(the Origin Private File System), which survives a reload and needs no permission. A browser without it falls back
to keeping them for the visit, with a download and an import button for the files you want to keep. The Library's
**Where your library is kept** changes this: inside this browser, a folder on your computer (File System Access,
Chrome and Edge: ordinary files, and disk writes go straight back to the image file), or download and open. Choosing
another place copies what CLOADM keeps there (the library, disk images, ROMs, recent programs; nothing else in your
folder) and leaves the old copies where they were; it is refused while a stored disk is in a drive. Which ROM is in
which socket and the ROMs' file names are merged with what the new place already has, so moving back to a folder
keeps the ROMs you set up in the meantime; the recent list is the library's own. The choice is remembered, and so is the folder (its handle in
IndexedDB); if the browser asks for the folder's permission again after a reload, the Library offers **Reconnect the
folder**, and until then what you load is kept in the browser; reconnecting copies what this visit added into the
folder too (only that: what the browser had from earlier visits is not, so nothing deleted from the folder comes back). When a ROM
or program was stored by an older CLOADM in `localStorage`, it is moved into the new storage once, on the first
load, and the old copy is removed. Small settings (the machine, its options and the flags) stay in
`localStorage`.

## What works today

The [README](../README.md#what-works) has the short version of this table.

| | Today | Coming |
|---|---|---|
| **Cassette** | `.CAS` played as a real 1200/2400 Hz signal through the cassette port, motor relay, fast loading; WAV recordings in; what `CSAVE`/`CSAVEM` write saved as `.CAS` or `.WAV` (a recording still running when the machine is switched is offered for saving first); a power cycle keeps the tape, the cartridge and its disks, as on real hardware; any tape exported as `.WAV`; the cassette panel (block, counter, motor, fast-forward or real speed, read errors, skip the tape) | the tape's sound at real speed |
| **Floppy** | The Dragon DOS cartridge (WD2797), the Premier / Delta cartridge (WD2791) and the RS-DOS cartridge (WD1773), cycle for cycle as MAME has them; VDK, JVC (`.dsk`) and DMK images read and written, including headerless NitrOS-9 / OS-9 `.dsk` images of 18 x 256-byte sectors, whose LSN 0 states the geometry (a 40-track two-sided image used to be read as 80 single-sided, and on the CoCo's drive did not mount at all); 4 drives (the Dragon Alpha's own 2), write-protect; the drives card under the screen: click a drive to insert a file, a disk from your library or a new blank disk (the sizes the disk system uses: 40 or 80 tracks, one or two sides for DragonDOS and Delta; 35 or 40 for Disk BASIC; VDK, JVC or, double-sided, DMK), see its light while it works, write-protect, download it with what was written, eject. A drive whose changes the browser's storage refused is marked "not saved" (Download keeps them); without a disk ROM, a drive says which one it takes. Disks are written back to the stored image a sector at a time. The DOS ROM is yours, as every ROM; the Alpha needs none; [booting NitrOS-9](#booting-nitros-9) Level 2 on the CoCo 3 from your own 40-track floppy image, with CLOADM's own loader instead of a ROM | Booting NitrOS-9 from 80-track floppies |
| **Cartridges** | ROM cartridges (`.ROM`, `.CCC`, `.DGN`) at `$C000`, autostarting; banked ROM cartridges (up to 128K in 16K pages); the Games Master Cartridge (SN76489A) and the Orchestra-90 (stereo DACs), sound included; the Multi-Pak with four slots; all as MAME has them on the CoCo 1/2, the CoCo 3 and the Dragons (MAME offers the banked board only on the CoCos). The cartridge port's board menu picks the board, or picks it from the image; its Multi-Pak section fills the four slots and sets the front-panel switch. The Multi-Pak also takes a disk controller (DragonDOS, Delta DOS or Disk BASIC, your ROM) on the Dragon 64 and the CoCo, compared with MAME in slot 4; a slot's board menu offers it, and the drives card uses it. The Speech/Sound Pak is offered as a board (music only; speech not yet) on the CoCo 1/2, CoCo 2B, CoCo 3 and the Dragon 64 | Speech/Sound Pak: its AY `-wavwrite` comparison is not passing (cause not established), and SP0256 speech synthesis is not implemented |
| **Printer, serial, DriveWire** | Printer (Dragon parallel, CoCo/MC-10 serial); the bit-banger and the Dragon 64's 6551 ACIA with a terminal or loopback plug; DriveWire 4 over the CoCo's Becker port, served in the browser: drives 0-3 from images in the browser's storage, printing, virtual serial channels to WebSockets; [booting NitrOS-9](#booting-nitros-9) Level 2 on the CoCo 3 from your own DriveWire image, with CLOADM's own loader instead of a ROM; serving a real CoCo over Web Serial (untested on hardware) | the full screens |
| **Input** | Keyboard in two modes (translated: the character typed; positional: the physical key), keyboard joystick, gamepads (two joysticks, dead zone), the Tandy and CoCo Max 3 Hi-Res interfaces, the CoCo 3 "The Rat" mouse, the CoCo Max Hi-Res module, mouse as the right joystick; an on-screen keyboard on phones and tablets (split for the thumbs when held sideways) and a touch joystick with FIRE, a tappable welcome menu | |
| **Tools** | 6809/6803 assembler, POKE book with the SAM CPU speed, ROM self-test, snapshots (a `.cloadm` file to drop back in; Snapshot 1–3 in the browser), the Debugger screen (breakpoints, watchpoints, stepping, registers, memory, trace, symbols) | Step back (rewind) |
| **Links, embedding, offline** | Every setting as a URL parameter (machine, RAM, CPU, a program, tape or cartridge to load, display, input); the Share screen: a link that opens this machine exactly as it is, a 6-second clip, a true-pixel screenshot, the snapshot file, and the embed code for a blog post; embed mode with a JavaScript API; works offline once visited, installable; settings export and import (never ROMs) | An install prompt, a touch keyboard in embeds |

**Speech/Sound Pak wiring.** The Pak is a CoCo cartridge holding three devices: a TMS7040 ("PIC") microcontroller running its own firmware, a GI SP0256 speech chip, and an AY-3-8913 sound chip. The 6809 never talks to the SP0256 directly: it writes a byte at `$FF7E` and interrupts the TMS7040, whose ports drive the speech chip and the AY. In MAME's `src/devices/bus/coco/coco_ssc.cpp` the SP0256 sits on the TMS7040's port C control lines (ALD on `C_ALD`, speech-ROM clock and chip selects alongside) and the TMS7040's port D is the data bus; the SP0256's `LRQ` and `SBY` come back to the host through the status read at `$FF7E` (`0x40` is `sby_r()`, `0x20` the sound-activity circuit, `0x80` the TMS7000 busy flag), and `$FF7D` bit 0 resets the speech chip along with the PIC and the AY. Port C bit 3 (`0x08`) does two jobs: it is the static RAM's read/write line and the AY-3-8913's `BDIR`, separated by the chip-select bits 4 and 6, which the firmware never asserts together. Our `js/chips/sp0256.js` models the speech chip itself, and the cartridge needs the TMS7040 core as well. At run time the Pak's two ROMs (the TMS7040's internal ROM and the SP0256-AL2's allophone data) are supplied by the user, like BASIC and DOS. For verification the project uses its own TMS7040 firmware and hand-built SP0256 data, never the real dumps, and runs MAME through its checksum-mismatch path as for the other diagnostic firmware.

## Booting NitrOS-9

[NitrOS-9](https://www.nitros9.org/) is the multitasking OS-9 operating system for the 6809 and 6309. On the
CoCo 3 CLOADM boots it from your own disk image, over DriveWire or from the floppy drive, and needs no ROM at all:
its own loaders (`js/machines/nitros9.js`, written for this project) take the place of the CoCo 3's internal ROM,
read the boot track from drive 0 and start it, as Disk BASIC's `DOS` command does.

1. **Get the image.** CLOADM doesn't include or download NitrOS-9. Get the CoCo 3 release from the
   [NitrOS-9 project's releases](https://github.com/nitros9project/nitros9/releases) (the v3.3.0 archives are
   also on [its SourceForge page](https://sourceforge.net/projects/nitros9/files/releases/v3.3.0/)):
   `nos96809l2v030300coco3.zip` for the 6809, `nos96309l2v030300coco3.zip` for the HD6309. Take the file ending in
   **`_becker.dsk`** to boot over DriveWire, or **`_40d_1.dsk`** (Disk 1 of the 40-track floppy set) to boot from
   the floppy drive.
2. **Boot it.** Pick the CoCo 3, then under the screen **NitrOS-9 · Add image…** and choose the file: it goes into
   your library (a DriveWire image with the DriveWire images, a floppy with the disks) and boots at once. Next time
   pick it in the list and press **Boot NitrOS-9**. Dropping the file on the page (or **Open…**) offers **Boot
   NitrOS-9** too, from any machine.
3. You land at NitrOS-9's shell, `{Term|02}/DD:`. The floppy's startup first asks for the time (`Time ?`): press
   Enter, or type it as `yyyy/mm/dd hh:mm:ss`. Then type `dir`, `mdir`, `free`… **Reset** and **Switch off and on**
   boot it again; **Back to BASIC** puts the machine's own ROMs back (so does choosing another machine).

What it does to the machine: for the 6309 build it switches the CPU to the HD6309 (the 6809 build runs on either);
RAM stays as it is (128K or 512K). A DriveWire image goes in DriveWire drive 0 with the Becker port turned on. A
floppy goes in drive 0 of the CoCo disk controller (Disk BASIC's WD1773 cartridge): the one in the cartridge port, or
one plugged in without a ROM (the loader drives it; Disk BASIC is never needed), which Back to BASIC takes out again.
What NitrOS-9 writes goes into the image in your library, as with any DriveWire drive or floppy.

Images it refuses, and says why: a file that isn't an OS-9 disk; a NitrOS-9 disk without a boot track (Disk 2 of
the floppy set); the 80-track floppies (`_80d`), as the CoCo's drives here have 40 tracks; the bit-banger, Arduino
and CoCo SDC builds (`_dw`, `_arduino`, `_cocosdc`), which talk to other hardware; and the headless builds
(`_becker_headless`), whose console is a DriveWire terminal rather than the screen. A floppy boot through a
Multi-Pak is refused (take it out first). NitrOS-9 boots on the NTSC CoCo 3 only; on another machine CLOADM says so.

**Links.** `?nitros9=1` opens the CoCo 3 and boots NitrOS-9 from the image in your library (the one in DriveWire
drive 0, else the one in floppy drive 0, else one for the link's CPU); `?nitros9=NAME` boots that image. The link
never holds the image, so whoever opens it needs their own; without one CLOADM says where to get it. **Share** while
NitrOS-9 runs gives such a link: a NitrOS-9 moment is never put in a link as a snapshot, because its memory is your
copy of NitrOS-9. Snapshots you keep (Snapshot 1–3, a `.cloadm` file) work as usual; a DriveWire one reopens with
whatever image is in DriveWire drive 0 then.

**What is verified** ([details](verification.md#nitros-9-boot-test)):

* **DriveWire:** the official v3.3.0 Level 2 CoCo 3 `_becker.dsk` images, 6809 and 6309, boot to the shell and list
  the root with `dir`: in Node, with every DriveWire transaction (but the clock's) identical to MAME 0.264 running the
  same image and loader at 512K; through the Session at 512K and 128K; and in the real page in Chromium, `dir` typed
  on the keyboard.
* **Floppy:** the v3.3.0 `_40d_1.dsk` images, 6809 and 6309, boot to the shell, take Return at the time prompt and
  list the root with `dir`: in Node at 512K, with every write to the disk controller's registers identical, in order,
  to MAME 0.264 running the same image and loader; through the Session at 512K and 128K (at 128K the 6809 build's
  startup skips the time prompt, as it does in MAME); and in the real page, Return and `dir` typed on the keyboard.
  The floppy loader itself runs in instruction lockstep with MAME on both CPUs, and the controller's HALT and NMI
  during halted sector reads at both CPU rates are compared with MAME instruction for instruction (the fix this
  needed is in [verification.md](verification.md#nitros-9-boot-test)).
* **Not tested:** other NitrOS-9 versions and other OS-9 boot disks; the `_40d_1_50hz` floppies (they boot, but they
  are PAL builds and their clock runs fast on the NTSC CoCo 3); 128K against MAME.

## Loading programs

* **`.BIN`**: DragonDOS binaries (9-byte `$55 … $AA` header) and segmented DECB-style binaries. The emulator writes them into RAM and jumps to the exec address. DragonDOS BASIC files are loaded and `RUN`.
* **`.CAS`**: tape images. With ROMs loaded, the emulator plays the tape through the cassette port and types `CLOAD`/`RUN` or `CLOADM:EXEC` for you, so multi-part and autorun loaders work. Tick *Load .CAS straight into memory* (Media tab) to skip the tape. Only machine code and tokenised BASIC are loaded that way: an ASCII BASIC listing always goes through `CLOAD` (it needs the ROMs), and a DATA file is only put in the deck for the program that reads it.
* **`.WAV`**: tape recordings (8, 16, 24 or 32-bit, mono or stereo, any sample rate). They are decoded to `.CAS` bytes and then load like a `.CAS`.
* **`.ROM` / `.DGN` / `.CCC`**: cartridges mapped at `$C000`, which autostart. Up to 16K goes on a Program Pak, more
  (up to 128K) on a banked board, and the Orchestra-90's own ROM on an Orchestra-90; the board menu in the cartridge
  port overrides the choice (Program Pak, Banked ROM, Games Master, Orchestra-90). The port's Multi-Pak section takes an
  image and a board for each of the four slots and the front-panel switch, and inserts them together; a slot's board
  menu also offers the machine's disk controllers (no image needed: the DOS ROM is the one you added), which the drives
  card then uses.
* **`.BAS` / `.TXT`**: BASIC listings, which are typed in.
* Any other file loads as raw data at an address you enter.

## Library and type-ins

This is how most of us learned: a magazine open beside the keyboard. BASIC listings need the machine's BASIC, so
add your ROMs first; then open the **Library** (in the header), paste a listing into the type-in card and CLOADM
types it in for you at keyboard speed, line by line, with the machine's screen beside it. The Library also keeps
every tape, disk, cartridge and program you load (disk images under `disks/` in the store, where the drives find them:
clicking one mounts it; one in a drive can't be renamed or deleted until it is ejected), so next time it's one click:
click a spine or a tile, or drag it onto the machine's screen in the type-in card. Its magazine rack links the
archives below. **Select** (beside "Add files…") turns clicks into a selection: load or rename one item (the name is
edited on the item: Enter saves, Esc cancels), download several, or delete them. Delete asks nothing; the items
leave the shelf at once and an Undo toast stays for 8 seconds before they are really removed. Done or Esc goes back to
loading on click. On a phone the actions sit in a bar along the bottom edge.

* *The Rainbow* (1981–1993) and *Hot CoCo* (1983–1986), the American CoCo magazines, at the
  [Color Computer Archive](https://colorcomputerarchive.com/repo/Documents/Magazines/). Their BASIC listings often
  run on a Dragon with small changes.
* Dragon 32 type-in listings at the
  [Centre for Computing History](https://www.computinghistory.org.uk/cgi/archive.pl?platform=Dragon+32&type=Listing),
  including 1983 games from *Popular Computing Weekly*.
* *Dragon User*, [all 69 issues](https://www.os9projects.com/DragonTop/DragonMag/DragonUser/DragonUser.html)
  (May 1983 to January 1989).
* *INPUT*, the 52-part programming course with Dragon 32 versions of its programs, at
  [Retromags](https://www.retromags.com/gallery/category/1043-input/).

## Keys

`Esc` = BREAK, `Home` = CLEAR, `Backspace`/arrows = arrow keys, `Enter` = ENTER. Shifted symbols are mapped to the Dragon layout.

The machine gets the keyboard while its screen has focus (click it, or just start typing on a fresh page). Anywhere
else the page keeps the keys: `Tab` moves between controls, `Enter` and `Space` press buttons, arrows move sliders
and `Esc` closes a dialog. `Tab` and `Shift+Tab` never go to the machine, so the screen is never a keyboard trap:
reached by keyboard it shows a ring and "Tab leaves the screen" (CLEAR is `Home` or `Delete`).

`Esc` answers "no" to a question waiting above the screen (a confirmation, an offer, a snapshot's "needs ROMs")
wherever the focus is. Otherwise it is BREAK while the screen has focus, and anywhere else it closes the topmost
thing that is open: a confirmation, a menu (the machine menu, a drive's menu, Ctrl+K), a card above the screen (an offer, a snapshot's
"needs ROMs"), a view (Share, the Library, Add ROMs, the Debugger), then the Claude chat (the Ask panel or the full
screen), and focus goes back to the screen. In the full-screen chat the screen is the chat, and `Esc` there escalates:
while a reply streams it is BREAK and stops the reply; while a line is typed it is BREAK and drops the line; on an
empty, idle prompt it leaves the chat, exactly as **← Emulator** does. With focus on the chat's bar (or anywhere off
the screen) `Esc` returns to the emulator and the reply goes on. Controls that use `Esc` themselves keep it: a rename in the Library cancels, select
mode ends, the Ask panel's drawer rail closes. Each view, and the full-screen chat, adds one entry to the browser's
history, so Back returns to the emulator; one opened from another replaces it (a view opened from the full-screen
chat takes its place; the conversation moves to the side panel, which reopens when you return to the emulator), and one the page was opened on (a link to
`#library`, or a reload on it) closes to the emulator rather than leaving the page. Every "← Emulator" returns to
the emulator, whatever the address (`?app=claude` included) and the history behind it.

On a phone or tablet an on-screen panel appears under the screen; held sideways it is fixed around the screen.
The **Keys | Joystick** switch (shown when the machine has a joystick port of its own — not the MC-10 or Alice, and
not when the right port holds a Hi-Res interface or The Rat) turns it into a **touch joystick**:

* One stick, on the **right** joystick (the one the first gamepad drives), analogue over the machines' 0–63 with a
  small dead zone, no eight-way snap. Touch down anywhere in the zone to set its centre; about 56 px of travel is
  full deflection. In Keys mode held sideways the panel is the split thumb keyboard; in Joystick mode the stick fills
  the left, and the key strip (SPACE, ENTER, BREAK, 1, 2, Y, N, ABC) and a large FIRE the right. Upright the switch,
  the key strip, the stick and FIRE come under the screen. ABC shows the keyboard for one keypress — the whole
  keyboard upright, the split keyboard's two halves sideways, where the screen has the height — then the stick
  returns. The stick and FIRE can be held at once.
* FIRE is the joystick's button bit, so it shares a keyboard row line as a real stick's fire button does, and on the
  CoCo 3 it raises the keyboard interrupt. A gamepad connecting stands the touch stick down until it disconnects.
  The mode is remembered per machine, and `?touch=joystick` or `?touch=keys` sets it for the visit.
* Keys mode: the keyboard splits for your thumbs, BREAK, CLEAR, the switch and Menu sit under it. `SHIFT` shifts the
  next key. **Hide keys** is in the panel's Menu. Input tab → On-screen keyboard: Automatic, Always or Never.
  The welcome menu's lines can be tapped (in Joystick mode a tap on the screen never reaches the menu).
  Files can be dropped anywhere on the page, and after the first ROMs are added CLOADM asks the browser to keep
  them, saying if it may not.

## Display

The Display tab: CRT · composite (composite colour, a WebGL CRT look with curvature, phosphor glow and
scan lines) or Sharp · RGB (the pixels as they are); NTSC artifact phase; integer scaling; 4:3 or fill; remembered.

* **Defaults:** CRT · composite with artifact phase 1 (MAME's default), curvature 35 %, glow 55 %, 4:3, no
  integer scaling. So composite colour is on from the start, and the CoCo 3 starts on its composite monitor's
  palette; Sharp · RGB switches it to the RGB monitor's.

## The speed POKEs

`POKE 65495,0` sets the address-dependent rate, `POKE 65497,0` the fast rate, and `POKE 65494,0` / `POKE 65496,0`
go back. The emulator's Machine tab shows the rate and lights the SAM chip when it changes; the POKEs tab has a
POKE book that types them in, and lights the chip line of the entry that makes the change, however it was typed. Without ROMs, CLOADM carries out typed `POKE address,value` lines.

## Snapshots and sharing

(Ask Claude's restore points are a different thing: kept in memory only while the chat is open, and lost on a
reload, when the chat ends or when you switch machine. See [claude.md](claude.md#claude).)

**Share** in the header takes a snapshot: the machine, its RAM, CPU, chips, the tape in the deck and
the cartridge, and the picture. **Download snapshot** saves it as a `.cloadm` file; drop the file on the screen
(or pick it with **Open…**) to restore it. **Screenshot** saves the picture at the machine's true
pixels.

A snapshot never contains ROMs, only the CRC of each ROM it ran with. Opening one needs exactly those ROMs in this
browser (or none, if it ran without ROMs); otherwise CLOADM says which ROM it needs and opens the snapshot as
soon as you add it. A snapshot of another model or RAM size asks before switching.

A page reads the snapshot versions it knows and says so when a file is newer or older, or was saved by a
pre-release build, whose snapshots it does not read (the format is in [architecture.md](architecture.md#snapshot-format)). **Snapshots** in the drawer's Media tab keeps three
snapshots in this browser's storage (as `library/snapshots/slot-N.cloadm`, so the Library lists them under
Snapshots); loading one works like opening a snapshot file.

The **Share screen**: **Capture & share** opens it: the link there carries the moment itself (the snapshot rides in the
fragment after `#s=`, which browsers never send to a server, so the link is long: about 4 to 10 KB), and the
embed builder writes the iframe and script for the machine, program and options you pick.

A shared moment holds no byte of a ROM or a cartridge (`Session.shareFile`, `js/media/romrefs.js`), even when it ran
on your own ROMs. It names them by CRC: the machine's ROMs, the cartridge's image, a disk controller's DOS ROM. Every
copy of their code in memory travels as a reference (which image, where in it, how long) with the bytes left out.
BASIC copies itself into RAM on the Dragon 64 in its 64K mode and on the CoCo 3; a program can copy any ROM, print it
or send it down a DriveWire channel, so the printout and DriveWire's buffers and queues are scanned too, and a tape
being recorded is left out of the link (its pulse timings could carry anything). Before a
link is made, CLOADM checks that no 16-byte run of any of those images is left in it (a run of one repeated byte
aside), and it refuses to make one otherwise. The person opening the link needs their own copies of the same
versions: with them the moment opens exactly, rebuilt from their images; without them the card says which ROMs (or
which cartridge, by size and CRC) to add, and the moment opens once they are in; another version of a ROM is refused
with both CRCs, never loaded. A moment on the built-in firmware needs nothing. Shared links are much shorter with
ROMs in use: a Dragon 64 whose memory holds BASIC's 16K copy of itself shares in about 3 KB instead of about 21 KB.
The references ride in the snapshot's `share` field, which only shared moments have. Snapshots you keep (the Snapshots panel and its slots) stay complete: they never leave your browser.

## Settings

Share screen → Your settings → **Export settings…** saves your settings (machines and their options, display,
the choices you made) as `cloadm-settings.json`; **Import…** in another browser takes them up. ROMs and stored
programs are never in that file, and are ignored if someone adds them.

## Links and embedding

Every link CLOADM writes opens `/play/`. `js/config.js` reads and checks these parameters; a value a machine
doesn't have is reported in a message (with Details) and the rest of the link still applies.

| Parameter | Values | |
|---|---|---|
| `machine` | `dragon32`, `dragon64`, `coco`, `coco3`, `mc10`, … (the machine menu's models) | |
| `ram`, `cpu` | the machine's own options, e.g. `ram=128` or `ram=512` on the CoCo 3 | checked against the model |
| `start` | `welcome`, `liza` | runs that program |
| `app` | `claude` | opens the Claude chat ([claude.md](claude.md#claude)) |
| `nitros9` | `1`, or an image's name | CoCo 3: boots NitrOS-9 from your own DriveWire or floppy image ([Booting NitrOS-9](#booting-nitros-9)); never carries the image |
| `load` | a link to a program, tape or cartridge | loads and runs it, as a dropped file |
| `tape` | a link to a `.cas` or `.wav` | puts it in the deck; with `autorun` it loads and runs |
| `cart` | a link to a cartridge ROM | plugs it in; it starts |
| `rom` | a link to a ROM image (repeatable), never the Color Computer Archive | with `selftest=1`, the ROM self-test |
| `display`, `phase`, `aspect`, `integer`, `curvature`, `glow` | `crt`/`sharp`, `1`/`2`, `4:3`/`fill`, `1`/`0`, `0`-`100` | for that visit only, never stored |
| `joy` | `mouse`, `off` | the mouse as the right joystick |
| `touch` | `joystick`, `keys` | the on-screen panel's mode on a touch screen: the touch joystick, or the keyboard alone (not for embeds) |
| `sound`, `fasttape`, `turbo` | `1`, `0` | |
| `embed` | `1` | the screen alone, for an iframe |
| `storage` | `opfs`, `fsa`, `fallback` | where ROMs and programs are kept |

Files given by link are fetched by the browser, so their server must allow CORS.

**Embedding.** Put `<iframe src="https://cloadm.dev/play/?embed=1&machine=dragon64">` in a page, include
`https://cloadm.dev/embed/cloadm.js`, and drive it:

```js
const m = await CLOADM.attach(document.querySelector('iframe'));
await m.load('game.cas', bytes);          // also type, insertTape, reset, powerCycle, switchMachine,
await m.type('PRINT 2+2\n');              // peek, poke, screenText, setDisplay, info
m.on('frame', (f) => {});                 // and 'machine', 'loaded', 'reset'
await m.loadBasic('10 PRINT "HI"\n20 GOTO 10');   // into program memory, no typing: needs BASIC at OK
```

`loadBasic` is `Session.loadBasic`, the same implementation as Claude's `load_basic` tool
([claude.md](claude.md#claude)) without its confirmation card: it resolves to `{lines, bytes, start, end}` or
rejects with a coded message such as `no-basic: ...` or `not-at-prompt: ...`.

## Offline

After one visit CLOADM works without a network (`sw.js`, a service worker that always asks the
network first and keeps a copy of the whole site), and browsers offer to install it as an app
(`manifest.webmanifest`). ROMs and programs stay in the browser's own storage either way.

## Assembler

The Assembler, in the Source pane of the **Debugger** screen (in the header), is a two-pass 6809/6803 assembler (`js/asm/`). Write or open source, click
**Assemble & run** to run it on the emulated machine, or click **Save .BIN** to download a DragonDOS binary.
Wrong code is never emitted without an error: an operand that doesn't fit its field (`LDA #$1234`, `FCB 300`, `FDB $12345`,
a 16-bit address or offset past 64K), a division by zero, a label defined twice (by a line label or `EQU`), and an
`ORG` or `RMB` whose value is defined only later in the source (it would move every label after it) are errors
with the line. `FCC`, `FCS` and `FCN` take `"text"` or text between two of the same delimiter, one of `/`, `!`, `|`, `:`, `^`, `~`, `?`, `\` or a backtick
(`FCC /a,b/`).

## ROM self-test

The Dragon ROMs aren't distributed with the emulator. Anyone who has them can verify the emulator against them:

1. Load the ROMs with **Choose files…**, or open `play/?rom=URL1&rom=URL2&selftest=1`. The server hosting the ROMs must allow CORS.
2. Click **ROM self-test**.

The self-test boots the ROMs on a hidden machine and drives BASIC through the emulated keyboard. It checks these things:

* booting to `OK`
* arithmetic
* every shifted symbol on the keyboard
* the field-sync interrupt, via `TIMER`
* `CLOADM`/`EXEC` and ASCII `CLOAD` from generated tapes
* `JOYSTK`
* `SOUND`
* `PMODE 4` graphics
* BREAK
* `MEM`
* switching to Dragon 64 64K mode with `EXEC`

The report contains no ROM data, only sizes, CRC32s (matched against known-good dumps) and results, so it can be shared freely.

---

See also: [Machines](machines.md) · [LIZA and Claude](claude.md) · [ROM list](roms.md) · [Verification](verification.md)
