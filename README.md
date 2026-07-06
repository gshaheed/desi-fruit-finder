# Desi Fruit Finder

Find **where to buy** South Asian & tropical fruit — mango, lychee, mangosteen, jamun, chikoo and more — near you in California or shipped to your door, and see whether it looks **in stock right now**.

**Live site:** https://gshaheed.github.io/desi-fruit-finder/

## What it does

- **Where to buy, per fruit** — open any fruit to see the vendors that carry it, each with a stock badge (in stock / pre-order / sold out / check directly), location, notes and a direct link.
- **Shop by region** — filter to NorCal, SoCal, or vendors that ship nationwide to your door.
- **Live-ish stock** — for online stores, a scheduled scraper checks each vendor's product page every few hours and records the result, with a "last checked" time on every listing. Grocery stores don't publish live inventory, so they're marked *check directly* with a link to confirm.
- **Automatic in-season signal** — for grocery vendors that can't be scraped, the site computes a "typically in season" or "typically out of season" read from each fruit's harvest calendar and today's date, so you get a useful signal without ever opening the vendor's site. It's an estimate based on typical season, not a live inventory count.
- **"Only where I can buy it now"** — one toggle to hide fruits with nothing available in your region.
- **A full guide for every fruit** — season, how to eat it, nutrition and a fun fact, behind each fruit's *Where to buy* panel.
- **23 fruits and 24 vendors tracked**, and growing — desi, Asian and Latin groceries, specialty shippers, and corporate stores.

## How stock checking works

`scraper.py` runs on a schedule via GitHub Actions (`.github/workflows/update-data.yml`). For every vendor in `data.json` marked `auto_checked`, it fetches the vendor's public product page and reads the stock signal — first the structured `og:availability` / schema.org `availability` field, then a text heuristic (sold out / pre-order / add to cart). It writes the status and a timestamp back to `data.json` and commits the change.

This is a **best-effort** signal, not a guaranteed real-time inventory feed. Storefronts change, and a store-wide page can be noisy — so every listing links straight to the vendor for you to confirm before you buy or drive.

## Files

- `index.html` — the whole site (HTML, CSS, vanilla JS, inline SVG illustrations). No build step; only Google Fonts from a CDN.
- `data.json` — the fruit and vendor dataset, and the file the scraper updates.
- `scraper.py` — the stock checker (standard library only).
- `.github/workflows/update-data.yml` — the schedule that runs the scraper.

## Running it locally

```bash
python3 -m http.server
# then visit http://localhost:8000
```

Opening `index.html` directly also works, but `data.json` only loads over http(s), so run a local server to see vendor data.

## Adding a vendor or fruit

- **Vendor:** add an entry to the `vendors` array in `data.json` — set `region` (`norcal`, `socal`, `both-ca`, or `ships-statewide`), list the `fruits` it carries (names must match the fruit names in `index.html`), and set `auto_checked` + a `check_url` if it has a scrapeable product page (otherwise `auto_checked: false` and a `manual` status).
- **Fruit:** add an entry to the `FRUITS` array and a matching SVG to the `ART` object in `index.html`, plus a matching entry (with `season_months`, the 1–12 months it's typically available) to the `fruits` array in `data.json`. The finder, filters and detail panel pick it up automatically.
