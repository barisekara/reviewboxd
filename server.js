import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const PORT = process.env.PORT || 3000;
const ROOT = fileURLToPath(new URL(".", import.meta.url));
const PUBLIC_DIR = join(ROOT, "public");
const CARDS_DIR = join(ROOT, "data", "cards");
const MAX_CARD_BYTES = 3 * 1024 * 1024;
// Where film posters/backdrops come from: "letterboxd" (default) or "tmdb" (needs TMDB_API_KEY).
const POSTER_SOURCE = (process.env.POSTER_SOURCE || "letterboxd").toLowerCase();
const TMDB_API_KEY = process.env.TMDB_API_KEY || "";
// Optional support links shown as tiles in the footer; each is hidden when unset.
const USERNAME_RE = /^[A-Za-z0-9_-]{1,64}$/;
const supportUser = (name) => {
  const v = (process.env[name] || "").trim();
  if (v && !USERNAME_RE.test(v)) console.warn(`${name} has invalid characters; ignoring it.`);
  return USERNAME_RE.test(v) ? v : null;
};
const BMC_USERNAME = supportUser("BMC_USERNAME");
const GITHUB_SPONSORS_USERNAME = supportUser("GITHUB_SPONSORS_USERNAME");
// Company sponsor slots, read from sponsors.json on each request so edits need no restart.
const SPONSORS_FILE = join(ROOT, "sponsors.json");
const SPONSOR_SLOTS = 3;
const isHttpUrl = (v) => typeof v === "string" && /^https?:\/\/[^\s]+$/i.test(v);

async function loadSponsors() {
  let config = {};
  try {
    config = JSON.parse(await readFile(SPONSORS_FILE, "utf8"));
  } catch (err) {
    if (err.code !== "ENOENT") console.warn(`sponsors.json is invalid: ${err.message}`);
  }
  const slots = Array.from({ length: SPONSOR_SLOTS }, (_, i) => {
    const s = (config.slots || [])[i];
    // logo: a file in public/sponsors/ ("acme.svg") or an https URL
    const logo = s && (isHttpUrl(s.logo) ? s.logo : /^[\w.-]+$/.test(s.logo || "") ? `/sponsors/${s.logo}` : null);
    if (!s || !logo || !isHttpUrl(s.url)) return null;
    return { name: String(s.name || "").slice(0, 80), url: s.url, logo };
  });
  const contact = typeof config.contact === "string" && /^(mailto:|https?:\/\/)\S+$/i.test(config.contact)
    ? config.contact
    : null;
  return { contact, slots };
}

// ---------- i18n ----------
// Language order: ?lang= (remembered in a cookie) > cookie > Cloudflare country > Accept-Language > en.

const LANGS = ["en", "fr", "es", "tr", "it"];
const LOCALES_DIR = join(ROOT, "locales");
const COUNTRY_LANG = {
  fr: ["FR", "BE", "LU", "MC", "SN", "CI", "CM", "ML", "BF", "NE", "TG", "BJ", "GA", "CG", "CD", "MG", "GN", "HT", "RE", "GP", "MQ", "GF", "NC", "PF"],
  es: ["ES", "MX", "AR", "CO", "CL", "PE", "VE", "EC", "GT", "CU", "BO", "DO", "HN", "PY", "SV", "NI", "CR", "PA", "UY", "PR", "GQ"],
  tr: ["TR"],
  it: ["IT", "SM", "VA"],
};
const LANG_BY_COUNTRY = Object.fromEntries(
  Object.entries(COUNTRY_LANG).flatMap(([lang, countries]) => countries.map((c) => [c, lang]))
);

function parseCookies(header = "") {
  return Object.fromEntries(
    header.split(";").map((p) => p.trim().split("=")).filter(([k, v]) => k && v).map(([k, v]) => [k, decodeURIComponent(v)])
  );
}

function detectLang(req) {
  const query = new URL(req.url, "http://x").searchParams.get("lang");
  if (LANGS.includes(query)) return { lang: query, fromQuery: true };

  const cookie = parseCookies(req.headers.cookie).lang;
  if (LANGS.includes(cookie)) return { lang: cookie };

  const country = LANG_BY_COUNTRY[String(req.headers["cf-ipcountry"] || "").toUpperCase()];
  if (country) return { lang: country };

  const accepted = String(req.headers["accept-language"] || "")
    .split(",")
    .map((part) => {
      const [tag, q] = part.trim().split(";q=");
      return { lang: tag.slice(0, 2).toLowerCase(), q: q ? Number(q) : 1 };
    })
    .sort((a, b) => b.q - a.q)
    .find((a) => LANGS.includes(a.lang));
  return { lang: accepted ? accepted.lang : "en" };
}

// Read on every request (the files are tiny), so translation edits need no restart.
async function loadLocale(lang) {
  const read = async (l) => {
    try {
      return JSON.parse(await readFile(join(LOCALES_DIR, `${l}.json`), "utf8"));
    } catch (err) {
      console.warn(`locales/${l}.json could not be read: ${err.message}`);
      return {};
    }
  };
  const en = await read("en");
  return lang === "en" ? en : { ...en, ...(await read(lang)) };
}

const fill = (str, vars = {}) => String(str).replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m));

function langHeaders(res, { lang, fromQuery }) {
  res.setHeader("Content-Language", lang);
  res.setHeader("Vary", "Cookie, CF-IPCountry, Accept-Language");
  res.setHeader("Cache-Control", "private, no-cache");
  if (fromQuery) res.setHeader("Set-Cookie", `lang=${lang}; Path=/; Max-Age=31536000; SameSite=Lax`);
}

async function renderIndex(template, req, res) {
  const detected = detectLang(req);
  const { lang } = detected;
  const dict = await loadLocale(lang);
  const names = Object.fromEntries(await Promise.all(LANGS.map(async (l) => [l, (await loadLocale(l)).lang_name || l])));
  const switcher = LANGS.map(
    (l) => `<a href="?lang=${l}" hreflang="${l}" lang="${l}"${l === lang ? ' aria-current="true"' : ""}>${escapeHtml(names[l])}</a>`
  ).join("");
  langHeaders(res, detected);
  return template
    .replace("{{LANG}}", lang)
    .replace("{{TAGLINE}}", escapeHtml(await randomTagline(lang)))
    .replace("{{LANG_SWITCHER}}", switcher)
    .replace("{{I18N}}", JSON.stringify(dict).replace(/</g, "\\u003c"))
    .replace(/\{\{t\.(\w+)(?::([^}]+))?\}\}/g, (_, key, arg) => escapeHtml(fill(dict[key] ?? key, { name: arg })));
}

// Manifesto lines under the logo; one is picked at random per page load. Edit taglines.json freely.
const TAGLINES_FILE = join(ROOT, "taglines.json");
const DEFAULT_TAGLINE = "Turn a Letterboxd review into a poster-worthy pull quote.";

// taglines.json is { "en": [...], "fr": [...] } (a plain array is treated as English).
async function randomTagline(lang) {
  try {
    const data = JSON.parse(await readFile(TAGLINES_FILE, "utf8"));
    const pick = Array.isArray(data) ? (lang === "en" ? data : []) : data[lang]?.length ? data[lang] : data.en;
    const lines = (pick || []).filter((l) => typeof l === "string" && l.trim());
    if (lines.length) return lines[Math.floor(Math.random() * lines.length)];
  } catch (err) {
    if (err.code !== "ENOENT") console.warn(`taglines.json is invalid: ${err.message}`);
  }
  return DEFAULT_TAGLINE;
}

const UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

// ---------- Letterboxd scraping ----------

function decodeEntities(str = "") {
  return str
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;|&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

function htmlToText(html) {
  return decodeEntities(
    html
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/p>\s*<p[^>]*>/gi, "\n\n")
      .replace(/<[^>]+>/g, "")
  )
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function meta(html, key) {
  const re = new RegExp(`<meta (?:property|name)="${key}" content="([^"]*)"`, "i");
  const m = html.match(re);
  return m ? decodeEntities(m[1]) : null;
}

function isLetterboxdUrl(raw) {
  try {
    const u = new URL(raw);
    return /^(www\.)?letterboxd\.com$|^boxd\.it$/.test(u.hostname);
  } catch {
    return false;
  }
}

async function scrapeReview(reviewUrl) {
  const res = await fetch(reviewUrl, {
    headers: { "User-Agent": UA, "Accept-Language": "en-US,en;q=0.9" },
    redirect: "follow",
  });
  if (!res.ok) throw Object.assign(new Error(`Letterboxd responded with ${res.status}`), { code: "fetch" });
  const html = await res.text();

  const ldMatch = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
  if (!ldMatch) throw Object.assign(new Error("Couldn't find review data on that page."), { code: "not_review" });
  const ld = JSON.parse(ldMatch[1].replace(/\/\*\s*<!\[CDATA\[\s*\*\/|\/\*\s*\]\]>\s*\*\//g, ""));
  if (ld["@type"] !== "Review") throw Object.assign(new Error("That link doesn't look like a review."), { code: "not_review" });

  // Review text: prefer the rendered HTML body (keeps paragraphs), fall back to JSON-LD.
  let body = null;
  const bodyMatch = html.match(/<div class="js-review-body"[^>]*>([\s\S]*?)<\/div>/);
  if (bodyMatch) body = htmlToText(bodyMatch[1]);
  if (!body) body = decodeEntities(ld.reviewBody || ld.description || "");

  const film = ld.itemReviewed || {};
  const title = decodeEntities(film.name || "");
  const itemName = html.match(/data-item-name="([^"]*)"/);
  const yearMatch = (itemName ? decodeEntities(itemName[1]) : meta(html, "og:title") || "").match(
    /\((\d{4})\)/
  );

  let poster = film.image ? film.image.replace(/-0-\d+-0-\d+-crop/, "-0-1000-0-1500-crop") : null;

  // og:image is the film backdrop when there is one (wide crop from the "sm/upload" bucket).
  const ogImage = meta(html, "og:image");
  // Ask for the 1920×1080 size: it gets stretched across the whole card.
  let backdrop =
    ogImage && ogImage.includes("/sm/upload/")
      ? ogImage.replace(/-\d+-\d+-\d+-\d+-crop/, "-1920-1920-1080-1080-crop")
      : null;

  let imageSource = "letterboxd";
  if (POSTER_SOURCE === "tmdb" && TMDB_API_KEY && film.sameAs) {
    try {
      const tmdb = await tmdbImages(film.sameAs);
      if (tmdb.poster) {
        poster = tmdb.poster;
        backdrop = tmdb.backdrop || backdrop;
        imageSource = "tmdb";
      }
    } catch (err) {
      console.warn(`TMDB lookup failed for ${film.sameAs}, using Letterboxd images: ${err.message}`);
    }
  }

  const author = (ld.author && ld.author[0]) || {};
  const username = decodeEntities(author.name || meta(html, "twitter:data1") || "");
  const displayMatch = html.match(/class="name">\s*<span>([^<]*)<\/span>/);
  const avatarMatch = html.match(/<a class="avatar[^"]*"[^>]*>\s*<img src="([^"]+)"/);

  return {
    url: ld.url || reviewUrl,
    body,
    rating: ld.reviewRating ? ld.reviewRating.ratingValue : null,
    date: ld.datePublished || null,
    film: {
      title,
      year: yearMatch ? yearMatch[1] : null,
      directors: (film.director || []).map((d) => decodeEntities(d.name)),
      poster,
      backdrop,
      imageSource,
    },
    author: {
      username,
      displayName: displayMatch ? decodeEntities(displayMatch[1].trim()) : username,
      avatar: avatarMatch
        ? avatarMatch[1].replace(/-0-\d+-0-\d+-crop/, "-0-220-0-220-crop")
        : null,
    },
  };
}

// ---------- TMDB (optional poster source) ----------

// Letterboxd film pages carry the TMDB id, so no fuzzy title search is needed.
async function tmdbImages(filmUrl) {
  const res = await fetch(filmUrl, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`film page responded with ${res.status}`);
  const html = await res.text();
  const id = html.match(/data-tmdb-id="(\d+)"/);
  const type = html.match(/data-tmdb-type="(movie|tv)"/);
  if (!id) throw new Error("no TMDB id on film page");

  // Accepts either a v3 API key or a v4 read access token (a JWT, starts with "eyJ").
  const isToken = TMDB_API_KEY.startsWith("eyJ");
  const api = new URL(`https://api.themoviedb.org/3/${type ? type[1] : "movie"}/${id[1]}`);
  api.searchParams.set("language", "en-US");
  if (!isToken) api.searchParams.set("api_key", TMDB_API_KEY);
  const tmdbRes = await fetch(api, {
    headers: isToken ? { Authorization: `Bearer ${TMDB_API_KEY}` } : {},
  });
  if (!tmdbRes.ok) throw new Error(`TMDB responded with ${tmdbRes.status}`);
  const data = await tmdbRes.json();

  const img = (size, path) => (path ? `https://image.tmdb.org/t/p/${size}${path}` : null);
  return { poster: img("w780", data.poster_path), backdrop: img("w1280", data.backdrop_path) };
}

// ---------- HTTP ----------

function sendJson(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}

async function handleReview(req, res, params) {
  const target = (params.get("url") || "").trim();
  if (!isLetterboxdUrl(target)) {
    return sendJson(res, 400, { code: "invalid_url", error: "Paste a letterboxd.com or boxd.it review link." });
  }
  try {
    sendJson(res, 200, await scrapeReview(target));
  } catch (err) {
    sendJson(res, 502, { code: err.code || "fetch", error: err.message || "Failed to fetch review." });
  }
}

// Proxies Letterboxd/TMDB images so the card can be exported as PNG without CORS taint.
async function handleImage(req, res, params) {
  let u;
  try {
    u = new URL(params.get("u"));
  } catch {
    res.writeHead(400).end();
    return;
  }
  if (!/(^|\.)ltrbxd\.com$/.test(u.hostname) && u.hostname !== "image.tmdb.org") {
    res.writeHead(403).end();
    return;
  }
  const upstream = await fetch(u, { headers: { "User-Agent": UA } }).catch(() => null);
  if (!upstream || !upstream.ok) {
    res.writeHead(502).end();
    return;
  }
  res.writeHead(200, {
    "Content-Type": upstream.headers.get("content-type") || "image/jpeg",
    "Cache-Control": "public, max-age=86400",
  });
  res.end(Buffer.from(await upstream.arrayBuffer()));
}

// ---------- shareable card links ----------
// Social sites can't receive an image from a web page directly, so we store the rendered card
// and give it a page with Open Graph tags. X / Bluesky / Facebook then show the card as the link preview.

const escapeHtml = (s = "") =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const clip = (s, n) => (typeof s === "string" ? s.slice(0, n) : "");

function baseUrl(req) {
  const proto = req.headers["x-forwarded-proto"] || "http";
  return `${proto.split(",")[0]}://${req.headers["x-forwarded-host"] || req.headers.host}`;
}

async function readBody(req, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error("Upload too large.");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function handleCreateCard(req, res) {
  let payload;
  try {
    // base64 inflates by ~4/3, plus a little room for the metadata
    payload = JSON.parse(await readBody(req, MAX_CARD_BYTES * 1.4 + 10_000));
  } catch (err) {
    return sendJson(res, 413, { error: err.message || "Invalid upload." });
  }
  const image = Buffer.from(String(payload.image || "").replace(/^data:image\/jpeg;base64,/, ""), "base64");
  const isJpeg = image.length > 3 && image[0] === 0xff && image[1] === 0xd8 && image[2] === 0xff;
  if (!isJpeg || image.length > MAX_CARD_BYTES) return sendJson(res, 400, { error: "Invalid image." });
  if (!isLetterboxdUrl(payload.reviewUrl)) return sendJson(res, 400, { error: "Invalid review link." });

  const id = randomBytes(6).toString("base64url");
  const meta = {
    title: clip(payload.title, 200),
    description: clip(payload.description, 300),
    reviewUrl: payload.reviewUrl,
    created: new Date().toISOString(),
  };
  await mkdir(CARDS_DIR, { recursive: true });
  await writeFile(join(CARDS_DIR, `${id}.jpg`), image);
  await writeFile(join(CARDS_DIR, `${id}.json`), JSON.stringify(meta));
  sendJson(res, 201, { id, url: `${baseUrl(req)}/c/${id}` });
}

async function handleCard(req, res, id, isImage) {
  if (!/^[\w-]{8}$/.test(id)) return res.writeHead(404).end("Not found");
  try {
    if (isImage) {
      const img = await readFile(join(CARDS_DIR, `${id}.jpg`));
      res.writeHead(200, { "Content-Type": "image/jpeg", "Cache-Control": "public, max-age=31536000, immutable" });
      return res.end(img);
    }
    const meta = JSON.parse(await readFile(join(CARDS_DIR, `${id}.json`), "utf8"));
    const base = baseUrl(req);
    const page = `${base}/c/${id}`;
    const img = `${base}/c/${id}.jpg`;
    const app = `${base}/?url=${encodeURIComponent(meta.reviewUrl)}`;
    const detected = detectLang(req);
    const dict = await loadLocale(detected.lang);
    langHeaders(res, detected);
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(`<!doctype html>
<html lang="${detected.lang}"><head>
<meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(meta.title)}</title>
<meta name="description" content="${escapeHtml(meta.description)}" />
<meta property="og:type" content="website" />
<meta property="og:url" content="${escapeHtml(page)}" />
<meta property="og:title" content="${escapeHtml(meta.title)}" />
<meta property="og:description" content="${escapeHtml(meta.description)}" />
<meta property="og:image" content="${escapeHtml(img)}" />
<meta property="og:image:width" content="1600" /><meta property="og:image:height" content="900" />
<meta name="twitter:card" content="summary_large_image" />
<meta name="twitter:image" content="${escapeHtml(img)}" />
<link rel="stylesheet" href="/style.css" />
</head><body class="card-page">
<img class="shared-card" src="${escapeHtml(img)}" alt="${escapeHtml(meta.title)}" />
<p class="card-links"><a href="${escapeHtml(meta.reviewUrl)}" rel="noopener">${escapeHtml(dict.read_full)}</a> · <a href="${escapeHtml(app)}">${escapeHtml(dict.make_own)}</a></p>
</body></html>`);
  } catch {
    res.writeHead(404).end("Not found");
  }
}

async function serveStatic(req, res, pathname) {
  const safe = normalize(pathname === "/" ? "/index.html" : pathname).replace(/^(\.\.[/\\])+/, "");
  const file = join(PUBLIC_DIR, safe);
  if (!file.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end();
    return;
  }
  try {
    let data = await readFile(file);
    if (file === join(PUBLIC_DIR, "index.html")) {
      data = await renderIndex(data.toString(), req, res);
    }
    res.writeHead(200, { "Content-Type": MIME[extname(file)] || "application/octet-stream" });
    res.end(data);
  } catch {
    res.writeHead(404).end("Not found");
  }
}

async function route(req, res) {
  const { pathname, searchParams } = new URL(req.url, `http://${req.headers.host}`);
  if (pathname === "/api/review") return handleReview(req, res, searchParams);
  if (pathname === "/api/config") {
    return sendJson(res, 200, {
      support: {
        coffee: BMC_USERNAME && `https://buymeacoffee.com/${BMC_USERNAME}`,
        sponsor: GITHUB_SPONSORS_USERNAME && `https://github.com/sponsors/${GITHUB_SPONSORS_USERNAME}`,
      },
      sponsors: await loadSponsors(),
    });
  }
  if (pathname === "/img") return handleImage(req, res, searchParams);
  if (pathname === "/api/cards" && req.method === "POST") return handleCreateCard(req, res);
  const card = pathname.match(/^\/c\/([\w-]+?)(\.jpg)?$/);
  if (card) return handleCard(req, res, card[1], Boolean(card[2]));
  return serveStatic(req, res, pathname);
}

createServer(async (req, res) => {
  try {
    await route(req, res);
  } catch (err) {
    console.error(err);
    if (!res.headersSent) res.writeHead(500);
    res.end();
  }
}).listen(PORT, () => {
  console.log(`reviewboxd running at http://localhost:${PORT}`);
  if (POSTER_SOURCE === "tmdb" && !TMDB_API_KEY) {
    console.warn("POSTER_SOURCE=tmdb but TMDB_API_KEY is not set; falling back to Letterboxd images.");
  }
  console.log(`poster source: ${POSTER_SOURCE === "tmdb" && TMDB_API_KEY ? "tmdb" : "letterboxd"}`);
});
