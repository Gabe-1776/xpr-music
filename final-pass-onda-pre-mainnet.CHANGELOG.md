# Changelog — final-pass-onda-pre-mainnet

Append-only.

## 2026-08-29 — dossier opened + Grok security pass (report-only)

**Agent:** Grok Build (xai)  
**Touched:** `final-pass-onda-pre-mainnet.md`, this file, `.reviews/2026-08-29-onda-pre-mainnet/02-grok-build-security.md`, `handoff-review.md` (stage append)  
**Why:** Gabriel asked for a vulnerability + contract + app code review for a human reviewer before mainnet. Reviewers-report-only; no patches, no setcode.  
**Verified:** `cd app && npm run test:meter` → 10/10. Did not re-query on-chain `code_hash` this pass.  
**Verdict:** NO-SHIP for mainnet. Independent SHIP gate **unassigned**.  
**Highest new finding:** `scopeFor` treats `NO_ACCESS` as truthy → IDOR on library/playlists/recents via `X-Account-Actor`.  
**Still open from 2026-08-26 package:** S5 unauth media, S7 env private keys, deposit-memo retain, settle-vs-expire.

## 2026-08-29 — live vs local (Gabriel asked)

**Agent:** Grok Build  
**Verified:** SSH `root@167.233.60.62` `xpr-music.service` = active. Hetzner `server.js` / `auth.js` / `desktop.html` sha256 **match** local. Live `onda-pulse.js` is older (no `playedSec`). On-chain `get_code_hash ondastream` = `5f60a2ee…` (Aug 26 REVIEW-PACKAGE), **not** local wasm `86bb9d28…`. Live `pullbal` ABI has no `playedSec`.  
**Why:** first pass reviewed Mac source as if it were live production; keeper + contract on disk are ahead of the box/chain.
