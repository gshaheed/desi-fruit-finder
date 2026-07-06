# Desi Fruit Finder

A hand-built field guide to the fruits of South Asia and the tropics — from the alphonso mango of Ratnagiri to the purple armour of a mangosteen. Search a fruit, filter by season, taste and where it grows, and learn how to open it, how to eat it, and where to find it.

**Live site:** https://gshaheed.github.io/desi-fruit-finder/

## What's inside

- **A searchable finder** — type a name (or a taste like "sour", or a season like "monsoon") and the grid filters instantly.
- **Filters** — narrow by season (summer / monsoon / winter), taste (sweet, tart, tropical, floral, earthy, sour, creamy) and growing region.
- **Detail pages** — click any fruit for its story, how to eat it, where to find it, a nutrition snapshot and a fun fact.
- **23 fruits and counting**, including mango, lychee, mangosteen, jackfruit, custard apple, chikoo, jamun, guava, pomegranate, dragon fruit, rambutan, longan, ber, wood apple (bael), phalsa, tamarind, amla, starfruit, muskmelon, karonda, passion fruit, sweet lime and water apple.
- **Custom illustrations** — every fruit is drawn from scratch as inline SVG. No stock photos, no templates.

## Design

Bold and vibrant, built to feel handmade rather than generated: warm paper tones, a Fraunces + Space Grotesk type pairing, custom SVG art, and a subtle paper grain.

## How it's built

The entire site is a single self-contained `index.html` — HTML, CSS and vanilla JavaScript, with the fruit data and SVG illustrations inline. No build step, no dependencies (only Google Fonts loaded from a CDN).

## Running it locally

Just open `index.html` in any browser, or serve the folder:

```bash
python3 -m http.server
# then visit http://localhost:8000
```

## Deployment

Published with GitHub Pages from the `main` branch (root). Any push to `main` updates the live site automatically.

## Adding a fruit

Open `index.html`, add an entry to the `FRUITS` array (id, name, local name, season, region, tastes, tagline, story, how-to-eat, where-to-find, nutrition, fun fact), add a matching SVG to the `ART` object, and commit. The finder, filters and detail page pick it up automatically.
