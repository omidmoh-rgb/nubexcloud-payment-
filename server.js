/**
 * NUBEXCLOUD — N-Genius Payment Server (Production)
 * + HubSpot CRM Integration
 * + QuickBooks Online Integration
 * + Password-Protected Admin Test Panel  (/admin/test)
 */

require("dotenv").config();

const express = require("express");
const cors    = require("cors");
const path    = require("path");
const fs      = require("fs");

async function apiFetch(url, options) {
  if (typeof globalThis.fetch === "function") return globalThis.fetch(url, options);
  const { default: nf } = await import("node-fetch");
  return nf(url, options);
}

// ── Config ─────────────────────────────────────────────────────────────────
const API_KEY        = (process.env.NGENIUS_API_KEY       || "").trim();
const OUTLET_ID      = (process.env.NGENIUS_OUTLET_ID     || "").trim();
const CURRENCY       = (process.env.NGENIUS_CURRENCY      || "AED").trim();
const SANDBOX        = (process.env.NGENIUS_SANDBOX       || "false").toLowerCase() !== "false";
const PORT           = Number(process.env.PORT)            || 3000;
const REDIRECT_BASE  = (process.env.REDIRECT_BASE_URL     || "").trim();
const HS_TOKEN       = (process.env.HUBSPOT_ACCESS_TOKEN  || "").trim();
const ADMIN_PASSWORD = (process.env.ADMIN_PASSWORD        || "").trim();

const QB_CLIENT_ID     = (process.env.QB_CLIENT_ID     || "").trim();
const QB_CLIENT_SECRET = (process.env.QB_CLIENT_SECRET || "").trim();
const QB_REALM_ID_ENV  = (process.env.QB_REALM_ID      || "").trim();
const QB_REFRESH_INIT  = (process.env.QB_REFRESH_TOKEN || "").trim();
const QB_SANDBOX_MODE  = (process.env.QB_SANDBOX       || "false").toLowerCase() !== "false";

const BASE = SANDBOX
  ? "https://api-gateway.sandbox.ngenius-payments.com"
  : "https://api-gateway.ngenius-payments.com";

const IDENTITY      = `${BASE}/identity/auth/access-token`;
const ORDERS        = `${BASE}/transactions/outlets/${OUTLET_ID}/orders`;
const ORDER_ACTIONS = ["PURCHASE", "SALE", "AUTH"];
const HS_BASE       = "https://api.hubapi.com";

const QB_API_BASE  = QB_SANDBOX_MODE
  ? "https://sandbox-quickbooks.api.intuit.com"
  : "https://quickbooks.api.intuit.com";
const QB_TOKEN_URL = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer";
const QB_AUTH_URL  = "https://appcenter.intuit.com/connect/oauth2";
const QB_TOKEN_FILE = "/tmp/qb_tokens.json";

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ── N-Genius ────────────────────────────────────────────────────────────────
const TOKEN = { value: null, expiresAt: 0 };

async function getAccessToken() {
  if (TOKEN.value && Date.now() < TOKEN.expiresAt) return TOKEN.value;
  const res = await apiFetch(IDENTITY, {
    method : "POST",
    headers: { "Authorization": `Basic ${API_KEY}`, "Content-Type": "application/vnd.ni-identity.v1+json" },
  });
  const txt = await res.text();
  if (!res.ok) throw new Error(`Auth failed (${res.status}): ${txt}`);
  const data      = JSON.parse(txt);
  TOKEN.value     = data.access_token;
  TOKEN.expiresAt = Date.now() + 4.5 * 60 * 1000;
  console.log("  [AUTH] Token obtained");
  return TOKEN.value;
}

function getRedirectBase(reqBody) {
  if (REDIRECT_BASE)              return REDIRECT_BASE;
  if (reqBody && reqBody.redirectBase) return reqBody.redirectBase;
  return `http://localhost:${PORT}`;
}

async function tryCreateOrder(token, amountInt, currency, redirectBase) {
  let lastError = null;
  for (const action of ORDER_ACTIONS) {
    const res = await apiFetch(ORDERS, {
      method : "POST",
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
        (order._links && order._links.payment && order._links.payment.href) ||
        (order._links && order._links.paymentAuthorizationUri && order._links.paymentAuthorizationUri.href) ||
        order.payPageUrl;
      if (paymentUrl) {
        console.log(`  [ORDER] action=${action} ref=${order.reference}`);
        return { order, paymentUrl, action };
      }
    }
    lastError = { status: res.status, body: order, action };
  }
  throw lastError;
}

// ── HubSpot ─────────────────────────────────────────────────────────────────
const HS_PUSHED = new Set();

async function hsFetch(endpoint, method, body) {
  if (!HS_TOKEN) throw new Error("HUBSPOT_ACCESS_TOKEN is not set");
  const opts = { method: method || "GET", headers: { "Authorization": `Bearer ${HS_TOKEN}`, "Content-Type": "application/json" } };
  if (body) opts.body = JSON.stringify(body);
  const res  = await apiFetch(`${HS_BASE}${endpoint}`, opts);
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = { raw: text }; }
  return { ok: res.ok, status: res.status, data };
}

async function hsUpsertContact(orderRef) {
  const email  = `customer-${orderRef}@nubexcloud.com`;
  const create = await hsFetch("/crm/v3/objects/contacts", "POST", {
    properties: { email, firstname: "Customer", lastname: orderRef, lifecyclestage: "customer", hs_lead_status: "CONNECTED" },
  });
  if (create.ok) { console.log(`  [HS] Contact created id=${create.data.id}`); return create.data.id; }
  if (create.status === 409) {
    const s = await hsFetch("/crm/v3/objects/contacts/search", "POST", {
      filterGroups: [{ filters: [{ propertyName: "email", operator: "EQ", value: email }] }],
      properties: ["email", "hs_object_id"], limit: 1,
    });
    if (s.ok && s.data.results && s.data.results.length > 0) { console.log(`  [HS] Contact found id=${s.data.results[0].id}`); return s.data.results[0].id; }
  }
  throw new Error(`HS Contact failed (${create.status}): ${JSON.stringify(create.data)}`);
}

async function hsCreateDeal(orderRef, amountRaw, currency, status, contactId) {
  const amtMajor = (amountRaw / 100).toFixed(2);
  const res = await hsFetch("/crm/v3/objects/deals", "POST", {
    properties: {
      dealname: `Nubex Payment - ${orderRef}`, amount: amtMajor, pipeline: "default",
      dealstage: "closedwon", closedate: new Date().toISOString().split("T")[0],
      deal_currency_code: currency,
      description: `Order: ${orderRef}\nAmount: ${currency} ${amtMajor}\nStatus: ${status}\nGateway: N-Genius\nProcessed: ${new Date().toUTCString()}`,
    },
    associations: [{ to: { id: contactId }, types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: 3 }] }],
  });
  if (!res.ok) throw new Error(`HS Deal failed (${res.status}): ${JSON.stringify(res.data)}`);
  console.log(`  [HS] Deal created id=${res.data.id}`);
  return res.data.id;
}

async function pushToHubSpot(orderRef, amountRaw, currency, status, force) {
  if (!HS_TOKEN) throw new Error("HUBSPOT_ACCESS_TOKEN is not set");
  if (!force && HS_PUSHED.has(orderRef)) return null;
  console.log(`\n  [HS] Pushing ref=${orderRef} ${currency} ${amountRaw}`);
  const contactId = await hsUpsertContact(orderRef);
  const dealId    = await hsCreateDeal(orderRef, amountRaw, currency, status, contactId);
  HS_PUSHED.add(orderRef);
  console.log(`  [HS] Complete contact=${contactId} deal=${dealId}\n`);
  return { contactId, dealId };
}

// ── QuickBooks Online ────────────────────────────────────────────────────────
const qbState = {
  accessToken    : null,
  refreshToken   : QB_REFRESH_INIT,
  realmId        : QB_REALM_ID_ENV,
  accessExpiresAt: 0,
};

function qbLoadTokenFile() {
  try {
    if (fs.existsSync(QB_TOKEN_FILE)) {
      const d = JSON.parse(fs.readFileSync(QB_TOKEN_FILE, "utf8"));
      if (d.refreshToken) qbState.refreshToken = d.refreshToken;
      if (d.realmId)      qbState.realmId      = d.realmId;
      if (d.accessToken && d.accessExpiresAt > Date.now()) {
        qbState.accessToken = d.accessToken; qbState.accessExpiresAt = d.accessExpiresAt;
      }
      console.log("  [QB] Tokens loaded from file");
    }
  } catch (e) { console.log("  [QB] No token file, using env vars"); }
}

function qbSaveTokenFile() {
  try {
    fs.writeFileSync(QB_TOKEN_FILE, JSON.stringify({
      accessToken: qbState.accessToken, refreshToken: qbState.refreshToken,
      realmId: qbState.realmId, accessExpiresAt: qbState.accessExpiresAt,
      savedAt: new Date().toISOString(),
    }, null, 2));
  } catch (e) { console.error("  [QB] Failed to save token file:", e.message); }
}

qbLoadTokenFile();

async function qbEnsureAccessToken() {
  if (qbState.accessToken && Date.now() < qbState.accessExpiresAt - 90000) return qbState.accessToken;
  if (!qbState.refreshToken) throw new Error("QB_REFRESH_TOKEN not set. Complete OAuth at /admin/qb-setup");
  if (!QB_CLIENT_ID || !QB_CLIENT_SECRET) throw new Error("QB_CLIENT_ID or QB_CLIENT_SECRET not set");
  const creds = Buffer.from(`${QB_CLIENT_ID}:${QB_CLIENT_SECRET}`).toString("base64");
  const res   = await apiFetch(QB_TOKEN_URL, {
    method : "POST",
    headers: { "Authorization": `Basic ${creds}`, "Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json" },
    body   : `grant_type=refresh_token&refresh_token=${encodeURIComponent(qbState.refreshToken)}`,
  });
  const txt = await res.text();
  if (!res.ok) throw new Error(`QB token refresh failed (${res.status}): ${txt}`);
  const d = JSON.parse(txt);
  qbState.accessToken     = d.access_token;
  qbState.refreshToken    = d.refresh_token;
  qbState.accessExpiresAt = Date.now() + (d.expires_in - 90) * 1000;
  qbSaveTokenFile();
  console.log("  [QB] Access token refreshed");
  return qbState.accessToken;
}

async function qbFetch(endpoint, method, body) {
  const token   = await qbEnsureAccessToken();
  const realmId = qbState.realmId;
  if (!realmId) throw new Error("QB Realm ID not set. Complete OAuth setup at /admin/qb-setup");
  const url  = `${QB_API_BASE}/v3/company/${realmId}${endpoint}?minorversion=75`;
  const opts = { method: method || "GET", headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json", "Accept": "application/json" } };
  if (body) opts.body = JSON.stringify(body);
  const res  = await apiFetch(url, opts);
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = { raw: text }; }
  return { ok: res.ok, status: res.status, data };
}

async function qbQuery(sql) {
  const token   = await qbEnsureAccessToken();
  const realmId = qbState.realmId;
  const url = `${QB_API_BASE}/v3/company/${realmId}/query?query=${encodeURIComponent(sql)}&minorversion=75`;
  const res = await apiFetch(url, { method: "GET", headers: { "Authorization": `Bearer ${token}`, "Accept": "application/json" } });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = { raw: text }; }
  return { ok: res.ok, status: res.status, data };
}

let QB_ITEM_ID = null;

async function ensureQBServiceItem() {
  if (QB_ITEM_ID) return QB_ITEM_ID;
  const q = await qbQuery("SELECT * FROM Item WHERE Name = 'Cloud Infrastructure Service' MAXRESULTS 1");
  if (q.ok && q.data.QueryResponse && q.data.QueryResponse.Item && q.data.QueryResponse.Item.length > 0) {
    QB_ITEM_ID = q.data.QueryResponse.Item[0].Id;
    console.log(`  [QB] Service item found id=${QB_ITEM_ID}`);
    return QB_ITEM_ID;
  }
  const accts = await qbQuery("SELECT * FROM Account WHERE AccountType = 'Income' MAXRESULTS 1");
  let incomeAcctId = "1";
  if (accts.ok && accts.data.QueryResponse && accts.data.QueryResponse.Account && accts.data.QueryResponse.Account.length > 0) {
    incomeAcctId = accts.data.QueryResponse.Account[0].Id;
  }
  const create = await qbFetch("/item", "POST", { Name: "Cloud Infrastructure Service", Type: "Service", IncomeAccountRef: { value: incomeAcctId } });
  if (create.ok && create.data.Item) { QB_ITEM_ID = create.data.Item.Id; console.log(`  [QB] Service item created id=${QB_ITEM_ID}`); return QB_ITEM_ID; }
  console.warn("  [QB] Could not create service item, using default id=1");
  QB_ITEM_ID = "1";
  return QB_ITEM_ID;
}

async function qbUpsertCustomer(orderRef) {
  const displayName = `NubexCloud Customer ${orderRef}`;
  const email       = `customer-${orderRef}@nubexcloud.com`;
  const search = await qbQuery(`SELECT * FROM Customer WHERE DisplayName = '${displayName}' MAXRESULTS 1`);
  if (search.ok && search.data.QueryResponse && search.data.QueryResponse.Customer && search.data.QueryResponse.Customer.length > 0) {
    const id = search.data.QueryResponse.Customer[0].Id;
    console.log(`  [QB] Customer found id=${id}`);
    return id;
  }
  const create = await qbFetch("/customer", "POST", {
    DisplayName: displayName, PrimaryEmailAddr: { Address: email },
    Notes: `Auto-created from N-Genius payment ${orderRef}`,
  });
  if (!create.ok) throw new Error(`QB Customer failed (${create.status}): ${JSON.stringify(create.data)}`);
  const custId = create.data.Customer && create.data.Customer.Id;
  console.log(`  [QB] Customer created id=${custId}`);
  return custId;
}

async function qbCreateInvoice(customerId, orderRef, amountMajor, currency) {
  const itemId = await ensureQBServiceItem();
  const today  = new Date().toISOString().split("T")[0];
  const docNum = `PAY-${orderRef}`.slice(0, 21);
  const res = await qbFetch("/invoice", "POST", {
    CustomerRef : { value: customerId },
    DocNumber   : docNum,
    TxnDate     : today,
    DueDate     : today,
    CurrencyRef : { value: currency },
    PrivateNote : `N-Genius Order: ${orderRef} | Gateway: Network International`,
    CustomerMemo: { value: "Thank you for your payment. Cloud infrastructure services." },
    Line: [{
      Amount    : parseFloat(amountMajor),
      DetailType: "SalesItemLineDetail",
      SalesItemLineDetail: { ItemRef: { value: itemId, name: "Cloud Infrastructure Service" }, UnitPrice: parseFloat(amountMajor), Qty: 1 },
      Description: `Cloud Infrastructure Service - Order ${orderRef}`,
    }],
  });
  if (!res.ok) throw new Error(`QB Invoice failed (${res.status}): ${JSON.stringify(res.data)}`);
  const invId = res.data.Invoice && res.data.Invoice.Id;
  console.log(`  [QB] Invoice created id=${invId} ${currency} ${amountMajor}`);
  return invId;
}

async function qbCreatePaymentRecord(customerId, invoiceId, amountMajor, currency) {
  const today = new Date().toISOString().split("T")[0];
  const res   = await qbFetch("/payment", "POST", {
    CustomerRef: { value: customerId },
    TotalAmt   : parseFloat(amountMajor),
    CurrencyRef: { value: currency },
    TxnDate    : today,
    Line       : [{ Amount: parseFloat(amountMajor), LinkedTxn: [{ TxnId: invoiceId, TxnType: "Invoice" }] }],
    PrivateNote: "Payment received via N-Genius / Network International",
  });
  if (!res.ok) throw new Error(`QB Payment failed (${res.status}): ${JSON.stringify(res.data)}`);
  const payId = res.data.Payment && res.data.Payment.Id;
  console.log(`  [QB] Payment recorded id=${payId}`);
  return payId;
}

const QB_PUSHED = new Set();

async function pushToQuickBooks(orderRef, amountRaw, currency, status, force) {
  if (!QB_CLIENT_ID || !QB_CLIENT_SECRET) throw new Error("QB_CLIENT_ID or QB_CLIENT_SECRET not set");
  if (!force && QB_PUSHED.has(orderRef)) return null;
  const amountMajor = (amountRaw / 100).toFixed(2);
  console.log(`\n  [QB] Pushing ref=${orderRef} ${currency} ${amountMajor}`);
  const customerId = await qbUpsertCustomer(orderRef);
  const invoiceId  = await qbCreateInvoice(customerId, orderRef, amountMajor, currency);
  const paymentId  = await qbCreatePaymentRecord(customerId, invoiceId, amountMajor, currency);
  QB_PUSHED.add(orderRef);
  console.log(`  [QB] Complete customer=${customerId} invoice=${invoiceId} payment=${paymentId}\n`);
  return { customerId, invoiceId, paymentId };
}

// ── QB OAuth CSRF state ──────────────────────────────────────────────────────
const QB_OAUTH_STATES = {};
function qbGenerateState() {
  const state = Math.random().toString(36).slice(2) + Date.now().toString(36);
  QB_OAUTH_STATES[state] = Date.now();
  const cutoff = Date.now() - 10 * 60 * 1000;
  Object.keys(QB_OAUTH_STATES).forEach(k => { if (QB_OAUTH_STATES[k] < cutoff) delete QB_OAUTH_STATES[k]; });
  return state;
}
function qbValidateState(state) {
  if (!QB_OAUTH_STATES[state]) return false;
  const age = Date.now() - QB_OAUTH_STATES[state];
  delete QB_OAUTH_STATES[state];
  return age < 10 * 60 * 1000;
}

// ── Admin middleware ─────────────────────────────────────────────────────────
function adminAuth(req, res, next) {
  if (!ADMIN_PASSWORD) return res.status(500).json({ error: "ADMIN_PASSWORD not set in Railway variables." });
  const pwd = (req.body && req.body.password) || req.headers["x-admin-password"] || "";
  if (pwd !== ADMIN_PASSWORD) return res.status(401).json({ error: "Invalid admin password." });
  next();
}

// ── Admin Panel HTML ─────────────────────────────────────────────────────────
const ADMIN_PANEL_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1.0"/>
<title>Nubexcloud Admin Panel</title>
<style>
@import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;700&family=Sora:wght@300;400;600;700;800&display=swap');
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:#080c12;--s1:#0f1521;--s2:#141d2e;--s3:#1a2540;
  --b1:#1e2d45;--b2:#243555;
  --or:#e34f14;--od:rgba(227,79,20,.12);--og:rgba(227,79,20,.28);
  --gn:#22c55e;--bl:#3b82f6;--rd:#ef4444;
  --tx:#dde6f5;--mu:#4f6a8f;--m2:#6b84a8;
  --fn:'Sora',sans-serif;--fm:'JetBrains Mono',monospace;--r:10px;
}
body{background:var(--bg);color:var(--tx);font-family:var(--fn);min-height:100vh;display:flex;flex-direction:column;}
.hdr{background:var(--s1);border-bottom:1px solid var(--b1);padding:14px 28px;display:flex;align-items:center;justify-content:space-between;}
.logo{display:flex;align-items:center;gap:10px;}
.lm{width:34px;height:34px;background:linear-gradient(135deg,#e34f14,#c43a08);border-radius:8px;display:flex;align-items:center;justify-content:center;font-size:16px;font-weight:800;color:#fff;font-family:var(--fm);}
.ln{font-size:14px;font-weight:700;letter-spacing:-.02em;} .ln span{color:var(--or);}
.ls{font-size:10px;color:var(--mu);font-weight:400;margin-top:1px;}
.hb{display:flex;align-items:center;gap:6px;background:var(--s2);border:1px solid var(--b2);border-radius:99px;padding:5px 13px;font-size:10px;font-weight:700;color:var(--m2);letter-spacing:.06em;text-transform:uppercase;}
.bd{width:5px;height:5px;border-radius:50%;background:var(--or);animation:pu 2s infinite;}
@keyframes pu{0%,100%{opacity:1}50%{opacity:.3}}
main{flex:1;display:flex;align-items:flex-start;justify-content:center;padding:32px 20px;}
.pnl{width:100%;max-width:640px;}
#loginScreen{text-align:center;margin-top:40px;}
.li{width:72px;height:72px;background:var(--od);border:2px solid var(--og);border-radius:18px;display:flex;align-items:center;justify-content:center;font-size:30px;margin:0 auto 22px;}
.lt{font-size:24px;font-weight:800;margin-bottom:8px;letter-spacing:-.03em;}
.ls2{font-size:13px;color:var(--m2);margin-bottom:28px;font-weight:300;line-height:1.65;}
.pw{position:relative;margin-bottom:12px;}
.pi{width:100%;padding:14px 50px 14px 18px;background:var(--s2);border:1.5px solid var(--b2);border-radius:var(--r);font-size:14px;font-family:var(--fm);color:var(--tx);outline:none;transition:border-color .2s;letter-spacing:.1em;}
.pi:focus{border-color:var(--or);box-shadow:0 0 0 3px var(--od);}
.pi::placeholder{letter-spacing:.02em;font-size:13px;color:var(--mu);}
.eb{position:absolute;right:14px;top:50%;transform:translateY(-50%);background:none;border:none;color:var(--mu);cursor:pointer;font-size:16px;padding:4px;}
.lb{width:100%;padding:14px;background:linear-gradient(135deg,#e34f14,#c43a08);border:none;border-radius:var(--r);font-size:14px;font-weight:700;color:#fff;cursor:pointer;font-family:var(--fn);box-shadow:0 4px 20px var(--og);}
.lb:hover{transform:translateY(-1px);}
.le{margin-top:10px;font-size:12px;color:var(--rd);display:none;}
#mainPanel{display:none;}
.tb{display:flex;align-items:center;justify-content:space-between;margin-bottom:20px;}
.tb h1{font-size:22px;font-weight:800;letter-spacing:-.03em;} .tb h1 span{color:var(--or);}
.ob{background:none;border:1px solid var(--b2);border-radius:6px;color:var(--mu);font-size:11px;padding:6px 13px;cursor:pointer;font-family:var(--fn);transition:all .15s;}
.ob:hover{border-color:var(--rd);color:var(--rd);}
.tabs{display:flex;gap:4px;background:var(--s2);border:1px solid var(--b2);border-radius:10px;padding:4px;margin-bottom:22px;}
.tab{flex:1;padding:9px;border:none;border-radius:7px;font-size:12px;font-weight:700;font-family:var(--fn);cursor:pointer;color:var(--m2);background:transparent;transition:all .2s;letter-spacing:.04em;}
.tab.act{background:var(--or);color:#fff;box-shadow:0 2px 12px var(--og);}
.tab.qb-act{background:#1a7f4b;color:#fff;box-shadow:0 2px 12px rgba(26,127,75,.4);}
.tp{display:none;} .tp.act{display:block;}
.sl{font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:.13em;color:var(--mu);margin-bottom:12px;padding-bottom:7px;border-bottom:1px solid var(--b1);}
.fg{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:22px;}
.ff{grid-column:1/-1;}
.fl label{display:block;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.1em;color:var(--m2);margin-bottom:7px;}
.fl input,.fl select{width:100%;padding:11px 14px;background:var(--s2);border:1.5px solid var(--b2);border-radius:8px;font-size:13px;font-family:var(--fm);color:var(--tx);outline:none;transition:border-color .2s;-webkit-appearance:none;}
.fl input:focus,.fl select:focus{border-color:var(--or);box-shadow:0 0 0 3px var(--od);}
.fl select option{background:var(--s2);}
.rw{position:relative;}
.ri{padding-right:52px!important;}
.rg{position:absolute;right:8px;top:50%;transform:translateY(-50%);background:var(--s3);border:1px solid var(--b2);border-radius:6px;color:var(--m2);font-size:11px;padding:4px 10px;cursor:pointer;font-family:var(--fn);font-weight:600;transition:all .15s;}
.rg:hover{color:var(--or);border-color:var(--or);}
.pb{width:100%;padding:14px;background:linear-gradient(135deg,#e34f14,#c43a08);border:none;border-radius:var(--r);font-size:14px;font-weight:700;color:#fff;cursor:pointer;font-family:var(--fn);transition:all .15s;box-shadow:0 4px 20px var(--og);display:flex;align-items:center;justify-content:center;gap:9px;}
.pb.qb{background:linear-gradient(135deg,#1a7f4b,#145c35);box-shadow:0 4px 20px rgba(26,127,75,.35);}
.pb:hover:not(:disabled){transform:translateY(-1px);}
.pb:disabled{opacity:.5;cursor:not-allowed;transform:none!important;}
.sp{width:14px;height:14px;border:2px solid rgba(255,255,255,.3);border-top-color:#fff;border-radius:50%;animation:spin .7s linear infinite;display:none;}
@keyframes spin{to{transform:rotate(360deg)}}
.rb{margin-top:20px;display:none;}
.rc{border-radius:var(--r);overflow:hidden;border:1px solid;}
.rc.ok{border-color:rgba(34,197,94,.3);} .rc.er{border-color:rgba(239,68,68,.3);}
.rt{padding:14px 18px;display:flex;align-items:center;gap:12px;}
.rt.ok{background:rgba(34,197,94,.07);} .rt.er{background:rgba(239,68,68,.07);}
.ri2{font-size:22px;flex-shrink:0;}
.rv{font-size:14px;font-weight:700;} .rv.ok{color:var(--gn);} .rv.er{color:var(--rd);}
.rs{font-size:11.5px;color:var(--m2);margin-top:2px;}
.rb2{background:var(--s2);padding:16px 18px;display:grid;grid-template-columns:1fr 1fr;gap:10px;}
.rc2{background:var(--s3);border:1px solid var(--b2);border-radius:8px;padding:11px 13px;}
.rl{font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:.1em;color:var(--mu);margin-bottom:5px;}
.rval{font-size:11.5px;font-family:var(--fm);color:var(--tx);word-break:break-all;font-weight:600;}
.rval.or{color:var(--or);} .rval.gn{color:var(--gn);} .rval.bl{color:#60a5fa;}
.al{display:inline-flex;align-items:center;gap:5px;margin-top:12px;font-size:12px;font-weight:600;text-decoration:none;border-radius:6px;padding:7px 14px;transition:background .15s;}
.al.hs{color:var(--or);background:var(--od);border:1px solid var(--og);}
.al.hs:hover{background:rgba(227,79,20,.2);}
.al.qb{color:#34d399;background:rgba(52,211,153,.08);border:1px solid rgba(52,211,153,.25);}
.al.qb:hover{background:rgba(52,211,153,.16);}
.rf{padding:13px 18px;background:var(--s2);border-top:1px solid var(--b1);display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;}
.ab{background:none;border:1px solid var(--b2);border-radius:6px;color:var(--m2);font-size:12px;font-weight:600;padding:7px 14px;cursor:pointer;font-family:var(--fn);transition:all .15s;}
.ab:hover{border-color:var(--or);color:var(--or);}
.ts{font-size:10px;color:var(--mu);font-family:var(--fm);}
.sc{background:var(--s2);border:1px solid var(--b2);border-radius:12px;padding:22px;margin-bottom:14px;}
.sc h3{font-size:15px;font-weight:700;margin-bottom:8px;letter-spacing:-.02em;}
.sc p{font-size:13px;color:var(--m2);line-height:1.7;font-weight:300;}
.ss{display:flex;align-items:center;gap:10px;padding:12px 16px;border-radius:8px;margin-top:14px;font-size:13px;font-weight:600;}
.ss.cn{background:rgba(34,197,94,.08);border:1px solid rgba(34,197,94,.25);color:var(--gn);}
.ss.dc{background:rgba(239,68,68,.08);border:1px solid rgba(239,68,68,.25);color:var(--rd);}
.sb{display:inline-flex;align-items:center;gap:8px;margin-top:16px;padding:12px 24px;background:linear-gradient(135deg,#1a7f4b,#145c35);border:none;border-radius:8px;color:#fff;font-size:13px;font-weight:700;cursor:pointer;font-family:var(--fn);text-decoration:none;transition:transform .15s;}
.sb:hover{transform:translateY(-1px);}
.sr{display:flex;gap:12px;align-items:flex-start;margin-bottom:12px;}
.sn{width:26px;height:26px;border-radius:50%;background:var(--or);display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:800;color:#fff;flex-shrink:0;margin-top:1px;}
.st{font-size:13px;color:var(--m2);line-height:1.6;font-weight:300;}
.st strong{color:var(--tx);font-weight:600;}
.mt{font-family:var(--fm);font-size:11px;background:var(--s3);border:1px solid var(--b2);padding:2px 8px;border-radius:4px;color:var(--or);}
.cu{font-family:var(--fm);font-size:11px;color:var(--or);margin-top:6px;word-break:break-all;}
@media(max-width:500px){.fg,.rb2{grid-template-columns:1fr;}.ff{grid-column:1;}main{padding:20px 16px;}}
</style>
</head>
<body>
<div class="hdr">
  <div class="logo">
    <div class="lm">N</div>
    <div><div class="ln"><span>Nubex</span>cloud</div><div class="ls">Internal Admin</div></div>
  </div>
  <div class="hb"><div class="bd"></div>Admin Panel</div>
</div>
<main><div class="pnl">

<!-- LOGIN -->
<div id="loginScreen">
  <div class="li">&#x1F510;</div>
  <div class="lt">Admin Access</div>
  <div class="ls2">Manage HubSpot &amp; QuickBooks integration.<br/>Enter your admin password to continue.</div>
  <div class="pw">
    <input class="pi" id="pwdInp" type="password" placeholder="Enter admin password&hellip;" autocomplete="current-password"/>
    <button class="eb" id="eyeBtn">&#x1F441;</button>
  </div>
  <button class="lb" id="loginBtn">Unlock Panel &rarr;</button>
  <div class="le" id="loginErr">&#x26A0; Incorrect password &mdash; please try again.</div>
</div>

<!-- MAIN PANEL -->
<div id="mainPanel">
  <div class="tb">
    <div><h1>Integration <span>Test Panel</span></h1></div>
    <button class="ob" id="logoutBtn">Log out</button>
  </div>
  <div class="tabs">
    <button class="tab act" data-tab="hs">HubSpot CRM</button>
    <button class="tab" data-tab="qb">QuickBooks</button>
    <button class="tab" data-tab="setup">QB Setup</button>
  </div>

  <!-- HUBSPOT TAB -->
  <div class="tp act" id="tab-hs">
    <div class="sl">HubSpot Test &mdash; Creates Contact + Deal</div>
    <div class="fg">
      <div class="fl ff"><label>Order Reference (auto-generated)</label>
        <div class="rw"><input class="ri" id="hsRef" type="text" readonly/><button class="rg" id="hsRegen">&#x21BB; New</button></div>
      </div>
      <div class="fl"><label>Amount</label><input id="hsAmt" type="number" min="1" step="0.01" value="100.00"/></div>
      <div class="fl"><label>Currency</label>
        <select id="hsCur"><option value="USD">USD</option><option value="AED" selected>AED</option><option value="EUR">EUR</option></select>
      </div>
      <div class="fl ff"><label>Payment Status</label>
        <select id="hsSt"><option value="CAPTURED" selected>CAPTURED</option><option value="AUTHORISED">AUTHORISED</option><option value="PURCHASED">PURCHASED</option></select>
      </div>
    </div>
    <button class="pb" id="hsPushBtn"><span id="hsLbl">Push to HubSpot &rarr;</span><div class="sp" id="hsSp"></div></button>
    <div class="rb" id="hsRes"></div>
  </div>

  <!-- QUICKBOOKS TAB -->
  <div class="tp" id="tab-qb">
    <div class="sl">QuickBooks Test &mdash; Creates Customer + Invoice + Payment</div>
    <div class="fg">
      <div class="fl ff"><label>Order Reference (auto-generated)</label>
        <div class="rw"><input class="ri" id="qbRef" type="text" readonly/><button class="rg" id="qbRegen">&#x21BB; New</button></div>
      </div>
      <div class="fl"><label>Amount</label><input id="qbAmt" type="number" min="1" step="0.01" value="100.00"/></div>
      <div class="fl"><label>Currency</label>
        <select id="qbCur"><option value="USD">USD</option><option value="AED" selected>AED</option><option value="EUR">EUR</option></select>
      </div>
      <div class="fl ff"><label>Payment Status</label>
        <select id="qbSt"><option value="CAPTURED" selected>CAPTURED</option><option value="AUTHORISED">AUTHORISED</option></select>
      </div>
    </div>
    <button class="pb qb" id="qbPushBtn"><span id="qbLbl">Push to QuickBooks &rarr;</span><div class="sp" id="qbSp"></div></button>
    <div class="rb" id="qbRes"></div>
  </div>

  <!-- QB SETUP TAB -->
  <div class="tp" id="tab-setup">
    <div class="sc">
      <h3>QuickBooks Connection Status</h3>
      <p>One-time browser authorization required. Tokens refresh automatically every hour after setup.</p>
      <div class="ss dc" id="qbStatusBadge">
        <span id="qbStatusIcon">&#x23F3;</span>
        <span id="qbStatusText">Checking&hellip;</span>
      </div>
    </div>
    <div class="sc">
      <h3>Setup Steps</h3>
      <div class="sr"><div class="sn">1</div><div class="st">In <strong>Railway &rarr; Variables</strong>, add <span class="mt">QB_CLIENT_ID</span> and <span class="mt">QB_CLIENT_SECRET</span> from your Intuit Developer app.</div></div>
      <div class="sr"><div class="sn">2</div><div class="st">Register the callback URL below in your Intuit Developer app &rarr; Redirect URIs.</div></div>
      <div class="sr"><div class="sn">3</div><div class="st">Click <strong>Connect QuickBooks</strong> &rarr; authorize with your QuickBooks account.</div></div>
      <div class="sr"><div class="sn">4</div><div class="st">Copy the <strong>Realm ID</strong> and <strong>Refresh Token</strong> from the success page to Railway as <span class="mt">QB_REALM_ID</span> and <span class="mt">QB_REFRESH_TOKEN</span>. Railway redeploys automatically.</div></div>
      <p style="margin-top:14px;font-size:11.5px;">Intuit Developer callback URL to register:</p>
      <p class="cu" id="cbUrl">Loading&hellip;</p>
      <a class="sb" id="connectQb" href="#" target="_blank">&#x1F517; Connect QuickBooks</a>
    </div>
  </div>
</div><!-- /mainPanel -->
</div></main>

<script>
var adminPwd = "";

// ── eye toggle ──
document.getElementById("eyeBtn").addEventListener("click", function() {
  var inp = document.getElementById("pwdInp");
  if (inp.type === "password") { inp.type = "text"; this.textContent = String.fromCodePoint(0x1F648); }
  else { inp.type = "password"; this.textContent = String.fromCodePoint(0x1F441); }
});

// ── login ──
document.getElementById("pwdInp").addEventListener("keydown", function(e) { if (e.key === "Enter") doLogin(); });
document.getElementById("loginBtn").addEventListener("click", doLogin);
document.getElementById("logoutBtn").addEventListener("click", function() {
  adminPwd = "";
  document.getElementById("mainPanel").style.display = "none";
  document.getElementById("loginScreen").style.display = "block";
  document.getElementById("pwdInp").value = "";
});

function doLogin() {
  var pwd = document.getElementById("pwdInp").value.trim();
  if (!pwd) { showLoginErr(); return; }
  fetch("/api/admin/ping", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: pwd })
  }).then(function(r) {
    if (r.ok) {
      adminPwd = pwd;
      document.getElementById("loginScreen").style.display = "none";
      document.getElementById("mainPanel").style.display = "block";
      newRef("hs"); newRef("qb"); initSetup();
    } else { showLoginErr(); }
  }).catch(function() { showLoginErr(); });
}
function showLoginErr() {
  var el = document.getElementById("loginErr");
  el.style.display = "block";
  setTimeout(function() { el.style.display = "none"; }, 3000);
}

// ── tabs ──
document.querySelectorAll(".tab").forEach(function(btn) {
  btn.addEventListener("click", function() {
    var tab = btn.getAttribute("data-tab");
    document.querySelectorAll(".tab").forEach(function(b) { b.classList.remove("act", "qb-act"); });
    document.querySelectorAll(".tp").forEach(function(p) { p.classList.remove("act"); });
    btn.classList.add(tab === "qb" ? "qb-act" : "act");
    document.getElementById("tab-" + tab).classList.add("act");
  });
});

// ── ref generator ──
function newRef(pfx) {
  var ts = Date.now().toString().slice(-8);
  var rnd = Math.random().toString(36).slice(2, 6).toUpperCase();
  document.getElementById(pfx + "Ref").value = "TEST-" + ts + "-" + rnd;
}
document.getElementById("hsRegen").addEventListener("click", function() { newRef("hs"); });
document.getElementById("qbRegen").addEventListener("click", function() { newRef("qb"); });

// ── loading state ──
function setLoad(pfx, on) {
  var btn = document.getElementById(pfx + "PushBtn");
  var lbl = document.getElementById(pfx + "Lbl");
  var sp  = document.getElementById(pfx + "Sp");
  btn.disabled      = on;
  lbl.style.display = on ? "none" : "inline";
  sp.style.display  = on ? "block" : "none";
}

// ── format amount ──
function fmtAmt(a, c) {
  var n = Number(a).toFixed(2);
  if (c === "USD") return "$" + n;
  if (c === "EUR") return "\u20AC" + n;
  return "AED " + n;
}

// ── HubSpot push ──
document.getElementById("hsPushBtn").addEventListener("click", function() {
  var ref = document.getElementById("hsRef").value.trim();
  var amt = parseFloat(document.getElementById("hsAmt").value);
  var cur = document.getElementById("hsCur").value;
  var st  = document.getElementById("hsSt").value;
  if (!ref || isNaN(amt) || amt <= 0) { alert("Please fill in all fields."); return; }
  setLoad("hs", true);
  document.getElementById("hsRes").style.display = "none";
  fetch("/api/admin/test-hubspot", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: adminPwd, orderRef: ref, amount: amt, currency: cur, status: st })
  }).then(function(r) {
    return r.json().then(function(d) { return { ok: r.ok, data: d }; });
  }).then(function(r) {
    showRes("hs", r.ok && r.data.success, ref, amt, cur, st, r.data);
    setLoad("hs", false);
  }).catch(function(e) {
    showRes("hs", false, ref, amt, cur, st, { error: e.message });
    setLoad("hs", false);
  });
});

// ── QuickBooks push ──
document.getElementById("qbPushBtn").addEventListener("click", function() {
  var ref = document.getElementById("qbRef").value.trim();
  var amt = parseFloat(document.getElementById("qbAmt").value);
  var cur = document.getElementById("qbCur").value;
  var st  = document.getElementById("qbSt").value;
  if (!ref || isNaN(amt) || amt <= 0) { alert("Please fill in all fields."); return; }
  setLoad("qb", true);
  document.getElementById("qbRes").style.display = "none";
  fetch("/api/admin/test-quickbooks", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: adminPwd, orderRef: ref, amount: amt, currency: cur, status: st })
  }).then(function(r) {
    return r.json().then(function(d) { return { ok: r.ok, data: d }; });
  }).then(function(r) {
    showRes("qb", r.ok && r.data.success, ref, amt, cur, st, r.data);
    setLoad("qb", false);
  }).catch(function(e) {
    showRes("qb", false, ref, amt, cur, st, { error: e.message });
    setLoad("qb", false);
  });
});

// ── showRes — pure DOM, zero HTML strings ──
function mk(tag, cls, txt) {
  var el = document.createElement(tag);
  if (cls) el.className = cls;
  if (txt !== undefined) el.textContent = txt;
  return el;
}

function showRes(pfx, ok, ref, amt, cur, st, data) {
  var box = document.getElementById(pfx + "Res");
  var ts  = new Date().toLocaleString("en-AE");
  box.innerHTML = "";

  var card = mk("div", "rc " + (ok ? "ok" : "er"));

  // Top row
  var top = mk("div", "rt " + (ok ? "ok" : "er"));
  var ico = mk("div", "ri2");
  ico.textContent = ok ? "\u2705" : "\u274C";
  var titleWrap = mk("div");
  var title = mk("div", "rv " + (ok ? "ok" : "er"));
  title.textContent = ok
    ? (pfx === "hs" ? "HubSpot" : "QuickBooks") + " \u2014 Success"
    : "Push Failed";
  var sub = mk("div", "rs");
  sub.textContent = ok
    ? (pfx === "hs" ? "Contact + Deal created" : "Customer + Invoice + Payment created")
    : (data && data.error) || "Unknown error \u2014 check Railway logs";
  titleWrap.appendChild(title);
  titleWrap.appendChild(sub);
  top.appendChild(ico);
  top.appendChild(titleWrap);
  card.appendChild(top);

  // Data cells (only on success)
  if (ok) {
    var body = mk("div", "rb2");
    var fields;
    if (pfx === "hs") {
      fields = [
        ["Contact ID", (data.contact && data.contact.id) || "-", "bl"],
        ["Deal ID",    (data.deal    && data.deal.id)    || "-", "gn"],
        ["Email",      "customer-" + ref + "@nubexcloud.com",    "or"],
        ["Amount",     fmtAmt(amt, cur),                         "gn"],
        ["Order Ref",  ref,                                       ""],
        ["Status",     st,                                        ""]
      ];
    } else {
      fields = [
        ["Customer ID", data.customerId || "-", "bl"],
        ["Invoice ID",  data.invoiceId  || "-", "gn"],
        ["Payment ID",  data.paymentId  || "-", "gn"],
        ["Amount",      fmtAmt(amt, cur),        "gn"],
        ["Order Ref",   ref,                     ""],
        ["Status",      st,                      ""]
      ];
    }
    fields.forEach(function(f) {
      var cell = mk("div", "rc2");
      cell.appendChild(mk("div", "rl", f[0]));
      cell.appendChild(mk("div", "rval" + (f[2] ? " " + f[2] : ""), String(f[1])));
      body.appendChild(cell);
    });
    card.appendChild(body);
  }

  // Footer
  var foot = mk("div", "rf");
  if (ok) {
    var href = pfx === "hs"
      ? "https://app.hubspot.com/contacts/" + ((data.contact && data.contact.id) || "")
      : "https://app.qbo.intuit.com/app/invoice?txnId=" + (data.invoiceId || "");
    var link = mk("a", "al " + pfx);
    link.href = href;
    link.target = "_blank";
    link.textContent = pfx === "hs" ? "Open in HubSpot \u2192" : "Open in QuickBooks \u2192";
    foot.appendChild(link);
  }
  var right = mk("div");
  right.style.cssText = "display:flex;align-items:center;gap:10px;";
  right.appendChild(mk("span", "ts", ts));
  var again = mk("button", "ab", "\u2190 " + (ok ? "Test Again" : "Try Again"));
  again.addEventListener("click", function() { newRef(pfx); box.style.display = "none"; });
  right.appendChild(again);
  foot.appendChild(right);
  card.appendChild(foot);

  box.appendChild(card);
  box.style.display = "block";
  box.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

// ── QB setup tab ──
function initSetup() {
  var cb = window.location.origin + "/admin/qb-callback";
  document.getElementById("cbUrl").textContent = cb;
  document.getElementById("connectQb").href = "/admin/qb-auth?pwd=" + encodeURIComponent(adminPwd);
  fetch("/health").then(function(r) { return r.json(); }).then(function(d) {
    var badge = document.getElementById("qbStatusBadge");
    var icon  = document.getElementById("qbStatusIcon");
    var text  = document.getElementById("qbStatusText");
    if (d.quickbooks === "connected") {
      badge.className  = "ss cn";
      icon.textContent = "\u2713";
      text.textContent = "Connected \u2014 tokens active (Realm: " + (d.qb_realm || "") + ")";
    } else {
      badge.className  = "ss dc";
      icon.textContent = "\u26A0";
      text.textContent = d.quickbooks || "Not connected \u2014 complete setup below";
    }
  }).catch(function() {});
}
</script>
</body>
</html>`;

// ── Routes ──────────────────────────────────────────────────────────────────

// Payment page
app.get("/", (_req, res) => {
  const htmlPath = path.join(__dirname, "public", "index.html");
  if (!fs.existsSync(htmlPath)) return res.status(404).send("Payment page not found. Put index.html inside /public.");
  let html = fs.readFileSync(htmlPath, "utf8");
  const inject = `<script>window.__SERVER_CONFIG__={currency:"${CURRENCY}",sandbox:${SANDBOX},serverMode:true};</script>`;
  html = html.replace("</head>", inject + "\n</head>");
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(html);
});

// Admin test panel
app.get("/admin/test", (_req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(ADMIN_PANEL_HTML);
});

// QB OAuth start — admin password in query string, redirects to Intuit
app.get("/admin/qb-auth", (req, res) => {
  const pwd = req.query.pwd || "";
  if (!ADMIN_PASSWORD || pwd !== ADMIN_PASSWORD) return res.status(401).send("Invalid admin password.");
  if (!QB_CLIENT_ID || !QB_CLIENT_SECRET) return res.status(500).send("QB_CLIENT_ID or QB_CLIENT_SECRET not set in Railway variables.");
  const state       = qbGenerateState();
  const redirectUri = encodeURIComponent(`${getRedirectBase({})}/admin/qb-callback`);
  const authUrl     = `${QB_AUTH_URL}?client_id=${QB_CLIENT_ID}&redirect_uri=${redirectUri}&response_type=code&scope=com.intuit.quickbooks.accounting&state=${state}`;
  res.redirect(authUrl);
});

// QB OAuth callback
app.get("/admin/qb-callback", async (req, res) => {
  const { code, state, realmId, error } = req.query;
  if (error)                          return res.status(400).send(`<h2>Authorization denied: ${error}</h2>`);
  if (!qbValidateState(state))        return res.status(400).send(`<h2>Invalid or expired OAuth state. Please start again from <a href="/admin/test">the admin panel</a>.</h2>`);
  if (!code || !realmId)              return res.status(400).send(`<h2>Missing code or realmId from QuickBooks.</h2>`);

  try {
    const creds       = Buffer.from(`${QB_CLIENT_ID}:${QB_CLIENT_SECRET}`).toString("base64");
    const redirectUri = `${getRedirectBase({})}/admin/qb-callback`;
    const tokenRes    = await apiFetch(QB_TOKEN_URL, {
      method : "POST",
      headers: { "Authorization": `Basic ${creds}`, "Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json" },
      body   : `grant_type=authorization_code&code=${encodeURIComponent(code)}&redirect_uri=${encodeURIComponent(redirectUri)}`,
    });
    const tokenText = await tokenRes.text();
    if (!tokenRes.ok) throw new Error(`Token exchange failed (${tokenRes.status}): ${tokenText}`);
    const td = JSON.parse(tokenText);

    qbState.accessToken     = td.access_token;
    qbState.refreshToken    = td.refresh_token;
    qbState.realmId         = realmId;
    qbState.accessExpiresAt = Date.now() + (td.expires_in - 90) * 1000;
    qbSaveTokenFile();
    console.log(`  [QB] OAuth complete realmId=${realmId}`);

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"/><title>QuickBooks Connected</title>
<style>body{font-family:system-ui,sans-serif;background:#080c12;color:#dde6f5;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;}
.card{background:#0f1521;border:1px solid #1e2d45;border-radius:16px;padding:40px;max-width:580px;width:100%;margin:20px;}
h1{color:#22c55e;font-size:24px;margin-bottom:8px;}h2{font-size:16px;color:#6b84a8;font-weight:400;margin-bottom:28px;}
.f{background:#141d2e;border:1px solid #243555;border-radius:8px;padding:14px 18px;margin-bottom:14px;}
.fl{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.1em;color:#6b84a8;margin-bottom:6px;}
.fv{font-family:monospace;font-size:12px;color:#e34f14;word-break:break-all;}
.note{background:rgba(34,197,94,.07);border:1px solid rgba(34,197,94,.2);border-radius:8px;padding:14px;font-size:13px;color:#86efac;line-height:1.7;}
a.btn{display:inline-block;margin-top:20px;padding:12px 24px;background:#e34f14;color:#fff;border-radius:8px;text-decoration:none;font-weight:700;}</style>
</head><body><div class="card">
<h1>QuickBooks Connected!</h1>
<h2>Authorization successful. Copy these two values to Railway Variables now.</h2>
<div class="f"><div class="fl">QB_REALM_ID (Company ID)</div><div class="fv">${realmId}</div></div>
<div class="f"><div class="fl">QB_REFRESH_TOKEN</div><div class="fv">${td.refresh_token}</div></div>
<div class="note">Add both values to Railway &rarr; Variables, then Railway will redeploy automatically. After redeploy, the QB Setup tab will show Connected.</div>
<a class="btn" href="/admin/test">Back to Admin Panel &rarr;</a>
</div></body></html>`);
  } catch (err) {
    console.error("[QB OAuth]", err.message);
    res.status(500).send(`<h2>OAuth Error: ${err.message}</h2><p><a href="/admin/test">Back to admin panel</a></p>`);
  }
});

// Admin ping
app.post("/api/admin/ping", adminAuth, (_req, res) => res.json({ ok: true }));

// Admin test: HubSpot
app.post("/api/admin/test-hubspot", adminAuth, async (req, res) => {
  const { orderRef, amount, currency, status } = req.body;
  if (!orderRef || !amount || !currency || !status) return res.status(400).json({ success: false, error: "Missing fields" });
  const amountCents = Math.round(Number(amount) * 100);
  try {
    const result = await pushToHubSpot(orderRef, amountCents, currency, status, true);
    return res.json({ success: true, contact: { id: result.contactId, email: `customer-${orderRef}@nubexcloud.com` }, deal: { id: result.dealId } });
  } catch (err) {
    console.error("[HS TEST]", err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// Admin test: QuickBooks
app.post("/api/admin/test-quickbooks", adminAuth, async (req, res) => {
  const { orderRef, amount, currency, status } = req.body;
  if (!orderRef || !amount || !currency || !status) return res.status(400).json({ success: false, error: "Missing fields" });
  const amountCents = Math.round(Number(amount) * 100);
  try {
    const result = await pushToQuickBooks(orderRef, amountCents, currency, status, true);
    return res.json({ success: true, customerId: result.customerId, invoiceId: result.invoiceId, paymentId: result.paymentId });
  } catch (err) {
    console.error("[QB TEST]", err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// Create payment order
app.post("/api/create-payment", async (req, res) => {
  if (!API_KEY || !OUTLET_ID) return res.status(500).json({ error: "Server not configured. Missing API credentials." });
  const { amount, currency } = req.body;
  if (!amount || isNaN(Number(amount)) || Number(amount) <= 0) return res.status(400).json({ error: "Invalid amount" });
  const amountInt    = Math.round(Number(amount));
  const cur          = (currency || CURRENCY).trim();
  const redirectBase = getRedirectBase(req.body);
  console.log(`\n[PAYMENT] ${cur} ${(amountInt / 100).toFixed(2)} -> redirect: ${redirectBase}`);
  try {
    const token  = await getAccessToken();
    const result = await tryCreateOrder(token, amountInt, cur, redirectBase);
    return res.json({ paymentUrl: result.paymentUrl, orderId: result.order.reference, reference: result.order.reference, status: result.order.status, action: result.action });
  } catch (err) {
    const message = err instanceof Error ? err.message : JSON.stringify(err);
    console.error("[ERROR]", message);
    return res.status(500).json({ error: message });
  }
});

// Order status — triggers HubSpot + QuickBooks on confirmed payments
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
    const amount   = (data.amount && data.amount.value)        || 0;
    const currency = (data.amount && data.amount.currencyCode) || CURRENCY;

    const CONFIRMED = ["CAPTURED", "AUTHORISED", "PURCHASED", "SALE"];
    if (orderRef && CONFIRMED.some(s => status.includes(s))) {
      if (HS_TOKEN) {
        pushToHubSpot(orderRef, amount, currency, status, false).catch(() => {});
      }
      if (QB_CLIENT_ID && QB_CLIENT_SECRET && qbState.refreshToken) {
        pushToQuickBooks(orderRef, amount, currency, status, false).catch(() => {});
      }
    }

    res.json({ reference: orderRef, status, amount, currency });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Health check
app.get("/health", (_req, res) => {
  const qbConnected = !!(QB_CLIENT_ID && QB_CLIENT_SECRET && qbState.refreshToken);
  res.json({
    status    : "ok",
    env       : SANDBOX ? "sandbox" : "live",
    configured: !!(API_KEY && OUTLET_ID),
    hubspot   : HS_TOKEN       ? "configured" : "not configured",
    quickbooks: qbConnected    ? "connected"  : "not configured",
    admin     : ADMIN_PASSWORD ? "configured" : "not configured",
    hs_pushed : HS_PUSHED.size,
    qb_pushed : QB_PUSHED.size,
    qb_realm  : qbState.realmId || "not set",
  });
});

// Start
app.listen(PORT, () => {
  console.log("\n+------------------------------------------+");
  console.log("|  Nubexcloud Payment Server -- LIVE       |");
  console.log("+------------------------------------------+");
  console.log(`  Port      : ${PORT}`);
  console.log(`  Mode      : ${SANDBOX ? "SANDBOX" : "LIVE"}`);
  console.log(`  Currency  : ${CURRENCY}`);
  console.log(`  Outlet    : ${OUTLET_ID      ? OUTLET_ID.slice(0,8)+"..." : "NOT SET"}`);
  console.log(`  N-Genius  : ${API_KEY        ? "Set" : "NOT SET"}`);
  console.log(`  HubSpot   : ${HS_TOKEN       ? "Set" : "NOT SET"}`);
  console.log(`  QB Client : ${QB_CLIENT_ID   ? "Set" : "NOT SET"}`);
  console.log(`  QB Realm  : ${qbState.realmId     || "NOT SET -- complete OAuth at /admin/qb-setup"}`);
  console.log(`  QB Token  : ${qbState.refreshToken ? "Set" : "NOT SET -- complete OAuth at /admin/qb-setup"}`);
  console.log(`  Admin     : ${ADMIN_PASSWORD  ? "Set" : "NOT SET"}\n`);
});
