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

// Throws on a failed read instead of returning []. An empty array is
// indistinguishable from "this listener has no balance row", which classified a
// fully funded listener as `unfunded` and stopped their playback on a single
// transient RPC error. Callers decide what to do with the failure.
async function rows(opts) {
  const r = await getRpc().get_table_rows(Object.assign({ json: true, code: CONTRACT, scope: CONTRACT }, opts));
  return (r && r.rows) || [];
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

  for (const g of await rows({ table: "grants", limit: 500 })) {
    if (Number(g.expiresAt) > now && Number(g.spent) < Number(g.budget)) {
      next.set(g.listener, { kind: "grant", token: extSym(g.tokenContract, g.symRaw) });
    }
  }
  for (const b of await rows({ table: "balances", limit: 500 })) {
    if (Number(b.amount) > 0 && !next.has(b.account)) {
      next.set(b.account, {
        kind: "balance",
        token: extSym(b.tokenContract, b.symRaw),
        maxPerTick: Number(b.maxPerTick) || 0,
        perSec: rateOf.get(`${b.tokenContract}|${b.symRaw}`) || 0,
      });
    }
  }
  modeMap = next;
  modesAt = Date.now();
  return modeMap;
}

/**
 * Seconds this pull may claim without breaching the deposit's stamped cap.
 *
 * The cap is `rate_at_deposit * windowSec * 8`; the charge is
 * `rate_now * billable`. Those are equal at billable = 16 only while the rate
 * has not moved, so ANY upward reprice makes a full 16s catch-up exceed the
 * cap -- and because the debt is not cleared by a failed pull, that stall is
 * sticky, not transient. Clamping here keeps `tick over cap` meaning what it
 * was designed to mean: a genuinely stale cap, not ordinary catch-up.
 *
 * Never returns less than one window: a cap too small for even a normal slice
 * IS the stale-cap case, and the contract should reject it loudly.
 */
function capAdmits(mode, owed) {
  if (!mode || mode.kind !== "balance" || !mode.perSec || !mode.maxPerTick) return owed;
  const fits = Math.floor(mode.maxPerTick / mode.perSec);
  return Math.max(windowSec, Math.min(owed, fits));
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

function invalidateMode() {
  modesAt = 0;
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
const MAX_CATCHUP_SEC = 16; // must match MAX_CATCHUP_SEC in the contract
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
    owedSec.set(actor, next > MAX_CATCHUP_SEC ? MAX_CATCHUP_SEC : next);
  }
}

// Only clear what the chain actually accepted. A reverted batch keeps its
// debt so the next successful pull still covers the time.
function settle(actors) {
  for (const actor of actors) owedSec.delete(actor);
}

function _debtState() { return { seenAt, owedSec, absentAt }; } // tests only

function actionFor(listener, songId, mode, playedSec) {
  const auth = [{ actor: ACTOR, permission: "active" }];
  if (!mode) return { account: CONTRACT, name: "pulse", authorization: auth, data: { listener, songId } };
  if (mode.kind === "grant") return { account: CONTRACT, name: "pullpay", authorization: auth, data: { listener, songId } };
  return {
    account: CONTRACT,
    name: "pullbal",
    authorization: auth,
    data: { listener, songId, token: mode.token || XPR, playedSec },
  };
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
  if (!enabled()) return;
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
  const targets = [...byActor.values()]
    .map((r) => ({ ...r, mode: modes.get(r.actor), playedSec: owedSec.get(r.actor) || 0 }))
    // Below one window the contract refuses with "below window"; sending it
    // would revert the whole batch to move nothing.
    .filter((t) => t.mode == null || t.mode.kind !== "balance" || t.playedSec >= windowSec);
  if (!targets.length) return;

  if (!isolateNext) {
    try {
      await send(targets.map((t) => actionFor(t.actor, t.songId, t.mode, capAdmits(t.mode, t.playedSec))));
      settle(targets.map((t) => t.actor));
      return;
    } catch (e) {
      // Reverts were invisible: no log, no signal, and the debt silently
      // carried. Record what failed so a stalled payout can be diagnosed
      // without reading chain history.
      console.warn("onda batch reverted, isolating next tick:", String((e && e.message) || e).slice(0, 200));
      isolateNext = true;
      invalidateMode();
      return;
    }
  }

  isolateNext = false;
  for (const t of targets) {
    try {
      await send([actionFor(t.actor, t.songId, t.mode, capAdmits(t.mode, t.playedSec))]);
      settle([t.actor]);
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
  const modes = await refreshModesSafe(false);
  if (modes == null) return null;
  const mode = modes.get(listener);
  try {
    await send([actionFor(listener, songId, mode, capAdmits(mode, owedSec.get(listener) || windowSec))]);
    settle([listener]);
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

module.exports = { start, payFor, payAll, pulse: payFor, expire, invalidateMode, enabled, _rpcLog: rpcLog, _debtState };
