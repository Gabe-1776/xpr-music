#!/usr/bin/env node
// pay-modes smoke — the automated gate for BOTH payment modes.
//
// Rewritten 2026-08-24: the previous version tested `startstream`/lock vesting,
// a design that no longer ships. It would have passed green while covering none
// of the live money paths.
//
// Every assertion here is a real transaction on real testnet state. The two
// that matter most:
//   * a pull must CROSS ACCOUNTS. A pull-payment contract is not tested until a
//     pull from a DIFFERENT account succeeds — self-payment passes even when
//     the authority is wrong (this exact hole shipped once in sigil-data).
//   * revocation and the deposit cap must BLOCK. A gate that only proves the
//     happy path proves nothing about safety.
//
// Restores all state on exit: leaving a grant or balance behind makes the live
// player double-charge, because the keeper routes on their presence.
// TESTNET ONLY. Never point this at mainnet.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { Api, JsonRpc, JsSignatureProvider } from "@proton/js";

const NAME = "ondastream";
const LISTENER = "felixpaw";
const ARTIST = "musictesting";
const KEEPER = "xprmusic";
const TESTNET_CHAIN_ID = "71ee83bcf52142d61019d95f9cc5427ba6a0d7ff8accd9e2088ae2abeaf3d3dd";
const XPR = { contract: "eosio.token", sym: "4,XPR" };

function loadEnv(p) {
  const out = {};
  for (const line of readFileSync(p, "utf8").split("\n")) {
    const s = line.trim();
    if (!s || s.startsWith("#") || !s.includes("=")) continue;
    const i = s.indexOf("=");
    out[s.slice(0, i)] = s.slice(i + 1).trim().replace(/^["']|["']$/g, "");
  }
  return out;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const err = (e) => String((e?.json?.error?.details?.[0]?.message) || e?.message || e)
  .replace(/PVT_[A-Za-z0-9_]+/g, "[REDACTED]").split("\n")[0].slice(0, 110);

const env = loadEnv(`${homedir()}/.openclaw/workspace/.env.xpr`);
if (env.XPR_NETWORK !== "testnet") { console.error("FATAL: not testnet"); process.exit(1); }
const w = JSON.parse(readFileSync(`${homedir()}/.xpr-testnet/wallets.json`, "utf8"));
const rpc = new JsonRpc(["https://test.proton.eosusa.io", "https://tn1.protonnz.com"], { fetch });
const info = await rpc.get_info();
if (info.chain_id !== TESTNET_CHAIN_ID) { console.error("FATAL: wrong chain"); process.exit(1); }

// A fresh Api per signing set — reusing one across different key sets fails
// silently with "does not have signatures for it".
const asListener = () => new Api({ rpc, signatureProvider: new JsSignatureProvider([env.XPR_PRIVATE_KEY]) });
const asKeeper = () => new Api({ rpc, signatureProvider: new JsSignatureProvider([w.accounts[KEEPER].private_key]) });
const send = (api, actions) => api.transact({ actions }, { blocksBehind: 3, expireSeconds: 60 });
const act = (account, name, actor, permission, data) =>
  ({ account, name, authorization: [{ actor, permission }], data });

const rows = async (table, limit = 20) =>
  (await rpc.get_table_rows({ json: true, code: NAME, scope: NAME, table, limit })).rows;
const balOf = async (a, c = "eosio.token", s = "XPR") =>
  Number(((await rpc.get_currency_balance(c, a, s))[0] || "0 XPR").split(" ")[0]);
const songId = async () => {
  const live = (await rows("songs", 300)).filter((r) => r.artist === ARTIST && r.active);
  if (!live.length) throw new Error(`no active ${ARTIST} songs on chain`);
  return live[0].songId;
};

let pass = 0, fail = 0;
const ok = (label, cond, detail = "") => {
  if (cond) { pass++; console.log(`  PASS  ${label}${detail ? "  " + detail : ""}`); }
  else { fail++; console.log(`  FAIL  ${label}${detail ? "  " + detail : ""}`); }
};
const mustThrow = async (label, fn, pattern) => {
  try { await fn(); ok(label, false, "expected rejection, got success"); }
  catch (e) { const m = err(e); ok(label, pattern.test(m), m); }
};

const SONG = await songId();
console.log(`pay-modes smoke — listener=${LISTENER} artist=${ARTIST} song=${SONG}\n`);

// ── cleanup helper, also run on exit ───────────────────────────────────────
async function cleanup(quiet) {
  try {
    if ((await rows("grants")).some((g) => g.listener === LISTENER))
      await send(asListener(), [act(NAME, "revoke", LISTENER, "active", { listener: LISTENER })]);
  } catch (e) { if (!quiet) console.log("  (cleanup revoke)", err(e)); }
  try {
    const acct = await rpc.get_account(LISTENER);
    const p = acct.permissions.find((x) => x.perm_name === "ondapull");
    if (p && (p.linked_actions || []).some((l) => l.account === "eosio.token" && l.action === "transfer"))
      await send(asListener(), [act("eosio", "unlinkauth", LISTENER, "active",
        { account: LISTENER, code: "eosio.token", type: "transfer" })]);
  } catch (e) { if (!quiet) console.log("  (cleanup unlink)", err(e)); }
  try {
    if ((await rows("balances")).some((b) => b.account === LISTENER))
      await send(asListener(), [act(NAME, "withdraw", LISTENER, "active", { listener: LISTENER, token: XPR })]);
  } catch (e) { if (!quiet) console.log("  (cleanup withdraw)", err(e)); }
}
await cleanup(true);
await sleep(2000);

// ── MODE A: top-up ─────────────────────────────────────────────────────────
console.log("MODE A — top-up (the consumer default)");
const rate = Number((await rows("tokrates")).find((r) => r.tokenContract === "eosio.token").perSec);
const windowSec = Number((await rows("config", 1))[0].windowSec);

await send(asListener(), [act("eosio.token", "transfer", LISTENER, "active",
  { from: LISTENER, to: NAME, quantity: "1.0000 XPR", memo: "onda" })]);
await sleep(3500);
let bal = (await rows("balances")).find((b) => b.account === LISTENER);
ok("deposit credits balance", bal && Number(bal.amount) === 10000, `amount=${bal?.amount}`);
ok("deposit sets a per-tick cap", bal && Number(bal.maxPerTick) === rate * windowSec * 8,
   `maxPerTick=${bal?.maxPerTick} (rate ${rate} x ${windowSec}s x 8)`);

const artist0 = await balOf(ARTIST);
await send(asKeeper(), [act(NAME, "pullbal", KEEPER, "active", { listener: LISTENER, songId: SONG, token: XPR })]);
await sleep(2000);
ok("first poke opens the 2s clock with no charge",
  Math.round(((await balOf(ARTIST)) - artist0) * 1e4) === 0, "artist should not move");

const artistBefore = await balOf(ARTIST);
await sleep(3500);
await send(asKeeper(), [act(NAME, "pullbal", KEEPER, "active", { listener: LISTENER, songId: SONG, token: XPR })]);
await sleep(3500);
const artistAfter = await balOf(ARTIST);
const due = rate * windowSec;
ok("second poke (full window) pays 2s", Math.round((artistAfter - artistBefore) * 1e4) === due,
   `+${(artistAfter - artistBefore).toFixed(4)} XPR, expected ${(due / 1e4).toFixed(4)}`);
bal = (await rows("balances")).find((b) => b.account === LISTENER);
ok("pullbal debits the balance", Number(bal.amount) === 10000 - due, `amount=${bal.amount}`);

// The cap is the whole reason a repricing key is safe on a server: a tick may
// never exceed what the deposit was made under.
//
// Deliberately exercised by LOWERING this listener's own cap rather than by
// inflating the global rate. Rewriting `tokrates` would race the live pricer
// (30s poll), which resets the rate mid-window and turns a correct BLOCK into
// a false FAIL. Same contract guard, no shared state, no flake.
await send(asListener(), [act(NAME, "setcap", LISTENER, "active",
  { listener: LISTENER, token: XPR, maxPerTick: 1 })]);
await sleep(3000);
await mustThrow("cap BLOCKS an over-large tick",
  () => send(asKeeper(), [act(NAME, "pullbal", KEEPER, "active", { listener: LISTENER, songId: SONG, token: XPR })]),
  /tick over cap/i);
await send(asListener(), [act(NAME, "setcap", LISTENER, "active",
  { listener: LISTENER, token: XPR, maxPerTick: rate * windowSec * 8 })]);
await sleep(3000);

await mustThrow("unpriced token is refused",
  () => send(asKeeper(), [act(NAME, "pullbal", KEEPER, "active",
    { listener: LISTENER, songId: SONG, token: { contract: "xtokens", sym: "4,FOOBAR" } })]),
  /token not payable/i);

// Late keeper: 8s of wall still only bills one 2s batch.
{
  await sleep(9000);
  const artistBefore = await balOf(ARTIST);
  await send(asKeeper(), [act(NAME, "pullbal", KEEPER, "active",
    { listener: LISTENER, songId: SONG, token: XPR })]);
  await sleep(3000);
  const paid = Math.round(((await balOf(ARTIST)) - artistBefore) * 1e4);
  ok("late poke bills at most one window", paid === rate * windowSec,
     `paid=${paid} want=${rate * windowSec}`);
}

const before = await balOf(LISTENER);
await send(asListener(), [act(NAME, "withdraw", LISTENER, "active", { listener: LISTENER, token: XPR })]);
await sleep(3500);
ok("withdraw returns the remainder", (await balOf(LISTENER)) > before,
   `+${((await balOf(LISTENER)) - before).toFixed(4)} XPR`);
ok("withdraw clears the row", !(await rows("balances")).some((b) => b.account === LISTENER));

// ── MODE B: direct from wallet ─────────────────────────────────────────────
console.log("\nMODE B — direct from wallet (power user)");
const acct = await rpc.get_account(LISTENER);
const linked = acct.permissions.flatMap((p) => (p.linked_actions || [])
  .filter((l) => l.account === "eosio.token" && l.action === "transfer").map(() => p.perm_name));
const grantActions = [];
for (const pn of linked) if (pn !== "ondapull")
  grantActions.push(act("eosio", "unlinkauth", LISTENER, "active",
    { account: LISTENER, code: "eosio.token", type: "transfer" }));
grantActions.push(act("eosio", "updateauth", LISTENER, "active", {
  account: LISTENER, permission: "ondapull", parent: "active",
  auth: { threshold: 1, keys: [], waits: [],
          accounts: [{ permission: { actor: NAME, permission: "eosio.code" }, weight: 1 }] } }));
if (!linked.includes("ondapull")) grantActions.push(act("eosio", "linkauth", LISTENER, "active",
  { account: LISTENER, code: "eosio.token", type: "transfer", requirement: "ondapull" }));
grantActions.push(act(NAME, "grant", LISTENER, "active", {
  listener: LISTENER, perm: "ondapull", token: XPR,
  maxPerTick: rate * windowSec * 4, budget: rate * windowSec * 50,
  expiresAt: Math.floor(Date.now() / 1000) + 3600 }));

// One signature activates it — that is the whole point of the mode.
await send(asListener(), grantActions);
await sleep(3500);
ok("one transaction activates the grant", (await rows("grants")).some((g) => g.listener === LISTENER));

const lOpen = await balOf(LISTENER), aOpen = await balOf(ARTIST);
await send(asKeeper(), [act(NAME, "pullpay", KEEPER, "active", { listener: LISTENER, songId: SONG })]);
await sleep(2000);
ok("grant first poke opens clock with no wallet pull",
  Math.round(((await balOf(LISTENER)) - lOpen) * 1e4) === 0, "listener should not move");

const lBefore = await balOf(LISTENER), aBefore = await balOf(ARTIST);
await sleep(3500);
await send(asKeeper(), [act(NAME, "pullpay", KEEPER, "active", { listener: LISTENER, songId: SONG })]);
await sleep(3500);
const lAfter = await balOf(LISTENER), aAfter = await balOf(ARTIST);
ok("pullpay CROSSES ACCOUNTS (listener -> artist)",
   Math.round((lBefore - lAfter) * 1e4) === due && Math.round((aAfter - aBefore) * 1e4) === due,
   `listener ${(lAfter - lBefore).toFixed(4)}, artist +${(aAfter - aBefore).toFixed(4)}`);

// unlinkauth must beat our own table: the user's revoke is the real backstop.
await send(asListener(), [act("eosio", "unlinkauth", LISTENER, "active",
  { account: LISTENER, code: "eosio.token", type: "transfer" })]);
await sleep(3000);
ok("grants row still present after unlinkauth", (await rows("grants")).some((g) => g.listener === LISTENER));
await mustThrow("revocation BLOCKS the pull anyway",
  () => send(asKeeper(), [act(NAME, "pullpay", KEEPER, "active", { listener: LISTENER, songId: SONG })]),
  /irrelevant authority|missing authority/i);

console.log("\ncleanup");
await cleanup(false);
await sleep(2500);
ok("no grant left behind", !(await rows("grants")).some((g) => g.listener === LISTENER));
ok("no balance left behind", !(await rows("balances")).some((b) => b.account === LISTENER));

console.log(`\n${fail === 0 ? "SMOKE PASS" : "SMOKE FAIL"} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
