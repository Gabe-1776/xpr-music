# Onda / xpr-music — start here

If a file disagrees with this page, **this page wins**. Dated `PROGRESS-*` / old handoffs are history, not live.

## What is live (2026-08-29 pin)

| | |
|---|---|
| Site | https://music.project-testing.xyz |
| Box | Hetzner `167.233.60.62` `/opt/xpr-music` (`xpr-music.service`) |
| Git | **private** https://github.com/Gabe-1776/xpr-music |
| Branch for the box | **`main`** — hashes in `PRODUCTION-PIN.md` |
| Chain | XPR **testnet** `ondastream` `code_hash` `86bb9d28…` |
| `pullbal` | `listener, songId, token, playedSec` |
| Flags | `payments_enabled: false` · `mainnet_maintenance: true` |
| Money | keeper `xprmusic` bills **playedSec** (capped) via `pullbal` |

**Elapsed-charge is live** on testnet (wasm `86bb9d28…` + keeper with `playedSec`).

## Do not

- setcode **mainnet**
- flip `payments_enabled` or `mainnet_maintenance`
- rsync `catalog/` or `keeper.env`
- treat Mac leftover `.bak` / `.wip-elapsed-charge` as production
- review a wasm that is not `86bb9d28…` as on-chain

## Verify this is the live tree

```bash
# app files on the box vs this checkout
ssh root@167.233.60.62 'sha256sum /opt/xpr-music/server.js /opt/xpr-music/onda-pulse.js'
shasum -a 256 app/server.js app/onda-pulse.js
# chain
curl -s https://test.proton.eosusa.io/v1/chain/get_code_hash \
  -H 'Content-Type: application/json' -d '{"account_name":"ondastream"}'
cd app && npm run test:meter
```

Expected pulse sha256: `f0db60ea6c04af1413c1629881a484a3a4d9ddfd5f94ba60f840eb66bde03d82`

## Docs map

| Read | For |
|---|---|
| **this file** | orientation |
| `PRODUCTION-PIN.md` | live hashes |
| `BLUEPRINT-pay-modes.md` | how pay is supposed to work |
| `.reviews/2026-08-29-onda-pre-mainnet/02-grok-build-security.md` | current security findings (live-corrected) |
| `REVIEW-PACKAGE.md` | 2026-08-26 audit (historical; S1–S4 fixed on live) |
| `docs/history/` | old progress/handoffs — **not** current |

## Production security

Live/money/mainnet: `~/.pi/core/production-security-default.md`. Reviewers report-only until Gabriel ACCEPT. Independent SHIP still unassigned. No mainnet.
