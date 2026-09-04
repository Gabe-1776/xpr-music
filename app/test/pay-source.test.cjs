#!/usr/bin/env node
"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { pickMode, normalizePaySource } = require("../onda-pulse");

const both = {
  grant: { kind: "grant", token: { contract: "eosio.token", sym: "4,XPR" } },
  balance: { kind: "balance", token: { contract: "eosio.token", sym: "4,XPR" }, maxPerTick: 1, perSec: 1 },
};
const grantOnly = { grant: both.grant, balance: null };
const balanceOnly = { grant: null, balance: both.balance };

test("missing pay source is topup", () => {
  assert.equal(normalizePaySource(undefined), "topup");
  assert.equal(normalizePaySource("topup"), "topup");
  assert.equal(normalizePaySource("wallet"), "wallet");
  assert.equal(normalizePaySource("nope"), "topup");
});

test("topup uses parked balance even when a grant exists", () => {
  assert.equal(pickMode(both, "topup").kind, "balance");
  assert.equal(pickMode(both, undefined).kind, "balance");
  assert.equal(pickMode(both, "wallet").kind, "grant");
});

test("topup does not fall through to a leftover grant", () => {
  assert.equal(pickMode(grantOnly, "topup"), null);
  assert.equal(pickMode(grantOnly, "wallet").kind, "grant");
});

test("wallet does not fall through to parked funds", () => {
  assert.equal(pickMode(balanceOnly, "wallet"), null);
  assert.equal(pickMode(balanceOnly, "topup").kind, "balance");
});

test("no entry is unfunded", () => {
  assert.equal(pickMode(null, "topup"), null);
  assert.equal(pickMode(null, "wallet"), null);
});
