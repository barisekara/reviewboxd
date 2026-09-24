# reviewboxd

Paste a Letterboxd review link and get a movie-poster style testimonial card:
the film poster, the star rating, a pull quote from the review, and the reviewer.

No press pass required. Whether your review is a masterpiece or a mess, it's yours: put it on
a poster and be proud of it.

**No analytics, no tracking, no ads. Just for fun.** See [Privacy](#privacy).

Made by [Barış](https://baris.wtf) · Contributions welcome, see [CONTRIBUTING.md](CONTRIBUTING.md).

<a href="https://buymeacoffee.com/barisekara"><img src="https://cdn.buymeacoffee.com/buttons/v2/default-yellow.png" alt="Buy me a coffee" height="40"></a>

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
{
  "en": [
    { "text": "The full tagline, shown on desktop.", "short": "A short one for phones." },
    "A plain string works too (used everywhere)."
  ],
  "fr": ["..."]
}
```

Taglines are designed to fit in two lines: keep `text` under ~150 characters and `short`
under ~80. No restart needed.

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

## Privacy

reviewboxd is a just-for-fun project and collects nothing about its visitors:

- **No analytics, trackers, ads, accounts or fingerprinting.**
- **Reviews aren't stored.** The server fetches the Letterboxd page when you ask for it and
  forgets it after sending you the result.
- **One cookie:** `lang`, set only when you pick a language in the footer, to remember it.
- **Share links store a card.** If you use the X / Bluesky / Facebook / … buttons, the card
  image, quote, film title, review link and creation date are saved on the server so the link can show a
  preview. Nothing else is attached (no IP address, no identifier).
- **No request logging.** The server only logs errors.

Third parties: fonts load from Google Fonts, and icons plus the image export library load
from jsDelivr, so those services see your IP address when the page loads. Images from
Letterboxd and TMDB go through this server, so those sites don't see you.

If you deploy your own copy behind Cloudflare, note that turning on Cloudflare Web Analytics
or similar features would make the "no analytics" note untrue for your deployment.

## Contributing

Contributions are welcome: bug fixes, new card designs, translation fixes and new languages.
Read [CONTRIBUTING.md](CONTRIBUTING.md) to get started, then open an issue or a pull request.

## Support

If reviewboxd made you smile, you can [buy me a coffee](https://buymeacoffee.com/barisekara).
It helps keep the site online. More of my work is at [baris.wtf](https://baris.wtf).

## Disclaimer

reviewboxd is an independent fan project. It is not affiliated with or endorsed by Letterboxd.
Film posters and backdrops belong to their respective rights holders.

## License

[MIT](LICENSE)
