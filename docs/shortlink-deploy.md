# Deploying the short-link server (for whoever runs cloadm.dev)

Short links (`https://s.cloadm.dev/<id>#<key>`) are stored by a small Cloudflare Worker and an R2 bucket. The code is
`shortlink/worker.js`; this page is how to put it online. **Nothing in the repository deploys it, and no test reaches
Cloudflare**: the Worker is tested in Node against an in-memory bucket (`tests/shortlink-worker.test.js`) and through the
page with the same Worker standing in for the server (`node tools/browser-check.js --only shortLink`).

Everything is served from **s.cloadm.dev, never from cloadm.dev**: cloadm.dev's origin holds people's ROMs in its
storage (OPFS), and nothing user-made should ever be served from it.

## What it stores

Per link, three objects in the bucket:

| Key | What | Who reads it |
|---|---|---|
| `<id>.bin` | the moment or BASIC program, sealed with AES-GCM in the person's browser (≤ 64 KB): version and kind in its first two bytes, the rest ciphertext (docs/automation.md, "Share links") | the page, `GET https://s.cloadm.dev/<id>.bin` |
| `<id>.png` | the preview picture, only if the person left "Show a preview picture" on: 1200 × 630, indexed, ≤ 16 colours, ≤ 32 KB, only IHDR/PLTE/IDAT/IEND (PLTE first, the IDATs together), and its pixels unpacked to check them: exactly 1200 × 630 of them, filters 0 to 4, every colour in the palette (an inflation bomb is stopped one byte past the size) | link unfurlers |
| `<id>` | the arrival page, from a fixed template (machine name and id only), which goes straight to `https://cloadm.dev/play/#l=<id>.<key>` and sends nothing | people and unfurlers |

The key is never sent: it is the part after `#`. The delete token's SHA-256 is kept in `<id>.bin`'s metadata; the
token itself only in the browser that made the link. **Links never expire**: there is no lifecycle rule, and none
should be added.

Counts, totals only, in `stats/counts.json` (links made, counted once stored; opened; deleted by whoever made them),
and a public page `stats/` that the Worker rewrites with each count. The daily cap counts in an object of its own,
`limits/today.json`, so nothing that writes the totals can slow down or block making a link, and a total that can't be
written is skipped rather than holding up the request. No address, user agent or anything per person is stored.

**Opens** are counted without anything on the read path: no Worker runs on a read and no page sends a ping. Once a day
a Cron Trigger runs the Worker's `scheduled` handler, which asks Cloudflare's GraphQL Analytics API for the zone's
successful `GET`s of `s.cloadm.dev/<id>.bin` (the page fetches a link's moment once per open; cached answers are
counted too, as the zone's HTTP analytics see them) for each UTC day not yet counted, up to yesterday and at most 30
days back, and adds the total. A failed run adds nothing; the next one counts the same days. If the cron stops for more than 30 days, the days before
those 30 are skipped and never counted. The total is approximate: the analytics are sampled, and a browser revalidating
a copy it already has (a 304) is not counted; the stats page says so. The query asks for a count
only, nothing about who.

**Program starts are not counted.** A start counter (for WYRMFIRE) would need the zone's analytics to see the program
page's requests, which only happens when cloadm.dev is served through Cloudflare's proxy. cloadm.dev is served by
GitHub Pages (`CNAME`, `.github/workflows/pages.yml`), so that counter was left out rather than replaced by a beacon. If
cloadm.dev is ever proxied by Cloudflare, the same query on `clientRequestPath: "/wyrmfire/"` would count it.

## Steps

1. **Bucket.** In the Cloudflare dashboard, R2 → Create bucket, e.g. `cloadm-shortlinks`. No lifecycle rule.
2. **Custom domain.** The bucket → Settings → Custom Domains → Connect `s.cloadm.dev`. This serves every object at
   `https://s.cloadm.dev/<key>` straight from R2.
3. **CORS on the bucket.** The page fetches `<id>.bin` from cloadm.dev. Bucket → Settings → CORS policy:

   ```json
   [{ "AllowedOrigins": ["https://cloadm.dev"], "AllowedMethods": ["GET"], "AllowedHeaders": [], "MaxAgeSeconds": 86400 }]
   ```

4. **Cache rule.** Zone cloadm.dev → Caching → Cache Rules → new rule: hostname equals `s.cloadm.dev` and URI path does
   not start with `/api/` → Eligible for cache, Edge TTL: use the origin's Cache-Control (the Worker writes
   `public, max-age=86400` on link objects, `max-age=300` on `stats/`, `max-age=60` on `stats/counts.json`).
5. **Worker.** Copy `shortlink/wrangler.toml.example` to `shortlink/wrangler.toml` (don't commit it), fill in the zone,
   the bucket name, two unique rate-limit namespace ids and the report address, then from `shortlink/`:

   ```
   npx wrangler deploy
   ```

   Wrangler bundles `worker.js` with the one file it imports from the site (`js/media/png.js`). The route
   `s.cloadm.dev/api/*` is the only place the Worker runs. Besides `/api/new` and `/api/delete` it serves the report page,
   `GET /api/report/<id>`: the arrival page's "Report this link" (a mailto to the report address naming the id), or
   "Reporting isn't set up for this server." without one. The play page's arrival card links a short link there (in a
   new tab, with no key); it reads nothing from the bucket. A Worker deployed before this page existed answers that
   address with 405, so redeploy after updating.
6. **Opens.** Make an API token (My Profile → API Tokens → Create Token → Custom) with the one permission **Zone →
   Analytics → Read** on the cloadm.dev zone, and give it to the Worker as a secret (never in `wrangler.toml`):

   ```
   npx wrangler secret put CF_ANALYTICS_TOKEN
   ```

   Put the zone's id (the cloadm.dev zone's Overview page) in `ZONE_ID`, and keep the `[triggers]` cron from the
   example (once a day). Without the token or the zone id, opens are simply not counted.
7. **Check it.** Make a short link on cloadm.dev's Share screen, open it in a private window, and look at
   `https://s.cloadm.dev/stats/`.

## Limits and switches

| What | Where | Default |
|---|---|---|
| A moment's size | `MAX_SEALED` in the Worker (and `Session.SHORT_SEALED_MAX`) | 64 KB |
| The picture | `MAX_PNG`, `PNG_COLOURS` (and `Session.SHORT_PNG`) | 32 KB, 16 colours |
| Per address | `RATE_IP` binding (making and deleting links, counted apart) | 10 a minute |
| Everyone, per minute | `RATE_ALL` binding | 120 a minute |
| Everyone, per day | `DAILY_CAP` var (UTC day, counted in `stats/counts.json`) | 5000 |
| Kill switch | `NEW_LINKS = "off"` (then `npx wrangler deploy`, or set it in the dashboard) | on |

Rate-limit bindings count per Cloudflare location and take only 10- or 60-second periods, so the day's ceiling is the
`DAILY_CAP` counter. The **kill switch** refuses new links with a message (the page shows it beside the button and
offers the long link); existing links stay readable, because reads never run the Worker.

## Removing a link (takedown)

A report ("Report this link" on the arrival page, or on the play page's arrival card, which opens `/api/report/<id>`)
names the id. Remove its three objects:

```
npx wrangler r2 object delete <BUCKET_NAME>/<id> --remote
npx wrangler r2 object delete <BUCKET_NAME>/<id>.bin --remote
npx wrangler r2 object delete <BUCKET_NAME>/<id>.png --remote
```

(`--remote` matters: without it Wrangler 4 deletes from its local development copy and the link stays up.) A takedown
does not change the public totals: "Short links deleted by whoever made them" counts only "Delete this link".

**Cached copies may live up to 1 day after removal** (the cache rule's TTL): there is no purge step. For anything
urgent, flip the kill switch as well, and purge `https://s.cloadm.dev/<id>` by hand in the dashboard (Caching →
Configuration → Custom Purge).

## Storage and cost

Links never expire, so the bucket only grows. Watch R2's storage size in the dashboard: the free tier is 10 GB, then
about $0.015 per GB-month. A typical link is 3 to 8 KB of moment plus up to 32 KB of picture.
