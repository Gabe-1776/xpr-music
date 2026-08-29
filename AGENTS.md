# Onda / xpr-music — start here

If a file disagrees with this page, **this page wins**. Dated `PROGRESS-*` / old handoffs are history, not live.

## What is live (2026-08-29 pin)

| | |
|---|---|
| Site | https://music.project-testing.xyz |
| Box | Hetzner `167.233.60.62` `/opt/xpr-music` (`xpr-music.service`) |
| Git | **private** https://github.com/Gabe-1776/xpr-music |
| Branch for the box | **`main`** — hashes in `PRODUCTION-PIN.md` |
| Chain | XPR **testnet** `ondastream` `code_hash` `5f60a2ee…` |
| `pullbal` | `listener, songId, token` — **no** `playedSec` |
| Flags | `payments_enabled: false` · `mainnet_maintenance: true` |
| Money | keeper `xprmusic` bills a **flat 2s** per successful pull (artists underpaid when ticks drop) |

**Unpublished:** branch `wip/elapsed-charge` (`playedSec`). Not on the box, not on chain. Do **not** rsync that keeper onto live without setcode of the matching wasm in the same cutover.

## Do not

- setcode **mainnet**
- flip `payments_enabled` or `mainnet_maintenance`
- rsync `catalog/` or `keeper.env`
- treat Mac leftover `.bak` / `.wip-elapsed-charge` as production
- review `assembly/target/` wasm on disk as on-chain (live hash is `5f60a2ee`, not `86bb9d28`)

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

Expected pulse sha256: `7d96be2019d3e7af121cb779c7d73552bd4a8d9aced05570c36022b4e93ae885`

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
