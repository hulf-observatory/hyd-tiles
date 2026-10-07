# hyd-tiles

A small Cloudflare Worker that serves map tiles from PMTiles files kept in the
GitHub Releases of [hulf-observatory/hyderabad-data](https://github.com/hulf-observatory/hyderabad-data).

Browsers cannot read GitHub Release files directly (GitHub sends no CORS header),
so the Worker sits in between: it reads only the bytes a tile needs, caches the
tile at Cloudflare's edge and returns it with CORS. Nothing is stored here; the
Releases stay the single home of the data.

Live at **https://hyd-tiles.hulf-observatory.workers.dev** (free plan: 100,000 requests/day).

## URLs

```
/r/<release>/<file>.pmtiles              download: redirects to the file on GitHub
/r/<release>/<file>.json                 TileJSON (use this as a MapLibre source url)
/r/<release>/<file>/{z}/{x}/{y}.<ext>    one tile; ext = pbf | webp | png | jpg | avif
```

`<release>` is the Release tag (e.g. `2026-10-15`), `<file>` the asset name without
`.pmtiles`. Tiles outside the file's bounds or zoom range return 204.

## Deploy

```bash
npm install
CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... npx wrangler deploy
```

The token needs only the "Edit Cloudflare Workers" template. `GITHUB_REPO` in
`wrangler.toml` limits which repo's releases can be read.

## Credits

Approach borrowed from [ramSeraph/indianopenmaps](https://github.com/ramSeraph/indianopenmaps)
(public domain), rewritten here without the framework and WASM pieces we don't need.
Tile reading by [pmtiles](https://github.com/protomaps/PMTiles) (BSD-3).

## Licence

MIT.
