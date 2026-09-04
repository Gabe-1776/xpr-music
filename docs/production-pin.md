# Production pin — music.project-testing.xyz

**Pinned:** 2026-09-04 — Top Up & Direct Wallet verified; partial withdrawal (`withdrawamt`); idle watchdog; Guarddog defense; live code review ready  
**Git:** `https://github.com/Gabe-1776/xpr-music` — `main`  
**Host:** Hetzner `<DEPLOY_HOST_IP>` `/opt/xpr-music` (`xpr-music.service`)  
**URL:** https://music.project-testing.xyz  
**Chain:** XPR **testnet** account `ondastream`  
**Do not rsync** `catalog/` or `keeper.env`.

This `main` branch is a snapshot of **what is running on production/testnet**.

## App files (sha256 = live)

| File | sha256 |
|---|---|
| `app/server.js` | `244dad0588c4979a7c09d22366fed5dc9a4a060d7c171f315299ae6683e17d18` |
| `app/auth.js` | `0c6412c7ebdb206e400a711a2bdf486d92b8fa84674b506999753e896f7337fc` |
| `app/onda-pulse.js` | `4eccc324660844117f4f40e5e2d8e12cec0e0ea90e9a21a43563246acdf2f5a2` |
| `app/onda-pricing.js` | `87a11a2ee3bf5d90fd5bc3719d9db336ef5bb8a059f907c2e2038f19f600bda9` |
| `app/web/desktop.html` | `8973bef49d6fa49c37ec1c4fe8c7ed07ec8c2d15ac64fec875145c4515e29a42` |
| `app/web/mobile.html` | `a463001956dc6f4434058ab3b6efe2effe5cafc02c3c15779273d1d0e4af0fcb` |
| `app/web/xpr-login.js` | `0050268c45572cd36d548954c4ea78912dc7dc456fa048440d567bdbb330f99c` |
| `app/web/admin.html` | `02bfa31d22fffcb6ced2e15ef95141e13561b348e4cb8ce79418d595a9372bcd` |
| `app/settle_all.mjs` | `cc1b96cea788bbf952bc4e4c71ae948e0a943ddb576b3eaf0bfcae4051c77f6a` |

## Contract (live on testnet)

| | |
|---|---|
| `code_hash` | `04bbeec5f65ce81e88fc1299431ae7a11f602b14a418ea69f8a1e25d97d828fb` |
| `pullbal` ABI | `listener, songId, token` |
| `pullpay` ABI | `listener, songId` |
| `withdrawamt` ABI | `listener, token, amount` |
| owner | `ondaadmin` (migrated to `felixpaw`) · window 2s · keeper `xprmusic` |
| keys | `ondastream` keys secured (admin on `felixpaw`) |
Live contract owns the 2s clock.

## ## Flags on the box

`payments_enabled: false` · `mainnet_maintenance: true` · network `testnet`
