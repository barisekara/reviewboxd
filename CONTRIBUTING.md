# Contributing to reviewboxd

Thanks for helping out! Bug reports, fixes, design ideas and translations are all welcome.

## Getting started

You need Node 22.9 or newer. There are no dependencies to install.

```sh
git clone https://github.com/barisekara/reviewboxd.git
cd reviewboxd
cp .env.example .env   # optional, defaults work
npm run dev            # restarts on changes to server.js
```

Open http://localhost:3000 and paste any Letterboxd review link.

## Project layout

| Path | What it does |
|---|---|
| `server.js` | Plain Node HTTP server: scrapes the review, proxies images, fills in translations, stores share cards |
| `public/index.html` | The page. `{{t.key}}` placeholders are replaced with translations by the server |
| `public/app.js` | Card rendering, quote fitting, export and sharing |
| `public/style.css` | All styles, including the card layouts |
| `locales/*.json` | UI translations, one file per language |
| `taglines.json` | Random taglines under the logo, per language |
| `sponsors.json` | Company sponsor slots in the footer |

## Ground rules

- **Keep it dependency-free.** The server uses only Node built-ins, and the front end is
  vanilla HTML/CSS/JS. If you think something really needs a package, open an issue first.
- **Match the existing style:** 2-space indent, double quotes, small functions, comments only
  where the *why* isn't obvious.
- **Check it in a browser.** Load a real review and try all three formats (poster, story,
  wide), plus Download PNG, before opening a PR. Include a screenshot if you changed anything
  visual.
- **One change per pull request.** Small PRs get reviewed faster.

## Adding a quote style

Quote styles (Classic, Blockbuster, Festival, Handwritten) are mostly CSS, which makes a new one a
good first contribution:

1. Add a button to the `#styles` picker in `public/index.html`, with a `style_<name>` label in
   every `locales/*.json`.
2. Add `.card[data-style="<name>"]` rules in `public/style.css`, next to the other styles.
3. Add the name to the allowed list at the bottom of `public/app.js`. If it uses a new Google Font,
   add the font to the stylesheet link in `index.html` and to `STYLE_FONTS` in `app.js`.
4. Check all three formats with a short and a long quote, and download a PNG of each. Fonts and
   graphics must also appear in the exported image.

## Translations

Fixes to existing translations are very welcome, especially from native speakers.
Edit `locales/<lang>.json` and the matching list in `taglines.json`.

### Adding a new language

1. Copy `locales/en.json` to `locales/<code>.json` (a two-letter code like `de`) and translate
   every value. Keep `{placeholders}` exactly as they are.
2. Add a list of taglines for the language to `taglines.json`.
3. In `server.js`, add the code to `LANGS` and the countries that should default to it to
   `COUNTRY_LANG`.
4. Check the page with `?lang=<code>`, including a loaded review card.

## Security issues

Please don't report security problems in public issues. See [SECURITY.md](SECURITY.md) for how to
report them privately.

## Reporting bugs

Open an [issue](https://github.com/barisekara/reviewboxd/issues/new/choose) with the review link
that fails, what you expected and what happened. Letterboxd changes its page markup now and then,
so "this review link doesn't load" reports are useful.

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
