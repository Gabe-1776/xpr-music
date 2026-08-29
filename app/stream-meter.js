#!/usr/bin/env node
/**
 * Onda streaming meter — 2s rolling hold (same shape as the 15–30s vest
 * window, tighter). USD is the unit of account. Token amounts are derived
 * from the demo pegs. No chain transfers here.
 *
 * Hold: debit up to 2s of runway from the wallet into escrow.
 * Vest: move played-time * rate from escrow into spend (artist).
 * Rebate: on explicit stop (pause / skip / track end), unused escrow
 * returns to the wallet.
 * Crash: if a heartbeat gap exceeds 2s + grace, remaining escrow VESTS
 * (listener pays the open window, no rebate) and playback stops.
 */
"use strict";

const WINDOW_S = 2;
const STALE_GRACE_S = 1; // client polls every 2s; gap > 3s = dead client
const DEFAULT_USD_PER_SEC = 0.00005;
// Mutable so the admin dashboard can retune the streaming rate at runtime
// without a deploy. `setUsdPerSec` persists the value; every accrual reads
// `usdPerSec()`.
let _usdPerSec = DEFAULT_USD_PER_SEC;
function usdPerSec() { return _usdPerSec; }
function setUsdPerSec(v) {
  const n = Number(v);
  if (Number.isFinite(n) && n > 0) _usdPerSec = n;
  return _usdPerSec;
}

// Real XPR Network prices + per-token on-chain contract/symbol/precision.
// usdc → XUSDC (xtokens, 6dp), loan → LOAN (loan.token, 4dp), metal → METAL (xtokens, 8dp).
const TOKEN_USD = { xpr: 0.0018, usdc: 1, loan: 0.00039, metal: 0.10, xmd: 1 };
// contract + symbol together are the identity: `xtokens` hosts BOTH XUSDC and
// METAL, so the contract name alone cannot name a token. Mirrors the on-chain
// `tokrates` table — keep the two in step.
const TOKEN_CONTRACTS = {
  xpr:   { contract: "eosio.token", symbol: "XPR",   precision: 4 },
  usdc:  { contract: "xtokens",     symbol: "XUSDC", precision: 6 },
  loan:  { contract: "loan.token",  symbol: "LOAN",  precision: 4 },
  metal: { contract: "xtokens",     symbol: "METAL", precision: 8 },
  xmd:   { contract: "xmd.token",   symbol: "XMD",   precision: 6 },
};

function windowUsd() {
  return WINDOW_S * usdPerSec();
}

function peg(cur) {
  const p = TOKEN_USD[cur];
  return Number.isFinite(p) && p > 0 ? p : TOKEN_USD.xpr;
}

function curOf(sess) {
  return TOKEN_USD[sess.currency] ? sess.currency : "xpr";
}

function usdToTok(usd, cur) {
  return usd / peg(cur);
}

function tokToUsd(tok, cur) {
  return tok * peg(cur);
}

function initMeter(sess) {
  if (!Number.isFinite(sess.escrow_usd)) sess.escrow_usd = 0;
  if (typeof sess.escrow_cur !== "string" || !sess.escrow_cur) sess.escrow_cur = curOf(sess);
  if (!sess.spend || typeof sess.spend !== "object") {
    sess.spend = { xpr: 0, usdc: 0, loan: 0, metal: 0 };
  }
  if (!Number.isFinite(sess.spend_usd)) sess.spend_usd = 0;
  if (!Number.isFinite(sess.position)) sess.position = 0;
}

function lockUsd(sess, wallet, usd, persist) {
  initMeter(sess);
  if (!(usd > 0)) return 0;
  const cur = curOf(sess);
  if (sess.escrow_usd > 0 && sess.escrow_cur && sess.escrow_cur !== cur) return 0;
  const have = Math.max(0, Number(wallet[cur]) || 0);
  const takeUsd = Math.min(usd, tokToUsd(have, cur));
  if (!(takeUsd > 0)) return 0;
  wallet[cur] = have - usdToTok(takeUsd, cur);
  sess.escrow_usd += takeUsd;
  sess.escrow_cur = cur;
  if (typeof persist === "function") persist();
  return takeUsd;
}

function rebate(sess, wallet, persist) {
  initMeter(sess);
  const usd = sess.escrow_usd;
  if (!(usd > 0)) {
    sess.escrow_usd = 0;
    return 0;
  }
  const cur = sess.escrow_cur || curOf(sess);
  wallet[cur] = Math.max(0, Number(wallet[cur]) || 0) + usdToTok(usd, cur);
  sess.escrow_usd = 0;
  if (typeof persist === "function") persist();
  return usd;
}

function vestUsd(sess, usd) {
  initMeter(sess);
  if (!(usd > 0)) return 0;
  const take = Math.min(usd, sess.escrow_usd);
  if (!(take > 0)) return 0;
  const cur = sess.escrow_cur || curOf(sess);
  sess.escrow_usd -= take;
  sess.spend_usd += take;
  sess.spend[cur] = (sess.spend[cur] || 0) + usdToTok(take, cur);
  return take;
}

function fillHold(sess, wallet, persist) {
  initMeter(sess);
  const missing = windowUsd() - sess.escrow_usd;
  if (missing > 1e-16) lockUsd(sess, wallet, missing, persist);
  return sess.escrow_usd;
}

function openPlay(sess, wallet, persist) {
  fillHold(sess, wallet, persist);
  return sess.escrow_usd > 0;
}

function closePlay(sess, wallet, persist) {
  return rebate(sess, wallet, persist);
}

/**
 * Advance the meter. `now` is injected so tests are deterministic.
 * @param {object} sess
 * @param {{ now: number, eligible: boolean, duration: number, wallet: object, renew?: boolean, persist?: function }} opts
 */
function tick(sess, opts) {
  const now = opts.now;
  const wallet = opts.wallet;
  const persist = opts.persist;
  const eligible = !!opts.eligible;
  const duration = Number(opts.duration) || 0;
  const renew = opts.renew !== false;
  initMeter(sess);

  const prevTick = Number.isFinite(sess.lastTick) ? sess.lastTick : now;
  let dt = (now - prevTick) / 1000;
  if (!Number.isFinite(dt) || dt < 0) dt = 0;
  const staleLimit = WINDOW_S + STALE_GRACE_S;

  if (!sess.playing) {
    sess.lastTick = now;
    return sess;
  }

  if (!eligible) {
    rebate(sess, wallet, persist);
    sess.position = Math.min((sess.position || 0) + dt, duration);
    if (duration > 0 && sess.position >= duration) sess.playing = false;
    sess.lastTick = now;
    return sess;
  }

  // Dead client: do not advance the playhead (no audio ran).
  // renew=true  (poll/play): vest the open window — crash bound, no rebate.
  // renew=false (explicit pause/skip): they sent stop; rebate unused hold.
  if (dt > staleLimit) {
    if (renew) {
      vestUsd(sess, sess.escrow_usd);
      sess.escrow_usd = 0;
      sess.stopReason = { reason: "stale_hold", window_s: WINDOW_S };
    } else {
      rebate(sess, wallet, persist);
    }
    sess.playing = false;
    sess.lastTick = now;
    return sess;
  }

  const prev = sess.position || 0;
  const room = Math.max(0, duration - prev);
  const wantPlay = Math.min(dt, room);
  const rate = usdPerSec();

  fillHold(sess, wallet, persist);

  let canPlay = sess.escrow_usd > 0 ? Math.min(wantPlay, sess.escrow_usd / rate) : 0;
  if (renew && canPlay < wantPlay) {
    lockUsd(sess, wallet, (wantPlay - canPlay) * rate, persist);
    canPlay = sess.escrow_usd > 0 ? Math.min(wantPlay, sess.escrow_usd / rate) : canPlay;
  }

  const vested = vestUsd(sess, canPlay * rate);
  const played = rate > 0 ? vested / rate : 0;
  sess.position = prev + played;

  if (played + 1e-12 < wantPlay) {
    sess.playing = false;
    sess.stopReason = { reason: "insufficient_balance", currency: curOf(sess) };
    rebate(sess, wallet, persist);
  } else if (duration > 0 && sess.position >= duration) {
    sess.playing = false;
    rebate(sess, wallet, persist);
  } else if (renew && sess.playing) {
    fillHold(sess, wallet, persist);
    if (sess.escrow_usd <= 0) {
      sess.playing = false;
      sess.stopReason = { reason: "insufficient_balance", currency: curOf(sess) };
    }
  }

  sess.lastTick = now;
  return sess;
}

module.exports = {
  WINDOW_S,
  STALE_GRACE_S,
  USD_PER_SEC: DEFAULT_USD_PER_SEC,  // historical export: default value (read-only)
  DEFAULT_USD_PER_SEC,
  usdPerSec,
  setUsdPerSec,
  TOKEN_USD,
  TOKEN_CONTRACTS,
  windowUsd,
  usdToTok,
  tokToUsd,
  tick,
  rebate,
  fillHold,
  openPlay,
  closePlay,
  lockUsd,
  vestUsd,
  initMeter,
  curOf,
};
