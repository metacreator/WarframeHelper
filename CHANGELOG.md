# Changelog

## 1.0.0 (not released yet)

First public release, for Firefox, LibreWolf, Chrome and Edge.

**Your inventory**
- Scan your in-game inventory from screenshots: item names, stack counts and relic refinements, with the game in
  English, Ukrainian, Spanish, or Simplified or Traditional Chinese. Two screenshots are read at a time.
- Overlapping screenshots are counted once. When counts differ, the newest screenshot wins, and a tile without a
  visible count keeps the quantity you already have.
- Names that could fit several items are marked "unclear" for you to pick, never guessed.
- Add items by hand, in English or your language.
- Reads mod cards too (white names over card art), as on the Mods screen and reward choices.
- Quick price check: paste one screenshot and see the lowest price and ducat value of each item on it,
  without adding anything to your list. Relic rewards warframe.market doesn't trade (Forma Blueprint) are
  shown as such.
- Screenshot shortcut for the quick price check: Ctrl+Shift+9 (or the button) waits a moment so you can switch to
  the game, then takes a screenshot of the screen you shared and checks it. In Chrome and Edge the shortcut also
  works while the game is in front; in Firefox, while the browser is. The delay and the key can be changed.

**Prices**
- Live warframe.market prices: cheapest online seller, median, best buy offer, value, ducats and ducats per platinum.
- Price history: the 7-day average of completed trades and how many sell per day.
- Complete prime sets you own, with set price against parts, and Combine/Split to sell a set as one item.

**Selling**
- List at the cheapest other seller minus your undercut, or at your own price, and only as many as you want.
- Reprice all listings in one click, hide listings without deleting them, list everything at once.
- Safety checks: mods and arcanes need their rank before listing, prices are refreshed before listing, and a price
  far below what it sells for needs confirming.
- Mark items sold or traded to Baro Ki'Teer; sales made on the website are noticed every 3 minutes while the
  page is open.
- Sales history, a ready-made trade chat message, and backups.

**Everything else**
- Uses your warframe.market login in the browser (Steam, Google, Discord or password); nothing to set up.
- The page in English, Ukrainian, Spanish, and Simplified and Traditional Chinese.
- No server and no tracking: your list stays in your browser and only warframe.market is contacted.
- Fast screenshot reading: a screenshot is split across up to four text-recognition workers, names already read
  exactly aren't read again, and matching text to item names skips hopeless candidates early. A full inventory
  screenshot takes under 2 seconds, a relic reward screen about 1. Workers start when a screenshot is on its way
  and stop after 10 minutes without use.
- The animated background stands still while the browser isn't the active window.
- Nothing runs in the background: with the page closed, the add-on makes no requests and keeps no timers.
  While it's open, prices are fetched again once they're an hour old, or when you press Refresh prices.
- Light on warframe.market: prices load only for the part of the list you have open, the same request is
  never sent twice at once, and a failed one waits before it is tried again.
