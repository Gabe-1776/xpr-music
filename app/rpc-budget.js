// ONE global RPC budget for the whole server. Every chain call — keeper pulls,
// price polling, anything added later — queues through here, so the limit is a
// property of the process rather than a promise each caller has to keep.
//
// Applied by wrapping a JsonRpc instance's methods: @proton/js's
// `JsonRpc(endpoints)` constructor takes ONLY endpoints and silently ignores a
// `{ fetch }` option, so there is no transport hook to use instead.
"use strict";

const MIN_RPC_INTERVAL_MS = Number(process.env.ONDA_MIN_RPC_MS || 1000);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rpcLog = [];
let lastRpcAt = 0;
let queue = Promise.resolve();

function rpcSlot() {
  queue = queue.then(async () => {
    const wait = lastRpcAt + MIN_RPC_INTERVAL_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastRpcAt = Date.now();
    rpcLog.push(lastRpcAt);
    if (rpcLog.length > 500) rpcLog.splice(0, rpcLog.length - 500);
  });
  return queue;
}

function rateLimit(rpc) {
  for (const key of Object.keys(rpc)) {
    const fn = rpc[key];
    if (typeof fn !== "function") continue;
    rpc[key] = async (...args) => {
      await rpcSlot();
      return fn.apply(rpc, args);
    };
  }
  return rpc;
}

// `transact` fetches get_info for TAPoS on EVERY transaction and never caches
// it. A ref block stays valid far longer than this, so caching halves spend.
function cacheInfo(rpc, ttlMs = 10000) {
  const raw = rpc.get_info.bind(rpc);
  let cached = null;
  let at = 0;
  rpc.get_info = async () => {
    if (cached && Date.now() - at < ttlMs) return cached;
    cached = await raw();
    at = Date.now();
    return cached;
  };
  return rpc;
}

function callsPerSec(windowMs = 10000) {
  const cutoff = Date.now() - windowMs;
  const n = rpcLog.filter((t) => t >= cutoff).length;
  return +(n / (windowMs / 1000)).toFixed(2);
}

module.exports = { rpcSlot, rateLimit, cacheInfo, rpcLog, callsPerSec, MIN_RPC_INTERVAL_MS };
