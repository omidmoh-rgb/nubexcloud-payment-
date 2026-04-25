/**
 * NUBEXCLOUD — N-Genius Payment Server (Production)
 * With HubSpot CRM Integration
 * Deployed on Railway / any Node.js host
 */

require("dotenv").config();

const express = require("express");
const cors    = require("cors");
const path    = require("path");
const fs      = require("fs");

/* ── fetch polyfill ── */
async function apiFetch(url, options) {
  if (typeof globalThis.fetch === "function") return globalThis.fetch(url, options);
  const { default: nf } = await import("node-fetch");
  return nf(url, options);
}

/* ══════════════════════════════════════════════
   CONFIG
══════════════════════════════════════════════ */
const API_KEY        = (process.env.NGENIUS_API_KEY       || "").trim();
const OUTLET_ID      = (process.env.NGENIUS_OUTLET_ID     || "").trim();
const CURRENCY       = (process.env.NGENIUS_CURRENCY      || "AED").trim();
const SANDBOX        = (process.env.NGENIUS_SANDBOX       || "false").toLowerCase() !== "false";
const PORT           = Number(process.env.PORT)            || 3000;
const REDIRECT_BASE  = (process.env.REDIRECT_BASE_URL     || "").trim();
const HS_TOKEN       = (process.env.HUBSPOT_ACCESS_TOKEN  || "").trim();  // ← NEW

const BASE     = SANDBOX
  ? "https://api-gateway.sandbox.ngenius-payments.com"
  : "https://api-gateway.ngenius-payments.com";

const IDENTITY      = `${BASE}/identity/auth/access-token`;
const ORDERS        = `${BASE}/transactions/outlets/${OUTLET_ID}/orders`;
const ORDER_ACTIONS = ["PURCHASE", "SALE", "AUTH"];

/* HubSpot base URL */
const HS_BASE = "https://api.hubapi.com";

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

/* ══════════════════════════════════════════════
   N-GENIUS TOKEN CACHE
══════════════════════════════════════════════ */
const TOKEN = { value: null, expiresAt: 0 };

async function getAccessToken() {
  if (TOKEN.value && Date.now() < TOKEN.expiresAt) return TOKEN.value;
  const res = await apiFetch(IDENTITY, {
    method: "POST",
    headers: {
      "Authorization": `Basic ${API_KEY}`,
      "Content-Type" : "application/vnd.ni-identity.v1+json",
    },
  });
  const txt = await res.text();
  if (!res.ok) throw new Error(`Auth failed (${res.status}): ${txt}`);
  const data      = JSON.parse(txt);
  TOKEN.value     = data.access_token;
  TOKEN.expiresAt = Date.now() + 4.5 * 60 * 1000;
  console.log("  [AUTH] ✓ Token obtained");
  return TOKEN.value;
}

function getRedirectBase(reqBody) {
  if (REDIRECT_BASE) return REDIRECT_BASE;
  if (reqBody?.redirectBase) return reqBody.redirectBase;
  return `http://localhost:${PORT}`;
}

async function tryCreateOrder(token, amountInt, currency, redirectBase) {
  let lastError = null;
  for (const action of ORDER_ACTIONS) {
    const res = await apiFetch(ORDERS, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type" : "application/vnd.ni-payment.v2+json",
        "Accept"       : "application/vnd.ni-payment.v2+json",
      },
      body: JSON.stringify({
        action,
        amount: { currencyCode: currency, value: amountInt },
        merchantAttributes: {
          redirectUrl: `${redirectBase}/?status=success`,
          cancelUrl  : `${redirectBase}/?status=cancelled`,
          skipConfirmationPage: true,
        },
      }),
    });
    const txt = await res.text();
    let order;
    try { order = JSON.parse(txt); } catch { order = { raw: txt }; }
    if (res.ok) {
      const paymentUrl =
        order._links?.payment?.href                 ||
        order._links?.paymentAuthorizationUri?.href ||
        order.payPageUrl;
      if (paymentUrl) {
        console.log(`  [ORDER] ✓ action=${action} ref=${order.reference}`);
        return { order, paymentUrl, action };
      }
    }
    console.log(`  [ORDER] ✗ ${action} → ${res.status}`);
    lastError = { status: res.status, body: order, action };
  }
  throw lastError;
}

/* ══════════════════════════════════════════════
   HUBSPOT INTEGRATION
══════════════════════════════════════════════ */

/**
 * De-duplication guard — tracks order refs already pushed to HubSpot
 * in this process lifetime. Prevents double-push if the success page
 * is refreshed or the status endpoint is polled multiple times.
 */
const HS_PUSHED = new Set();

/**
 * Low-level HubSpot REST call helper
 */
async function hsFetch(path, method = "GET", body = null) {
  if (!HS_TOKEN) throw new Error("HUBSPOT_ACCESS_TOKEN is not set");
  const opts = {
    method,
    headers: {
      "Authorization": `Bearer ${HS_TOKEN}`,
      "Content-Type" : "application/json",
    },
  };
  if (body) opts.body = JSON.stringify(body);
  const res  = await apiFetch(`${HS_BASE}${path}`, opts);
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  return { ok: res.ok, status: res.status, data };
}

/**
 * Upsert a HubSpot Contact.
 * - Tries to create with the generated email.
 * - If a 409 (duplicate) is returned, searches for the existing contact
 *   and returns its ID instead.
 * Returns the HubSpot contact ID (string).
 */
async function hsUpsertContact(orderRef) {
  const email     = `customer-${orderRef}@nubexcloud.com`;
  const firstName = "Customer";
  const lastName  = orderRef;

  // Attempt create
  const create = await hsFetch("/crm/v3/objects/contacts", "POST", {
    properties: {
      email,
      firstname       : firstName,
      lastname        : lastName,
      lifecyclestage  : "customer",
      hs_lead_status  : "CONNECTED",
    },
  });

  if (create.ok) {
    console.log(`  [HS] ✓ Contact created  id=${create.data.id}  email=${email}`);
    return create.data.id;
  }

  // 409 = email already exists → look it up
  if (create.status === 409) {
    const search = await hsFetch("/crm/v3/objects/contacts/search", "POST", {
      filterGroups: [{
        filters: [{
          propertyName : "email",
          operator     : "EQ",
          value        : email,
        }],
      }],
      properties: ["email", "hs_object_id"],
      limit: 1,
    });
    if (search.ok && search.data.results?.length > 0) {
      const id = search.data.results[0].id;
      console.log(`  [HS] ✓ Contact found    id=${id}  email=${email}`);
      return id;
    }
  }

  throw new Error(`HubSpot contact upsert failed (${create.status}): ${JSON.stringify(create.data)}`);
}

/**
 * Create a HubSpot Deal and immediately associate it with the contact.
 * Returns the deal ID.
 */
async function hsCreateDeal(orderRef, amountRaw, currency, status, contactId) {
  // Convert amount from minor units (cents) back to major units for display
  const amountMajor = (amountRaw / 100).toFixed(2);
  const dealName    = `Nubex Payment — ${orderRef}`;
  const environment = SANDBOX ? "Sandbox" : "Live";
  const now         = new Date().toISOString().split("T")[0]; // YYYY-MM-DD

  const res = await hsFetch("/crm/v3/objects/deals", "POST", {
    properties: {
      dealname       : dealName,
      amount         : amountMajor,
      pipeline       : "default",
      dealstage      : "closedwon",
      closedate      : now,
      deal_currency_code: currency,

      // Custom note field — visible in deal timeline
      description    : [
        `Order Ref : ${orderRef}`,
        `Amount    : ${currency} ${amountMajor}`,
        `Status    : ${status}`,
        `Gateway   : N-Genius / Network International`,
        `Mode      : ${environment}`,
        `Processed : ${new Date().toUTCString()}`,
      ].join("\n"),
    },
    associations: [
      {
        to   : { id: contactId },
        types: [{
          associationCategory: "HUBSPOT_DEFINED",
          associationTypeId  : 3,   // Deal → Contact
        }],
      },
    ],
  });

  if (!res.ok) {
    throw new Error(`HubSpot deal creation failed (${res.status}): ${JSON.stringify(res.data)}`);
  }

  console.log(`  [HS] ✓ Deal created     id=${res.data.id}  name="${dealName}"`);
  return res.data.id;
}

/**
 * Master function — called automatically after a confirmed payment.
 * Runs entirely server-side; the customer is never aware.
 * Fire-and-forget (errors are logged but do NOT affect the API response).
 */
async function pushToHubSpot(orderRef, amountRaw, currency, status) {
  if (!HS_TOKEN) {
    console.warn("  [HS] ⚠ HUBSPOT_ACCESS_TOKEN not set — skipping CRM push");
    return;
  }
  if (HS_PUSHED.has(orderRef)) {
    console.log(`  [HS] ↩ Already pushed  ref=${orderRef}`);
    return;
  }

  console.log(`\n  [HS] Pushing to HubSpot — ref=${orderRef} ${currency} ${amountRaw}`);

  try {
    const contactId = await hsUpsertContact(orderRef);
    const dealId    = await hsCreateDeal(orderRef, amountRaw, currency, status, contactId);
    HS_PUSHED.add(orderRef);
    console.log(`  [HS] ✅ CRM record complete — contact=${contactId}  deal=${dealId}\n`);
  } catch (err) {
    // Never crash the payment server over a CRM error
    console.error("  [HS] ✗ CRM push error:", err.message);
  }
}

/* ══════════════════════════════════════════════
   ROUTES
══════════════════════════════════════════════ */

/* Serve payment page */
app.get("/", (_req, res) => {
  const htmlPath = path.join(__dirname, "public", "index.html");
  if (!fs.existsSync(htmlPath)) {
    return res.status(404).send("Payment page not found. Put index.html inside a /public folder.");
  }
  let html = fs.readFileSync(htmlPath, "utf8");
  const inject = `<script>window.__SERVER_CONFIG__={currency:"${CURRENCY}",sandbox:${SANDBOX},serverMode:true};</script>`;
  html = html.replace("</head>", inject + "\n</head>");
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(html);
});

/* Create payment order */
app.post("/api/create-payment", async (req, res) => {
  if (!API_KEY || !OUTLET_ID) {
    return res.status(500).json({ error: "Server not configured. Missing API credentials." });
  }
  const { amount, currency } = req.body;
  if (!amount || isNaN(Number(amount)) || Number(amount) <= 0) {
    return res.status(400).json({ error: "Invalid amount" });
  }
  const amountInt    = Math.round(Number(amount));
  const cur          = (currency || CURRENCY).trim();
  const redirectBase = getRedirectBase(req.body);

  console.log(`\n[PAYMENT] ${cur} ${(amountInt / 100).toFixed(2)} → redirect: ${redirectBase}`);

  try {
    const token  = await getAccessToken();
    const result = await tryCreateOrder(token, amountInt, cur, redirectBase);
    return res.json({
      paymentUrl: result.paymentUrl,
      orderId   : result.order.reference,
      reference : result.order.reference,
      status    : result.order.status,
      action    : result.action,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : JSON.stringify(err);
    console.error("[ERROR]", message);
    return res.status(500).json({ error: message });
  }
});

/* Order status — also triggers HubSpot push on confirmed payments */
app.get("/api/order-status/:ref", async (req, res) => {
  try {
    const token = await getAccessToken();
    const r     = await apiFetch(
      `${BASE}/transactions/outlets/${OUTLET_ID}/orders/${req.params.ref}`,
      { headers: { "Authorization": `Bearer ${token}`, "Accept": "application/vnd.ni-payment.v2+json" } }
    );
    const data = await r.json();
    if (!r.ok) return res.status(r.status).json({ error: data.message });

    const orderRef = data.reference;
    const status   = (data.status || "").toUpperCase();
    const amount   = data.amount?.value    || 0;
    const currency = data.amount?.currencyCode || CURRENCY;

    /* ── Auto-push confirmed payments to HubSpot (fire-and-forget) ── */
    const CONFIRMED_STATUSES = ["CAPTURED", "AUTHORISED", "PURCHASED", "SALE"];
    if (orderRef && CONFIRMED_STATUSES.some(s => status.includes(s))) {
      // Deliberately not awaited — CRM push never delays the customer's response
      pushToHubSpot(orderRef, amount, currency, status).catch(() => {});
    }

    res.json({ reference: orderRef, status, amount, currency });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* Health check — now also reports HubSpot config status */
app.get("/health", (_req, res) => {
  res.json({
    status    : "ok",
    env       : SANDBOX ? "sandbox" : "live",
    configured: !!(API_KEY && OUTLET_ID),
    hubspot   : HS_TOKEN ? "✓ configured" : "⚠ not configured",
    hs_pushed : HS_PUSHED.size,
  });
});

/* Start */
app.listen(PORT, () => {
  console.log("\n╔══════════════════════════════════════════╗");
  console.log("║  Nubexcloud Payment Server — LIVE        ║");
  console.log("╚══════════════════════════════════════════╝");
  console.log(`  Port    : ${PORT}`);
  console.log(`  Mode    : ${SANDBOX ? "🧪 SANDBOX" : "🟢 LIVE"}`);
  console.log(`  Currency: ${CURRENCY}`);
  console.log(`  Outlet  : ${OUTLET_ID ? OUTLET_ID.slice(0, 8) + "…" : "⚠ NOT SET"}`);
  console.log(`  Key     : ${API_KEY   ? "✓ Set"    : "⚠ NOT SET"}`);
  console.log(`  Redirect: ${REDIRECT_BASE || "(not set)"}`);
  console.log(`  HubSpot : ${HS_TOKEN  ? "✓ Set"    : "⚠ NOT SET — CRM push disabled"}\n`);
});
