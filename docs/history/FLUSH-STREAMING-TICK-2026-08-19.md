# Streaming tick flush — 2026-08-19

**Seat:** Grok Build. **App:** local Onda `http://127.0.0.1:8788`. **Chain:** XPR testnet only.

## Wallet

`music.testing` is **illegal** (XPR names: 1–12 chars, `a-z` + `1-5`, **no dots**).

Created **`musictesting`** on testnet:

| | |
|---|---|
| Created | 2026-08-19T22:16:00Z |
| Tx | `09c45cd97e5af6660d95eb902e2922b719a5c9060f751f752a74dd4624135273` |
| RAM | 5400 (4000 buyrambytes + overhead) |
| Chain XPR | 20.0000 (seed from `felixpaw`; **not** used by the app tick) |
| Keys | `~/.xpr-testnet/musictesting.key.json` + `wallets.json` (0600) |
| Explorer | https://testnet.explorer.xprnetwork.org/account/musictesting |

Proton CLI keychain was **locked** (`isLocked: true`) — `proton key:list` hangs on a password prompt. Account create used the house persist-first testnet script (`felixpaw` via `~/.openclaw/workspace/.env.xpr`, key never printed).

## What 5s / 15s actually are

| Number | What it is | In live code? |
|---|---|---|
| **per second** | `tick()` accrues `played * USD_PER_SEC` on every `/api/session/state` | **yes** — this is the live payment logic |
| **2s** | Client `setInterval(pollSession, 2000)` | yes, UI poll |
| **5s** | Client `pollNetwork` **or** old `vest::claimvest` research | **not** a payment interval |
| **15–30s** | Blueprint rolling deposit window (bounded crash loss) | **not implemented** |

`payments_enabled: false`. No chain transfers. App seed is **50 XPR simulated**, independent of the 20 XPR on-chain.

Rate: `USD_PER_SEC = 0.00005`, peg `XPR = $0.42` → **0.0001190476 XPR/s**. Catalog `rates.xpr` (0.002) does **not** drive spend.

Eligible: Signal Bloom, Night Ledger, Open Circuit. CC (Carefree etc.) is free.

## Results (actor `musictesting`, JWT via `auth.mintAccessToken`)

| Experiment | Observed | Expected if continuous | Verdict |
|---|---|---|---|
| A — Signal Bloom, **15s with zero polls**, one state | 0.00178643 XPR / $0.00075 | 0.00178571 XPR | **match** (error −3.6e-7) |
| A vs 5s chunk | — | 0.000595 XPR | **not** a 5s window |
| A vs catalog 0.002 XPR/s | — | 0.030 XPR | catalog rates unused |
| C — Carefree 5s | Δ 4.7e-7 XPR | 0 | free (delta is pause-tick jitter on the previous eligible song, ~4ms) |
| B — Night Ledger, poll every 2s × 8 (~16s) | Δ 0.00191072 XPR | 0.00191095 | **match** |

Persisted: `app/catalog/token-balances.json` → `musictesting.xpr ≈ 49.99630` (50 − A − B). Chain still 20 XPR.

Balance identity: `balance_scope: actor`, `balance_actor: musictesting`. Spend + remaining = seed.

## Correct vs blueprint

The **simulated per-second math is correct**. As of the same day, the **2s rolling hold** shipped in `app/stream-meter.js` (same vest shape as 15–30s, faster): hold 2s, vest play, rebate on pause/skip/end, stale heartbeat (>3s) vests the open window only. `payments_enabled` still false.

Verify: `cd app && npm run test:meter`

## Next (not done this session)

1. Import `musictesting` into **testnet.webauth.com / Anchor** if Gabriel wants a real desktop login (CLI keys ≠ WebAuth biometric).
2. On-chain vest contract (2s lock, quantum XPR claims) — do not flip `payments_enabled` until then.
3. Do not treat on-chain 20 XPR as the app balance.
