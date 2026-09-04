// ONE global RPC budget for the whole server. Every chain call — keeper pulls,
// price polling, anything added later — goes through here, so the limit is a
// property of the process rather than a promise each caller has to keep.
//
// SPLIT budget (2026-08-30): READS (get_table_rows etc.) wait at least
// MIN_RPC_INTERVAL_MS apart. WRITES (push_transaction) and get_info for TAPOS
// take a priority slot instead — they log for the budget meter but never
// wait. Making a 2s pull wait behind a table read stretched the keeper's 2s
// cadence into 4-20s gaps of unbilled playback (chain evidence 2026-08-30:
// only 4/77 pulls on a 2s cadence). `transact` internally does get_info +
// push; both are priority. The endpoint's own capacity is the write limit.
//
// Applied by wrapping a JsonRpc instance's methods: @proton/js's
// `JsonRpc(endpoints)` constructor takes ONLY endpoints and silently ignores a
// `{ fetch }` option, so there is no transport hook to use instead.
"use strict";

const MIN_RPC_INTERVAL_MS = Number(process.env.ONDA_MIN_RPC_MS || 250);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rpcLog = [];
let lastRpcAt = 0;
let queue = Promise.resolve();

function logCall() {
  rpcLog.push(Date.now());
  if (rpcLog.length > 500) rpcLog.splice(0, rpcLog.length - 500);
}

function rpcSlot() {
  queue = queue.then(async () => {
    const wait = lastRpcAt + MIN_RPC_INTERVAL_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastRpcAt = Date.now();
    logCall();
  });
  return queue;
}

// Methods every transaction path depends on. Rate-limiting these made keeper
// pulls wait behind table reads and stretched the 2s tick to 4-20s.
const PRIORITY_KEYS = new Set(["push_transaction", "get_info"]);

function rateLimit(rpc) {
  for (const key of Object.keys(rpc)) {
    const fn = rpc[key];
    if (typeof fn !== "function") continue;
    if (PRIORITY_KEYS.has(key)) {
      // Priority path: counted in the budget meter, never queued.
      rpc[key] = async (...args) => {
        logCall();
        return fn.apply(rpc, args);
      };
      continue;
    }
    rpc[key] = async (...args) => {
      await rpcSlot();
      return fn.apply(rpc, args);
    };
  }
  return rpc;
}

// get_info caching is NO LONGER used for TAPOS freshness — onda-pulse.js
// invalidates after every transact so each pull gets a unique txid (a cached
// ref block + expiration produced identical txids and "duplicate transaction"
// reverts). Kept for other callers that may want read caching.
let infoCached = null;
let infoAt = 0;

function invalidateInfo() {
  infoCached = null;
  infoAt = 0;
}

function cacheInfo(rpc, ttlMs = 10000) {
  const raw = rpc.get_info.bind(rpc);
  rpc.get_info = async () => {
    if (infoCached && Date.now() - infoAt < ttlMs) return infoCached;
    infoCached = await raw();
    infoAt = Date.now();
    return infoCached;
  };
  return rpc;
}

function callsPerSec(windowMs = 10000) {
  const cutoff = Date.now() - windowMs;
  const n = rpcLog.filter((t) => t >= cutoff).length;
  return +(n / (windowMs / 1000)).toFixed(2);
}

module.exports = { rpcSlot, rateLimit, cacheInfo, invalidateInfo, rpcLog, callsPerSec, MIN_RPC_INTERVAL_MS };
