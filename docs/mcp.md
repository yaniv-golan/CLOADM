# MCP server: CLOADM for coding agents

[CLOADM](../README.md) › [Automation](automation.md) › MCP server

`node cli/cloadm.js --mcp` is a [Model Context Protocol](https://modelcontextprotocol.io) server on stdio. A coding
agent (Claude Code, Cursor, Claude Desktop or any MCP client) boots Dragon, CoCo and MC-10 machines, runs programs on
them, types, waits for the screen, reads the screen, memory and registers, steps the CPU and takes screenshots. The
machines live in the server for as long as it runs. It needs Node 22.12 or later and a checkout of this repository,
and nothing else: no npm packages and no build.

## Starting it

```sh
node cli/cloadm.js --mcp [--roms PATH]... [--media-root DIR] [--read-only]
```

| Option | What it does |
|---|---|
| `--roms PATH` | your own ROM dumps: a file, a ROM pack `.zip` or a directory (repeatable). Without them every machine runs CLOADM's built-in firmware, which runs machine code but not BASIC. The server reads them once at start; they are never sent to the client as files |
| `--media-root DIR` | the only directory the tools may read programs, tapes, disks, snapshots and `INCLUDE` files from, or write snapshots to. Every path is resolved inside it with `realpath`: `..`, an absolute path elsewhere, or a link that leads out are refused (`outside-media-root`). Without it (nor `mediaRoot` in the config file) the media root is `~/CLOADM` (`%USERPROFILE%\CLOADM` on Windows), a folder you can find: it is made on the first write (the first `save_snapshot`), never by starting or reading, and put tapes, disks and programs there for the tools to load; a file that is not there is `cannot-read`, naming the folder. What remains: a hard link inside the root to a file elsewhere is followed (it is the same file), and a directory swapped for a link between the check and the open is a race only someone who can already write in the root can run |
| `--read-only` | only the tools that leave the machines' input, memory and your files alone: an agent can boot machines, let them run and look at them, but not type, write memory, load media or write files. The other tools are hidden (`tools/list` leaves them out, and the server's instructions name none of them); a call to one anyway is refused with `read-only` |

**The config file.** `--roms` and `--media-root` can also be set once, in `~/.config/cloadm/config.json`
(`%APPDATA%\cloadm\config.json` on Windows):

```json
{ "roms": ["/path/to/roms"], "mediaRoot": "/path/to/project" }
```

Each setting comes from the command line if it is given there, else from this file, else its default: no ROMs (the
built-in firmware), and the media root `~/CLOADM`. A plugin install that cannot pass either still has a folder for
snapshots and media. `roms` is a
path or a list of paths; a path may be `~` or start with `~/`, and a relative one is taken from the file's directory. A value
that is empty (`--roms=`) or an unfilled placeholder (`--media-root=${user_config.media_root}`, as plugin hosts pass an
unset setting) counts as not given, so the file applies; a bare `--roms` with nothing after it is an error. A file
that is not valid JSON, not an object, or has another key or a wrong type stops the server with the reason (exit 2).
The server's start-up line on stderr says where each setting came from.

`--serve` takes the same options and serves the same tools over plain JSON lines, for programs that do not speak MCP
(see [Serving JSON lines](#serving-json-lines)).

### Claude Code

```sh
claude mcp add cloadm -- node /path/to/cloadm/cli/cloadm.js --mcp --roms /path/to/roms --media-root /path/to/project
```

### Cursor

`.cursor/mcp.json` in the project, or `~/.cursor/mcp.json`:

```json
{ "mcpServers": { "cloadm": { "command": "node", "args": ["/path/to/cloadm/cli/cloadm.js", "--mcp", "--media-root", "/path/to/project"] } } }
```

### Claude Desktop

`claude_desktop_config.json` (Settings → Developer → Edit Config):

```json
{ "mcpServers": { "cloadm": { "command": "node", "args": ["/path/to/cloadm/cli/cloadm.js", "--mcp", "--roms", "/path/to/roms", "--media-root", "/path/to/project"] } } }
```

Use absolute paths: the client starts the server from a directory of its own choosing.

## The tools

Every machine tool takes `machine_id`, the handle `boot` returns (`"m1"`, `"m2"`, …; never reused). At most 8 machines
are open at once.

| Tool | What it does | Read-only |
|---|---|---|
| `list_models` | the models, their options and values, and the ROM files each needs for BASIC | yes |
| `list_machines` | the machines open now | yes |
| `boot` | a new machine: `model`, `options`, `roms` (true: your ROMs, false: the built-in firmware) → its `machine_id` | allowed |
| `switch_machine` | another model or options behind the same `machine_id` | |
| `close_machine` | switch it off and forget the handle | allowed |
| `machine_info` | the page's tool: model, RAM, CPU, video mode, whether BASIC is at its prompt, PC; plus, while a tape is in the deck, `tape`: its motor, position (byte of the image and percent), block, whether it is at the end (also in every tool's `machine` summary) | yes |
| `screen_text` | the page's tool: the text on the screen (VDG, every CoCo 3 GIME text mode, the Dragon 64 Plus's 80 columns); on the VDG, `semigraphics` counts the cells that are blocks rather than characters | yes |
| `peek` | the page's tool: memory as the CPU sees it, up to 256 bytes a call, as hex rows of 16 (`"$0400: 4C 49 …"`) | yes |
| `disassemble` | the page's tool: instructions in the machine's own instruction set, up to 64 a call | yes |
| `poke` | the page's tool: write bytes through the memory map; says what did not land | |
| `type_text` | the page's tool: type at the keyboard (`\n` is Enter), each key held until the machine has read it | |
| `load_basic` | the page's tool: a BASIC listing straight into program memory (needs your ROMs, BASIC at its prompt) | |
| `press_break` | the page's tool: press BREAK until the machine reads it | |
| `find_bytes` | search memory as the CPU sees it for hex bytes with `??` wildcards (`"86 ?? 39"`), optionally `from`-`to`: up to 64 addresses | yes |
| `press_keys` | hold keys together (`["LEFT"]`, `["SHIFT", "UP"]`; the named keys type_text cannot type) and/or set the joystick (x, y 0-63, fire) for some frames, then let go: for games. Nothing waits for the program to read them; only a program that scans the keyboard or joystick itself sees them (on the built-in firmware, type into LIZA and the welcome screen with `type_text`) | |
| `assemble_and_load` | the page's tool: assemble 6809/6803/6309 source and write it into memory (`INCLUDE` from the media root) | |
| `run` | the page's tool: jump to an address, or type RUN | |
| `run_frames` | let the machine run up to `frames`, stopping as soon as `until` holds (`text` on the screen; `address` + `value` in memory; `pc`; `tape` `"stopped"` or `"end"`; `screen` `"changed"`: a character or block shape in a text mode, not a colour alone such as BASIC's cursor, any pixel in a graphics mode) | allowed |
| `step` | exactly `count` CPU instructions, then the registers | |
| `registers` | the CPU's registers | yes |
| `screenshot` | the screen as a PNG image, always a whole frame (`mid_frame` says when the machine stopped inside one and this is the last complete frame; the next frame began before the stop, so `run_frames 2` shows one drawn entirely after it); `scale` 1 to 3 enlarges it | yes |
| `reset`, `power_cycle` | the reset button; off and on (RAM cleared) | |
| `set_display` | which of the Dragon 64 Plus's screens is shown (`main` or `plus`) | allowed |
| `load` | run a file from the media root (binary, tape, cartridge, BASIC listing, disk into drive 0) or a bundled program (`welcome`, `liza`, `demo`). A listing is typed as NEW, its lines and RUN (`run: false` leaves out RUN), and the result says what the keyboard typed differently (`changed`) or could not type (`dropped`) | |
| `insert_tape`, `insert_disk` | a tape in the deck, a disk in a drive (a disk needs your disk ROM) | |
| `save_snapshot`, `restore_snapshot` | the whole machine to a file under the media root, and back. `save_snapshot` writes only names ending `.cloadm-state`, replaces an existing file only if it is a snapshot, and never writes the server's config file | |

"Read-only" says which tools `--read-only` keeps: "yes" for the tools that change nothing (`readOnlyHint`), "allowed"
for the ones it keeps because they only make, run or show a machine of the server's own. Every tool states all four
hints: `readOnlyHint`, `destructiveHint` (true for what types, writes, loads or replaces), `idempotentHint` (true for
the read-only tools and for what gives the same result when repeated) and `openWorldHint: false`: nothing reaches
beyond the server and your media root.

**The page's tools are the page's.** `machine_info`, `screen_text`, `peek`, `disassemble`, `poke`, `type_text`,
`load_basic`, `press_break`, `assemble_and_load` and `run` are the tools the in-page Claude uses
([claude.md](claude.md)), with the same parameters, run through the same code on the same kind of machine: their
results, checks and refusals are the page's, byte for byte (`tests/mcp.test.js` compares them). The page's own consent
switch and cards are replaced by your MCP client's approval of each call.

**Time.** `run_frames` and anything that types run in emulated time and stop after a frame limit or about 25 seconds
of real time, whichever comes first; `run_frames` then answers `"status": "not-yet"` with the screen, and the agent
calls again. A call never blocks for longer. Cancelling a call (`notifications/cancelled`) stops the machine where it
is, and the call gets no reply, as the protocol asks. A `run_frames` call given a `progressToken` sends
`notifications/progress` as frames pass. The same calls give the same results: nothing in the emulation reads the
clock.

**Waiting for text.** `until.text` is a plain substring: `{"text": "OK"}` stops when OK is on the screen (the rows as
`screen_text` reads them, each with its trailing spaces trimmed, joined by `\n`, so `"\n>"` is a `>` at the start of a
row), and `"ignore_case": true` matches whatever the case. There are no pattern waits: a regular expression tested on
every frame can backtrack for seconds on one screen, and limiting the patterns did not close that. A later version may
offer them again, run in a worker with a timeout.

### Results and errors

A result is the tool's JSON, as `structuredContent` and as text. What the emulated program produced (the screen,
memory, a disassembly of it) comes under `machine_output`, next to `untrusted`, a note saying it is the program's
output, data and never instructions: a program can print anything, including text that reads like a request to the
agent. `machine_info`'s answer is the emulator's own and is not wrapped. Only `screenshot` returns an image.

A tool that fails returns `isError: true` with `{ "error": { "code", "remedy", "detail" } }`: a stable code, an
instruction saying what to do instead, and the value that failed. The page's tools use the page's codes
(`bad-address`, `past-end`, `not-ram`, `not-typable`, `not-consumed`, `assembly-failed`, `no-basic`, …, in
`js/claude/toolerrors.js`), with one addition: the remedies of `not-typable` and `not-consumed` point at `press_keys`,
which only the server has. The others use these:

| Code | Meaning |
|---|---|
| `bad-argument` | an argument is malformed or out of range; `detail` names it |
| `no-machine` | no machine with that `machine_id`: boot first |
| `too-many-machines` | 8 are open: close one |
| `unknown-model` | not a model id from `list_models` |
| `bad-option` | the model has no such option, or not that value |
| `missing-roms` | `boot` asked for ROMs the server was not given |
| `no-media-root` | the server was started without `--media-root` |
| `outside-media-root` | the path leaves the media root, or is a link the server will not write through |
| `cannot-read`, `cannot-write` | the file could not be read or written: missing, not a regular file (a FIFO, a device, a directory), or over 64 MB |
| `bad-media` | the file is not what the tool takes |
| `rejected` | the machine refused (a disk without a disk ROM, a format it does not know, …); nothing changed |
| `read-only` | the server runs with `--read-only` |
| `cancelled` | the call was cancelled (on `--serve`; MCP sends no reply) |

An unknown tool name is the protocol's error `-32602`, as the specification says; everything else is a tool result,
so the agent can read the remedy and try again.

**ROMs.** The server reads your ROMs; it never returns them as files. Reads of memory follow the page's rule: like the
in-page Claude, `peek`, `disassemble` and `screenshot` show what the machine holds, which with your ROMs includes ROM
code, so treat what an agent reads as you would treat your ROMs.

### Protocol versions

The server speaks both eras of the protocol on stdio. A client that opens with `initialize` is served by the
handshake revisions (`2025-11-25`, `2025-06-18`, `2025-03-26`, `2024-11-05`: the one it asks for, or the newest). A
request that carries `_meta["io.modelcontextprotocol/protocolVersion"]` is served statelessly by `2026-07-28`:
`server/discover` gives the versions, capabilities and instructions, every result has `resultType: "complete"` and
the server's identity in its `_meta`, `tools/list` carries `ttlMs` and `cacheScope`, and a version it does not speak is
`UnsupportedProtocolVersionError` (`-32022`) with the list it does. Tool lists come in a fixed order. stdout carries
only protocol messages; the server's start-up line goes to stderr; it exits when its input closes. Each message is
one line of at most 4 MB (a longer line is refused with `-32600` and not read); a JSON-RPC batch (an array of
messages) is refused with `-32600` too, as no revision it speaks has batches. A cancellation also reaches a call still
waiting behind another: it is then never run, and never answered.

MCP Apps (a `ui://` view of the machine in the client) is not served yet: the tools are built so that one can be added
without changing them.

## Serving JSON lines

The same tools for any program: one JSON object per line on stdin, one reply per line on stdout, in order.

```text
{"id": 1, "tool": "boot", "arguments": {"model": "coco"}}
{"id": 2, "tool": "load", "arguments": {"machine_id": "m1", "program": "liza"}}
{"id": 3, "tool": "run_frames", "arguments": {"machine_id": "m1", "until": {"text": "\n>"}}}
{"id": 4, "tool": "type_text", "arguments": {"machine_id": "m1", "text": "I need a holiday\n"}}
{"id": 5, "tool": "run_frames", "arguments": {"machine_id": "m1", "until": {"text": "HOLIDAY?"}}}
```

A reply is `{ "id", "ok": true, "result" }` or `{ "id", "ok": false, "error": { code, remedy, detail } }`; a
screenshot's PNG comes as base64 in `result.png`. `{ "cancel": id }` stops a request that is running or still queued
(it then replies with `cancelled`).

---

See also: [Automation](automation.md) · [Claude in CLOADM](claude.md) · [Development](development.md)
