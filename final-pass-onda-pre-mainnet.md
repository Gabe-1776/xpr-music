# Final pass: onda-pre-mainnet (XPR Music / Ondastream)

**Status:** in-review · **NO-SHIP for mainnet**  
**Started:** 2026-08-29  
**Owner / orchestrator:** Grok Build  
**Author seat / family:** mixed (claude-code / anthropic for grant+pull+cap money path; grok-build / xai for meter/auth/UI; later Mercury/Claude hardening)  
**This security pass:** grok-build / xai  
**Invert:** yes vs Claude-authored contract money path (picker preferred invert for *this* report if treated as Grok-authored: openai / Vulcan-Review / Claude)  
**Independent SHIP gate owner:** **UNASSIGNED** — must not be grok-build; Fable-class or other non-author family  
**Branch / commit:** **no git repo** — tree is not a checkout; cannot pin a ship artifact  
**Deploy target:** testnet `ondastream` + `https://music.project-testing.xyz` (Hetzner `167.233.60.62:/opt/xpr-music`). **Not mainnet.**  
**Live vs local (measured 2026-08-29):** app `server.js`/`auth.js`/`desktop.html` **hash-match** Hetzner. Live keeper `onda-pulse.js` and on-chain wasm `5f60a2ee…` are **behind** Mac source (elapsed-charge `playedSec` not deployed). See findings §0.  
**ASVS-ish target:** **L2 (money/auth default)**  
**Changelog:** [final-pass-onda-pre-mainnet.CHANGELOG.md](./final-pass-onda-pre-mainnet.CHANGELOG.md)  
**Reviews dir:** `.reviews/2026-08-29-onda-pre-mainnet/`  
**Breadth scan:** none this pass (informed frontier read of contracts + app money/auth)  
**Prior package:** `REVIEW-PACKAGE.md` (2026-08-26) — several S1–S4/S6 items fixed; this pass re-verified current disk and found **new** issues plus still-open ship-blockers.

---

## Goals

- Human reviewer (pre-mainnet) gets a current, evidence-backed list of vulnerabilities and code-quality issues in the **smart contract** and the **regular app/keeper** — not a restatement of the Aug 26 package alone.
- Success looks like: reviewer can accept/reject each finding; nothing goes mainnet without independent SHIP; this seat does **not** patch (reviewers-report-only).

## Scope

**In:**

- `contracts/ondastream/assembly/ondastream.contract.ts` (1026 lines, live source)
- `app/server.js`, `auth.js`, `onda-pulse.js`, `onda-pricing.js`, `onda-wallet.js`, `stream-meter.js`
- `app/web/desktop.html`, `mobile.html`, `xpr-login.js`
- Ops scripts under `contracts/ondastream/scripts/` and `app/settle_all.mjs` / `run_settlement.sh`

**Out:**

- UI polish, mockup archives under `app/web/_archive/`
- Mainnet deploy / setcode (forbidden until invert SHIP)
- Applying fixes (apply-leg only after ACCEPT)

## Features (this product)

- Catalog + wallet-gated playback on testnet
- On-chain streaming pay: top-up (`pullbal`) default, wallet grant (`pullpay`) power-user, legacy lock (`pulse` / `s:` memo)
- Keeper `xprmusic` pulses playing sessions; pricer rewrites `tokrates`
- WebAuth / identity-proof login → 7-day HS256 JWT
- Artist self-publish (no approval gate)

## Structure (high level)

```
listener browser  --Bearer JWT / session-->  app/server.js (Hetzner :8788)
                     |                         |  static /media /web (unauth)
                     |                         |  keeper onda-pulse.js (env private key)
                     v                         v
              WebAuth wallet              XPR testnet
                     |                         |
                     +-- transfer/grant -----> ondastream (wasm)
                     |                         | inline eosio.token / xtokens
                     +-- linkauth ondapull ----+
```

**Trust boundaries:** wallet signatures; contract `requireAuth`; keeper key (can pick `songId` and call pull/pulse); `cfg.owner` (`ondaadmin`) for rates/pause/keeper; JWT secret; `ADMIN_PIN`.

**Money flow:** deposit memo `onda` → `balances` + deposit-time `maxPerTick` → keeper `pullbal(playedSec)` → `sendToken` to `songs.payout`. Grant: listener `grant` + `linkauth` → keeper `pullpay` → `sendFrom` listener@child-perm. JSON `stream-meter` is **display-only** while `payments_enabled: false` — but the keeper still moves **real testnet tokens**.

## Non-negotiables (ASVS-ish)

- [x] **Authn/authz / IDOR**
- [x] **Session / token lifecycle**
- [x] **Secrets**
- [x] **Injection / XSS / SSRF**
- [x] **Payments / mainnet**
- [ ] **Webhook authenticity** — n/a
- [x] **Supply chain** (unpinned esm.sh SDK, no git/SBOM)
- [x] **Deploy integrity** (no git; wasm hash on disk ≠ README)

## CI / automated gates (status)

| Gate | Status | Notes |
|------|--------|-------|
| Secrets scan | missing | `.gitignore` covers `auth-secret.json`; no CI |
| SCA critical | missing | lockfiles exist (`app/`, `contracts/ondastream/`) |
| Critical unit/integration tests | partial | `npm run test:meter` **10/10** (JSON meter only — **does not cover contract**) |
| Contract smoke | exists | `scripts/pay-modes-smoke.mjs` (must stay in sync with live actions) |
| SBOM at release | n/a | no release tag; tree is not git |

## How to verify

```bash
cd ~/Developer/xpr-music/app && npm run test:meter
# live catalog
curl -sS https://music.project-testing.xyz/api/catalog | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['mode'])"
# this review's findings
less ~/Developer/xpr-music/.reviews/2026-08-29-onda-pre-mainnet/02-grok-build-security.md
```

## Baseline risks (known before this pass — still true)

- `linkauth` is **not** a limited spend right; contract code is custody-grade; leaked `ondastream` key can `setcode` and drain grants.
- Freeze needs `cfg.owner` off the contract account (done: `setowner`) **then destroy contract keys**.
- Deposit-time `maxPerTick` vs `settokrate` inflation (done on `pullbal`; grant uses grant-time cap).
- Songs are ownership-immutable (`setsong` artist lock; no `delsong`).
- Keeper NET=0 trap: enroll with `eosio.proton::newaccres`, not `stakexpr`.
- xtokens hosts multiple symbols — `ExtendedSymbol` required.
- USDC/XMD oracles stale; LOAN has no feed.

## Pipeline progress

| Step | Owner | Done | Artifact |
|------|--------|------|----------|
| 0 Dossier | grok-build | [x] | this file |
| 0b Inventory | grok-build | [x] | findings §0 |
| 0c Breadth (naive M3/sentinel) | — | [ ] | not run this pass |
| 0d Informed triage | grok-build | [x] | findings file |
| 1 Composer (structural) | — | [ ] | |
| 2 Frontier security (this) | grok-build / xai | [x] | `.reviews/2026-08-29-onda-pre-mainnet/02-grok-build-security.md` |
| 3 2nd family security | **required** | [ ] | picker: openai preferred |
| 4 Merge + dispute | human | [ ] | |
| 5 Apply (grunt, not reviewer) | — | [ ] | after ACCEPT |
| 6 Independent SHIP | **unassigned** | [ ] | cannot skip |

## Verdict (this seat)

**NO-SHIP for mainnet.** Testnet may stay up. Blocking class: IDOR on account-scoped reads, unauthenticated premium media, keeper-key + keeper-chosen payout song, unfrozen contract keys, no git artifact, independent SHIP not assigned, source wasm not proven equal to on-chain code.

Human reviewer: start at `.reviews/2026-08-29-onda-pre-mainnet/02-grok-build-security.md`.
