# Privacy policy: Tenno Trade Helper

*Last updated: 12 October 2026*

Tenno Trade Helper is a browser add-on that helps you sell Warframe items on warframe.market.
It has no server of its own and no analytics. The developer receives no data from it.

## What the add-on accesses

- **Your warframe.market session.** The add-on reads the `JWT` login cookie that warframe.market sets in your
  browser when you log in there. It uses it only to send requests to warframe.market (`api.warframe.market`)
  on your behalf: reading your profile and orders, and creating, updating or closing orders when you ask it to.
  The cookie is never sent anywhere else and is not stored by the add-on.
- **Item names and prices.** To show prices and recent trade history, the add-on asks warframe.market for
  current orders and trade statistics on the items in your list.
- **Screenshots you add.** Screenshots are read on your computer by the bundled text-recognition library.
  They are never uploaded and are discarded when you close the page.

## What the add-on stores

In your browser's local extension storage only: your item list, your sales history, a cache of prices and
item data, your platform setting, and your warframe.market username (to link to your profile).
Removing the add-on deletes this data. You can save or load it yourself with the **Backup** section.

## Third parties

The only service the add-on talks to is warframe.market, which handles your data under its own privacy policy.
Item images are also loaded from warframe.market.

## Contact

Questions or problems: open an issue on the project's GitHub repository.
