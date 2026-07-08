#!/usr/bin/env python3
"""
Availability checker for Desi Fruit Finder.

For every vendor in data.json with "auto_checked": true, fetches the vendor's
public product page and figures out whether the fruit looks in stock,
pre-order, sold out, or season-ended.

Vendors that carry multiple fruits behind one shared page instead get a
"fruit_urls" map (fruit name -> its own specific product page), so each
fruit is checked against a page that's actually about that fruit, not a
collection page whose text could belong to a different product entirely.
Results for those go into a parallel "fruit_status" map; the vendor's own
top-level status/status_text stay a static placeholder instead of being
overwritten by a shared/ambiguous page's status.

Two layers of signal, checked in order:
  1. Structured signal: an Open Graph `og:availability` meta tag or a
     schema.org Product `"availability"` field embedded in the page. These
     are far more reliable than scanning body text, when present.
  2. Heuristic fallback: strip <script>/<style> blocks (so CSS/JS variable
     names like "preordermessagecolor" can't masquerade as real text), then
     regex/keyword-match the visible text for phrases like "sold out",
     "season has ended", "pre-order", "add to cart".

This is still a best-effort heuristic, not a guaranteed real-time inventory
feed -- see README.md for the known limitations.

A vendor marked "needs_js_render": true is instead fetched with a headless
browser (see fetch_rendered()), for sites whose real stock status is added
to the page entirely client-side after load -- a plain GET sees none of it.

Run via GitHub Actions on a schedule (see .github/workflows/update-data.yml).
"""

import json
import re
import sys
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

DATA_PATH = Path(__file__).parent / "data.json"
TIMEOUT = 20

# Look like an ordinary browser. Some storefronts (Wordfence/WooCommerce,
# certain Shopify apps) 403/404 requests from generic script user agents
# even though the page is public.
HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36"
    ),
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
}

# Ordered: first match wins.
STATUS_RULES = [
    ("season_ended", [
        r"season has ended",
        r"no longer taking new orders",
        r"season is over",
        r"see you next season",
    ]),
    ("sold_out", [
        r"sold out",
        r"out of stock",
        r"currently unavailable",
    ]),
    ("pre_order", [
        r"pre[\s-]?order",
        r"coming soon",
        r"notify me when available",
    ]),
    ("in_stock", [
        r"add to cart",
        r"buy now",
        r"in stock",
    ]),
]

# Maps values seen in og:availability / schema.org availability fields.
STRUCTURED_AVAILABILITY_MAP = {
    "instock": "in_stock",
    "in stock": "in_stock",
    "http://schema.org/instock": "in_stock",
    "https://schema.org/instock": "in_stock",
    "outofstock": "sold_out",
    "out of stock": "sold_out",
    "http://schema.org/outofstock": "sold_out",
    "https://schema.org/outofstock": "sold_out",
    "preorder": "pre_order",
    "pre-order": "pre_order",
    "http://schema.org/preorder": "pre_order",
    "https://schema.org/preorder": "pre_order",
    "discontinued": "season_ended",
    "http://schema.org/discontinued": "pre_order",
}


def fetch(url: str) -> str:
    req = urllib.request.Request(url, headers=HEADERS)
    with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
        raw = resp.read()
    return raw.decode("utf-8", errors="ignore")


def fetch_rendered(url: str) -> str:
    """Fetch a page after letting its JS run.

    Some storefronts (e.g. Weee!) render their real stock status entirely
    client-side after page load; a plain GET only sees the pre-render HTML,
    which carries no genuine signal (and can be actively misleading -- SPA
    bundles often ship generic i18n strings like "sold_out"/"in_stock" as
    UI label text, unrelated to any specific product's real status).

    Requires Playwright + a Chromium download (see the "install-browser"
    step in .github/workflows/update-data.yml) -- only imported when a
    vendor is marked "needs_js_render": true, so environments without it
    installed can still run the rest of the scraper.
    """
    from playwright.sync_api import sync_playwright

    with sync_playwright() as p:
        browser = p.chromium.launch()
        try:
            page = browser.new_page(user_agent=HEADERS["User-Agent"])
            page.goto(url, wait_until="networkidle", timeout=TIMEOUT * 1000)
            return page.content()
        finally:
            browser.close()


def strip_noise(html: str) -> str:
    """Remove <script> and <style> blocks (contents included), then tags."""
    html = re.sub(r"<script[^>]*>.*?</script>", " ", html, flags=re.DOTALL | re.IGNORECASE)
    html = re.sub(r"<style[^>]*>.*?</style>", " ", html, flags=re.DOTALL | re.IGNORECASE)
    text = re.sub(r"<[^>]+>", " ", html)
    text = re.sub(r"\s+", " ", text)
    return text.lower()


def check_structured_availability(html: str):
    # Open Graph: <meta property="og:availability" content="out of stock">
    m = re.search(
        r'<meta[^>]+property=["\']og:availability["\'][^>]+content=["\']([^"\']+)["\']',
        html, re.IGNORECASE,
    )
    if not m:
        # attribute order can be reversed
        m = re.search(
            r'<meta[^>]+content=["\']([^"\']+)["\'][^>]+property=["\']og:availability["\']',
            html, re.IGNORECASE,
        )
    if m:
        value = m.group(1).strip().lower()
        mapped = STRUCTURED_AVAILABILITY_MAP.get(value)
        if mapped:
            return mapped, 'og:availability = "%s"' % m.group(1)

    # schema.org JSON-LD or microdata: "availability": "https://schema.org/InStock"
    m = re.search(r'"availability"\s*:\s*"([^"]+)"', html, re.IGNORECASE)
    if m:
        value = m.group(1).strip().lower()
        mapped = STRUCTURED_AVAILABILITY_MAP.get(value)
        if mapped:
            return mapped, 'schema availability = "%s"' % m.group(1)

    return None


def _find_product_price(node, depth: int = 0):
    """Recursively search parsed JSON-LD for a Product node's offers.price.

    Handles a bare Product object, an array of nodes, or Yoast/WordPress-style
    {"@graph": [...]} nesting. Never falls back to grabbing the first bare
    "price" key in raw text -- that risks picking up an unrelated product's
    price (e.g. from a "you may also like" carousel), the same class of bug
    already fixed for stock status.
    """
    if depth > 6 or node is None or not isinstance(node, (dict, list)):
        return None
    if isinstance(node, list):
        for item in node:
            price = _find_product_price(item, depth + 1)
            if price is not None:
                return price
        return None

    node_type = node.get("@type")
    is_product = node_type == "Product" or (isinstance(node_type, list) and "Product" in node_type)
    if is_product and node.get("offers"):
        offers = node["offers"]
        offer = offers[0] if isinstance(offers, list) and offers else offers
        if isinstance(offer, dict) and offer.get("price") is not None:
            try:
                value = float(offer["price"])
                if value > 0:
                    return value
            except (TypeError, ValueError):
                pass

    for value in node.values():
        price = _find_product_price(value, depth + 1)
        if price is not None:
            return price
    return None


def extract_price(html: str):
    """Best-effort real price, or None if no reliable signal is found.

    Priority order (most to least reliable), mirroring the structured-first
    approach used for stock status:
      1. og:price:amount / product:price:amount meta tags -- both are part of
         the same Open Graph "product" object type (ogp.me/#type_product);
         different Shopify themes/apps emit one or the other, so both are
         checked.
      2. JSON-LD Product.offers.price -- scoped to a node that explicitly
         declares itself a Product, not just any "price" text on the page.
    No text-heuristic fallback: an unlabelled dollar amount on the page could
    belong to any product, so showing nothing is better than showing a
    possibly-wrong price with false confidence.
    """
    for prop in ("og:price:amount", "product:price:amount"):
        m = re.search(
            r'<meta[^>]+property=["\']%s["\'][^>]+content=["\']([^"\']+)["\']' % re.escape(prop),
            html, re.IGNORECASE,
        )
        if not m:
            m = re.search(
                r'<meta[^>]+content=["\']([^"\']+)["\'][^>]+property=["\']%s["\']' % re.escape(prop),
                html, re.IGNORECASE,
            )
        if m:
            try:
                value = float(m.group(1))
                if value > 0:
                    return value
            except ValueError:
                pass

    for script in re.finditer(
        r'<script[^>]*type=["\']application/ld\+json["\'][^>]*>(.*?)</script>',
        html, re.DOTALL | re.IGNORECASE,
    ):
        try:
            data = json.loads(script.group(1))
        except (json.JSONDecodeError, ValueError):
            continue
        price = _find_product_price(data)
        if price is not None:
            return price

    return None


def extract_weight_lbs(html: str, url: str = ""):
    """Best-effort product weight in pounds for $/lb display. Returns None if unknown."""
    u = (url or "").lower()
    if "per-lb" in u or "per lb" in u or "/lb" in u:
        return 1.0

    for pattern in (
        r"(\d+(?:\.\d+)?)[-\s]?pounds?",
        r"(\d+(?:\.\d+)?)[-\s]?lbs?(?:\b|[-.])",
        r"(\d+(?:\.\d+)?)\s*lb\b",
    ):
        m = re.search(pattern, u)
        if m:
            value = float(m.group(1))
            if value > 0:
                return value

    m = re.search(r"(\d+(?:\.\d+)?)[-\s]?kg", u)
    if m:
        value = float(m.group(1))
        if value > 0:
            return round(value * 2.20462, 2)

    text = strip_noise(html) if html else ""
    for pattern in (
        r"(\d+(?:\.\d+)?)\s*pounds?",
        r"(\d+(?:\.\d+)?)\s*lbs?\b",
        r"(\d+(?:\.\d+)?)\s*kilograms?",
        r"(\d+(?:\.\d+)?)\s*kg\b",
    ):
        m = re.search(pattern, text)
        if m:
            value = float(m.group(1))
            if value > 0:
                if "kg" in pattern or "kilogram" in pattern:
                    return round(value * 2.20462, 2)
                return value

    if "-box" in u or "/box" in u or "box-" in u:
        return 6.0

    return None


def classify(html: str):
    structured = check_structured_availability(html)
    if structured:
        return structured

    text = strip_noise(html)
    for status, patterns in STATUS_RULES:
        for pat in patterns:
            m = re.search(pat, text)
            if m:
                start = max(0, m.start() - 40)
                end = min(len(text), m.end() + 40)
                snippet = text[start:end].strip()
                return status, snippet

    return "unknown", "Could not find a clear stock signal on the page."


def main() -> int:
    data = json.loads(DATA_PATH.read_text())
    now = datetime.now(timezone.utc).isoformat()
    changed = False

    for vendor in data.get("vendors", []):
        fruit_urls = vendor.get("fruit_urls") or {}

        if fruit_urls:
            # Multi-fruit vendor: a single shared page can't represent every
            # fruit it carries, so don't scrape it as one vendor-wide status.
            # Scrape each fruit's own verified URL instead.
            fetch_fn = fetch_rendered if vendor.get("needs_js_render") else fetch
            fruit_status = vendor.setdefault("fruit_status", {})
            for fruit_name, url in fruit_urls.items():
                price = None
                weight_lbs = None
                html = ""
                try:
                    html = fetch_fn(url)
                    status, snippet = classify(html)
                    price = extract_price(html)
                    weight_lbs = extract_weight_lbs(html, url)
                except Exception as exc:  # noqa: BLE001 - best effort, keep going
                    status, snippet = "error", "Fetch failed: %s" % exc

                prev = fruit_status.get(fruit_name) or {}
                # A check that finds no price this time must not erase a
                # previously-known real price -- only overwrite when this
                # check actually found one.
                if price is None:
                    price = prev.get("price")
                if weight_lbs is None:
                    weight_lbs = prev.get("weight_lbs")
                if weight_lbs is None:
                    weight_lbs = extract_weight_lbs("", url)
                if (
                    prev.get("status") != status
                    or prev.get("status_text") != snippet
                    or prev.get("price") != price
                    or prev.get("weight_lbs") != weight_lbs
                ):
                    changed = True

                # Merge rather than replace -- preserves hand-researched fields
                # (e.g. unit_lbs, used to sanity-check price-per-pound) that
                # this scraper doesn't know about and shouldn't erase.
                fruit_status[fruit_name] = {
                    **prev,
                    "status": status,
                    "status_text": snippet,
                    "last_checked": now,
                    "price": price,
                    "weight_lbs": weight_lbs,
                }

        elif vendor.get("auto_checked") and vendor.get("check_url"):
            url = vendor["check_url"]
            price = None
            weight_lbs = None
            try:
                html = fetch(url)
                status, snippet = classify(html)
                price = extract_price(html)
                weight_lbs = extract_weight_lbs(html, url)
            except Exception as exc:  # noqa: BLE001 - best effort, keep going
                status, snippet = "error", "Fetch failed: %s" % exc

            if price is None:
                price = vendor.get("price")
            if weight_lbs is None:
                weight_lbs = vendor.get("weight_lbs")
            if weight_lbs is None:
                weight_lbs = extract_weight_lbs("", url)
            if (
                vendor.get("status") != status
                or vendor.get("status_text") != snippet
                or vendor.get("price") != price
                or vendor.get("weight_lbs") != weight_lbs
            ):
                changed = True

            vendor["status"] = status
            vendor["status_text"] = snippet
            vendor["last_checked"] = now
            vendor["price"] = price
            vendor["weight_lbs"] = weight_lbs

    data["generated_at"] = now

    DATA_PATH.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n")

    print("Checked vendors. Data changed: %s" % changed)
    return 0


if __name__ == "__main__":
    sys.exit(main())
