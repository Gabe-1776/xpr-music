# XPR-Music (Ondastream) — Human Review Package

> **Historical (2026-08-26).** Not the live pin. Current: `AGENTS.md` + `PRODUCTION-PIN.md`. Git exists: private `Gabe-1776/xpr-music`. S1–S4/S6 in this file were applied to live; S5/S7 and later findings are in `.reviews/2026-08-29-onda-pre-mainnet/`.

Prepared 2026-08-26 by machine audit (security pass + quality pass), for human reviewer sign-off.
Scope: whole project. Status: **testnet only** (`music.project-testing.xyz`, chain `71ee83b…`).

---

## 1. What you are reviewing

| Layer | Path | Notes |
|---|---|---|
| Smart contract | `contracts/ondastream/assembly/ondastream.contract.ts` (957 ln, 23 actions) | AssemblyScript/proton-tsc, deployed to XPR testnet account `ondastream` |
| Backend | `app/server.js` (2529 ln single-file router) + `auth.js`, `stream-meter.js`, `rpc-budget.js`, `onda-wallet.js`, `onda-pricing.js`, `onda-pulse.js` | Node stdlib http; deps: `@proton/js ^23`, `@proton/signing-request ^5.1.0-rc-1` (`app/package.json`) |
| Web clients | `app/web/desktop.html`, `mobile.html`, `xpr-login.js` | Served by same backend; UA-routed at `/` |
| Admin/ops scripts | `scripts/*.mjs` (deploy/key/settle tooling) | Sign via keys from `~/.xpr-testnet/…` / `~/.openclaw/workspace/.env.xpr` — outside repo |
| Docs of record | `BLUEPRINT-pay-modes.md`, `PROGRESS-2026-08-24-…handoff.md`, `handoff-review.md` | Intent reference; contract header mirrors it |

Accounts: `ondastream` (contract), `ondaadmin` (cfg.owner, admin), `xprmusic` (keeper/pulse + backend acct), `felixpaw` (personal wallet). Pricer key is scoped: `@ondarates` linked to `settokrate` **on-chain** (verified live by probe scripts).

## 2. How to run / verify

```bash
cd app && npm install
ADMIN_PIN=<pin> PORT=8788 node server.js      # fails fast without ADMIN_PIN (server.js:68)
npm run test:meter                            # stream-meter unit tests
node test/verify-auth.mjs                     # end-to-end login proof — needs ~/.xpr-testnet/wallets.json (Mac-bound)
cd ../contracts/ondastream && npm run build   # proton-asc → assembly/target/
```

Deploy discipline already in place: wasm sha256 printed pre-push; ABI backups; testnet-first.

## 3. Verdict summary

Fundamentals are sound for a testnet payments app: cryptographic wallet login with anti-replay, escrow-metered billing with tight clamps, contract auth matrix clean across all 23 actions (no unauthenticated fund movement; keeper bounded by fuse/cap/budget everywhere). The blocking gap is **application-layer authz on two server routes** plus a stored-XSS chain that turns anonymous publishing into token theft. Fix set A+B below before any exposure beyond LAN.

## 4. Security findings (audit 2026-08-25 — all currently OPEN)

### Must fix before approval (chain: crit/high)
| # | Where | Finding |
|---|---|---|
| S1 | `desktop.html:2847-2862` | Stored XSS: `html()` escapes `&<>` but not quotes → attribute breakout via song title/cover; auto-fires on render; steals 7-day bearer + admin PIN. Fed by S2 |
| S2 | `server.js:1891-1935` | POST `/api/submissions`: no authentication, publishes into paid catalog with attacker-chosen owner/payout, uncapped base64 write |
| S3 | `server.js:2439-2449` | PUT `/api/songs/:id/splits`: authorizes off client-supplied `body.actor` → anonymous royalty-split rewrite |
| S4 | `server.js:195-198` | Uploads accept arbitrary extension into web-served roots → persistent HTML/SVG (XSS substrate) |
| S5 | `/media/*` serving | Premium audio unmetered/unauthenticated — playback gate exists only client-side |
| S6 | `app/catalog/auth-secret.json` | Live HS256 JWT secret inside project tree; `.gitignore` now covers it but the file itself should move out of tree |
| S7 | `onda-pulse.js:13,53`, `onda-pricing.js:19,53` | Raw private key via env into `JsSignatureProvider` — violates house key-isolation policy (charliebot pattern). Testnet/Mac-side today; must move to proton CLI keystore before mainnet/Hetzner |

### Should fix (med): unbounded `readBody` buffer (DoS), bind-all-interfaces vs loopback banner + cleartext tokens, client-fixed immortal session ids, `/api/agents/listeners` identity leak via `?actor=`, admin PIN non-constant-time compares ×10, wildcard CORS, pricer permission defaults to `active`, localStorage-stored long-lived tokens, unpinned esm.sh SDK imports, mobile plays attacker-supplied absolute `song.file` URLs.
Contract-side med: deposits stranded when paused / unrecognized memos retained (no refund path); legacy `settle_all.mjs` still executable & cron-wired — double-pay/treasury-drain hazard if run post-contract (**quarantine before approval**); `restore-ratesetter.mjs` recreates over-scoped permission if misrun against current topology.

Clean (explicitly checked, not found): command injection, SSRF, prototype pollution, committed secrets/backups, metering math abuse (negative/zero/replay clamped), wallet-login actor spoofing (verified vs chain authority), ratesetter scope bypass (enforced nodeos-side).

## 5. Code-quality findings (quality pass 2026-08-26)

**Blockers for "good code" bar**
- Q1 `ondastream.contract.ts:913-926` — `claim()` walks the *entire* claimed table per call while the `byAccount` secondary index (188-194) sits unused. CPU is billed to the withdrawing artist; growth ⇒ claim eventually exceeds block CPU = artists locked out of earnings. Use `idx.lower_bound/byAccount`.
- Q2 No `package-lock.json` anywhere under `app/` or `contracts/` + caret ranges → reviewers cannot reproduce a build. Commit lockfiles (or pin exact).
- Q3 server.js has no `process.on('uncaughtException'/'unhandledRejection')` guard; one stray async error in a 2500-line router with sync-fs writes takes the box down mid-ledger-write.

**Should fix**
- Q4 ABI drift: staged `target/*.abi` omits the `transfer` notify action the source exports (`ondastream.contract.ts:710`). Regenerate from source and add an explicit `check(this.firstReceiver != this.receiver)` hardening in `onTransfer` in the same rebuild — safety should not depend on which artifact side you're on.
- Q5 `pulse()` doc says pause stops billing ("paused time is free", :451-452) but anyone can call permissionless `settle()` (:426-435) to vest full wall-clock elapsed dues on an abandoned lock — converting what should have been an `expire()` rebate into a forced payout. Semantic conflict between the two abandonment paths; make settle respect the same intent (e.g. rebate-only after idle threshold) or document explicitly.
- Q6 `settokrate()` update path doesn't re-verify `(token,symRaw)` on hash collision (`:364-368`) unlike `setsong`/`requireSong` collision discipline two functions away. Owner-only so low risk, but inconsistent pattern.
- Q7 `xpr-login.js:10-12,22-30` — floating SDK majors `@proton/web-sdk@4` / `@proton/link@3` regressed vs pinned `5.1.0-rc-4` seen throughout `.versions/`. Re-pin exact versions + SRI (ties to S-group esm.sh item).
- Q8 `server.js:3` header claims "zero-dependency node http" — stale since `auth.js` requires `@proton/js`. Doc drift misleads reviewers in the first three seconds.
- Q9 desktop/mobile.html carry parallel ~1000-line implementations of player/session/wallet logic with known semantic drift (escaper differences being the worst). Consolidate shared modules opportunistically; at minimum add a parity checklist comment atop both.

**Nits**: `startstream` error text says "buffer 2-180s" but real lower bound is `windowSec` (:647); `u32` time casts → Y2106 (conventional, note only); `claim()` could also batch-limit iterations.

**Praise — keep these patterns**
- Contract docs are exemplary: pay-mode rationale in the header, inline explanations for fuse/cap/CAP_MULTIPLIER design, the proton-tsc `sendFrom` child-permission trap documented where it bites (928-946).
- Golden-rule compliance: legacy `streams` table preserved untouched; header forbids reshaping deployed tables.
- Fail-closed money checks: `check(bal.maxPerTick > 0, "cap unset")` (514), budget≥tick at grant time, mutate-then-inline-send relying on EOSIO atomic rollback.
- Server: fail-fast ADMIN_PIN; payer-stop callback halts unpaid playback immediately (2509-2524); genre taxonomy data-driven; comments record decisions, not narration.

## 6. Decisions needed from human reviewer

1. Approve gating `/api/submissions` + splits behind verified Bearer tokens (breaks any script currently calling them anonymously — e.g. `cli-publish-rest.mjs` flow gets a token step).
2. Abandonment semantics (Q5): is forced settle-billing of idle locks acceptable revenue-griefing tradeoff?
3. `settle_all.mjs`/`run_settlement.sh`: archive/delete now?
4. Key-isolation migration scope: migrate keeper/pricer signing to proton CLI keystore now, or accept env-key pattern until mainnet prep?
5. Upload policy: strict extension+magic-byte allowlist proposed — confirm acceptable formats list.

## 7. Suggested fix order

1. S1+S2+S3+S4 together (one session: auth gate, quote-safe escaping, upload allowlist+caps)
2. Q1-Q3 (index use, lockfiles, process guards) + quarantine `settle_all.mjs`
3. S5 signed media URLs · S6 secret relocation · Q4 ABI regen w/ firstReceiver check
4. S7 keystore migration + transport/session hardening before public exposure

---

## 8. Status update — fixes applied 2026-08-26 (afternoon)

| Item | Status | Evidence |
|---|---|---|
| S1 desktop stored XSS | **FIXED** | `html()` now escapes `"`/`'`; new `safeCoverUrl()` allowlists cover sources (`desktop.html:1793-1804`); card builder rebuilt on guarded values |
| S2 anonymous publishing | **FIXED** | POST `/api/submissions` requires verified Bearer or admin PIN; `owner` stamped from token only (`server.js:1909-1918`) |
| S3 splits hijack | **FIXED** | PUT splits authorizes off `auth.verifyToken` / PIN; `body.actor` never trusted (`server.js:2467-2474`) |
| S4 web-executable uploads | **FIXED** | `UPLOAD_EXT` allowlist + `UPLOAD_MAX_B64` cap applied to covers, artist photos, audio (`server.js:193-216,1781-1788,1946-1954`) — mirrors the existing video C8 pattern |
| NEW F-M1: proof replay via raw-string hash (MailSigil F1 bug re-introduced by the port) | **FIXED** | `app/auth.js:175-181` now hashes canonical `proof.toString()`, not the client string |
| Legacy settler hazard (was Decision #3) | **CONTAINED (default-safe)** | `com.felix.xpr-settlement` launchd agent unscheduled (plist intact — restore: `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.felix.xpr-settlement.plist`); `run_settlement.sh` refuses without `ONDA_LEGACY_SETTLE=1`. Today's 09:00 run had crashed pre-payout by luck (`xpr-settlement.log:161-191`) — containment removes tomorrow's dice roll |

Verification: `node --check` clean; isolated smoke rig (`/tmp/xpr-smoke`, port 8898, copied catalog): anonymous submissions → 401, anonymous splits spoof → 401, admin-path splits → 200, publish with hostile filenames → audio saved `.mp3`/cover `.jpg` fallbacks, 201 otherwise; headless-browser render of `/desktop`: 70 cards, 34 covers, no errors. Meter suite green (10/10).

## 9. MailSigil auth stack audit (~/projects/agent-mail/auth)

The identity layer xpr-music's wallet login is ported from. Verdict: **sound, approve**.
- Proof path (`identity-proof.ts:52-143`): chain-ID bound, active/owner-only, live-RPC authority with weight/threshold math (correctly bypassing upstream `verify()`'s expiry AND-bug), EOS/PUB_K1 normalization, single-use claim applied LAST so failed attempts stay retryable.
- Transaction path (`verify-authority.ts:43-90`): correct weighted multi-sig model replacing the historical `signatures[0]`-only check (F2); digest replication kept byte-compatible.
- Replay store: claims are atomic SQLite insert-if-new (`grant-store.ts:1545-1548`) — no TOCTOU even concurrently.
- Ops hygiene: loginLimiter on every auth route, per-actor buckets keyed only after JWT verification (F3 fix documented), SSRF guard module, Deprecation header steering clients off the nonce-less proof path, and outstanding findings tracked inline with repros.
Residual (documented upstream, acceptable): proton-web-sdk proofs carry no nonce/expiry — first-use race window exists by wire-format limitation; deprecation path is the long-term closure.
xpr-music parity: weight/threshold logic correctly ported; F-M1 (canonical hash) was the one drift — fixed above. Nonce challenge flow is single-use with TTL sweep; recommend adding a tight dedicated login rate limit like MailSigil's 20/min (currently global ~300/min).

## 10. Non-XPR surface sweep

- `test/stream-meter.test.cjs`: 10/10 passing — real behavioral coverage (escrow conservation across currency switches, rebate-on-pause semantics, dust holds). This suite is trustworthy as an approval gate for billing changes.
- `backup_catalog.sh`: good mandatory-pre-edit snapshot discipline, explicitly excludes `auth-secret.json` ✓.
- `scripts/*.mjs` key handling: all load from outside-repo files; smoke-test role-separation nit remains (pay-modes-smoke uses owner key for listener role).
- Remaining open items are exactly those listed in §4 med/low + §5 Q1–Q9 minus Q-group items already covered above; decisions #1, #2, #4, #5 in §6 still want human sign-off (#3 resolved default-safe this session).

## 11. Round two — hardening applied 2026-08-26 evening

### Corrections to earlier findings
- **Q4 reclassified**: the staged ABI omitting `transfer` is proton-asc **by design** (`proton-asc/dist/contract/contract.js:359` "Ignore notify actions in ABI"), not drift. Nodeos rejects pushes of ABI-absent actions, so the direct-call spoof shield is permanent and correct as-shipped. Local rebuild produced a **byte-identical ABI** — zero schema-migration exposure for the next deploy.

### Contract hardened AND DEPLOYED — 2026-08-26 (testnet `ondastream`)
WASM sha256 `5f60a2ee…f37e3f1b0` — **on-chain code_hash now matches it exactly** (was `2e2efa73…55f`). Changes live:
1. `onTransfer` direct-call guard (`firstReceiver == receiver → return`) at :719-722
2. `settokrate` hash-collision assertion mirroring setsong discipline (:365-370)
3. `claim()` scan cap `CLAIM_SCAN_LIMIT=256` with fairness rationale (:44-47, 926-945) — supersedes the "use byAccount ranges" phrasing in §5 Q1 until the secondary-index API surface is proven by an on-chain test

Deploy evidence: setcode/setabi tx `728d43fd…1f80ba`, eosio.code re-assert `420cc704…59cf`, init returned "already done". Safety rails honored: pre-redeploy on-chain ABI backed up (`backups/contract/onchain-abi-pre-redeploy-20260826.json`), rebuilt ABI byte-identical (zero table-schema change per golden rule), post-deploy reads confirm intact state — config `{owner: ondaadmin, paused: 0, windowSec: 2}`, 10 songs, 5 tokrates, keeper `xprmusic`.

### Applied this round
- **F-M1** proof-replay canonical hash fix (`app/auth.js:175-181`) — closes the base64-alphabet replay port of MailSigil F1
- **S6 complete**: live secret moved to `~/.xpr-testnet/auth-secret.json` (0600, sessions preserved); `loadSecret()` prefers env override → canonical home → legacy in-tree fallback; generation only ever happens outside the tree
- **Q2**: `package-lock.json` committed for `app/` and `contracts/ondastream/` — reproducible installs for reviewers
- **Q3**: process-level `uncaughtException`/`unhandledRejection` handlers log-and-exit(1) (`server.js:2539-2550`); state files are sync-written so exit-consistency holds; restart supervision belongs to the operator harness
- **Q8**: stale "zero-dependency" header claim rewritten truthfully (`server.js:3-8`)
- Settler containment detail: this morning's scheduled run died on a transient `ECONNRESET` from `testnet.protonchain.com` BEFORE transferring anything (log lines 161-191); endpoint verified healthy post-hoc (200 in ~1s). Not rate-limit/ban related — but revived chain jobs get budget/backoff/staggering conditions regardless (see parked zone).

### Deferred (parked)
S5 signed media URLs · S7 keystore migration · remaining med/low transport+session items · deposit-memo refund hardening (retain-vs-refund decision interacts with #2 below).
Tracked in zone `~/zones/xpr-music-hardening/brief.md` (board row added). Human decisions outstanding: #1 token-gating of publish flow tooling, #2 settle-vs-expire semantics, #4 keystore timing, #5 upload format list — see §6.

### PRODUCTION DEPLOYED — 2026-08-26 (post-battery)
`server.js` + `auth.js` + `web/desktop.html` shipped to `/opt/xpr-music/` on Hetzner (`systemctl xpr-music`, active); remote sha256s match local byte-for-byte. Rollback copies: `*.pre-fixes-20260826` beside each file; pre-deploy remote catalog snapshot in `backups/prod-pre-fixes-*`. External probes post-restart: `/api/catalog` 200 · `/desktop` serves new client (safeCoverUrl present) · anonymous submissions → **401** · anonymous splits spoof → **401**.
Deployment-session bonus fix: `grantAccessFor()` null-deref crash (dormant since bearer callers never existed) found by the verification battery itself, root-fixed with frozen `NO_ACCESS` default before push. Known behavioral break: anonymous CLI publish tooling now needs a wallet token step (or admin pin) — parked in zone next-steps.

## 12. Open-work checklist — everything still to do (consolidated 2026-08-26)

### Before public exposure / mainnet prep (ship-blockers)
- [ ] **S5** signed short-lived media URLs; enforce `/media/songs/**` via `ONDA_REQUIRE_MEDIA_SIG=1` after clients adopt
- [ ] **S7** keystore migration (proton CLI `createCliSession`); retire `ONDA_KEEPER_PRIVATE_KEY` / `ONDA_PRICER_PRIVATE_KEY`
- [ ] **Deposit-memo refunds** in contract (`onTransfer` early-returns strand funds when paused; unknown memos retained) — one rebuild+redeploy alongside Decision #2 outcome
- [ ] **cli-publish-rest.mjs token step** — publishing automation broke with S2 gating (intentional); tooling upgrade required

### Quality backlog (non-blocking, bundled opportunistically)
- [ ] Session meds: server-generated sids + TTL sweep · immutable-session binding of actor per mutating request
- [ ] Transport: `readBody` 2MB/55MB caps · explicit bind host or TLS termination
- [ ] AuthN/Z polish: `timingSafeEqual` pin/nonce helpers · CORS origin allowlist · token TTL < 7d + revocation route · tokens out of localStorage
- [ ] Login rate limit dedicated (~20/min/IP like MailSigil) instead of global-only
- [ ] Pricer `ONDA_PRICER_PERMISSION` hard-fail unless set and ≠ active
- [ ] Contract: settle-vs-expire forced-billing semantics (Decision #2) · deposit refund behavior finalized · `claim()` true byAccount range iteration replacing scan cap (after API proven on-chain) · explicit `check(firstReceiver != receiver)` stays ✓ done this round
- [ ] Clients: restyle desktop card builder toward createElement parity · restore exact SDK version pins + SRI (regression vs `.versions`) · mobile `song.file` scheme/host allowlist · single shared module extraction over time
- [ ] Tests: smoke-gate role separation (throwaway listener account vs owner key) · auth replay-store timestamp-based pruning

### Ops / watch items
- [ ] Auto-restart harness choice for backend process (launchd KeepAlive locally / systemd Restart=on-failure on Hetzner) to complement Q3 guards
- [ ] 48h watch: keeper pulse success rate on organic streams · rst_in recurrence on the Mac (else Apple Diagnostics) · settler refuse-log growth · abuse probes against gated routes
- [ ] `git init` + audit-commit tagging once review approved (`.gitignore` ready; tree currently not a checkout)

### Human decisions outstanding
#1 approve publish-flow token gating ↔ affects artist UX · #2 settle-billing of idle locks tradeoff · #4 keystore migration timing · #5 upload format allowlist final list — see §6.

_Anything shipped after this document's §8–§11 entries is recorded in zone `~/zones/xpr-music-hardening/brief.md`._
