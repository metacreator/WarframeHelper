# Warframe Help: Tenno Trade Helper

A browser add-on for Firefox, LibreWolf, Chrome and Edge for selling Warframe items on [warframe.market](https://warframe.market).

- **Scan your inventory from screenshots.** Item names, stack counts and relic refinements are read in your browser,
  with the game in English, Ukrainian, Spanish or Chinese. Overlapping screenshots are counted once; when counts
  differ, the newest screenshot wins, and a tile without a visible count keeps the quantity you already have.
- **See what everything is worth right now:** cheapest online seller, median, best buy offer, ducats, plus the
  7-day average of completed trades and how many sell per day.
- **Complete prime sets:** see which sets you own every part of, and combine the parts into one set row to list.
- **List, update, unlist and mark items sold** on warframe.market in one click, using the login you already have
  on the site (Steam, Google, Discord or password).
- **Keep listings competitive:** one click moves them to the cheapest other online seller minus your undercut.
  Hide listings without deleting them, and record parts traded to Baro Ki'Teer for ducats.
- **Sales made on the website are picked up automatically**, with a notification.
- Safety checks: mods and arcanes can't be listed until you've set their rank, prices are refreshed before listing,
  and a price far below what others ask needs confirming.
- **In your language:** English, Ukrainian, Spanish, and Simplified and Traditional Chinese, including item names.

Everything runs in the browser: there is no server, and nothing is sent anywhere except to warframe.market.

## Where things are

| Path | What |
| --- | --- |
| [`extension/`](extension/README.md) | The add-on: how to try it, publish it, and how it works |
| [`tests/`](tests/README.md) | End-to-end tests in Firefox, Chrome and Edge against a fake warframe.market |
| `tools/build-chrome.js` | Makes the Chrome / Edge package from `extension/` |
| [`CHANGELOG.md`](CHANGELOG.md) | What changed in each version |
| [`PRIVACY.md`](PRIVACY.md) | Privacy policy for the add-on stores |

## Commands

```
npm install            # test and packaging tools
npm test               # run the add-on in headless Firefox and check the whole flow, plus the translations
npm run test:chrome    # the same in Chrome (npm run test:edge for Edge)
npm run lint           # Mozilla's add-on checker
npm run build          # package for addons.mozilla.org (dist/)
npm run build:chrome   # package for the Chrome Web Store and Edge Add-ons (dist/)
```

## Data from the old local app

Earlier versions were a local Node app that kept its data in `data/`. To move it into the add-on, open
**Backup → Load backup…** in the add-on and pick `data/inventory.json`, then `data/sales.json`.
