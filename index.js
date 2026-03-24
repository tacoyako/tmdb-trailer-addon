const express = require("express");
const fetch = (...args) =>
  import("node-fetch").then(({ default: f }) => f(...args));
const { exec } = require("child_process");
const { promisify } = require("util");
const execAsync = promisify(exec);

const app = express();
const PORT = process.env.PORT || 7860;

const TMDB_API_KEY = "8852aee2beb868f28f0edbca8079e34d";
const TMDB_BASE = "https://api.themoviedb.org/3";

const MANIFEST = {
  id: "it.tmdb.trailers",
  version: "1.8.0",
  name: "TMDB Trailer ITA",
  description: "Trailer in italiano da The Movie Database (TMDB)",
  logo: "https://www.themoviedb.org/assets/2/v4/logos/v2/blue_square_2-d537fb228cf3ded904ef09b136fe3fec72548ebc1fea3fbbd1ad9e36364db38b.svg",
  resources: [
    { name: "meta", types: ["movie", "series"], idPrefixes: ["tt"] },
  ],
  types: ["movie", "series"],
  idPrefixes: ["tt"],
  catalogs: [],
};

app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "*");
  next();
});

// Cache stream risolti per 4 ore
const streamCache = new Map();
const CACHE_TTL = 1000 * 60 * 60 * 4;

async function resolveYouTubeStream(ytKey) {
  const cached = streamCache.get(ytKey);
  if (cached && Date.now() - cached.ts < CACHE_TTL) {
    console.log("Cache hit per " + ytKey);
    return cached.url;
  }
  try {
    const ytUrl = `https://www.youtube.com/watch?v=${ytKey}`;
    const { stdout } = await execAsync(
      `yt-dlp -f "best[ext=mp4][height<=1080]/best[ext=mp4]/best" --get-url "${ytUrl}"`,
      { timeout: 20000 }
    );
    const url = stdout.trim().split("\n")[0];
    if (url) {
      streamCache.set(ytKey, { url, ts: Date.now() });
      console.log("Stream risolto per " + ytKey);
      return url;
    }
  } catch (e) {
    console.error("yt-dlp error per " + ytKey + ":", e.message);
  }
  return null;
}

async function imdbToTmdb(imdbId, type) {
  const mediaType = type === "series" ? "tv" : "movie";
  const url = `${TMDB_BASE}/find/${imdbId}?api_key=${TMDB_API_KEY}&external_source=imdb_id&language=it-IT`;
  const res = await fetch(url);
  const data = await res.json();
  const results = type === "series" ? data.tv_results : data.movie_results;
  if (!results || results.length === 0) return null;
  return { tmdbId: results[0].id, mediaType };
}

async function getItalianTrailers(tmdbId, mediaType) {
  const itUrl = `${TMDB_BASE}/${mediaType}/${tmdbId}/videos?api_key=${TMDB_API_KEY}&language=it-IT`;
  const itRes = await fetch(itUrl);
  const itData = await itRes.json();
  let videos = (itData.results || []).filter(
    (v) => v.site === "YouTube" && v.type === "Trailer"
  );
  if (videos.length === 0) {
    const enUrl = `${TMDB_BASE}/${mediaType}/${tmdbId}/videos?api_key=${TMDB_API_KEY}&language=en-US`;
    const enRes = await fetch(enUrl);
    const enData = await enRes.json();
    videos = (enData.results || []).filter(
      (v) => v.site === "YouTube" && v.type === "Trailer"
    );
  }
  return videos;
}

async function getTmdbDetails(tmdbId, mediaType) {
  const url = `${TMDB_BASE}/${mediaType}/${tmdbId}?api_key=${TMDB_API_KEY}&language=it-IT`;
  const res = await fetch(url);
  return await res.json();
}

app.get("/manifest.json", (req, res) => {
  res.json(MANIFEST);
});

app.get("/meta/:type/:id.json", async (req, res) => {
  const { type, id } = req.params;
  if (!id.startsWith("tt")) return res.json({ meta: null });

  try {
    const result = await imdbToTmdb(id, type);
    if (!result) return res.json({ meta: null });

    const { tmdbId, mediaType } = result;
    const [details, videos] = await Promise.all([
      getTmdbDetails(tmdbId, mediaType),
      getItalianTrailers(tmdbId, mediaType),
    ]);

    if (videos.length === 0) return res.json({ meta: null });

    const name = details.title || details.name || details.original_title || id;
    const firstVideo = videos[0];
    const streamUrl = await resolveYouTubeStream(firstVideo.key);

    if (!streamUrl) return res.json({ meta: null });

    const meta = {
      id,
      type,
      name,
      links: [
        {
          trailers: streamUrl,
          provider: `▶ ${firstVideo.name || "Trailer ITA"}`,
        },
      ],
    };

    return res.json({ meta });
  } catch (err) {
    console.error("Errore per " + id + ":", err.message);
    return res.status(500).json({ err: err.message });
  }
});

app.listen(PORT, () => {
  console.log("🎬 TMDB Trailer ITA avviato su porta " + PORT);
});
