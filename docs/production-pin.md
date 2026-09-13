# Production pin — music.project-testing.xyz

**Pinned:** 2026-09-04 — Top Up & Direct Wallet verified; partial withdrawal (`withdrawamt`); idle watchdog; Guarddog defense; live code review ready
**Updated:** 2026-09-13 — wallet SDK vendored locally (no more esm.sh CDN); greymass ESM import dropped. Bearer token memory-only + silent wallet re-auth. Exact signed amounts shown before grant/play wallet prompts. Grant timeout reconciles late wallet approvals against the on-chain row.
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
| `app/web/desktop.html` | `9878d518e131784cd156ee653d830a3752ea64a8f3fe680580f61a3ad18f4066` |
| `app/web/mobile.html` | `c931128972f9f099c97f80a122d94041c78a44afa88ea321ba93089116b78157` |
| `app/web/xpr-login.js` | `00669d6135edb9adc07a710d9a6e4dfd59b1f8b1bf41efbfecd15b348db74283` |
| `app/web/vendor/proton-web-sdk-4.4.2.bundle.js` | `be7a1f83e84f2286c666b7bf91701aed194ed62f18de8aeb00bfa7236b193da9` |
| `app/web/vendor/proton-link-3.2.4.bundle.js` | `6e985bb877d24804dd2d03522328f8ad6dd290061b92e6fc9d34e37f08523188` |
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
