# ondastream (TESTNET)

Custom Onda music stream contract. Same **shape** as Metal X Stream / mainnet `vest`, sized for music.

Pay modes (Gabriel 2026-08-23): **wallet-direct** and **on-chain top-up**. Both vest on-chain. JSON debit is not money.

**Network:** XPR testnet only until invert SHIP. Account: `ondastream`  
**Code:** on-chain `code_hash` `5f60a2ee1e43fec519a76a584b559a052b6543785f81c274a10b56f537e3f1b0` (pin: repo `PRODUCTION-PIN.md`)  
**Deploy:** `5b7b901e36fdda7dd73a11ad395a619b1e3d41cc317d78734f67e8f331a83898`  
**Explorer:** https://testnet.explorer.xprnetwork.org/account/ondastream  
**Canon:** `~/Developer/xpr-music/BLUEPRINT-pay-modes.md`

Do **not** setcode mainnet. `mainnet_maintenance` stays true.

## Tokens

XPR (`eosio.token`, 4) and XUSDC (`xtokens`, 6) only. Memo `deposit` is **ignored** (Metal X DEX footgun). Park memo is **`onda`**.

## Actions

| Action | Who | What |
|---|---|---|
| `init` | contract | owner + window 2s |
| `setrate` | owner | catalog `xprPerSec` / `xusdcPerSec` (token units). **New singleton `rates`** — do not reshape `config`. |
| `setsong` | artist | register `songId` → payout account |
| `pausesong` | artist | deactivate |
| transfer memo `s:<songId>` | listener | wallet-direct lock at catalog rate (2–180s of rate) |
| transfer memo `onda` | listener | park into `balances` (does not start a stream) |
| `startstream` | listener | pull `rate × bufferSec` from `balances` into a lock (`source=1`) |
| `stopstream` | listener | vest elapsed; rebate to **wallet** (`source=0`) or **balances** (`source=1`) |
| `withdraw` | listener | unpark all of one token from `balances` to wallet |
| `settle` | anyone | vest elapsed; close if empty (crash drain of the open lock) |
| `claim` | artist | withdraw vested tokens |

Live testnet rate (smoke): `xprPerSec=1` (0.0001 XPR/s), `xusdcPerSec=50` (0.000050 XUSDC/s). Owner can `setrate` to match catalog USD later.

Tables: keep `config` / `songs` / `streams` / `claimed` layout. New: `rates`, `balances`, `locks`.

## Smoke (2026-08-23) PASS

`node scripts/pay-modes-smoke.mjs`

- Mode A: `musictesting` 0.0002 XPR memo `s:signal-bloom` → lock `source=0` → `stopstream` closed.
- Mode B: 0.0100 XPR memo `onda` → `balances=100` → `startstream` 30s (`source=1`, park 70) → stop rebated leftover to balances (97 after 3 units vested) → `withdraw` emptied.
- Memo `deposit` did not credit `balances`.

## Build / deploy

```bash
cd contracts/ondastream
npx proton-asc assembly/ondastream.contract.ts
node scripts/buyram-redeploy.mjs   # testnet only
node scripts/pay-modes-smoke.mjs
```

Keys: `~/.xpr-testnet/ondastream.key.json` (0600) + `wallets.json`. Never print PVT. Web server does not hold this key.
