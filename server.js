/**
 * NubexCloud Payment Server
 * ─────────────────────────────────────────────────────────────
 * Gateways : N-Genius (Network.ae)  +  Stripe
 * CRM      : HubSpot
 * Accounting: QuickBooks Online
 * Host     : Railway
 *
 * ENV variables required:
 *   NGENIUS_API_KEY          Network.ae API key
 *   NGENIUS_OUTLET_ID        Network.ae outlet UUID
 *   NGENIUS_CURRENCY         AED | USD | EUR  (default AED)
 *   NGENIUS_SANDBOX          true | false
 *   STRIPE_SECRET_KEY        sk_live_... or sk_test_...
 *   STRIPE_PUBLISHABLE_KEY   pk_live_... or pk_test_...
 *   STRIPE_WEBHOOK_SECRET    whsec_...  (from Stripe dashboard)
 *   HS_TOKEN                 HubSpot private app token
 *   QB_CLIENT_ID             QuickBooks app client ID
 *   QB_CLIENT_SECRET         QuickBooks app client secret
 *   ADMIN_PASSWORD           Admin panel password
 *   PORT                     (Railway sets this automatically)
 */

"use strict";

// ── Deps ─────────────────────────────────────────────────────
const express  = require("express");
const cors     = require("cors");
const path     = require("path");
require("dotenv").config();

// Stripe — loaded once with secret key
const Stripe   = require("stripe");
const stripe   = Stripe(process.env.STRIPE_SECRET_KEY || "");

// ── Config ────────────────────────────────────────────────────
const PORT         = process.env.PORT             || 3000;
const API_KEY      = process.env.NGENIUS_API_KEY  || "";
const OUTLET_ID    = process.env.NGENIUS_OUTLET_ID|| "";
const CURRENCY     = process.env.NGENIUS_CURRENCY || "AED";
const SANDBOX      = process.env.NGENIUS_SANDBOX  === "true";
const HS_TOKEN     = process.env.HS_TOKEN         || "";
const QB_CLIENT_ID = process.env.QB_CLIENT_ID     || "";
const QB_CLIENT_SECRET = process.env.QB_CLIENT_SECRET || "";
const ADMIN_PASSWORD   = process.env.ADMIN_PASSWORD   || "admin123";

const NGENIUS_BASE = SANDBOX
  ? "https://api-gateway.sandbox.ngenius-payments.com"
  : "https://api-gateway.ngenius-payments.com";

// ── Dedup sets (prevent double-push per order ref) ────────────
const HS_PUSHED = new Set();
const QB_PUSHED = new Set();

// ── QuickBooks state ──────────────────────────────────────────
let qbState = {
  accessToken : process.env.QB_ACCESS_TOKEN  || "",
  refreshToken: process.env.QB_REFRESH_TOKEN || "",
  realmId     : process.env.QB_REALM_ID      || "",
};
const QB_SANDBOX    = process.env.QB_SANDBOX === "true";
const QB_AUTH_BASE  = "https://appcenter.intuit.com/connect/oauth2";
const QB_API_BASE   = QB_SANDBOX
  ? "https://sandbox-quickbooks.api.intuit.com"
  : "https://quickbooks.api.intuit.com";

// ── App setup ─────────────────────────────────────────────────
const app = express();
app.use(cors());
app.use(express.static(path.join(__dirname, "public")));

// ─────────────────────────────────────────────────────────────
//  IMPORTANT: Stripe webhook MUST receive the raw body.
//  This route is declared BEFORE express.json() middleware.
// ─────────────────────────────────────────────────────────────
app.post(
  "/api/stripe/webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    const sig    = req.headers["stripe-signature"];
    const secret = process.env.STRIPE_WEBHOOK_SECRET || "";

    let event;
    try {
      event = stripe.webhooks.constructEvent(req.body, sig, secret);
    } catch (err) {
      console.error("[Stripe Webhook] Signature verification failed:", err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    console.log(`[Stripe Webhook] Event: ${event.type}`);

    if (event.type === "payment_intent.succeeded") {
      const pi       = event.data.object;
      const ref      = pi.metadata.ref      || pi.id;
      const email    = pi.metadata.email    || pi.receipt_email || "";
      const name     = pi.metadata.name     || "NubexCloud Customer";
      const amount   = pi.amount / 100;
      const currency = pi.currency.toUpperCase();
      pushToHubSpot(ref, amount, currency, email, name).catch(() => {});
      pushToQuickBooks(ref, amount, currency, email, name).catch(() => {});
    }

    if (event.type === "checkout.session.completed") {
      const session  = event.data.object;
      const ref      = session.metadata?.ref   || session.id;
      const email    = session.customer_email  || session.metadata?.email || "";
      const name     = session.metadata?.name  || "NubexCloud Customer";
      const amount   = session.amount_total / 100;
      const currency = session.currency.toUpperCase();
      pushToHubSpot(ref, amount, currency, email, name).catch(() => {});
      pushToQuickBooks(ref, amount, currency, email, name).catch(() => {});
    }

    res.json({ received: true });
  }
);

// ── JSON body parser (after raw webhook route) ────────────────
app.use(express.json());

// ═══════════════════════════════════════════════════════════════
//  N-GENIUS (NETWORK.AE) — UNCHANGED
// ═══════════════════════════════════════════════════════════════

/** Authenticate with N-Genius and return a bearer token */
async function getNGeniusToken() {
  const { default: fetch } = await import("node-fetch");
  const res = await fetch(`${NGENIUS_BASE}/identity/auth/access-token`, {
    method : "POST",
    headers: {
      "Content-Type" : "application/vnd.ni-identity.v1+json",
      "Authorization": `Basic ${API_KEY}`,
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`N-Genius auth failed ${res.status}: ${text}`);
  }
  const data = await res.json();
  return data.access_token;
}

/** Create an N-Genius order and return the redirect URL */
async function createNGeniusOrder(amount, currency, ref, email, name) {
  const { default: fetch } = await import("node-fetch");
  const token  = await getNGeniusToken();
  const amountInCents = Math.round(parseFloat(amount) * 100);

  const body = {
    action      : "SALE",
    amount      : { currencyCode: currency, value: amountInCents },
    merchantAttributes: {
      redirectUrl      : `${process.env.PUBLIC_URL || ""}/payment-success.html`,
      cancelUrl        : `${process.env.PUBLIC_URL || ""}/index.html`,
      skipConfirmation : false,
    },
    emailAddress: email,
    merchantOrderId: ref,
    billingAddress  : { firstName: name },
    language: "en",
  };

  const res = await fetch(
    `${NGENIUS_BASE}/transactions/outlets/${OUTLET_ID}/orders`,
    {
      method : "POST",
      headers: {
        "Content-Type" : "application/vnd.ni-payment.v2+json",
        "Accept"       : "application/vnd.ni-payment.v2+json",
        "Authorization": `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    }
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`N-Genius order failed ${res.status}: ${text}`);
  }

  const data = await res.json();
  // Extract hosted payment page URL
  const links  = data._links || {};
  const payUrl = (links["payment.hosted"] || links["payment"] || {}).href || "";
  const orderRef = data.reference || ref;
  return { payUrl, orderRef, raw: data };
}

// POST /api/create-payment  (N-Genius)
app.post("/api/create-payment", async (req, res) => {
  try {
    const { amount, currency = CURRENCY, email, name, ref } = req.body;
    if (!amount || !email) {
      return res.status(400).json({ error: "amount and email are required" });
    }

    const orderRef = ref || `NX-${Date.now()}`;
    const { payUrl, orderRef: confirmedRef, raw } = await createNGeniusOrder(
      amount, currency, orderRef, email, name || "Customer"
    );

    if (!payUrl) {
      return res.status(502).json({ error: "No payment URL returned from N-Genius", raw });
    }

    res.json({ redirectUrl: payUrl, ref: confirmedRef });
  } catch (err) {
    console.error("[N-Genius] create-payment error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/order-status/:ref  (N-Genius)
app.get("/api/order-status/:ref", async (req, res) => {
  try {
    const { default: fetch } = await import("node-fetch");
    const token = await getNGeniusToken();
    const r = await fetch(
      `${NGENIUS_BASE}/transactions/outlets/${OUTLET_ID}/orders/${req.params.ref}`,
      {
        headers: {
          "Authorization": `Bearer ${token}`,
          "Accept"       : "application/vnd.ni-payment.v2+json",
        },
      }
    );
    const data = await r.json();

    const status   = data.status || "UNKNOWN";
    const captured = ["CAPTURED", "AUTHORISED", "PURCHASED", "SALE"].includes(status);

    if (captured) {
      const payment = (data._embedded?.payment || [])[0] || {};
      const amount  = (payment.amount?.value || 0) / 100;
      const cur     = payment.amount?.currencyCode || CURRENCY;
      const email   = data.emailAddress || "";
      const name    = data.billingAddress?.firstName || "Customer";

      pushToHubSpot(req.params.ref, amount, cur, email, name).catch(() => {});
      pushToQuickBooks(req.params.ref, amount, cur, email, name).catch(() => {});
    }

    res.json({ status, captured, ref: req.params.ref });
  } catch (err) {
    console.error("[N-Genius] order-status error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /payment-initiate  (N-Genius redirect helper)
app.get("/payment-initiate", async (req, res) => {
  try {
    const { amount, currency = CURRENCY, email = "customer@nubexcloud.com", name = "Customer" } = req.query;
    if (!amount) return res.status(400).send("Missing amount");

    const ref = `NX-${Date.now()}`;
    const { payUrl } = await createNGeniusOrder(amount, currency, ref, email, name);
    if (!payUrl) return res.status(502).send("No redirect URL from N-Genius");
    res.redirect(payUrl);
  } catch (err) {
    console.error("[payment-initiate] error:", err.message);
    res.status(500).send(`Payment error: ${err.message}`);
  }
});

// ═══════════════════════════════════════════════════════════════
//  STRIPE — NEW
// ═══════════════════════════════════════════════════════════════

// POST /api/stripe/create-checkout-session  (hosted Stripe Checkout page)
app.post("/api/stripe/create-checkout-session", async (req, res) => {
  try {
    const { amount, currency = "usd", email, name, ref } = req.body;
    if (!amount || !email) {
      return res.status(400).json({ error: "amount and email are required" });
    }

    const orderRef      = ref || `NX-STR-${Date.now()}`;
    const amountInCents = Math.round(parseFloat(amount) * 100);
    const base          = process.env.PUBLIC_URL || "https://nubexcloud-payment-production.up.railway.app";

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      mode                : "payment",
      customer_email      : email,
      line_items: [{
        price_data: {
          currency    : currency.toLowerCase(),
          product_data: {
            name       : "NubexCloud Cloud Credit",
            description: `Top-Up — Ref: ${orderRef}`,
          },
          unit_amount: amountInCents,
        },
        quantity: 1,
      }],
      success_url: `${base}/payment-success.html?session_id={CHECKOUT_SESSION_ID}&ref=${orderRef}`,
      cancel_url : `${base}/index.html`,
      metadata   : { ref: orderRef, email, name: name || "Customer" },
    });

    console.log(`[Stripe Checkout] Session created: ${session.id} | $${amount} ${currency.toUpperCase()} | ${email}`);
    res.json({ url: session.url });
  } catch (err) {
    console.error("[Stripe Checkout] error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/stripe/create-payment-intent
app.post("/api/stripe/create-payment-intent", async (req, res) => {
  try {
    const { amount, currency = "usd", email, name, ref } = req.body;
    if (!amount || !email) {
      return res.status(400).json({ error: "amount and email are required" });
    }

    // Stripe amounts are in smallest currency unit (cents for USD)
    const amountInCents = Math.round(parseFloat(amount) * 100);
    const orderRef      = ref || `NX-STR-${Date.now()}`;

    const paymentIntent = await stripe.paymentIntents.create({
      amount  : amountInCents,
      currency: currency.toLowerCase(),
      metadata: { ref: orderRef, email, name: name || "Customer" },
      receipt_email: email,
      description: `NubexCloud Top-Up — ${orderRef}`,
    });

    console.log(`[Stripe] PaymentIntent created: ${paymentIntent.id} | $${amount} ${currency.toUpperCase()} | ${email}`);
    res.json({ clientSecret: paymentIntent.client_secret, ref: orderRef });
  } catch (err) {
    console.error("[Stripe] create-payment-intent error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/stripe/config  (expose publishable key to frontend safely)
app.get("/api/stripe/config", (_req, res) => {
  res.json({ publishableKey: process.env.STRIPE_PUBLISHABLE_KEY || "" });
});

// ═══════════════════════════════════════════════════════════════
//  SHARED — HUBSPOT
// ═══════════════════════════════════════════════════════════════
async function pushToHubSpot(ref, amount, currency, email, name) {
  if (!HS_TOKEN || HS_PUSHED.has(ref)) return;
  HS_PUSHED.add(ref);

  try {
    const { default: fetch } = await import("node-fetch");

    // Upsert contact
    const contactRes = await fetch("https://api.hubapi.com/crm/v3/objects/contacts", {
      method : "POST",
      headers: {
        "Content-Type" : "application/json",
        "Authorization": `Bearer ${HS_TOKEN}`,
      },
      body: JSON.stringify({
        properties: {
          email    : email,
          firstname: name.split(" ")[0] || name,
          lastname : name.split(" ").slice(1).join(" ") || "",
        },
      }),
    });

    let contactId = "";
    if (contactRes.ok) {
      const c = await contactRes.json();
      contactId = c.id;
    } else if (contactRes.status === 409) {
      // Contact exists — get ID from conflict response
      const c = await contactRes.json();
      contactId = (c.message?.match(/ID: (\d+)/) || [])[1] || "";
    }

    // Create deal
    await fetch("https://api.hubapi.com/crm/v3/objects/deals", {
      method : "POST",
      headers: {
        "Content-Type" : "application/json",
        "Authorization": `Bearer ${HS_TOKEN}`,
      },
      body: JSON.stringify({
        properties: {
          dealname  : `NubexCloud Payment — ${ref}`,
          amount    : String(amount),
          currency  : currency,
          dealstage : "closedwon",
          closedate : new Date().toISOString().split("T")[0],
        },
        associations: contactId
          ? [{ to: { id: contactId }, types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: 3 }] }]
          : [],
      }),
    });

    console.log(`[HubSpot] ✅ Pushed: ${ref}`);
  } catch (err) {
    console.error(`[HubSpot] Error for ${ref}:`, err.message);
  }
}

// ═══════════════════════════════════════════════════════════════
//  SHARED — QUICKBOOKS
// ═══════════════════════════════════════════════════════════════
async function refreshQBToken() {
  const { default: fetch } = await import("node-fetch");
  const creds = Buffer.from(`${QB_CLIENT_ID}:${QB_CLIENT_SECRET}`).toString("base64");
  const res = await fetch("https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer", {
    method : "POST",
    headers: {
      "Content-Type" : "application/x-www-form-urlencoded",
      "Authorization": `Basic ${creds}`,
    },
    body: new URLSearchParams({
      grant_type   : "refresh_token",
      refresh_token: qbState.refreshToken,
    }),
  });
  const data = await res.json();
  if (data.access_token) {
    qbState.accessToken  = data.access_token;
    qbState.refreshToken = data.refresh_token || qbState.refreshToken;
  }
}

async function pushToQuickBooks(ref, amount, currency, email, name) {
  if (!QB_CLIENT_ID || !qbState.refreshToken || QB_PUSHED.has(ref)) return;
  QB_PUSHED.add(ref);

  try {
    await refreshQBToken();
    const { default: fetch } = await import("node-fetch");
    const headers = {
      "Content-Type" : "application/json",
      "Authorization": `Bearer ${qbState.accessToken}`,
      "Accept"       : "application/json",
    };
    const base = `${QB_API_BASE}/v3/company/${qbState.realmId}`;

    // Create Customer
    const custRes = await fetch(`${base}/customer`, {
      method : "POST",
      headers,
      body   : JSON.stringify({
        DisplayName: `${name || "Customer"} (${ref})`,
        PrimaryEmailAddr: { Address: email },
        CurrencyRef: { value: currency },
      }),
    });
    const custData = await custRes.json();
    const custId   = custData.Customer?.Id || "1";

    // Create Invoice
    const invRes = await fetch(`${base}/invoice`, {
      method : "POST",
      headers,
      body   : JSON.stringify({
        CustomerRef : { value: custId },
        CurrencyRef : { value: currency },
        Line: [{
          Amount     : amount,
          DetailType : "SalesItemLineDetail",
          Description: `NubexCloud Top-Up — ${ref}`,
          SalesItemLineDetail: {
            ItemRef   : { value: "1", name: "Services" },
            Qty       : 1,
            UnitPrice : amount,
          },
        }],
      }),
    });
    const invData = await invRes.json();
    const invId   = invData.Invoice?.Id;

    // Create Payment linked to invoice
    if (invId) {
      await fetch(`${base}/payment`, {
        method : "POST",
        headers,
        body   : JSON.stringify({
          CustomerRef  : { value: custId },
          TotalAmt     : amount,
          CurrencyRef  : { value: currency },
          Line: [{
            Amount    : amount,
            LinkedTxn : [{ TxnId: invId, TxnType: "Invoice" }],
          }],
        }),
      });
    }

    console.log(`[QuickBooks] ✅ Pushed: ${ref}`);
  } catch (err) {
    console.error(`[QuickBooks] Error for ${ref}:`, err.message);
  }
}

// ═══════════════════════════════════════════════════════════════
//  ADMIN PANEL
// ═══════════════════════════════════════════════════════════════

function checkAdmin(req, res, next) {
  const auth = req.headers.authorization || "";
  const pass = auth.replace("Bearer ", "");
  if (pass !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

app.get("/admin/test", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "admin.html"));
});

app.post("/admin/login", (req, res) => {
  const { password } = req.body;
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ error: "Wrong password" });
  res.json({ token: ADMIN_PASSWORD });
});

// QuickBooks OAuth
app.get("/admin/qb-setup", checkAdmin, (_req, res) => {
  const params = new URLSearchParams({
    client_id    : QB_CLIENT_ID,
    response_type: "code",
    scope        : "com.intuit.quickbooks.accounting",
    redirect_uri : `${process.env.PUBLIC_URL || ""}/admin/qb-callback`,
    state        : "nubex",
  });
  res.redirect(`${QB_AUTH_BASE}?${params}`);
});

app.get("/admin/qb-callback", async (req, res) => {
  try {
    const { default: fetch } = await import("node-fetch");
    const { code, realmId } = req.query;
    const creds = Buffer.from(`${QB_CLIENT_ID}:${QB_CLIENT_SECRET}`).toString("base64");
    const r = await fetch("https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer", {
      method : "POST",
      headers: {
        "Content-Type" : "application/x-www-form-urlencoded",
        "Authorization": `Basic ${creds}`,
      },
      body: new URLSearchParams({
        grant_type  : "authorization_code",
        code,
        redirect_uri: `${process.env.PUBLIC_URL || ""}/admin/qb-callback`,
      }),
    });
    const data = await r.json();
    qbState.accessToken  = data.access_token  || "";
    qbState.refreshToken = data.refresh_token || "";
    qbState.realmId      = realmId || "";
    console.log("[QB] OAuth complete. RealmId:", realmId);
    res.send(`<h2>✅ QuickBooks Connected!</h2><p>Realm: ${realmId}</p><p>Copy these to Railway env vars:</p><pre>QB_ACCESS_TOKEN=${qbState.accessToken}\nQB_REFRESH_TOKEN=${qbState.refreshToken}\nQB_REALM_ID=${realmId}</pre>`);
  } catch (err) {
    res.status(500).send(`QB OAuth error: ${err.message}`);
  }
});

// ── Health & Status ────────────────────────────────────────────
app.get("/health", (_req, res) => {
  res.json({
    status    : "ok",
    ts        : new Date().toISOString(),
    env       : SANDBOX ? "sandbox" : "live",
    ngenius   : API_KEY    ? "configured" : "NOT SET",
    stripe    : process.env.STRIPE_SECRET_KEY ? "configured" : "NOT SET",
    hubspot   : HS_TOKEN   ? "configured" : "NOT SET",
    quickbooks: qbState.realmId ? `connected (${qbState.realmId})` : "not configured",
    hs_pushed : HS_PUSHED.size,
    qb_pushed : QB_PUSHED.size,
  });
});

// ── Start ──────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log("\n+--------------------------------------------------+");
  console.log("|   NubexCloud Payment Server — Network.ae + Stripe  |");
  console.log("+--------------------------------------------------+");
  console.log(`  Port      : ${PORT}`);
  console.log(`  Mode      : ${SANDBOX ? "SANDBOX" : "LIVE"}`);
  console.log(`  Currency  : ${CURRENCY}`);
  console.log(`  N-Genius  : ${API_KEY  ? "✅ Set" : "❌ NOT SET"}`);
  console.log(`  Stripe    : ${process.env.STRIPE_SECRET_KEY ? "✅ Set" : "❌ NOT SET"}`);
  console.log(`  HubSpot   : ${HS_TOKEN ? "✅ Set" : "❌ NOT SET"}`);
  console.log(`  QB Realm  : ${qbState.realmId || "NOT SET"}`);
  console.log(`  Admin     : ${ADMIN_PASSWORD ? "✅ Set" : "❌ NOT SET"}\n`);
});
