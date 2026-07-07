# Desi Fruit Finder

Find **where to buy** South Asian & tropical fruit — mango, lychee, mangosteen, jamun, chikoo and more — near you in California or shipped to your door, and see whether it looks **in stock right now**.

**Live site:** https://gshaheed.github.io/desi-fruit-finder/

## What it does

- **Where to buy, per fruit** — open any fruit to see the vendors that carry it, each with a stock badge (in stock / pre-order / sold out / check directly), location, notes and a direct link.
- **Shop by region** — filter to NorCal, SoCal, or vendors that ship nationwide to your door.
- **Live-ish stock** — for online stores, a scheduled scraper checks each vendor's product page every 15 minutes and records the result, with a "last checked" time on every listing. Grocery stores don't publish live inventory, so they're marked *check directly* with a link to confirm.
- **Check live, on demand** — any auto-checked vendor also has a "⚡ Check live" button that fetches its current stock right now, via a small serverless proxy (see "Live checks" below), instead of waiting for the next scheduled run.
- **Automatic in-season signal** — for grocery vendors that can't be scraped, the site computes a "typically in season" or "typically out of season" read from each fruit's harvest calendar and today's date, so you get a useful signal without ever opening the vendor's site. It's an estimate based on typical season, not a live inventory count.
- **"Only where I can buy it now"** — one toggle to hide fruits with nothing available in your region.
- **A full guide for every fruit** — season, how to eat it, nutrition and a fun fact, behind each fruit's *Where to buy* panel. Several fruits (Mango, Lychee, Guava, Custard Apple) also list popular named varieties (Alphonso, Kesar, Totapuri, Chausa...).
- **Varieties tied to actual vendors** — where we have real evidence (a vendor's own listed specialty, or a specific product name like "Pink Guava"/"Sweetheart Lychee"), the vendor's "Where to buy" row shows exactly which named varieties they carry, not just a general encyclopedia entry.
- **Real photos** — every fruit card and detail panel shows an actual photo (`images/fruit/`), not just the illustrated art. The inline SVG illustrations still render as a fallback if a photo fails to load.
- **📝 Request order** — every vendor listing has a small form (name, contact, notes) that prepares a ready-to-send message and copies it to your clipboard. This site never takes payment or places orders itself — it just saves you writing the message, which you send to the vendor yourself however they're reachable (their own contact info, if we have it, is shown right there; otherwise use their site/WhatsApp/phone).
- **Real prices** — where a vendor's page exposes structured price data (`og:price:amount` or a JSON-LD `Product.offers.price`), the scraper reads the real, current price and shows it right on the listing. No price signal found → shows "check vendor" instead of guessing.
- **🔥 Fruit Swipe** — an endless Tinder-style card deck (nav bar or the hero button) of every tracked (fruit, vendor) pairing: photo, "Fruit Name, $price" where "Name, Age" would be on a real profile, vendor + location, taste tags and a tagline. Drag or tap ❤️/✕ — it reshuffles forever, purely for fun browsing. Prices are also shown directly on every fruit's grid card ("From $X.XX"), not just inside the swipe deck or a vendor's detail row.
- **💬 Message us** — a chat-style bubble (bottom-left) opens a small contact form that emails straight to the site owner, no account or backend needed.
- **23 fruits and 24 vendors tracked**, and growing — desi, Asian and Latin groceries, specialty shippers, and corporate stores.

## How stock checking works

`scraper.py` runs every 15 minutes via GitHub Actions (`.github/workflows/update-data.yml`). For every vendor in `data.json` marked `auto_checked`, it fetches the vendor's public product page and reads the stock signal — first the structured `og:availability` / schema.org `availability` field, then a text heuristic (sold out / pre-order / add to cart). It writes the status and a timestamp back to `data.json` and commits the change.

This is a **best-effort** signal, not a guaranteed real-time inventory feed. Storefronts change, and a store-wide page can be noisy — so every listing links straight to the vendor for you to confirm before you buy or drive.

### Vendors that carry more than one fruit

A vendor's `check_url` can only describe *one* page. If a vendor carries several fruits behind a single shared page (a collection/category page, or one product page being reused for others), scraping that one page and applying the result to every fruit is actively misleading — text about one product (e.g. "sold out" near an unrelated item) can get misattributed to a completely different fruit the vendor also carries.

Instead, such vendors get a `fruit_urls` map — `{"Dragon Fruit": "https://.../dragon-fruit-box", "Mango": "https://.../mango-box", ...}` — pointing each fruit at its own specific product page. The scraper checks each one independently and writes results into a parallel `fruit_status` map (same shape as the vendor-level `status`/`status_text`/`last_checked`, just keyed by fruit name). The vendor's own top-level `status` becomes a static placeholder ("Carries multiple fruits — see each fruit's own status below.") since it's no longer scraped.

Any fruit that vendor carries but isn't in `fruit_urls` shows "Check directly" (plus the seasonal signal) instead of a shared/ambiguous status — coverage is intentionally traded for accuracy. Extending coverage later is additive: just add another verified URL to `fruit_urls`, no other change needed. Never guess a URL — verify it's a real, single-product page first, or leave that fruit uncovered.

### Vendors whose stock is only rendered client-side

Some sites (Weee! is the current example) don't put real stock status anywhere in the HTML a plain GET receives — it's fetched by the page's own JS after load and painted into the DOM afterward. Worse, their JS bundle can contain generic UI label strings like `"sold_out":"Sold Out"` (i18n dictionaries) that have nothing to do with any specific product, so text-scanning the raw response is actively unreliable, not just incomplete.

A vendor marked `"needs_js_render": true` is fetched with a real headless browser instead (`fetch_rendered()` in `scraper.py`, via [Playwright](https://playwright.dev/)) — it waits for the page's JS to run, then reads the fully-rendered DOM, the same content a real visitor would see. This only runs in the scheduled GitHub Actions scraper (which installs Chromium; see the workflow's caching steps). The Cloudflare Worker behind the "⚡ Check live" button is a lightweight edge function with no browser available on the free tier, so for `needs_js_render` vendors it still does a plain fetch and will often honestly return `unknown` rather than a wrong answer — the scheduled scraper is the accurate source for those.

### How real prices are found

`extract_price()` (in both `scraper.py` and `worker/check-stock.js`) looks for, in order: an `og:price:amount` meta tag, then a JSON-LD node explicitly typed `"@type": "Product"` with an `offers.price` field (recursing into `{"@graph": [...]}` nesting, since WordPress/Yoast SEO sites nest schema that way). It deliberately does **not** fall back to scanning the page for any bare `"price"` value — a product page commonly has several (variants, a "you may also like" carousel), and grabbing the wrong one would be the same class of bug the multi-fruit stock contamination was. No structured signal found → the price field stays `null` and the UI shows "check vendor," never a guess.

## Live checks (the "⚡ Check live" button)

GitHub Pages only serves static files, and browsers block client-side JS from fetching most vendor sites directly (CORS) — so an on-demand, in-page check needs a tiny server-side proxy. `worker/check-stock.js` is that proxy: a [Cloudflare Worker](https://workers.cloudflare.com/) (free tier) that fetches a vendor's page server-side and runs the same classification logic as `scraper.py`, then returns the result to the browser with CORS enabled. It only fetches hosts on its `ALLOWED_HOSTS` allowlist, so it can't be used as an open proxy for arbitrary URLs.

To turn the button on:
1. Sign up for a free Cloudflare account and go to **Workers & Pages → Create → Create Worker**.
2. Paste the contents of `worker/check-stock.js` into the editor and deploy.
3. Copy the resulting `https://<name>.<subdomain>.workers.dev` URL.
4. In `index.html`, set `CHECK_LIVE_ENDPOINT` (near the `vendorRow`/`onCheckLive` functions) to that URL, then commit and push.

Until `CHECK_LIVE_ENDPOINT` is set, the button shows a message instead of failing silently. Keep `ALLOWED_HOSTS` in the worker in sync with the `check_url` hosts of `auto_checked` vendors in `data.json` whenever you add or remove one.

## The "💬 Message us" chatbox

The chat bubble posts to [FormSubmit](https://formsubmit.co/) (`CHAT_EMAIL_ENDPOINT` in `index.html`), which forwards submissions to `meanhacks@gmail.com` — no account, backend, or API key needed. **One-time setup:** the *first* message sent through the form triggers a confirmation email from FormSubmit to `meanhacks@gmail.com` — click the link in it once to activate the endpoint; every message after that delivers immediately. To point it at a different address, change the email in `CHAT_EMAIL_ENDPOINT` and repeat the one-time confirmation.

## Files

- `index.html` — the whole site (HTML, CSS, vanilla JS, inline SVG illustrations). No build step; only Google Fonts from a CDN.
- `images/fruit/` — one photo per fruit (resized to ≤1200px wide, JPEG). All sourced from Wikimedia Commons/Wikipedia, which requires freely-licensed images (public domain or Creative Commons) for article use — see each file's Commons page (search the filename at commons.wikimedia.org) for its specific license and photographer credit before reusing outside this project.
- `data.json` — the fruit and vendor dataset, and the file the scraper updates.
- `scraper.py` — the stock checker (standard library only, except for `needs_js_render` vendors, which need Playwright — installed by the workflow, not required to just read the code).
- `.github/workflows/update-data.yml` — the schedule that runs the scraper.
- `worker/check-stock.js` — the Cloudflare Worker behind the "⚡ Check live" button (see "Live checks" below).

## Running it locally

```bash
python3 -m http.server
# then visit http://localhost:8000
```

Opening `index.html` directly also works, but `data.json` only loads over http(s), so run a local server to see vendor data.

## Adding a vendor or fruit

- **Vendor:** add an entry to the `vendors` array in `data.json` — set `region` (`norcal`, `socal`, `both-ca`, or `ships-statewide`), list the `fruits` it carries (names must match the fruit names in `index.html`), and set `auto_checked` + a `check_url` if it has one scrapeable product page (otherwise `auto_checked: false` and a `manual` status). If the vendor carries more than one fruit, use `fruit_urls` instead (see "Vendors that carry more than one fruit" above) rather than pointing `check_url` at a shared page.
- **Fruit:** add an entry to the `FRUITS` array and a matching SVG to the `ART` object in `index.html`, plus a matching entry (with `season_months`, the 1–12 months it's typically available) to the `fruits` array in `data.json`. Drop a photo at `images/fruit/<art-key>.jpg` (same key as the `art` field) — it's picked up automatically, with the SVG as a fallback if it's missing. Optionally add a `varieties` array (`[{n: "name", d: "description"}, ...]`) to show named regional varieties in the fruit guide. The finder, filters and detail panel pick all of this up automatically.
- **Vendor variety:** if you have real evidence a vendor carries a specific named variety (their own marketing copy, or a distinct product listing — never guess), add `variety_names` to that vendor in `data.json`: `{"Mango": ["Alphonso", "Kesar"]}`. It shows as tags directly on that vendor's row in the fruit's "Where to buy" list.
