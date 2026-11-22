# MCP server: CLOADM for coding agents

[CLOADM](../README.md) › [Automation](automation.md) › MCP server

`node cli/cloadm.js --mcp` is a [Model Context Protocol](https://modelcontextprotocol.io) server on stdio. A coding
agent (Claude Code, Cursor, Claude Desktop or any MCP client) boots Dragon, CoCo and MC-10 machines, runs programs on
them, types, waits for the screen, reads the screen, memory and registers, steps the CPU and takes screenshots. The
machines live in the server for as long as it runs. It needs Node 22.12 or later and a checkout of this repository,
and nothing else: no npm packages and no build.

## Use with Claude

**Use the connector.** Add `https://mcp.cloadm.dev/mcp` as a custom connector (no sign-in). CLOADM opens in Claude's side panel on the web and in the desktop app (phones not yet tested): you watch, type along, and Claude plays it with you. Nothing to install.

**Optional, recommended:** add the CLOADM skill too, so Claude drives the emulator better: download `cloadm-skill.zip` from the [Releases](https://github.com/yaniv-golan/CLOADM/releases) page and add it in claude.ai under Settings → Capabilities → Skills (steps not yet verified by the owner).

**For developers and your own files: the plugin.** Runs CLOADM on your computer with your ROM files and the ~/CLOADM folder of tapes, disks and snapshots; Claude sees text and screenshots, with no live panel. Needs the Claude desktop app open (Claude Code runs it itself). The install steps are in the reference table below.

**Which one?**

| You want to… | Use |
|---|---|
| Play or watch a machine with Claude, live | Connector |
| Use Claude on a phone or a computer that isn't yours (not yet tested on phones) | Connector |
| Install nothing | Connector |
| Open your own tapes, disks or snapshot files | Plugin |
| Keep results as files (screenshots, saved tapes, disk images) | Plugin |
| Script it from Claude Code, or run tests | Plugin |
| Your organisation blocks plugins (desktop) | .mcpb extension |

**Both on?** That's fine. Say "in the side panel" for the connector or "use my files" for the plugin; for play, Claude is told to prefer the side panel. The skill alone, without the plugin, is enough to get Claude's best play on the connector.

## Which way should I install CLOADM for Claude?

Claude is one app on the web, on phones and on the desktop. There are two main ways to give it CLOADM, and two
for special cases. "Marketplace" is not a separate way: it is just where the plugin is listed, and this repository is
its own marketplace.

| Way | Install | Where the emulator runs | Tested |
|---|---|---|---|
| **1. Connector** (most people) | Plugins → Add → "Add custom connector" → name `CLOADM` and URL `https://mcp.cloadm.dev/mcp` → **No sign-in** → Add | in Claude's side panel, in your browser | claude.ai on the web and the desktop app, by the owner; phones not yet |
| **2. Plugin** (your own files, or Claude Code) | Customize → Plugins → Add → "Add marketplace" → `yaniv-golan/CLOADM` → Add on **Cloadm**; in Claude Code `/plugin marketplace add yaniv-golan/CLOADM`, then `/plugin install cloadm@cloadm-marketplace` | on your computer | Claude Code; the desktop app's plugin path by the owner |
| 3. `.mcpb` extension (niche) | download `cloadm.mcpb` from the [Releases](https://github.com/yaniv-golan/CLOADM/releases) page and open it | on your computer, Claude Desktop only | |
| 4. Other agents (Cursor, Codex, Gemini CLI, …) | an MCP entry for `node cli/cloadm.js --mcp`, plus `.agents/skills/` | on your computer | see [below](#cursor-gemini-cli-codex-and-other-mcp-clients) |

**1. Connector.** Works on the web and in the desktop app, with no computer of your own involved. The emulator runs in Claude's
side panel: you watch the screen and can type into it yourself, and Claude uses the tools on the same machine,
asking you to approve each call. Nothing to install. Your ROMs are added inside the panel and stay in that browser.
There are no files: no tapes, disks or snapshots from your computer, and no downloads. Verified by the owner on
claude.ai on the web and in the Claude desktop app (the view opened, Claude typed, LIZA answered); phones are not yet tested. Details:
[Claude on the web: side panel](#claude-on-the-web-side-panel).

**2. Plugin.** The emulator runs on your computer, so it needs the Claude desktop app installed and open (Claude Code
runs it itself). Claude sessions on the web and on your phone can then use it too while that computer is on (how the
app shares a computer's local tools; not yet tested with CLOADM). With the app closed the tools are not available
(inferred, not tested). It uses your ROM files and the `~/CLOADM` folder for tapes, disks, programs and snapshots
([Your ROMs and media folder](#your-roms-and-media-folder)). Claude sees text and screenshots; there is no live
panel. The plugin includes the skill that teaches Claude how to drive the emulator.

**3. `.mcpb` extension.** For a Claude desktop app where your organisation does not allow plugins or marketplaces, or
if you want a settings form for the ROM and media folders. Desktop only, and without the skill.

**4. Other agents.** An MCP configuration entry that starts the server from a checkout, and the skill from
`.agents/skills/cloadm/` where the client reads skills.

## Starting it

```sh
node cli/cloadm.js --mcp [--roms PATH]... [--media-root DIR] [--read-only]
```

| Option | What it does |
|---|---|
| `--roms PATH` | your own ROM dumps: a file, a ROM pack `.zip` or a directory (repeatable). Without them every machine runs CLOADM's built-in firmware, which runs machine code but not BASIC. The server reads them once at start; they are never sent to the client as files |
| `--media-root DIR` | the only directory the tools may read programs, tapes, disks, snapshots and `INCLUDE` files from, or write snapshots to. Every path is resolved inside it with `realpath`: `..`, an absolute path elsewhere, or a link that leads out are refused (`outside-media-root`). Without it (nor `mediaRoot` in the config file) the media root is `~/CLOADM` (`%USERPROFILE%\CLOADM` on Windows), a folder you can find: it is made on the first write (the first `save_snapshot`), never by starting or reading, and put tapes, disks and programs there for the tools to load; a file that is not there is `cannot-read`, naming the folder. What remains: a hard link inside the root to a file elsewhere is followed (it is the same file), and a directory swapped for a link between the check and the open is a race only someone who can already write in the root can run |
| `--read-only` | only the tools that leave the machines' input, memory and your files alone: an agent can boot machines, let them run and look at them, but not type, write memory, load media or write files. The other tools are hidden (`tools/list` leaves them out, and the server's instructions name none of them); a call to one anyway is refused with `read-only` |

<a id="the-config-file"></a>**The config file.** `--roms` and `--media-root` can also be set once, in `~/.config/cloadm/config.json`
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

## Installing

Every host below runs the same server from a copy of this repository; only the way it gets there differs. All of
them need Node 22.12 or later on the computer that runs the server. No ROMs come with CLOADM: without yours, every
machine runs the built-in firmware (machine code and the bundled programs LIZA, the demo, the welcome screen, 2048 and
Minesweeper run; BASIC does not). The agent skill that teaches an agent to use these tools lives in `skills/cloadm/` (and a copy in
`.agents/skills/cloadm/`).

| Host | How |
|---|---|
| Claude Code | the plugin from this repository's marketplace |
| The Claude desktop app | the plugin, from this repository's marketplace (see [The Claude desktop app](#the-claude-desktop-app)); or the `.mcpb` extension where plugins are not allowed |
| Cursor | an MCP server entry pointing at a checkout, plus the skill folder (supported); this repository's marketplace may also install as it is (untested: see below) |
| Codex (CLI and app), Gemini CLI, other MCP clients | an MCP server entry pointing at a checkout, plus the skill folder; in the Codex app the marketplace is untested (see below) |
| claude.ai on the web | the remote connector `https://mcp.cloadm.dev/mcp`, in Claude's side panel (see [Claude on the web: side panel](#claude-on-the-web-side-panel)) |

### Claude Code

In a Claude Code session:

```text
/plugin marketplace add yaniv-golan/CLOADM
/plugin install cloadm@cloadm-marketplace
```

(Claude Code 2.1.275 or later also takes the two steps as one: `/plugin install cloadm --marketplace yaniv-golan/CLOADM`.)
The plugin starts `node ${CLAUDE_PLUGIN_ROOT}/cli/cloadm.js --mcp` with no arguments, so out of the box it has no
ROMs and its files live in `~/CLOADM` (put tapes, disks and programs there); see
[Your ROMs and media folder](#your-roms-and-media-folder). Instead of the plugin you can also add the server by hand:

```sh
claude mcp add cloadm -- node /path/to/cloadm/cli/cloadm.js --mcp --roms /path/to/roms --media-root /path/to/project
```

### The Claude desktop app

The app reads plugins from your Claude account, not from Claude Code: a plugin installed with `/plugin` or
`claude plugin install` stays on that computer and does not reach the app. In the app:

1. In the sidebar, **Customize** → the **Plugins** tab → **Add** → **Add marketplace**, and enter `yaniv-golan/CLOADM`.
2. **Add** on the **Cloadm** plugin (or just ask for it in a chat).
3. The app says "This plugin includes local MCP servers … cloadm": click **Continue**.

(Steps checked by the owner in the desktop app.) The server is a local one (the app starts `node` on your computer),
so it runs while the app is open on that computer, which needs Node 22.12 or later on its `PATH`.

The plugin's root is the repository, so it must not have a top-level `bin/` directory: Cowork and claude.ai refuse
a plugin that has one ([plugins reference](https://code.claude.com/docs/en/plugins-reference), "Standard layout";
[platform support](https://claude.com/docs/plugins/platform-support)). That is why the server is in `cli/`.

### The .mcpb extension

Download `cloadm.mcpb` from the [Releases](https://github.com/yaniv-golan/CLOADM/releases) page and open it (or drag
it onto Settings → Extensions). The app asks for a **media folder** (required: the only folder the tools read and
write) and a **ROM folder** (optional), and passes them as `--media-root` and `--roms`. The bundle holds only the
server (`cli/`, `js/` and the bundled programs); it has no npm packages and no ROMs. It is made from
`mcpb/manifest.json` when a version is tagged (`.github/workflows/release.yml`).

To run a checkout instead, add it to `claude_desktop_config.json` (Settings → Developer → Edit Config):

```json
{ "mcpServers": { "cloadm": { "command": "node", "args": ["/path/to/cloadm/cli/cloadm.js", "--mcp", "--roms", "/path/to/roms", "--media-root", "/path/to/project"] } } }
```

### Cursor, Gemini CLI, Codex and other MCP clients

**Untested: the marketplace in the Codex app and in Cursor.** Both read Claude Code's plugin format to some
degree, so adding `yaniv-golan/CLOADM` as a plugin marketplace there may install the plugin as it is. Nobody has
tried it yet; if it does not start the server, use the manual steps after this paragraph.

* The Codex desktop app reads a repository's `.claude-plugin/marketplace.json` as a "legacy-compatible" marketplace,
  accepts Claude-compatible plugin manifests, and sets `CLAUDE_PLUGIN_ROOT` for plugin hooks
  ([Package your plugin](https://developers.openai.com/plugins/build/plugins),
  [Submit your Claude Code plugin](https://developers.openai.com/plugins/guides/submit-claude-plugin)). Its docs do
  not say whether it expands `${CLAUDE_PLUGIN_ROOT}` in an MCP server's arguments, which this plugin needs.
* Cursor documents its own `.cursor-plugin/` format and the open Agent Plugins format
  ([Plugins](https://cursor.com/docs/plugins), [Plugins reference](https://cursor.com/docs/reference/plugins)); it
  imports Claude Code plugins too, but only its forum says so, not its docs.

Clone the repository, then give your client an MCP server entry that runs it; use absolute paths, as the client
starts the server from a directory of its own choosing.

Cursor: `.cursor/mcp.json` in the project, or `~/.cursor/mcp.json` (both are read; the project's entry wins on the
same name: [Cursor MCP](https://cursor.com/docs/mcp)):

```json
{ "mcpServers": { "cloadm": { "command": "node", "args": ["/path/to/cloadm/cli/cloadm.js", "--mcp", "--media-root", "/path/to/project"] } } }
```

Gemini CLI: the same `mcpServers` entry in `.gemini/settings.json` (the project) or `~/.gemini/settings.json`
([Gemini CLI MCP servers](https://github.com/google-gemini/gemini-cli/blob/main/docs/tools/mcp-server.md)).

Codex: a `[mcp_servers.<name>]` table in `~/.codex/config.toml`
([Codex MCP](https://developers.openai.com/codex/mcp), [configuration reference](https://developers.openai.com/codex/config-reference)),
or `codex mcp add cloadm -- node /path/to/cloadm/cli/cloadm.js --mcp --media-root /path/to/project`:

```toml
[mcp_servers.cloadm]
command = "node"
args = ["/path/to/cloadm/cli/cloadm.js", "--mcp", "--media-root", "/path/to/project"]
```

The skill: all three read `.agents/skills/<name>/SKILL.md`, in the project and in `~/.agents/skills/`, so copy (or
link) this repository's `.agents/skills/cloadm/` to either place
([Codex skills](https://developers.openai.com/codex/skills): every `.agents/skills` from the working directory up to
the repository root, and `$HOME/.agents/skills`; [Cursor skills](https://cursor.com/docs/skills): `.agents/skills/`
and `.cursor/skills/` anywhere in the repository, `~/.agents/skills/` and `~/.cursor/skills/`, and Claude's
`.claude/skills/` and `~/.claude/skills/` too;
[Gemini CLI skills](https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/skills.md): `.agents/skills/` as
an alias of `.gemini/skills/`, and `~/.agents/skills/`). A skill under `~/.agents/skills/` stays on that computer:
Cursor's Cloud Agents sync only `~/.cursor/skills/`.

### Your ROMs and media folder

The plugin starts the server with no paths of its own, so it takes them from the [config file](#the-config-file)
(`~/.config/cloadm/config.json`, or `%APPDATA%\cloadm\config.json` on Windows), with `roms` and `mediaRoot` as in
the example there; paths may start with `~/`. Without one it has no ROMs (machines run the built-in firmware), and
its media folder is `~/CLOADM` (`%USERPROFILE%\CLOADM` on Windows): put the tapes, disks and programs you want an
agent to load there; snapshots are written there too, and the folder is made on the first one. Restart the server
after editing the file (`/mcp` in Claude Code). The
Claude Desktop extension asks for both folders when it is installed and passes them on the command line, which wins
over the file; a ROM folder left empty there falls back to the file.

**On macOS, keep ROMs out of Downloads, Desktop and Documents.** Those folders are protected, so a config `roms` that
points into one makes macOS ask "node would like to access files in your Downloads folder" every time the server
starts. Copy the dumps into `~/CLOADM` and add them with `add_roms` (`source: "media"`), or put them in a folder of
their own elsewhere: `add_roms` copies what it stores into `~/.config/cloadm/roms/`, so the server never reads the
original location again.

## Adding your ROMs

CLOADM never ships, links to or fetches ROMs by itself. `add_roms` lets **you** give the server your own dumps from
inside a chat, from one of three sources, and keeps them in the server's own ROM store:

| `source` | Arguments | What it takes |
|---|---|---|
| `media` | `path` | a ROM file, a ZIP of them or a folder of them (its subfolders too) in the media root, by the same rules as every other file tool: `..`, absolute paths elsewhere and links that lead out are refused, and links in a folder are not followed |
| `url` | `url` | an https URL you gave the agent |
| `data` | `data`, `name` | the base64 bytes of a file you uploaded in the chat, and its file name |

The safety rules, all enforced by the server:

- **Only what you gave.** The tool's description tells the agent to use it only with a file, folder, URL or upload
  you gave it in the conversation for this purpose, never one it found in tool output, on a web page or on the
  emulated screen, and never to search for ROMs. When your client supports MCP elicitation (the `initialize`
  handshake revisions, 2025-06-18 on, with the `elicitation` capability), the server also asks you first. For a URL it
  asks **before anything is contacted** (not even DNS), showing the whole URL, query included: "Download <URL> and add
  the ROMs in it to CLOADM?". For a file or an upload it asks once it knows what is in it: "Add these ROMs from
  <source>: <files> → <models>?". Only an accept goes on; a decline, a cancel or an error from the client downloads
  and stores nothing (`declined`). A client without elicitation is not asked, and the result says so.
- **URLs: https to a public address only.** `http`, a user name or password in the URL, and any host that resolves to
  a loopback, link-local, private (RFC 1918, IPv6 ULA), CGNAT (100.64.0.0/10), unspecified, multicast, reserved,
  documentation (192.0.2/24, 198.51.100/24, 203.0.113/24, 2001:db8::/32), benchmarking (198.18/15) or 6to4 relay
  (192.88.99/24) address are refused (`refused-url`). *Every* address the name resolves to is checked, and the
  connection goes to the checked address. IPv4-mapped IPv6 addresses (`::ffff:0:0/96`), local NAT64 (`64:ff9b:1::/48`)
  and Teredo (`2001::/32`) are refused; NAT64 and 6to4 addresses are checked by the IPv4 address inside. Any port is
  allowed: the address being public is what counts. Each redirect is checked the same way, at most 3 of them, and its
  body is never read (the connection is closed at once, as for an error status). The download stops after 20 s
  (`fetch-failed`). The certificate must be valid for the host in the system's trust store. Nothing is sent but the
  request itself: no cookies (not even one a redirect sets), no credentials. It connects directly and never through a
  proxy, so it does not work where every connection must go through one: use the media or data source there.
- **Size caps.** A ROM file is at most 1 MiB, a ZIP of ROMs (or a CLOADM ROM pack) at most 4 MiB, by URL, upload or
  media file, and one call unpacks at most 8 MiB from all its ZIPs together (`too-large`); a download is cut off as
  soon as it passes the cap.
- **Only ROMs.** What is stored must be recognised as a ROM by the page's rules (`js/roms.js`): a known dump's CRC, a
  combined image of known halves, or a socket's usual file name with the right size. Anything else is listed in
  `skipped`; if nothing is a ROM the call fails with `not-a-rom` and stores nothing. A ROM pack's images go back to the
  sockets its manifest names.
- **No bytes back.** No result carries ROM bytes (only names, sizes, CRCs and the models they fit), and the server
  logs none.

The store is a folder of the server's own, next to its config file: `~/.config/cloadm/roms/`
(`%APPDATA%\cloadm\roms\` on Windows), never the media root. It is merged with `--roms` and the config file's
`roms` at every start (where both fill a socket, `--roms` or the config file wins). Machines already open do not
change: the result lists `models_with_basic` (as `list_models` reports it) and `newly_with_basic`, and suggests
`boot` or `switch_machine`. `list_models` gives, for each model, `basic` (whether the server has its BASIC ROMs) and,
for each ROM, `loaded`: the file that fills it and its `source` (`cli`, `config` or `stored`). `remove_roms` forgets
stored ROMs by name, or `all: true`; ROMs from `--roms` or the config file are yours to remove. `--read-only` hides
both tools (the stored ROMs are still used).

## The tools

Every machine tool takes `machine_id`, the handle `boot` returns (`"m1"`, `"m2"`, …; never reused). At most 8 machines
are open at once.

| Tool | What it does | Read-only |
|---|---|---|
| `list_models` | the models, their options and values, the ROM files each needs for BASIC, whether the server has them (`basic`), and which file fills each ROM and from where (`loaded`: `source` `cli`, `config` or `stored`) | yes |
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
| `load` | run a file from the media root (binary, tape, cartridge, BASIC listing, disk into drive 0) or a bundled program (`welcome`, `liza`, `demo`, or the games `2048` and `minesweeper`). A listing is typed as NEW, its lines and RUN (`run: false` leaves out RUN), and the result says what the keyboard typed differently (`changed`) or could not type (`dropped`) | |
| `insert_tape`, `insert_disk` | a tape in the deck, a disk in a drive (a disk needs your disk ROM) | |
| `save_snapshot`, `restore_snapshot` | the whole machine to a file under the media root, and back. `save_snapshot` writes only names ending `.cloadm-state`, replaces an existing file only if it is a snapshot, and never writes the server's config file | |
| `add_roms` | store your own ROMs from the media root, an https URL or an upload (`source` `media`, `url` or `data`), with the checks in [Adding your ROMs](#adding-your-roms); only with a source you gave the agent | |
| `remove_roms` | forget stored ROMs by name, or all of them | |

"Read-only" says which tools `--read-only` keeps: "yes" for the tools that change nothing (`readOnlyHint`), "allowed"
for the ones it keeps because they only make, run or show a machine of the server's own. Every tool states all four
hints: `readOnlyHint`, `destructiveHint` (true for what types, writes, loads or replaces), `idempotentHint` (true for
the read-only tools and for what gives the same result when repeated) and `openWorldHint`: false on every tool but
`add_roms`, which can fetch a URL you give it; nothing else reaches beyond the server and your media root.

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
| `no-media-root` | the host gave the tools no media root: only through the Node API with `mediaRoot` null, as the server itself defaults to `~/CLOADM` |
| `outside-media-root` | the path leaves the media root, or is a link the server will not write through |
| `cannot-read`, `cannot-write` | the file could not be read or written: missing, not a regular file (a FIFO, a device, a directory), or over 64 MB |
| `bad-media` | the file is not what the tool takes |
| `rejected` | the machine refused (a disk without a disk ROM, a format it does not know, …); nothing changed |
| `read-only` | the server runs with `--read-only` |
| `cancelled` | the call was cancelled (on `--serve`; MCP sends no reply) |
| `not-a-rom` | `add_roms`: nothing given is a ROM CLOADM recognises; nothing stored |
| `too-large` | `add_roms`: a file over 1 MiB or a ZIP over 4 MiB |
| `refused-url` | `add_roms`: not https, credentials in the URL, an address that is not public (also after a redirect), or more than 3 redirects |
| `fetch-failed` | `add_roms`: the download failed (HTTP status, TLS, DNS, the 20 s timeout) |
| `declined` | `add_roms`: you said no when asked; nothing stored |
| `no-rom-store` | a host of the tools (the Node API) without a ROM store |

An unknown tool name is the protocol's error `-32602`, as the specification says; everything else is a tool result,
so the agent can read the remedy and try again.

**ROMs.** The server reads your ROMs; it never returns them as files, and `add_roms` never echoes their bytes. (In Claude's [side panel](#claude-on-the-web-side-panel)
the rule is stricter: memory reads are refused while your ROMs run.) Reads of memory follow the page's rule: like the
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
one line of at most 8 MB (room for an `add_roms` upload) (a longer line is refused with `-32600` and not read); a JSON-RPC batch (an array of
messages) is refused with `-32600` too, as no revision it speaks has batches. A cancellation also reaches a call still
waiting behind another: it is then never run, and never answered.

On stdio the server serves no MCP Apps view (`ui://`); the [side panel](#claude-on-the-web-side-panel) is where the
same tools run in one.

## Claude on the web: side panel

On claude.ai the emulator runs in Claude's side panel, in your browser, through a remote connector at
`https://mcp.cloadm.dev/mcp` (a small stateless server with no sign-in: it serves the view and keeps nothing). Claude
then uses the same machine tools as above on the machine you see.

**Add it** (once): in claude.ai, **Plugins → Add → "Add custom connector"**, name `CLOADM`, URL
`https://mcp.cloadm.dev/mcp`, choose **No sign-in**, then **Add**. On a Team or Enterprise plan an owner may have to add it
under Organization settings → Connectors. Interactive views and app tools are a claude.ai feature that not every
account or organization has yet.

**Use it:**

1. In a chat with the connector enabled, ask Claude to open the emulator (for example "Open CLOADM"). It calls
   `open_emulator` and the view appears: a Dragon 64 talking as LIZA, or BASIC if you have added ROMs there.
2. Open the view in the side panel (Claude's expand control, or **⋯ → Open in side panel** in the view, offered while
   it is not there already). Click the screen to type on it yourself. The toolbar has **Programs** (what this machine
   runs without ROMs: LIZA, the Welcome menu, and on the 6809 machines the colour demo, 2048 and Minesweeper),
   **Machine** (every model, marked "✓ BASIC ready" or "needs ROMs", then Reset, Switch off and on and Add ROMs…),
   **Sound** ("Sound off" until you click it or the screen: that click starts the sound) and **⋯** (Details, the
   diagnostics, and Copy details). The line under the screen says what runs. While one of Claude's calls acts on the
   machine, the bezel takes Claude's colour and a chip says what it does ("Claude is typing: DIR↵"); a call that only
   reads shows a quiet "Claude read the screen". Your own typing never shows a chip. On a phone or tablet the view
   has on-screen keys under the screen (the page's keyboard, CLEAR and BREAK, and **Keys | Stick** for a joystick on a
   machine with a port); **⋯ → Hide on-screen keys** hides them.
3. In your **next** message, ask for what you want ("type I AM HAPPY and tell me what LIZA says", "play 2048",
   "write a 6809 program that fills the screen and run it"). The view registers its tools after it has loaded, so
   Claude can use them from the next turn, not in the one that opened it. Claude asks you to approve each call.

**The tools in the panel** are the ones in [The tools](#the-tools), with the same names, arguments and results
(`machine_output` with its `untrusted` note included), run by the view on the machine on screen:

* There is one machine, `machine_id` `"m1"`, already on. `boot` and `switch_machine` change it to another model or
  options; `close_machine` is not offered.
* `load` runs the bundled programs by name (`welcome`, `liza`, `demo`, `2048`, `minesweeper`). The panel has no files:
  a `path` is refused with `no-media-root`, and `insert_tape`, `insert_disk`, `save_snapshot` and `restore_snapshot`
  are not offered. Claude's views cannot download, so nothing is saved out of the panel either.
* Your ROM files stay in the panel. Add them with **Add ROMs…** or by dropping the files on the view; they are kept
  in that view's own browser storage, and no tool takes or returns them as files (`add_roms` and `remove_roms` are not
  offered). While they run, `peek`, `find_bytes`
  and `disassemble` are refused (`rejected`): memory can then hold ROM code, and no tool returns it directly. That is
  not a seal: a program run on the machine can read the ROM (BASIC's `PEEK` printed on the screen, machine code from
  `assemble_and_load` and then `registers`, `run_frames` waiting for a memory byte to hold each value in turn), so a
  determined agent can infer ROM contents through execution. Each call is still yours to approve. Claude gives each
  conversation's view its own origin, so a new conversation starts without them; reopening the same conversation keeps
  them (in that browser).
* Claude's limits for app tools: a call may run 45 s, and a result may hold 100,000 characters. A tool that runs the
  machine stops after about 25 s of real time, `run_frames` after 3000 frames (call it again to wait longer, as
  everywhere), and a result that would be longer is refused with `too-long`.

Errors the panel adds to the [ones above](#results-and-errors):

| Code | Meaning |
|---|---|
| `too-long` | the result is over 100,000 characters: ask for less (a shorter `peek` or `disassemble`, a narrower `find_bytes`, a smaller screenshot `scale`) |
| `not-started` | the emulator in the view could not start (`detail` says why: cloadm.dev unreachable, for example) |
| `not-ready` | a call came before the emulator had started, and it did not start within 15 s: call again |
| `out-of-step` | the connector and the cloadm.dev site are from different releases (see below) |

**Two views.** `open_emulator` (the default) is a small view whose emulator code comes from cloadm.dev
(`_meta.ui.csp` declares `https://cloadm.dev` and nothing else, and the site sends `Access-Control-Allow-Origin: *`).
`open_emulator_inline` carries all of the emulator's code, about 1 MiB, and loads nothing from anywhere: Claude uses
it when the first view stays at "loading" or says `error`.

**Releases.** The first view loads `connector/view/panel.js` from cloadm.dev, which loads `js/` from beside it, so the
glue between the view and the emulator always comes from the same release of the site as the emulator itself. What
the connector itself carries (the bridge that talks to Claude, and the tool list Claude sees before the emulator has
loaded) is checked against the site's with a version number, `PANEL_API` (`connector/view/tools.js`): when they
differ, the tools answer `out-of-step` rather than half working, and the emulator's own tool list replaces the
connector's as soon as it has loaded. The self-contained view has no such dependency. The connector's server and its
deployment: [deploy-connector.md](deploy-connector.md).

**Privacy.** The connector's server receives Claude's requests for its tool list and its views, nothing more: what you
type, the screen and your ROM files stay in the view in your browser (what Claude reads through
the tools goes to Claude, as in any chat). It stores nothing and logs nothing.

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
