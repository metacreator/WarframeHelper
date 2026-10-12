# Tenno Trade Helper (Firefox / LibreWolf add-on)

Scan your Warframe inventory from screenshots, see live warframe.market prices, and list or mark items
sold on warframe.market in one click. Everything runs in your browser: there is no server, and your
warframe.market login never leaves your computer except to talk to warframe.market itself.

"Tenno Trade Helper" is a working name. Change `name` in `manifest.json` (and the `<title>`/heading in
`app.html`) before publishing if you want a different one. The add-on ID in `manifest.json`
(`tenno-trade-helper@metacreator`) must stay the same after the first public release, or existing users
won't get updates.

## Try it in LibreWolf or Firefox

1. Open `about:debugging#/runtime/this-firefox`.
2. Click **Load Temporary Add-on…** and pick `extension/manifest.json`.
3. The app opens in a new tab. Later you can open it from the toolbar button (pin it from the puzzle-piece menu).

A temporary add-on is removed when the browser closes. For a permanent install, publish it (below),
or sign it as an unlisted add-on, which gives you an installable `.xpi` file that only you share.

### Logging in

Just log in on [warframe.market](https://warframe.market) in the same browser, with Steam, Google, Discord
or a password. The add-on picks that up automatically and shows "Connected as …". Logging out on the site
disconnects it.

**LibreWolf deletes cookies when it closes** (its default), which logs you out of warframe.market on every
restart. To stay logged in, add an exception: Settings → Privacy & Security → Cookies and Site Data →
Manage Exceptions → enter `https://warframe.market` → **Allow**.

### Moving your data from the old local app

In the add-on, open **Backup → Load backup…** and pick `data/inventory.json` from the old app, then do the
same with `data/sales.json`.

## Publishing on addons.mozilla.org (free)

1. Create a developer account at https://addons.mozilla.org/developers/.
2. Build the package (from the repository root; settings are in `web-ext-config.mjs`):
   ```
   npx web-ext lint
   npx web-ext build
   ```
3. **Submit a New Add-on** → "On this site" → upload `dist/tenno_trade_helper-<version>.zip`.
4. When asked about source code: the only minified files are the unmodified third-party libraries listed in
   `vendor/tesseract/SOURCES.md` (tesseract.js 5.1.1, tesseract.js-core 5.1.1, and the @tesseract.js-data language packages 1.0.0).
   Everything else is plain, unbuilt JavaScript, so no build instructions are needed.
5. Listing text and privacy policy: see `STORE_LISTING.md` and `../PRIVACY.md`.

To release an update, raise `version` in `manifest.json`, rebuild, and upload the new zip.

`npx web-ext lint` currently reports no errors and 5 warnings, all about the `Function` constructor inside the
bundled Tesseract library. The page itself never builds HTML from strings: `lib/dom.js` creates elements and
sets text directly, so text from warframe.market or a screenshot can never become markup.

## Testing

`npm test` from the repository root runs the add-on end to end in Firefox against a fake warframe.market
(no real account involved). See `tests/README.md`.

## How it works

| File | Role |
| --- | --- |
| `app.html`, `app.js`, `style.css` | The app page (opens in a tab) |
| `scan.js` | Screenshot reading with the bundled Tesseract OCR: game in English, Ukrainian, Spanish or Chinese, stack counts, relic refinement, two screenshots at a time |
| `lib/dom.js` | Builds page elements without HTML strings |
| `lib/backend.js` | warframe.market requests (rate-limited to 3/s), caching in `browser.storage.local`, login from the `JWT` cookie, sale detection |
| `background.js` | Toolbar button, opens the app after install, checks for sales every 3 minutes and shows a notification |
| `vendor/tesseract/` | Unmodified OCR library and language data (English, Ukrainian, Spanish, Simplified and Traditional Chinese) |

Permissions: `cookies` + access to `warframe.market` to read your login there; `api.warframe.market` for prices
and orders; `storage`/`unlimitedStorage` for your list, sales history and the price cache; `alarms` and
`notifications` for the background sale check.
