# LIZA and Claude

[CLOADM](../README.md) › LIZA and Claude

## LIZA

In 1983 a computer that talked back was a trick. **LIZA**, written for this project, is that trick: ELIZA-style
keyword matching in 3 KB of 6809. It runs with no ROMs: press 1 on the welcome screen, or open
[cloadm.dev/play/?start=liza](https://cloadm.dev/play/?start=liza).

`examples/liza.asm` is LIZA, an ELIZA-style conversation program written for this project in 6809 assembly. It finds
keywords in what you type, swaps pronouns ("my" → "your", "I am" → "you are") and rotates through its replies.
It uses only the ROM's `POLCAT`/`CHROUT` vectors, so it runs with or without the Dragon ROMs. Click **Open LIZA source**,
then **Assemble & run**, and type `BYE` (or press BREAK) to finish; CLEAR clears the screen for a fresh prompt and
keeps the conversation going.

There are two builds holding the same conversation, and the keywords, replies and pronoun swaps live once, in
`examples/liza-data.inc`, which both sources `INCLUDE`. The 6809 build (`examples/liza.asm`) assembles to 3217
bytes of code and data at `$3000`, and the 6803 build (`examples/liza6803.asm`, for the MC-10 and Matra Alice,
in 6803 assembly) to 3556 at `$5000`: its loaded image ends at `$5DE3` and its variables extend to `$5FCE`. It sits
above a 4K machine's RAM, so it needs the 20K option: on a 4K MC-10 or Alice the shelf's LIZA says so, and
choosing it (or opening `play/?start=liza`) offers a one-click switch to 20K above the screen, which restarts the
machine with 20K and starts LIZA.

The 6803 build is one per machine, because its title names the machine it runs on (`LIZA - AN MC-10 THERAPIST` /
`LIZA - AN ALICE THERAPIST`, `examples/liza6803-mc10.bin` and `examples/liza6803-alice.bin`). The two titles are the
same length, so the two images have the same layout and differ only in the name.

## The welcome program

`examples/welcome.asm` is the first program a visitor sees: the eight VDG colours build up as a stripe, then
CLOADM in block letters and a menu. The keys 1 to 4 reach the page through a mailbox byte the Session reads after
every frame (`Session.startWelcome`, events `welcome:liza`, `welcome:demo`, `welcome:roms`, `welcome:claude`);
key 5, "PLAY A GAME", opens the games menu, where 1 and 2 start 2048 and Minesweeper (events `welcome:2048`,
`welcome:minesweeper`) and 0 or BREAK go back. A short original tune plays on the DAC once the browser allows sound. It runs on the 6809-family machines
(the HD6309 included, which runs the 6809 build in emulation mode, and the CoCo 3 in its CoCo 2-compatible text
mode); the MC-10 and Alice get a 6803 version with LIZA's, which has keys 1 to 4 and no games. Option 3 asks for
ROMs only when there are none: on a machine whose ROMs are stored and switched off (`Run without ROMs`, the side
card's third state) it reads "3 USE YOUR ROMS FOR BASIC", from a flag byte the Session sets before the menu draws
(`WELCOME['6809'].romsw`), so the menu never asks for what the machine already has.
Without ROMs every visit opens on it: a returning visitor reads
"WELCOME BACK" and, if something ran last time, option 6 "CARRY ON WITH ..." (option 5 on the 6803 build;
`welcome:carryon`; the Session sets the greeting and the line before the program starts). It offers only what runs
on the machine in use
(`Session.carryOn`): a file on the machine it was loaded on, the colour demo and the games on a 6809-family CPU (the
6309 runs them too), LIZA everywhere. Leaving a program brings the menu back, "BYE FOR NOW.
PICK ANOTHER?": BYE in LIZA, or a key once the colour demo is drawing (the Session watches and emits `menu`).
The watch belongs to the machine the program runs on, and opening or closing the full-screen chat leaves that
machine and its program as they were: BYE in LIZA still brings the menu, Reset still restarts what ran there. While
the chat's own machine is on screen the watch waits, because the menu is a start on the machine in use; it comes
when you are back on the BASIC session (Ctrl+B, **Show my BASIC session** or **← Emulator**).
With ROMs the machine boots them as before; the Media tab's "Last time" runs the last item again, and the
welcome menu is the first entry of "Runs without ROMs".
Without ROMs the machine behaves like a real computer and never leaves you on the stub's bare screen: **Power
cycle**, **Run without ROMs** and **Remove ROMs** turn it on into the welcome menu (`menu` with `'back'`), and
**Reset** restarts what is running from its own entry point (the menu, LIZA, a binary with an exec address), or
brings the menu when nothing is. Switching to a machine without its ROMs turns it on into its menu (the MC-10 and
Alice run their own 6803 build, with the same greetings and its option 5), and a snapshot taken on the stub's bare
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
visible to the emulated machine, snapshots, share links or exported settings. Get a key at console.anthropic.com (API
keys); use is billed to your Anthropic account. Without one, CLOADM can be used inside Claude instead
([Use with Claude](mcp.md#use-with-claude)). What Claude reads from the machine's memory (ROM
areas included) is sent to Anthropic as part of your conversation; CLOADM itself never uploads your ROMs. Coming: the same chat over DriveWire
to a real CoCo or Dragon on Web Serial, and the CoCo 3's 80-column screen.

The API costs are kept down with prompt caching: the tool list and the brief are cached together behind one
breakpoint (they never change during a conversation), and the growing part of the conversation is cached
automatically, so a request pays full price only for what the latest turn added. On a manual run with a real key,
send the same message twice and check `usage.cache_read_input_tokens` in the response: the second request must
report a non-zero count (and `cache_creation_input_tokens` near zero). A zero there across identical requests means
something in the prompt prefix is changing between them.

Two ways to talk to Claude, one conversation:

* **Ask Claude** (`js/ui/ask.js`; a bottom sheet on a phone) is a side panel beside the
  live machine: the header's **Ask Claude** button, **Ctrl+K** (⌘K on a Mac), or one of the example questions under the
  machine (below). It opens at 420 px and its left edge drags it between 320 and 560 px; the drawer's tabs fold into an icon
  rail beside it (an icon opens that tab over the panel, Esc closes it); minimised, a strip at the top of the drawer
  shows what Claude is doing. The panel docks beside the machine and never covers it: the machine narrows, down to
  480 px (the 256-pixel picture at nearly 2×), which needs a window of at least 960 px (from 960 to 1100 px there is
  no rail, and the drawer stays below the machine). Narrower than 960 px the panel lies over the page instead, as
  docking would leave the machine too small to use; on a phone it is a bottom sheet with peek, half
  and full heights (the restore points and the switch are in its ⋯ menu), and it moves up above the phone's own
  keyboard while you type (the visual viewport).
  Three example questions for what is on the machine now (`js/claude/prompts.js`) sit under the machine while the
  panel is closed and in its empty chat while it is open, never in both: the
  Debugger's stop, a visit that just arrived from a link (until your first key, message, load, Reset, Start over or
  switch), WYRMFIRE, the welcome menu (one set without ROMs for the machine, another with them), LIZA, 2048,
  Minesweeper, the colour demo, a machine-code program of yours, BASIC at its prompt with a program or without one,
  BASIC running a program, and a general set for anything else, in that order of priority. They come from the
  Session's and the machine's state (BASIC's program pointers and its current line number, CURLIN, on the Dragon and
  CoCo), never from the picture, and nothing is sent to a model to make them. With a key a tap puts the question in
  the message box (one under the machine opens the panel first) and sends nothing. Without one they sit under "You
  could ask, once Claude is connected:" (under the machine it is their first line); a tap selects one (opening the
  panel with it) and offers **I have an API key** (the question fills the box once the key is saved) and **I use
  Claude →** (the question is copied). They follow the machine half a second after it changes while the chat and the
  box are empty, stay put while the box has text, a finger is down or a question is selected, and go after the first
  message. With Claude features Off there are none.
* **Ctrl+K** opens "Ask Claude or find a command" (`js/ui/command-box.js`): the page's commands that match what you
  type come first (each presses the page's own button and is never sent to Claude), **Ask Claude: "…"** is always
  last. Enter runs the command or asks (a question ending in "?" puts **Ask Claude** first, so "reset?" asks rather than resets, unless it is a command's whole label); asking opens the side panel beside the
  machine, whatever is on it (the welcome menu, a game, LIZA). Only **Chat with Claude, full screen** and the welcome
  menu's chat item open the full-screen chat.
* **Inside another site** (`js/ui/ask-popout.js`) there is no chat: CLOADM framed in someone else's page would put
  the key card on their page. The app bar's Ask button reads **Ask Claude ↗** instead, in the same place (beside
  Menu on a phone), and is a link that opens CLOADM top-level in a new tab with `target=_blank` and
  `rel="noopener noreferrer"`: the moment as the Share screen's link carries it (the snapshot in the fragment) with
  `app=claude`, and never `embed=1` (`Session.claudeLink`). The new tab reads the key saved in your browser, and the
  framing page has no handle on it. Its tooltip says "Opens CLOADM in a new tab with this machine as it is now.
  Claude can't run inside another site." Where the moment can't be carried (NitrOS-9 running, as the Share screen
  detects) the link opens a fresh CLOADM on the same machine with `app=claude`, and says "Opens a fresh CLOADM in a
  new tab (this program can't be carried over)." A screen-only embed (`embed=1`) offers nothing unless its snippet
  asks for the corner chip with `askclaude=1` ([using.md](using.md#links-and-embedding)). The new tab never starts a
  turn: `app=claude` opens the chat and waits for you to type.
* **A card's first half second** (`js/ui/arm-guard.js`). The consent card's **Allow**, the key cards' **Save key**
  and **Forget**, and **Let Claude use the emulator** take no press until their card has been on screen for 500 ms,
  so a click or key meant for whatever was there a moment before can't answer them. The window starts when the card
  shows (again when it is shown again) and when the page comes back (`pageshow`, and `visibilitychange` to visible);
  window focus doesn't restart it, and nothing but the time arms it, so a tap at 600 ms works. Meanwhile the
  controls are `aria-disabled` (a press does nothing and leaves the focus on them, so a second press works), the card
  fades in over about 300 ms, and at 500 ms the controls take presses with no change in how they look; the card is
  then announced to screen readers by its purpose ("Claude settings ready."), once per showing. A click, a tap, Enter or Space and a label's click are all held to the same rule.
* **Consent.** Claude can always read the emulated machine (screen text, memory, model and program counter), and nothing outside the emulator; the panel names what it reads. What it reads goes to Anthropic with the conversation, using your key. That includes the machine's memory, so ROM areas Claude peeks at or disassembles are sent too; CLOADM itself never uploads your ROMs, and never puts them in share links or exported settings. Acting
  (POKE, typing, BREAK) needs **Let Claude use the emulator**, off until you allow it: the first time Claude wants to
  act it asks in the conversation (**Allow**, which turns the switch on for the visit, or **Just tell me the fix**,
  which Claude is told as `consent-declined` and which changes nothing; Stop while it asks is `stopped`). While Claude acts the screen has a pulsing green ring and
  "Claude is typing line 120… **Stop**" at its top, and each thing it does appears as a small line under the turn (see
  **What Claude did** below). A key you press on the machine
  pauses Claude: what it still had to type is held back and its next action waits, until **Resume** (or **Stop**).
  That includes an action still waiting at its gate: a key while a card asks pauses Claude too, and so does a key
  while the action's own check runs (an `INCLUDE` read), before anything is written; Stop refuses it with nothing
  changed and no restore point. A card that waits while Claude is paused says so ("Paused because you pressed a
  key…") and its accept button reads **Allow and resume** (**Load and resume** on the load card): one click gives
  consent and resumes (`Session.consent.answer(true, { resume: true })`, one synchronous step; the card says "Allow and
  resume lets Claude go on and act on the machine for the rest of this session" / "Load and resume loads the program
  and lets Claude go on"; the page passes what the
  button said when it was drawn, never the pause at click time, so a key pressed just before a click on plain
  **Allow** is not resumed unseen). The decline button is unchanged and never resumes: the pause stays until
  Resume, Stop or the turn's end. A Resume with no card answered works as before, and the button goes back to
  **Allow**. Turning "Let Claude use the emulator" off while Claude is paused withdraws consent for everything the
  pause holds: on Resume the action waiting on it is refused (`no-consent`), whatever consent it relied on, even a
  card answered for it, and typing it held back is dropped, not typed (the `type_text` call fails `no-consent`), as
  Stop drops it. The refusal belongs to that pause: with the switch back on, the next action (in the same turn or
  the next) goes on as usual. Turning the switch on while paused gives consent only and does not resume. Paused at a card that you then decline, the pause lasts the rest of the turn
  while Claude only writes its reply: the page does not show Claude as acting, and its next acting call still waits
  for Resume. Every paused state has the one status "Paused: you pressed a key · Claude's next action waits · Esc
  stops Claude" (`CLAUDE_PAUSED_TEXT`); the browser Fullscreen's one-line pill shortens it to "Paused: you pressed a
  key · Esc stops Claude". **Esc** while paused with a card up is Stop (the card is answered `stopped`);
  a menu or a confirmation open over it closes first. The page's own leave of the browser's Fullscreen for a card is
  not taken for the person's Esc, even when a key pauses Claude before the browser reports it.
  Every way your input reaches the machine Claude is using counts as such a key (`Session.personInput`): a key on
  the screen or with the focus on the page itself (Shift too, and Ctrl or Alt on a machine that has them: the CoCo
  3; a modifier held then a key is one press, so Shift+Esc is BREAK), an on-screen key, a paste, the type-in panel, a tap on the
  welcome menu, a POKE from the book, an edit in the Debugger (a byte set, a register or a flag), the embed API's
  `typeText`, `poke`, `loadBasic`, `load` and `insertTape`, and a joystick in your hand: a gamepad, the mouse as
  joystick, or the on-screen touch stick and its FIRE, on a fire press or a push out of the dead zone (one hook,
  `HostInput.player`, sources `pad0`, `pad1`, `mouse` and `touch`: each source keeps its own state, a pad resting with noise inside the dead zone is nothing, and a push
  counts once until the stick is back below 0.8 of the dead zone, so jitter at its edge is not a new push). Only Claude's own typing is Claude's, so
  what the program then asks for (the welcome menu's choices) is yours. The page views (Share, the Library, Add
  ROMs, the Debugger) hide the emulator and the panel: while a turn is in progress, or Claude's typing is still
  going in, they show Claude's status at the bottom of the window with **Stop**, **Resume** while paused and
  **Answer** while a card waits (it goes back to the emulator, where the card is); a card that comes up while a
  view is open closes the view, so it is seen. The same status shows, over the screen, in any layout where no
  other Stop can be clicked (a phone held sideways with its touch keyboard and the panel closed or minimised: the
  drawer's strip is hidden there), and the touch keyboard steps aside while a card waits (held sideways it covers the
  page). A page view closes the rail's tab. With a drawer tab open from the Ask panel's rail, the first Esc closes the tab (as a menu, on the
  screen too, so it is not also BREAK), during a pause too; the next stops Claude.
  A pause belongs to its turn: a key pressed outside a turn pauses nothing, and when the turn ends (finished, failed
  or stopped) the pause ends with it, what it held back is never typed, and the next turn does not start paused.
  While paused the status reads "Paused: you pressed a key · Claude's next action waits · Esc stops Claude" (the one
  paused text, above): **Esc** stops Claude in every view
  (the side panel at any width, the phone sheet, minimised, the full-screen chat in its chat and BASIC views, a
  phone held sideways with its keyboard). It is Stop only: it does not also send BREAK to BASIC. A confirmation,
  a menu or a card open during the pause takes the first Esc (the page's usual order); the next stops Claude.
  When Claude is not paused, Esc is as before (BREAK on the BASIC screen, which pauses Claude like any key). In the
  browser's **Fullscreen** the screen itself shows Claude's status with Stop (and Resume while paused); the browser
  takes Esc there to leave Fullscreen, so leaving it while paused stops Claude, and a card waiting for your answer
  ends Fullscreen so it can be answered. A **Reset** or a **power cycle** of the machine Claude acts on, while Claude
  acts or is paused, stops Claude first ("[stopped: you reset the machine]" in the conversation); so does any other
  restart of that machine (a program or cartridge that starts, the welcome menu, LIZA, ROMs cleared: the machine's
  `onReset`), and any program you load or run on it (with ROMs a program starts without a reset). A Reset of the full-screen chat's own screen leaves Claude's work on the BASIC session alone: Reset restarts what
  is on screen (the chat firmware, which comes back running), while **Power** switches off and on the machine you
  are working on - your BASIC session - and leaves the chat's screen alone. A
  snapshot load or a machine switch replaces the machine and closes the conversation. An Esc held down is one
  press: its autorepeat does not stop Claude, whatever modifier (Shift, AltGr, Caps Lock…) is pressed meanwhile; an
  Esc that only closes a card or a confirmation above the screen is not a key on the machine and pauses nothing.
  The note names the cause: "you reset the machine", "you power cycled the machine" (the buttons), "you loaded a
  program", "you started a program" or "the machine restarted" (ROMs added, Run without ROMs and the like).
  What the program on the machine asks for itself (the welcome menu's choices, the menu coming back after LIZA's
  BYE or the colour demo: `Session.asMachine`) was asked by keys typed into the machine: Claude's own while it acts,
  so its turn goes on. Whose keys they were is decided when the program asks (`Session.machineTicket`): Claude's
  only if Claude was acting and not paused then, and the same turn went on with no pause until the start; else
  they were yours (a key pressed while Claude paused, or only thought), and Claude stops. Only the start itself is exempt
  (asMachine is synchronous; the page fetches the bytes first), so what you do while they are fetched still stops
  Claude. In every case a later Resume types nothing and runs nothing.
  `node tests/claude-turn-scope.test.js` (its Esc-while-paused cases) and the browser check's `askEscChecks` cover these.
* **The turn's status.** While a turn is in progress every view shows what it is doing, with **Stop** beside it
  (`Session.claudeStatus`): *Thinking…* while the reply comes (the model thinking, or streaming text or a long tool
  call that shows no text yet), *Using <tool>…* while a tool runs, *Waiting for your OK* while a card asks (or,
  while Claude is paused with the card up, the pause's own status, with Resume; on a page view Answer stays next to
  it) (the card is scrolled into view; on a phone the sheet leaves peek for it). It sits above the message box in the side
  panel and the phone sheet (in the sheet's peek line, with its own Stop, when it is lowered; the minimised strip
  has a Stop too), and in the bar of the full-screen chat. Stop ends the whole turn: another tool call in the same
  reply is neither asked about nor run.
  A turn that fails (HTTP, network, an error event in the stream, an exception in the tool loop) ends with its
  message in the conversation and the box usable again. A stream that sends nothing for 60 s (`STALL_MS`,
  `js/claude/backend.js`) is aborted and the turn ends with "Claude stopped answering": a working stream is not that
  quiet (thinking streams as deltas and the API sends pings while it works), and a minute is about as long as a
  person waits before deciding something is wrong. The timer runs only while a request is out, never while a tool
  runs or a card waits. `node tests/claude-turn-status.test.js` and `tools/browser-check.js` (`askStatusChecks`:
  side panel and full screen at 1440 x 900 and 390 x 844, with a mocked fetch whose streams can be slow, stall or
  fail) check every state, Stop in each, and every failure.
  Stop also ends `assemble_and_load` while it reads an `INCLUDE` file: the page's reader
  (`js/host/example-reader.js`) passes the turn's signal to `fetch` and gives up after 15 s
  (`INCLUDE_TIMEOUT_MS`), when the tool fails with `include-unreadable` and the turn goes on (one read times out,
  the rest are not waited for). A reply with no text is never kept as an empty message: a turn of tool calls only is
  kept as a note of the tools it used (for the model only: the views do not show it), and a refusal or a reply of nothing with no tool calls drops the question (the panel shows it
  with "Claude declined to answer this one." or "Claude gave no reply."), so it is not sent again inside every later
  question. Every request goes through
  `apiMessages` (`js/claude/history.js`): no empty assistant message, no blank text block, every `tool_use` with
  its `tool_result`, so no turn can leave a history that makes every later request fail.
  **What a turn leaves in the history.** A turn is recorded whole: the person's line, each tool round as the API saw
  it (the `tool_use` with its input, the `tool_result` exactly as sent) and the reply's last text, checked by
  `wholeTurn` (`js/claude/history.js`, the same pairing and validation as `apiMessages`). A reply that says "I typed
  DIR" carries its evidence into every later request; with the text alone (as before), Claude found its own claims
  and nothing behind them, and retracted them. A turn that fails after a tool result came back (Stop, a network
  error, a stall, a refused request) keeps its completed rounds (the backend hands them back as `e.partial`) and ends
  with the page's note "(Note from the page: this turn ended with `<code>` after these tool results.)"; a turn that
  fails before any tool result is dropped, as before. The oldest turns go first when the history nears 64 KiB, whole
  (`ChatSession.trim`), so a `tool_use` never loses its `tool_result`. The views show only the conversation's text
  (`transcript`): the line and the reply as it streamed, never a tool round or a note, and a failed turn as before
  (the panel shows the failed line itself). The history holds only what the tools read from the emulated machine:
  the key is in no tool result, as it is in no machine memory. `node tests/claude-history.test.js` covers this.
  `node tests/claude-turn-scope.test.js` checks these with a mocked API that refuses what the Messages API refuses
  (400), and `askFollowupChecks` in the browser check covers Stop during a hanging `INCLUDE` and the pause ending
  with its turn.
* **What is this code doing?** in the Ctrl+K box asks about the code at the program counter: the disassembly and
  the registers go with the question (`Session.codeAt`), and the panel says Claude can read the code and the
  registers. A restore point is made before
  Claude's first change in each turn. **The restore line** (`js/ui/claude-lines.js`): one small, muted
  line under the latest turn that changed the machine, "↶ Restore to 23:58 · Restore points…", in the side panel,
  the phone sheet and the full-screen chat's card alike. The first button restores the newest point (its label for
  screen readers: "Restore the machine to 23:58, before Claude's last changes"; never "Undo"); **Restore points…** is
  a disclosure with every point (the last 10) and the note "Restore points are kept only while this chat is open, and
  only the last 10: reloading the page, ending the chat or switching machine loses them. Restoring also undoes your
  own typing since that point. Saved files (Library, DriveWire) are not rolled back, except a disk left in its drive
  since the point." While a turn runs the line reads "Restore point at 23:58 · Stop first to restore", its button
  disabled. Each point records the turn it was taken in (`Session.claudePoints[].turn`), so after a restore the line
  moves to the previous point's turn, or goes when none is left.
  **What Claude did** (`js/claude/actions.js`): under each turn's reply, one small, muted line per
  acting call, in order, made from what the call returned or threw, never guessed: "✓ typed "DIR"", "✓ typed 3
  lines", "✓ pressed BREAK", "✓ poked 3 bytes at $0400", "✓ loaded a 12-line BASIC program", "✓ assembled and loaded
  128 bytes at $3000", "✓ ran RUN", "✓ started $3000"; partly done "✓ loaded 120 of 128 bytes at $3000 (8 not
  taken)", "✓ poked 2 of 3 bytes at $0400"; not done "– didn't type "DIR": you said no", "– stopped before typing
  "DIR"", "– stopped while typing "DIR"" (the `stopped` error's delivered count tells the two apart); keys not read
  "– typed "DIR", but the machine didn't read the keys" (`not-consumed`); an error "✗ couldn't type "DIR": …" with
  the line a person reads for it (`failureText`). The glyphs are hidden from screen readers. The records stay with
  their turn (`ChatSession.noteAction`; never sent to the API). After a restore, the lines it took back (the calls
  that changed something) end " · undone at 00:02". A turn of more than 3 acting calls folds its plain ✓ lines into
  one button, "7 actions · read the screen 2× ▸" (`aria-expanded`); partial, – and ✗ lines always stay, and the
  summary never starts with ✓. A read that worked is never a line of its own, but reads are never invisible: they are
  counted in that summary, or, when nothing folds, on a plain muted line (text, not a button) such as "read the
  screen 2×, memory 1×". A read that failed is a ✗ line: "✗ couldn't read memory: …". When the machine resets under
  Claude's typing (a key of Claude's starting a program that resets it), the call ends `machine-restarted`, not
  `stopped` (it is not a Stop; the restart may still come from a key the person pressed): "– typed "1", then the machine restarted"; a job whose keys were all read
  first ends done (`Typist.clear(why)`, called by `Machine.reset`). The page's note on a failed turn carries the
  reason the page stopped it: "(Note from the page: this turn ended with aborted (you reset the machine) after these
  tool results.)". The side panel's conversation is a
  live region whose rows are appended, never all replaced. In the full-screen chat the latest turn's lines sit in its
  card beside the restore line, and are never printed on the chat screen itself (its frames are the chat firmware's).
  `node tests/claude-actions.test.js` covers the records and the copy; the browser check's `ask` and `claude` groups
  cover the lines in the three views. Saved files (the Library, DriveWire) are not rolled back, except a disk that has stayed in
  the same drive since the point (`DiskDrives.restorePoint`, also behind the chat's undo): if the machine wrote to it
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
  Back leaves the chat (opening it adds one history step), and so does Esc from the chat bar or its cards. On the
  screen Esc escalates: it is BREAK while a reply streams (it stops the reply) or while a line is typed (the firmware
  drops it), and on an empty, idle prompt it leaves the chat like **← Emulator** (the focus pill reads "Esc stops a
  reply, clears the line, then leaves the chat"; the page reads the firmware's `BLEN` and `WAIT` bytes to tell).
  `tools/browser-check.js` (`phoneChatChecks`) checks all of it at 390 x 844 and 844 x 390, including a line typed
  on the on-screen keys and the mocked reply drawn on the screen.

* **Two machines.** `Session.startChat` keeps the machine in use as your BASIC session and runs the chat firmware
  (`examples/chat.asm`) on a second machine of the same model, on the built-in stub (no ROM needed), which goes on
  screen and gets the keyboard. Both machines run, the one off screen in the picture-in-picture, so Claude's typing
  goes in while you watch the chat. The chat needs a 6809-family CPU (the 6309 runs the firmware unchanged) and
  32K or more: the firmware uses $0400-$7FFF. On a machine with less (a CoCo with 4K or 16K) the chat is
  refused, saying so ("The chat needs 32K of memory or more"): give it 32K or more, or use a Dragon 32 or 64; the chat opens on a Dragon 64 from an MC-10 or Alice.
  A file dropped while the chat is full screen (a program, a tape, a cartridge, a disk or a ROM) goes to your BASIC
  session, never the chat machine: the chat machine runs the chat firmware, and a load there would overwrite it and
  take the chat screen away. The message says where it went, and the drives card shows the BASIC session's drives. A
  ROM is stored for its model either way, so a ROM dropped here sets up the same model's BASIC session; the chat
  machine keeps running its firmware and takes the stored ROMs when you go back to BASIC. The POKE book, Remove ROMs,
  Save snapshot, Skip on the cassette and the welcome menu are the BASIC session's too.
* **Typing.** A line can be up to 1024 characters. It wraps as you type the way replies wrap: a word that doesn't fit
  moves to the next line, a word with no space in it breaks at the character, and a space that falls at the end of a
  full line ends it without being drawn. A line longer than the screen scrolls it as you type; BACKSPACE goes back
  across the wraps, and a row that has scrolled off the top comes back as you reach it. A key past the 1024th is
  refused visibly, never dropped without notice: the row under the line says "[Full: 1024 characters. ENTER sends
  it.]" (BACKSPACE, ENTER or BREAK takes it away) and the screen flashes (the VDG's colour set switches from green to
  buff for about a tenth of a second).
  You can type ahead: keys typed while a reply is still coming (or while Claude uses its tools, or a card waits) are
  kept and typed at the prompt once the reply has ended, so a line typed then is sent whole. BREAK (Esc) while a reply
  comes only stops the reply; it is not kept for the next line.
* **The screen.** 256×192 two-colour graphics (VDG GM7, SAM mode 6 at `$0400`, the SAM's memory size set to 64K as
  BASIC sets it), 42 columns by 24 rows with this project's own 6×8 font. Typed lower case reaches the firmware as
  typed (the stub hands every other program upper case, as BASIC's keyboard does).
* **The bytes.** A line goes to Claude when you press ENTER. The firmware carries the bytes one of two ways, chosen
  at start. On a CoCo with the Becker port on (`?becker=true`, Machine settings) it finds the DriveWire server
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
  `is_error:true`. `peek` returns at most 256 bytes, as hex rows of 16 with their address (`"$0400: 4C 49 …"`), and
  says `truncated` when it cut a request short; a read whose
  bytes would run past `$FFFF` is a `past-end` error, because reads do not wrap. `disassemble` decodes up to 64
  instructions in the machine's own instruction set (6809, 6803 or 6309, taken from the machine, never from the
  request) through the same side-effect-free peek, and returns each instruction's bytes (in hex, `"31 3F"`) with its text. Both read whatever the machine has mapped at the
  address, ROM areas included, and what they return is sent to Anthropic as part of your conversation, like everything else Claude reads. CLOADM
  itself never uploads your ROMs, and never puts them in share links or exported settings.
  `screen_text` returns the screen's rows as text, trailing spaces trimmed and trailing blank rows left out. The
  page's other readers of the screen (the embed API's `screenText`, the Ask panel, the tape panel, the boot
  watchdog, the screen canvas's text alternative) use the same reader, `Session.screenText`, which gives every row
  at its full width. It reads three kinds of text screen:
  * **the MC6847 VDG's 32x16 page** (MC-10, Dragon 32/64/200, CoCo 1/2, and the CoCo 3 in its CoCo-compatible
    mode), from the page the display uses, read where the VDG fetches it, never through the CPU's map. On the Dragon
    32/64/200 and CoCo 1/2 the page starts at the SAM's display offset (F6-F0 x 512, `$FFC6`-`$FFD3`; BASIC's `$0400`
    is F = 2), wrapped by the SAM's video counter size (M1-M0), so a page a program has moved is read where it is
    and `base` names it; on the Dragon 64 Plus the VDG fetches the motherboard RAM whatever `$FFE2` pages in for the CPU, so `base` (`$0400`) is given
    only while the CPU reads the same 512 bytes there (all of them, every row), otherwise `null`. On a CoCo 3 that page is the GIME's own video base (the SAM's page bits
    and `$FF9D`), a physical address, and it is read there, in physical RAM, as the display reads it: a page the MMU
    shows the CPU somewhere else, or nowhere (or a slot routed to ROM), is still the page on screen. `physicalBase`
    is that address and `base` the CPU address that shows the whole page under the current map, or `null` when no
    slot does. Cells whose bit 7 is set are semigraphics blocks: they read as spaces and `semigraphics` counts them,
    with a `note`, so a picture of blocks is not mistaken for an empty screen - except the cursor's own block, the cell
    the machine's cursor variable names (`textCursor`: BASIC's `$0088`-`$0089` on the 6809 families, the built-in
    firmware's console position on the MC-10), which is left out; a screen whose only block is the cursor has no note.
    The cursor's cell is left out by its address, not by what it shows: a picture block sitting exactly at the cursor's
    address with no cursor drawn there is not counted either.
    In compatibility mode the GIME sets the lines each text row takes from `$FF9C` (BASIC's `$0F` is 12;
    `$03` is 8, `$0A` is 1), so the screen can show more or fewer than 16 rows - 24 at 8 lines a row on a 192-line
    body, 17 or 19 at 12 lines on a 200- or 225-line one, the last row cut short. The reader walks that screen the
    way the display does (`GIME.legacyTextScreen()`: ceil(body lines / lines a row) rows, `$FF9C`'s lines a row), so
    a program's `$FF9C` is followed rather than assumed, and `screenRows` gives the count.
  * **every CoCo 3 GIME text mode** (6809 or 6309): 32, 40, 64 or 80 columns, with or without attribute bytes, as
    NitrOS-9 and BASIC's `WIDTH 40`/`WIDTH 80` use. The GIME walks the screen itself (`GIME.textScreen()` in
    `js/chips/gime.js`, beside the renderer it follows): the video start (`$FF9B`/`$FF9D`/`$FF9E`), the row pitch
    (doubled by attributes, 256 bytes with `$FF9F` HVEN), the horizontal offset (`$FF9F`, wrapping within a row's
    256 bytes), the lines per row (`$FF98`) and the number of rows the body shows (`$FF99`: 192, 200 or 225 lines;
    a last row cut short is included). All of it comes from the emulator's GIME state, never from the CPU-readable
    registers, which a program cannot read back; the page is read from physical RAM, so no MMU mapping can hide
    it. The result names the mode with its columns and rows (`GIME native text, 80 columns with attributes, 24
    rows`) and gives `screenRows` (the rows the screen shows; `rows`, as on the VDG, counts the rows returned,
    after trailing blank rows are left out), `physicalBase` (the physical address) and `base`: the CPU address of
    the whole screen, given only when the memory map shows every byte the GIME reads for it to the CPU in one
    contiguous run (each 8K slot the screen crosses into holding the next physical block), otherwise `null` (an
    MMU that splits or hides it, or 256-byte virtual rows, where the screen is a window on a wider page). Characters `$20`-`$7E` are ASCII; the GIME's international characters
    `$00`-`$1F` come back as the Unicode letters they show (`Ç ü é â ä à å ç ê ë è ï î ß Ä Å ó æ Æ ô ö ø û ù Ø Ö Ü
    § £ ± ° ƒ`) and `$7F` (a checkerboard) as `▒`; bit 7 is ignored, as the GIME's font ignores it. Attribute
    bytes are never shown as characters: `attributes` gives each row's runs of equal attributes (`from`, `to`,
    `fg`, `bg`, `underline`, `blink`), where `fg` and `bg` are palette slots 0-7, not colours: the foreground is
    palette register 8+`fg`, the background palette register `bg`. The vertical fine scroll register `$FF9C`
    (VSC) moves the text up by VSC scanlines when VSC is less than the rows' height (8, 9, 10 or 11 lines), as on
    real hardware: the first row then shows only its lower part, and the next row of the buffer comes in at the
    bottom, so the reader counts it too (`screenRows` 25 instead of 24 on a 192-line screen of 8-line rows), and reads
    every row whole, as it stands in memory. A write to `$FF9C` takes effect at the next field's start, for the
    picture and the reader alike. MAME 0.264 does not scroll (the machine's `mameCompat` option, for the
    MAME comparisons, reproduces that, and the reader follows it there).
  * **the Dragon 64 Plus's 80-column screen** (its Hitachi HD6845S), while the Display tab shows it. The board has
    no register that picks a screen (MAME shows both, as two screens): the screen read is the one the page shows,
    and on the main screen the VDG page is read as on a Dragon 64. The machine walks the board's own screen
    (`D64PlusMachine.textScreen()` in `js/machines/d64plus.js`, the same row walk the picture is drawn from): row
    *r* starts at the address `R12/R13 + r x R1` (fourteen bits) and holds R1 codes, R6 rows are shown, and the
    2K video RAM decodes the address's low 11 bits, so a screen wraps round it and a start above `$07FF` mirrors.
    It reads the registers and the video RAM as they stand, which is what the next frame draws (the board's picture
    is drawn whole at each CRTC frame start, as MAME draws it, so a register written mid-frame shows from the next
    frame). It works from the codes, not from glyph pixels, so no character generator is needed; without one the
    picture is blank and the answer's `note` says so. The result is named `HD6845S text (the Dragon Plus), 80
    columns, 22 rows`, with `screenRows` (R6), `startAddress` (R12/R13) and `base`: the CPU address of the screen
    only while `$FFE2` bit 0 maps the video RAM over `$0000-$07FF`, the SAM leaves that window in place and the
    screen does not wrap (never under `mameCompat`, where MAME 0.264 does not map it), otherwise `null`. The
    cursor (R14/R15, R10/R11) is not reported: `screen_text` has no cursor field on any machine.

    **The character mapping.** Codes `$20`-`$7E` are read as ASCII. Sources: P. Mooney (Serenarian), "Appendix A:
    The DragonPlus Character Set", his IC22 EPROM dump transcribed from a 1986 programmer printout (World of Dragon
    forum, 25 March 2018, `archive.worldofdragon.org/phpBB3/viewtopic.php?p=16452`), and the Dragon Archive's
    Compusense character ROM dump. Both put `A` at EPROM offset `$0410` and `a` at `$0610`: code c's glyph is at
    c x 16. `$00`-`$1F` hold other visible symbols (accented letters, the pound sign and so on), `$7F` is a solid
    block and `$80`-`$FF` are mostly underlined forms of `$00`-`$7F`; the reader gives no character for a code
    outside `$20`-`$7E`, because those symbols and the underlining are not mapped here: such a cell reads as a space
    and `unknown` counts them, with a `note` (as the VDG's semigraphics blocks are counted), so the rest of the
    screen is still read and a screen of them is not taken for an empty one. Which half of the generator is used: P. Harvey-Smith's
    Eagle schematic, traced from his own DragonPlus board (World of Dragon forum, 7 June 2017,
    `viewtopic.php?p=15826`), has EPROM A0-A3 on the 6845's RA0-RA3, A4-A10 on character bits 0-6, A11 on character
    bit 7 (through the latch/jumper path) and A12 on a font-select jumper; no 6845 output drives A11 or A12.
    That wiring is from a traced schematic with known drawing errors; not verified on hardware.
    Compusense's notes (p. 4) say only the first set is used, and the archived ROM's upper 4K is all `$FF`. The
    character generator itself is the user's ROM and is never needed, read or stored.

    It DECLINES, rather than guess, a set-up the board cannot show whole, checked on the CRTC's registers in this
    order: R8 bit 0 selecting an interlace mode (not modelled; Compusense's own `$A2` is non-interlace and read);
    R8 bits 5-4 = 11, the HD6845S's display skew "non-output", which blanks the screen;
    R1 or R6 0 (no characters); R1 not less than R0 + 1 or R6 not less than R4 + 1 (the MC6845 data sheet's
    Nhd < Nht and Nvd < Nvt); more than 80 columns or rows taller than the board's 264-line picture (MAME's
    `plus_screen`, 640 x 264); fewer than 10 raster lines a row (the board's characters are a 7 x 9 matrix below a
    blank row, Compusense's notes p. 4, so a shorter row cuts them). The CRTC's
    power-on registers (8 lines a row) are declined that way until a program sets the board up; Compusense's own
    set-up (p. 4: 80 x 24 rows of 11 lines) is read.

    The R8 decline is sourced from Hitachi, "HD6845S, HD68A45S, HD68B45S" data sheet, Interlace and Skew
    Register (R8), Tables 4-6, PDF p. 11 (the printed page numbers are cropped in the archived scan). Bits 1-0 are 00 and 10
    non-interlace, 01 interlace sync and 11 interlace sync and video. Bits 5-4 (display skew) and 7-6 (cursor skew)
    are 00 none, 01 one character, 10 two characters and 11 non-output. A skew of 1 or 2 characters only moves the
    picture, so it is read. Neither our renderer nor MAME 0.264 models skew, so the 80-column picture is not moved
    or blanked by it here.

  The tool DECLINES, with `text:false`, the mode named and a reason, anything it cannot read faithfully: a
  graphics mode (VDG or GIME bitmap), a GIME text mode whose rows are 1 or 2 lines tall (no glyph is shown whole)
  or that shows no rows (`$FF99` lines per field 2), and an 80-column Dragon 64 Plus set-up or code it cannot read
  (above) - rather than returning rows
  that are garbage or belong to a screen nobody is looking at. `machine_info`'s `video.readable` is that same
  answer from the same rule in the same module, so a model can skip `screen_text` when it cannot help; `kind`
  stays `text` when a text mode merely goes unread. On such a screen `atPrompt` is
  `null` ("cannot be told"), not inferred from a page that is not visible. Before
  Claude's first change in a turn the BASIC session is snapshotted, by every acting tool through the one path
  (`ChatSession.withRestorePoint`); **↶ Restore to …** on the restore line restores it exactly (the last 10 points are
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
  memory, replacing the program there, as a load from tape or disk would (`js/media/basic.js`, `planBasic`
  and `writeBasic` in `js/claude/basicload.js`). Lines are crunched as Color BASIC crunches them (the keyword tables
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
  with "Let Claude use the emulator" on: after its program is checked (a load that cannot happen is refused with its
  code and no card), a card in either view says what it loads ("a 20-line BASIC program (lines 10 to 200, 313
  bytes)") with **Load it**, **Don't load** (the code `load-declined`; Stop while the card is up is `stopped`) and,
  only while the switch is on, **Don't ask again this session**, which stops the card for the visit until the
  switch is turned off (`Session.consent.loadNoAsk`). With the switch off the box is not shown and every load asks.
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
  ROMs, which no test may use; a maintainer checks it by hand (manual test step 4 below).
* **Which to use.** The tool descriptions and the brief (`TYPING_POLICY` in `js/claude/chat.js`) tell Claude: type a
  program of 3 lines or fewer with `type_text`; for a longer one, call `load_basic` without asking in prose first
  (its card is the question: nothing loads unless the person agrees there); after either, check with LIST and
  `screen_text` before saying it worked.
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
  such header. **BREAK** (Esc on the chat screen) stops a reply, and Esc on an empty, idle prompt leaves the chat; errors (no key, a refused key, rate limits, network) are said once,
  on the screen and under the key card, and nothing retries in the background.
* **The acting tools' contract.** Every acting tool runs one way (`ChatSession.runTool`, `js/claude/chat.js`):
  the consent gate (`ChatSession.gate`; the Session sets it in `gateTools`), then the tool's own checks, which only
  read, then the pre-act re-check, then the change inside the turn's restore point (`ChatSession.withRestorePoint`).
  A `ChatSession` built without a gate refuses every acting tool (`no-consent`). The pre-act re-check
  (`ChatSession.recheck`, set in `gateTools`) runs synchronously with the change, after any wait for a card or an
  async check (an INCLUDE read): a stopped turn is `stopped`; Claude paused waits for Resume, as the gate's own pause
  wait does (Resume goes on and the re-check runs again; Stop, or Esc/BREAK while paused, is `stopped`), so nothing
  changes while paused; and consent is re-validated. The pause is the Ask panel's turn-scoped one (`Session.personInput`,
  `pauseClaude`, `resumeClaude`, `endClaudePause`): the gate and the re-check wait on it (`Consent.wait`), and the turn's
  end or abort ends it (`endClaudePause`, from the chat's `onTurnEnd` and `onAbort` hooks; `onAbort` runs before the
  request is aborted), which refuses the waiting call. The Session wires a chat only through these hooks, set in
  `gateTools` (`gate`, `recheck`, `onAbort`, `onTurnEnd`, `onRestorePoint`, and `onToolStart` / `onToolEnd`, which
  bracket every tool call the backend makes for the turn's status); it never replaces a chat's methods
  (`node tests/chat-hooks.test.js`). The consent itself (the switch, the cards, "Don't ask again", the pause's
  state) lives in `Session.consent` (`js/claude/consent.js`): `decide` is the gate's decision, `recheck` the
  re-check's, `setAllowed` the switch, `answer` a card's answer; the Session's `pauseClaude`, `resumeClaude` and
  `endClaudePause` do the machine side of a pause and call its `pause`, `resume` and `endPause`. None of it is saved
  in a snapshot or a settings export (`node tests/claude-consent.test.js`). An acting call counts as Claude acting from
  its gate to its act (`Session.claudeCall`), so the person's input pauses it there even before Claude's first change
  of the turn; `node tests/claude-ask-acting.test.js` covers the two together. Each call records the consent it relied on: **the card** when
  the person answered a card for this call (Allow on the consent card, or Load it on `load_basic`'s card), which
  holds for that call even if the switch is turned off before the change lands; **the switch** otherwise (the
  "Let Claude use the emulator" switch already on, and for `load_basic` also "Don't ask again this session"), which
  must still be on at the re-check or the call is `no-consent` and nothing changes. The
  tools are entries of one table (`ACTING`) whose schemas the model is offered and whose names are the gated set
  (`ACTING_TOOL_NAMES`), so a tool cannot be offered without passing the gate and the restore point. A refusal
  changes nothing and keeps no restore point; a failure once the change has begun (typing stopped or not consumed, or `tool-failed` inside it) keeps
  it. Stop while either card is up is `stopped`, and so is an abort (Esc, BREAK) while a card or a pause waits; once a turn
  is stopped, a later call in the same response is `stopped` without asking. Nothing leaves a tool as a raw exception: anything uncoded is
  `tool-failed` (`asToolError`), in `runTool` and again in the backend. Each description names the codes the tool can
  return and states every range and default from the constants the code applies (`POKE_MIN`/`POKE_MAX`,
  `BYTE_MIN`/`BYTE_MAX`, `TYPE_TEXT_MAX`, `SOURCE_MAX`, `ASSEMBLE_DEFAULT_ORG`, `RUN_DEFAULT_TARGET`,
  `BASIC_PROGRAM_TEXT_MAX`, and `ADDRESS_MIN`/`ADDRESS_MAX` from `js/claude/readtools.js`). The results:
  `poke` `{address, length, written, skipped, not_taken}`; `type_text` `{requested, consumed, lines_requested,
  lines_delivered}`; `load_basic` `{lines, bytes, start, end}`; `press_break` `{requested, consumed}`;
  `assemble_and_load` `{bytes, written, skipped, ranges, start, symbols, not_taken}`; `run` `{how:"jump", target}`,
  or for `"RUN"` `{how:"typed", target:"RUN", requested, consumed, lines_requested, lines_delivered}`.
  The keyboard tools (`type_text`, `press_break`, `run "RUN"`) all go through the paced typist (`Typist.typePaced`,
  `Typist.holdPaced` for BREAK) and say what the machine read: *consumed* means the keyboard was scanned with the
  key down, not proof the program acted on it. A machine that never reads the keyboard while a key is held (a
  program that does not scan it; no ROMs, whose stub reads no BREAK) is `not-consumed`, where `press_break` used to
  answer `{pressed:true}` at once and `run` `{started:true}` with RUN only queued. For BREAK and the Enter of RUN, a
  key read once down is enough: what they start or stop may never read the keyboard again.
  The brief says the same in short (`TOOL_CONTRACT` in `js/claude/brief.js`), and adds the rule a success is read by:
  "An acting tool's success means the keys or bytes reached the machine, not that the program did what you wanted.
  Check the effect with screen_text, peek or machine_info before you say it happened. If you can't read the result,
  say it is unverified." The brief's facts come from the machine's real state: BASIC ROMs in (and then that a
  program may be running, not BASIC's prompt), NitrOS-9 running, or no ROMs (`software`), and the machine's own text
  screen by family (32 by 16 on the MC6847 machines; the CoCo 3's and the Dragon 64 Plus's wider ones named). The
  chat firmware's 42 by 24 is said only to the full-screen chat, where the replies are read on it. `node tests/claude-acting-contract.test.js`
  checks every acting tool against every outcome through the backend with a mocked API, the schemas against the
  constants, and the gate and restore point for every tool in the schemas.
  **The codes** (`js/claude/toolerrors.js`), each sent as `{"error":{"code":…,"remedy":…,"detail":…}}` with
  `is_error:true`:

  | Code | Remedy the model is given |
  |---|---|
  | `bad-address` | use an address from 0 to 65535 |
  | `not-ram` | that address is ROM or I/O on this machine's memory map: write to RAM |
  | `too-large` | send less: the limit for this parameter is given in detail |
  | `bad-length` | use a length from 1 to 65536 bytes: 65536 is the whole address space, and a read over 256 bytes is truncated |
  | `bad-count` | ask for at least 1 instruction, and at most 64 |
  | `past-end` | start at a lower address: the bytes read (at most 256) or written must end at or before 65535 ($FFFF); addresses do not wrap |
  | `not-a-number` | pass a whole number, not a string or a fraction |
  | `unknown-tool` | use one of the tool names offered in this request |
  | `no-machine` | open a machine first; there is none in this chat |
  | `no-consent` | the person has not allowed acting on the machine: explain the change instead of making it |
  | `consent-declined` | the person chose "Just tell me the fix": explain the change so they can make it |
  | `stopped` | the person stopped Claude: do not change the machine |
  | `machine-restarted` | the machine restarted while your keys went in (detail says how many went in; the rest were not typed); this is not a Stop. Read the screen with screen_text and machine_info before you type again |
  | `empty` | send a non-empty value for the parameter named in detail |
  | `bad-byte` | a byte is a whole number from 0 to 255 |
  | `assembly-failed` | fix the errors named in detail (line numbers are those of your source) and call again; nothing was written |
  | `org-conflict` | drop the org argument, or remove the ORG line from the source |
  | `no-basic` | this needs the BASIC ROMs, which this machine does not have: for run, pass an address to jump to instead; for a program, write it in assembler with assemble_and_load |
  | `bad-target` | pass an address 0-65535 (a decimal integer, or hex text like "$3000") or "RUN" |
  | `not-consumed` | the machine did not read the keyboard while the keys were held (detail says how far it got; the rest was not typed or pressed): read the screen with screen_text and machine_info to see what is running; if a program is running that reads the keyboard, press_break may stop it; a program that never reads it ignores keys, so say so. Then type only what is missing, or offer load_basic for a long program |
  | `bad-line-number` | start every line with a line number from 0 to 63999 (detail names the line); nothing was loaded |
  | `line-too-long` | split the line named in detail: it is longer than this BASIC accepts (the limit is in detail); nothing was loaded |
  | `not-at-prompt` | BASIC must be at its OK prompt: read the screen with screen_text, press_break if a program is running, and try again |
  | `program-too-large` | the program does not fit in this BASIC session's free memory (detail gives the sizes): shorten it, or ask the person to free memory (for example PCLEAR 1 on a CoCo or Dragon) |
  | `unknown-machine` | this machine's BASIC is not one load_basic knows: type the program with type_text instead |
  | `load-declined` | the person chose not to load the program: do not load it; offer to type it if it has 3 lines or fewer, or give them the listing |
  | `machine-stopped` | the Debugger has the machine stopped (detail says where and why): it runs no frames and reads no keys until it is resumed, so nothing more was typed, pressed or run (a call made while it was stopped did nothing; one it stopped part-way says in detail how far it got, and the rest was dropped). Reading still works (screen_text, peek, disassemble, registers, screenshot). Ask the person to press Resume (or Run in the Debugger), then call again; loading a program, Reset or a power cycle also releases the stop, and starts that instead |
  | `include-unreadable` | an INCLUDE file could not be read (detail names it and why); nothing was written: put the code it holds into the source itself and call again |
  | `tool-failed` | the tool failed inside the emulator (detail says how): read the machine with machine_info or screen_text before going on, and tell the person; do not repeat the call unchanged. (When the detail says the CALL was wrong - it names a tool target, say - fix the call; nothing was read and the machine is fine.) |
  | `not-typable` | the machine cannot take the characters in detail (no key for them on this keyboard, or above $7E, which BASIC cannot store as text): leave them out or use plain ASCII it has (BASIC keywords are uppercase) |
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
   session comes on screen, the program is typed and runs, and the turn's lines say what was typed. Click
   **↶ Restore to …** on the restore line: the program is gone and the lines say *undone at*. Then ask for a 20-line program: Claude calls `load_basic` without asking in prose, the panel
   says *Thinking…* with Stop while it writes the call, and the load card asks (*Waiting for your OK*); click
   **Load it**, and it lists the program and checks the screen; `LIST` and `RUN` it yourself. Do this on a Dragon, a CoCo (1/2 and 3)
   and an MC-10: this is the only check of `load_basic` against a real BASIC (not automated: no test may use ROMs).
5. Ask for something long and press Esc while it streams: the reply stops with `[stopped]` and the chat stays. Type
   a few characters and press Esc: the line goes and the chat stays. Press Esc once more on the empty prompt: the chat
   closes and the emulator is back, as with **← Emulator**.
6. Save a wrong key (`sk-ant-wrong`) and send a line: the help line says the key was refused, and nothing retries.
7. ← Emulator, then the **Machine** tab → **Settings file** → **Export…**: the file holds no key. Back in the chat,
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
