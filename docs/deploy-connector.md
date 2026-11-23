# Deploying the side-panel connector

[CLOADM](../README.md) › [MCP server](mcp.md) › Deploying the connector

For the maintainers who run cloadm.dev. The connector that puts CLOADM in Claude's side panel ([Claude on the web: side
panel](mcp.md#claude-on-the-web-side-panel)) is a Cloudflare Worker, `connector/worker/`, served at
`https://mcp.cloadm.dev/mcp`. It is stateless, needs no sign-in, holds no secret and stores and logs nothing: it
answers Claude's MCP requests with two tools and two views, and the emulator then runs in each person's browser.

## What it depends on

* **cloadm.dev serves this release.** The default view (`open_emulator`) loads `connector/view/panel.js` and `js/`
  from `https://cloadm.dev`, so the release must be on the site before the Worker that matches it is deployed. GitHub
  Pages publishes the head of `main`, not a tag: the site is whatever `main` holds now. The build enforces the order:
  it fetches `https://cloadm.dev/connector/view/tools.js` and refuses to build unless the site's `PANEL_API` is the
  checkout's (a first deploy, before the site has the connector, or a deliberate one: `CLOADM_FORCE_DEPLOY=1 npx
  wrangler@latest deploy`, or `node ../build.js --force`). The view's bridge checks `PANEL_API` (`connector/view/tools.js`) against the site's: a
  Worker newer or older than the site in that number answers `out-of-step` until both match. Deploy the Worker after
  each release that changes `connector/` or `PANEL_API`; a release that changes only `js/` needs no redeploy (the
  emulator's own tool list replaces the one the Worker was built with as soon as the view has loaded).
* **The panel's tool list is kept under claude.ai's 8 KB limit for input schemas.** `compactTool` (`connector/view/tools.js`) shortens the
  toolbox's schemas for the panel only (the local MCP server lists them in full); `tests/connector.test.js` compares each
  compact schema with the full one and holds the total to 7,600 bytes, so a new tool or a longer description that passes the
  budget fails the test, and the fix is shorter wording (or a rule in `compactTool`'s `WORDS`).
  **Deploy the Worker again whenever the skill's connector-essentials section changes** (the text between the
  `connector-essentials` markers in `skills/cloadm/SKILL.md`): it is the Worker's MCP `instructions`, copied in by
  `connector/build.js` when the Worker is built (the build prints its sha-256), so a Worker built before the edit keeps
  serving the old text. The Worker holds no copy of its own; `tests/connector.test.js` and `tests/skill.test.js` fail
  when the skill's section and what the build serves differ (the connector test also checks the last generated
  `views.gen.js`), and `.agents/skills/cloadm/` must stay a byte-for-byte copy of `skills/cloadm/`.
* **CORS on the site.** Module scripts are fetched with CORS from the view's origin (`*.claudemcpcontent.com`).
  GitHub Pages sends `Access-Control-Allow-Origin: *`; check it after the release is live:

  ```
  curl -sI https://cloadm.dev/connector/view/panel.js | grep -i -E 'access-control|content-type'
  # access-control-allow-origin: *
  # content-type: application/javascript; charset=utf-8
  ```

* **Node 22.12 or later** where you deploy: wrangler's build step runs `node ../build.js`, which builds both views
  from `connector/view/` and `js/` (it folds the emulator into the offline copy; nothing else is built).

## Deploy

From a checkout of the release:

```
cd connector/worker
npx wrangler@latest login          # once: opens the browser
npx wrangler@latest deploy
```

`deploy` runs the build (it checks the site, then prints the two views' sizes and the version) and uploads the
Worker `cloadm-mcp`. The version the server reports is the checkout's `git describe` (`0.1.8` on the release's tag,
`0.1.8-2-gabc1234` for later work, `-dirty` with uncommitted changes), so deploy from a clean checkout of the tag.
`wrangler.toml` turns Workers Logs off (`[observability] enabled = false`) and has no `workers.dev` address
(`workers_dev = false`). To try it before it has its domain, `npx wrangler@latest dev` serves it on
`http://localhost:8787/mcp`.

## The domain: mcp.cloadm.dev

`wrangler.toml` asks for the custom domain itself (`routes = [{ pattern = "mcp.cloadm.dev", custom_domain = true }]`).
That works when the zone `cloadm.dev` is on the same Cloudflare account. Check where its DNS is:

```
dig +short NS cloadm.dev
```

* **Cloudflare name servers** (`*.ns.cloudflare.com`): `wrangler deploy` adds the custom domain. Cloudflare creates
  the DNS record it needs, a record named `mcp` of type **Worker** (shown as such under DNS → Records; proxied), and
  the certificate. There must be no other record named `mcp` already (delete it first). The same can be done by hand:
  Workers & Pages → `cloadm-mcp` → Settings → Domains & Routes → Add → Custom domain → `mcp.cloadm.dev`.
* **Name servers elsewhere** (the registrar's, for example): a custom domain needs the zone on Cloudflare. A CNAME from
  `mcp.cloadm.dev` to a `workers.dev` address does not work (Workers answer only their own host names there). Add
  `cloadm.dev` to Cloudflare (Websites → Add a site), make sure the records GitHub Pages needs are copied: the apex
  `A` records `185.199.108.153`, `185.199.109.153`, `185.199.110.153`, `185.199.111.153` (and the `AAAA` ones if you use
  them, and `www` if there is one), set to **DNS only** (grey cloud) so GitHub Pages keeps issuing the site's
  certificate, then change the name servers at the registrar to the two Cloudflare gives. Once the zone is active,
  deploy again.

## Verify

```
curl -s -X POST https://mcp.cloadm.dev/mcp \
  -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

The answer lists `open_emulator` and `open_emulator_inline`, each with `_meta.ui.resourceUri`. Also:

```
# serverInfo.version is the checkout's git describe (the tag, on a release)
curl -s -X POST https://mcp.cloadm.dev/mcp -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{}}}'
# the default view declares https://cloadm.dev and nothing else
curl -s -X POST https://mcp.cloadm.dev/mcp -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"resources/read","params":{"uri":"ui://cloadm/panel.html"}}' | grep -o '"csp":{[^}]*}'
# GET is not served (405): the connector is stateless and offers no event stream
curl -s -o /dev/null -w '%{http_code}\n' https://mcp.cloadm.dev/mcp
# the live instructions are the build's: their sha-256 starts with the one `node connector/build.js` printed ("sha256:...")
curl -s -X POST https://mcp.cloadm.dev/mcp -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{}}}' \
  | jq -j .result.instructions | sha256sum | cut -c1-12
```

Then in claude.ai: add the connector as [the guide](mcp.md#claude-on-the-web-side-panel) says, ask "Open CLOADM",
open the view in the side panel, and in the next message ask Claude to type `I AM HAPPY` and say what LIZA answered.
Under the screen the view says what runs ("LIZA is running · Dragon 64 · no ROMs"); open **Details** (in **⋯**, or
beside that line) for the diagnostics: the variant, the host, its display mode and container size (`inline`, or
`fullscreen` in the side panel), the domains it was granted, the storage it has, the sound, what the host asked of it
(`bridge: init … ms, tools/list ×N, calls ×N, list_changed sent, last call screen_text ok 12 ms, size 390×640 ×2`),
and the last load's raw message. **⋯ → Copy details** copies them.

### On a phone

In the Claude app on an iPhone or Android phone, with the same connector:

1. Ask "Open CLOADM". Inline in the chat the whole view shows: the toolbar, the screen at the full width, the
   on-screen keys and the status line (the view tells the app its height, `ui/notifications/size-changed`; Details
   shows `size W×H`).
2. Open it in the side panel or fullscreen (**⋯ → Open in side panel**). Nothing of the toolbar or the screen is under
   the app's title chip or the home bar.
3. Tap **H**, **I**, **ENTER** on the on-screen keys: LIZA shows `> HI` and answers. **Programs → 2048** opens on the
   **Pad**, and its arrows move the tiles; **Stick** shows the stick and FIRE (on a machine with a joystick port); BREAK
   is beside the switch in every mode; **⋯ → Hide on-screen keys** hides them. Close the view and open it again: LIZA
   comes back in the mode you last chose for it.
4. In the next message ask Claude to read the screen. If the call fails, open **Details**: `calls ×0` means the app
   never passed the call to the view (the app's side: say whether it asked you to approve it; on iOS, a call that is not
   read-only is blocked without a prompt unless the connector's Permission is **Manually approve**, which Details also
   says); `last call screen_text
   error <code>` means the view answered it with that error, which names the cause.

## Roll back or remove

`npx wrangler@latest rollback` returns to the previous deployment; `npx wrangler@latest delete` removes the Worker
(and its custom domain). Users then see the connector fail to connect; nothing of theirs is lost, since nothing is kept
on the server.
