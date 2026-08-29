# Handoff review — xpr-music

**Status:** open  
**Project path:** /Users/felix/Developer/xpr-music
**Started:** 2026-08-19  
**Last stage:** 2s rolling hold+rebate meter (Grok 2026-08-19)

## Current truth (one screen — keep updated)

- **What this is:** Onda local testnet music app; simulated streaming paywall
- **Done means:** 2s hold/vest/rebate matches tests; `payments_enabled` still false
- **Last agent / seat:** Grok Build
- **Author family:** xai
- **Authoritative reviewer family:** anthropic or minimax (invert — not Grok)
- **Invert:** yes
- **Verify command:** `cd ~/Developer/xpr-music/app && npm run test:meter`
- **Do not touch until Gabriel decides:** flipping `payments_enabled`; mainnet setcode / `mainnet_maintenance`  
- **On-chain testnet (2026-08-23):** `ondastream` pay modes LIVE; Gabriel tests after UI; then maybe mainnet

## Goals / purpose (source of truth)

- 
- **Success looks like:**  

## Non-goals

- 

## Style / architecture notes (how this tree already works)

- 

## Agents

| When | Agent | Family | Role (author / reviewer / fixer) | What they did |
|------|-------|--------|----------------------------------|---------------|
| | | | | |

**Policy:** authoritative review family ≠ author family. Canon: `~/knowledge/patterns/code-review/cross-model-review-policy.md`

## Scope paths (this cycle)

- 

## Open FLAGs for Gabriel (live board)

| # | Issue | Stage | Options | Your call |
|---|--------|-------|---------|-----------|
| | | | | |

---

## Stage log (append only — newest at bottom)

<!-- 
## Stage 0 — Dossier open (<agent>, YYYY-MM-DD)
- author_family: … · author_seat: …
- reviewer_family: … · reviewer_seat/model: … · invert: yes
- Loaded: AGENTS.md, …
- Diff base: …
- picker: `bash ~/bin/pick-cross-model-reviewer.sh <author>`

## Stage 1 — Alignment (<reviewer>, YYYY-MM-DD)
- author_family: … · reviewer_family: … · invert: yes
### Finding F-1-1
- **class:** AUTO-FIX | FLAG | INFO
- **area:** style | contract | bug | security | test | docs
- **where:**
- **issue:**
- **evidence:**
- **action:**

## Stage 2 — Correctness (…)
## Stage 3 — Security (…)
## Stage 4 — Decision board (…)
### AUTO-FIXED this pass
- 
### GABRIEL DECIDE
| # | Issue | Why not auto | Options |
|---|--------|--------------|---------|

## Stage 5 — Next agent (…)
- Solid:
- Do not touch until FLAG resolved:
- reference/repos:
- Suggested next (if unblocked):
- Next review must invert if author family changes:
-->

## Stage — 2s hold+rebate meter (Grok Build, 2026-08-19)
- author_family: xai · author_seat: grok-build
- reviewer_family: pending invert · invert: yes
- picker: `bash ~/bin/pick-cross-model-reviewer.sh grok-build`
- **What:** `stream-meter.js` 2s rolling hold; rebate on pause/skip/end; stale >3s vests the window only. Wired into `server.js` tick/play/pause/currency.
- **Verify:** `npm run test:meter` 10/10; HTTP :8788 0.5s pause = $0.000025 + rebate; CC free; 4s stale = $0.00010 hold only.
- **Not done:** UI for `held`; on-chain; `payments_enabled` remains false.


---

## Stage: post-build auto-review — 2026-08-19 (post-build-20260819-1551)
**author_seat:** grok-build  
**reviewer_seat (invert):** Vulcan-Review  
**author_family / reviewer_family:** (fill via picker --json)  
**invert:** yes (FULL/HARD)  
**class_threshold:** FULL  
**summary:** 2s rolling hold+rebate stream meter; simulated; payments_enabled false  
**scope_files≈:** 11  
**scope_lines≈:** 0  
**risk_paths:** 0  

### Scope paths
- /Users/felix/Developer/xpr-music/app/test/stream-meter.test.cjs
- /Users/felix/Developer/xpr-music/app/server.js
- /Users/felix/Developer/xpr-music/app/web/desktop.html
- /Users/felix/Developer/xpr-music/app/catalog/metrics.json
- /Users/felix/Developer/xpr-music/app/catalog/token-balances.json
- /Users/felix/Developer/xpr-music/app/package.json
- /Users/felix/Developer/xpr-music/app/stream-meter.js
- /Users/felix/Developer/xpr-music/app/.versions/server.js.20260819T224654Z.grok-build-2s-hold-rebate-meter.json
- /Users/felix/Developer/xpr-music/FLUSH-STREAMING-TICK-2026-08-19.md
- /Users/felix/Developer/xpr-music/handoff-review.md
- /Users/felix/Developer/xpr-music/BLUEPRINT.md

### AUTO-FIXED
- (author or reviewer fills)

### GABRIEL DECIDE (FLAG)
| # | Issue | Why structural | Options | Call |
|---|--------|----------------|---------|------|
|  |  |  |  |  |

### Tests / verify
- (command → result)

### Residual
- 

**Canon:** /Users/felix/knowledge/patterns/code-review/post-build-auto-review.md · classification: /Users/felix/knowledge/patterns/code-review/merge-review-pipeline.md  
**Spend:** review = frontier invert; multi-file AUTO-FIX apply = dispatch-grunt Luna (not reviewer).  
**Next:** invert seat runs stages; AUTO-FIX simple on author OR grunt multi-file; FLAG + Telegram voice if urgent.

---

## Stage: post-build auto-review — 2026-08-19 (post-build-20260819-1927)
**author_seat:** grok-build  
**reviewer_seat (invert):** Vulcan-Review  
**author_family / reviewer_family:** (fill via picker --json)  
**invert:** yes (FULL/HARD)  
**class_threshold:** HARD  
**summary:** WebAuth login: SDK v4+link@3 + sigillogin nonce fallback; play still gated; live 15/15 verify-auth  
**scope_files≈:** 20  
**scope_lines≈:** 0  
**risk_paths:** 1  

### Scope paths
- /Users/felix/Developer/xpr-music/app/test/verify-auth.mjs
- /Users/felix/Developer/xpr-music/app/server.js
- /Users/felix/Developer/xpr-music/app/web/desktop.html
- /Users/felix/Developer/xpr-music/app/web/desktop.html.bak-pre-sdkfix
- /Users/felix/Developer/xpr-music/app/web/mobile.html
- /Users/felix/Developer/xpr-music/app/web/desktop.html.bak-pre-artistlogin
- /Users/felix/Developer/xpr-music/app/web/xpr-login.js
- /Users/felix/Developer/xpr-music/app/auth.js
- /Users/felix/Developer/xpr-music/app/catalog/albums.json
- /Users/felix/Developer/xpr-music/app/catalog/library.json
- /Users/felix/Developer/xpr-music/app/catalog/token-balances.json
- /Users/felix/Developer/xpr-music/app/catalog/playlists.json
- /Users/felix/Developer/xpr-music/app/catalog/used-proofs.json
- /Users/felix/Developer/xpr-music/app/.versions/server.js.20260820T021800Z.grok-build-webauth-nonce-login-fallback
- /Users/felix/Developer/xpr-music/app/.versions/server.js.20260820T021800Z.grok-build-webauth-nonce-login-fallback.json
- /Users/felix/Developer/xpr-music/app/.versions/auth.js.20260820T021800Z.grok-build-webauth-nonce-login-fallback.json
- /Users/felix/Developer/xpr-music/app/.versions/server.js.20260820T005225Z.grok-build-re-gate-wallet-playback.json
- /Users/felix/Developer/xpr-music/PROGRESS-2026-08-19.md
- /Users/felix/Developer/xpr-music/PROGRESS-2026-08-12.md
- /Users/felix/Developer/xpr-music/BLUEPRINT.md

### AUTO-FIXED
- (author or reviewer fills)

### GABRIEL DECIDE (FLAG)
| # | Issue | Why structural | Options | Call |
|---|--------|----------------|---------|------|
|  |  |  |  |  |

### Tests / verify
- (command → result)

### Residual
- 

**Canon:** /Users/felix/knowledge/patterns/code-review/post-build-auto-review.md · classification: /Users/felix/knowledge/patterns/code-review/merge-review-pipeline.md  
**Spend:** review = frontier invert; multi-file AUTO-FIX apply = dispatch-grunt Luna (not reviewer).  
**Next:** invert seat runs stages; AUTO-FIX simple on author OR grunt multi-file; FLAG + Telegram voice if urgent.

---

## Stage: post-build auto-review — 2026-08-24 (post-build-20260824-0025)
**author_seat:** grok-build  
**reviewer_seat (invert):** Vulcan-Review  
**author_family / reviewer_family:** (fill via picker --json)  
**invert:** yes (FULL/HARD)  
**class_threshold:** FULL  
**summary:** Wiped dump catalog; re-added 34 tracks via live POST /api/submissions as felixpaw; setsong new ids on testnet; deployed player+ondaChain to Hetzner. No mainnet.  
**scope_files≈:** 11  
**scope_lines≈:** 0  
**risk_paths:** 0  

### Scope paths
- /Users/felix/Developer/xpr-music/app/server.js
- /Users/felix/Developer/xpr-music/app/web/desktop.html
- /Users/felix/Developer/xpr-music/app/web/mobile.html
- /Users/felix/Developer/xpr-music/app/web/xpr-login.js
- /Users/felix/Developer/xpr-music/app/catalog/.dashboard-republish-map.json
- /Users/felix/Developer/xpr-music/app/catalog/songs.json
- /Users/felix/Developer/xpr-music/app/catalog/albums.json
- /Users/felix/Developer/xpr-music/app/catalog/recents.json
- /Users/felix/Developer/xpr-music/app/catalog/.songs-source-for-dashboard-20260824T072049Z.json
- /Users/felix/Developer/xpr-music/app/catalog/artists.json
- /Users/felix/Developer/xpr-music/app/.versions/server.js.20260824T070935Z.grok-build-setsong-helper.json

### AUTO-FIXED
- (author or reviewer fills)

### GABRIEL DECIDE (FLAG)
| # | Issue | Why structural | Options | Call |
|---|--------|----------------|---------|------|
|  |  |  |  |  |

### Tests / verify
- (command → result)

### Residual
- 

**Canon:** /Users/felix/knowledge/patterns/code-review/post-build-auto-review.md · classification: /Users/felix/knowledge/patterns/code-review/merge-review-pipeline.md  
**Spend:** review = frontier invert; multi-file AUTO-FIX apply = dispatch-grunt Luna (not reviewer).  
**Next:** invert seat runs stages; AUTO-FIX simple on author OR grunt multi-file; FLAG + Telegram voice if urgent.

---

## Stage — pre-mainnet security + contract review (Grok Build, 2026-08-29)

- author_family: xai · author_seat: grok-build
- reviewer_family: this *is* the Grok security pass of mixed Claude/Grok tree; next authoritative invert = openai (preferred) or anthropic · invert: yes
- picker: `bash ~/bin/pick-cross-model-reviewer.sh grok-build`
- Loaded: `REVIEW-PACKAGE.md`, `FIXPROP-elapsed-charge.md`, `ondastream.contract.ts` (1026), `server.js` / `onda-pulse.js` / `auth.js`, production-security-default
- Diff base: no git (tree is not a checkout)
- **What:** report-only final-pass dossier. **NO-SHIP mainnet.** Did not patch.
- **Dossier:** `final-pass-onda-pre-mainnet.md`
- **Findings:** `.reviews/2026-08-29-onda-pre-mainnet/02-grok-build-security.md`
- **Verify:** `cd ~/Developer/xpr-music/app && npm run test:meter` → 10/10
- **Do not touch until Gabriel / human + invert SHIP:** `payments_enabled`, `mainnet_maintenance`, setcode mainnet, applying P0 without ACCEPT

### Finding F-sec-1 (P0)
- **class:** FLAG (security IDOR)
- **area:** security
- **where:** `app/server.js` `scopeFor` 755–766 after `grantAccessFor` always returns `NO_ACCESS` (truthy)
- **issue:** Bearer + `X-Account-Actor: victim` reads victim library/playlists/recents
- **action:** apply-leg after ACCEPT: deny unless `access.read`

### Finding F-sec-2 (P0)
- **class:** FLAG
- **area:** security / payments
- **where:** `GET /media/songs/**` unauthenticated (S5 still open)
- **issue:** catalog publishes file paths; paywall is client-side
- **action:** signed media URLs

### GABRIEL DECIDE
| # | Issue | Why not auto | Options |
|---|--------|--------------|---------|
| 1 | settle() vests pause vs expire rebates | product | force-vest OK vs keeper-only rebate |
| 2 | unknown transfer memos keep tokens | irreversible | revert vs retain vs admin refund |
| 3 | keeper songId binding | Face-ID vs stolen-keeper redirect | bind to listener-signed start vs accept keeper trust |
| 4 | on-chain ignores UI splits | UI lie | implement on-chain vs document 100% to payout |

**Independent SHIP:** unassigned (must not be grok-build).
