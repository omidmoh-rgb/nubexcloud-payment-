/**
 * NUBEXCLOUD — N-Genius Payment Server (Production)
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

/* ── Config from environment variables ── */
const API_KEY       = (process.env.NGENIUS_API_KEY    || "").trim();
const OUTLET_ID     = (process.env.NGENIUS_OUTLET_ID  || "").trim();
const CURRENCY      = (process.env.NGENIUS_CURRENCY   || "AED").trim();
const SANDBOX       = (process.env.NGENIUS_SANDBOX    || "false").toLowerCase() !== "false";
const PORT          = Number(process.env.PORT)         || 3000;
const REDIRECT_BASE = (process.env.REDIRECT_BASE_URL  || "").trim();

const BASE     = SANDBOX
  ? "https://api-gateway.sandbox.ngenius-payments.com"
  : "https://api-gateway.ngenius-payments.com";

const IDENTITY = `${BASE}/identity/auth/access-token`;
const ORDERS   = `${BASE}/transactions/outlets/${OUTLET_ID}/orders`;
const OUTLET_Q = `${BASE}/transactions/outlets/${OUTLET_ID}`;
const ORDER_ACTIONS = ["PURCHASE", "SALE", "AUTH"];

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

/* ── Token cache ── */
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
   ROUTES
══════════════════════════════════════════════ */

/* Serve payment page from /public/index.html */
app.get("/", (_req, res) => {
  const htmlPath = path.join(__dirname, "public", "index.html");
  if (!fs.existsSync(htmlPath)) {
    return res.status(404).send("Payment page not found. Put payment-page.html inside a /public folder as index.html");
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

  console.log(`\n[PAYMENT] ${cur} ${(amountInt/100).toFixed(2)} → redirect: ${redirectBase}`);

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

/* Order status */
app.get("/api/order-status/:ref", async (req, res) => {
  try {
    const token = await getAccessToken();
    const r     = await apiFetch(
      `${BASE}/transactions/outlets/${OUTLET_ID}/orders/${req.params.ref}`,
      { headers: { "Authorization": `Bearer ${token}`, "Accept": "application/vnd.ni-payment.v2+json" } }
    );
    const data = await r.json();
    if (!r.ok) return res.status(r.status).json({ error: data.message });
    res.json({ reference: data.reference, status: data.status, amount: data.amount?.value, currency: data.amount?.currencyCode });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* Health check */
app.get("/health", (_req, res) => {
  res.json({ status: "ok", env: SANDBOX?"sandbox":"live", configured: !!(API_KEY && OUTLET_ID) });
});

/* Start */
app.listen(PORT, () => {
  console.log("\n╔══════════════════════════════════════╗");
  console.log("║  Nubexcloud Payment Server — LIVE    ║");
  console.log("╚══════════════════════════════════════╝");
  console.log(`  Port    : ${PORT}`);
  console.log(`  Mode    : ${SANDBOX ? "🧪 SANDBOX" : "🟢 LIVE"}`);
  console.log(`  Currency: ${CURRENCY}`);
  console.log(`  Outlet  : ${OUTLET_ID ? OUTLET_ID.slice(0,8)+"…" : "⚠ NOT SET"}`);
  console.log(`  Key     : ${API_KEY ? "✓ Set" : "⚠ NOT SET"}`);
  console.log(`  Redirect: ${REDIRECT_BASE || "(not set)"}\n`);
});
