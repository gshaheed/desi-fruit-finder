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
 * `check_url` AND `fruit_urls` hosts of vendors in data.json, so this can't
 * be used as an open proxy for arbitrary URLs.
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
  "www.sayweee.com",
  "fresh.99ranch.com",
  "sameday.hmart.com",
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

// Recursively search parsed JSON-LD for a Product node's offers.price.
// Handles a bare Product object, an array of nodes, or Yoast/WordPress-style
// {"@graph": [...]} nesting. Mirrors scraper.py's _find_product_price --
// never falls back to grabbing the first bare "price" in raw text, which
// risks picking up an unrelated product's price (e.g. a recommendation
// carousel), the same contamination class already fixed for stock status.
function findProductPrice(node, depth) {
  depth = depth || 0;
  if (depth > 6 || node === null || typeof node !== "object") return null;
  if (Array.isArray(node)) {
    for (const item of node) {
      const price = findProductPrice(item, depth + 1);
      if (price !== null) return price;
    }
    return null;
  }
  const type = node["@type"];
  const isProduct = type === "Product" || (Array.isArray(type) && type.includes("Product"));
  if (isProduct && node.offers) {
    const offer = Array.isArray(node.offers) ? node.offers[0] : node.offers;
    if (offer && offer.price !== undefined) {
      const value = parseFloat(offer.price);
      if (!isNaN(value) && value > 0) return value;
    }
  }
  for (const key of Object.keys(node)) {
    const price = findProductPrice(node[key], depth + 1);
    if (price !== null) return price;
  }
  return null;
}

// Best-effort real price, or null if no reliable signal is found. Priority:
// og:price:amount / product:price:amount meta tags first (both part of the
// same Open Graph "product" object type, ogp.me/#type_product -- different
// Shopify themes/apps emit one or the other), then JSON-LD
// Product.offers.price. No text-heuristic fallback -- an unlabelled dollar
// amount could belong to any product on the page.
function extractPrice(html) {
  for (const prop of ["og:price:amount", "product:price:amount"]) {
    const m =
      html.match(new RegExp(`<meta[^>]+property=["']${prop}["'][^>]+content=["']([^"']+)["']`, "i")) ||
      html.match(new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+property=["']${prop}["']`, "i"));
    if (m) {
      const value = parseFloat(m[1]);
      if (!isNaN(value) && value > 0) return value;
    }
  }

  const scriptRe = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let sm;
  while ((sm = scriptRe.exec(html))) {
    let data;
    try { data = JSON.parse(sm[1]); } catch (e) { continue; }
    const price = findProductPrice(data);
    if (price !== null) return price;
  }
  return null;
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

// --- Checkout (Stripe) — POST /create-checkout and POST /webhook ---
const BROKER_RATE = 0.05;
const BUYABLE = new Set(["in_stock", "pre_order"]);
const DEFAULT_DATA_JSON =
  "https://raw.githubusercontent.com/gshaheed/desi-fruit-finder/main/data.json";
const DEFAULT_SITE_URL = "https://gshaheed.github.io/desi-fruit-finder";
const DEFAULT_ORDER_EMAIL = "meanhacks@gmail.com";
const MAX_QTY = 10;
const MAX_ITEMS = 20;

function checkoutJson(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "no-store",
    },
  });
}

function resolveVendorFruitView(v, fruitName) {
  if (v.fruit_urls && Object.prototype.hasOwnProperty.call(v.fruit_urls, fruitName)) {
    const fs = (v.fruit_status && v.fruit_status[fruitName]) || {};
    return { status: fs.status || "manual", price: fs.price ?? null };
  }
  if (v.fruit_urls && !Object.prototype.hasOwnProperty.call(v.fruit_urls, fruitName)) {
    return { status: "manual", price: null };
  }
  return { status: v.status, price: v.price ?? null };
}

function buildCatalog(vendors) {
  const map = new Map();
  for (const v of vendors) {
    for (const fruit of v.fruits || []) {
      const view = resolveVendorFruitView(v, fruit);
      if (view.price != null && view.price > 0 && BUYABLE.has(view.status)) {
        map.set(`${v.id}:${fruit}`, {
          vendorId: v.id,
          vendorName: v.name,
          fruitName: fruit,
          vendorPrice: view.price,
          status: view.status,
        });
      }
    }
  }
  return map;
}

let catalogCache = { at: 0, map: null };

async function getCatalog(env) {
  const ttlMs = 5 * 60 * 1000;
  const now = Date.now();
  if (catalogCache.map && now - catalogCache.at < ttlMs) return catalogCache.map;
  const url = (env && env.DATA_JSON_URL) || DEFAULT_DATA_JSON;
  const res = await fetch(url, { cf: { cacheTtl: 300 } });
  if (!res.ok) throw new Error("Could not load product catalog");
  const data = await res.json();
  const map = buildCatalog(data.vendors || []);
  catalogCache = { at: now, map };
  return map;
}

function feeCents(vendorPrice) {
  return Math.round(vendorPrice * BROKER_RATE * 100);
}

function vendorCents(vendorPrice) {
  return Math.round(vendorPrice * 100);
}

async function createStripeSession(env, validatedItems, customerNote) {
  const siteUrl = ((env && env.SITE_URL) || DEFAULT_SITE_URL).replace(/\/$/, "");
  const params = new URLSearchParams();
  params.set("mode", "payment");
  params.set("success_url", `${siteUrl}/order-success.html?session_id={CHECKOUT_SESSION_ID}`);
  params.set("cancel_url", `${siteUrl}/order-cancel.html`);
  params.set("billing_address_collection", "required");
  params.set("shipping_address_collection[allowed_countries][0]", "US");
  params.set("phone_number_collection[enabled]", "true");
  params.set("allow_promotion_codes", "true");

  let idx = 0;
  let orderTotalCents = 0;
  const summary = [];

  for (const item of validatedItems) {
    const qty = item.quantity;
    const vCents = vendorCents(item.vendorPrice);
    const fCents = feeCents(item.vendorPrice);
    orderTotalCents += (vCents + fCents) * qty;

    params.set(`line_items[${idx}][price_data][currency]`, "usd");
    params.set(`line_items[${idx}][price_data][product_data][name]`, `${item.fruitName} — ${item.vendorName}`);
    params.set(`line_items[${idx}][price_data][product_data][description]`, `Vendor-listed price. Fulfilled by ${item.vendorName}.`);
    params.set(`line_items[${idx}][price_data][unit_amount]`, String(vCents));
    params.set(`line_items[${idx}][quantity]`, String(qty));
    idx++;

    params.set(`line_items[${idx}][price_data][currency]`, "usd");
    params.set(`line_items[${idx}][price_data][product_data][name]`, "Brokerage service (5%)");
    params.set(`line_items[${idx}][price_data][product_data][description]`, `Desi Fruit Finder order facilitation for ${item.fruitName}`);
    params.set(`line_items[${idx}][price_data][unit_amount]`, String(fCents));
    params.set(`line_items[${idx}][quantity]`, String(qty));
    idx++;

    summary.push({
      fruit: item.fruitName,
      vendor: item.vendorName,
      vendorId: item.vendorId,
      qty,
      vendorPrice: item.vendorPrice,
      serviceFee: fCents / 100,
      lineTotal: ((vCents + fCents) * qty) / 100,
    });
  }

  params.set("metadata[source]", "desi-fruit-finder");
  params.set("metadata[order_summary]", JSON.stringify(summary).slice(0, 490));
  params.set("metadata[item_count]", String(validatedItems.length));
  params.set("metadata[order_total_cents]", String(orderTotalCents));
  if (customerNote) params.set("metadata[customer_note]", customerNote.slice(0, 490));

  const resp = await fetch("https://api.stripe.com/v1/checkout/sessions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params,
  });
  const session = await resp.json();
  if (!resp.ok) throw new Error(session.error?.message || "Stripe session creation failed");
  return session;
}

async function stripeWebhookSecretBytes(secret) {
  if (secret.startsWith("whsec_")) {
    const bin = atob(secret.slice(6));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }
  return new TextEncoder().encode(secret);
}

async function verifyStripeWebhook(request, env) {
  const secret = env.STRIPE_WEBHOOK_SECRET;
  if (!secret) return null;
  const sigHeader = request.headers.get("stripe-signature");
  if (!sigHeader) throw new Error("Missing stripe-signature");
  const body = await request.text();
  const parts = {};
  for (const piece of sigHeader.split(",")) {
    const [k, v] = piece.split("=");
    if (k && v) parts[k.trim()] = v.trim();
  }
  const timestamp = parts.t;
  const v1 = parts.v1;
  if (!timestamp || !v1) throw new Error("Invalid stripe-signature");
  const signedPayload = `${timestamp}.${body}`;
  const keyBytes = await stripeWebhookSecretBytes(secret);
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signedPayload));
  const expected = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
  if (expected !== v1) throw new Error("Webhook signature mismatch");
  const age = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (age > 300) throw new Error("Webhook timestamp too old");
  return JSON.parse(body);
}

async function notifyOrder(env, session) {
  const email = (env && env.ORDER_EMAIL) || DEFAULT_ORDER_EMAIL;
  const summary = session.metadata?.order_summary || "[]";
  let items;
  try { items = JSON.parse(summary); } catch { items = summary; }
  const lines = [
    `Payment received via Desi Fruit Finder`,
    ``,
    `Stripe session: ${session.id}`,
    `Customer email: ${session.customer_details?.email || session.customer_email || "—"}`,
    `Phone: ${session.customer_details?.phone || "—"}`,
    ``,
    `Items:`,
    ...(Array.isArray(items)
      ? items.map((i) => `- ${i.qty}x ${i.fruit} from ${i.vendor} (vendor $${i.vendorPrice}, fee $${i.serviceFee}, total $${i.lineTotal})`)
      : [String(items)]),
    ``,
    session.metadata?.customer_note ? `Customer note: ${session.metadata.customer_note}` : null,
    ``,
    `Fulfillment: place the order with each vendor at their listed price; Desi Fruit Finder keeps the 5% brokerage fee.`,
  ].filter(Boolean);
  await fetch(`https://formsubmit.co/ajax/${encodeURIComponent(email)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      _subject: `🛒 New Desi Fruit Finder order — ${session.id.slice(-8)}`,
      _template: "table",
      message: lines.join("\n"),
      stripe_session: session.id,
    }),
  }).catch(() => {});
}

async function handleCreateCheckout(request, env) {
  if (!env || !env.STRIPE_SECRET_KEY) {
    return checkoutJson({ error: "Checkout is not configured yet (missing STRIPE_SECRET_KEY)." }, 503);
  }
  let body;
  try { body = await request.json(); } catch { return checkoutJson({ error: "Invalid JSON body" }, 400); }
  const items = body.items;
  if (!Array.isArray(items) || items.length === 0) return checkoutJson({ error: "Cart is empty" }, 400);
  if (items.length > MAX_ITEMS) return checkoutJson({ error: `Maximum ${MAX_ITEMS} distinct items per order` }, 400);
  let catalog;
  try { catalog = await getCatalog(env); } catch (err) {
    return checkoutJson({ error: err.message || "Catalog unavailable" }, 503);
  }
  const validated = [];
  const seen = new Set();
  for (const raw of items) {
    const vendorId = String(raw.vendorId || "").trim();
    const fruitName = String(raw.fruitName || "").trim();
    const quantity = Math.min(MAX_QTY, Math.max(1, parseInt(raw.quantity, 10) || 1));
    const key = `${vendorId}:${fruitName}`;
    if (!vendorId || !fruitName) return checkoutJson({ error: "Each item needs vendorId and fruitName" }, 400);
    if (seen.has(key)) return checkoutJson({ error: `Duplicate item: ${fruitName} from ${vendorId}` }, 400);
    seen.add(key);
    const catalogItem = catalog.get(key);
    if (!catalogItem) {
      return checkoutJson({ error: `${fruitName} from ${vendorId} is not available for checkout (no price or not in stock).` }, 400);
    }
    validated.push({ ...catalogItem, quantity });
  }
  try {
    const session = await createStripeSession(env, validated, body.customerNote || "");
    return checkoutJson({ url: session.url, sessionId: session.id });
  } catch (err) {
    return checkoutJson({ error: err.message || "Checkout failed" }, 502);
  }
}

async function handleWebhook(request, env) {
  let event;
  try { event = await verifyStripeWebhook(request, env); } catch (err) {
    return new Response(err.message, { status: 400 });
  }
  if (event.type === "checkout.session.completed") await notifyOrder(env, event.data.object);
  return checkoutJson({ received: true });
}

export default {
  async fetch(request, env) {
    const reqUrl = new URL(request.url);
    const path = reqUrl.pathname.replace(/\/+$/, "") || "/";

    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
        },
      });
    }

    if (request.method === "POST" && path.endsWith("/create-checkout")) {
      return handleCreateCheckout(request, env);
    }
    if (request.method === "POST" && path.endsWith("/webhook")) {
      return handleWebhook(request, env);
    }

    if (request.method !== "GET") {
      return withCors({ error: "Method not allowed" }, 405);
    }

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
      const price = extractPrice(html);
      return withCors({
        status,
        status_text: statusText,
        price,
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
