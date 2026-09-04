// Wallet balances for the Top Up picker: "what do I hold, and what is it worth"
// in ONE place, so a listener can choose a token without leaving the page.
//
// Two constraints shape this:
//  1. There is a hard 1-RPC/sec budget process-wide (rpc-budget.js). Fetching
//     five balances one-by-one would cost five seconds; Hyperion's get_tokens
//     returns every balance in a SINGLE call, so that is what we use.
//  2. The keeper's own RPC (tn1.protonnz.com) answers get_tokens but returns an
//     EMPTY list for wallets that demonstrably hold funds — it is not indexing.
//     Pointing this at that host would silently show every user a zero balance,
//     which looks like "you have nothing" rather than "we could not tell".
//     Hence a separate, explicitly-indexed endpoint plus a sanity check.
"use strict";

const { rpcSlot } = require("./rpc-budget");
const pricing = require("./onda-pricing");

const HYPERION = process.env.ONDA_HYPERION || "https://test.proton.eosusa.io";
const WALLET_TTL_MS = Number(process.env.ONDA_WALLET_TTL_MS || 20000);
const PRICE_TTL_MS = Number(process.env.ONDA_WALLET_PRICE_TTL_MS || 60000);

const walletCache = new Map();
let priceCache = null;
let priceAt = 0;

async function payablePrices() {
  if (priceCache && Date.now() - priceAt < PRICE_TTL_MS) return priceCache;
  try {
    const { rows } = await pricing.plan();
    priceCache = new Map(rows.map((r) => [`${r.token.contract}|${r.token.sym}`, r]));
    priceAt = Date.now();
  } catch {
    if (!priceCache) priceCache = new Map();
  }
  return priceCache;
}

async function hyperionTokens(actor) {
  await rpcSlot();
  const res = await fetch(`${HYPERION}/v2/state/get_tokens?account=${encodeURIComponent(actor)}`,
    { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`hyperion ${res.status}`);
  const data = await res.json();
  return Array.isArray(data.tokens) ? data.tokens : [];
}

// An empty list is ambiguous: genuinely-empty wallet, or an indexer that is not
// indexing. Confirm against the chain itself before reporting zeros as fact.
async function confirmEmpty(actor) {
  try {
    await rpcSlot();
    const res = await fetch(`${HYPERION}/v1/chain/get_currency_balance`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: "eosio.token", account: actor, symbol: "XPR" }),
      signal: AbortSignal.timeout(8000),
    });
    const rows = await res.json();
    return Array.isArray(rows) && rows.length === 0;   // true = really empty
  } catch { return false; }
}

async function walletFor(actor, opts) {
  if (!actor) return { actor: null, tokens: [], reliable: false };
  // fresh=1 (post-deposit/withdraw refresh) skips the TTL cache read but
  // still repopulates it — one client action gets current numbers without
  // letting every poll hammer the indexer (Gabriel, 2026-09-03).
  if (!(opts && opts.fresh)) {
    const hit = walletCache.get(actor);
    if (hit && Date.now() - hit.at < WALLET_TTL_MS) return hit.value;
  }

  const prices = await payablePrices();
  let held = [];
  let reliable = true;
  try {
    held = await hyperionTokens(actor);
    if (!held.length) reliable = await confirmEmpty(actor);
  } catch {
    reliable = false;
  }

  const bySymbol = new Map(held.map((t) => [`${t.contract}|${t.symbol}`, Number(t.amount) || 0]));
  const tokens = pricing.TOKENS.map((t) => {
    const balance = bySymbol.get(`${t.contract}|${t.symbol ||
      t.sym.split(",")[1]}`) ?? bySymbol.get(`${t.contract}|${t.sym.split(",")[1]}`) ?? 0;
    const row = prices.get(`${t.contract}|${t.sym}`);
    const priceUsd = row && row.priceUsd ? row.priceUsd : null;
    return {
      key: t.key,
      symbol: t.sym.split(",")[1],
      contract: t.contract,
      precision: t.precision,
      // Real token amounts, never raw integers and never a synthetic "credit".
      balance: +balance.toFixed(t.precision),
      price_usd: priceUsd,
      value_usd: priceUsd != null ? +(balance * priceUsd).toFixed(4) : null,
      price_source: row ? row.source : "unavailable",
    };
  });

  const value = { actor, tokens, reliable, fetched_at: new Date().toISOString() };
  walletCache.set(actor, { value, at: Date.now() });
  return value;
}

// Live USD prices keyed the way the player already keys currencies, so any
// display can stop using the hardcoded TOKEN_USD constants. Falls back to the
// caller's constants per-token when a feed is unavailable (LOAN has none), so a
// missing oracle degrades one row rather than blanking the whole panel.
async function livePrices(fallback) {
  const prices = await payablePrices();
  const out = Object.assign({}, fallback || {});
  for (const t of pricing.TOKENS) {
    const row = prices.get(`${t.contract}|${t.sym}`);
    if (row && row.priceUsd) out[t.key] = row.priceUsd;
  }
  return out;
}

module.exports = { walletFor, livePrices };
