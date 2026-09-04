# Onda — Security Audit Notes for External Human Reviewer

**Date:** 2026-09-04  
**Audit:** Pre-Public Security Code Review  
**Target Codebase:** `Gabe-1776/xpr-music` (`main`)  
**Live Testnet Service:** `https://music.project-testing.xyz` (Hetzner `<DEPLOY_HOST_IP>`)  
**Live Contract:** XPR Testnet `ondastream` (code hash `04bbeec5f65ce81e88fc1299431ae7a11f602b14a418ea69f8a1e25d97d828fb`)

---

## 1. Executive Summary

An automated, deep static analysis of `contracts/ondastream` and `app/` was completed prior to public handoff. Four high-value backend vulnerabilities were **immediately fixed, tested, and deployed live** (commit `4b106d5`). 

Four items (one authentication architecture constraint and three smart contract items) are intentionally documented below for your human code review and mainnet cutover decisions.

---

## 2. Remediated & Deployed Fixes (Verified Live)

| Issue ID | Severity | Description | Fix Implemented |
|---|---|---|---|
| **ONDA-API-001** | **Medium** | `POST /api/albums` took `owner` from `body.actor` without checking the `Authorization` header, allowing anyone to forge album records under any artist. | `app/server.js:2226` now derives `owner` strictly from the verified Bearer token (`auth.verifyToken`), matching the existing `PUT` and `DELETE` handlers. |
| **ONDA-API-002** | **Medium** | `POST /api/playlists` and mutation actions (`add`, `remove`, `delete`) only checked `actorGate(scope)` but omitted `writeGate(scope)`, allowing read-only delegated agents (`access.write == false`) to create or alter playlists. | `app/server.js:2110,2138` now enforces `actorGate(scope) \|\| writeGate(scope)`. |
| **ONDA-AUTH-003** | **Informational** | `ADMIN_PIN` checks across 15 routes in `app/server.js` used non-constant-time string comparison (`===`), susceptible to timing side-channels. | Replaced with `checkAdminPin(req)` using `crypto.timingSafeEqual` over length-validated buffers. |
| **ONDA-AUTH-002** | **Low** | `claimProofUse` in `app/auth.js` pruned half of the used proof hashes when the set exceeded 5,000 entries, allowing non-expiring IdentityProofs to be replayed after cache rollover. | Removed the 5,000-hash eviction limit (`app/auth.js:106`). Proof hashes are now retained permanently (~6MB for 100k hashes). |

---

## 3. Notes & Decisions for the Human Reviewer

### Item 1: `ONDA-AUTH-001` — IdentityProof Relay vs. `viaNonce` (Authentication Architecture)
- **Finding:** In `app/server.js:1424`, `/api/auth/verify-proof` verifies that the recovered public key from an `IdentityProof` satisfies the on-chain authority of the signer. However, the Proton Web SDK (`@proton/signing-request`) constructs `IdentityProof` with `expiration: 0` and without domain or challenge binding in the signed action (`account: "", name: "identity", data: { permission }`). As a result, a proof generated for any other Proton dApp could theoretically be submitted to `/api/auth/verify-proof` to mint a session token.
- **Current Mitigation:**
  1. Proofs are strictly single-use (`claimProofUse` burns the proof hash).
  2. The codebase **already contains** a secure challenge-response alternative: `/api/auth/nonce` + `/api/auth/verify` (`viaNonce` in `web/xpr-login.js`), which requires the wallet to sign an explicit contract action on `sigillogin::login` with a server-minted nonce.
- **Reviewer Action / Recommendation:** For mainnet, formally deprecate `/api/auth/verify-proof` and require all WebAuth sessions to authenticate exclusively via the `viaNonce` challenge-response flow.

---

### Item 2: `ONDA-CONTRACT-001` — Permissionless `settle()` on Legacy `locks` Table
- **Finding:** In `contracts/ondastream/assembly/ondastream.contract.ts:438`, `@action("settle") settle(listener: Name)` is permissionless and calls `accrueLock(lock, false)`, which calculates `due = vestPerSec * (now - lastVest)` using wall-clock time.
- **Context & Risk Assessment:** In Onda v2, streaming playback **does not use the `locks` table at all**. All playback billing uses either `balances` (Top Up mode via `pullbal`) or `grants` (Direct Wallet mode via `pullpay`). The `locks` table is empty legacy code from the v1 lock/buffer model.
- **Reviewer Action / Recommendation:** Remove the `settle` action and the `this.locks` table entirely from the contract prior to the mainnet deployment. (It was retained on testnet to preserve bytecode parity with the tested hash `04bbeec5…`).

---

### Item 3: `ONDA-CONTRACT-002` — 256-Row Scan Limit in `payoutClaimed()`
- **Finding:** In `contracts/ondastream/assembly/ondastream.contract.ts:984`, `payoutClaimed(account: Name)` scans `this.claimed` starting at `this.claimed.first()` and terminates after `CLAIM_SCAN_LIMIT = 256` rows.
- **Risk:** If the total number of claimed rows across all payees in the contract exceeds 256, payees whose row IDs sort past the 256th position will not be reached by a scan starting from `first()`.
- **Reviewer Action / Recommendation:** For mainnet, implement an account-scoped secondary index (`byAccount`) or pass a paging cursor (`last_id`) so payouts can paginate through claims without being bounded by a global 256-row table scan.

---

### Item 4: `ONDA-CONTRACT-003` — Unknown Transfer Memo Handling (Policy Decision H2)
- **Finding:** In `contracts/ondastream/assembly/ondastream.contract.ts:780`, `onTransfer` checks `if (memo == MEMO_PARK) ... if (!memo.startsWith(MEMO_SONG)) return;`.
- **Risk:** If a user transfers tokens to `@ondastream` with an unrecognized memo (e.g. `"deposit"` or a typo), the transaction succeeds on `eosio.token`, but the contract does not credit any balance table. The funds sit in `@ondastream`'s account without a balance entry.
- **Reviewer Action / Recommendation:** Decide between:
  1. **Revert (Recommended for Mainnet):** `check(false, "invalid memo: use 'onda' to deposit");` so transfers with bad memos fail atomically and tokens never leave the sender's wallet.
  2. **Refund:** Automatically dispatch an inline transfer back to the sender.
  3. **Admin Sweep:** Add a privileged `sweep` action allowing the contract owner to return misdirected funds.

---

## 4. Test & Build Status

- **Unit Tests:** `npm run test:meter` (11/11 PASS), `npm run test:pay-source` (5/5 PASS).
- **Live Auth & E2E:** `test/verify-auth.mjs` (15/15 PASS).
- **Testnet Contract Bytecode:** Local AssemblyScript build matches live on-chain `get_code_hash` (`04bbeec5…`).
