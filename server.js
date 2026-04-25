/**
 * NUBEXCLOUD — N-Genius Payment Server (Production)
 * + HubSpot CRM Integration
 * + Password-Protected Admin Test Panel  (/admin/test)
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
const HS_TOKEN       =pat-eu1-6e8d4c18-64f8-4546-b505-966d75b8764e (process.env.HUBSPOT_ACCESS_TOKEN  || "").trim();
const ADMIN_PASSWORD =nubex@2026 (process.env.ADMIN_PASSWORD        || "").trim();

const BASE     = SANDBOX
  ? "https://api-gateway.sandbox.ngenius-payments.com"
  : "https://api-gateway.ngenius-payments.com";

const IDENTITY      = `${BASE}/identity/auth/access-token`;
const ORDERS        = `${BASE}/transactions/outlets/${OUTLET_ID}/orders`;
const ORDER_ACTIONS = ["PURCHASE", "SALE", "AUTH"];
const HS_BASE       = "https://api.hubapi.com";

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

/* ══════════════════════════════════════════════
   N-GENIUS — TOKEN + ORDER
══════════════════════════════════════════════ */
const TOKEN = { value: null, expiresAt: 0 };

async function getAccessToken() {
  if (TOKEN.value && Date.now() < TOKEN.expiresAt) return TOKEN.value;
  const res = await apiFetch(IDENTITY, {
    method : "POST",
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
  if (REDIRECT_BASE)         return REDIRECT_BASE;
  if (reqBody?.redirectBase) return reqBody.redirectBase;
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
          redirectUrl         : `${redirectBase}/?status=success`,
          cancelUrl           : `${redirectBase}/?status=cancelled`,
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
   HUBSPOT — CORE FUNCTIONS
══════════════════════════════════════════════ */

/** De-duplication guard — prevents double-push on page refresh */
const HS_PUSHED = new Set();

/** Low-level HubSpot REST helper */
async function hsFetch(endpoint, method, body) {
  if (!HS_TOKEN) throw new Error("HUBSPOT_ACCESS_TOKEN is not set");
  method = method || "GET";
  const opts = {
    method,
    headers: {
      "Authorization": `Bearer ${HS_TOKEN}`,
      "Content-Type" : "application/json",
    },
  };
  if (body) opts.body = JSON.stringify(body);
  const res  = await apiFetch(`${HS_BASE}${endpoint}`, opts);
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  return { ok: res.ok, status: res.status, data };
}

/**
 * Upsert Contact — tries to create; on duplicate (409) searches by email.
 * Returns HubSpot contact ID string.
 */
async function hsUpsertContact(orderRef) {
  const email = `customer-${orderRef}@nubexcloud.com`;

  const create = await hsFetch("/crm/v3/objects/contacts", "POST", {
    properties: {
      email,
      firstname     : "Customer",
      lastname      : orderRef,
      lifecyclestage: "customer",
      hs_lead_status: "CONNECTED",
    },
  });

  if (create.ok) {
    console.log(`  [HS] ✓ Contact created  id=${create.data.id}  email=${email}`);
    return create.data.id;
  }

  if (create.status === 409) {
    const search = await hsFetch("/crm/v3/objects/contacts/search", "POST", {
      filterGroups: [{
        filters: [{ propertyName: "email", operator: "EQ", value: email }],
      }],
      properties: ["email", "hs_object_id"],
      limit: 1,
    });
    if (search.ok && search.data.results && search.data.results.length > 0) {
      const id = search.data.results[0].id;
      console.log(`  [HS] ✓ Contact found    id=${id}  email=${email}`);
      return id;
    }
  }

  throw new Error(`Contact upsert failed (${create.status}): ${JSON.stringify(create.data)}`);
}

/**
 * Create a Deal and associate it to the given contact.
 * amountRaw is in minor units (cents). Returns HubSpot deal ID string.
 */
async function hsCreateDeal(orderRef, amountRaw, currency, status, contactId) {
  const amountMajor = (amountRaw / 100).toFixed(2);
  const dealName    = `Nubex Payment \u2014 ${orderRef}`;
  const now         = new Date().toISOString().split("T")[0];
  const environment = SANDBOX ? "Sandbox" : "Live";

  const res = await hsFetch("/crm/v3/objects/deals", "POST", {
    properties: {
      dealname          : dealName,
      amount            : amountMajor,
      pipeline          : "default",
      dealstage         : "closedwon",
      closedate         : now,
      deal_currency_code: currency,
      description       : [
        `Order Ref : ${orderRef}`,
        `Amount    : ${currency} ${amountMajor}`,
        `Status    : ${status}`,
        `Gateway   : N-Genius / Network International`,
        `Mode      : ${environment}`,
        `Processed : ${new Date().toUTCString()}`,
      ].join("\n"),
    },
    associations: [{
      to   : { id: contactId },
      types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: 3 }],
    }],
  });

  if (!res.ok) {
    throw new Error(`Deal creation failed (${res.status}): ${JSON.stringify(res.data)}`);
  }

  console.log(`  [HS] ✓ Deal created     id=${res.data.id}  "${dealName}"`);
  return res.data.id;
}

/**
 * Master push function.
 * force=true  → bypasses dedup guard (used by the test panel).
 * force=false → skips if already pushed (used by real payments).
 * Returns { contactId, dealId } on success, or throws.
 */
async function pushToHubSpot(orderRef, amountRaw, currency, status, force) {
  if (!HS_TOKEN) throw new Error("HUBSPOT_ACCESS_TOKEN is not set");
  if (!force && HS_PUSHED.has(orderRef)) {
    console.log(`  [HS] ↩ Already pushed  ref=${orderRef}`);
    return null;
  }
  console.log(`\n  [HS] Pushing → ref=${orderRef}  ${currency}  ${amountRaw}`);
  const contactId = await hsUpsertContact(orderRef);
  const dealId    = await hsCreateDeal(orderRef, amountRaw, currency, status, contactId);
  HS_PUSHED.add(orderRef);
  console.log(`  [HS] ✅ Complete — contact=${contactId}  deal=${dealId}\n`);
  return { contactId, dealId };
}

/* ══════════════════════════════════════════════
   ADMIN AUTH MIDDLEWARE
══════════════════════════════════════════════ */
function adminAuth(req, res, next) {
  if (!ADMIN_PASSWORD) {
    return res.status(500).json({ error: "ADMIN_PASSWORD not set in Railway variables." });
  }
  const pwd = (req.body && req.body.password) || req.headers["x-admin-password"] || "";
  if (pwd !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: "Invalid admin password." });
  }
  next();
}

/* ══════════════════════════════════════════════
   ADMIN TEST PANEL — HTML
══════════════════════════════════════════════ */
const ADMIN_PANEL_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1.0"/>
<title>Nubexcloud \u2014 HubSpot Test Panel</title>
<style>
@import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;600;700&family=Sora:wght@300;400;600;700;800&display=swap');
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:#080c12;--surface:#0f1521;--surface2:#141d2e;--surface3:#1a2540;
  --border:#1e2d45;--border2:#243555;
  --orange:#f97316;--orange-dim:rgba(249,115,22,.12);--orange-glow:rgba(249,115,22,.25);
  --blue:#3b82f6;--blue-dim:rgba(59,130,246,.1);
  --green:#22c55e;--green-dim:rgba(34,197,94,.1);
  --red:#ef4444;--red-dim:rgba(239,68,68,.1);
  --text:#dde6f5;--muted:#4f6a8f;--muted2:#6b84a8;
  --mono:'JetBrains Mono',monospace;
  --sans:'Sora',sans-serif;
  --r:10px;
}
body{background:var(--bg);color:var(--text);font-family:var(--sans);min-height:100vh;display:flex;flex-direction:column;}
.header{background:var(--surface);border-bottom:1px solid var(--border);padding:14px 28px;display:flex;align-items:center;justify-content:space-between;}
.logo{display:flex;align-items:center;gap:10px;}
.logo-mark{width:34px;height:34px;background:linear-gradient(135deg,#f97316,#ea580c);border-radius:8px;display:flex;align-items:center;justify-content:center;font-size:16px;font-weight:800;color:#fff;font-family:var(--mono);}
.logo-name{font-size:14px;font-weight:700;letter-spacing:-.02em;}
.logo-name span{color:var(--orange);}
.logo-sub{font-size:10px;color:var(--muted);font-weight:400;margin-top:1px;}
.hbadge{display:flex;align-items:center;gap:6px;background:var(--surface2);border:1px solid var(--border2);border-radius:99px;padding:5px 13px;font-size:10px;font-weight:700;color:var(--muted2);letter-spacing:.06em;text-transform:uppercase;}
.bdot{width:5px;height:5px;border-radius:50%;background:var(--orange);animation:pulse 2s infinite;}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.3}}
main{flex:1;display:flex;align-items:center;justify-content:center;padding:32px 20px;}
.panel{width:100%;max-width:580px;}

/* LOGIN */
#loginScreen{text-align:center;}
.l-icon{width:72px;height:72px;background:var(--orange-dim);border:2px solid var(--orange-glow);border-radius:18px;display:flex;align-items:center;justify-content:center;font-size:30px;margin:0 auto 22px;}
.l-title{font-size:24px;font-weight:800;margin-bottom:8px;letter-spacing:-.03em;}
.l-sub{font-size:13px;color:var(--muted2);margin-bottom:28px;font-weight:300;line-height:1.65;}
.pwd-wrap{position:relative;margin-bottom:12px;}
.pwd-inp{width:100%;padding:14px 50px 14px 18px;background:var(--surface2);border:1.5px solid var(--border2);border-radius:var(--r);font-size:14px;font-family:var(--mono);color:var(--text);outline:none;transition:border-color .2s,box-shadow .2s;letter-spacing:.1em;}
.pwd-inp:focus{border-color:var(--orange);box-shadow:0 0 0 3px var(--orange-dim);}
.pwd-inp::placeholder{letter-spacing:.02em;font-size:13px;color:var(--muted);}
.eye-btn{position:absolute;right:14px;top:50%;transform:translateY(-50%);background:none;border:none;color:var(--muted);cursor:pointer;font-size:16px;padding:4px;}
.l-btn{width:100%;padding:14px;background:linear-gradient(135deg,#f97316,#ea580c);border:none;border-radius:var(--r);font-size:14px;font-weight:700;color:#fff;cursor:pointer;font-family:var(--sans);transition:transform .15s,box-shadow .15s;box-shadow:0 4px 20px var(--orange-glow);}
.l-btn:hover{transform:translateY(-1px);box-shadow:0 6px 28px rgba(249,115,22,.4);}
.l-err{margin-top:10px;font-size:12px;color:var(--red);display:none;}

/* TEST PANEL */
#testPanel{display:none;}
.top-bar{display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:24px;}
.ph h1{font-size:22px;font-weight:800;letter-spacing:-.03em;margin-bottom:5px;}
.ph h1 span{color:var(--orange);}
.ph p{font-size:12.5px;color:var(--muted2);line-height:1.65;font-weight:300;max-width:420px;}
.logout-btn{flex-shrink:0;background:none;border:1px solid var(--border2);border-radius:6px;color:var(--muted);font-size:11px;padding:6px 13px;cursor:pointer;font-family:var(--sans);transition:all .15s;margin-top:4px;}
.logout-btn:hover{border-color:var(--red);color:var(--red);}
.sec-lbl{font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:.13em;color:var(--muted);margin-bottom:12px;padding-bottom:7px;border-bottom:1px solid var(--border);}
.fields-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:22px;}
.f-full{grid-column:1/-1;}
.field label{display:block;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.1em;color:var(--muted2);margin-bottom:7px;}
.field input,.field select{width:100%;padding:11px 14px;background:var(--surface2);border:1.5px solid var(--border2);border-radius:8px;font-size:13px;font-family:var(--mono);color:var(--text);outline:none;transition:border-color .2s,box-shadow .2s;-webkit-appearance:none;}
.field input:focus,.field select:focus{border-color:var(--orange);box-shadow:0 0 0 3px var(--orange-dim);}
.field select option{background:var(--surface2);}
.ref-wrap{position:relative;}
.ref-inp{padding-right:52px!important;}
.regen{position:absolute;right:8px;top:50%;transform:translateY(-50%);background:var(--surface3);border:1px solid var(--border2);border-radius:6px;color:var(--muted2);font-size:11px;padding:4px 10px;cursor:pointer;font-family:var(--sans);font-weight:600;transition:all .15s;}
.regen:hover{color:var(--orange);border-color:var(--orange);}
.push-btn{width:100%;padding:14px;background:linear-gradient(135deg,#f97316,#ea580c);border:none;border-radius:var(--r);font-size:14px;font-weight:700;color:#fff;cursor:pointer;font-family:var(--sans);transition:all .15s;box-shadow:0 4px 20px var(--orange-glow);display:flex;align-items:center;justify-content:center;gap:9px;}
.push-btn:hover:not(:disabled){transform:translateY(-1px);box-shadow:0 6px 28px rgba(249,115,22,.42);}
.push-btn:disabled{opacity:.5;cursor:not-allowed;transform:none!important;}
.spin{width:14px;height:14px;border:2px solid rgba(255,255,255,.3);border-top-color:#fff;border-radius:50%;animation:sp .7s linear infinite;display:none;}
@keyframes sp{to{transform:rotate(360deg)}}

/* RESULT */
#resultBox{margin-top:20px;display:none;}
.rc{border-radius:var(--r);overflow:hidden;border:1px solid;}
.rc.ok{border-color:rgba(34,197,94,.3);}
.rc.err{border-color:rgba(239,68,68,.3);}
.rc-top{padding:14px 18px;display:flex;align-items:center;gap:12px;}
.rc-top.ok{background:var(--green-dim);}
.rc-top.err{background:var(--red-dim);}
.rc-ico{font-size:22px;flex-shrink:0;}
.rc-title{font-size:14px;font-weight:700;}
.rc-title.ok{color:var(--green);}
.rc-title.err{color:var(--red);}
.rc-sub{font-size:11.5px;color:var(--muted2);margin-top:2px;}
.rc-body{background:var(--surface2);padding:16px 18px;display:grid;grid-template-columns:1fr 1fr;gap:10px;}
.rc-cell{background:var(--surface3);border:1px solid var(--border2);border-radius:8px;padding:11px 13px;}
.rc-lbl{font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:.1em;color:var(--muted);margin-bottom:5px;}
.rc-val{font-size:11.5px;font-family:var(--mono);color:var(--text);word-break:break-all;font-weight:600;}
.rc-val.or{color:var(--orange);}
.rc-val.gn{color:var(--green);}
.rc-val.bl{color:#60a5fa;}
.hs-link{display:inline-flex;align-items:center;gap:5px;margin-top:12px;font-size:12px;font-weight:600;color:var(--orange);text-decoration:none;background:var(--orange-dim);border:1px solid var(--orange-glow);border-radius:6px;padding:7px 14px;transition:background .15s;}
.hs-link:hover{background:rgba(249,115,22,.2);}
.rc-foot{padding:13px 18px;background:var(--surface2);border-top:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;}
.again-btn{background:none;border:1px solid var(--border2);border-radius:6px;color:var(--muted2);font-size:12px;font-weight:600;padding:7px 14px;cursor:pointer;font-family:var(--sans);transition:all .15s;}
.again-btn:hover{border-color:var(--orange);color:var(--orange);}
.ts{font-size:10px;color:var(--muted);font-family:var(--mono);}
@media(max-width:500px){
  .fields-grid,.rc-body{grid-template-columns:1fr;}
  .f-full{grid-column:1;}
  main{padding:20px 16px;}
}
</style>
</head>
<body>

<div class="header">
  <div class="logo">
    <div class="logo-mark">N</div>
    <div>
      <div class="logo-name"><span>Nubex</span>cloud</div>
      <div class="logo-sub">Internal Admin</div>
    </div>
  </div>
  <div class="hbadge"><div class="bdot"></div>HubSpot Test Panel</div>
</div>

<main>
<div class="panel">

  <!-- LOGIN SCREEN -->
  <div id="loginScreen">
    <div class="l-icon">&#x1F510;</div>
    <div class="l-title">Admin Access</div>
    <div class="l-sub">This panel pushes test records directly into your HubSpot CRM.<br/>Enter your admin password to continue.</div>
    <div class="pwd-wrap">
      <input class="pwd-inp" id="pwdInp" type="password" placeholder="Enter admin password&hellip;" autocomplete="current-password"/>
      <button class="eye-btn" id="eyeBtn" onclick="togglePwd()">&#x1F441;</button>
    </div>
    <button class="l-btn" onclick="doLogin()">Unlock Panel &rarr;</button>
    <div class="l-err" id="loginErr">&#x26A0; Incorrect password. Please try again.</div>
  </div>

  <!-- TEST PANEL -->
  <div id="testPanel">
    <div class="top-bar">
      <div class="ph">
        <h1>HubSpot <span>Test Push</span></h1>
        <p>Fill in the fields below and click Push. A Contact + Deal will be created in HubSpot instantly &mdash; no payment required.</p>
      </div>
      <button class="logout-btn" onclick="logout()">Log out</button>
    </div>

    <div class="sec-lbl" style="margin-top:4px;">Transaction Fields</div>

    <div class="fields-grid">
      <div class="field f-full">
        <label>Order Reference (auto-generated)</label>
        <div class="ref-wrap">
          <input class="ref-inp" id="fRef" type="text" readonly/>
          <button class="regen" onclick="regenRef()">&#x21BB; New</button>
        </div>
      </div>
      <div class="field">
        <label>Amount</label>
        <input id="fAmount" type="number" min="1" step="0.01" value="100.00" placeholder="100.00"/>
      </div>
      <div class="field">
        <label>Currency</label>
        <select id="fCurrency">
          <option value="USD">USD &mdash; US Dollar</option>
          <option value="AED" selected>AED &mdash; UAE Dirham</option>
          <option value="EUR">EUR &mdash; Euro</option>
        </select>
      </div>
      <div class="field f-full">
        <label>Payment Status</label>
        <select id="fStatus">
          <option value="CAPTURED" selected>CAPTURED &mdash; Payment successful</option>
          <option value="AUTHORISED">AUTHORISED &mdash; Payment approved</option>
          <option value="PURCHASED">PURCHASED &mdash; Purchase complete</option>
        </select>
      </div>
    </div>

    <button class="push-btn" id="pushBtn" onclick="doPush()">
      <span id="pushLabel">Push to HubSpot &rarr;</span>
      <div class="spin" id="pushSpin"></div>
    </button>

    <div id="resultBox"></div>
  </div>

</div>
</main>

<script>
var adminPwd = "";

function togglePwd(){
  var i=document.getElementById("pwdInp"),b=document.getElementById("eyeBtn");
  if(i.type==="password"){i.type="text";b.innerHTML="&#x1F648;";}
  else{i.type="password";b.innerHTML="&#x1F441;";}
}
document.getElementById("pwdInp").addEventListener("keydown",function(e){if(e.key==="Enter")doLogin();});

function doLogin(){
  var pwd=document.getElementById("pwdInp").value.trim();
  if(!pwd){showErr();return;}
  fetch("/api/admin/ping",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({password:pwd})})
    .then(function(r){
      if(r.ok){adminPwd=pwd;document.getElementById("loginScreen").style.display="none";document.getElementById("testPanel").style.display="block";regenRef();}
      else showErr();
    }).catch(showErr);
}
function showErr(){
  var e=document.getElementById("loginErr");e.style.display="block";
  setTimeout(function(){e.style.display="none";},3000);
}
function logout(){
  adminPwd="";
  document.getElementById("testPanel").style.display="none";
  document.getElementById("loginScreen").style.display="block";
  document.getElementById("pwdInp").value="";
  document.getElementById("resultBox").style.display="none";
}
function regenRef(){
  var ts=Date.now().toString().slice(-8);
  var rnd=Math.random().toString(36).slice(2,6).toUpperCase();
  document.getElementById("fRef").value="TEST-"+ts+"-"+rnd;
}
function setLoading(on){
  var btn=document.getElementById("pushBtn"),lbl=document.getElementById("pushLabel"),sp=document.getElementById("pushSpin");
  btn.disabled=on;lbl.style.display=on?"none":"inline";sp.style.display=on?"block":"none";
}
function doPush(){
  var ref=document.getElementById("fRef").value.trim();
  var amount=parseFloat(document.getElementById("fAmount").value);
  var currency=document.getElementById("fCurrency").value;
  var status=document.getElementById("fStatus").value;
  if(!ref||isNaN(amount)||amount<=0){alert("Please fill in all fields correctly.");return;}
  setLoading(true);
  document.getElementById("resultBox").style.display="none";
  fetch("/api/admin/test-hubspot",{
    method:"POST",
    headers:{"Content-Type":"application/json"},
    body:JSON.stringify({password:adminPwd,orderRef:ref,amount:amount,currency:currency,status:status})
  }).then(function(r){return r.json().then(function(d){return{ok:r.ok,data:d};});})
  .then(function(r){
    if(r.ok&&r.data.success) showResult("ok",ref,amount,currency,status,r.data);
    else showResult("err",ref,amount,currency,status,r.data);
    setLoading(false);
  }).catch(function(e){showResult("err",ref,amount,currency,status,{error:e.message});setLoading(false);});
}
function fmt(amount,currency){
  var n=Number(amount).toFixed(2);
  return currency==="USD"?"$"+n:currency==="EUR"?"\\u20AC"+n:"AED "+n;
}
function showResult(type,ref,amount,currency,status,data){
  var box=document.getElementById("resultBox");
  var ts=new Date().toLocaleString("en-AE");
  var email="customer-"+ref+"@nubexcloud.com";
  var amtFmt=fmt(amount,currency);
  if(type==="ok"){
    box.innerHTML='<div class="rc ok">'
      +'<div class="rc-top ok"><div class="rc-ico">&#x2705;</div><div>'
      +'<div class="rc-title ok">Successfully pushed to HubSpot</div>'
      +'<div class="rc-sub">Contact + Deal created and linked in your CRM</div></div></div>'
      +'<div class="rc-body">'
      +'<div class="rc-cell"><div class="rc-lbl">&#x1F464; Contact ID</div><div class="rc-val bl">'+((data.contact&&data.contact.id)||"&mdash;")+'</div></div>'
      +'<div class="rc-cell"><div class="rc-lbl">&#x1F4B0; Deal ID</div><div class="rc-val gn">'+((data.deal&&data.deal.id)||"&mdash;")+'</div></div>'
      +'<div class="rc-cell"><div class="rc-lbl">&#x1F4E7; Email Generated</div><div class="rc-val or" style="font-size:10px;">'+email+'</div></div>'
      +'<div class="rc-cell"><div class="rc-lbl">&#x1F4B5; Amount</div><div class="rc-val gn">'+amtFmt+'</div></div>'
      +'<div class="rc-cell"><div class="rc-lbl">&#x1F516; Order Ref</div><div class="rc-val" style="font-size:10px;">'+ref+'</div></div>'
      +'<div class="rc-cell"><div class="rc-lbl">&#x1F4CB; Status</div><div class="rc-val">'+status+'</div></div>'
      +'</div>'
      +'<div class="rc-foot">'
      +'<a class="hs-link" href="https://app.hubspot.com/contacts/'+(data.contact&&data.contact.id||'')+'" target="_blank">Open in HubSpot &rarr;</a>'
      +'<div style="display:flex;align-items:center;gap:10px;"><span class="ts">'+ts+'</span>'
      +'<button class="again-btn" onclick="regenRef();document.getElementById(\'resultBox\').style.display=\'none\';">&larr; Test Again</button>'
      +'</div></div></div>';
  } else {
    box.innerHTML='<div class="rc err">'
      +'<div class="rc-top err"><div class="rc-ico">&#x274C;</div><div>'
      +'<div class="rc-title err">Push Failed</div>'
      +'<div class="rc-sub">'+(data.error||"Unknown error &mdash; check Railway logs")+'</div></div></div>'
      +'<div class="rc-foot"><span class="ts">'+ts+'</span>'
      +'<button class="again-btn" onclick="document.getElementById(\'resultBox\').style.display=\'none\';">&larr; Try Again</button>'
      +'</div></div>';
  }
  box.style.display="block";
  box.scrollIntoView({behavior:"smooth",block:"nearest"});
}
</script>
</body>
</html>`;

/* ══════════════════════════════════════════════
   ROUTES
══════════════════════════════════════════════ */

/* Payment page */
app.get("/", (_req, res) => {
  const htmlPath = path.join(__dirname, "public", "index.html");
  if (!fs.existsSync(htmlPath)) {
    return res.status(404).send("Payment page not found. Put index.html inside /public.");
  }
  let html = fs.readFileSync(htmlPath, "utf8");
  const inject = `<script>window.__SERVER_CONFIG__={currency:"${CURRENCY}",sandbox:${SANDBOX},serverMode:true};</script>`;
  html = html.replace("</head>", inject + "\n</head>");
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(html);
});

/* Admin test panel UI */
app.get("/admin/test", (_req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(ADMIN_PANEL_HTML);
});

/* Admin ping — validates password only (used by login form) */
app.post("/api/admin/ping", adminAuth, (_req, res) => {
  res.json({ ok: true });
});

/* Admin test-push — push a synthetic transaction directly to HubSpot */
app.post("/api/admin/test-hubspot", adminAuth, async (req, res) => {
  const { orderRef, amount, currency, status } = req.body;

  if (!orderRef || !amount || !currency || !status) {
    return res.status(400).json({ success: false, error: "Missing fields: orderRef, amount, currency, status" });
  }
  if (isNaN(Number(amount)) || Number(amount) <= 0) {
    return res.status(400).json({ success: false, error: "Amount must be a positive number" });
  }

  const amountCents = Math.round(Number(amount) * 100); // dollars → cents

  try {
    const result = await pushToHubSpot(orderRef, amountCents, currency, status, true); // force=true
    return res.json({
      success: true,
      contact: { id: result.contactId, email: `customer-${orderRef}@nubexcloud.com` },
      deal   : { id: result.dealId,    name:  `Nubex Payment \u2014 ${orderRef}` },
    });
  } catch (err) {
    console.error("[TEST] HubSpot push error:", err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
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

  console.log(`\n[PAYMENT] ${cur} ${(amountInt / 100).toFixed(2)} \u2192 redirect: ${redirectBase}`);

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

/* Order status — auto-triggers HubSpot push on confirmed real payments */
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
    if (orderRef && CONFIRMED.some(function(s){ return status.includes(s); })) {
      // Fire-and-forget — never delays the customer response
      pushToHubSpot(orderRef, amount, currency, status, false).catch(function(){});
    }

    res.json({ reference: orderRef, status, amount, currency });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* Health check */
app.get("/health", (_req, res) => {
  res.json({
    status    : "ok",
    env       : SANDBOX ? "sandbox" : "live",
    configured: !!(API_KEY && OUTLET_ID),
    hubspot   : HS_TOKEN       ? "\u2713 configured" : "\u26A0 not configured",
    admin     : ADMIN_PASSWORD ? "\u2713 configured" : "\u26A0 not configured",
    hs_pushed : HS_PUSHED.size,
  });
});

/* Start */
app.listen(PORT, () => {
  console.log("\n\u2554\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2557");
  console.log("\u2551  Nubexcloud Payment Server \u2014 LIVE        \u2551");
  console.log("\u255A\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u255D");
  console.log(`  Port    : ${PORT}`);
  console.log(`  Mode    : ${SANDBOX ? "\u{1F9EA} SANDBOX" : "\u{1F7E2} LIVE"}`);
  console.log(`  Currency: ${CURRENCY}`);
  console.log(`  Outlet  : ${OUTLET_ID      ? OUTLET_ID.slice(0,8)+"\u2026" : "\u26A0 NOT SET"}`);
  console.log(`  Key     : ${API_KEY        ? "\u2713 Set" : "\u26A0 NOT SET"}`);
  console.log(`  Redirect: ${REDIRECT_BASE  || "(not set)"}`);
  console.log(`  HubSpot : ${HS_TOKEN       ? "\u2713 Set" : "\u26A0 NOT SET \u2014 CRM push disabled"}`);
  console.log(`  Admin   : ${ADMIN_PASSWORD ? "\u2713 Set" : "\u26A0 NOT SET \u2014 test panel disabled"}\n`);
});
