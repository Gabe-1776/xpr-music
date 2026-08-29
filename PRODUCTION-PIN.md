# Production pin — music.project-testing.xyz

**Start here for humans/agents:** [`AGENTS.md`](./AGENTS.md).

**Pinned:** 2026-08-29 (Grok Build)  
**Git:** private `https://github.com/Gabe-1776/xpr-music` — `main` = this pin (`363e0eb`); `wip/elapsed-charge` unpublished  
**Host:** Hetzner `167.233.60.62` `/opt/xpr-music` (`xpr-music.service`)  
**URL:** https://music.project-testing.xyz  
**Chain:** XPR **testnet** account `ondastream`  
**Do not rsync** `catalog/` or `keeper.env`.

This `main` branch is a snapshot of **what is running**, not the unpublished elapsed-charge work.

## App files (sha256 = live)

| File | sha256 |
|---|---|
| `app/server.js` | `6ab336780e2ca7953436c3d2b02105021fb2c881cf062e03bd09e83ced781638` |
| `app/auth.js` | `b57185c5872f60b283add43f98f747c741e3957467c990c34a442ea14f3a741e` |
| `app/onda-pulse.js` | `7d96be2019d3e7af121cb779c7d73552bd4a8d9aced05570c36022b4e93ae885` |
| `app/onda-pricing.js` | `ac202be484600e599c3505487c0b60b6b91fe5fa08f140457cbc5292c07981bb` |
| `app/web/desktop.html` | `9aa65ab32ae7e7d8df870ae40c02fc1fcb35461aff0b7c12902e4a35844d2085` |
| `app/web/mobile.html` | `f49bbf775cd342fa4e6e05fcc74c20035ea08c86f421a4c8e45935096ec7c50a` |
| `app/settle_all.mjs` | `cc1b96cea788bbf952bc4e4c71ae948e0a943ddb576b3eaf0bfcae4051c77f6a` |

## Contract (live, not the Mac wasm)

| | |
|---|---|
| `code_hash` | `5f60a2ee1e43fec519a76a584b559a052b6543785f81c274a10b56f537e3f1b0` |
| `pullbal` ABI | `listener, songId, token` — **no** `playedSec` |
| owner | `ondaadmin` · window 2s · keeper `xprmusic` |
| keys | `ondastream` **still has** owner+active keys (not frozen) |

Unreleased elapsed-charge (`playedSec`, wasm `86bb9d28…`) lives on branch **`wip/elapsed-charge`**. Do not setcode it against the live 3-arg keeper, or restart the live keeper against the 4-arg wasm.

## Flags on the box

`payments_enabled: false` · `mainnet_maintenance: true` · network `testnet`
