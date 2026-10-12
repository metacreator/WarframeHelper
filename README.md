# Warframe Help

A local price checker for your Warframe items, using the public [warframe.market](https://warframe.market) API.
Add the prime parts, mods, arcanes and relics you own, and it shows what each one sells for right now,
which items you've already listed on your profile, and which complete prime sets you could sell.

## Run it

Requires Node.js 18 or newer. There is nothing to install.

```
node server.js
```

Then open http://localhost:3000. On Windows you can double-click `start.bat` instead.

## Configure

Edit `config.json`:

| Key | Meaning |
| --- | --- |
| `username` | Your warframe.market profile name. Used to show your current listings. |
| `platform` | `pc`, `ps4`, `xbox` or `switch` |
| `port` | Local port. Default 3000. |
| `priceTtlMinutes` | How long fetched prices are reused before asking the API again |

## Adding your items

- **Scan screenshots**: open your in-game Inventory or Mods screen, take screenshots while scrolling, and drop them
  on the page (or paste with Ctrl+V). Text recognition runs in your browser with Tesseract.js. Each tile's name is matched
  to a market item and its count is read. Overlapping screenshots are fine. Warframe stacks identical items into one tile,
  so an item seen in several screenshots is counted once, using the highest count seen. Review the matches,
  fix any mistakes, then add them. "Set quantities" mode lets you re-scan later without doubling counts.
  If names are missed, lower **Text brightness**. If background art turns into junk text, raise it.
  Tick "show what the scanner sees" to check.
- **One at a time**: type a name (it autocompletes) and press Add.
- **Paste a list**: one item per line, e.g. `Ash Prime Systems Blueprint x2`, `Primed Continuity r10`, `Axi A1 Relic radiant`.
  Partial names work if they're unambiguous (`soma prime bp`).
- **Game inventory export**: a raw Warframe inventory JSON (with `MiscItems` / `Recipes` / `RawUpgrades` / `Upgrades`)
  is matched to market items by internal game path. Built gear is ignored because it can't be traded.
- **From your listings**: copies your current warframe.market sell orders into the list.

Your list is saved to `data/inventory.json`.

## What the columns mean

- **Lowest sell / Median**: the cheapest, and the median of the 5 cheapest, sellers who are *online right now*.
  These are the prices you're competing with.
- **Best buy**: the highest online buy order. You can sell at this price immediately.
- **D/P**: ducats per platinum. A high value means the item is worth more as ducats for Baro Ki'Teer than as platinum.
- **My listing**: your current price on warframe.market. It's red if you're priced above the cheapest online seller.

## Notes

- Requests are throttled to stay under warframe.market's limit of 3 requests per second, so refreshing a large list takes a little while.
  Results are cached in `data/cache/`.
- Everything is read-only. Nothing is posted to your profile.
