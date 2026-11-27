# MCP server: CLOADM for coding agents

[CLOADM](../README.md) › [Automation](automation.md) › MCP server

`node cli/cloadm.js --mcp` is a [Model Context Protocol](https://modelcontextprotocol.io) server on stdio. A coding
agent (Claude Code, Cursor, Claude Desktop or any MCP client) boots Dragon, CoCo and MC-10 machines, runs programs on
them, types, waits for the screen, reads the screen, memory and registers, steps the CPU and takes screenshots. The
machines live in the server for as long as it runs. It needs Node 22.12 or later and a checkout of this repository,
and nothing else: no npm packages and no build.

## Use with Claude

**Install the CLOADM plugin.** One plugin works everywhere Claude does.

1. Customize → Plugins → Add marketplace → `yaniv-golan/CLOADM` → Add **CLOADM**. In Claude Code:
   `/plugin marketplace add yaniv-golan/CLOADM`, then `/plugin install cloadm@cloadm-marketplace`.
2. On the web and in desktop chat: open the plugin's Connectors tab and click **Connect** next to *CLOADM side panel*, then
   **Continue**. The emulator then opens in Claude's side panel.

   Already added https://mcp.cloadm.dev/mcp as a custom connector? The plugin's CLOADM side panel uses that same connector, so you won't have two; you can keep it.

   On phones the plugin and connector install, but the side panel can't be used yet. Use claude.ai on a computer or the desktop app. <!-- phones-not-yet: remove once the side panel works on phones (PHONE_VIEW_WORKS in tests/readme.test.js) -->

In Cowork and Claude Code it runs on your computer instead, with your ROM files and the ~/CLOADM folder; nothing to connect.

**Updating the plugin.** In Claude Code, new versions arrive automatically when auto-update is on for the marketplace (off by default in Claude Code for a third-party marketplace; turn it on in `/plugin` → Marketplaces; [install](https://code.claude.com/docs/en/plugins/install.md), [loading](https://code.claude.com/docs/en/plugins/loading.md)). To get one at once: `/plugin` → Marketplaces → cloadm-marketplace → Update marketplace (or `claude plugin update cloadm@cloadm-marketplace`), then `/reload-plugins`. claude.ai and the desktop app keep their own record of the installed version and don't read the manifest's, so they don't update by themselves: Plugins → Add → Manage marketplace, remove `yaniv-golan/CLOADM` and add it again, then **Connect** *CLOADM side panel* (in 0.3.0 the server was renamed from *cloadm-panel*). Maintainer-verified on 2026-11-25.

**The badge next to *CLOADM side panel*.** Claude shows this for any connector Anthropic hasn't reviewed. CLOADM's runs at mcp.cloadm.dev, needs no sign-in, and sees only the emulator in that panel. Nothing else of yours. It's open source: [source](https://github.com/yaniv-golan/CLOADM/tree/main/connector).

| Where you use Claude | What you get |
|---|---|
| claude.ai on the web, desktop chat | the live side panel (after Connect) |
| Desktop Cowork, Claude Code | on your computer, with your ROMs and files |
| Phone | not yet. On phones the plugin and connector install, but the side panel can't be used yet. Use claude.ai on a computer or the desktop app. <!-- phones-not-yet: remove once the side panel works on phones (PHONE_VIEW_WORKS in tests/readme.test.js) --> |
| Other agents (Cursor, Codex, Gemini CLI, …) | the MCP entry for `node cli/cloadm.js --mcp` ([below](#cursor-gemini-cli-codex-and-other-mcp-clients)) |

The plugin's two servers are *CLOADM side panel* (the side panel, at `https://mcp.cloadm.dev/mcp`) and *CLOADM on this
computer* (on your computer, `node cli/cloadm.js --mcp`, the name the Desktop extension has too); each Claude app uses
the one it can. Claude lists the plugin as **CLOADM**. The plugin format has no field for a server's display name: the
key under `mcpServers` is the name, so the keys are these readable names, which Claude Code lists. How claude.ai's plugin
page and chat menu show them is to be confirmed by the maintainer after release (they showed the earlier keys).

### Without the plugin

Add `https://mcp.cloadm.dev/mcp` as a custom connector and name it **CLOADM** (no sign-in). You get the side panel but not the skill that teaches Claude to play it well. Already added https://mcp.cloadm.dev/mcp as a custom connector? The plugin's CLOADM side panel uses that same connector, so you won't have two; you can keep it. To add the skill on its own, download `cloadm-skill.zip` from the [Releases](https://github.com/yaniv-golan/CLOADM/releases) page and add it in claude.ai under Settings → Capabilities → Skills (steps not yet verified by the maintainers). Claude Code 2.1.331 or later gets the skill from the connector itself, over MCP ([The agent skill over MCP](#the-agent-skill-over-mcp)); whether claude.ai chat does is not yet verified.

## Which way should I install CLOADM for Claude?

Claude is one app on the web, on phones and on the desktop. The plugin is the way for Claude; the other three are for
special cases. "Marketplace" is not a separate way: it is just where the plugin is listed, and this repository is its
own marketplace.

| Way | Install | Where the emulator runs | Tested |
|---|---|---|---|
| **1. The CLOADM plugin** (most people) | Customize → Plugins → Add marketplace → `yaniv-golan/CLOADM` → Add **CLOADM**; on the web and in desktop chat, then **Connect** next to *CLOADM side panel* on the plugin's Connectors tab; in Claude Code `/plugin marketplace add yaniv-golan/CLOADM`, then `/plugin install cloadm@cloadm-marketplace` | web and desktop chat: in Claude's side panel (*CLOADM side panel*); Cowork and Claude Code: on your computer (*CLOADM on this computer*) | by the maintainers: web and desktop chat show a Connect button and use the side panel; Cowork uses the local server (the new names are not yet confirmed on claude.ai) |
| 2. The connector alone (no skill) | Plugins → Add → "Add custom connector" → name `CLOADM` and URL `https://mcp.cloadm.dev/mcp` → **No sign-in** → Add | in Claude's side panel, in your browser | claude.ai on the web and the desktop app, by the maintainers |
| 3. `.mcpb` extension (niche) | download `cloadm.mcpb` from the [Releases](https://github.com/yaniv-golan/CLOADM/releases) page and open it | on your computer, Claude Desktop only | |
| 4. Other agents (Cursor, Codex, Gemini CLI, …) | an MCP entry for `node cli/cloadm.js --mcp`, plus `.agents/skills/` | on your computer | see [below](#cursor-gemini-cli-codex-and-other-mcp-clients) |

**1. The CLOADM plugin.** One plugin with the skill and two servers (`.claude-plugin/plugin.json`). The plugin
manifest names each server by its key ([plugins reference](https://code.claude.com/docs/en/plugins-reference):
`mcpServers` holds "server configs keyed by name"; no per-server title), so the keys are readable names, which Claude
Code lists (it names the tools `mcp__plugin_cloadm_CLOADM_side_panel__<tool>` and
`mcp__plugin_cloadm_CLOADM_on_this_computer__<tool>`, its spaces written as underscores). claude.ai's plugin page and
chat menu showed the earlier keys; the maintainer confirms what they show for these after release:

- *CLOADM side panel*, the remote server `https://mcp.cloadm.dev/mcp`. On the web and in desktop chat it is on the plugin's
  Connectors tab with a **Connect** button; after **Connect** and **Continue**, the emulator runs in Claude's side
  panel: you watch the screen and can type into it yourself, and Claude uses the tools on the same machine. Your ROMs
  are added inside the panel and stay in that browser. There are no files: no tapes, disks or snapshots from your
  computer, and no downloads. Details: [Claude on the web: side panel](#claude-on-the-web-side-panel). Those apps
  ignore the local server.
- *CLOADM on this computer*, the local server `node ${CLAUDE_PLUGIN_ROOT}/cli/cloadm.js --mcp`. Cowork and Claude Code run it on
  your computer (Cowork needs the Claude desktop app open), with your ROM files and the `~/CLOADM` folder for tapes,
  disks, programs and snapshots ([Your ROMs and media folder](#your-roms-and-media-folder)). Claude sees text and
  screenshots; there is no live panel. Nothing to connect.

The manifest also declares the one host the plugin reaches, `network.hosts: ["mcp.cloadm.dev"]` (the same page: the
field "doesn't allow or block any host"). Each server tells Claude which one it is: its instructions open with "You are
driving CLOADM in the person's side panel." or "You are driving CLOADM on the person's computer.", and `machine_info`
returns `route: "panel"` or `route: "local"`; the skill reads that first and follows its "Side panel" or "On this
computer" section.

**2. The connector alone.** The side panel without the plugin, for an account that can add a custom connector but not
a plugin. You get the panel but not the skill that teaches Claude to play it well.

**3. `.mcpb` extension.** For a Claude desktop app where your organisation does not allow plugins or marketplaces, or
if you want a settings form for the ROM and media folders. Desktop only, and without the skill.

**4. Other agents.** An MCP configuration entry that starts the server from a checkout, and the skill from
`.agents/skills/cloadm/` where the client reads skills.

## Starting it

```sh
node cli/cloadm.js --mcp [--roms PATH]... [--media-root DIR] [--read-only] [--no-skills]
```

| Option | What it does |
|---|---|
| `--roms PATH` | your own ROM dumps: a file, a ROM pack `.zip` or a directory (repeatable). Without them every machine runs CLOADM's built-in firmware, which runs machine code but not BASIC. The server reads them once at start; they are never sent to the client as files |
| `--media-root DIR` | the only directory the tools may read programs, tapes, disks, snapshots and `INCLUDE` files from, or write snapshots to. Every path is resolved inside it with `realpath`: `..`, an absolute path elsewhere, or a link that leads out are refused (`outside-media-root`). Without it (nor `mediaRoot` in the config file) the media root is `~/CLOADM` (`%USERPROFILE%\CLOADM` on Windows), a folder you can find: it is made on the first write (the first `save_snapshot`), never by starting or reading, and put tapes, disks and programs there for the tools to load; a file that is not there is `cannot-read`, naming the folder. What remains: a hard link inside the root to a file elsewhere is followed (it is the same file), and a directory swapped for a link between the check and the open is a race only someone who can already write in the root can run |
| `--read-only` | only the tools that leave the machines' input, memory and your files alone: an agent can boot machines, let them run and look at them, but not type, write memory, load media or write files. The other tools are hidden (`tools/list` leaves them out, and the server's instructions name none of them); a call to one anyway is refused with `read-only` |
| `--no-skills` | serve no agent skill over MCP ([The agent skill over MCP](#the-agent-skill-over-mcp)). The plugin's *CLOADM on this computer* starts with it, as the plugin ships the skill itself |

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
| Claude Code | the plugin from this repository's marketplace (its *CLOADM on this computer* server) |
| The Claude desktop app | the plugin, from this repository's marketplace (see [The Claude desktop app](#the-claude-desktop-app)): the side panel in chat, the local server in Cowork; or the `.mcpb` extension where plugins are not allowed |
| Cursor | an MCP server entry pointing at a checkout, plus the skill folder (supported); this repository's marketplace may also install as it is (untested: see below) |
| Codex (CLI and app), Gemini CLI, other MCP clients | an MCP server entry pointing at a checkout, plus the skill folder; in the Codex app the marketplace is untested (see below) |
| claude.ai on the web | the plugin (its *CLOADM side panel* server, after **Connect**), or the remote connector `https://mcp.cloadm.dev/mcp` alone, in Claude's side panel (see [Claude on the web: side panel](#claude-on-the-web-side-panel)) |

### Claude Code

In a Claude Code session:

```text
/plugin marketplace add yaniv-golan/CLOADM
/plugin install cloadm@cloadm-marketplace
```

(Claude Code 2.1.275 or later also takes the two steps as one: `/plugin install cloadm --marketplace yaniv-golan/CLOADM`.)
The plugin starts `node ${CLAUDE_PLUGIN_ROOT}/cli/cloadm.js --mcp --no-skills` (the plugin brings the skill itself), so out of the box it has no
ROMs and its files live in `~/CLOADM` (put tapes, disks and programs there); see
[Your ROMs and media folder](#your-roms-and-media-folder). Instead of the plugin you can also add the server by hand:

```sh
claude mcp add cloadm -- node /path/to/cloadm/cli/cloadm.js --mcp --roms /path/to/roms --media-root /path/to/project
```

### The Claude desktop app

The app reads plugins from your Claude account, not from Claude Code: a plugin installed with `/plugin` or
`claude plugin install` stays on that computer and does not reach the app. In the app:

1. In the sidebar, **Customize** → the **Plugins** tab → **Add** → **Add marketplace**, and enter `yaniv-golan/CLOADM`.
2. **Add** on the **CLOADM** plugin (or just ask for it in a chat).
3. For chat: open the plugin's Connectors tab and click **Connect** next to *CLOADM side panel*, then **Continue**. The
   emulator then opens in Claude's side panel.

(Steps checked by the maintainers in the desktop app.) Cowork uses the plugin's local server, *CLOADM on this computer* (the app starts
`node` on your computer), so it runs while the app is open on that computer, which needs Node 22.12 or later on its
`PATH`.

The plugin's root is the repository, so it must not have a top-level `bin/` directory: Cowork and claude.ai refuse
a plugin that has one ([plugins reference](https://code.claude.com/docs/en/plugins-reference), "Standard layout";
[platform support](https://claude.com/docs/plugins/platform-support)). That is why the server is in `cli/`.

### The .mcpb extension

Download `cloadm.mcpb` from the [Releases](https://github.com/yaniv-golan/CLOADM/releases) page and open it (or drag
it onto Settings → Extensions). The app asks for a **media folder** (required: the only folder the tools read and
write) and a **ROM folder** (optional), and passes them as `--media-root` and `--roms`. The bundle holds only the
server (`cli/`, `js/` and the bundled programs); it has no npm packages and no ROMs. It is made from
`mcpb/manifest.json` when a version is tagged (`.github/workflows/release.yml`), and only after the same gates a
branch runs have passed on the tagged commit; each asset carries a build-provenance attestation, which
`gh attestation verify cloadm.mcpb --repo yaniv-golan/CLOADM` checks.

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

The store records where a ROM came from: a URL as origin + path only (never its query or fragment). Two servers may share it; changes are serialised by a lock file (`index.lock`), and an index that is not valid JSON is moved aside as `index.json.corrupt-<time>` before the next change.

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
| `machine_info` | the page's tool: model, RAM, CPU, video mode, whether BASIC is at its prompt, PC; `route`, `"local"` here (`"panel"` in the side panel); plus, while a tape is in the deck, `tape`: its motor, position (byte of the image and percent), block, whether it is at the end (also in every tool's `machine` summary) | yes |
| `screen_text` | the page's tool: the text on the screen (VDG, from the page the VDG shows: on the Dragon and CoCo 1/2 the SAM's display offset, so a page a program has moved is read where it is, and only in the alphanumeric / semigraphics-4 mode - INT/EXT high and the graphics modes are declined; every CoCo 3 GIME text mode, the CoCo 3's 32-column page wherever the MMU maps it, the Dragon 64 Plus's 80 columns); on the VDG, `semigraphics` counts the cells that are blocks rather than characters (the cursor's own block left out: a screen whose only block is the cursor has no `note`), and on the Plus `unknown` the codes outside `$20`-`$7E`, both read as spaces; on a CoCo 3, `physicalBase` is where the display reads the screen and `base` the CPU address that shows it, or `null` | yes |
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
| `load` | run a file from the media root (binary, tape, cartridge, BASIC listing, disk into drive 0) or a bundled program (`welcome`, `liza`, `demo`, or the games `2048` and `minesweeper`). A listing is typed as NEW, its lines and RUN (`run: false` leaves out RUN), and the result says what the keyboard typed differently (`changed`) or could not type (`dropped`). A machine's or a disk controller's ROM image (by its contents or its usual name, such as `d64_1.rom`) is `rejected`, not plugged in as a cartridge: add it with `add_roms` (or `--roms` when the server starts) | |
| `insert_tape`, `insert_disk` | a tape in the deck (with no BASIC running its message says there is no BASIC to type CLOAD into), a disk in a drive (without your disk ROM, on the disk controller alone: programs that read the disk directly can use it, DIR and the other disk commands cannot) | |
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
calls again. Typing that reaches the 25 seconds (a long `type_text` on a host too slow to finish it) is stopped there and
fails `time-limit`, whose detail says how many of the keys went in ("40 of 150 keys typed before the time limit"): nothing
more goes in afterwards, and the rest is sent in shorter calls. A call never blocks for longer. Cancelling a call (`notifications/cancelled`) stops the machine where it
is, and the call gets no reply, as the protocol asks. A `run_frames` call given a `progressToken` sends
`notifications/progress` as frames pass. The same calls give the same results: nothing in the emulation reads the
clock.

**Waiting for text.** `until.text` is a plain substring: `{"text": "OK"}` stops when OK is on the screen (the rows as
`screen_text` reads them, each with its trailing spaces trimmed, joined by `\n`, so `"\n>"` is a `>` at the start of a
row), and `"ignore_case": true` matches whatever the case. There are no pattern waits: a regular expression tested on
every frame can backtrack for seconds on one screen, and limiting the patterns did not close that. A later version may
offer them again, run in a worker with a timeout.

**A stop the page's Debugger made.** While the Debugger has the machine stopped, nothing runs and no key is read, so
the tools that must run it or press its keys refuse rather than queue behind the stop or seem to work: `type_text`,
`press_break`, `run` (a jump too), `press_keys` and `run_frames` fail with `machine-stopped`, whose detail says where
it stopped (`stopped in the Debugger at $C0F3 (breakpoint)`) and whose remedy says how it goes on: the person presses
Resume, or Run in the Debugger. The person's own typing is refused the same way then. A stop made while one of those
calls runs ends it the same way: `run_frames` and `press_keys` fail `machine-stopped` (the keys are let go, and
`run_frames` with `until.pc` resumes only a stop its own breakpoint made, never the person's), and `type_text`,
`press_break` and `run "RUN"` drop the keys not typed yet and fail `machine-stopped`, whose detail says how many went
in (`12 of 45 keys typed, the rest dropped`); nothing more goes in after Resume. Reading works as usual and leaves the
machine stopped: `machine_info`, `screen_text`, `peek`, `disassemble`, `find_bytes`, `registers` and
`screenshot`; so do the tools that only write memory (`poke`, `assemble_and_load`, `load_basic`), and `step`, which
steps as the Debugger's Step does and leaves the machine stopped where it ended (with the reason its steps gave, a
watchpoint hit say, or as a pause). What a tool starts runs: `load`,
`insert_disk`, `reset`, `power_cycle`, `boot` and a machine switch release the stop (the breakpoints stay set), as the
page's own Run again, Reset and drops do. A file that is refused starts nothing, and the stop stays.

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
| `rejected` | the machine refused (a disk on a machine with no drives, a format it does not know, …); nothing changed |
| `read-only` | the server runs with `--read-only` |
| `cancelled` | the call was cancelled (on `--serve`; MCP sends no reply) |
| `time-limit` | the call ran for its whole time limit (about 25 s of real time) and was stopped there: detail says how much went in (`type_text`: "N of M keys typed") |
| `not-a-rom` | `add_roms`: nothing given is a ROM CLOADM recognises; nothing stored |
| `too-large` | `add_roms`: a file over 1 MiB or a ZIP over 4 MiB |
| `refused-url` | `add_roms`: not https, credentials in the URL, an address that is not public (also after a redirect), or more than 3 redirects |
| `fetch-failed` | `add_roms`: the download failed (HTTP status, TLS, DNS, the 20 s timeout) |
| `declined` | `add_roms`: you said no when asked; nothing stored |
| `no-rom-store` | a host of the tools (the Node API) without a ROM store |

An unknown tool name is the protocol's error `-32602`, as the specification says; everything else is a tool result,
so the agent can read the remedy and try again.

**ROMs.** The server reads your ROMs; it never returns them as files, and `add_roms` never echoes their bytes. Claude
reads everything in the emulated machine, ROM areas included, on every host (this server, the side panel and the
claude.ai connector), as the in-page Claude does: `peek`, `find_bytes`, `disassemble`, `screen_text`, `screenshot` and
`run_frames` show what the machine holds, which with your ROMs includes ROM code, so treat what an agent reads as you
would treat your ROMs. What CLOADM itself shares stays ROM-free: snapshots and share links carry no ROM.

**Your own WAD.** While a [WYRMFIRE](using.md#wyrmfire) level converted from your own DOOM WAD is in a drive, every
host refuses `screenshot`, `screen_text`, `peek`, `disassemble`, `find_bytes`, `registers`, `step` and `run_frames`'
screen and its `until` on a memory byte or the `pc` with `rejected`: "Claude can't look at the screen or memory while
your own WAD is loaded: it's id Software's game data." (`machine_info` still answers.) `registers` and `step` are refused
because loading a load instruction, stepping it and reading a register would read memory a byte at a time. The refusal
belongs to the machine and to the disk: taking the disk out, a Reset or loading something else keeps it; it ends once
the disk is out and the machine has been switched off and on (`power_cycle`), or on switching machines or opening a
snapshot (a power cycle with the disk still in keeps it: a program could read the disk through the controller). With WYRMFIRE's Freedoom level, screenshots work and memory reads follow the cartridge
rule above.

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

## The agent skill over MCP

Both servers, `node cli/cloadm.js --mcp` and the connector at `https://mcp.cloadm.dev/mcp`, serve the agent skill
`skills/cloadm/` through the MCP extension **Skills over MCP**, `io.modelcontextprotocol/skills`
([overview](https://modelcontextprotocol.io/extensions/skills/overview); the specification is `skills.mdx` in
[modelcontextprotocol/ext-skills](https://github.com/modelcontextprotocol/ext-skills), written against protocol
revision `2026-07-28`). A client that supports it gets the skill with the server, without the plugin or a skill
folder, and the skill changes when the server does: a new checkout, or a new deploy of the connector. Both serve the
files of `skills/cloadm/` as they are (`.agents/skills/cloadm/` is the same bytes); nothing is copied or rewritten.

| What | How |
|---|---|
| Declared | in `server/discover` (`2026-07-28`): `capabilities.extensions["io.modelcontextprotocol/skills"]: {}` and `capabilities.resources`. The handshake revisions (`initialize`) define no skills, so the extension is declared there only to a client whose own `initialize` declares it under `capabilities.extensions`; a client that does not ask sees the same handshake, tools and resources. On stdio the skill methods stay unknown (`-32601`) to such a client; the connector is stateless, so it answers `skills/list` and `skills/get` to any client that calls them |
| `skills/list` | one skill, `skill://cloadm/SKILL.md`: its frontmatter as `SKILL.md` has it, and the complete manifest, every file with its `size` and `sha256:` digest of the bytes on disk. One page, no cursor |
| `skills/get` | `{ "uri": "skill://cloadm/SKILL.md" }` gives the same entry; an unknown URI (another skill, or a file that is not a `SKILL.md`) is `-32602` |
| `resources/read` | each file, e.g. `skill://cloadm/references/debugging.md`, as `text/markdown`, byte for byte; a file not in the manifest is `-32602`. `resources/list` lists them too (on stdio; on the connector to `2026-07-28` clients, beside the two views) |
| Not offered | `resources/directory/read` (the extension's optional directory listing: `directoryRead` is not set) |

**Which clients load it.** Claude Code 2.1.331 or later, in public beta: it uses `2026-07-28` with servers that
speak it, as both of these do, and names a skill `<server>:<skill>`, such as `cloadm:cloadm` for a server added as
`cloadm`, or `claude_ai_CLOADM:cloadm` for the connector added in claude.ai as *CLOADM*
([Claude Code: Use skills from MCP servers](https://code.claude.com/docs/en/mcp#use-skills-from-mcp-servers); Team
and Enterprise owners turn on "Skills over MCP" under Organization settings → Connectors). The same page lists where
it does not: `claude -p`, cloud sessions and Claude Desktop's own connectors. Whether claude.ai chat loads skills from
a connector is not verified yet. Other clients ignore the extension.

**With the plugin.** The plugin ships the skill itself, so its *CLOADM on this computer* starts with `--no-skills`;
Claude Code would otherwise list the same skill twice (`cloadm:cloadm` from the plugin and
`plugin_cloadm_CLOADM_on_this_computer:cloadm` from the server): the extension's specification has a host keep skills from different origins apart, never silently dropping one.
The plugin's *CLOADM side panel* is the public connector and cannot be told apart, so a Claude Code that connects it
may still list `plugin_cloadm_CLOADM_side_panel:cloadm` beside the plugin's own. The two need not match: the connector serves whatever was last deployed, which can be newer or older than the installed plugin.
Use one way: the plugin, or a server added by hand (`claude mcp add`, a connector) without the plugin.

## Claude on the web: side panel

On claude.ai the emulator runs in Claude's side panel, in your browser, through a remote connector at
`https://mcp.cloadm.dev/mcp` (a small stateless server with no sign-in: it serves the view and keeps nothing). Claude
then uses the same machine tools as above on the machine you see.

The connector speaks both protocol eras over Streamable HTTP, as the stdio server does: `initialize` and the handshake
revisions (`2025-11-25`, `2025-06-18`, `2025-03-26`), and `2026-07-28` statelessly, where `server/discover` declares
its tools, resources, the MCP Apps extension and the [skill](#the-agent-skill-over-mcp), the `MCP-Protocol-Version`,
`Mcp-Method` and `Mcp-Name` headers must match the body (`400`, `-32020` when not), a version it does not speak is `400`
with `-32022`, and an unknown method is `404`.

**Add it** (once): install the CLOADM plugin and **Connect** *CLOADM side panel* ([Use with Claude](#use-with-claude)); or, without the plugin, in claude.ai **Plugins → Add → "Add custom connector"**, name `CLOADM`, URL
`https://mcp.cloadm.dev/mcp`, choose **No sign-in**, then **Add**. On a Team or Enterprise plan an owner may have to add it
under Organization settings → Connectors. Interactive views and app tools are a claude.ai feature that not every
account or organization has yet.

**Use it:**

1. In a chat with the connector enabled, ask Claude to open the emulator (for example "Open CLOADM"). It calls
   **Open CLOADM** (`open_emulator`) and the view appears: a Dragon 64 talking as LIZA, or BASIC if you have added ROMs
   there. If the app keeps the view from reaching cloadm.dev, the view says "This app can't reach cloadm.dev here. Ask
   Claude to open the offline copy." and tells Claude so, and Claude opens **Open CLOADM (offline copy)** instead.
2. Open the view in the side panel (Claude's expand control, or **⋯ → Open in side panel** in the view, offered while
   it is not there already). Click the screen to type on it yourself. The toolbar has **Programs** (what this machine
   runs without ROMs: LIZA, the Welcome menu, and on the 6809 machines the colour demo, 2048 and Minesweeper),
   **Machine** (every model, marked "✓ BASIC ready" or "needs ROMs", then Reset, Switch off and on and Add ROMs…),
   **Sound** ("Sound off" until you click it or the screen: that click starts the sound) and **⋯** (Details, the
   diagnostics, and Copy details). The line under the screen says what runs. While one of Claude's calls acts on the
   machine, the bezel takes Claude's colour and a chip says what it does ("Claude is typing: DIR↵"); a call that only
   reads shows a quiet "Claude read the screen". Your own typing never shows a chip. On a phone or tablet the view
   has on-screen keys under the screen: **Keys | Pad | Stick** (the keyboard; a D-pad with SPACE, ENTER and the game's
   own keys; a stick and FIRE where the machine has a joystick port), with CLEAR and BREAK beside the switch. A game
   opens on the Pad, LIZA on the Keys, and your choice is remembered per program; **⋯ → Hide on-screen keys** hides
   them.
3. In your **next** message, ask for what you want ("type I AM HAPPY and tell me what LIZA says", "play 2048",
   "write a 6809 program that fills the screen and run it"). The view registers its tools after it has loaded, so
   Claude can use them from the next turn, not in the one that opened it. Claude asks you to approve each call.
   **On the Claude iOS app**, set the CLOADM connector's **Permission** to **Manually approve** so Claude can type into
   and run the machine: with the default setting the app blocks every tool that is not read-only without showing a
   prompt (Claude may report that the call needed your approval and none came). Read-only tools work either way. The
   view never sees a call the app blocked, so it cannot warn you itself; the same note is under **Details**.

**The tools in the panel** are the ones in [The tools](#the-tools), with the same names, arguments and results
(`machine_output` with its `untrusted` note included), run by the view on the machine on screen:

* There is one machine, `machine_id` `"m1"`, already on. `boot` and `switch_machine` change it to another model or
  options; `close_machine` is not offered.
* `load` runs the bundled programs by name (`welcome`, `liza`, `demo`, `2048`, `minesweeper`). The panel has no files:
  a `path` is refused with `no-media-root`, and `insert_tape`, `insert_disk`, `save_snapshot` and `restore_snapshot`
  are not offered. Claude's views cannot download, so nothing is saved out of the panel either.
* Your ROM files stay in the panel. Add them with **Add ROMs…** or by dropping the files on the view; they are kept
  in that view's own browser storage, and no tool takes or returns them as files (`add_roms` and `remove_roms` are not
  offered). While they run, `peek`, `find_bytes` and `disassemble` read the ROM areas like any other memory, and what Claude
  reads goes to Anthropic. Each call is still yours to approve. Claude gives each
  conversation's view its own origin, so a new conversation starts without them; reopening the same conversation keeps
  them (in that browser).
* Claude's limits for app tools: a call may run 45 s, and a result may hold 100,000 characters. A tool that runs the
  machine stops after about 25 s of real time, `run_frames` after 3000 frames (call it again to wait longer, as
  everywhere), and a result that would be longer is refused with `too-long`.

Errors the panel adds to the [ones above](#results-and-errors):

| Code | Meaning |
|---|---|
| `too-long` | the result is over 100,000 characters: ask for less (a shorter `peek` or `disassemble`, a narrower `find_bytes`, a smaller screenshot `scale`) |
| `blocked` | the app keeps the view from loading its code from cloadm.dev (`detail` says how): open the offline copy (`open_emulator_inline`) |
| `not-started` | the emulator in the view could not start (`detail` says why) |
| `not-ready` | a call came before the emulator had started, and it did not start within 15 s: call again |
| `out-of-step` | the connector and the cloadm.dev site are from different releases (see below) |

**Two views.** **Open CLOADM** (`open_emulator`, "Opens the CLOADM emulator in a panel beside the chat. Use this
first.") is a small view whose emulator code comes from cloadm.dev (`_meta.ui.csp` declares `https://cloadm.dev` and
nothing else, and the site sends `Access-Control-Allow-Origin: *`). **Open CLOADM (offline copy)**
(`open_emulator_inline`, "Only if Open CLOADM showed a blank or blocked panel: opens a larger copy that doesn't need to
reach cloadm.dev.") carries all of the emulator's code, about 1 MiB, and loads nothing from anywhere.

The small view watches its own load. It counts as blocked when the host's `ui/initialize` answer has
`hostCapabilities.sandbox.csp` without cloadm.dev in its `resourceDomains` (written with or without the scheme or a
trailing slash), when the browser reports a `securitypolicyviolation` for cloadm.dev, when the import of `panel.js`
fails, or when nothing has loaded after about 8 s (unless the host's csp allows cloadm.dev: then it is only slow). The
first and the last are only signs: if `panel.js` loads after all, the view starts, and Claude is told on the same
channel that it loaded and to keep using it. A wait that runs out before the host has answered `ui/initialize` is not
reported until it does, and is dropped unsaid when that answer allows cloadm.dev. Then the status line says "This app can't reach cloadm.dev here. Ask
Claude to open the offline copy.", every tool call answers `blocked`, and Claude is told: by `ui/message` when the host
offers it (`hostCapabilities.message`), else by `ui/update-model-context` when it offers that. **Details** names the
cause and the channel (`blocked: … · reported: message`), and, for every host, its `serverTools` and
`serverResources` capabilities, which say whether a host could call the connector's own tools from inside the view.

**Releases.** The first view loads `connector/view/panel.js` from cloadm.dev, which loads `js/` from beside it, so the
glue between the view and the emulator always comes from the same release of the site as the emulator itself. What
the connector itself carries (the bridge that talks to Claude, and the tool list Claude sees before the emulator has
loaded) is checked against the site's with a version number, `PANEL_API` (`connector/view/tools.js`): when they
differ, the tools answer `out-of-step` rather than half working, and the emulator's own tool list replaces the
connector's as soon as it has loaded. The offline copy has no such dependency. The connector's server and its
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
