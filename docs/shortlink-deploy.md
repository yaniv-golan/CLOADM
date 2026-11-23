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
| `<id>.bin` | the moment, sealed with AES-GCM in the person's browser (≤ 64 KB) | the page, `GET https://s.cloadm.dev/<id>.bin` |
| `<id>.png` | the preview picture, only if the person left "Show a preview picture" on: 1200 × 630, indexed, ≤ 16 colours, ≤ 32 KB, only IHDR/PLTE/IDAT/IEND | link unfurlers |
| `<id>` | the arrival page, from a fixed template (machine name and id only), which counts the open and goes to `https://cloadm.dev/play/#l=<id>.<key>` | people and unfurlers |

The key is never sent: it is the part after `#`. The delete token's SHA-256 is kept in `<id>.bin`'s metadata; the
token itself only in the browser that made the link. **Links never expire**: there is no lifecycle rule, and none
should be added.

Counts, totals only, in `stats/counts.json` (links made, opened, removed; starts of programs in `COUNTED_STARTS`), and
a public page `stats/` that the Worker rewrites with each count. No address, user agent or anything per person is
stored. Opens are counted by the arrival page's one `POST /api/opened` (no id in it), so reads stay Worker-free.

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
   `s.cloadm.dev/api/*` is the only place the Worker runs.
6. **Check it.** Make a short link on cloadm.dev's Share screen, open it in a private window, and look at
   `https://s.cloadm.dev/stats/`.

## Limits and switches

| What | Where | Default |
|---|---|---|
| A moment's size | `MAX_SEALED` in the Worker (and `Session.SHORT_SEALED_MAX`) | 64 KB |
| The picture | `MAX_PNG`, `PNG_COLOURS` (and `Session.SHORT_PNG`) | 32 KB, 16 colours |
| Per address | `RATE_IP` binding | 10 a minute |
| Everyone, per minute | `RATE_ALL` binding | 120 a minute |
| Everyone, per day | `DAILY_CAP` var (UTC day, counted in `stats/counts.json`) | 5000 |
| Kill switch | `NEW_LINKS = "off"` (then `npx wrangler deploy`, or set it in the dashboard) | on |

Rate-limit bindings count per Cloudflare location and take only 10- or 60-second periods, so the day's ceiling is the
`DAILY_CAP` counter. The **kill switch** refuses new links with a message (the page shows it beside the button and
offers the long link); existing links stay readable, because reads never run the Worker.

## Removing a link (takedown)

A report ("Report this link" on the arrival page) names the id. Remove its three objects:

```
npx wrangler r2 object delete <BUCKET_NAME>/<id>
npx wrangler r2 object delete <BUCKET_NAME>/<id>.bin
npx wrangler r2 object delete <BUCKET_NAME>/<id>.png
```

**Cached copies may live up to 1 day after removal** (the cache rule's TTL): there is no purge step. For anything
urgent, flip the kill switch as well, and purge `https://s.cloadm.dev/<id>` by hand in the dashboard (Caching →
Configuration → Custom Purge).

## Storage and cost

Links never expire, so the bucket only grows. Watch R2's storage size in the dashboard: the free tier is 10 GB, then
about $0.015 per GB-month. A typical link is 3 to 8 KB of moment plus up to 32 KB of picture.
