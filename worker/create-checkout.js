/**
 * Desi Fruit Finder — Stripe Checkout + webhook for marketplace orders.
 *
 * Deploy on Cloudflare Workers. Set secrets:
 *   STRIPE_SECRET_KEY       — sk_test_... or sk_live_...
 *   STRIPE_WEBHOOK_SECRET   — whsec_... (from Stripe webhook endpoint)
 *   ORDER_EMAIL             — where new-order alerts go (optional, default below)
 *
 * Optional vars:
 *   DATA_JSON_URL — catalog source (defaults to repo data.json on GitHub)
 *   SITE_URL      — e.g. https://gshaheed.github.io/desi-fruit-finder
 *
 * Routes:
 *   POST /create-checkout  — validate cart against data.json, create Stripe session
 *   POST /webhook          — Stripe webhook (checkout.session.completed)
 *   OPTIONS *              — CORS preflight
 */

const BROKER_RATE = 0.05;
const BUYABLE = new Set(["in_stock", "pre_order"]);
const DEFAULT_DATA_JSON =
  "https://raw.githubusercontent.com/gshaheed/desi-fruit-finder/main/data.json";
const DEFAULT_SITE_URL = "https://gshaheed.github.io/desi-fruit-finder";
const DEFAULT_ORDER_EMAIL = "meanhacks@gmail.com";
const MAX_QTY = 10;
const MAX_ITEMS = 20;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}

function resolveVendorFruitView(v, fruitName) {
  if (v.fruit_urls && Object.prototype.hasOwnProperty.call(v.fruit_urls, fruitName)) {
    const fs = (v.fruit_status && v.fruit_status[fruitName]) || {};
    return {
      status: fs.status || "manual",
      price: fs.price ?? null,
    };
  }
  if (v.fruit_urls && !Object.prototype.hasOwnProperty.call(v.fruit_urls, fruitName)) {
    return { status: "manual", price: null };
  }
  return {
    status: v.status,
    price: v.price ?? null,
  };
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
  if (catalogCache.map && now - catalogCache.at < ttlMs) {
    return catalogCache.map;
  }
  const url = env.DATA_JSON_URL || DEFAULT_DATA_JSON;
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
  const siteUrl = (env.SITE_URL || DEFAULT_SITE_URL).replace(/\/$/, "");
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
    params.set(
      `line_items[${idx}][price_data][product_data][name]`,
      `${item.fruitName} — ${item.vendorName}`
    );
    params.set(
      `line_items[${idx}][price_data][product_data][description]`,
      `Vendor-listed price. Fulfilled by ${item.vendorName}.`
    );
    params.set(`line_items[${idx}][price_data][unit_amount]`, String(vCents));
    params.set(`line_items[${idx}][quantity]`, String(qty));
    idx++;

    params.set(`line_items[${idx}][price_data][currency]`, "usd");
    params.set(`line_items[${idx}][price_data][product_data][name]`, "Brokerage service (5%)");
    params.set(
      `line_items[${idx}][price_data][product_data][description]`,
      `Desi Fruit Finder order facilitation for ${item.fruitName}`
    );
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
  if (customerNote) {
    params.set("metadata[customer_note]", customerNote.slice(0, 490));
  }

  const resp = await fetch("https://api.stripe.com/v1/checkout/sessions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params,
  });

  const session = await resp.json();
  if (!resp.ok) {
    throw new Error(session.error?.message || "Stripe session creation failed");
  }
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
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signedPayload));
  const expected = [...new Uint8Array(mac)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  if (expected !== v1) throw new Error("Webhook signature mismatch");

  const age = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (age > 300) throw new Error("Webhook timestamp too old");

  return JSON.parse(body);
}

async function notifyOrder(env, session) {
  const email = env.ORDER_EMAIL || DEFAULT_ORDER_EMAIL;
  const summary = session.metadata?.order_summary || "[]";
  let items;
  try {
    items = JSON.parse(summary);
  } catch {
    items = summary;
  }

  const lines = [
    `Payment received via Desi Fruit Finder`,
    ``,
    `Stripe session: ${session.id}`,
    `Customer email: ${session.customer_details?.email || session.customer_email || "—"}`,
    `Phone: ${session.customer_details?.phone || "—"}`,
    ``,
    `Items:`,
    ...(Array.isArray(items)
      ? items.map(
          (i) =>
            `- ${i.qty}x ${i.fruit} from ${i.vendor} (vendor $${i.vendorPrice}, fee $${i.serviceFee}, total $${i.lineTotal})`
        )
      : [String(items)]),
    ``,
    session.metadata?.customer_note
      ? `Customer note: ${session.metadata.customer_note}`
      : null,
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
  if (!env.STRIPE_SECRET_KEY) {
    return json({ error: "Checkout is not configured yet (missing STRIPE_SECRET_KEY)." }, 503);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const items = body.items;
  if (!Array.isArray(items) || items.length === 0) {
    return json({ error: "Cart is empty" }, 400);
  }
  if (items.length > MAX_ITEMS) {
    return json({ error: `Maximum ${MAX_ITEMS} distinct items per order` }, 400);
  }

  let catalog;
  try {
    catalog = await getCatalog(env);
  } catch (err) {
    return json({ error: err.message || "Catalog unavailable" }, 503);
  }

  const validated = [];
  const seen = new Set();

  for (const raw of items) {
    const vendorId = String(raw.vendorId || "").trim();
    const fruitName = String(raw.fruitName || "").trim();
    const quantity = Math.min(MAX_QTY, Math.max(1, parseInt(raw.quantity, 10) || 1));
    const key = `${vendorId}:${fruitName}`;

    if (!vendorId || !fruitName) {
      return json({ error: "Each item needs vendorId and fruitName" }, 400);
    }
    if (seen.has(key)) {
      return json({ error: `Duplicate item: ${fruitName} from ${vendorId}` }, 400);
    }
    seen.add(key);

    const catalogItem = catalog.get(key);
    if (!catalogItem) {
      return json(
        {
          error: `${fruitName} from ${vendorId} is not available for checkout (no price or not in stock).`,
        },
        400
      );
    }

    validated.push({ ...catalogItem, quantity });
  }

  try {
    const session = await createStripeSession(env, validated, body.customerNote || "");
    return json({ url: session.url, sessionId: session.id });
  } catch (err) {
    return json({ error: err.message || "Checkout failed" }, 502);
  }
}

async function handleWebhook(request, env) {
  let event;
  try {
    event = await verifyStripeWebhook(request, env);
  } catch (err) {
    return new Response(err.message, { status: 400 });
  }

  if (event.type === "checkout.session.completed") {
    await notifyOrder(env, event.data.object);
  }

  return json({ received: true });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS });
    }

    if (request.method === "POST" && url.pathname.endsWith("/create-checkout")) {
      return handleCreateCheckout(request, env);
    }

    if (request.method === "POST" && url.pathname.endsWith("/webhook")) {
      return handleWebhook(request, env);
    }

    return json({ error: "Not found" }, 404);
  },
};
