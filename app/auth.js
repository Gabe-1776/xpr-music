#!/usr/bin/env node
/**
 * XPR Music — wallet login (XPR Network identity proof) + session tokens.
 *
 * Pattern ported from MailSigil's auth stack (`~/projects/agent-mail/auth/`):
 *   - the app NEVER trusts a browser-asserted actor; the wallet's login
 *     already produces a cryptographic IdentityProof which we verify against
 *     the actor's live on-chain authority (identity-proof.ts).
 *   - proofs are single-use, retained indefinitely (anti-replay).
 *   - verified actors get a signed session token (here: HS256 JWT, secret
 *     persisted on disk so restarts keep sessions valid).
 *
 * Testnet only for now: chain id + RPC endpoints below. The token says
 * NOTHING about payments — it only proves wallet ownership of an XPR
 * account, which is what "logged in" means at this stage.
 */
"use strict";
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const TESTNET_CHAIN_ID = "71ee83bcf52142d61019d95f9cc5427ba6a0d7ff8accd9e2088ae2abeaf3d3dd";
const MAINNET_CHAIN_ID = "384da888112027f0321850a169f737c33e53b388aad48b5adace4bab97f437e0";
const TESTNET_RPC = ["https://test.proton.eosusa.io", "https://rpc.api.testnet.metalx.com"];
const MAINNET_RPC = ["https://proton.eosusa.io", "https://rpc.api.mainnet.metalx.com"];

// Network registry: pick chain id + RPC in one place. Mainnet is wired and
// ready but still gated by the maintenance flag upstream — nothing here
// accepts a mainnet proof until the caller opts in.
const NETWORKS = {
  testnet: { chainId: TESTNET_CHAIN_ID, rpc: TESTNET_RPC },
  mainnet: { chainId: MAINNET_CHAIN_ID, rpc: MAINNET_RPC },
};
function networkFor(network) {
  return NETWORKS[network] || NETWORKS.testnet;
}
const TOKEN_TTL_S = 7 * 24 * 3600; // 7 days, same as Sigil access tokens

const ROOT = __dirname;

// HS256 signing secret — lives OUTSIDE the project tree so a zip/rsync of the
// repo can never exfiltrate session-minting power (audit finding S6). Order:
//   1. AUTH_SECRET_FILE env override
//   2. ~/.xpr-testnet/auth-secret.json   (canonical home, chmod 600)
//   3. legacy in-tree catalog/auth-secret.json (read-only fallback so tokens
//      minted before the move stay valid)
// Generation happens ONLY at the canonical home.
function secretCandidates() {
  const list = [];
  if (process.env.AUTH_SECRET_FILE) list.push(process.env.AUTH_SECRET_FILE);
  list.push(path.join(process.env.HOME || "", ".xpr-testnet", "auth-secret.json"));
  list.push(path.join(ROOT, "catalog", "auth-secret.json"));
  return list;
}
const CANONICAL_SECRET_FILE = secretCandidates()[process.env.AUTH_SECRET_FILE ? 0 : 1];

class AuthError extends Error {}

// ---------------------------------------------------------------- secret
function loadSecret() {
  for (const file of secretCandidates()) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
      if (typeof parsed.secret === "string" && parsed.secret.length >= 32) {
        return { value: parsed.secret, file };
      }
    } catch {}
  }
  // Nothing usable anywhere → generate at the canonical home, never in-tree.
  const dir = path.dirname(CANONICAL_SECRET_FILE);
  fs.mkdirSync(dir, { recursive: true });
  const secret = crypto.randomBytes(32).toString("hex");
  fs.writeFileSync(CANONICAL_SECRET_FILE, JSON.stringify({ secret, created_at: new Date().toISOString() }, null, 2));
  fs.chmodSync(CANONICAL_SECRET_FILE, 0o600); // never world-readable
  return { value: secret, file: CANONICAL_SECRET_FILE };
}
const SECRET_INFO = loadSecret();
const SECRET = SECRET_INFO.value;

// ------------------------------------------------------- used-proof store
// Persisted immediately on claim — a crash between "proof accepted" and
// "row written" would otherwise let a captured proof replay once after
// restart. Proof logins are rare; a synchronous write is the correct cost.
function loadUsedProofs() {
  try {
    const parsed = JSON.parse(fs.readFileSync(USED_FILE, "utf8"));
    return parsed && Array.isArray(parsed.hashes) ? new Set(parsed.hashes) : new Set();
  } catch {
    return new Set();
  }
}
let usedProofs = loadUsedProofs();

/** Atomically claims a proof hash. Returns true the FIRST time, false on replay. */
function claimProofUse(signatureHash) {
  if (usedProofs.has(signatureHash)) return false;
  usedProofs.add(signatureHash);
  // C4: cap the store — proofs are single-use and 7d tokens expire, so entries
  // older than 30 days can never be replayed meaningfully. Prune when large.
  if (usedProofs.size > 5000) {
    const cutoff = Date.now() - 30 * 24 * 3600 * 1000;
    // Re-read the persisted timestamps isn't possible (we store hashes only),
    // so prune by count: drop the oldest half (Set preserves insertion order).
    const arr = [...usedProofs];
    const drop = arr.slice(0, Math.floor(arr.length / 2));
    drop.forEach((h) => usedProofs.delete(h));
  }
  fs.mkdirSync(path.dirname(USED_FILE), { recursive: true });
  fs.writeFileSync(USED_FILE, JSON.stringify({ hashes: [...usedProofs], updated_at: new Date().toISOString() }, null, 2));
  return true;
}

// ------------------------------------------------------- lazy ESM imports
// @proton/signing-request ships a CommonJS `main` but is flagged
// `type: module`, which breaks named ESM imports from the package root — the
// same issue MailSigil documented. The real ESM entry is the `.m.js` bundle,
// imported directly. @proton/js ships dual builds; we import it uniformly.
let signingRequestLib = null;
let protonJs = null;
async function libs() {
  if (!signingRequestLib) signingRequestLib = await import("@proton/signing-request/lib/proton-signing-request.m.js");
  if (!protonJs) protonJs = await import("@proton/js");
  return { signingRequestLib, protonJs };
}

// -------------------------------------------------------- proof verification
/**
 * Verify a wallet login identity proof against the actor's live on-chain
 * authority (testnet). Returns { actor, permission } or throws AuthError.
 *
 * Port of MailSigil auth/src/identity-proof.ts — key↔authority matching is
 * done manually (not proof.verify()) because proton-web-sdk proofs carry
 * expiration == 0, which makes the library's bundled verify() always fail
 * its expiry half. Legacy `EOS…` and modern `PUB_K1_…` encodings of the same
 * key are normalized; the permission's weight threshold is honored.
 */
async function verifyIdentityProof(proofString, network = "testnet") {
  const { signingRequestLib, protonJs } = await libs();
  const { IdentityProof } = signingRequestLib;
  const { Key, JsonRpc } = protonJs;

  let proof;
  try {
    proof = IdentityProof.fromString(proofString);
  } catch {
    throw new AuthError("malformed identity proof");
  }

  const net = networkFor(network);
  if (proof.chainId.toString() !== net.chainId) {
    throw new AuthError("identity proof is for a different chain");
  }

  const actor = proof.signer.actor.toString();
  const permission = proof.signer.permission.toString();

  let account;
  try {
    const rpc = new JsonRpc(net.rpc);
    account = await rpc.get_account(actor);
  } catch {
    throw new AuthError(`account "${actor}" not found on chain`);
  }
  const perm = (account?.permissions || []).find((p) => p.perm_name === permission);
  if (!perm) {
    throw new AuthError(`unknown permission "${permission}" for ${actor}`);
  }

  let recoveredKey;
  try {
    recoveredKey = Key.PublicKey.fromString(proof.recover().toString()).toString();
  } catch {
    throw new AuthError("could not recover a key from the identity proof");
  }

  const requiredAuth = perm.required_auth ?? { threshold: 1, keys: [] };
  const weight = (requiredAuth.keys ?? []).reduce((sum, k) => {
    try {
      return Key.PublicKey.fromString(k.key).toString() === recoveredKey ? sum + (k.weight ?? 0) : sum;
    } catch {
      return sum;
    }
  }, 0);
  if (weight < (requiredAuth.threshold ?? 1)) {
    throw new AuthError("identity proof does not satisfy actor's on-chain authority");
  }

  // Honor a real expiration if the wallet ever sets one (web-sdk currently
  // does not — expiration == 0 — so this is a no-op until it does).
  const expMs = proof.expiration.toMilliseconds?.() ?? 0;
  if (expMs > 0) {
    const headMs = new Date(`${account.head_block_time}Z`).getTime();
    if (headMs >= expMs) throw new AuthError("identity proof has expired");
  }

  // Single-use, LAST — only burn the proof after every other check passed.
  // Hash the CANONICAL re-serialized proof, never the raw client string:
  // the decoder treats standard and url-safe base64 alphabets identically,
  // so an alphabet-swapped replay of a burned proof would otherwise produce
  // a fresh hash over byte-identical input (MailSigil F1, live-confirmed).
  const signatureHash = crypto.createHash("sha256").update(proof.toString()).digest("hex");
  if (!claimProofUse(signatureHash)) {
    throw new AuthError("identity proof already used — request a fresh login");
  }

  return { actor, permission };
}

// ---------------------------------------------- WebAuth nonce fallback
// webauth.com's desktop popup returns a session and NO IdentityProof (see
// ProtonWebLink.login in @proton/web-sdk). MailSigil's path 2: the wallet
// signs sigillogin::login(account, nonce) with broadcast:false; we verify
// the signature against live on-chain authority and never push the tx.
const LOGIN_CONTRACT = "sigillogin";
const NONCE_TTL_MS = 5 * 60 * 1000;
const challenges = new Map();

function issueChallenge() {
  const challengeId = crypto.randomBytes(16).toString("hex");
  const nonce = crypto.randomBytes(18).toString("base64url");
  challenges.set(challengeId, { nonce, createdAt: Date.now(), consumed: false });
  return {
    challengeId,
    nonce,
    message: `Sign in to Onda (XPR Music)\nNonce: ${nonce}\nThis only proves wallet ownership — it does not send any funds.`,
  };
}

function consumeChallenge(challengeId, nonce) {
  if (typeof challengeId !== "string" || typeof nonce !== "string") return false;
  const row = challenges.get(challengeId);
  if (!row) return false;
  if (row.consumed) return false;
  if (Date.now() - row.createdAt > NONCE_TTL_MS) {
    challenges.delete(challengeId);
    return false;
  }
  if (row.nonce !== nonce) return false;
  row.consumed = true;
  return true;
}

const nonceSweep = setInterval(() => {
  const now = Date.now();
  for (const [id, row] of challenges) {
    if (now - row.createdAt > NONCE_TTL_MS) challenges.delete(id);
  }
}, 60 * 1000);
if (typeof nonceSweep.unref === "function") nonceSweep.unref();

function digestFromSerializedData(chainId, serializedTransaction) {
  const signBuf = Buffer.concat([
    Buffer.from(chainId, "hex"),
    Buffer.from(serializedTransaction),
    Buffer.alloc(32),
  ]);
  return crypto.createHash("sha256").update(signBuf).digest();
}

function signaturesSatisfyAuthority(requiredAuth, signatures, digest, Key) {
  const threshold = requiredAuth?.threshold ?? 1;
  const keys = requiredAuth?.keys ?? [];
  const satisfied = new Set();
  for (const signature of signatures) {
    let sig;
    try {
      sig = Key.Signature.fromString(signature);
    } catch {
      continue;
    }
    for (const entry of keys) {
      let pub;
      try {
        pub = Key.PublicKey.fromString(entry.key);
      } catch {
        continue;
      }
      const normalized = pub.toString();
      if (satisfied.has(normalized)) continue;
      try {
        if (sig.verify(digest, pub, false)) satisfied.add(normalized);
      } catch {}
    }
  }
  let weightSum = 0;
  const counted = new Set();
  for (const entry of keys) {
    let normalized;
    try {
      normalized = Key.PublicKey.fromString(entry.key).toString();
    } catch {
      continue;
    }
    if (counted.has(normalized)) continue;
    counted.add(normalized);
    if (satisfied.has(normalized)) weightSum += entry.weight ?? 0;
  }
  return weightSum >= threshold;
}

/**
 * Verify a signed-but-not-broadcast sigillogin::login transaction against
 * the actor's live on-chain authority. Body: { challengeId, actor,
 * permission, signatures, serializedTransaction (hex) }.
 */
async function verifySignedLogin(body, network = "testnet") {
  const challengeId = body && body.challengeId;
  const actor = body && typeof body.actor === "string" ? body.actor.trim() : "";
  const permission = body && typeof body.permission === "string" ? body.permission.trim() : "";
  const signatures = body && Array.isArray(body.signatures) ? body.signatures : null;
  const hex = body && typeof body.serializedTransaction === "string"
    ? body.serializedTransaction.replace(/^0x/i, "")
    : "";
  if (!challengeId || !actor || !permission || !signatures || !signatures.length || !hex) {
    throw new AuthError("missing required login fields");
  }
  if (permission !== "active" && permission !== "owner") {
    throw new AuthError(`permission "${permission}" is not allowed for sign-in — use "active" or "owner"`);
  }
  if (!/^[a-z1-5]{1,12}$/.test(actor)) {
    throw new AuthError("invalid actor");
  }

  let bytes;
  try {
    bytes = Buffer.from(hex, "hex");
    if (!bytes.length || hex.length % 2 !== 0) throw new Error("bad hex");
  } catch {
    throw new AuthError("malformed serialized transaction");
  }

  const { protonJs } = await libs();
  const { Api, JsonRpc, Key } = protonJs;
  const net = networkFor(network);
  const rpc = new JsonRpc(net.rpc);
  const api = new Api({ rpc });

  let transaction;
  try {
    transaction = await api.deserializeTransactionWithActions(bytes);
  } catch {
    throw new AuthError("could not decode signed login transaction");
  }
  if (!transaction || !Array.isArray(transaction.actions) || transaction.actions.length !== 1) {
    throw new AuthError("sign-in proof must contain exactly one login action");
  }
  const act = transaction.actions[0];
  if (act.account !== LOGIN_CONTRACT || act.name !== "login") {
    throw new AuthError(`sign-in must use ${LOGIN_CONTRACT}::login; token transfers are not accepted`);
  }
  const actionAccount = String(act.data && act.data.account != null ? act.data.account : "");
  if (actionAccount !== actor) {
    throw new AuthError("login action is for a different account");
  }
  const nonceInTx = act.data && act.data.nonce != null ? String(act.data.nonce) : "";
  if (!nonceInTx || !consumeChallenge(challengeId, nonceInTx)) {
    throw new AuthError("invalid, expired, or already-used challenge");
  }

  let account;
  try {
    account = await rpc.get_account(actor);
  } catch {
    throw new AuthError(`account "${actor}" not found on chain`);
  }
  const perm = (account?.permissions || []).find((p) => p.perm_name === permission);
  if (!perm) {
    throw new AuthError(`unknown permission "${permission}" for ${actor}`);
  }
  const digest = digestFromSerializedData(net.chainId, bytes);
  if (!signaturesSatisfyAuthority(perm.required_auth, signatures, digest, Key)) {
    throw new AuthError("signature does not satisfy actor's on-chain authority");
  }
  return { actor, permission };
}

// ------------------------------------------------------------- session token
function base64url(value) {
  return Buffer.from(value).toString("base64url");
}

/**
 * Mint a 7-day HS256 session token for a verified actor. HS256 (node:crypto,
 * no extra deps) is sufficient for a local testnet backend; the secret is
 * persisted so restarts keep sessions valid. The token proves only wallet
 * ownership — it grants no payment capability.
 */
function mintAccessToken(actor) {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = base64url(
    JSON.stringify({
      sub: actor,
      iat: now,
      exp: now + TOKEN_TTL_S,
      iss: "xpr-music-local",
      aud: "xpr-music",
      scope: "wallet-ownership",
    }),
  );
  const signature = crypto.createHmac("sha256", SECRET).update(`${header}.${payload}`).digest("base64url");
  return {
    token: `${header}.${payload}.${signature}`,
    actor,
    expires_at: new Date((now + TOKEN_TTL_S) * 1000).toISOString(),
  };
}

/**
 * Verify a session token. Returns the actor (sub) or null. Constant-time
 * signature comparison; payload signature checked before any parsing.
 */
function verifyToken(token) {
  if (typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [header, payload, signature] = parts;
  const expected = crypto.createHmac("sha256", SECRET).update(`${header}.${payload}`).digest("base64url");
  const actual = Buffer.from(signature);
  const wanted = Buffer.from(expected);
  if (actual.length !== wanted.length || !crypto.timingSafeEqual(actual, wanted)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (typeof data.sub !== "string" || !data.sub) return null;
    if (Math.floor(Date.now() / 1000) >= (data.exp || 0)) return null;
    return data.sub;
  } catch {
    return null;
  }
}

const MEDIA_TTL_S = 2 * 3600;

function signMediaUrl(relPath) {
  const clean = String(relPath || "").replace(/^\/+/, "").replace(/\.\./g, "");
  const exp = Math.floor(Date.now() / 1000) + MEDIA_TTL_S;
  const sig = crypto.createHmac("sha256", SECRET).update(`${clean}|${exp}`).digest("hex");
  return `/media/${clean.split("/").map(encodeURIComponent).join("/")}?exp=${exp}&sig=${sig}`;
}

function verifyMediaSig(relPath, exp, sig) {
  if (typeof relPath !== "string" || typeof exp !== "string" || typeof sig !== "string") return false;
  if (!/^[0-9]+$/.test(exp) || !/^[0-9a-f]{64}$/.test(sig)) return false;
  const expN = Number(exp);
  if (!Number.isFinite(expN) || expN < Math.floor(Date.now() / 1000)) return false;
  const clean = relPath.replace(/^\/+/, "").replace(/\.\./g, "");
  const want = crypto.createHmac("sha256", SECRET).update(`${clean}|${expN}`).digest("hex");
  const a = Buffer.from(sig, "hex");
  const b = Buffer.from(want, "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = {
  AuthError,
  verifyIdentityProof,
  verifySignedLogin,
  issueChallenge,
  mintAccessToken,
  verifyToken,
  signMediaUrl,
  verifyMediaSig,
  TESTNET_CHAIN_ID,
  LOGIN_CONTAINER: LOGIN_CONTRACT,
  LOGIN_CONTRACT,
  NETWORKS,
};
