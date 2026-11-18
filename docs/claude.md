# LIZA and Claude

[CLOADM](../README.md) › LIZA and Claude

## LIZA

In 1983 a computer that talked back was a trick. **LIZA**, written for this project, is that trick: ELIZA-style
keyword matching in 3 KB of 6809. It runs with no ROMs: press 1 on the welcome screen, or open
[cloadm.dev/play/?start=liza](https://cloadm.dev/play/?start=liza).

`examples/liza.asm` is LIZA, an ELIZA-style conversation program written for this project in 6809 assembly. It finds
keywords in what you type, swaps pronouns ("my" → "your", "I am" → "you are") and rotates through its replies.
It uses only the ROM's `POLCAT`/`CHROUT` vectors, so it runs with or without the Dragon ROMs. Click **Open LIZA source**,
then **Assemble & run**, and type `BYE` to finish.

There are two builds holding the same conversation, and the keywords, replies and pronoun swaps live once, in
`examples/liza-data.inc`, which both sources `INCLUDE`. The 6809 build (`examples/liza.asm`) assembles to 3190
bytes of code and data at `$3000`, and the 6803 build (`examples/liza6803.asm`, for the MC-10 and Matra Alice,
in 6803 assembly) to 3530 at `$5000`: its loaded image ends at `$5DC9` and its variables extend to `$5FB4`. It sits
above a 4K machine's RAM, so it needs the 20K option: on a 4K MC-10 or Alice the shelf's LIZA says so, and
choosing it (or opening `play/?start=liza`) offers a one-click switch to 20K above the screen, which restarts the
machine with 20K and starts LIZA.

The 6803 build is one per machine, because its title names the machine it runs on (`LIZA - AN MC-10 THERAPIST` /
`LIZA - AN ALICE THERAPIST`, `examples/liza6803-mc10.bin` and `examples/liza6803-alice.bin`). The two titles are the
same length, so the two images have the same layout and differ only in the name.

## The welcome program

`examples/welcome.asm` is the first program a visitor sees: the eight VDG colours build up as a stripe, then
CLOADM in block letters and a menu. The keys 1 to 4 reach the page through a mailbox byte the Session reads after
every frame (`Session.startWelcome`, events `welcome:liza`, `welcome:demo`, `welcome:roms`, `welcome:claude`),
and a short original tune plays on the DAC once the browser allows sound. It runs on the 6809-family machines
(the HD6309 included, which runs the 6809 build in emulation mode, and the CoCo 3 in its CoCo 2-compatible text
mode); the MC-10 and Alice get a 6803 version with LIZA's.
Without ROMs every visit opens on it: a returning visitor reads
"WELCOME BACK" and, if something ran last time, option 5 "CARRY ON WITH ..." (`welcome:carryon`; the Session
sets the greeting and the line before the program starts). Option 5 offers only what runs on the machine in use
(`Session.carryOn`): a file on the machine it was loaded on, the colour demo on a 6809-family CPU (the 6309 runs it
too), LIZA everywhere. Leaving a program brings the menu back, "BYE FOR NOW.
PICK ANOTHER?": BYE in LIZA, or a key once the colour demo is drawing (the Session watches and emits `menu`).
With ROMs the machine boots them as before; the Media tab's "Last time" runs the last item again, and the
welcome menu is the first entry of "Runs without ROMs".
Without ROMs the machine behaves like a real computer and never leaves you on the stub's bare screen: **Power
cycle**, **Run without ROMs** and **Remove ROMs** turn it on into the welcome menu (`menu` with `'back'`), and
**Reset** restarts what is running from its own entry point (the menu, LIZA, a binary with an exec address), or
brings the menu when nothing is. Switching to a machine without its ROMs turns it on into its menu (the MC-10 and
Alice run their own 6803 build, with the same greetings and option 5), and a snapshot taken on the stub's bare
prompt opens on the menu. On the menu, or any program on the stub, the POKE book does its POKE directly instead of
typing it (its digits would be the program's keys). Embedded (`?embed=1`) the page has no menu of its own: the
embedding page drives a plain machine, and without ROMs that is the stub's own screen.

## Claude

**Claude** is the same machine forty years on: press 4 on the welcome screen, or open
[cloadm.dev/play/?app=claude](https://cloadm.dev/play/?app=claude). Firmware written for this project replaces
BASIC and holds the conversation on the green screen, in a lowercase font drawn by the machine itself. Claude can
work on the BASIC session kept alongside the chat: read its screen and memory, POKE, type in short programs or load
longer ones and RUN them,
press BREAK, and one click undoes it all. It runs on your own Anthropic API key, kept in your browser and never
visible to the emulated machine, snapshots, share links or exported settings. Coming: the same chat over DriveWire
to a real CoCo or Dragon on Web Serial, and the CoCo 3's 80-column screen.

The API costs are kept down with prompt caching: the tool list and the brief are cached together behind one
breakpoint (they never change during a conversation), and the growing part of the conversation is cached
automatically, so a request pays full price only for what the latest turn added. On a manual run with a real key,
send the same message twice and check `usage.cache_read_input_tokens` in the response: the second request must
report a non-zero count (and `cache_creation_input_tokens` near zero). A zero there across identical requests means
something in the prompt prefix is changing between them.

Two ways to talk to Claude, one conversation:

* **Ask Claude** (`js/ui/ask.js`; a bottom sheet on a phone) is a side panel beside the
  live machine: the header's **Ask Claude** button, **Ctrl+K** (⌘K on a Mac), or an opener under the machine
  (**Explain this error** when a BASIC error is on screen, **Help with my program** when a BASIC program is in
  memory). It opens at 420 px and its left edge drags it between 320 and 560 px; the drawer's tabs fold into an icon
  rail beside it (an icon opens that tab over the panel, Esc closes it); minimised, a strip at the top of the drawer
  shows what Claude is doing. The panel docks beside the machine and never covers it: the machine narrows, down to
  480 px (the 256-pixel picture at nearly 2×), which needs a window of at least 960 px (from 960 to 1100 px there is
  no rail, and the drawer stays below the machine). Narrower than 960 px the panel lies over the page instead, as
  docking would leave the machine too small to use; on a phone it is a bottom sheet with peek, half
  and full heights (the restore points and the switch are in its ⋯ menu), and it moves up above the phone's own
  keyboard while you type (the visual viewport).
* **Ctrl+K** opens "Ask Claude or find a command" (`js/ui/command-box.js`): the page's commands that match what you
  type come first (each presses the page's own button and is never sent to Claude), **Ask Claude: "…"** is always
  last. Enter runs the command or asks; asking opens the side panel, or full screen while the welcome menu is on
  screen.
* **Consent.** Claude can always read (the screen, memory, the machine); the panel says what it can see. Acting
  (POKE, typing, BREAK) needs **Let Claude use the machine**, off until you allow it: the first time Claude wants to
  act it asks in the conversation (**Allow**, which turns the switch on for the visit, or **Just tell me the fix**,
  which Claude is told and which changes nothing). While Claude acts the screen has a pulsing green ring and
  "Claude is typing line 120… **Stop**" at its top, and the panel shows a live log. A key you press on the machine
  pauses Claude: what it still had to type is held back and its next action waits, until **Resume** (or **Stop**).
* **What is this code doing?** in the Ctrl+K box asks about the code at the program counter: the disassembly and
  the registers go with the question (`Session.codeAt`), and the panel says Claude can see the code and the
  registers. A restore point is made before
  Claude's first change in each turn: **Restore to before Claude's changes**, and **All restore points** (the last 10).
  Restore points are kept in memory only, while the chat is open: reloading the page, ending the chat or switching
  machine loses them. Saved files (the Library, DriveWire) are not rolled back, except a disk that has stayed in
  the same drive since the point (`Session.restorePoint`, also behind the chat's undo): if the machine wrote to it
  since, its stored image is put back to the image the drive holds after the restore, and it goes on saving its
  writes. A disk changed since the point (ejected, replaced or changed in the Library, mounted again or in another
  drive), or one written since and now write-protected or a file that can't be written, is not rolled back: the
  Library's file is left as it is, and the restore says "Drive N was changed since this point; the restored disk
  isn't saved to the Library. Download it to keep it." (or why). If putting a stored image back fails, the error
  says so and that drive is no longer saved to the Library. A point that can't be restored (the ROMs changed since it was taken,
  with Forget ROMs or Run without ROMs) says so and changes nothing: every point is kept.
* **The key states** read the same in both views: no key (the key form replaces the message box), refused
  ("[The API key was refused: check it and try again.]", the form reopens with a red border), rate limited and
  offline (with **Try again**; nothing retries by itself).
* **Side panel / Full screen** moves the same conversation between the two views (`Session.toSidePanel`,
  `Session.startChat`): the chat firmware is given what was said so far. Closing either view keeps the conversation
  for the visit; a machine switch ends it.

**Chat with Claude** is full screen (`js/ui/claude.js`): `?app=claude`, 4 on the welcome screen, or **Full screen** in the panel. The screen is the chat only: your
BASIC session keeps running beside it, and its window in the corner (a strip under the screen on a phone) appears
when Claude acts on it, or when **Ctrl+B** or **Show my BASIC session** swaps the two (the BASIC session big, the
chat in the corner). It stays until you hide it: **Ctrl+B** again, or its **×**. **← Emulator** goes back to the
emulator.

* **On a phone** (portrait up to 700 px wide, or held sideways up to 500 px high) the chat's text gets the room: the
  app bar gives way to the chat bar on one row, the monitor loses its bezel, and the screen shows the chat's picture
  area without its border (`fitActive` in `js/video/layout.js`: the VDG frame says where its 256 x 192 area is, and
  the whole frame is scaled so that area fills the space and the tube clips the border; the pixels are the
  machine's, scaled, never reflowed). A text row is then 11.2 px tall upright and 11.3 px sideways (7.5 and 7.0
  before). Held sideways the screen between the keyboard's halves is wider and its four buttons sit in one row.
  Without a key the key card comes first, above the screen upright and beside it held sideways (both fit the
  height), and the help line says where, measured ("add one above", "on the right"), and the on-screen keyboard stands aside while the phone's own keyboard types the key; once it is
  saved the screen has the focus. The key card comes first wherever the page stacks the chat under the screen (a
  tablet too, under about 1020 px). The way out is always there: the chat bar stays at the top as the page scrolls,
  the on-screen keyboard's Menu becomes **← Emulator** (held sideways the keyboard covers the bar), the browser's
  Back leaves the chat (opening it adds one history step), and so does Esc from the chat bar or its cards (on the
  screen Esc stays the machine's BREAK).
  `tools/browser-check.js` (`phoneChatChecks`) checks all of it at 390 x 844 and 844 x 390, including a line typed
  on the on-screen keys and the mocked reply drawn on the screen.

* **Two machines.** `Session.startChat` keeps the machine in use as your BASIC session and runs the chat firmware
  (`examples/chat.asm`) on a second machine of the same model, on the built-in stub (no ROM needed), which goes on
  screen and gets the keyboard. Both machines run, the one off screen in the picture-in-picture, so Claude's typing
  goes in while you watch the chat. The chat needs a 6809-family CPU (the 6309 runs the firmware unchanged) and
  32K or more: the firmware uses $0400-$7FFF. On a machine with less the chat opens and the screen stays the stub's,
  so pick a 32K model (the Dragon 64, a 32K CoCo); the chat opens on a Dragon 64 from an MC-10 or Alice.
* **Typing.** A line can be up to 255 characters. It wraps as you type the way replies wrap: a word that doesn't fit
  moves to the next line, a word with no space in it breaks at the character, and a space that falls at the end of a
  full line ends it without being drawn. BACKSPACE goes back across the wraps. A key past the 255th is refused visibly: the screen flashes (the VDG's colour
  set switches from green to buff for about a tenth of a second) instead of the key being dropped without notice.
* **The screen.** 256×192 two-colour graphics (VDG GM7, SAM mode 6 at `$0400`, the SAM's memory size set to 64K as
  BASIC sets it), 42 columns by 24 rows with this project's own 6×8 font. Typed lower case reaches the firmware as
  typed (the stub hands every other program upper case, as BASIC's keyboard does).
* **The bytes.** A line goes to Claude when you press ENTER. The firmware carries the bytes one of two ways, chosen
  at start. On a CoCo with the Becker port on (`?becker=true`, the Machine tab) it finds the DriveWire server
  (DWINIT) and talks on virtual serial channel 14, as it would on a real machine with a Becker port: SERINIT,
  FASTWRITE for each typed byte, SERREAD / SERREADM for the reply, into a 256-byte ring (DriveWire 4
  specification, "Virtual Serial Channels"). The chat machine has its own DriveWire server on the Session's
  drives, so its link never mixes with the BASIC session's, and the Session hands the channel to the chat
  (`DriveWireChatChannel`). Otherwise (a Dragon, or the Becker port off: nothing answers DWINIT) the firmware and
  the page meet at a four-byte mailbox at `$7000` (`js/claude/chat.js`), moved after every frame of the chat
  machine, one byte each way.
* **Claude's tools** act on the BASIC session, never on the chat machine. They are split in two, and the split is
  the consent rule: **read-only** tools (`machine_info`, `screen_text`, `peek`, `disassemble`) always work, and
  **acting** tools (`poke`, `type_text`, `load_basic`, `press_break`, `assemble_and_load`, `run`) ask first (see Consent above). The acting set is derived from the tool
  schemas in `js/claude/chat.js` (`ACTING_TOOL_NAMES`), so a tool added there is gated without a second list to
  remember; the read-only tools live in `js/claude/readtools.js`, where a test proves none of them changes the
  machine (the full saved state is byte-identical after every call, even with write-shaped arguments).
  Results are JSON, so a model reads fields and does not have to parse prose; a failure carries a stable code and a
  remedy (`js/claude/toolerrors.js`) and reaches the model as `{"error":{"code":…,"remedy":…}}` with
  `is_error:true`. `peek` returns at most 256 bytes and says `truncated` when it cut a request short; a read whose
  bytes would run past `$FFFF` is a `past-end` error, because reads do not wrap. `disassemble` decodes up to 64
  instructions in the machine's own instruction set (6809, 6803 or 6309, taken from the machine, never from the
  request) through the same side-effect-free peek, and returns each instruction's bytes with its text.
  `screen_text` reads the 32-column text screen from the page the display uses, when the machine's memory map
  still routes the CPU to it. On a CoCo 3 that page is the GIME's own video base, not a fixed `$400`, masked to
  the 16 bits a CPU address holds; the reader reads through the CPU's map while the display reads physical
  memory, and the two are the same page only while the map agrees. When the MMU has moved that page elsewhere
  (or onto ROM), the tool DECLINES rather than showing a screen nobody is looking at, and the reason names both
  addresses. It also DECLINES a mode it cannot read faithfully: a graphics mode, a 40/64/80-column GIME text
  mode, GIME native text (it holds ASCII, not the VDG codes this reader decodes), or
  the d64plus's HD6845S screen each answer `text:false` with the mode named and a reason, rather than returning
  rows that repeat or belong to a screen nobody is looking at. `machine_info`'s `video.readable` is that same
  answer from the same rule in the same module, so a model can skip `screen_text` when it cannot help; `kind`
  stays `text` when a text mode merely goes unread by this reader. On such a screen `atPrompt` is
  `null` ("cannot be told"), not inferred from a page that is not visible. Before
  Claude's first change in a turn the BASIC session is snapshotted, by every acting tool through the one path
  (`ChatSession.withRestorePoint`); **Restore to before Claude's changes** restores it exactly (the last 10 turns are
  kept, in memory only).
  Every integer parameter is declared `"type":"integer"` with the range the code enforces, derived from one set of
  constants, so the schema cannot drift from what the tool accepts; an optional parameter's description states
  the default that omitting it gives (`peek` 16 bytes, `disassemble` 8 instructions), from the constant the code
  applies.
  BREAK is held on the keyboard matrix for the same few frames the typist holds a typed key, because the CPU reads
  the matrix through the PIA (or `$BFFF` on the MC-10) and does not sample it: a key set down and up inside one call
  would never be seen. On a machine with no BASIC ROMs it has no effect, because the built-in stub takes key codes
  from its own queue rather than scanning the matrix. Undo takes a queued BREAK back (it is input on its way in,
  and a restore clears the typist queue); the machine state it changes is zero unless the CPU polls the matrix.
  `node tests/press-break.test.js` covers this on all three families with our own firmware in the BASIC socket;
  the MC-10's strobe address is backed by `tools/mame-diff/mc10-strobe-probe.js`, which runs the same firmware
  in MAME 0.264 and prints `PROBE 5a ff fb bf ff a5` (BREAK visible on column 2 only).
* **Typing (`type_text`).** Keys go in at the pace the machine takes them, not by the clock
  (`Typist.typePaced`, `js/machines/typist.js`). Each key is held until the CPU has read its keyboard column with the
  key down 4 times (and at least 3 frames), then released until the column has been read twice with it up (and 2
  frames), so the next key is never pressed before the machine has seen this one go; after Enter nothing more is
  pressed until the machine reads the keyboard again. The reads are counted on the bus (`Machine.scanKeys`: the
  PIA's row port, the MC-10's `$BFFF`; the stub's POLCAT calls), so this needs no knowledge of any ROM. BASIC busy
  storing a line or scrolling reads no keys, and keys pressed and released then were what went missing. A key
  counts as consumed once the machine has read it while it was down. The result is what the machine took:
  `{requested, consumed, lines_requested, lines_delivered}`. If a key is not read within 300 frames (5 s) the rest
  is not typed and the call fails `not-consumed`, with that report in its detail; a character with no key on this
  keyboard is `not-typable` before anything is typed. Stop ends the typing with `stopped`. Pasting into the
  emulator keeps the old fixed-timing typist. `node tests/claude-typing.test.js` proves it with firmware written for
  the test in the BASIC socket (Dragon 64, CoCo 3, MC-10) that, like BASIC, reads the keyboard with a rollover rule
  and stops reading it for about ten frames after each Enter and every few passes: the old timing loses keys there
  and paced typing loses none; firmware that stops reading the keyboard gets `not-consumed` with an honest count.
* **Loading a program (`load_basic`).** The listing is tokenized for the machine's BASIC and written into program
  memory, replacing the program there, as a load from tape or disk would (`js/media/basic.js`, `ChatSession.planBasic`
  and `loadBasic` in `js/claude/chat.js`). Lines are crunched as Color BASIC crunches them (the keyword tables
  searched in ROM order, first match; `?` is PRINT; `'` and ELSE get a `:` in front; DATA, REM and strings are not
  crunched), laid out as link, line number, text, 0, with a zero link at the end, at the address BASIC's TXTTAB
  holds; then VARTAB, ARYTAB and ARYEND point just past it (no variables, as after a load). Before writing, BASIC's
  own pointers are checked to describe the program in memory (the links end where VARTAB says), so a machine whose
  pointers are not where the dialect says is refused, not written over. It needs BASIC at its OK prompt, leaves 256
  bytes below FRETOP free, and returns `{lines, bytes, start, end}`. Errors, each changing nothing:
  `bad-line-number`, `line-too-long`, `not-typable` (a character above `$7E`: a byte of `$80` or more in program
  text would read back as a token), `no-basic`, `not-at-prompt`, `program-too-large`, `unknown-machine`, `empty`,
  `too-large`. Text outside strings is upper-cased, as typing it would be.
  **Its own card, every call.** Because it replaces the program in memory, `load_basic` asks on every call, even
  with "Let Claude use the machine" on: after its program is checked (a load that cannot happen is refused with its
  code and no card), a card in either view says what it loads ("a 20-line BASIC program (lines 10 to 200, 313
  bytes)") with **Load it**, **Don't load** (the code `load-declined`; Stop while the card is up is `stopped`) and,
  only while the switch is on, **Don't ask again this session**, which stops the card for the visit until the
  switch is turned off (`Session.claudeLoadNoAsk`). With the switch off the box is not shown and every load asks.
  Other acting tools keep the one consent question.
  **For automation:** `Session.loadBasic(program)` and the embed API's `loadBasic(program)` do the same load with no
  card and no restore point, through the same implementation (`js/claude/basicload.js`: `planBasic`, `writeBasic`),
  and fail with the same codes.
  The oracle is published documentation, not a ROM (none may be used here): the token tables, crunch rules,
  pointers and line format come from *Color BASIC Unravelled II* (p.7, p.A1, p.B18, pp.B40-B41), *Extended BASIC
  Unravelled II* (pp.B2-B3), *Disk BASIC Unravelled II* (p.B3), *Super Extended BASIC Unravelled II* (p.B9), *Inside
  the Dragon* (Appendices 7 and 8, pp.226-231), *Your Computer* October 1983 (the MC-10's keyword table) and the MCX
  BASIC memory map (the MC-10's pointers). What they leave open is a choice of ours, said in `js/media/basic.js`:
  the MC-10's token values are $80 plus each keyword's place in its published list (single bytes, no $FF prefix);
  its pointers come from MCX BASIC's map, which keeps the stock ROM's direct page (not confirmed for the stock ROM,
  hence the pointer check); its line limit (128) is a conservative guess; the Dragon's `?`, `'` and ELSE rules and
  249-character limit are taken from Color BASIC's; and Super Extended's table is searched before Disk BASIC's so
  that LOCATE is its own token. `node tests/basic-load.test.js` checks hand-built bytes for each family, every
  keyword's round trip, whole-program round trips to the normalised listing, the memory layout and pointers on the
  three families with our own firmware in the BASIC socket, every error, and the consent gate.
  **Not checked automatically:** that a real BASIC lists and runs what `load_basic` wrote. That needs the BASIC
  ROMs, which no test may use; the owner checks it by hand (manual test step 4 below).
* **Which to use.** The tool descriptions and the brief (`TYPING_POLICY` in `js/claude/chat.js`) tell Claude: type a
  program of 3 lines or fewer with `type_text`; for a longer one, ask the person whether to load it with
  `load_basic`, and only after they agree; after either, check with LIST and `screen_text` before saying it worked.
* **The key.** Saved only in this browser, as `cloadm.anthropicKey` (`js/host/key-store.js`); never a Session
  setting, so never in the machine, a snapshot, a share link or a settings export. The field is emptied once it
  is saved; **Forget key** removes it.
* **The API.** The page calls `https://api.anthropic.com/v1/messages` straight from the browser, streamed, with the
  brief (`js/claude/brief.js`) as the system prompt. A cross-origin call needs the request header
  `anthropic-dangerous-direct-browser-access: true`: without it the API answers the CORS preflight with 400 and no
  `Access-Control-Allow-Origin` (measured 2026-11-15: preflight from `https://example.org` asking for
  `content-type,x-api-key,anthropic-version` → 400 with no allow-origin; the same plus that header → 200 with
  `access-control-allow-origin: *`). Anthropic's own TypeScript SDK sends the header when `dangerouslyAllowBrowser`
  is set (`anthropics/anthropic-sdk-typescript`, `src/client.ts`, `buildHeaders`); the API overview page lists no
  such header. **BREAK** (Esc) stops a reply; errors (no key, a refused key, rate limits, network) are said once,
  on the screen and under the key card, and nothing retries in the background.
* **Not yet:** the chat on a real machine over a serial cable (the firmware's DriveWire is the Becker port's; a
  bit-banger DriveWire driver is not written), the CoCo 3's 80-column screen (the CoCo 3 runs the same 256×192
  screen), the `read_program` tool and the "Type this listing into BASIC" button.

**Testing against the real API (manual).** The automatic checks use a mocked Messages API (`tools/browser-check.js`);
a chat with the real one needs a key, so it is done by hand. Chat with the real API: passed, manual test
(2026-11-15, desktop Chrome on macOS). The steps:

1. Serve the repository (the browser check's server, or any static server) and open `/play/?app=claude` in Chrome.
2. Paste an Anthropic API key and click **Save key**: the field empties and the tag reads *saved*.
3. Click the screen, type `Hello, what machine is this?` and press ENTER: *Thinking...*, then a reply in upper and
   lower case that names the Dragon 64; the tag reads *connected*.
4. With BASIC ROMs added, ask `Write a three-line BASIC program that prints HELLO, type it in and RUN it`: the BASIC
   session comes on screen, the program is typed and runs. Click **Restore to before Claude's changes**: the
   program is gone. Then ask for a 20-line program: Claude offers to load it rather than type it; say yes, and it
   lists the program and checks the screen; `LIST` and `RUN` it yourself. Do this on a Dragon, a CoCo (1/2 and 3)
   and an MC-10: this is the only check of `load_basic` against a real BASIC (not automated: no test may use ROMs).
5. Ask for something long and press Esc while it streams: the reply stops with `[stopped]`.
6. Save a wrong key (`sk-ant-wrong`) and send a line: the help line says the key was refused, and nothing retries.
7. ← Emulator, then **Capture & share** → Your settings → **Export settings…**: the file holds no key. Back in the chat,
   **Forget key**.

## LIZA for the 6803 (MC-10, Matra Alice)

The 6803 build is not board-level hardware, so MAME is not its oracle. It is held to the 6809 build: on the MC-10 and
the Alice the scripted conversation, the reply to every line, repeat detection, the scroll at the bottom of the screen
and lines longer than the screen are compared character for character with the 6809 build on the Dragon 64
(`tests/liza6803.test.js`). It calls the MC-10 ROM's documented `POLCAT` (`$F883`) and `CHROUT` (`$F9C6`) entry points,
as the no-ROM stub does, so it runs with or without BASIC.

One thing is deliberate and is not taken from documented hardware: the MC-10's own cursor variable is not an address
this project can verify, so LIZA keeps its own cursor (it clears the block it drew before printing, as the 6809 build
does with the Dragon's ROM variable). Nothing here reads or writes a ROM variable it cannot cite.

The 6803 build is application software, not hardware, so it has no MAME trace comparison. Its one per-machine difference, the title, is pinned by `tests/liza6803.test.js`
(the two images differ in 5 bytes, inside the title) and by `tests/regress.test.js` (the Alice build's trace hash; the
MC-10 build is byte-identical to the pre-split single build, so its hash did not move).

---

See also: [Using CLOADM](using.md) · [Machines](machines.md) · [Architecture](architecture.md)
