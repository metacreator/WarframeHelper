# Warframe Help

A local tool for selling your Warframe items on [warframe.market](https://warframe.market).
Scan screenshots of your inventory, see what each item sells for right now, list items on your profile
in one click, and keep the list in step as things sell.

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
| `username` | Your warframe.market profile name, used to show your listings when you're not connected |
| `platform` | `pc`, `ps4`, `xbox` or `switch` |
| `port` | Local port. Default 3000. |
| `priceTtlMinutes` | How old a cached price can be before it is fetched again (default 30) |

## Adding your items

- **Scan screenshots**: open your in-game Inventory or Mods screen, take screenshots while scrolling, and drop them
  on the page (or paste with Ctrl+V). Text recognition runs in your browser with Tesseract.js. Each tile's name is matched
  to a market item and its count is read. Overlapping screenshots are fine. Warframe stacks identical items into one tile,
  so an item seen in several screenshots is counted once, using the highest count seen. Review the matches,
  fix any mistakes, then add them. "Set quantities" mode lets you re-scan later without doubling counts.
  If names are missed, lower **Text brightness**. If background art turns into junk text, raise it.
  Tick "show what the scanner sees" to check.
- **By hand**: type a name in the box above the table (it autocompletes) and press Add.

Your list is saved to `data/inventory.json`.

## Listing and selling

Click **Connect warframe.market** at the top. There are two ways in:

- **Steam / Google / Discord login** (no password): while logged in on warframe.market in your browser, press F12,
  open Application → Cookies → `https://warframe.market`, copy the value of the `JWT` cookie and paste it.
  The app checks it with warframe.market before saving it.
- **Password**: sign in with email and password. The password goes to warframe.market and is not saved.

Either way, only the session token is kept, in `data/auth.json`. **Disconnect** deletes it. Don't share that token:
it works like a logged-in session.

- **Sell at**: the price you list for. Leave it empty to use the default: the lowest online price minus the
  undercut you set above the table. Type a number to use your own price (the box turns gold).
- **List** creates a sell order for the row's quantity. **List all unlisted** lists every row shown that isn't listed yet,
  after asking you to confirm.
- **Update** appears when your listing's price or quantity differs from the row. **Unlist** deletes the order.
- **Sold** removes the sold quantity from your list. If the item is listed, it also closes the order on warframe.market,
  which records the trade there.
- **Sales made on the website** are picked up automatically, every 3 minutes and on Refresh. If one of your orders'
  quantity went down, the difference is removed from your list. If an order disappeared, the row is flagged
  "Listing gone. Sold?" so you can confirm, since a deleted order looks the same as a fully sold one.
- Every sale is kept in **Sales history** (`data/sales.json`).

## What the columns mean

- **Lowest sell / Median**: the cheapest, and the median of the 5 cheapest, sellers who are *online right now*.
  These are the prices you're competing with.
- **Best buy**: the highest online buy order. You can sell at this price immediately.
- **D/P**: ducats per platinum. A high value means the item is worth more as ducats for Baro Ki'Teer than as platinum.
- **Listing**: your current order. It's red if you're priced above the cheapest online seller.

## Caching

- Prices are cached in `data/cache/prices.json`. When you open the page, cached prices show instantly. Only prices older
  than `priceTtlMinutes` are fetched again, in the background. Faded prices are stale. Hover a price to see its age.
- **Refresh prices** re-checks everything, but prices fetched within the cache time are still reused unless you tick
  **ignore cache**.
- The item database is cached for a day and set definitions are cached permanently.
- Requests are throttled to stay under warframe.market's limit of 3 requests per second.

## Testing

`WFM_API_URL` overrides the warframe.market address, so the app can be pointed at a mock server instead of your real account.
