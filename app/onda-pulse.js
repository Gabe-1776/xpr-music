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
const RPC = process.env.ONDA_KEEPER_RPC || "https://test.proton.eosusa.io"; // fastest testnet endpoint (2.6x faster than tn1) — TAPOS + push latency dominates the 2s tick
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
const MODE_TTL_MS = Number(process.env.ONDA_MODE_TTL_MS || 60000);
// Max pull actions per batched transaction. Above this, contract CPU/frame
// limits risk failing the whole room; chunks keep a tx comfortably small.
const BATCH_MAX = Number(process.env.ONDA_BATCH_MAX || 25);
// Minimum wall time between billing pushes: the contract's windowSec is 2s,
// and billing less than that per poke is fine, but hammering per-block would
// spam the fuse (same-second pokes reject). 2s floor = one poke per window.
const WINDOW_S_FLOOR_MS = 2000;

function enabled() {
  return Boolean(ACTOR && KEY);
}

const { rateLimit, invalidateInfo, rpcLog } = require("./rpc-budget");

let api = null;
let rpcClient = null;
function getRpc() {
  if (!rpcClient) {
    // rateLimit wraps RPC calls: priority calls (get_info, push_transaction)
    // are never queued; read calls adhere to MIN_RPC_INTERVAL_MS.
    // cacheInfo is intentionally NOT used here: caching get_info with a 10s TTL
    // made head_block_num stagnant for 10s, stretching the 2s block-driven
    // tick into 12-13s pull gaps (2026-09-04).
    rpcClient = rateLimit(new JsonRpc([RPC]));
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
  try {
    return await getApi().transact({
      actions: [{ account: CONTRACT, name, authorization: [{ actor: ACTOR, permission: "active" }], data }],
    }, { blocksBehind: 3, expireSeconds: 30 });
  } finally {
    try { invalidateInfo(); } catch (_) {}
  }
}

// ── mode resolution ────────────────────────────────────────────────────────
// ONE table read per table for ALL listeners, refreshed on a timer — never a
// per-listener query. With N listeners the RPC cost must not scale with N.
let modeMap = new Map();
let modesAt = 0;
// Onda top-up piggy per account — the REAL playback balance the contract
// pulls from. Same table read as the mode map, exposed for display so the
// server never needs its own copy of these numbers.
let piggyMap = new Map();
let piggyAt = 0;

/** Cached piggy balance for one listener, or null. Freshness = mode TTL. */
function piggyFor(listener) {
  return piggyMap.get(listener) || null;
}

function piggyFreshness() {
  return piggyAt;
}

// Throws on a failed read instead of returning []. An empty array is
// indistinguishable from "this listener has no balance row", which classified a
// fully funded listener as `unfunded` and stopped their playback on a single
// transient RPC error. Callers decide what to do with the failure.
// Paginated past 500 rows: a listener whose row sorts beyond the first page
// must still be seen, or the keeper misclassifies them as unfunded and stops
// their playback. Each page is one rate-limited call (the 1/s budget holds;
// extra pages just land in later slots). MAX_TABLE_PAGES is a runaway guard.
const MAX_TABLE_PAGES = 20;

async function rows(opts) {
  const out = [];
  let lower = "";
  for (let page = 0; page < MAX_TABLE_PAGES; page++) {
    const r = await getRpc().get_table_rows(Object.assign(
      { json: true, code: CONTRACT, scope: CONTRACT },
      opts,
      lower ? { lower_bound: lower } : {}
    ));
    const batch = (r && r.rows) || [];
    out.push(...batch);
    if (r && r.more) {
      lower = r.next_key || "";
      if (!lower) break;
    } else {
      break;
    }
  }
  return out;
}

async function refreshModes(force) {
  if (!force && Date.now() - modesAt < MODE_TTL_MS) return modeMap;
  const now = Math.floor(Date.now() / 1000);
  const next = new Map();

  // windowSec is read, not assumed: hardcoding 2 here meant an owner calling
  // `setwindow` would stall every balance pull on "below window" with nothing
  // in the code to explain why.
  const cfg = (await rows({ table: "config", limit: 1 }))[0];
  windowSec = Number(cfg && cfg.windowSec) || WINDOW_SEC_FALLBACK;

  // Per-token per-second rate, needed to convert a deposit's `maxPerTick`
  // (raw units) into the seconds of catch-up that cap will actually admit.
  const rateOf = new Map();
  for (const r of await rows({ table: "tokrates", limit: 500 })) {
    if (Number(r.enabled) !== 0) rateOf.set(`${r.tokenContract}|${r.symRaw}`, Number(r.perSec));
  }

  // Keep BOTH piggy banks per listener. Settings picks which one the keeper
  // uses (default top-up). Grant-first used to silently drain the wallet
  // while parked balances sat unused.
  function entry(name) {
    if (!next.has(name)) next.set(name, { grant: null, balance: null });
    return next.get(name);
  }
  for (const g of await rows({ table: "grants", limit: 500 })) {
    if (Number(g.expiresAt) > now && Number(g.spent) < Number(g.budget)) {
      entry(g.listener).grant = { kind: "grant", token: extSym(g.tokenContract, g.symRaw) };
    }
  }
  piggyMap = new Map();
  for (const b of await rows({ table: "balances", limit: 500 })) {
    if (Number(b.amount) > 0) {
      piggyMap.set(b.account, {
        amount: Number(b.amount),
        token: extSym(b.tokenContract, b.symRaw),
        maxPerTick: Number(b.maxPerTick) || 0,
        perSec: rateOf.get(`${b.tokenContract}|${b.symRaw}`) || 0,
      });
      entry(b.account).balance = {
        kind: "balance",
        token: extSym(b.tokenContract, b.symRaw),
        maxPerTick: Number(b.maxPerTick) || 0,
        perSec: rateOf.get(`${b.tokenContract}|${b.symRaw}`) || 0,
      };
    }
  }
  piggyAt = Date.now();
  modeMap = next;
  modesAt = Date.now();
  return modeMap;
}

/** Settings pay source: missing/unknown = topup (consumer default). */
function normalizePaySource(v) {
  return v === "wallet" ? "wallet" : "topup";
}

/**
 * Pick the piggy bank Settings selected. Never fall through to the other
 * one — a leftover grant must not hijack parked top-up funds.
 */
function pickMode(entry, paySource) {
  if (!entry) return null;
  if (normalizePaySource(paySource) === "wallet") return entry.grant || null;
  return entry.balance || null;
}
// Returns null when the chain could not be read. Serving the STALE map would be
// wrong too (a revoked grant would keep pulling), so callers skip the tick --
// wall-clock accrual means nothing is lost by waiting one round.
async function refreshModesSafe(force) {
  try {
    return await refreshModes(force);
  } catch (e) {
    console.warn("onda mode read failed, skipping tick:", String((e && e.message) || e).slice(0, 160));
    return null;
  }
}

/** Cached mode+piggy refresh for DISPLAY paths (state polls). Self-throttled
 * by the mode TTL, so a 2s poll never causes extra reads — it at most awaits
 * one refresh per TTL window. Returns null if the read failed. */
async function ensureModes() {
  const modes = await refreshModesSafe(false);
  return modes == null ? null : piggyFor;
}

function invalidateMode() {
  modesAt = 0;
  try { invalidateInfo(); } catch (_) {}
}

// Owed playback seconds per actor, for pullbal's `playedSec`.
//
// Accrued from the WALL CLOCK, never by counting ticks: a tick is dropped
// whenever a send overruns the 2s timer, so tick-counting would reproduce
// exactly the undercount this exists to fix. It only advances for an actor
// the server reports as PLAYING right now, so paused time is still free --
// dropping an actor forgets their watermark, and resuming starts from zero
// rather than billing the pause.
const seenAt = new Map();
const owedSec = new Map();
const absentAt = new Map();
// How long an un-pulled debt survives after the listener stops. Long enough to
// cover a pause or a reload, short enough that the maps cannot grow forever.
const OWED_TTL_MS = 60 * 60 * 1000;
const WINDOW_SEC_FALLBACK = 2; // only until the first config read succeeds
let windowSec = WINDOW_SEC_FALLBACK;

function accrue(actors, nowMs) {
  for (const actor of [...seenAt.keys()]) {
    if (actors.has(actor)) continue;
    // Stop the clock so the pause itself is never billed -- but KEEP the debt.
    // Deleting it here would forfeit seconds the listener really did play and
    // the artist really did earn, which is a smaller version of the very bug
    // this accrual exists to fix.
    seenAt.delete(actor);
    absentAt.set(actor, nowMs);
  }
  for (const [actor, at] of [...absentAt]) {
    if (nowMs - at > OWED_TTL_MS) { absentAt.delete(actor); owedSec.delete(actor); }
  }
  for (const actor of actors) {
    absentAt.delete(actor);
    const prev = seenAt.get(actor);
    seenAt.set(actor, nowMs);
    if (prev === undefined) continue; // first sighting after a gap owes nothing yet
    const add = Math.floor((nowMs - prev) / 1000);
    if (add <= 0) continue;
    const next = (owedSec.get(actor) || 0) + add;
    // Cap at one batch. A late tick does not pile 8–16s of catch-up.
    owedSec.set(actor, next > windowSec ? windowSec : next);
  }
}

// Only clear what the chain actually accepted. A reverted batch keeps its
// debt so the next successful pull still covers the time.
function settle(actors) {
  for (const actor of actors) owedSec.delete(actor);
}

function _debtState() { return { seenAt, owedSec, absentAt }; } // tests only

function actionFor(listener, songId, mode) {
  const auth = [{ actor: ACTOR, permission: "active" }];
  if (!mode) return { account: CONTRACT, name: "pulse", authorization: auth, data: { listener, songId } };
  if (mode.kind === "grant") return { account: CONTRACT, name: "pullpay", authorization: auth, data: { listener, songId } };
  return {
    account: CONTRACT,
    name: "pullbal",
    authorization: auth,
    data: { listener, songId, token: mode.token || XPR },
  };
}

function classify(msg) {
  if (/fuse|below second/i.test(msg)) return null;
  // TAPOS/expiry from a queued poke — retry next tick with a fresh ref block,
  // do not stop playback as if the listener was unfunded.
  if (/expired transaction|duplicate transaction/i.test(msg)) return null;
  if (/keeper unset|song not active|unknown song/i.test(msg)) return null;
  // Deposit-cap failures. The UI keys on these exact codes; without them a
  // capped-out stream stops with nothing shown to the listener but a server log.
  if (/tick over cap/i.test(msg)) return "tickcap";
  if (/cap unset/i.test(msg)) return "capunset";
  if (/insufficient onda balance|no onda balance/i.test(msg)) return "nofunds";
  if (/irrelevant authority|missing authority/i.test(msg)) return "nolink";
  if (/budget exhausted/i.test(msg)) return "budget";
  if (/grant expired/i.test(msg)) return "expired";
  if (/token not payable/i.test(msg)) return "unpayable";
  if (/no open stream|no grant/i.test(msg)) return "unfunded";
  return null;
}

async function send(actions) {
  try {
    return await getApi().transact({ actions }, { blocksBehind: 3, expireSeconds: 30 });
  } finally {
    // The cached get_info (10s TTL) makes consecutive identical pulls share a
    // ref block + head_time + expiration → identical txid → "duplicate
    // transaction" revert. Invalidate after every transact so each pull gets
    // fresh TAPOS.
    try { invalidateInfo(); } catch (_) {}
  }
}

// Pay one slice for every playing listener in a SINGLE transaction, so RPC
// cost is flat in listener count. A batch is atomic, so one broke listener
// would revert everyone's payment — on failure we isolate on the next tick to
// find the culprit rather than letting it stall the whole room.
let isolateNext = false;
let pokeBusy = false;

async function payAll(live, onFailure) {
  if (!enabled()) return;
  if (pokeBusy) return;
  // Accrue BEFORE the empty check: an actor who stopped playing must have their
  // watermark forgotten even on a tick where nobody is playing at all.
  const actors = new Set(live.map((r) => r.actor));
  accrue(actors, Date.now());
  if (!live.length) return;

  const modes = await refreshModesSafe(false);
  if (modes == null) return; // read failed: skip rather than bill against a blind map
  // One action per ACTOR. Two tabs on one account used to emit two pullbal
  // actions in a single transaction; the second hit the contract fuse (same
  // block second) and reverted the batch for every other listener too.
  const byActor = new Map();
  for (const r of live) if (!byActor.has(r.actor)) byActor.set(r.actor, r);
  const targets = [];
  for (const r of byActor.values()) {
    // Free / CC tracks are not billed. Missing `billable` means billable
    // (older callers and tests).
    if (r.billable === false) continue;
    const mode = pickMode(modes.get(r.actor), r.paySource);
    if (!mode) {
      if (typeof onFailure === "function") {
        onFailure(r.actor, normalizePaySource(r.paySource) === "wallet" ? "unfunded" : "nofunds");
      }
      continue;
    }
    targets.push({ ...r, mode });
  }
  if (!targets.length) return;

  pokeBusy = true;
  try {
  if (!isolateNext) {
    // Split large rooms: one tx per ONDA_BATCH_MAX actions. A single tx with
    // hundreds of actions hits contract CPU/frame limits and fails the whole
    // room; chunks keep RPC cost near-flat (ceil(N/chunk) txs per tick).
    const chunked = [];
    for (let i = 0; i < targets.length; i += BATCH_MAX) {
      chunked.push(targets.slice(i, i + BATCH_MAX));
    }
    try {
      for (const chunk of chunked) {
        await send(chunk.map((t) => actionFor(t.actor, t.songId, t.mode)));
        settle(chunk.map((t) => t.actor));
      }
      return;
    } catch (e) {
      // Reverts were invisible: no log, no signal, and the debt silently
      // carried. Record what failed so a stalled payout can be diagnosed
      // without reading chain history. No invalidateMode here: a reverted
      // batch is a TAPOS/transport failure, not a modes change — the contract
      // still enforces balance/grant on the retry.
      console.warn("onda batch reverted, isolating next tick:", String((e && e.message) || e).slice(0, 200));
      isolateNext = true;
      return;
    }
  }

  isolateNext = false;
  for (const t of targets) {
    try {
      await send([actionFor(t.actor, t.songId, t.mode)]);
      settle([t.actor]);
    } catch (e) {
      const d = e && e.json && e.json.error && Array.isArray(e.json.error.details) ? e.json.error.details[0] : null;
      const msg = String((d && d.message) || (e && e.message) || e || "");
      const reason = classify(msg);
      if (reason) {
        // The CONTRACT enforced balance/grant/cap and rejected — that IS the
        // awareness. Modes only change on revoke/link changes (nolink);
        // balance exhaustion is per-listener state the contract reports,
        // not something the mode map tracks.
        if (reason === "nolink") invalidateMode();
        if (typeof onFailure === "function") onFailure(t.actor, reason);
      } else if (!/fuse|expired transaction|duplicate transaction/i.test(msg)) {
        console.error("onda pay", t.actor, t.songId, msg.slice(0, 200));
      }
    }
  }
  } finally {
    pokeBusy = false;
  }
}

// Single-listener path, kept for direct calls and tests.
async function payFor(listener, songId, paySource) {
  if (!enabled() || !listener || !songId) return null;
  const modes = await refreshModesSafe(false);
  if (modes == null) return null;
  const mode = pickMode(modes.get(listener), paySource);
  if (!mode) return normalizePaySource(paySource) === "wallet" ? "unfunded" : "nofunds";
  try {
    await send([actionFor(listener, songId, mode)]);
    settle([listener]);
    return null;
  } catch (e) {
    const d = e && e.json && e.json.error && Array.isArray(e.json.error.details) ? e.json.error.details[0] : null;
    const msg = String((d && d.message) || (e && e.message) || e || "");
    const reason = classify(msg);
    if (reason === "nolink") invalidateMode();
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
    // Rebating a leftover does not change which piggy bank anyone uses —
    // no invalidateMode here.
  } catch (e) {
    const msg = String((e && e.message) || e || "");
    if (/no open|keeper unset/i.test(msg)) return;
    console.error("onda expire", listener, msg.slice(0, 200));
  }
}

// Pause / skip mid-batch: pull the leftover second (or whatever is owed,
// capped at one window) against THIS song's payout, then clear the debt.
// Pause / skip / play-start: poke the contract clock. First poke opens
// lastPull with no transfer; a poke 1s later bills 1s; 2s later bills 2s.
async function settleRemainder(listener, songId, paySource) {
  if (!enabled() || !listener || !songId) return null;
  if (pokeBusy) return null;
  pokeBusy = true;
  try {
    const modes = await refreshModesSafe(false);
    if (modes == null) return null;
    const mode = pickMode(modes.get(listener), paySource);
    if (!mode) return null;
    try {
      await send([actionFor(listener, songId, mode)]);
      settle([listener]);
      seenAt.delete(listener);
      return null;
    } catch (e) {
      const d = e && e.json && e.json.error && Array.isArray(e.json.error.details) ? e.json.error.details[0] : null;
      const msg = String((d && d.message) || (e && e.message) || e || "");
      const reason = classify(msg);
      if (reason) {
        if (reason === "nolink") invalidateMode();
        return reason;
      }
      if (!/fuse|below second|expired transaction|duplicate transaction/i.test(msg)) {
        console.warn("onda remainder", listener, songId, msg.slice(0, 180));
      }
      return null;
    }
  } finally {
    pokeBusy = false;
  }
}

function start(getPlaying, onPaymentFailure) {
  if (!enabled()) {
    console.log("onda pulse: keeper unset — chain pulses off");
    return { pulse: payFor, payFor, expire, invalidateMode, enabled: false };
  }
  console.log("onda pulse: keeper", ACTOR, "(batched, max 1 RPC/sec)");

  // Mode/piggy refresh runs on its OWN background cadence (every 15s), never
  // inside the 2s tick. Before this, an expired TTL made the tick do 4
  // table reads through the 1/s read queue (~3s stall) -> busy-skip next
  // tick -> pull gaps of 4-20s and underbilled playback (chain evidence:
  // only 4/77 pulls on cadence, 2026-08-30). The contract enforces balance/
  // grant/cap itself, so a 15-60s stale mode map is harmless — worst case,
  // one pull bounces off the contract and the keeper classifies the revert.
  let modesRefreshing = false;
  setInterval(async () => {
    if (modesRefreshing) return;
    modesRefreshing = true;
    try {
      await refreshModesSafe(true);
    } finally {
      modesRefreshing = false;
    }
  }, 15000);
  // Prime immediately so the first tick has a map (and piggy display data).
  void refreshModesSafe(true);

  // BLOCK-DRIVEN tick (2026-08-30): instead of a wall-clock 2s timer racing
  // block production, fire on the first NEW head block observed after
  // WINDOW_S elapsed. Blocks are 500ms; a push issued right after a new head
  // lands 1-2 blocks later, so tick placement has ~1 block of jitter instead
  // of timer-vs-block drift. Head polls are priority calls (never queued).
  let busy = false;
  let lastHead = 0;
  let lastTickAt = 0;
  setInterval(async () => {
    try {
      const info = await getRpc().get_info();
      const head = Number(info.head_block_num);
      const elapsed = Date.now() - lastTickAt;
      const isNew = head !== lastHead;
      lastHead = head;
      if (!isNew || elapsed < WINDOW_S_FLOOR_MS || busy) return;
      busy = true;
      lastTickAt = Date.now();
      try {
        const live = typeof getPlaying === "function" ? (getPlaying() || []) : [];
        await payAll(live, onPaymentFailure);
      } catch (e) {
        console.error("onda tick", String((e && e.message) || e).slice(0, 200));
      } finally {
        busy = false;
      }
    } catch (_) { /* head poll failed — retry next iteration */ }
  }, 250); // poll heads at 2x block rate; priority call
  return { pulse: payFor, payFor, payAll, expire, settleRemainder, invalidateMode, enabled: true };
}

module.exports = { start, payFor, payAll, pulse: payFor, expire, settleRemainder, invalidateMode, enabled, pickMode, normalizePaySource, piggyFor, piggyFreshness, ensureModes, _rpcLog: rpcLog, _debtState };
