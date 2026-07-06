/**
 * Desi Fruit Finder — live stock check proxy.
 *
 * Browsers can't fetch most vendor sites directly from client-side JS
 * (CORS), so this Worker fetches a vendor's product page server-side and
 * returns a parsed stock signal. Deploy this on Cloudflare Workers (free
 * tier) and point CHECK_LIVE_ENDPOINT in index.html at the resulting
 * *.workers.dev URL.
 *
 * Only fetches hosts in ALLOWED_HOSTS below — keep this in sync with the
 * `check_url` hosts of auto_checked vendors in data.json, so this can't be
 * used as an open proxy for arbitrary URLs.
 */

const ALLOWED_HOSTS = new Set([
  "aumpi.com",
  "bhanunaturalproducts.com",
  "freshmangoes.us",
  "mangomaniaus.com",
  "miamifruit.org",
  "tropicalfruitbox.com",
  "www.a1mangos.com",
  "www.ar4mangoes.com",
  "www.exoticfruitsusa.com",
  "www.ishopindian.com",
  "www.melissas.com",
]);

const FETCH_TIMEOUT_MS = 15000;

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
};

// Ordered: first match wins. Mirrors scraper.py's STATUS_RULES.
const STATUS_RULES = [
  ["season_ended", [
    /season has ended/,
    /no longer taking new orders/,
    /season is over/,
    /see you next season/,
  ]],
  ["sold_out", [/sold out/, /out of stock/, /currently unavailable/]],
  ["pre_order", [/pre[\s-]?order/, /coming soon/, /notify me when available/]],
  ["in_stock", [/add to cart/, /buy now/, /in stock/]],
];

const STRUCTURED_AVAILABILITY_MAP = {
  instock: "in_stock",
  "in stock": "in_stock",
  "http://schema.org/instock": "in_stock",
  "https://schema.org/instock": "in_stock",
  outofstock: "sold_out",
  "out of stock": "sold_out",
  "http://schema.org/outofstock": "sold_out",
  "https://schema.org/outofstock": "sold_out",
  preorder: "pre_order",
  "pre-order": "pre_order",
  "http://schema.org/preorder": "pre_order",
  "https://schema.org/preorder": "pre_order",
  discontinued: "season_ended",
  "http://schema.org/discontinued": "pre_order",
};

function stripNoise(html) {
  let text = html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, " ");
  text = text.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, " ");
  text = text.replace(/<[^>]+>/g, " ");
  text = text.replace(/\s+/g, " ");
  return text.toLowerCase();
}

function checkStructuredAvailability(html) {
  let m =
    html.match(/<meta[^>]+property=["']og:availability["'][^>]+content=["']([^"']+)["']/i) ||
    html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:availability["']/i);
  if (m) {
    const mapped = STRUCTURED_AVAILABILITY_MAP[m[1].trim().toLowerCase()];
    if (mapped) return [mapped, `og:availability = "${m[1]}"`];
  }
  m = html.match(/"availability"\s*:\s*"([^"]+)"/i);
  if (m) {
    const mapped = STRUCTURED_AVAILABILITY_MAP[m[1].trim().toLowerCase()];
    if (mapped) return [mapped, `schema availability = "${m[1]}"`];
  }
  return null;
}

function classify(html) {
  const structured = checkStructuredAvailability(html);
  if (structured) return structured;

  const text = stripNoise(html);
  for (const [status, patterns] of STATUS_RULES) {
    for (const pat of patterns) {
      const m = text.match(pat);
      if (m) {
        const start = Math.max(0, m.index - 40);
        const end = Math.min(text.length, m.index + m[0].length + 40);
        return [status, text.slice(start, end).trim()];
      }
    }
  }
  return ["unknown", "Could not find a clear stock signal on the page."];
}

function withCors(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "no-store",
    },
  });
}

export default {
  async fetch(request) {
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, OPTIONS",
        },
      });
    }

    const reqUrl = new URL(request.url);
    const target = reqUrl.searchParams.get("url");
    if (!target) {
      return withCors({ error: "Missing url parameter" }, 400);
    }

    let parsed;
    try {
      parsed = new URL(target);
    } catch {
      return withCors({ error: "Invalid url" }, 400);
    }

    if (parsed.protocol !== "https:" || !ALLOWED_HOSTS.has(parsed.hostname)) {
      return withCors({ error: "Host not allowed" }, 403);
    }

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
      const resp = await fetch(parsed.toString(), {
        headers: HEADERS,
        signal: controller.signal,
      });
      clearTimeout(timer);
      const html = await resp.text();
      const [status, statusText] = classify(html);
      return withCors({
        status,
        status_text: statusText,
        checked_at: new Date().toISOString(),
      });
    } catch (err) {
      return withCors({
        status: "error",
        status_text: `Live fetch failed: ${err.message || err}`,
        checked_at: new Date().toISOString(),
      });
    }
  },
};
