import { createServer } from "node:http";
import { mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

// Prefix every log line with an ISO timestamp and level (docker logs shows no time by default).
for (const [method, level] of [["log", "INFO "], ["warn", "WARN "], ["error", "ERROR"]]) {
  const original = console[method].bind(console);
  console[method] = (...args) => original(new Date().toISOString(), level, ...args);
}

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
  // The whole support area (donation tiles + sponsor slots) stays hidden unless "visible": true.
  return { visible: config.visible === true, contact, slots };
}

// ---------- i18n ----------
// Language order: ?lang= (remembered in a cookie) > cookie > Cloudflare country > Accept-Language > en.

const LANGS = ["en", "fr", "es", "tr", "it", "de", "pt"];
const LOCALES_DIR = join(ROOT, "locales");
const COUNTRY_LANG = {
  fr: ["FR", "BE", "LU", "MC", "SN", "CI", "CM", "ML", "BF", "NE", "TG", "BJ", "GA", "CG", "CD", "MG", "GN", "HT", "RE", "GP", "MQ", "GF", "NC", "PF"],
  es: ["ES", "MX", "AR", "CO", "CL", "PE", "VE", "EC", "GT", "CU", "BO", "DO", "HN", "PY", "SV", "NI", "CR", "PA", "UY", "PR", "GQ"],
  tr: ["TR"],
  it: ["IT", "SM", "VA"],
  de: ["DE", "AT", "LI"],
  pt: ["BR", "PT", "AO", "MZ", "CV", "GW", "ST", "TL"],
};
const LANG_BY_COUNTRY = Object.fromEntries(
  Object.entries(COUNTRY_LANG).flatMap(([lang, countries]) => countries.map((c) => [c, lang]))
);

function parseCookies(header = "") {
  const decode = (v) => {
    try {
      return decodeURIComponent(v);
    } catch {
      return ""; // a malformed cookie (e.g. set by a sibling subdomain) must not break the page
    }
  };
  return Object.fromEntries(
    header.split(";").map((p) => p.trim().split("=")).filter(([k, v]) => k && v).map(([k, v]) => [k, decode(v)])
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

const indexCsp = (nonce) =>
  [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' https://cdn.jsdelivr.net`,
    "style-src 'self' https://fonts.googleapis.com",
    "font-src https://fonts.gstatic.com",
    "img-src 'self' data: blob: https://cdn.jsdelivr.net",
    // html-to-image fetches fonts and images again to embed them in the exported PNG
    "connect-src 'self' https://fonts.googleapis.com https://fonts.gstatic.com https://cdn.jsdelivr.net",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "object-src 'none'",
  ].join("; ");

async function renderIndex(template, req, res) {
  const detected = detectLang(req);
  const { lang } = detected;
  const dict = await loadLocale(lang);
  const names = Object.fromEntries(await Promise.all(LANGS.map(async (l) => [l, (await loadLocale(l)).lang_name || l])));
  const switcher = LANGS.map(
    (l) => `<a href="?lang=${l}" hreflang="${l}" lang="${l}"${l === lang ? ' aria-current="true"' : ""}>${escapeHtml(names[l])}</a>`
  ).join("");
  langHeaders(res, detected);
  // The only inline script (translations) runs via a per-request nonce; everything else must be a file.
  const nonce = randomBytes(16).toString("base64");
  res.setHeader("Content-Security-Policy", indexCsp(nonce));
  return template
    .replace("{{NONCE}}", nonce)
    .replace("{{LANG}}", lang)
    .replace("{{TAGLINE}}", await (async () => {
      const { text, short } = await randomTagline(lang);
      return `<span class="tl-full">${escapeHtml(text)}</span><span class="tl-short">${escapeHtml(short)}</span>`;
    })())
    .replace("{{LANG_SWITCHER}}", switcher)
    .replace("{{COUNTER}}", (() => {
      if (!posterCount) return `<p id="counter" class="counter" hidden></p>`;
      const { before, number, after } = counterParts(dict, lang, posterCount);
      return `<p id="counter" class="counter">${escapeHtml(before)}<strong>${number}</strong>${escapeHtml(after)}</p>`;
    })())
    .replace("{{I18N}}", JSON.stringify(dict).replace(/</g, "\\u003c"))
    .replace(/\{\{t\.(\w+)(?::([^}]+))?\}\}/g, (_, key, arg) => escapeHtml(fill(dict[key] ?? key, { name: arg })));
}

// Manifesto lines under the logo; one is picked at random per page load. Edit taglines.json freely.
const TAGLINES_FILE = join(ROOT, "taglines.json");
const DEFAULT_TAGLINE = "Turn a Letterboxd review into a poster-worthy pull quote.";

// taglines.json is { "en": [...], "fr": [...] } (a plain array is treated as English).
// Each entry is a string, or { "text": "...", "short": "..." } where "short" is shown on phones.
async function randomTagline(lang) {
  try {
    const data = JSON.parse(await readFile(TAGLINES_FILE, "utf8"));
    const pick = Array.isArray(data) ? data : data[lang]?.length ? data[lang] : data.en;
    const lines = (pick || [])
      .map((l) => (typeof l === "string" ? { text: l } : l))
      .filter((l) => typeof l?.text === "string" && l.text.trim());
    if (lines.length) {
      const { text, short } = lines[Math.floor(Math.random() * lines.length)];
      return { text, short: typeof short === "string" && short.trim() ? short : text };
    }
  } catch (err) {
    if (err.code !== "ENOENT") console.warn(`taglines.json is invalid: ${err.message}`);
  }
  return { text: DEFAULT_TAGLINE, short: DEFAULT_TAGLINE };
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

// Returns a clean https://letterboxd.com/... or https://boxd.it/... URL, or null for anything else.
// Rebuilding the URL (instead of reusing the input) drops other schemes like javascript:,
// credentials, ports, query strings and fragments.
function canonicalLetterboxdUrl(raw) {
  let u;
  try {
    u = new URL(String(raw));
  } catch {
    return null;
  }
  if (!["https:", "http:"].includes(u.protocol) || u.username || u.password || u.port) return null;
  const host = u.hostname.toLowerCase();
  if (host === "letterboxd.com" || host === "www.letterboxd.com") return `https://letterboxd.com${u.pathname}`;
  if (host === "boxd.it") return `https://boxd.it${u.pathname}`;
  return null;
}

// Review pages look like /<user>/film/<slug>/ or /<user>/film/<slug>/<n>/ (repeat viewings).
const isReviewPath = (url) => /^\/[\w.-]+\/film\/[\w-]+\/(\d+\/?)?$/.test(new URL(url).pathname.replace(/\/?$/, "/"));

const fail = (code, message) => Object.assign(new Error(message), { code });

// Error codes the UI translates: invalid_url, not_review, not_found, and "fetch" for anything
// that means Letterboxd itself is down, blocking us, or changed its page layout.
async function scrapeReview(inputUrl) {
  // Letterboxd answers 403 when the trailing slash is missing, so always add it.
  const normalized = new URL(canonicalLetterboxdUrl(inputUrl));
  if (normalized.hostname !== "boxd.it" && !normalized.pathname.endsWith("/")) normalized.pathname += "/";
  const reviewUrl = normalized.href;
  if (new URL(reviewUrl).hostname !== "boxd.it" && !isReviewPath(reviewUrl)) {
    throw fail("not_review", "That link doesn't look like a review.");
  }
  let res;
  try {
    res = await fetch(reviewUrl, {
      headers: { "User-Agent": UA, "Accept-Language": "en-US,en;q=0.9" },
      redirect: "follow",
    });
  } catch (err) {
    throw fail("fetch", `Letterboxd is unreachable: ${err.cause?.code || err.message}`);
  }
  if (res.status === 404) throw fail("not_found", "Review not found.");
  // Letterboxd puts repeat-review pages (/film/<slug>/1/) behind a bot challenge. We don't try to
  // get past it; the same review is in the reviewer's public RSS feed.
  if (res.status === 403 && res.headers.get("cf-mitigated") === "challenge" && isRepeatReview(res.url)) {
    return scrapeRepeatReview(res.url);
  }
  if (!res.ok) throw fail("fetch", `Letterboxd responded with ${res.status}`);
  // boxd.it short links are only checked once we know where they lead
  if (new URL(res.url).hostname !== "letterboxd.com" || !isReviewPath(res.url)) {
    throw fail("not_review", "That link doesn't look like a review.");
  }
  const html = await res.text();

  // A review page without its JSON-LD means Letterboxd changed its layout (or served a block page).
  const ldMatch = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
  if (!ldMatch) throw fail("fetch", "Couldn't find review data on the page; the layout may have changed.");
  let ld;
  try {
    ld = JSON.parse(ldMatch[1].replace(/\/\*\s*<!\[CDATA\[\s*\*\/|\/\*\s*\]\]>\s*\*\//g, ""));
  } catch {
    throw fail("fetch", "Review data on the page is malformed; the layout may have changed.");
  }
  if (ld["@type"] !== "Review") throw fail("not_review", "That link doesn't look like a review.");

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

  const images = await filmImages(largePoster(film.image), backdropFrom(html), film.sameAs);

  const author = (ld.author && ld.author[0]) || {};
  // The JSON-LD "name" is the display name; the username is the first segment of the review URL.
  const username = new URL(res.url).pathname.split("/")[1] || decodeEntities(author.name || "");
  const displayMatch = html.match(/class="name">\s*<span>([^<]*)<\/span>/);

  return {
    url: ld.url || reviewUrl,
    body,
    rating: ld.reviewRating ? ld.reviewRating.ratingValue : null,
    date: ld.datePublished || null,
    film: {
      title,
      year: yearMatch ? yearMatch[1] : null,
      directors: (film.director || []).map((d) => decodeEntities(d.name)),
      ...images,
    },
    author: {
      username,
      displayName: displayMatch ? decodeEntities(displayMatch[1].trim()) : username,
      avatar: avatarFrom(html),
    },
  };
}

// ---------- shared page helpers ----------

// Letterboxd image URLs carry their crop size; ask for bigger versions than the page shows.
const largePoster = (url) => (url ? url.replace(/-0-\d+-0-\d+-crop/, "-0-1000-0-1500-crop") : null);

// og:image is the film backdrop when it's a wide image (films without one fall back to the poster).
// Letterboxd serves backdrops from more than one path, so judge by shape, not by URL.
function backdropFrom(html) {
  const image = meta(html, "og:image");
  const width = Number(meta(html, "og:image:width"));
  const height = Number(meta(html, "og:image:height"));
  if (!image || !(width > height)) return null;
  // Ask for the 1920×1080 size: it gets stretched across the whole card.
  return image.replace(/-\d+-\d+-\d+-\d+-crop/, "-1920-1920-1080-1080-crop");
}

function avatarFrom(html) {
  const m = html.match(/<a class="avatar[^"]*"[^>]*>\s*<img src="([^"]+)"/);
  return m ? m[1].replace(/-0-\d+-0-\d+-crop/, "-0-220-0-220-crop") : null;
}

// Letterboxd images by default; TMDB when POSTER_SOURCE=tmdb (falls back to Letterboxd on failure).
async function filmImages(poster, backdrop, filmUrl) {
  if (POSTER_SOURCE === "tmdb" && TMDB_API_KEY && filmUrl) {
    try {
      const tmdb = await tmdbImages(filmUrl);
      if (tmdb.poster) return { poster: tmdb.poster, backdrop: tmdb.backdrop || backdrop, imageSource: "tmdb" };
    } catch (err) {
      console.warn(`TMDB lookup failed for ${filmUrl}, using Letterboxd images: ${err.message}`);
    }
  }
  return { poster, backdrop, imageSource: "letterboxd" };
}

async function fetchPage(url) {
  const res = await fetch(url, { headers: { "User-Agent": UA, "Accept-Language": "en-US,en;q=0.9" } });
  if (!res.ok) throw new Error(`${new URL(url).pathname} responded with ${res.status}`);
  return res.text();
}

// ---------- repeat reviews (/<user>/film/<slug>/<n>/) via RSS ----------

const isRepeatReview = (url) => /^\/[\w.-]+\/film\/[\w-]+\/\d+\/$/.test(new URL(url).pathname);

const rssTag = (item, tag) => {
  const m = item.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
  return m ? decodeEntities(m[1].replace(/^<!\[CDATA\[|\]\]>$/g, "").trim()) : null;
};

async function scrapeRepeatReview(reviewUrl) {
  const [, user, , slug] = new URL(reviewUrl).pathname.split("/");
  console.log(`Repeat review is behind a challenge, reading ${user}'s RSS feed instead`);

  let xml;
  try {
    xml = await fetchPage(`https://letterboxd.com/${user}/rss/`);
  } catch (err) {
    throw fail("fetch", `RSS feed unavailable: ${err.message}`);
  }
  const item = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)]
    .map((m) => m[1])
    .find((it) => rssTag(it, "link") === reviewUrl);
  // The feed only holds the latest 50 diary entries.
  if (!item) throw fail("too_old", "Repeat review isn't in the reviewer's RSS feed (only the latest 50 entries are).");

  const description = item.match(/<description>([\s\S]*?)<\/description>/)?.[1] || "";
  const html = description.replace(/^\s*<!\[CDATA\[|\]\]>\s*$/g, "");
  const posterSrc = html.match(/<img src="([^"]+)"/)?.[1] || null;
  const body = htmlToText(html.replace(/<p>\s*<img[^>]*>\s*<\/p>/, ""));
  // Diary entries without a review only say "Watched on …".
  if (!body || /^Watched on /.test(body)) throw fail("not_review", "That diary entry has no review text.");

  // The feed has no director, backdrop or avatar: get them from the film page and the first review page.
  const [filmHtml, firstReviewHtml] = await Promise.all([
    fetchPage(`https://letterboxd.com/film/${slug}/`).catch(() => ""),
    fetchPage(`https://letterboxd.com/${user}/film/${slug}/`).catch(() => ""),
  ]);
  let directors = [];
  const ldMatch = filmHtml.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
  if (ldMatch) {
    try {
      const ld = JSON.parse(ldMatch[1].replace(/\/\*\s*<!\[CDATA\[\s*\*\/|\/\*\s*\]\]>\s*\*\//g, ""));
      directors = (ld.director || []).map((d) => decodeEntities(d.name));
    } catch {}
  }
  const images = await filmImages(largePoster(posterSrc), backdropFrom(filmHtml), `https://letterboxd.com/film/${slug}/`);
  const rating = rssTag(item, "letterboxd:memberRating");

  return {
    url: reviewUrl,
    body,
    rating: rating ? Number(rating) : null,
    date: rssTag(item, "letterboxd:watchedDate"),
    film: {
      title: rssTag(item, "letterboxd:filmTitle") || "",
      year: rssTag(item, "letterboxd:filmYear"),
      directors,
      ...images,
    },
    author: {
      username: user,
      displayName: rssTag(item, "dc:creator") || user,
      avatar: avatarFrom(firstReviewHtml),
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
  // Log the call with the key masked, never the real key.
  const shownUrl = api.href.replace(/api_key=[^&]+/, "api_key=***");
  console.log(`TMDB request GET ${shownUrl} film=${new URL(filmUrl).pathname}${isToken ? " auth=bearer" : ""}`);
  const started = Date.now();
  const tmdbRes = await fetch(api, {
    headers: isToken ? { Authorization: `Bearer ${TMDB_API_KEY}` } : {},
  });
  const took = `${Date.now() - started}ms`;
  if (!tmdbRes.ok) {
    const body = (await tmdbRes.text().catch(() => "")).replace(/\s+/g, " ").slice(0, 300);
    console.warn(`TMDB response ${tmdbRes.status} ${took} body=${body}`);
    throw new Error(`TMDB responded with ${tmdbRes.status}`);
  }
  const data = await tmdbRes.json();
  console.log(
    `TMDB response ${tmdbRes.status} ${took} id=${data.id} title=${JSON.stringify(data.title || data.name || "")}` +
      ` poster=${data.poster_path || "none"} backdrop=${data.backdrop_path || "none"}`
  );

  const img = (size, path) => (path ? `https://image.tmdb.org/t/p/${size}${path}` : null);
  return { poster: img("w780", data.poster_path), backdrop: img("w1280", data.backdrop_path) };
}

// ---------- poster counter ----------
// One global number, no per-visitor data. Kept in memory and saved to data/stats.json every few
// seconds (and on shutdown), so it survives restarts through the Docker volume.

const STATS_FILE = join(ROOT, "data", "stats.json");
let posterCount = 0;
let statsDirty = false;
try {
  posterCount = Number(JSON.parse(await readFile(STATS_FILE, "utf8")).posters) || 0;
} catch (err) {
  if (err.code !== "ENOENT") console.warn(`stats.json is invalid, starting the counter at 0: ${err.message}`);
}

async function saveStats() {
  if (!statsDirty) return;
  statsDirty = false;
  try {
    await mkdir(join(ROOT, "data"), { recursive: true });
    // Write then rename, so a crash mid-write can't leave a half-written file.
    await writeFile(`${STATS_FILE}.tmp`, JSON.stringify({ posters: posterCount }));
    await rename(`${STATS_FILE}.tmp`, STATS_FILE);
  } catch (err) {
    statsDirty = true;
    console.warn(`Could not save stats.json: ${err.message}`);
  }
}
setInterval(saveStats, 10_000).unref();

// "1,234 posters generated so far", with the number in <strong>; plural rules per language.
function counterParts(dict, lang, count) {
  const category = new Intl.PluralRules(lang).select(count);
  const template = dict[`counter_${category}`] || dict.counter_other || "{count}";
  const [before, after = ""] = template.split("{count}");
  return { before, number: new Intl.NumberFormat(lang).format(count), after };
}

// ---------- rate limiting ----------
// Each review lookup hits Letterboxd, so limit it per visitor: RATE_LIMIT_PER_MINUTE requests in
// any 60-second window. IPs live only in this in-memory map for a minute; they're never logged.

const RATE_WINDOW_MS = 60_000;
const limitFromEnv = (name, fallback) => Math.max(1, Number(process.env[name]) || fallback);

// Behind Cloudflare the visitor's IP is in CF-Connecting-IP; the socket address is the tunnel/proxy.
// Only trustworthy when the app is reachable solely through Cloudflare (see DEPLOY.md).
function clientIp(req) {
  const ip =
    req.headers["cf-connecting-ip"] ||
    String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() ||
    req.socket.remoteAddress ||
    "";
  return rateKey(String(ip).trim());
}

// One IPv6 user usually controls a whole /64, so count per /64 instead of per address.
function rateKey(ip) {
  if (!ip.includes(":") || /^::ffff:\d+\.\d+\.\d+\.\d+$/i.test(ip)) return ip.replace(/^::ffff:/i, "");
  const [head, tail = ""] = ip.split("::");
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const groups = [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill("0"), ...right];
  return `${groups.slice(0, 4).join(":")}::/64`;
}

// Sliding-window limiter: returns 0 if allowed (and records the hit), otherwise the seconds until
// the next slot frees up. Keys live only in memory for a minute; they're never logged.
function createLimiter(limit) {
  const hits = new Map();
  setInterval(() => {
    const now = Date.now();
    for (const [key, times] of hits) if (times.every((t) => now - t >= RATE_WINDOW_MS)) hits.delete(key);
  }, RATE_WINDOW_MS).unref();
  return (key) => {
    const now = Date.now();
    const recent = (hits.get(key) || []).filter((t) => now - t < RATE_WINDOW_MS);
    if (recent.length >= limit) {
      hits.set(key, recent);
      return Math.ceil((recent[0] + RATE_WINDOW_MS - now) / 1000);
    }
    recent.push(now);
    hits.set(key, recent);
    return 0;
  };
}

const lookupLimiter = createLimiter(limitFromEnv("RATE_LIMIT_PER_MINUTE", 5));
const cardLimiter = createLimiter(limitFromEnv("CARD_RATE_LIMIT_PER_MINUTE", 5));
const imageLimiter = createLimiter(limitFromEnv("IMAGE_RATE_LIMIT_PER_MINUTE", 120));

function tooMany(res, retryAfter) {
  res.logNote = `${res.logNote ? `${res.logNote} ` : ""}code=rate_limited`;
  res.setHeader("Retry-After", retryAfter);
  sendJson(res, 429, { code: "rate_limited", error: "Too many requests, try again shortly." });
}

// ---------- HTTP ----------

function sendJson(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}

async function handleReview(req, res, params) {
  const raw = (params.get("url") || "").trim();
  res.logNote = `url=${raw.slice(0, 200)}`;
  const target = canonicalLetterboxdUrl(raw);
  if (!target) {
    res.logNote += " code=invalid_url";
    return sendJson(res, 400, { code: "invalid_url", error: "Paste a letterboxd.com or boxd.it review link." });
  }
  // Only lookups that would reach Letterboxd count towards the limit.
  const retryAfter = lookupLimiter(clientIp(req));
  if (retryAfter) {
    res.logNote += " code=rate_limited";
    res.setHeader("Retry-After", retryAfter);
    return sendJson(res, 429, { code: "rate_limited", error: "Too many lookups, try again shortly." });
  }
  try {
    const review = await scrapeReview(target);
    posterCount++;
    statsDirty = true;
    sendJson(res, 200, { ...review, posterCount });
  } catch (err) {
    const code = err.code || "fetch";
    res.logNote += ` code=${code}`;
    if (code === "fetch") console.warn(`Review fetch failed: ${err.message}`);
    sendJson(res, code === "fetch" ? 502 : 400, { code, error: err.message || "Failed to fetch review." });
  }
}

// Proxies Letterboxd/TMDB images so the card can be exported as PNG without CORS taint.
const PROXY_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif", "image/avif"];
const MAX_PROXY_BYTES = 10 * 1024 * 1024;

async function handleImage(req, res, params) {
  let u;
  try {
    u = new URL(params.get("u"));
  } catch {
    res.writeHead(400).end();
    return;
  }
  const allowedHost = /(^|\.)ltrbxd\.com$/.test(u.hostname) || u.hostname === "image.tmdb.org";
  if (u.protocol !== "https:" || u.port || u.username || !allowedHost) {
    res.writeHead(403).end();
    return;
  }
  const retryAfter = imageLimiter(clientIp(req));
  if (retryAfter) return tooMany(res, retryAfter);

  const upstream = await fetch(u, { headers: { "User-Agent": UA } }).catch(() => null);
  const type = (upstream?.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  // Only raster images: never relay HTML, SVG or scripts from another host under our origin.
  if (!upstream || !upstream.ok || !PROXY_TYPES.includes(type)) {
    res.writeHead(502).end();
    return;
  }
  const body = Buffer.from(await upstream.arrayBuffer());
  if (body.length > MAX_PROXY_BYTES) {
    res.writeHead(502).end();
    return;
  }
  res.writeHead(200, {
    "Content-Type": type,
    "Cache-Control": "public, max-age=86400",
    "Content-Security-Policy": "default-src 'none'; sandbox",
  });
  res.end(body);
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

// Cap total share-card storage so uploads can't fill the disk (default 1 GB).
const MAX_CARDS_BYTES = Math.max(1, Number(process.env.MAX_CARDS_STORAGE_MB) || 1024) * 1024 * 1024;
let cardsBytes = null; // computed lazily from disk, then kept up to date

async function cardsStorageUsed() {
  if (cardsBytes === null) {
    cardsBytes = 0;
    const files = await readdir(CARDS_DIR).catch(() => []);
    for (const f of files) cardsBytes += (await stat(join(CARDS_DIR, f)).catch(() => ({ size: 0 }))).size;
  }
  return cardsBytes;
}

async function handleCreateCard(req, res) {
  const retryAfter = cardLimiter(clientIp(req));
  if (retryAfter) return tooMany(res, retryAfter);
  if ((await cardsStorageUsed()) >= MAX_CARDS_BYTES) {
    console.warn(`Share-card storage is full (${Math.round(cardsBytes / 1048576)} MB); rejecting uploads`);
    return sendJson(res, 507, { code: "storage_full", error: "Share links are unavailable right now." });
  }
  let payload;
  try {
    // base64 inflates by ~4/3, plus a little room for the metadata
    payload = JSON.parse(await readBody(req, MAX_CARD_BYTES * 1.4 + 10_000));
  } catch (err) {
    return sendJson(res, 413, { error: err.message || "Invalid upload." });
  }
  if (!payload || typeof payload !== "object" || typeof payload.image !== "string") {
    return sendJson(res, 400, { error: "Invalid upload." });
  }
  const image = Buffer.from(payload.image.replace(/^data:image\/jpeg;base64,/, ""), "base64");
  const isJpeg = image.length > 3 && image[0] === 0xff && image[1] === 0xd8 && image[2] === 0xff;
  if (!isJpeg || image.length > MAX_CARD_BYTES) return sendJson(res, 400, { error: "Invalid image." });
  const reviewUrl = canonicalLetterboxdUrl(payload.reviewUrl);
  if (!reviewUrl) return sendJson(res, 400, { error: "Invalid review link." });

  const id = randomBytes(6).toString("base64url");
  const meta = {
    title: clip(payload.title, 200),
    description: clip(payload.description, 300),
    reviewUrl,
    created: new Date().toISOString(),
  };
  const metaJson = JSON.stringify(meta);
  await mkdir(CARDS_DIR, { recursive: true });
  await writeFile(join(CARDS_DIR, `${id}.jpg`), image);
  await writeFile(join(CARDS_DIR, `${id}.json`), metaJson);
  cardsBytes += image.length + Buffer.byteLength(metaJson);
  res.logNote = `card=${id}`;
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
    // Re-check stored links: cards saved by older versions may hold unsafe URLs.
    const reviewUrl = canonicalLetterboxdUrl(meta.reviewUrl) || "https://letterboxd.com/";
    const app = `${base}/?url=${encodeURIComponent(reviewUrl)}`;
    const detected = detectLang(req);
    const dict = await loadLocale(detected.lang);
    langHeaders(res, detected);
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'none'; img-src 'self'; style-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"
    );
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
<p class="card-links"><a href="${escapeHtml(reviewUrl)}" rel="noopener">${escapeHtml(dict.read_full)}</a> · <a href="${escapeHtml(app)}">${escapeHtml(dict.make_own)}</a></p>
<p class="legal">${escapeHtml(dict.legal)}</p>
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
    // Public by design (the footer needs it), but reveals nothing while the support area is hidden.
    const sponsors = await loadSponsors();
    if (!sponsors.visible) {
      return sendJson(res, 200, {
        support: { coffee: null, sponsor: null },
        sponsors: { visible: false, contact: null, slots: sponsors.slots.map(() => null) },
      });
    }
    return sendJson(res, 200, {
      support: {
        coffee: BMC_USERNAME && `https://buymeacoffee.com/${BMC_USERNAME}`,
        sponsor: GITHUB_SPONSORS_USERNAME && `https://github.com/sponsors/${GITHUB_SPONSORS_USERNAME}`,
      },
      sponsors,
    });
  }
  if (pathname === "/img") return handleImage(req, res, searchParams);
  if (pathname === "/api/cards" && req.method === "POST") return handleCreateCard(req, res);
  const card = pathname.match(/^\/c\/([\w-]+?)(\.jpg)?$/);
  if (card) return handleCard(req, res, card[1], Boolean(card[2]));
  return serveStatic(req, res, pathname);
}

// Request log without IPs or identifiers. Static files, image proxy and config calls are skipped as noise.
const isLoggedPath = (p) => p === "/" || p.startsWith("/api/review") || p.startsWith("/api/cards") || p.startsWith("/c/");

const server = createServer(async (req, res) => {
  const started = Date.now();
  // Baseline headers for every response; HTML pages add a full Content-Security-Policy.
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Content-Security-Policy", "frame-ancestors 'none'; base-uri 'none'; object-src 'none'");
  const path = (req.url || "/").split("?")[0];
  if (isLoggedPath(path)) {
    res.on("finish", () => {
      // Escape control characters so user input (like the review link) can't forge log lines.
      const note = res.logNote ? ` ${res.logNote.replace(/[\x00-\x1f\x7f]/g, (c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, "0")}`)}` : "";
      console.log(`${req.method} ${path} ${res.statusCode} ${Date.now() - started}ms${note}`);
    });
  }
  try {
    await route(req, res);
  } catch (err) {
    console.error(err);
    if (!res.headersSent) res.writeHead(500);
    res.end();
  }
});

// Docker sends SIGTERM on stop; close cleanly instead of waiting to be killed.
for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => server.close(async () => {
    await saveStats();
    process.exit(0);
  }));
}

server.listen(PORT, () => {
  console.log(`reviewboxd running at http://localhost:${PORT}`);
  if (POSTER_SOURCE === "tmdb" && !TMDB_API_KEY) {
    console.warn("POSTER_SOURCE=tmdb but TMDB_API_KEY is not set; falling back to Letterboxd images.");
  }
  console.log(`poster source: ${POSTER_SOURCE === "tmdb" && TMDB_API_KEY ? "tmdb" : "letterboxd"}`);
});
