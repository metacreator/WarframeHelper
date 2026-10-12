# Tests

```
npm install
npm test               # Firefox, plus the translation check
npm run test:chrome    # Chrome (Chrome for Testing, downloaded once by Selenium)
npm run test:edge      # Microsoft Edge
```

Each run installs the add-on in a real, headless browser and checks the whole flow end to end: login detection,
listing, "List qty", sold tracking, sales made on the website, repricing, hiding listings, Baro, type groups,
rank and price safety checks, price history, combining sets, backups, page translations, and screenshot
scanning, including two real in-game inventory screenshots and one screenshot per supported game language.
A run takes about 3 minutes and needs the browser installed (Chrome is downloaded) and an internet connection.
Set `FIREFOX_BIN` to test another Firefox-based browser.

Chrome itself no longer loads unpacked add-ons from the command line, so `test:chrome` uses Chrome for
Testing, the build Google publishes for automated tests.

**No real account is used.** `mock-wfm.js` stands in for warframe.market: everything tied to an account
(your profile, your orders, creating/closing orders) is faked, and only public read-only data (items, prices,
trade history) comes from the real API.

| File | What it is |
| --- | --- |
| `run.js` | Builds a test copy of the add-on (pointed at the mock, with `selftest.js` added), installs it in the browser, and logs in/out on the "website" when asked |
| `selftest.js` | Runs inside the add-on page and clicks through it, reporting each check to the mock (WebDriver can't script add-on pages) |
| `mock-wfm.js` | The fake warframe.market |
| `check-locales.js` | Checks that every text on the page and in the code is translated in every language |
| `fixtures/` | Screenshots: `real1.png`, `real2.png` are real inventory screenshots; `shotA/B.png` are synthetic ones with stack counts, made by `make-synthetic-shots.ps1`; `lang-*.png` are synthetic ones in each game language (names from warframe.market, with a Radiant relic), made by `make-language-shots.ps1` from `language-shots.json` |
| `output/<browser>/` | Screenshots the self-test takes, for a visual check (not committed) |

`npm run lint` runs Mozilla's add-on checker. `npm run build` and `npm run build:chrome` make the store packages (in `dist/`).
