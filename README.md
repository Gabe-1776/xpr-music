# Onda — Real-Time Streaming Music on XPR Network

**Live Testnet Application:** https://music.project-testing.xyz  
**Network:** XPR Network (Proton Testnet)  
**Contract Account:** `ondastream` (WASM code hash: `04bbeec5f65ce81e88fc1299431ae7a11f602b14a418ea69f8a1e25d97d828fb`)

Onda is a decentralized streaming music platform powered by per-second micro-metered payments on the XPR Network. Audio is streamed and billed in real-time increments, paying creators directly on-chain every two seconds.

---

## Architecture Overview

```text
┌───────────────────────────────────────────────────────────┐
│                       Client (Web UI)                     │
│  - Vanilla JS responsive player (Desktop & Mobile)        │
│  - Timed synced lyrics, 4-decimal balance updates         │
│  - Inactivity watchdog (auto-pauses when idle)            │
└─────────────┬───────────────────────────────▲─────────────┘
              │ 2s state polls / auth         │ Audio stream
              ▼                               │
┌─────────────────────────────────────────────┴─────────────┐
│                   Backend (Node.js)                       │
│  - Stream meter & keeper daemon (onda-pulse.js)           │
│  - Priority RPC budgeting (rpc-budget.js)                 │
│  - Real-time price oracle normalization ($0.00005/sec)    │
│  - Guarddog autonomous perimeter defense & circuit breaker│
└─────────────┬─────────────────────────────────────────────┘
              │ Block-driven tick (every 2.0s)
              ▼
┌───────────────────────────────────────────────────────────┐
│              Smart Contract (ondastream)                   │
│  - AssemblyScript compiled to WebAssembly                 │
│  - 2-second billing window clamp (prevents overbilling)   │
│  - Direct artist payouts per tick (s:<songId>)            │
└───────────────────────────────────────────────────────────┘
```

### Dual Payment Modes

Onda supports two user payment models:

1. **Top Up (Balance Mode — Default):**
   - The listener deposits tokens to `@ondastream` with memo `onda`.
   - The contract credits the listener's row in the `balances` table.
   - While playing, the keeper submits `pullbal(listener, songId, token)` on every 2-second block boundary, debiting the contract balance and transferring funds directly to the artist.
   - Listeners can withdraw all or a partial amount of their balance at any time using `withdraw` or `withdrawamt`.

2. **Direct Wallet (Grant Mode — Advanced):**
   - The listener creates a limited child permission (`ondapull`) on their account linked exclusively to `eosio.token::transfer` with `ondastream@eosio.code` authority, accompanied by an on-chain `grant(listener, perm, token, maxPerTick, budget, expiresAt)`.
   - The keeper submits `pullpay(listener, songId)` every 2 seconds, pulling funds directly from the listener's wallet to the artist without requiring an escrow deposit.
   - The contract enforces the per-tick maximum, total budget, and expiration timestamp.

---

## Repository Structure

- **`contracts/ondastream/`**:
  - `assembly/ondastream.contract.ts` — Core AssemblyScript smart contract.
  - `assembly/target/` — Compiled WASM and ABI artifacts.
  - `scripts/` — Deployment, smoke test, and permission setup scripts.
- **`app/`**:
  - `server.js` — HTTP API, session management, and audio serving.
  - `onda-pulse.js` — Keeper daemon managing the 2-second on-chain pull loop.
  - `rpc-budget.js` — Priority RPC scheduler and TAPOS manager.
  - `onda-pricing.js` — Price oracle normalizer (XPR, XUSDC, METAL, LOAN, XMD).
  - `stream-meter.js` — Audio stream playback meter and session tracking.
  - `web/` — Frontend UI (`desktop.html`, `mobile.html`, `admin.html`).
  - `test/` — Unit tests and testnet E2E test harnesses.

---

## Documentation

- **[`docs/security-audit.md`](./docs/security-audit.md)** — Pre-mainnet security audit findings, remediations applied, and open contract policy decisions for review.
- **[`docs/pre-mainnet-checklist.md`](./docs/pre-mainnet-checklist.md)** — Operational checklist and deployment status before cutting to mainnet.
- **[`docs/production-pin.md`](./docs/production-pin.md)** — Authoritative hashes for live testnet code and smart contract WASM.
- **[`docs/payment-modes.md`](./docs/payment-modes.md)** — Deep dive on the Top Up vs. Direct Wallet payment architecture.
- **[`docs/scaling.md`](./docs/scaling.md)** — Multi-page table pagination, batch chunking, and RPC scalability design.

---

## Running Tests & Building

### Backend Unit Tests
```bash
cd app
npm run test:meter       # 11 unit tests for stream-meter
npm run test:pay-source   # 5 unit tests for payment mode routing
```

### Smart Contract Build
```bash
cd contracts/ondastream
npm install
npm run build            # Builds assembly/target/ondastream.contract.wasm
```

### Live Contract Hash Verification
```bash
curl -sS https://test.proton.eosusa.io/v1/chain/get_code_hash \
  -H 'Content-Type: application/json' \
  -d '{"account_name":"ondastream"}' | jq -r .code_hash
# Expected: 04bbeec5f65ce81e88fc1299431ae7a11f602b14a418ea69f8a1e25d97d828fb
```
