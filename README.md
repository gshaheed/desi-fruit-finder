# Desi Fruit Finder

A small site that tracks where region-specific Indian fruits (Alphonso mango, Kesar mango,
jamun, chikoo, sitaphal/custard apple) are showing up at vendors in Northern and Southern
California, so buyers can get to good stock before it sells out or expires.

**Live site:** enable GitHub Pages on this repo (Settings → Pages → Deploy from branch → `main` / `/root`) and it will be published at `https://<your-username>.github.io/desi-fruit-finder/`.

## What's here

- `index.html`, `style.css`, `script.js` — the static site. It reads `data.json` and renders
  filterable vendor cards (by region: NorCal / SoCal / Ships to You, and by fruit) plus a
  general season calendar.
- `data.json` — the vendor + fruit database. Hand-researched to start; see sources below.
- `scraper.py` — a small heuristic checker. For vendors with a public Shopify-style product
  page (`auto_checked: true` in `data.json`), it fetches the page and looks for phrases like
  "sold out," "season has ended," "pre-order," or "add to cart" to guess current status.
- `.github/workflows/update-data.yml` — a GitHub Actions workflow that runs `scraper.py`
  once a day (and on manual trigger) and commits any changes to `data.json`. This is the
  "algorithm" that keeps the live-status badges current without anyone touching the repo.

## Known limitations (read before trusting a badge)

- There is no public, structured API for "which Indian fruit vendor has stock right now" —
  this doesn't exist anywhere, so the auto-checker is a text heuristic against each vendor's
  own webpage, not a guaranteed real-time inventory feed.
- Vendors without a scrapeable product page (physical stores like Patel Brothers, marketplaces
  like Weee!) are marked `"auto_checked": false` and show "check directly" — call or visit.
- Season windows in the calendar are general estimates for India-grown fruit, not vendor-confirmed
  dates for this year.
- Always confirm with the vendor before a special trip, especially for a store location — hours
  and even whether a location is still open can change.

## Adding or fixing a vendor

Edit `data.json`. Each vendor entry:

```json
{
  "id": "unique-slug",
  "name": "Vendor Name",
  "region": "norcal | socal | ships-statewide",
  "location": "Human-readable location/delivery area",
  "url": "https://vendor-homepage",
  "check_url": "https://vendor-product-page-or-null",
  "fruits": ["Alphonso Mango"],
  "auto_checked": true,
  "status": "unknown",
  "status_text": "",
  "last_checked": null
}
```

Set `auto_checked: false` and `check_url: null` if there's no reliable page to scrape.

## Sources used for initial data

- [AumPi](https://aumpi.com/) — Bay Area Alphonso/Kesar/Banganpalle mango delivery
- [Bhanu Natural Products](https://bhanunaturalproducts.com/us/buy-mangoes-in-bay-area)
- [Patel Brothers locations](https://www.patelbros.com/locations)
- [Fresh Mangoes](https://freshmangoes.us/) — nationwide air-cargo mango/custard apple shipping
- [A1 Mangos](https://www.a1mangos.com/)
- [MangoZZ](https://mangozz.com/)
- [AR4 Mangoes](https://www.ar4mangoes.com/)
- [Weee!](https://www.sayweee.com/) — Asian-American grocery marketplace
