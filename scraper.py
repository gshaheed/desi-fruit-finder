#!/usr/bin/env python3
"""
Daily availability checker for Desi Fruit Finder.

For every vendor in data.json with "auto_checked": true, fetches the vendor's
public product/collection page and applies a best-effort text heuristic to
guess whether the fruit looks in stock, pre-order, sold out, or season-ended.

This is intentionally simple (regex/keyword matching over page text) rather
than a full headless-browser scraper, so it only works for vendors whose
status is expressed in plain HTML text (true for the Shopify-style stores
currently in data.json). Vendors marked "auto_checked": false are left alone
and keep their manual status_text.

Run via GitHub Actions on a daily cron (see .github/workflows/update-data.yml).
"""

import json
import re
import sys
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

DATA_PATH = Path(__file__).parent / "data.json"
TIMEOUT = 20
HEADERS = {
    "User-Agent": "Mozilla/5.0 (compatible; DesiFruitFinderBot/1.0; +https://github.com/)"
}

# Ordered: first match wins.
STATUS_RULES = [
    ("season_ended", [
        r"season has ended",
        r"no longer taking new orders",
        r"season is over",
        r"see you next season",
    ]),
    ("pre_order", [
        r"pre[\s-]?order",
        r"coming soon",
        r"notify me when available",
    ]),
    ("sold_out", [
        r"sold out",
        r"out of stock",
        r"currently unavailable",
    ]),
    ("in_stock", [
        r"add to cart",
        r"buy now",
        r"in stock",
    ]),
]


def fetch(url: str) -> str:
    req = urllib.request.Request(url, headers=HEADERS)
    with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
        raw = resp.read()
    return raw.decode("utf-8", errors="ignore")


def classify(html: str) -> tuple[str, str]:
    text = re.sub(r"<[^>]+>", " ", html).lower()
    text = re.sub(r"\s+", " ", text)

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
        if not vendor.get("auto_checked"):
            continue
        url = vendor.get("check_url")
        if not url:
            continue

        try:
            html = fetch(url)
            status, snippet = classify(html)
        except Exception as exc:  # noqa: BLE001 - best effort, keep going
            status, snippet = "error", f"Fetch failed: {exc}"

        if vendor.get("status") != status or vendor.get("status_text") != snippet:
            changed = True

        vendor["status"] = status
        vendor["status_text"] = snippet
        vendor["last_checked"] = now

    data["generated_at"] = now

    DATA_PATH.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n")

    print(f"Checked vendors. Data changed: {changed}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
