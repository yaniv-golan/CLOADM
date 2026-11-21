# Deploying the side-panel connector

[CLOADM](../README.md) › [MCP server](mcp.md) › Deploying the connector

For the owner of cloadm.dev. The connector that puts CLOADM in Claude's side panel ([Claude on the web: side
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
* **CORS on the site.** Module scripts are fetched with CORS from the view's origin (`*.claudemcpcontent.com`).
  GitHub Pages sends `Access-Control-Allow-Origin: *`; check it after the release is live:

  ```
  curl -sI https://cloadm.dev/connector/view/panel.js | grep -i -E 'access-control|content-type'
  # access-control-allow-origin: *
  # content-type: application/javascript; charset=utf-8
  ```

* **Node 22.12 or later** where you deploy: wrangler's build step runs `node ../build.js`, which builds both views
  from `connector/view/` and `js/` (it folds the emulator into the self-contained view; nothing else is built).

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
```

Then in claude.ai: add the connector as [the guide](mcp.md#claude-on-the-web-side-panel) says, ask "Open CLOADM",
open the view in the side panel, and in the next message ask Claude to type `I AM HAPPY` and say what LIZA answered.
The view's status line shows the host, the domains it was granted, the storage it has and what the host asked of it
(`bridge: init … ms, tools/list ×N, calls ×N, list_changed sent`).

## Roll back or remove

`npx wrangler@latest rollback` returns to the previous deployment; `npx wrangler@latest delete` removes the Worker
(and its custom domain). Users then see the connector fail to connect; nothing of theirs is lost, since nothing is kept
on the server.
