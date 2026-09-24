# reviewboxd

Paste a Letterboxd review link and get a movie-poster style testimonial card:
the film poster, the star rating, a pull quote from the review, and the reviewer.

## Run

```sh
npm start        # or: npm run dev (auto-restart on change)
```

Open http://localhost:3000. No dependencies, just Node 22.9+.

## Configuration

Copy `.env.example` to `.env` (it's loaded automatically) or set real environment variables:

| Variable | Default | |
|---|---|---|
| `POSTER_SOURCE` | `letterboxd` | `letterboxd` or `tmdb`: where posters and backdrops come from |
| `TMDB_API_KEY` | none | Required for `tmdb`. v3 API key or v4 read access token |
| `BMC_USERNAME` | none | Shows a "Buy me a coffee" tile linking to buymeacoffee.com/&lt;name&gt; |
| `GITHUB_SPONSORS_USERNAME` | none | Shows a "Become a sponsor" tile linking to github.com/sponsors/&lt;name&gt; |
| `PORT` | `3000` | |

With `tmdb`, the TMDB id is read from the Letterboxd film page (no title guessing). If the
key is missing or a lookup fails, that film falls back to Letterboxd images and the server
logs a warning. Review text and avatars always come from Letterboxd. The UI shows TMDB's
required attribution when TMDB images are used.

## How it works

- `server.js` fetches the review page server-side, because the browser can't fetch it
  directly (CORS). It reads the page's JSON-LD and meta tags (text, rating, film, poster,
  director, reviewer, avatar). It also proxies images through `/img` so the card can be
  exported as a PNG.
- `public/` is a vanilla HTML/CSS/JS front end. The card is laid out at its real export
  size (1080×1350, 1080×1920 or 1600×900) and scaled down for the preview. Download PNG
  uses [html-to-image](https://github.com/bubkoo/html-to-image).

## Languages

English, French, Spanish, Turkish and Italian. The language is chosen in this order:

1. `?lang=xx` (from the footer switcher), remembered in a `lang` cookie
2. the `lang` cookie
3. Cloudflare's `CF-IPCountry` header (country → language map in `server.js`)
4. the browser's `Accept-Language`
5. English

UI text lives in `locales/<lang>.json`; missing keys fall back to English. The server fills
translations into the page, so there's no flash of English. Edits apply without a restart.
HTML responses send `Vary: Cookie, CF-IPCountry, Accept-Language` and `Cache-Control: private`,
so don't add a Cloudflare cache rule that caches HTML.

## Taglines

The line under the logo is picked at random from `taglines.json` on every page load, from the
visitor's language (falling back to English):

```json
{ "en": ["..."], "fr": ["..."], "es": ["..."], "tr": ["..."], "it": ["..."] }
```

No restart needed.

## Sponsor slots

The footer has three company sponsor slots, configured in `sponsors.json`. The file is re-read
on every request, so there's no restart needed. Empty slots (`null`) show a "Your logo here"
placeholder. If `contact` is set (`mailto:` or `https://`), empty slots link to it.

```json
{
  "contact": "mailto:you@example.com",
  "slots": [
    { "name": "Acme", "url": "https://acme.com", "logo": "acme.svg" },
    null,
    null
  ]
}
```

`logo` is a file in `public/sponsors/` or a full `https://` image URL. Logos in light colors
(or white) suit the dark background best.

## Sharing

- **Phones:** "Share image…" opens the system share sheet with the PNG attached
  (Instagram Stories, X, WhatsApp, etc.). This needs HTTPS.
- **Everywhere:** the X / Bluesky / Threads / Facebook / Reddit / WhatsApp / copy-link buttons
  upload a wide JPEG of the card to the server (`data/cards/`). They share a `/c/<id>` page whose
  Open Graph preview image is the card. Previews only work when the site is publicly reachable.

Share a preset by link: `/?url=<review link>&format=poster|story|wide`.

This depends on scraping Letterboxd's HTML, so it can break if they change their markup.

## Disclaimer

reviewboxd is an independent fan project. It is not affiliated with or endorsed by Letterboxd.
Film posters and backdrops belong to their respective rights holders.

## License

[MIT](LICENSE)
