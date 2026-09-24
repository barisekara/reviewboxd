const $ = (id) => document.getElementById(id);

// Translations are injected by the server as window.I18N (see locales/*.json).
const I18N = window.I18N || {};
const t = (key, vars = {}) =>
  String(I18N[key] ?? key).replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m));

const els = {
  form: $("form"), url: $("url"), go: $("go"), status: $("status"),
  workspace: $("workspace"), stage: $("stage"), card: $("card"),
  bgImg: $("bgImg"), posterImg: $("posterImg"), stars: $("stars"),
  quoteBox: $("quoteBox"), quote: $("quote"), avatar: $("avatar"), author: $("author"),
  filmTitle: $("filmTitle"), filmMeta: $("filmMeta"),
  quoteInput: $("quoteInput"), fullReview: $("fullReview"), formats: $("formats"),
  showStars: $("showStars"), showFilm: $("showFilm"), useBackdrop: $("useBackdrop"),
  download: $("download"), share: $("share"), shareHint: $("shareHint"), sourceLink: $("sourceLink"),
  socials: $("socials"), tmdbCredit: $("tmdbCredit"),
};

// Phones that can share image files (iOS Safari, Android Chrome) get a "Share image…" button.
const canShareFiles = (() => {
  try {
    return Boolean(navigator.canShare?.({ files: [new File([""], "x.png", { type: "image/png" })] }));
  } catch {
    return false;
  }
})();

let review = null;

const proxied = (u) => (u ? `/img?u=${encodeURIComponent(u)}` : "");

const segmenter = new Intl.Segmenter("en", { granularity: "sentence" });
const sentences = (text) => [...segmenter.segment(text)].map((s) => s.segment.trim()).filter(Boolean);

// Pick a short, punchy opening excerpt for the pull quote.
function excerpt(text, max = 220) {
  let out = "";
  for (const s of sentences(text.replace(/\n+/g, " "))) {
    if (!out && s.length > max) {
      return s.slice(0, s.lastIndexOf(" ", max)).replace(/[,;:—-]+$/, "") + "…";
    }
    if ((out + " " + s).length > max) break;
    out = out ? `${out} ${s}` : s;
    if (out.length > 80) break;
  }
  return out;
}

function starString(rating) {
  if (rating == null) return "";
  const full = Math.floor(rating);
  return "★".repeat(full) + (rating % 1 ? '<span class="half">½</span>' : "");
}

// kind: "" (info), "error" (red, the user can fix it) or "outage" (calm box, Letterboxd's fault)
function setStatus(msg, kind = "") {
  if (kind === true) kind = "error";
  els.status.textContent = msg;
  els.status.classList.toggle("error", kind === "error");
  els.status.classList.toggle("outage", kind === "outage");
}

// ---------- rendering ----------

function scaleCard() {
  const w = els.card.offsetWidth;
  const h = els.card.offsetHeight;
  const scale = els.stage.clientWidth / w;
  els.card.style.transform = `scale(${scale})`;
  els.stage.style.height = `${h * scale}px`;
}

// Shrink the quote font until it fits its box. Works on the live card or an offscreen copy.
function fitQuote(card) {
  const box = card.querySelector(".quote-box");
  const quote = card.querySelector(".quote");
  let max = card.dataset.format === "wide" ? 96 : 120;
  let min = 26;
  // quote-box uses max-height, so let it grow to its limit before measuring
  box.style.height = getComputedStyle(box).maxHeight;
  while (max - min > 1) {
    const mid = (max + min) / 2;
    quote.style.fontSize = `${mid}px`;
    if (quote.scrollHeight <= box.clientHeight + 1) min = mid;
    else max = mid;
  }
  quote.style.fontSize = `${min}px`;
  box.style.height = "";
}

function renderQuote() {
  const text = els.quoteInput.value.trim();
  els.quote.textContent = text ? `“${text}”` : "";
  fitQuote(els.card);
  invalidateExport();
}

function renderBackground() {
  const { film } = review;
  const wantBackdrop = els.useBackdrop.checked && film.backdrop;
  els.card.classList.toggle("backdrop", Boolean(wantBackdrop));
  els.bgImg.src = proxied(wantBackdrop ? film.backdrop : film.poster || film.backdrop);
  invalidateExport();
}

function render() {
  const { film, author, rating, body } = review;

  renderBackground();
  els.posterImg.src = proxied(film.poster);
  els.stars.innerHTML = starString(rating);
  els.card.classList.toggle("no-stars", !els.showStars.checked || rating == null);
  els.card.classList.toggle("no-film", !els.showFilm.checked);

  els.author.textContent = `— ${author.displayName || author.username}`;
  els.avatar.hidden = !author.avatar;
  if (author.avatar) els.avatar.src = proxied(author.avatar);

  els.filmTitle.textContent = film.title;
  els.filmMeta.textContent = [film.year, film.directors.length && t("card_dir", { names: film.directors.join(", ") })]
    .filter(Boolean)
    .join("  ·  ");

  els.useBackdrop.parentElement.hidden = !film.backdrop;
  els.sourceLink.href = review.url;
  els.tmdbCredit.hidden = film.imageSource !== "tmdb";

  // full review as clickable sentences
  els.fullReview.replaceChildren(
    ...body.split(/\n{2,}/).map((para) => {
      const p = document.createElement("p");
      for (const s of sentences(para)) {
        const span = document.createElement("span");
        span.textContent = s + " ";
        p.append(span);
      }
      return p;
    })
  );

  scaleCard();
  renderQuote();
}

// ---------- events ----------

async function load(url) {
  setStatus(t("fetching"));
  els.go.disabled = true;
  try {
    const res = await fetch(`/api/review?url=${encodeURIComponent(url)}`);
    const data = await res.json();
    if (!res.ok) {
      const err = new Error(I18N[`err_${data.code}`] || data.error || t("generic_error"));
      err.outage = data.code === "fetch";
      throw err;
    }
    review = data;
    els.quoteInput.value = excerpt(data.body) || data.body;
    els.useBackdrop.checked = false;
    els.workspace.hidden = false;
    await document.fonts.ready;
    render();
    setStatus("");
    history.replaceState(null, "", `?url=${encodeURIComponent(url)}&format=${els.card.dataset.format}`);
  } catch (err) {
    setStatus(err.message, err.outage ? "outage" : "error");
  } finally {
    els.go.disabled = false;
  }
}

els.form.addEventListener("submit", (e) => {
  e.preventDefault();
  load(els.url.value.trim());
});

els.quoteInput.addEventListener("input", renderQuote);

els.fullReview.addEventListener("click", (e) => {
  if (e.target.tagName !== "SPAN") return;
  const s = e.target.textContent.trim();
  els.quoteInput.value = e.shiftKey && els.quoteInput.value ? `${els.quoteInput.value.trim()} ${s}` : s;
  renderQuote();
});

els.formats.addEventListener("click", (e) => {
  const btn = e.target.closest("button");
  if (!btn) return;
  for (const b of els.formats.children) b.classList.toggle("active", b === btn);
  els.card.dataset.format = btn.dataset.format;
  els.workspace.dataset.format = btn.dataset.format;
  if (!review) return;
  scaleCard();
  renderQuote();
  history.replaceState(null, "", `?url=${encodeURIComponent(review.url)}&format=${btn.dataset.format}`);
});

for (const el of [els.showStars, els.showFilm]) {
  el.addEventListener("change", () => {
    els.card.classList.toggle("no-stars", !els.showStars.checked || review.rating == null);
    els.card.classList.toggle("no-film", !els.showFilm.checked);
    renderQuote();
  });
}
els.useBackdrop.addEventListener("change", renderBackground);

new ResizeObserver(() => review && scaleCard()).observe(els.stage);

// ---------- export ----------

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const fileName = () =>
  `${slug(review.film.title)}-${slug(review.author.username)}-${els.card.dataset.format}.png`;

let warmedUp = false;
async function renderBlob(card = els.card, toImage = htmlToImage.toBlob) {
  const opts = {
    width: card.offsetWidth,
    height: card.offsetHeight,
    pixelRatio: 1,
    quality: 0.9,
    includeQueryParams: true, // all images share the /img?u= path, so the query must be part of the cache key
    style: { transform: "none" },
  };
  // Safari sometimes drops images on the very first render, so do a throwaway pass once.
  if (!warmedUp) {
    await toImage(card, opts);
    warmedUp = true;
  }
  return toImage(card, opts);
}

// The share sheet must open right after the tap, so we keep a fresh PNG ready in advance.
let cachedBlob = null;
let renderToken = 0;
let prerenderTimer;
function invalidateExport() {
  cachedBlob = null;
  sharedLink = null;
  if (!canShareFiles || !review) return;
  clearTimeout(prerenderTimer);
  prerenderTimer = setTimeout(async () => {
    const token = ++renderToken;
    try {
      const blob = await renderBlob();
      if (token === renderToken) cachedBlob = blob;
    } catch {}
  }, 600);
}

async function withBusy(btn, label, fn) {
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = label;
  try {
    await fn();
  } finally {
    btn.disabled = false;
    btn.textContent = original;
  }
}

els.download.addEventListener("click", () =>
  withBusy(els.download, t("rendering"), async () => {
    try {
      const blob = cachedBlob || (await renderBlob());
      const a = document.createElement("a");
      a.download = fileName();
      a.href = URL.createObjectURL(blob);
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    } catch (err) {
      setStatus(t("export_failed", { error: err.message || err }), true);
    }
  })
);

els.share.addEventListener("click", async () => {
  if (!cachedBlob) {
    // Not ready yet: render now. The browser may then refuse to open the share sheet because
    // too much time passed since the tap, in which case a second tap works instantly.
    await withBusy(els.share, t("preparing"), async () => {
      cachedBlob = await renderBlob();
    });
  }
  try {
    await navigator.share({ files: [new File([cachedBlob], fileName(), { type: "image/png" })] });
    setStatus("");
  } catch (err) {
    if (err.name === "NotAllowedError") setStatus(t("tap_again"));
    else if (err.name !== "AbortError") setStatus(t("share_failed", { error: err.message || err }), true);
  }
});

// ---------- share a link (X, Bluesky, Facebook…) ----------
// Those sites only accept a link, so we upload a wide JPEG of the card and share its page,
// whose preview image is the card.

let sharedLink = null;

async function createShareLink() {
  if (sharedLink) return sharedLink;
  const holder = document.createElement("div");
  holder.style.cssText = "position:fixed;left:-10000px;top:0;";
  const clone = els.card.cloneNode(true);
  clone.removeAttribute("id");
  clone.dataset.format = "wide";
  clone.style.transform = "none";
  holder.append(clone);
  document.body.append(holder);
  try {
    fitQuote(clone);
    const image = await renderBlob(clone, htmlToImage.toJpeg);
    const { film, author } = review;
    const res = await fetch("/api/cards", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        image,
        reviewUrl: review.url,
        title: t("card_title", { film: filmLabel(), author: author.displayName || author.username }),
        description: els.quoteInput.value.trim(),
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || t("upload_failed"));
    sharedLink = data.url;
    return sharedLink;
  } finally {
    holder.remove();
  }
}

const filmLabel = () => `${review.film.title}${review.film.year ? ` (${review.film.year})` : ""}`;

function shareText() {
  const q = els.quoteInput.value.trim().replace(/\s+/g, " ");
  const short = q.length > 180 ? `${q.slice(0, q.lastIndexOf(" ", 177))}…` : q;
  const { author } = review;
  return t("share_text", { quote: short, author: author.displayName || author.username, film: filmLabel() });
}

const enc = encodeURIComponent;
const intents = {
  x: (url, text) => `https://x.com/intent/post?text=${enc(text)}&url=${enc(url)}`,
  bluesky: (url, text) => `https://bsky.app/intent/compose?text=${enc(`${text}\n${url}`)}`,
  threads: (url, text) => `https://www.threads.net/intent/post?text=${enc(`${text}\n${url}`)}`,
  facebook: (url) => `https://www.facebook.com/sharer/sharer.php?u=${enc(url)}`,
  reddit: (url) =>
    `https://www.reddit.com/submit?url=${enc(url)}&title=${enc(t("reddit_title", { film: review.film.title, author: review.author.displayName || review.author.username }))}`,
  whatsapp: (url, text) => `https://wa.me/?text=${enc(`${text}\n${url}`)}`,
};

els.socials.addEventListener("click", async (e) => {
  const btn = e.target.closest("button");
  if (!btn || !review) return;
  const target = btn.dataset.target;
  // Open the window now, while we still have the click; popup blockers reject it after an await.
  const win = target === "copy" ? null : window.open("about:blank", "_blank");
  for (const b of els.socials.children) b.disabled = true;
  setStatus(t("creating_link"));
  try {
    const url = await createShareLink();
    if (target === "copy") {
      await navigator.clipboard.writeText(url);
      setStatus(t("link_copied", { url }));
      return;
    }
    const href = intents[target](url, shareText());
    if (win) win.location.href = href;
    else location.href = href;
    setStatus("");
  } catch (err) {
    win?.close();
    setStatus(t("share_failed", { error: err.message || err }), true);
  } finally {
    for (const b of els.socials.children) b.disabled = false;
  }
});

if (canShareFiles) {
  els.share.hidden = false;
  els.shareHint.hidden = false;
}

// ---------- support tiles ----------

fetch("/api/config")
  .then((r) => r.json())
  .then(({ support, sponsors }) => {
    const tiles = [
      [$("coffeeTile"), support.coffee],
      [$("sponsorTile"), support.sponsor],
    ];
    for (const [tile, href] of tiles) {
      tile.hidden = !href;
      if (href) tile.href = href;
    }
    const anyTile = tiles.some(([, href]) => href);
    $("supportTitle").hidden = !anyTile;
    $("supportTiles").hidden = !anyTile;
    renderSponsorSlots(sponsors);
    $("supportArea").hidden = !sponsors.visible;
  })
  .catch(() => {});

function renderSponsorSlots({ contact, slots }) {
  $("sponsorSlots").replaceChildren(
    ...slots.map((slot) => {
      if (slot) {
        const a = document.createElement("a");
        a.className = "sponsor-slot filled";
        a.href = slot.url;
        a.target = "_blank";
        a.rel = "noopener sponsored";
        a.title = slot.name;
        const img = document.createElement("img");
        img.src = slot.logo;
        img.alt = slot.name;
        a.append(img);
        return a;
      }
      // Empty slot: a link to get in touch when a contact is configured, otherwise just a placeholder.
      const el = document.createElement(contact ? "a" : "div");
      el.className = "sponsor-slot empty";
      if (contact) {
        el.href = contact;
        if (!contact.startsWith("mailto:")) {
          el.target = "_blank";
          el.rel = "noopener";
        }
      }
      const title = document.createElement("strong");
      title.textContent = t("slot_title");
      const sub = document.createElement("small");
      sub.textContent = t("slot_sub");
      el.append(title, sub);
      return el;
    })
  );
}

// ---------- language switcher ----------
// Keep the current review/format when switching language; the server remembers the choice.
for (const a of $("langs").querySelectorAll("a")) {
  a.addEventListener("click", () => {
    const next = new URLSearchParams(location.search);
    next.set("lang", a.hreflang);
    a.href = `?${next}`;
  });
}

// auto-load ?url= (and optional ?format=poster|story|wide)
const params = new URLSearchParams(location.search);
const initial = params.get("url");
// On phones that can share, default to the Stories-sized card.
const startFormat = params.get("format") || (canShareFiles ? "story" : null);
els.formats.querySelector(`[data-format="${startFormat}"]`)?.click();
if (initial) {
  els.url.value = initial;
  load(initial);
}
