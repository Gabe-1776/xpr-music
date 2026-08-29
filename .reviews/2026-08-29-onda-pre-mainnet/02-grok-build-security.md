# Grok Build — code + security review (report-only)

**When:** 2026-08-29  
**Seat:** grok-build · **author_family:** xai  
**invert:** yes vs Claude-authored `ondastream` money path (anthropic). If this dossier is treated as Grok-authored, next authoritative pass must be **openai or anthropic**, not Grok.  
**picker:** `bash ~/bin/pick-cross-model-reviewer.sh grok-build` → preferred openai (Vulcan-Review / gpt-5.6-sol), alternate Claude  
**Scope:** current disk at `~/Developer/xpr-music/` (not a git repo)  
**Did not:** implement fixes, setcode, rsync, or flip `payments_enabled` / `mainnet_maintenance`  
**Verify run:** `cd app && npm run test:meter` → **10/10 pass** (JSON hold/rebate only)

House rules applied: `production-security-default.md` · reviewers report-only · no secret values (path:line + kind only).

---

## 0. What I actually read

| Layer | Path | Lines / notes |
|---|---|---|
| Contract source | `contracts/ondastream/assembly/ondastream.contract.ts` | 1026 · sha256 `5aab5b0f…ad01e1` |
| Built wasm on disk | `assembly/target/ondastream.contract.wasm` | sha256 `86bb9d28…690fe5` |
| README (stale) | `contracts/ondastream/README.md` | still lists wasm `fd882d4a…` and “XPR+XUSDC only” |
| Prior audit | `REVIEW-PACKAGE.md` | 2026-08-26; S1–S4/S6 marked fixed; S5/S7 open |
| Elapsed-charge proposal | `FIXPROP-elapsed-charge.md` | **source now contains** `playedSec` + `MAX_CATCHUP_SEC=16` |
| App | `server.js` 2644, `auth.js` 443, `onda-pulse.js` 361, `onda-pricing.js` | |
| Clients | `web/desktop.html`, `mobile.html`, `xpr-login.js` | |

**LIVE vs LOCAL — measured 2026-08-29 after Gabriel asked.** Right *project* (`xpr-music` → `https://music.project-testing.xyz` → Hetzner `167.233.60.62:/opt/xpr-music`). Not the right *contract/keeper revision*.

| Piece | Live (production testnet) | Local Mac tree I reviewed |
|---|---|---|
| `server.js` | sha256 `6ab33678…` | **same** |
| `auth.js` | `b57185c5…` | **same** |
| `web/desktop.html` | `9aa65ab3…` | **same** |
| `onda-pulse.js` | `7d96be20…` 2026-08-24, **no** `playedSec` | `f0db60ea…` **has** `playedSec` (not on the box) |
| `ondastream` wasm | on-chain `code_hash` **`5f60a2ee1e43fec5…f1b0`** | disk wasm `86bb9d28…` **not deployed** |
| `pullbal` ABI | `listener, songId, token` | local adds **`playedSec`** |

Live site probes: `payments_enabled: false`, `mainnet_maintenance: true`, 34 songs, anon POST `/api/submissions` → 401, desktop has `safeCoverUrl`. Config owner on-chain: `ondaadmin`, `windowSec=2`.

**Correction:** P1-3 as written (“pullbal has catch-up, pullpay does not”) describes **unreleased local source**. **Live both `pullbal` and `pullpay` bill a flat window** — that is the FIXPROP underpay, still on chain. App IDOR / unauth `/media` / listeners dump / env keeper key findings apply to **what is on the box**, because those files hash-match.

---

## 1. Verdict

**NO-SHIP for mainnet.**

The contract’s pay-mode design (deposit-time cap, fuse, `requireAuth` matrix, `sendFrom` child-perm, `onTransfer` firstReceiver guard, paused-deposit revert) is the strongest part of the tree. It is **not** ready to freeze as mainnet custody: the keeper is a hot private key that chooses the payout song; grant mode still bills a flat 2s; freeze is incomplete while contract keys exist; app-layer IDOR and free `/media` sit in front of the same catalog the keeper bills.

`REVIEW-PACKAGE.md` S1–S4 (XSS, anonymous publish, splits hijack, upload extensions) look **fixed on disk**. Do not re-open those without a regression test. **S5 and S7 are still open.** This pass adds **new** findings that the Aug 26 package does not list.

---

## 2. Findings (security)

Severity: **P0** blocks mainnet / public money. **P1** must-fix before public exposure. **P2** should-fix. **INFO** for the human’s notes.

### P0-1 — IDOR: any logged-in wallet can read another wallet’s library / playlists / recents

**Where:** `app/server.js` `grantAccessFor` 578–591 · `scopeFor` 755–766  
**class:** security / IDOR  

`grantAccessFor` used to return `null` for “no grant”. After the null-deref fix it **always** returns a truthy `NO_ACCESS` object.

`scopeFor` still does:

```javascript
const access = grantAccessFor(actor, target);
if (access) return { kind: "actor", id: target, access };
```

`if (access)` is now **always true**. A bearer token plus header `X-Account-Actor: <victim>` makes the request’s scope the victim.

`GET /api/library`, `GET /api/playlists`, `GET /api/recents` use `scopeFor` and **do not** check `access.read`. Those routes therefore leak another user’s saved songs, playlist contents, and recents.

Write routes go through `writeGate` (`access.write === false` → 403), so this is a **read IDOR**, not a mute/delete IDOR. `/api/account/balance` and `/api/now-playing` check `access.read` explicitly and are **not** in this hole.

**Evidence:** `NO_ACCESS` is `Object.freeze({ read: false, … })` — truthy. No test covers `X-Account-Actor` without a grant.

**Action for apply-leg (do not do in this review):** `if (access && access.read)` (or restore null for “no grant” and fix call sites). Add a test: token A + `X-Account-Actor: B` → 403 on library.

---

### P0-2 — Premium audio is unauthenticated (S5 still open)

**Where:** `app/server.js` 2598 · `serveStatic` 1074–1108 · catalog `file` is public on `GET /api/catalog`  
**class:** security / payments bypass  

`/media/songs/**` is served with Range support and **no** session, JWT, or HMAC. Playback *start* is gated (`POST /api/session/play` → 401 without wallet), but the MP3 URL is in the public catalog JSON. Anyone who can `curl` the file gets the track without paying.

`ONDA_REQUIRE_MEDIA_SIG` is **not** in this tree (grep: no hits). The Aug 26 “signed URL” item was never applied.

For a paid streaming product this is the actual paywall. The keeper billing a wallet is irrelevant if the bytes are free.

**Action:** short-lived HMAC URLs minted only after `/api/session/play`; reject `/media/songs/**` without sig. Flip behind a flag after both clients use it.

---

### P0-3 — Keeper key + keeper-chosen `songId` can redirect every stream

**Where:** contract `pulse` 481–508, `pullbal` 528–573, `pullpay` 625–655; `app/onda-pulse.js` 13–14, 53, 208–217, 2624–2628 in `server.js`  
**class:** security / custody  

All three keeper actions take `songId` from the **server**, not from a listener signature. Money goes to `requireSong(songId).payout`.

A leaked `ONDA_KEEPER_PRIVATE_KEY` (today: raw key in `JsSignatureProvider`, house key-isolation **violated**) can:

1. Register attacker song via any wallet `setsong`.
2. Pulse/pull every live listener toward that `songId`.
3. For **grants**, pull the listener’s wallet (bounded by `maxPerTick`/`budget`/`fuse`, but **to the attacker payout**).
4. For **locks**, also rewrite `lock.songId` / `lock.payout` on each `pulse`.

This is the real mainnet threat model, not “random user calls pullpay” (`requireAuth(keeper)` is correct).

**Action:** (a) migrate signing to proton CLI keystore (S7); (b) bind payout song to a listener-signed `start`/`switchsong` (or last `setsong` they consented to) so a stolen keeper cannot retarget; (c) keeper permission scoped to `pullbal`/`pullpay`/`pulse`/`expire` only — never `active` if that key is also used elsewhere.

---

### P0-4 — Contract keys still = `setcode` = drain every grant

**Where:** contract header comments 359–364; `setowner` 366–374; house lesson 2026-08-24  
**class:** security / custody  

`linkauth` does not cap amount or recipient. Whoever can `setcode` on `ondastream` can ship wasm that `sendFrom`s every granting wallet. Chain still cannot steal keys or XUSDC without a second `linkauth` — worst case is **all linked XPR (and any other linked token)**, not account takeover.

`setowner` exists and admin is documented as `ondaadmin` (off the contract account). **Freeze is still incomplete** until:

1. Human confirms `get_account ondastream` has **no** keys / only `eosio.code` where required for inline transfers.
2. Owner account itself is not a single hot key that also sits on a server (`onda-pricing.js` defaults `ONDA_PRICER_PERMISSION` to **`active`** — P1-6).

README still points at `~/.xpr-testnet/ondastream.key.json`. If that key still controls `ondastream@active`, mainnet is not freezeable.

---

### P0-5 — No ship artifact (no git) + wasm hash drift

**Where:** project root has no `.git`; README wasm `fd882d4a…`; REVIEW-PACKAGE last deploy `5f60a2ee…`; disk wasm `86bb9d28…`; source sha `5aab5b0f…`  
**class:** deploy integrity  

House rule: no money/auth SHIP on mixed dirty scp. This tree cannot name a commit. A human cannot prove Hetzner `/opt/xpr-music` and testnet `code_hash` match this review.

Elapsed-charge (`playedSec`) is **in source**. If chain is still `5f60a2ee`, live `pullbal` ABI does not match the keeper that now sends `playedSec` — pulls would fail or decode wrong.

**Action before any mainnet thought:** `git init` + tag; print on-chain `code_hash`; rebuild; only deploy if ABI table layout is **byte-identical** (golden rule). Do not add fields to existing tables.

---

### P1-1 — `GET /api/agents/listeners` dumps every live session (sid + actor + track)

**Where:** `server.js` 1319–1350  
**class:** privacy + session hijack assist  

Default path (no `owner` query) returns **all** playing listeners including `sid`. Combined with `POST /api/session` accepting a client-supplied UUID (`1410–1414`) and `GET /api/session/state` keyed only on `X-Session-Id`, a leaked sid is a **session handle**.

The `owner` + grant branch is the intended design; the unauthenticated dump is the hole. Aug 26 package listed this as med; for a public player it is P1.

---

### P1-2 — Arbitrary `file` / `cover` / `video` URLs on publish

**Where:** `server.js` 2010–2021, 2027–2028, 2054–2056; `mobile.html` 1826 (`https?:` passthrough)  
**class:** stored content / client SSRF / tracking  

Authenticated publish (S2 gate is real) still accepts `body.file` / `body.cover` / `body.video` as **any string** when no base64 is sent. Mobile will load `https://…` as the audio `src`. Desktop prefixes `/media/songs/` so absolute URLs are less live there — **client drift**.

An artist (or stolen JWT) can point listeners’ browsers at an attacker origin (malware, tracking, huge download). Cover `https:` is allowed by `safeCoverUrl`.

**Action:** allowlist relative `uploads/…` only; reject `..` and schemes.

---

### P1-3 — `pullpay` (grant mode) still bills a flat `windowSec`, not played time

**Where:** contract `pullpay` 642–643 vs `pullbal` 518–550; `onda-pulse.js` `actionFor` grant branch has **no** `playedSec`  
**class:** money correctness  

Elapsed-charge was applied only to **top-up**. Grant/power-user path still: `due = rate * windowSec`, then min with `maxPerTick` and remaining budget. Dropped keeper ticks (documented: RPC 1/s + `if (busy) return`) **underpay the artist** on the grant path the same way `FIXPROP-elapsed-charge.md` described for `pullbal`.

Fails safe for the listener (never over-bills pause, because pause stops pulses). Product: grant users systematically underpay when the keeper lags.

---

### P1-4 — Permissionless `settle()` vests **wall-clock** including paused time

**Where:** `settle` 454–464 (no `requireAuth`); `accrueLock` 885–912 uses `now - lastVest`  
**class:** money / griefing  

`pulse` comments: paused time is free. `settle(listener)` can be called **by anyone** and runs `accrueLock(lock, false)` which vests the full elapsed lock at `vestPerSec`. An abandoned or paused lock (wallet-direct `s:` or `startstream`) can be force-settled for the pause duration, up to remaining.

If lock mode is still reachable, this is pause-to-charge. Same as REVIEW-PACKAGE Q5 — **still open**. Human Decision #2 in that package.

`expire` (keeper-only) rebates without vesting pause — the two abandonment paths disagree.

---

### P1-5 — Unknown transfer memos still **keep the tokens**

**Where:** `onTransfer` 761–827  
**class:** money / stranding  

Parked `onda` while paused now `check`s (revert — good). Unpriced token on `onda` / `s:` now `requireRate` (revert — good). Any other memo (including MetalX-footgun `"deposit"` and typos) **returns** after the transfer has already credited the contract. `withdraw` only reads `balances`. Those funds need `setcode` to recover.

Intentional for `"deposit"`. For a consumer app, a wrong memo is a lost top-up. Human should pick: `check(false)` on unknown memos (breaks accidental airdrops / other contracts sending with memos) vs an admin `refund` action.

---

### P1-6 — Pricer permission defaults to `active`

**Where:** `onda-pricing.js` 22 `ONDA_PRICER_PERMISSION || "active"`  
**class:** privilege  

If env is unset, the pricer key is used as `@active`. On `ondaadmin` that is `setowner` / `setkeeper` / `setpaused` / `setwindow` / `settokrate`, not “rates only”. House lesson: never put a `setcode`-capable key on a server; same applies to admin `active`.

**Action:** hard-fail unless permission is set and is a linked child (`ondarates`), never `active`/`owner`.

---

### P1-7 — Royalty `splits` are off-chain only; PUT does not reuse `isStreamPayout`

**Where:** contract `sendToken`/`sendFrom` → **100%** `songs.payout`; `server.js` 2547–2554 vs 2069–2071  
**class:** product / money  

On-chain streaming ignores `song.splits` and platform cut. Splits only mattered to `settle_all.mjs` (legacy, gated — good). Artists will believe the UI splits. Mainnet would pay the single `payout` account.

PUT `/api/songs/:id/splits` does not call `isStreamPayout` (POST submissions does). Invalid names or `ondastream` can be stored.

---

### P1-8 — `readBody` has no size cap (DoS)

**Where:** `server.js` 1063–1068  
**class:** availability  

`req.on("data")` concatenates unbounded. Upload paths check `audio_base64.length` **after** the full body is in RAM. One request can OOM the Node process that also holds the keeper.

Rate limit is 300/min/IP (1200 static) — not a byte cap.

---

### P1-9 — CORS `Access-Control-Allow-Origin: *` on every JSON response

**Where:** `server.js` 1006–1008  
**class:** browser security  

Any origin can read catalog, listeners dump (P1-1), and (with a stolen token) call APIs from a hostile page. Tokens live in `localStorage` (XSS → theft; S1 quote-escape reduces XSS). For a wallet product, allowlist the real origin.

---

### P2-1 — Grants table is **one row per listener**, not per token

**Where:** `Grant.primary` = `listener.N` 244–246; `grant()` overwrite 600–603  
**class:** contract design  

A second `grant` for another token **replaces** the first row (`spent` resets — comment says fresh consent). Leftover `linkauth` on the old token contract remains on the account. `pullpay` uses the **new** row’s contract; old link is orphaned until `unlinkauth`. UI must not imply multi-token standing grants.

---

### P2-2 — `creditBalance` on a new row leaves `maxPerTick = 0`

**Where:** `creditBalance` 931–938 vs `bumpCap` 788–790  
**class:** money liveness  

Constructor default `maxPerTick` is 0. Park path calls `bumpCap` after credit — OK. **Rebate** of a `SOURCE_BALANCE` lock via `creditBalance` after `debitBalance` removed the row (amount hit 0) recreates a row with **cap unset**. Next `pullbal` fails `cap unset` until the listener `setcap`s. Sticky stall, artist unpaid.

---

### P2-3 — Admin PIN compared with `===` (not `timingSafeEqual`) in ~10 routes

**Where:** e.g. `server.js` 1980, 2440, 2494, 2538  
**class:** crypto hygiene  

`auth.js` JWT path **does** use `timingSafeEqual` (421). PIN checks do not. PIN is in `X-Admin-Pin` over TLS (Caddy) on the live site — still brute-forceable if short. `/admin` HTML is served with **no** gate (2590); PIN is only API-side.

---

### P2-4 — Identity proofs have no nonce/expiry (documented); JWT TTL 7 days in localStorage

**Where:** `auth.js` 13–15, 37, 188–194; clients `localStorage`  
**class:** session  

Same MailSigil limitation: web-sdk proofs `expiration == 0`. Replay store is canonical `proof.toString()` (F-M1 fixed — keep). 7-day bearer in `localStorage` survives XSS that `httpOnly` cookies would not. No revoke route.

---

### P2-5 — Unpinned esm.sh SDK majors

**Where:** `app/web/xpr-login.js` 9–11 `@proton/web-sdk@4` and `@proton/link@3`  
**class:** supply chain  

A tag move on esm.sh changes login/signing in every browser with no deploy. `.versions/` previously had `5.1.0-rc-4`. Re-pin + SRI.

---

### P2-6 — GIF still in image allowlist; no magic-bytes on audio/covers

**Where:** `UPLOAD_EXT` 200–203 vs video path 2041–2047  
**class:** content-type  

Video checks ftyp/EBML. Covers/audio trust the filename extension. GIF is an HTML/script polyglot class in old browsers; lower now that `html()` uses `textContent`. Still inconsistent.

---

### P2-7 — `accepted_tokens` API still lists only XPR + XUSDC

**Where:** `server.js` 1284–1288 vs contract `tokrates` (XPR, XUSDC, METAL, LOAN, XMD per lessons)  
**class:** product drift  

Clients told a lie; contract will accept whatever `tokrates` enables. Repricer can turn tokens on that the UI picker hides (or the reverse).

---

### P2-8 — JSON mock top-up is unbounded for `spend` (including self)

**Where:** `POST /api/account/topup` 2217–2238  
**class:** money (if `payments_enabled` flipped)  

Self has `spend: true`. This writes `catalog/balances.json` with no chain debit. Safe while the JSON meter is display-only. **Fatal** if someone sets `payments_enabled: true` without ripping this out.

---

### P2-9 — `settle_all.mjs` still executable; restore-ratesetter is over-capable

**Where:** `app/settle_all.mjs`, `run_settlement.sh` (gated `ONDA_LEGACY_SETTLE=1` — good); `scripts/restore-ratesetter.mjs` signs `updateauth` with an **active** key from `~/.openclaw/workspace/.env.xpr`  
**class:** ops hazard  

Default-safe. A future agent “just running settlement” or restore against the wrong account is still a drain/escalation footgun. Keep quarantined; do not cron.

---

### INFO — What looks sound (do not “fix”)

- `requireAuth` on every fund-moving user action; keeper-only on pulse/pull/expire.
- `grant` rejects `active`/`owner` child names.
- `pullbal` `check(maxPerTick > 0)` fail-closed; deposit-time cap via `bumpCap`.
- `onTransfer` `firstReceiver == receiver` early-return (direct-call spoof).
- `sendFrom` uses `PermissionLevel(from, perm)` — documented proton-tsc `@active` trap avoided.
- Canonical proof hash (`proof.toString()`) — MailSigil F1 not reintroduced.
- Submissions/splits identity from JWT/PIN, not `body.actor`.
- `html()` escapes quotes; `safeCoverUrl` allowlist (desktop).
- Upload extension allowlist for base64 writes.
- Rate-limit uses `X-Forwarded-For` **only** from loopback peer.
- `payments_enabled: false`, `mainnet_maintenance: true` in process memory — client cannot flip them.
- Play requires wallet (`1471–1472`).
- Table schemas: new tables for grants/tokrates/pulls/ops; `config`/`songs`/`streams`/`claimed` not reshaped in source (golden rule honored in this file — still verify ABI vs chain before next setcode).
- `npm run test:meter` 10/10.

---

## 3. Contract action auth matrix (this source)

| Action | Auth | Moves funds? | Notes |
|---|---|---|---|
| `init` | `this.receiver` once | no | |
| `setpaused/setowner/settokrate/setwindow/setrate/setkeeper` | `cfg.owner` | no (rate change can *enable* drain) | pricer should be **subset** |
| `setsong/pausesong` | `artist` | no | payout change = future pulls; **no del/transfer** |
| `grant` | `listener` | no | overwrites single row |
| `revoke` | `listener` | no | **soft**; `unlinkauth` is the backstop |
| `setcap` | `listener` | no | can **raise** cap (consent to inflation) |
| `startstream/stopstream/switchsong/withdraw/claim` | subject | yes | |
| `pulse/pullbal/pullpay/expire` | **keeper** | yes | songId from keeper |
| `settle` | **nobody** | yes (vest lock) | P1-4 |
| `transfer` notify | token contract | yes (credit lock/balance) | firstReceiver guard |

`claim()` still walks primaries with `CLAIM_SCAN_LIMIT=256` (Q1 mitigated, not indexed). CPU billed to artist.

`fnv64(songId)` / `tokenKey` / `rateKey` are hash IDs with collision checks on song/rate; `tokenKey` collision would mix two (account,token,sym) rows — unproven, owner-unrelated, FLAG as residual.

`u32` times → year 2106 (conventional).

---

## 4. Regular-code review (quality, not just vulns)

**Blockers for “good enough for a human to bless”**

1. `server.js` is a 2600-line router with catalog mutation, authz, static, keeper wiring. Easy to reintroduce IDOR (P0-1 is exactly that). Split authz helpers with tests.
2. Contract README + `accepted_tokens` + prior REVIEW-PACKAGE hashes are **stale vs source**. Reviewers will audit the wrong wasm if they trust README.
3. Dual billing engines: JSON `stream-meter` (tested) vs on-chain keeper (smoke script). They can disagree; only one should be money.
4. Desktop vs mobile: cover escaping / `song.file` absolute URLs already drifted.

**Should-fix**

- `scopeFor` must treat `NO_ACCESS` as deny (P0-1).
- Pin SDK + SRI.
- Server-generated session ids; stop accepting client UUIDs.
- `claim()` real `byAccount` iteration once proton-tsc range API is proven on-chain.
- `pullpay` playedSec + same three clamps as `pullbal` if grant mode stays.
- Hard-fail pricer perm.
- Process bind: log says `127.0.0.1` but `listen(PORT)` is all interfaces unless Caddy is the only public socket — confirm Hetzner unit.

**Nits**

- `setwindow` error string in comments vs 1–30s actual.
- `grant` regex on app grants allows dots (`2161`) while `isXprAccount` forbids them.
- Archive HTML under `web/_archive/` is still on disk; ensure `/web/_archive` is not served in production (it **is** under `/web/` static).

---

## 5. Suggested order for the human / apply-leg (after ACCEPT)

1. **P0-1** IDOR one-liner + test (safe AUTO-FIX).
2. **P0-5** measure on-chain `code_hash` vs disk wasm; do not setcode until ABI-identical.
3. **P0-2** signed media (product).
4. **P0-3/P0-4/S7** key isolation + freeze keys + songId binding.
5. **P1** listeners auth, URL allowlist, settle/memo decisions, pullpay elapsed, pricer perm, splits honesty in UI, `readBody` cap, CORS.
6. Independent SHIP (not Grok). Then — and only then — mainnet discussion.

Do **not** flip `payments_enabled` or `mainnet_maintenance` in this tree as part of fixing.

---

## 6. Open human decisions (carried + new)

| # | Question | Why not auto |
|---|---|---|
| H1 | Settle vs expire: is force-vest of idle locks OK? | product / money |
| H2 | Unknown memo: revert vs retain vs admin refund? | irreversible funds |
| H3 | Keystore migration now vs at mainnet prep? | ops |
| H4 | Upload format list (gif? wav?) | product |
| H5 | On-chain splits vs “payout wallet is the whole story”? | if UI shows splits, chain must match or UI must stop lying |
| H6 | Bind keeper `songId` to listener-signed start? | extra Face-ID vs stolen-keeper redirect |

---

## 7. Residual after a clean apply of P0/P1

- Oracle staleness (USDC/XMD/LOAN) — off-chain pricer already the design.
- Proof first-use race (web-sdk).
- Hash-id collisions (fnv/tokenKey).
- Artist RAM for `setsong` (grief by spamming ids — paid by artist).
- Keeper liveness: dropped ticks underpay until catch-up; cap vs 16s knife-edge documented in contract comments.

**Independent SHIP still required.** This file is one family’s informed pass, not a ship ticket.
