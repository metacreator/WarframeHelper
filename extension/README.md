# Tenno Trade Helper (Firefox, LibreWolf, Chrome and Edge add-on)

Scan your Warframe inventory from screenshots, see live warframe.market prices, and list or mark items
sold on warframe.market in one click. Everything runs in your browser: there is no server, and your
warframe.market login never leaves your computer except to talk to warframe.market itself.

The page is available in English, Ukrainian, Spanish, and Simplified and Traditional Chinese (🌐 at the top
right), and the scanner reads the game in the same languages.

"Tenno Trade Helper" is a working name. The name shown to users is `extensionName` in
`_locales/*/messages.json` (and the `<title>`/heading in `app.html`). The add-on ID in `manifest.json`
(`tenno-trade-helper@metacreator`) must stay the same after the first public release on addons.mozilla.org,
or existing users won't get updates.

## Try it in LibreWolf or Firefox

1. Open `about:debugging#/runtime/this-firefox`.
2. Click **Load Temporary Add-on…** and pick `extension/manifest.json`.
3. The app opens in a new tab. Later you can open it from the toolbar button (pin it from the puzzle-piece menu).

A temporary add-on is removed when the browser closes. For a permanent install, publish it (below),
or sign it as an unlisted add-on, which gives you an installable `.xpi` file that only you share.

## Try it in Chrome or Edge

1. From the repository root, run `npm run build:chrome`. This makes `dist/chrome/`.
2. Open `chrome://extensions` (Chrome) or `edge://extensions` (Edge) and turn on **Developer mode**.
3. Click **Load unpacked** and pick the `dist/chrome` folder. The app opens in a new tab.

Chrome and Edge need their own package because they run the background script as a service worker; the code
is the same (see `tools/build-chrome.js`). Rebuild after changing anything in `extension/`.

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

## Publishing

Raise `version` in `manifest.json` for every release, and note the changes in `../CHANGELOG.md`.

**addons.mozilla.org (Firefox, LibreWolf; free)**
1. Create a developer account at https://addons.mozilla.org/developers/.
2. From the repository root: `npm run lint`, then `npm run build` (settings are in `web-ext-config.mjs`).
3. **Submit a New Add-on** → "On this site" → upload `dist/tenno_trade_helper-<version>.zip`.
4. When asked about source code: the only minified files are the unmodified third-party libraries listed in
   `vendor/tesseract/SOURCES.md` (tesseract.js 5.1.1, tesseract.js-core 5.1.1, and the @tesseract.js-data
   language packages 1.0.0). Everything else is plain, unbuilt JavaScript, so no build instructions are needed.

**Chrome Web Store (one-time $5 developer registration)** and **Microsoft Edge Add-ons (free)**
1. Register at https://chrome.google.com/webstore/devconsole or https://partner.microsoft.com/dashboard/microsoftedge.
2. `npm run build:chrome`, then upload `dist/tenno_trade_helper-chrome-<version>.zip` to either store.
   Both stores accept the same package.

Listing text and privacy policy for all stores: `STORE_LISTING.md` and `../PRIVACY.md`.

`npm run lint` currently reports no errors and 5 warnings, all about the `Function` constructor inside the
bundled Tesseract library. The page itself never builds HTML from strings: `lib/dom.js` creates elements and
sets text directly, so text from warframe.market or a screenshot can never become markup.

## Testing

From the repository root, against a fake warframe.market (no real account involved):
`npm test` (Firefox, plus a check that every translation is complete), `npm run test:chrome`, `npm run test:edge`.
See `tests/README.md`.

## Translations

Page text is in `locales/<language>.js`: the English text is the key, `{name}` marks a value filled in when
shown, and a few entries have plural forms. Static text in `app.html` is marked `data-i18n` (and
`data-i18n-attr` for tooltips and placeholders); text built in code goes through `t('…')`.
`node tests/check-locales.js` lists anything missing; `--keys` prints every text. The store name and
description are in `_locales/`. Item names come from warframe.market in each language.

The translations were written without a native speaker's review, so corrections are welcome.

## How it works

| File | Role |
| --- | --- |
| `app.html`, `app.js`, `style.css` | The app page (opens in a tab) |
| `scan.js` | Screenshot reading with the bundled Tesseract OCR: game in English, Ukrainian, Spanish or Chinese, stack counts, relic refinement, two screenshots at a time |
| `lib/backend.js` | warframe.market requests (rate-limited to 3/s), caching in `browser.storage.local`, login from the `JWT` cookie, sale detection, price history |
| `lib/dom.js` | Builds page elements without HTML strings |
| `lib/i18n.js`, `locales/` | Page translations |
| `lib/compat.js` | Lets the same code use `browser.*` in Chrome and Edge |
| `background.js` | Toolbar button, opens the app after install, checks for sales every 3 minutes and shows a notification |
| `_locales/` | Add-on name and description in each language (stores, add-on manager) |
| `vendor/tesseract/` | Unmodified OCR library and language data (English, Ukrainian, Spanish, Simplified and Traditional Chinese) |

Permissions: `cookies` + access to `warframe.market` to read your login there; `api.warframe.market` for prices,
trade history and orders; `storage`/`unlimitedStorage` for your list, sales history and the caches; `alarms` and
`notifications` for the background sale check.
