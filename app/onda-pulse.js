// Keeper: every windowSec, move one slice of money for each playing session.
// Signs with ONDA_KEEPER_* only — never the listener key, never the contract key.
//
// Two modes (see BLUEPRINT-pay-modes.md):
//   grant   -> `pullpay`  money leaves the LISTENER'S WALLET (power user)
//   balance -> `pullbal`  money leaves their topped-up credits (consumer default)
// The legacy lock path (`pulse`) is still honoured if an old lock exists.
"use strict";

const { Api, JsonRpc, JsSignatureProvider } = require("@proton/js");

const ACTOR = process.env.ONDA_KEEPER_ACCOUNT || "";
const KEY = process.env.ONDA_KEEPER_PRIVATE_KEY || "";
const RPC = process.env.ONDA_KEEPER_RPC || "https://tn1.protonnz.com";
const CONTRACT = "ondastream";
const XPR = { contract: "eosio.token", sym: "4,XPR" };

// A symbol's raw u64 packs precision in the low byte and the ASCII code above
// it, so any payable token decodes without a hardcoded table. Needed because
// contract name alone is ambiguous: `xtokens` hosts both XUSDC and METAL.
function symFromRaw(raw) {
  let v = BigInt(raw);
  const precision = Number(v & 0xffn);
  v >>= 8n;
  let code = "";
  while (v > 0n) {
    const c = Number(v & 0xffn);
    if (c) code += String.fromCharCode(c);
    v >>= 8n;
  }
  return `${precision},${code}`;
}
function extSym(contract, symRaw) {
  return { contract, sym: symFromRaw(symRaw) };
}
const MODE_TTL_MS = 15000;

function enabled() {
  return Boolean(ACTOR && KEY);
}

const { rateLimit, cacheInfo, rpcLog } = require("./rpc-budget");

let api = null;
let rpcClient = null;
function getRpc() {
  if (!rpcClient) {
    rpcClient = cacheInfo(rateLimit(new JsonRpc([RPC])));
  }
  return rpcClient;
}
function getApi() {
  if (!api) api = new Api({ rpc: getRpc(), signatureProvider: new JsSignatureProvider([KEY]) });
  return api;
}

function errText(e) {
  const d = e && e.json && e.json.error && Array.isArray(e.json.error.details) ? e.json.error.details[0] : null;
  return String((d && d.message) || (e && e.message) || e || "").slice(0, 240);
}

async function act(name, data) {
  if (!enabled()) return null;
  return getApi().transact({
    actions: [{ account: CONTRACT, name, authorization: [{ actor: ACTOR, permission: "active" }], data }],
  }, { blocksBehind: 3, expireSeconds: 30 });
}

// ── mode resolution ────────────────────────────────────────────────────────
// ONE table read per table for ALL listeners, refreshed on a timer — never a
// per-listener query. With N listeners the RPC cost must not scale with N.
let modeMap = new Map();
let modesAt = 0;

async function rows(opts) {
  try {
    const r = await getRpc().get_table_rows(Object.assign({ json: true, code: CONTRACT, scope: CONTRACT }, opts));
    return (r && r.rows) || [];
  } catch { return []; }
}

async function refreshModes(force) {
  if (!force && Date.now() - modesAt < MODE_TTL_MS) return modeMap;
  const now = Math.floor(Date.now() / 1000);
  const next = new Map();
  for (const g of await rows({ table: "grants", limit: 500 })) {
    if (Number(g.expiresAt) > now && Number(g.spent) < Number(g.budget)) {
      next.set(g.listener, { kind: "grant", token: extSym(g.tokenContract, g.symRaw) });
    }
  }
  for (const b of await rows({ table: "balances", limit: 500 })) {
    if (Number(b.amount) > 0 && !next.has(b.account)) {
      next.set(b.account, { kind: "balance", token: extSym(b.tokenContract, b.symRaw) });
    }
  }
  modeMap = next;
  modesAt = Date.now();
  return modeMap;
}

function invalidateMode() {
  modesAt = 0;
}

function actionFor(listener, songId, mode) {
  const auth = [{ actor: ACTOR, permission: "active" }];
  if (!mode) return { account: CONTRACT, name: "pulse", authorization: auth, data: { listener, songId } };
  if (mode.kind === "grant") return { account: CONTRACT, name: "pullpay", authorization: auth, data: { listener, songId } };
  return { account: CONTRACT, name: "pullbal", authorization: auth, data: { listener, songId, token: mode.token || XPR } };
}

function classify(msg) {
  if (/fuse/i.test(msg)) return null;
  if (/keeper unset|song not active|unknown song/i.test(msg)) return null;
  // Deposit-cap failures. The UI keys on these exact codes; without them a
  // capped-out stream stops with nothing shown to the listener but a server log.
  if (/tick over cap/i.test(msg)) return "tickcap";
  if (/cap unset/i.test(msg)) return "capunset";
  if (/insufficient onda balance|no onda balance/i.test(msg)) return "nofunds";
  if (/irrelevant authority|missing authority/i.test(msg)) return "revoked";
  if (/budget exhausted/i.test(msg)) return "budget";
  if (/grant expired/i.test(msg)) return "expired";
  if (/token not payable/i.test(msg)) return "unpayable";
  if (/no open stream|no grant/i.test(msg)) return "unfunded";
  return null;
}

async function send(actions) {
  return getApi().transact({ actions }, { blocksBehind: 3, expireSeconds: 30 });
}

// Pay one slice for every playing listener in a SINGLE transaction, so RPC
// cost is flat in listener count. A batch is atomic, so one broke listener
// would revert everyone's payment — on failure we isolate on the next tick to
// find the culprit rather than letting it stall the whole room.
let isolateNext = false;

async function payAll(live, onFailure) {
  if (!enabled() || !live.length) return;
  const modes = await refreshModes(false);
  const targets = live.map((r) => ({ ...r, mode: modes.get(r.actor) }));

  if (!isolateNext) {
    try {
      await send(targets.map((t) => actionFor(t.actor, t.songId, t.mode)));
      return;
    } catch (e) {
      isolateNext = true;
      invalidateMode();
      return;
    }
  }

  isolateNext = false;
  for (const t of targets) {
    try {
      await send([actionFor(t.actor, t.songId, t.mode)]);
    } catch (e) {
      const d = e && e.json && e.json.error && Array.isArray(e.json.error.details) ? e.json.error.details[0] : null;
      const msg = String((d && d.message) || (e && e.message) || e || "");
      const reason = classify(msg);
      if (reason) {
        invalidateMode();
        if (typeof onFailure === "function") onFailure(t.actor, reason);
      } else if (!/fuse/i.test(msg)) {
        console.error("onda pay", t.actor, t.songId, msg.slice(0, 200));
      }
    }
  }
}

// Single-listener path, kept for direct calls and tests.
async function payFor(listener, songId) {
  if (!enabled() || !listener || !songId) return null;
  const modes = await refreshModes(false);
  try {
    await send([actionFor(listener, songId, modes.get(listener))]);
    return null;
  } catch (e) {
    const d = e && e.json && e.json.error && Array.isArray(e.json.error.details) ? e.json.error.details[0] : null;
    const msg = String((d && d.message) || (e && e.message) || e || "");
    const reason = classify(msg);
    if (reason) invalidateMode();
    return reason;
  }
}

// Kept for stop/logout. NOT for pause: pausing used to call this, which
// refunded the whole remaining lock and forced a fresh signature on the very
// next song. Pause should hold your place, not cash you out.
async function expire(listener) {
  if (!enabled() || !listener) return;
  try {
    await send([{ account: CONTRACT, name: "expire", authorization: [{ actor: ACTOR, permission: "active" }], data: { listener } }]);
    invalidateMode();
  } catch (e) {
    const msg = String((e && e.message) || e || "");
    if (/no open|keeper unset/i.test(msg)) return;
    console.error("onda expire", listener, msg.slice(0, 200));
  }
}

function start(getPlaying, onPaymentFailure) {
  if (!enabled()) {
    console.log("onda pulse: keeper unset — chain pulses off");
    return { pulse: payFor, payFor, expire, invalidateMode, enabled: false };
  }
  console.log("onda pulse: keeper", ACTOR, "(batched, max 1 RPC/sec)");
  let busy = false;
  setInterval(async () => {
    // The limiter can push a tick past 2s; overlapping ticks would double-spend
    // RPC budget and race the fuse. Skip instead of stacking.
    if (busy) return;
    busy = true;
    try {
      const live = typeof getPlaying === "function" ? (getPlaying() || []) : [];
      await payAll(live, onPaymentFailure);
    } catch (e) {
      console.error("onda tick", String((e && e.message) || e).slice(0, 200));
    } finally {
      busy = false;
    }
  }, 2000);
  return { pulse: payFor, payFor, payAll, expire, invalidateMode, enabled: true };
}

module.exports = { start, payFor, payAll, pulse: payFor, expire, invalidateMode, enabled, _rpcLog: rpcLog };
