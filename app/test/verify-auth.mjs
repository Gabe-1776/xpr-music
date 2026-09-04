#!/usr/bin/env node
/**
 * End-to-end wallet-auth verification against the LOCAL server.
 *
 * Constructs a REAL XPR testnet IdentityProof for an account whose private
 * key lives in the existing testnet wallet store (~/.xpr-testnet/wallets.json
 * — the same store MailSigil's fleet uses; the key is read at runtime, never
 * embedded or logged), signs it, posts it to /api/auth/verify-proof, then
 * exercises account-scoped favorites/playlists with the returned token.
 *
 * Usage: node test/verify-auth.mjs [account]   (default: vulcanwallet)
 */
"use strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

const ACCOUNT = process.argv[2] || "vulcanwallet";
const BASE = process.env.BASE_URL || "http://127.0.0.1:8788";
const CHAIN_ID = "71ee83bcf52142d61019d95f9cc5427ba6a0d7ff8accd9e2088ae2abeaf3d3dd";

// The signing-request lib's root entry is broken under Node ESM (CJS-style
// require in a type:module file) — use the real .m.js ESM bundle, as
// MailSigil's identity-proof.ts does. PrivateKey/Transaction/Action come
// from @greymass/eosio (the underlying crypto lib @proton/js re-exports
// Key from).
const { IdentityProof, IdentityV3 } = await import("@proton/signing-request/lib/proton-signing-request.m.js");
const { PrivateKey } = await import("@greymass/eosio");

function loadPrivateKey(account) {
  const store = JSON.parse(
    fs.readFileSync(path.join(os.homedir(), ".xpr-testnet", "wallets.json"), "utf8"),
  );
  const entry = store.accounts?.[account];
  if (!entry?.private_key) throw new Error(`no testnet key for ${account} in ~/.xpr-testnet/wallets.json`);
  return entry.private_key;
}

async function buildProof(account, privateKeyString) {
  // The IdentityProof's canonical transaction (what recover() verifies
  // against) is: { ref_block_num: 0, ref_block_prefix: 0, expiration,
  // signer, actions: [identity action] }. A future expiration makes the
  // digest unique per run (the server's anti-replay store retains used
  // proofs) — the real wallet varies the resolved transaction the same way.
  // Expiration is second-granularity, so back-to-back runs within the same
  // wall-second would produce an identical digest (a genuine replay); space
  // generation so each run lands in a fresh second, like a real human-paced
  // wallet login.
  await new Promise((resolve) => setTimeout(resolve, 1100));
  const { Transaction, Action } = await import("@greymass/eosio");
  const signer = { actor: account, permission: "active" };
  const expiration = new Date(Date.now() + 5 * 60 * 1000);
  const tx = Transaction.from({
    ref_block_num: 0,
    ref_block_prefix: 0,
    expiration,
    actions: [
      Action.from({
        account: "",
        name: "identity",
        authorization: [signer],
        data: IdentityV3.from({ permission: signer }),
      }),
    ],
  });
  const privateKey = PrivateKey.fromString(privateKeyString);
  const signature = privateKey.signDigest(tx.signingDigest(CHAIN_ID));
  const proof = IdentityProof.from({
    chainId: CHAIN_ID,
    expiration,
    signer,
    signature: signature.toString(),
  });
  return proof.toString(); // "EOSIO <base64>"
}

async function api(pathname, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(`${BASE}${pathname}`, {
    method: options.method || "GET",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(`${pathname} -> ${res.status}: ${data.error || res.statusText}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

const steps = [];
const check = (name, ok, detail = "") => {
  steps.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) process.exitCode = 1;
};

// 1. Replay protection: same proof twice → second must be rejected.
const proof = await buildProof(ACCOUNT, loadPrivateKey(ACCOUNT));
const first = await api("/api/auth/verify-proof", { method: "POST", body: { proof } });
check("verify-proof accepts a fresh signed proof", Boolean(first.token && first.actor === ACCOUNT), `actor=${first.actor}`);
let replayRejected = false;
try {
  await api("/api/auth/verify-proof", { method: "POST", body: { proof } });
} catch (e) {
  replayRejected = e.status === 401;
}
check("replaying the same proof is rejected (401)", replayRejected);

// 2. Token is valid for /api/auth/me.
const me = await api("/api/auth/me", { headers: { Authorization: `Bearer ${first.token}` } });
check("session token authenticates /api/auth/me", me.actor === ACCOUNT && me.authenticated === true, `actor=${me.actor}`);

// 2b. WebAuth fallback: signed-but-not-broadcast sigillogin::login.
const { Api, JsonRpc, JsSignatureProvider } = await import("@proton/js");
const rpc = new JsonRpc(["https://test.proton.eosusa.io", "https://rpc.api.testnet.metalx.com"]);
const nonceRes = await api("/api/auth/nonce", { method: "POST", body: {} });
check("nonce endpoint issues a challenge", Boolean(nonceRes.challengeId && nonceRes.nonce));
const signApi = new Api({
  rpc,
  signatureProvider: new JsSignatureProvider([loadPrivateKey(ACCOUNT)]),
});
const signed = await signApi.transact(
  {
    actions: [{
      account: "sigillogin",
      name: "login",
      authorization: [{ actor: ACCOUNT, permission: "active" }],
      data: { account: ACCOUNT, nonce: nonceRes.nonce },
    }],
  },
  { blocksBehind: 3, expireSeconds: 120, broadcast: false, sign: true },
);
const serializedTransaction = Buffer.from(signed.serializedTransaction).toString("hex");
const nonceBody = {
  challengeId: nonceRes.challengeId,
  actor: ACCOUNT,
  permission: "active",
  signatures: signed.signatures,
  serializedTransaction,
};
const nonceLogin = await api("/api/auth/verify", { method: "POST", body: nonceBody });
check("nonce signed-login mints a token", Boolean(nonceLogin.token && nonceLogin.actor === ACCOUNT), `actor=${nonceLogin.actor}`);
const nonceMe = await api("/api/auth/me", { headers: { Authorization: `Bearer ${nonceLogin.token}` } });
check("nonce session authenticates /api/auth/me", nonceMe.actor === ACCOUNT);
let nonceReplay = false;
try {
  await api("/api/auth/verify", { method: "POST", body: nonceBody });
} catch (e) {
  nonceReplay = e.status === 401;
}
check("replaying the signed login is rejected (401)", nonceReplay);

// Live catalog id — hardcoded ids rot when the catalog changes
// (signal-bloom was removed; 400 "bad song" is the server validating).
const catalog = await api("/api/catalog");
const liveSongId = (catalog.songs || catalog.tracks || catalog)[0].id;

// 3. No token → 401.
let meRejected = false;
try {
  await api("/api/auth/me");
} catch (e) {
  meRejected = e.status === 401;
}
check("unauthenticated /api/auth/me is 401", meRejected);

// 3b. Playback gate: guests may browse/library but NOT play; wallet
//     sessions may play.
const guestSession = await api("/api/session", { method: "POST", body: {} });
const guestHeaders = { "X-Session-Id": guestSession.session_id };
let guestPlayRejected = false;
try {
  await api("/api/session/play", { method: "POST", body: { song_id: liveSongId, position: 0 }, headers: guestHeaders });
} catch (e) {
  guestPlayRejected = e.status === 401 && /wallet login required/.test(e.message);
}
check("guest playback is rejected (401, wallet login required)", guestPlayRejected);
const guestBrowse = await api("/api/library", { headers: guestHeaders });
check("guest can still browse library", Array.isArray(guestBrowse.saved));

// 4. Account-scoped favorites: save under token, verify listed, verify
//    isolated from an anonymous session.
const authHeaders = { Authorization: `Bearer ${first.token}` };
if (process.env.DUMP_TOKEN) {
  const { writeFileSync } = await import("node:fs");
  writeFileSync("/tmp/onda-test-token.json", JSON.stringify({ token: first.token, actor: first.actor }));
  console.log("(token dumped to /tmp/onda-test-token.json)");
}
await api("/api/library/save", { method: "POST", body: { song_id: liveSongId }, headers: authHeaders });
const accountLib = await api("/api/library", { headers: authHeaders });
const accountSaved = (accountLib.saved || []).map((s) => s.id);
check("account-scoped library persists", accountSaved.includes(liveSongId), `saved=${accountSaved.join(",") || "(empty)"}`);

const guestLib = await api("/api/library", { headers: guestHeaders });
const guestSaved = (guestLib.saved || []).map((s) => s.id);
check("guest library is isolated from account favorites", !guestSaved.includes(liveSongId), `guest=${guestSaved.join(",") || "(empty)"}`);

// 4b. Wallet session CAN start playback.
const walletPlay = await api("/api/session/play", {
  method: "POST",
  body: { song_id: liveSongId, position: 0 },
  headers: { ...guestHeaders, ...authHeaders },
});
check("wallet session can play", walletPlay.playing === true && walletPlay.song?.id === liveSongId, `song=${walletPlay.song?.id}`);

// 5. Account-scoped playlist: create + add song + read back.
const playlist = await api("/api/playlists", {
  method: "POST",
  body: { name: `Auth E2E ${Date.now() % 100000}` },
  headers: authHeaders,
});
const playlistId = playlist.playlist.id;
await api(`/api/playlists/${playlistId}/add`, { method: "POST", body: { song_id: liveSongId }, headers: authHeaders });
const playlistDetail = await api(`/api/playlists/${playlistId}`, { headers: authHeaders });
check(
  "account-scoped playlist persists with song",
  playlistDetail.playlist.song_ids.includes(liveSongId) && playlistDetail.playlist.songs.length === 1,
  `song_ids=${playlistDetail.playlist.song_ids.join(",")}`,
);

// 6. Cleanup: remove favorite + delete playlist so the account store is tidy.
await api("/api/library/remove", { method: "POST", body: { song_id: liveSongId }, headers: authHeaders });
await api(`/api/playlists/${playlistId}/delete`, { method: "POST", body: {}, headers: authHeaders });
check("cleanup removed test favorite and playlist", true);

console.log("\n" + (process.exitCode ? "AUTH E2E FAILED" : "AUTH E2E PASSED"));
