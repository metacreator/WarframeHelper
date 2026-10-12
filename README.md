# Warframe Help: Tenno Trade Helper

A Firefox / LibreWolf add-on for selling Warframe items on [warframe.market](https://warframe.market).

- **Scan your inventory from screenshots.** Item names, stack counts and relic refinements are read in your browser,
  with the game in English, Ukrainian, Spanish or Chinese. Overlapping screenshots are counted once.
- **See what everything is worth right now:** cheapest online seller, median, best buy offer, ducats, and which
  complete prime sets you own.
- **List, update, unlist and mark items sold** on warframe.market in one click, using the login you already have
  on the site (Steam, Google, Discord or password).
- **Sales made on the website are picked up automatically**, with a notification.
- Safety checks: mods and arcanes can't be listed until you've set their rank, prices are refreshed before listing,
  and a price far below what others ask needs confirming.

Everything runs in the browser: there is no server, and nothing is sent anywhere except to warframe.market.

## Where things are

| Path | What |
| --- | --- |
| [`extension/`](extension/README.md) | The add-on: how to try it, publish it, and how it works |
| [`tests/`](tests/README.md) | End-to-end tests in Firefox against a fake warframe.market (`npm test`) |
| [`PRIVACY.md`](PRIVACY.md) | Privacy policy for the add-on store |

## Commands

```
npm install      # test and packaging tools
npm test         # run the add-on in headless Firefox and check the whole flow
npm run lint     # Mozilla's add-on checker
npm run build    # package for addons.mozilla.org (dist/)
```

## Data from the old local app

Earlier versions were a local Node app that kept its data in `data/`. To move it into the add-on, open
**Backup → Load backup…** in the add-on and pick `data/inventory.json`, then `data/sales.json`.
