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
| `app/server.js` | `bf5bec87a0d328eebd1592794e071d3c46f054f3b79146e482e4cfb429056110` |
| `app/auth.js` | `b191cf3776a73432915636dd8470aebd9fa9ea137a44b26defdad87ebd6cafcd` |
| `app/onda-pulse.js` | `f0db60ea6c04af1413c1629881a484a3a4d9ddfd5f94ba60f840eb66bde03d82` |
| `app/onda-pricing.js` | `ac202be484600e599c3505487c0b60b6b91fe5fa08f140457cbc5292c07981bb` |
| `app/web/desktop.html` | `3cea7c6f097d4a1484d7a474e3d4ae0753c29705acc24c1e67e2787d4260f31e` |
| `app/web/mobile.html` | `f49bbf775cd342fa4e6e05fcc74c20035ea08c86f421a4c8e45935096ec7c50a` |
| `app/settle_all.mjs` | `cc1b96cea788bbf952bc4e4c71ae948e0a943ddb576b3eaf0bfcae4051c77f6a` |

## Contract (live, not the Mac wasm)

| | |
|---|---|
| `code_hash` | `86bb9d285dfb69fec0fe932225dd3b41cf89b7881395f3f8d62f50c386690fe5` |
| `pullbal` ABI | `listener, songId, token, playedSec` |
| owner | `ondaadmin` · window 2s · keeper `xprmusic` |
| keys | `ondastream` **still has** owner+active keys (not frozen) |

Unreleased elapsed-charge (`playedSec`, wasm `86bb9d28…`) lives on branch **`wip/elapsed-charge`**. Do not setcode it against the live 3-arg keeper, or restart the live keeper against the 4-arg wasm.

## ## Flags on the box

`payments_enabled: false` · `mainnet_maintenance: true` · network `testnet`
