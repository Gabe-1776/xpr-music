// Keep every payable token charging the SAME value per second.
//
// The contract stores a fixed raw amount per token per second and knows nothing
// about USD. Left alone those raw amounts drift as prices move, so a METAL
// listener silently pays more (or less) than an XUSDC listener for the same
// music. This polls the on-chain `oracles` feeds and rewrites `tokrates` so the
// USD value per second matches across all of them.
//
// Shares the ONE global RPC budget (see rpc-budget.js) — polling never competes
// with the keeper's pulls for the 1-call/sec limit.
"use strict";

const { Api, JsonRpc, JsSignatureProvider } = require("@proton/js");
const { rateLimit, cacheInfo } = require("./rpc-budget");

const RPC = process.env.ONDA_KEEPER_RPC || "https://tn1.protonnz.com";
const CONTRACT = "ondastream";
const ACTOR = process.env.ONDA_PRICER_ACCOUNT || "";
const KEY = process.env.ONDA_PRICER_PRIVATE_KEY || "";
// Should be a permission scoped to ondastream::settokrate ONLY — never a key
// that can `setcode`, which could redeploy the contract and drain grants.
const PERM = process.env.ONDA_PRICER_PERMISSION || "active";
const POLL_MS = Number(process.env.ONDA_PRICE_POLL_MS || 6000);
// Don't spend a transaction on noise; only rewrite on a real move.
const MIN_CHANGE = Number(process.env.ONDA_PRICE_MIN_CHANGE || 0.01);

// feed_index -> name, from the `oracles` feeds table.
const FEEDS = { 3: "XPR/USD", 5: "USDC/USD", 6: "MTL/USD", 12: "XMD/USD" };

// A token is either oracle-priced or pegged. `pegged` means "worth this many
// USD, no feed needed"; LOAN has NO oracle feed on this chain, so it can only
// ever be a manual number — flagged rather than silently guessed.
const TOKENS = [
  { key: "xpr",   contract: "eosio.token", sym: "4,XPR",   precision: 4, feed: "XPR/USD" },
  { key: "usdc",  contract: "xtokens",     sym: "6,XUSDC", precision: 6, pegged: 1 },
  { key: "metal", contract: "xtokens",     sym: "8,METAL", precision: 8, feed: "MTL/USD" },
  { key: "xmd",   contract: "xmd.token",   sym: "6,XMD",   precision: 6, pegged: 1 },
  { key: "loan",  contract: "loan.token",  sym: "4,LOAN",  precision: 4,
    manual: Number(process.env.ONDA_LOAN_USD || 0.00039), noFeed: true },
];

function enabled() {
  return Boolean(ACTOR && KEY);
}

let rpcClient = null;
let api = null;
function getRpc() {
  if (!rpcClient) rpcClient = cacheInfo(rateLimit(new JsonRpc([RPC])));
  return rpcClient;
}
function getApi() {
  if (!api) api = new Api({ rpc: getRpc(), signatureProvider: new JsSignatureProvider([KEY]) });
  return api;
}

async function oraclePrices() {
  const out = {};
  try {
    const r = await getRpc().get_table_rows({ json: true, code: "oracles", scope: "oracles", table: "data", limit: 60 });
    for (const row of (r.rows || [])) {
      const name = FEEDS[row.feed_index];
      if (!name) continue;
      const v = row.aggregate && row.aggregate.d_double;
      const n = Number(v);
      if (Number.isFinite(n) && n > 0) out[name] = n;
    }
  } catch (e) {
    console.error("onda pricing: oracle read failed", String(e && e.message).slice(0, 120));
  }
  return out;
}

function usdPerSec() {
  // One number defines the product's price; every token converts into it.
  return Number(process.env.ONDA_USD_PER_SEC || 0.00005);
}

// Raw integer units of `token` that equal usdPerSec of value, each second.
function rawPerSec(token, usd, priceUsd) {
  if (!(priceUsd > 0)) return null;
  return Math.max(1, Math.round((usd / priceUsd) * 10 ** token.precision));
}

function priceFor(token, feeds) {
  if (token.pegged) return { price: token.pegged, source: "pegged" };
  if (token.feed && feeds[token.feed]) return { price: feeds[token.feed], source: token.feed };
  if (token.manual) return { price: token.manual, source: "manual (no oracle feed)" };
  return { price: null, source: "unavailable" };
}

async function currentRates() {
  const out = new Map();
  try {
    const r = await getRpc().get_table_rows({ json: true, code: CONTRACT, scope: CONTRACT, table: "tokrates", limit: 50 });
    for (const row of (r.rows || [])) out.set(`${row.tokenContract}|${row.symRaw}`, Number(row.perSec));
  } catch {}
  return out;
}

// Compute what every token SHOULD charge. Pure — no writes, so it doubles as
// the dry-run used to eyeball pricing before letting it loose.
async function plan() {
  const feeds = await oraclePrices();
  const usd = usdPerSec();
  const rows = [];
  for (const t of TOKENS) {
    const { price, source } = priceFor(t, feeds);
    const target = price ? rawPerSec(t, usd, price) : null;
    rows.push({ token: t, priceUsd: price, source, target });
  }
  return { usd, rows };
}

async function applyOnce() {
  if (!enabled()) return { applied: 0, skipped: "pricer key unset" };
  const { rows } = await plan();
  const live = await currentRates();
  const actions = [];
  for (const r of rows) {
    if (!r.target) continue;
    const symRaw = symRawOf(r.token.sym);
    const now = live.get(`${r.token.contract}|${symRaw}`);
    if (now != null && Math.abs(r.target - now) / Math.max(1, now) < MIN_CHANGE) continue;
    actions.push({
      account: CONTRACT, name: "settokrate",
      authorization: [{ actor: ACTOR, permission: PERM }],
      data: { token: r.token.contract, sym: r.token.sym, perSec: r.target, enabled: true },
    });
  }
  if (!actions.length) return { applied: 0 };
  try {
    // One transaction for all repricing — flat RPC cost regardless of token count.
    await getApi().transact({ actions }, { blocksBehind: 3, expireSeconds: 30 });
    return { applied: actions.length };
  } catch (e) {
    console.error("onda pricing: settokrate failed", String(e && e.message).slice(0, 160));
    return { applied: 0, error: true };
  }
}

// "4,XPR" -> the u64 the chain stores (precision in the low byte, ASCII above).
function symRawOf(sym) {
  const [precStr, code] = String(sym).split(",");
  let v = 0n;
  for (let i = code.length - 1; i >= 0; i--) v = (v << 8n) | BigInt(code.charCodeAt(i));
  return String((v << 8n) | BigInt(Number(precStr)));
}

function start() {
  if (!enabled()) {
    console.log("onda pricing: pricer key unset — token rates stay fixed");
    return { enabled: false, plan, applyOnce };
  }
  console.log(`onda pricing: normalising all tokens to $${usdPerSec()}/sec every ${POLL_MS / 1000}s as ${ACTOR}@${PERM}`);
  let busy = false;
  setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      const r = await applyOnce();
      if (r.applied) console.log(`onda pricing: repriced ${r.applied} token(s)`);
    } catch (e) {
      console.error("onda pricing tick", String(e && e.message).slice(0, 160));
    } finally { busy = false; }
  }, POLL_MS);
  return { enabled: true, plan, applyOnce };
}

module.exports = { start, plan, applyOnce, symRawOf, enabled, TOKENS };
