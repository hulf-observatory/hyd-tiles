// hyd-tiles: serves map tiles from PMTiles files kept in GitHub Releases.
//
// Browsers cannot read GitHub Release files directly (no CORS header), so this
// Worker sits in between: it reads only the bytes a tile needs, caches the tile
// at Cloudflare's edge and returns it with CORS. Nothing is stored here; the
// Releases stay the single home of the data.
//
//   GET /                                        this text
//   GET /r/<release>/<file>.pmtiles              302 → the file on GitHub (download)
//   GET /r/<release>/<file>.json                 TileJSON for that file
//   GET /r/<release>/<file>/{z}/{x}/{y}.<ext>    one tile (ext: pbf, webp, png, jpg, avif)
//
// <release> is the Release tag (e.g. 2026-10-15), <file> the asset name without
// ".pmtiles". Only files of the configured GitHub repo are reachable.

import { PMTiles, SharedPromiseCache, TileType } from 'pmtiles';

// Header + directory cache shared across requests in this isolate.
const pmCache = new SharedPromiseCache(100, true);
const openFiles = new Map(); // url -> PMTiles | Mosaic

// A layer over GitHub's 2 GB asset limit is uploaded as <id>.mosaic.json plus
// <id>-part0000.pmtiles, … (made by pmtiles_mosaic's partition-basic). The mosaic
// lists each part with the zoom range and bounds it covers; a tile is looked up in
// the first part whose range contains it. Same URLs as a single file.
class Mosaic {
  constructor(url) {
    this.url = url;
    this.ready = null;
  }
  async load() {
    if (!this.ready) {
      this.ready = (async () => {
        const res = await fetch(this.url);
        if (res.status === 404) throw new Error('404 mosaic not found');
        const m = await res.json();
        if (m.version !== 1) throw new Error('unsupported mosaic version');
        this.hdr = m.header;
        this.meta = m.metadata || {};
        this.parts = Object.entries(m.slices).map(([key, s]) => ({
          pm: new PMTiles(new URL(key, this.url).href, pmCache),
          h: s.header,
        }));
      })();
    }
    return this.ready;
  }
  async getHeader() {
    await this.load();
    const h = this.hdr;
    return {
      tileType: h.tile_type, minZoom: h.min_zoom, maxZoom: h.max_zoom,
      minLon: h.min_lon_e7 / 1e7, minLat: h.min_lat_e7 / 1e7, maxLon: h.max_lon_e7 / 1e7, maxLat: h.max_lat_e7 / 1e7,
      centerLon: h.center_lon_e7 / 1e7, centerLat: h.center_lat_e7 / 1e7, centerZoom: h.center_zoom,
    };
  }
  async getMetadata() {
    await this.load();
    return this.meta;
  }
  async getZxy(z, x, y) {
    await this.load();
    // tile bounds in e7 degrees
    const n = 2 ** z;
    const lon = (i) => (i / n) * 360 - 180;
    const lat = (j) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * j) / n))) * 180) / Math.PI;
    const w = Math.round(lon(x) * 1e7), e = Math.round(lon(x + 1) * 1e7);
    const nn = Math.round(lat(y) * 1e7), s = Math.round(lat(y + 1) * 1e7);
    for (const p of this.parts) {
      const h = p.h;
      if (z < h.min_zoom || z > h.max_zoom) continue;
      if (s > h.max_lat_e7 || e > h.max_lon_e7 || nn < h.min_lat_e7 || w < h.min_lon_e7) continue;
      return p.pm.getZxy(z, x, y);
    }
    return undefined;
  }
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
  'Access-Control-Allow-Headers': 'Range',
  'Access-Control-Expose-Headers': 'Content-Length, Content-Range, ETag',
};

const MIME = {
  [TileType.Mvt]: 'application/vnd.mapbox-vector-tile',
  [TileType.Png]: 'image/png',
  [TileType.Jpeg]: 'image/jpeg',
  [TileType.Webp]: 'image/webp',
  [TileType.Avif]: 'image/avif',
};
const EXT = {
  [TileType.Mvt]: ['pbf', 'mvt'],
  [TileType.Png]: ['png'],
  [TileType.Jpeg]: ['jpg', 'jpeg'],
  [TileType.Webp]: ['webp'],
  [TileType.Avif]: ['avif'],
};

const NAME = /^[A-Za-z0-9._-]+$/;

function text(body, status = 200, extra = {}) {
  return new Response(body, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8', ...CORS, ...extra } });
}

function assetUrl(env, release, file) {
  return `https://github.com/${env.GITHUB_REPO}/releases/download/${release}/${file}.pmtiles`;
}

// Open <id>.pmtiles, or fall back to <id>.mosaic.json when the single file is absent.
async function open(url) {
  let p = openFiles.get(url);
  if (p) return p;
  const single = new PMTiles(url, pmCache);
  try {
    await single.getHeader();
    p = single;
  } catch (e) {
    if (!/404|not found/i.test(String(e?.message || e))) throw e;
    p = new Mosaic(url.replace(/\.pmtiles$/, '.mosaic.json'));
    await p.getHeader(); // throws 404 if neither exists
  }
  openFiles.set(url, p);
  return p;
}

async function tileJSON(env, release, file, origin) {
  const p = await open(assetUrl(env, release, file));
  const [h, meta] = await Promise.all([p.getHeader(), p.getMetadata()]);
  const ext = EXT[h.tileType]?.[0] ?? 'bin';
  return {
    tilejson: '3.0.0',
    name: meta.name ?? file,
    description: meta.description,
    attribution: meta.attribution,
    version: meta.version,
    scheme: 'xyz',
    tiles: [`${origin}/r/${release}/${file}/{z}/{x}/{y}.${ext}`],
    vector_layers: meta.vector_layers,
    minzoom: h.minZoom,
    maxzoom: h.maxZoom,
    bounds: [h.minLon, h.minLat, h.maxLon, h.maxLat],
    center: [h.centerLon, h.centerLat, h.centerZoom],
  };
}

async function tile(env, release, file, z, x, y, ext) {
  const p = await open(assetUrl(env, release, file));
  const h = await p.getHeader();
  if (!EXT[h.tileType]?.includes(ext)) return text('wrong tile extension for this file', 404);
  if (z < h.minZoom || z > h.maxZoom) return new Response(null, { status: 204, headers: CORS });
  const r = await p.getZxy(z, x, y); // decompressed by the library
  if (!r) return new Response(null, { status: 204, headers: CORS });
  return new Response(r.data, {
    headers: {
      'Content-Type': MIME[h.tileType],
      'Cache-Control': 'public, max-age=86400, s-maxage=2592000', // releases never change
      ...CORS,
    },
  });
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (request.method !== 'GET' && request.method !== 'HEAD') return text('method not allowed', 405);

    const url = new URL(request.url);
    const parts = url.pathname.split('/').filter(Boolean);

    if (parts.length === 0) {
      return text(
        `hyd-tiles: map tiles from PMTiles files in github.com/${env.GITHUB_REPO} releases\n\n` +
          `  /r/<release>/<file>.pmtiles          download (redirect to GitHub)\n` +
          `  /r/<release>/<file>.json             TileJSON\n` +
          `  /r/<release>/<file>/{z}/{x}/{y}.ext  tile\n`,
      );
    }
    if (parts[0] !== 'r' || parts.length < 3) return text('not found', 404);

    const release = parts[1];
    if (!NAME.test(release)) return text('bad release name', 400);

    // Whole file: hand over to GitHub.
    if (parts.length === 3 && parts[2].endsWith('.pmtiles')) {
      const file = parts[2].slice(0, -'.pmtiles'.length);
      if (!NAME.test(file)) return text('bad file name', 400);
      return Response.redirect(assetUrl(env, release, file), 302);
    }

    try {
      // TileJSON
      if (parts.length === 3 && parts[2].endsWith('.json')) {
        const file = parts[2].slice(0, -'.json'.length);
        if (!NAME.test(file)) return text('bad file name', 400);
        const body = JSON.stringify(await tileJSON(env, release, file, url.origin));
        return new Response(body, {
          headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=3600', ...CORS },
        });
      }

      // Tile
      if (parts.length === 6) {
        const file = parts[2];
        const z = Number(parts[3]);
        const x = Number(parts[4]);
        const m = /^(\d+)\.([a-z0-9]+)$/.exec(parts[5]);
        if (!NAME.test(file) || !Number.isInteger(z) || !Number.isInteger(x) || !m) return text('bad tile path', 400);
        const y = Number(m[1]);

        // Edge cache: a tile of a published release never changes.
        const cache = caches.default;
        const cached = await cache.match(request);
        if (cached) return cached;

        const res = await tile(env, release, file, z, x, y, m[2]);
        if (res.status === 200) ctx.waitUntil(cache.put(request, res.clone()));
        return res;
      }
    } catch (e) {
      // pmtiles throws on 404 from GitHub (missing release/file) and on non-PMTiles bytes.
      const msg = String(e?.message || e);
      if (/404|not found/i.test(msg)) return text('no such release or file', 404);
      if (/magic|header|pmtiles/i.test(msg)) return text('not a PMTiles file', 415);
      return text('upstream error: ' + msg, 502);
    }

    return text('not found', 404);
  },
};
