#!/usr/bin/env node
"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const m = require("../stream-meter");

const SEED_XPR = 50;
const TOL = 1e-9;

function fresh(overrides = {}) {
  const wallet = { xpr: SEED_XPR, usdc: 20, loan: 500, metal: 100 };
  const sess = {
    playing: false,
    position: 0,
    lastTick: 0,
    currency: "xpr",
    spend: { xpr: 0, usdc: 0, loan: 0, metal: 0 },
    spend_usd: 0,
    escrow_usd: 0,
    escrow_cur: "xpr",
    stopReason: null,
    ...overrides,
  };
  return { sess, wallet };
}

function conserved(sess, wallet, seedTok = SEED_XPR) {
  const cur = "xpr";
  const spendTok = sess.spend[cur] || 0;
  const heldTok = m.usdToTok(sess.escrow_usd || 0, cur);
  const left = Number(wallet[cur]) || 0;
  assert.ok(Math.abs(spendTok + heldTok + left - seedTok) < 1e-8, `conserved ${spendTok}+${heldTok}+${left} != ${seedTok}`);
  assert.ok(left >= -TOL, "no negative wallet");
  assert.ok(sess.escrow_usd >= -TOL, "no negative escrow");
}

test("pause after 0.5s bills 0.5s and rebates the rest of the 2s hold", () => {
  const { sess, wallet } = fresh({ lastTick: 1000 });
  sess.playing = true;
  assert.equal(m.openPlay(sess, wallet), true);
  conserved(sess, wallet);
  assert.ok(Math.abs(sess.escrow_usd - m.windowUsd()) < TOL);

  m.tick(sess, { now: 1000 + 500, eligible: true, duration: 105, wallet, renew: false });
  const rebated = m.closePlay(sess, wallet);
  sess.playing = false;

  const expectUsd = 0.5 * m.USD_PER_SEC;
  assert.ok(Math.abs(sess.spend_usd - expectUsd) < 1e-12, `spend ${sess.spend_usd} != ${expectUsd}`);
  assert.equal(sess.escrow_usd, 0);
  assert.ok(rebated > expectUsd, "rebate is the unused tail, larger than the 0.5s vest");
  conserved(sess, wallet);
  assert.ok(Math.abs(wallet.xpr - (SEED_XPR - m.usdToTok(expectUsd, "xpr"))) < 1e-8);
});

test("2.5s of healthy polls: spend 2.5s, hold refilled to ~2s while playing", () => {
  const { sess, wallet } = fresh({ lastTick: 0 });
  sess.playing = true;
  m.openPlay(sess, wallet);
  m.tick(sess, { now: 2000, eligible: true, duration: 105, wallet, renew: true });
  assert.equal(sess.playing, true);
  assert.ok(Math.abs(sess.spend_usd - 2 * m.USD_PER_SEC) < 1e-12);
  assert.ok(Math.abs(sess.escrow_usd - m.windowUsd()) < 1e-12, "runway topped back to 2s");
  conserved(sess, wallet);

  m.tick(sess, { now: 2500, eligible: true, duration: 105, wallet, renew: true });
  assert.ok(Math.abs(sess.spend_usd - 2.5 * m.USD_PER_SEC) < 1e-12);
  assert.ok(Math.abs(sess.escrow_usd - m.windowUsd()) < 1e-12);
  conserved(sess, wallet);
});

test("stale 20s heartbeat vests at most the open 2s hold, does not bill 10s, no rebate", () => {
  const { sess, wallet } = fresh({ lastTick: 0 });
  sess.playing = true;
  m.openPlay(sess, wallet);
  const held = sess.escrow_usd;
  m.tick(sess, { now: 20_000, eligible: true, duration: 105, wallet, renew: true });
  assert.equal(sess.playing, false);
  assert.equal(sess.stopReason.reason, "stale_hold");
  assert.ok(Math.abs(sess.spend_usd - held) < 1e-12, "crash pays the lock, not the gap");
  assert.equal(sess.escrow_usd, 0);
  assert.ok(sess.position < 1e-9, "playhead does not jump the dead gap");
  conserved(sess, wallet);
  const billedTok = m.usdToTok(held, "xpr");
  assert.ok(Math.abs(wallet.xpr - (SEED_XPR - billedTok)) < 1e-8);
});

test("CC / ineligible never holds or spends; position still advances", () => {
  const { sess, wallet } = fresh({ lastTick: 0, playing: true });
  m.tick(sess, { now: 5000, eligible: false, duration: 205, wallet, renew: true });
  assert.equal(sess.spend_usd, 0);
  assert.equal(sess.escrow_usd, 0);
  assert.equal(wallet.xpr, SEED_XPR);
  assert.ok(Math.abs(sess.position - 5) < 1e-9);
});

test("track end rebates leftover hold", () => {
  const { sess, wallet } = fresh({ lastTick: 0, playing: true, position: 104.5 });
  m.openPlay(sess, wallet);
  m.tick(sess, { now: 1000, eligible: true, duration: 105, wallet, renew: true });
  assert.equal(sess.playing, false);
  assert.equal(sess.escrow_usd, 0);
  const expectUsd = 0.5 * m.USD_PER_SEC;
  assert.ok(Math.abs(sess.spend_usd - expectUsd) < 1e-12);
  conserved(sess, wallet);
});

test("cannot start eligible play with empty wallet", () => {
  const { sess, wallet } = fresh();
  wallet.xpr = 0;
  assert.equal(m.openPlay(sess, wallet), false);
  assert.equal(sess.escrow_usd, 0);
});

test("dust wallet plays until hold runs out, then stops and rebates nothing useful", () => {
  const { sess, wallet } = fresh({ lastTick: 0, playing: true });
  // 0.4s of XPR at the peg — less than a 2s window.
  wallet.xpr = m.usdToTok(0.4 * m.USD_PER_SEC, "xpr");
  const seed = wallet.xpr;
  assert.equal(m.openPlay(sess, wallet), true);
  m.tick(sess, { now: 2000, eligible: true, duration: 105, wallet, renew: true });
  assert.equal(sess.playing, false);
  assert.equal(sess.stopReason.reason, "insufficient_balance");
  assert.ok(sess.position < 0.4 + 1e-9);
  conserved(sess, wallet, seed);
});

test("currency switch rebates old hold so xpr+usdc conservation holds", () => {
  const { sess, wallet } = fresh({ lastTick: 0, playing: true });
  m.openPlay(sess, wallet);
  m.tick(sess, { now: 500, eligible: true, duration: 105, wallet, renew: false });
  m.closePlay(sess, wallet);
  sess.currency = "usdc";
  assert.equal(m.openPlay(sess, wallet), true);
  assert.equal(sess.escrow_cur, "usdc");
  assert.ok(Math.abs(sess.escrow_usd - m.windowUsd()) < 1e-12);
  const xprOut = SEED_XPR - wallet.xpr;
  assert.ok(Math.abs(xprOut - (sess.spend.xpr || 0)) < 1e-8, "xpr only vested, hold rebated");
  const usdcHeld = m.usdToTok(sess.escrow_usd, "usdc");
  assert.ok(Math.abs(wallet.usdc + usdcHeld - 20) < 1e-8);
});

test("explicit pause after a 20s gap rebates the hold (stop is not a crash)", () => {
  const { sess, wallet } = fresh({ lastTick: 0 });
  sess.playing = true;
  m.openPlay(sess, wallet);
  m.tick(sess, { now: 20_000, eligible: true, duration: 105, wallet, renew: false });
  const rebated = m.closePlay(sess, wallet);
  sess.playing = false;
  assert.equal(sess.spend_usd, 0);
  assert.equal(sess.escrow_usd, 0);
  assert.ok(rebated === 0); // already rebated inside tick
  assert.equal(wallet.xpr, SEED_XPR);
  conserved(sess, wallet);
});

test("wallet-linked (actor) session with dust display copy keeps playing through shortfall", () => {
  const { sess, wallet } = fresh({ lastTick: 0, actor: "felixpaw", playing: true });
  m.openPlay(sess, wallet);
  // The liquid display copy is display-only for actors: a zero copy must
  // NOT stop playback. The chain piggy pays; the keeper classifies stops.
  wallet.usdc = 0;
  wallet.xpr = 0;
  m.tick(sess, { now: 2000, eligible: true, duration: 105, wallet, renew: true });
  assert.equal(sess.playing, true, "keeper classification is the only stop");
  assert.ok(sess.position > 0, "playhead still advances (wall-clock accrual)");
  m.tick(sess, { now: 4000, eligible: true, duration: 105, wallet, renew: true });
  assert.equal(sess.playing, true);
  assert.ok(sess.position > 1.5, "keeps advancing across ticks");
  assert.equal(sess.stopReason, null);
});

test("stale boundary: gap just under grace keeps playing, just over stops", () => {
  const limit = (m.WINDOW_S + m.STALE_GRACE_S) * 1000;
  // Inside grace (each tick measured from lastTick=0, single gap)
  const under = fresh({ lastTick: 0, playing: true });
  m.openPlay(under.sess, under.wallet);
  m.tick(under.sess, { now: limit - 500, eligible: true, duration: 205, wallet: under.wallet, renew: true });
  assert.equal(under.sess.playing, true, "inside grace: still playing");
  // Just over grace (independent session, same single gap)
  const over = fresh({ lastTick: 0, playing: true });
  m.openPlay(over.sess, over.wallet);
  m.tick(over.sess, { now: limit + 500, eligible: true, duration: 205, wallet: over.wallet, renew: true });
  assert.equal(over.sess.playing, false);
  assert.equal(over.sess.stopReason.reason, "stale_hold");
});

