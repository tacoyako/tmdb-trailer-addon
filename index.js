const express = require(“express”);
const fetch = (…args) =>
import(“node-fetch”).then(({ default: f }) => f(…args));

const app = express();
const PORT = process.env.PORT || 3000;

const TMDB_API_KEY = “8852aee2beb868f28f0edbca8079e34d”;
const TMDB_BASE = “https://api.themoviedb.org/3”;

const MANIFEST = {
id: “it.tmdb.trailers”,
version: “3.0.0”,
name: “TMDB Trailer ITA”,
description: “Trailer in italiano da iTunes + Fandango fallback”,
logo: “https://www.themoviedb.org/assets/2/v4/logos/v2/blue_square_2-d537fb228cf3ded904ef09b136fe3fec72548ebc1fea3fbbd1ad9e36364db38b.svg”,
resources: [
{ name: “meta”, types: [“movie”, “series”], idPrefixes: [“tt”] },
],
types: [“movie”, “series”],
idPrefixes: [“tt”],
catalogs: [],
};

app.use((req, res, next) => {
res.header(“Access-Control-Allow-Origin”, “*”);
res.header(“Access-Control-Allow-Headers”, “*”);
next();
});

// Cache 6 ore
const cache = new Map();
const CACHE_TTL = 1000 * 60 * 60 * 6;

// ─── SOURCE 1: iTunes Store Italia ───────────────────────────────────────────
async function getItunesTrailer(title, year, type) {
try {
const mediaType = type === “series” ? “tvShow” : “movie”;
const query = encodeURIComponent(title);
const url = `https://itunes.apple.com/search?term=${query}&country=it&media=${mediaType}&limit=10&lang=it_it`;
const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
const data = await res.json();

```
if (!data.results || data.results.length === 0) return null;

// Trova il match migliore per anno
let best = data.results[0];
if (year) {
  const match = data.results.find(r => {
    const rYear = (r.releaseDate || "").split("-")[0];
    return rYear === year;
  });
  if (match) best = match;
}

if (!best.previewUrl) return null;

// Converti l'URL preview in M3U8 HD come fa Trailerio
// previewUrl è tipo: https://video-ssl.itunes.apple.com/...
// Proviamo a ottenere la versione HD tramite lookup
const trackId = best.trackId || best.collectionId;
if (trackId) {
  const lookupUrl = `https://itunes.apple.com/lookup?id=${trackId}&country=it`;
  const lookupRes = await fetch(lookupUrl, { signal: AbortSignal.timeout(5000) });
  const lookupData = await lookupRes.json();
  if (lookupData.results?.[0]?.previewUrl) {
    return {
      url: lookupData.results[0].previewUrl,
      provider: "⭐ Apple TV ITA",
      title: lookupData.results[0].trackName || lookupData.results[0].collectionName || title,
    };
  }
}

return {
  url: best.previewUrl,
  provider: "⭐ Apple TV ITA",
  title: best.trackName || best.collectionName || title,
};
```

} catch (e) {
console.error(“iTunes error:”, e.message);
return null;
}
}

// ─── SOURCE 2: Fandango via TMDB ─────────────────────────────────────────────
async function getFandangoTrailer(tmdbId, mediaType) {
try {
// TMDB ha i link a Fandango/IVA nei “release dates” e “watch providers”
// Ma la vera fonte è l’API di Internet Video Archive tramite TMDB
const url = `${TMDB_BASE}/${mediaType}/${tmdbId}/videos?api_key=${TMDB_API_KEY}&language=en-US`;
const res = await fetch(url);
const data = await res.json();

```
const videos = (data.results || []).filter(
  v => v.site === "YouTube" && v.type === "Trailer"
);

if (videos.length === 0) return null;

// Usa Internet Video Archive che Trailerio usa come "Plex 1080p"
// Proviamo a trovare l'URL IVA per questo film
const firstKey = videos[0].key;

// Cerca su IVA tramite TMDB external IDs
const extUrl = `${TMDB_BASE}/${mediaType}/${tmdbId}/external_ids?api_key=${TMDB_API_KEY}`;
const extRes = await fetch(extUrl);
const extData = await extRes.json();
const imdbId = extData.imdb_id;

if (!imdbId) return null;

// Internet Video Archive API
const ivaUrl = `https://www.internetvideoarchive.com/api/videos/?imdb=${imdbId}&format=json&apikey=d10fd2a1c17`;
const ivaRes = await fetch(ivaUrl, { signal: AbortSignal.timeout(8000) });

if (!ivaRes.ok) return null;

const ivaData = await ivaRes.json();
if (!ivaData || !ivaData.Videos || ivaData.Videos.length === 0) return null;

const video = ivaData.Videos[0];
const mp4 = video.Files?.find(f => f.Format === "HD" || f.Format === "SD");

if (!mp4?.URL) return null;

return {
  url: mp4.URL,
  provider: "Plex 1080p",
  title: videos[0].name || "Trailer",
};
```

} catch (e) {
console.error(“Fandango/IVA error:”, e.message);
return null;
}
}

// ─── HELPERS ─────────────────────────────────────────────────────────────────
async function imdbToTmdb(imdbId, type) {
const mediaType = type === “series” ? “tv” : “movie”;
const url = `${TMDB_BASE}/find/${imdbId}?api_key=${TMDB_API_KEY}&external_source=imdb_id&language=it-IT`;
const res = await fetch(url);
const data = await res.json();
const results = type === “series” ? data.tv_results : data.movie_results;
if (!results || results.length === 0) return null;
return { tmdbItem: results[0], mediaType };
}

// ─── ROUTES ──────────────────────────────────────────────────────────────────
app.get(”/manifest.json”, (req, res) => {
res.json(MANIFEST);
});

app.get(”/meta/:type/:id.json”, async (req, res) => {
const { type, id } = req.params;
if (!id.startsWith(“tt”)) return res.json({ meta: null });

const cached = cache.get(id);
if (cached && Date.now() - cached.ts < CACHE_TTL) {
console.log(“Cache hit: “ + id);
return res.json(cached.data);
}

try {
const result = await imdbToTmdb(id, type);
if (!result) return res.json({ meta: null });

```
const { tmdbItem, mediaType } = result;
const title = tmdbItem.title || tmdbItem.name || tmdbItem.original_title || tmdbItem.original_name;
const year = (tmdbItem.release_date || tmdbItem.first_air_date || "").split("-")[0];

console.log(`Cercando trailer per: ${title} (${year})`);

// 1. Prova iTunes IT (trailer italiano)
let trailer = await getItunesTrailer(title, year, type);

// 2. Fallback: Internet Video Archive (inglese ma funziona in-app)
if (!trailer) {
  console.log("iTunes fallito, provo IVA...");
  trailer = await getFandangoTrailer(tmdbItem.id, mediaType);
}

if (!trailer) {
  console.log("Nessun trailer trovato per " + id);
  return res.json({ meta: null });
}

console.log(`✅ Trailer trovato [${trailer.provider}] per ${id}: ${trailer.url.substring(0, 60)}...`);

const response = {
  meta: {
    id,
    type,
    name: trailer.title || title,
    links: [
      {
        trailers: trailer.url,
        provider: trailer.provider,
      },
    ],
  },
};

cache.set(id, { data: response, ts: Date.now() });
return res.json(response);
```

} catch (err) {
console.error(“Errore per “ + id + “:”, err.message);
return res.status(500).json({ err: err.message });
}
});

app.listen(PORT, () => {
console.log(“🎬 TMDB Trailer ITA v3 avviato su porta “ + PORT);
});