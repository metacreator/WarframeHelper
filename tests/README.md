# Tests

```
npm install
npm test
```

`npm test` runs the add-on in real Firefox (headless) and checks the whole flow end to end: login detection,
listing, "List qty", sold tracking, sales made on the website, type groups, rank and price safety checks,
backups, and screenshot scanning, including two real in-game inventory screenshots and one screenshot per supported
game language. It takes about 2–3 minutes
and needs Firefox installed and an internet connection. Set `FIREFOX_BIN` to test another Firefox-based browser.

**No real account is used.** `mock-wfm.js` stands in for warframe.market: everything tied to an account
(your profile, your orders, creating/closing orders) is faked, and only public read-only data (items, prices)
comes from the real API.

| File | What it is |
| --- | --- |
| `run-firefox.js` | Builds a test copy of the add-on (pointed at the mock, with `selftest.js` added), installs it in Firefox, and logs in/out on the "website" when asked |
| `selftest.js` | Runs inside the add-on page and clicks through it, reporting each check to the mock (Firefox's WebDriver can't script add-on pages) |
| `mock-wfm.js` | The fake warframe.market |
| `fixtures/` | Screenshots: `real1.png`, `real2.png` are real inventory screenshots; `shotA/B.png` are synthetic ones with stack counts, made by `make-synthetic-shots.ps1`; `lang-*.png` are synthetic ones in each game language (names from warframe.market, with a Radiant relic), made by `make-language-shots.ps1` from `language-shots.json` |
| `output/` | Screenshots the self-test takes, for a visual check (not committed) |

`npm run lint` runs Mozilla's add-on checker and `npm run build` makes the package for the add-on store (in `dist/`).
