# XPR Music — Progress Report & Open Problem: Real Money Streaming
**Date:** 2026-08-23
**Site:** https://music.project-testing.xyz (Hetzner 167.233.60.62, /opt/xpr-music)
**Repo (local):** ~/Developer/xpr-music (NOT git-tracked — backups in app/backups/)
**Testnet:** XPR Network chain 71ee83bcf52142d61019d95f9cc5427ba6a0d7ff8accd9e2088ae2abeaf3d3dd

---

## 1. WHAT IS BUILT AND WORKING

### Streaming meter (app/stream-meter.js)
- 2s rolling hold: debit up to 2s runway into escrow → vest played-time → rebate on stop.
- USD is unit of account. `USD_PER_SEC = 0.00005` ($0.009/3-min song).
- 10/10 unit tests pass (`app/test/stream-meter.test.cjs`).
- Admin-adjustable rate at runtime (`POST /api/admin/rate`, persisted catalog/rate.json).

### Real wallet balances (just fixed)
- Logged-in wallets: server queries `get_currency_balance` per token (cached 15s).
- Token registry (all live on testnet, verified):
  | key   | contract     | symbol | precision | real price |
  |-------|-------------|--------|-----------|------------|
  | xpr   | eosio.token | XPR    | 4         | $0.0018    |
  | usdc  | xtokens     | XUSDC  | 6         | $1.00      |
  | loan  | loan.token  | LOAN   | 4         | $0.00039   |
  | metal | xtokens     | METAL  | 8         | $0.10      |
- felixpaw real balances: 5034.5541 XPR, 99.9751 XUSDC, 0 LOAN, 0 METAL.
- Zero balance shows 0 (no fake seed for logged-in wallets). Guests get SEED_BALANCE demo.

### Zero-balance playback gate (just fixed)
- `accountBalances(actor)` hydrates from chain via `hydrateWalletBalances()` on
  play/currency-switch. 0 balance → `meter.openPlay` fails → 409 insufficient balance.
- Verified: vulcanwallet (0 LOAN) → switch to LOAN → play → 409.

### Artist payouts (structure built, execution manual)
- Artist profile `payout_account` (PUT /api/artist/profile) — UI field added both platforms.
- Per-song `splits: [{wallet, pct}]` — submission form + per-song editor in artist dash
  (desktop + mobile), `GET/PUT /api/songs/:id/splits`.
- `settle_payout.mjs` — pays ONE artist (accrued → XPR at real peg), split-aware.
- `settle_all.mjs` — pays ALL artists the DELTA (accrued − settled ledger in
  catalog/settlements.json), treasury-capped, dry-run mode. launchd job
  `com.felix.xpr-settlement` runs it daily 9AM from Felix's Mac (treasury key
  `ondastream` lives there, NOT on the web server — by design).
- Treasury: `ondastream` (testnet, holds ~20 XPR). Owed right now: ~400 XPR
  (underfunded — runner caps payments to balance, defers shortfall).

### Auth
- Identity-proof login (XPR WebAuthn), single-use proofs, JWT sessions (7d).
- `auth.js` now network-aware: MAINNET_CHAIN_ID/RPC wired via NETWORKS registry,
  but `mainnet_maintenance: true` — mainnet logins still rejected until flipped.
- All chain reads (balances, agentcore, NFT) resolve RPC from `appMode.network`.

### Other completed features
- 34 AI songs (demo XPR Music tracks removed), all with real album art.
- Artist dashboard: release form (audio+cover+video upload), profile editor
  (name/bio/photo/payout wallet), albums, per-song splits editor, metrics charts.
- Library page: favorites + user playlists (rows), per-user scoping.
- Playlist/favorites/settings gated to logged-in wallets (guests read-only).
- Admin dashboard: platform-cut toggle, streaming-rate toggle, song search/delete,
  revenue card, charts, per-song plays.
- Mobile: play-all button, non-repeating shuffle + play-history prev, smooth scrub,
  video layout fixed, up-next shows album art.
- Search matches title OR artist, linked with category filter (same card row).

---

## 2. THE OPEN PROBLEM — streaming does not move real money

### What the user sees
- Balance in the player "goes down" while streaming.
- BUT the real on-chain felixpaw balance never changes. The decrement is fake.

### Root cause (verified)
- `app/server.js` line 6: "No token transfer, marketplace listing, or payment
  action is exposed." The server NEVER broadcasts a chain transaction.
- The meter debits `token-balances.json` (a local file), seeded from the chain
  balance at login. The "debit" is a local subtraction — no `eosio.token::transfer`
  is ever broadcast from the listener to anyone.
- The artist accrual (`accrued_usd` in metrics.json) is likewise a local ledger.
- Settlement (`settle_all.mjs`) DOES move real tokens (ondastream → artist wallets)
  but only when run manually/scheduled, and only from the treasury's own balance —
  it doesn't move the LISTENER's money.

### Why per-second on-chain transfers don't work
- XPR blocks every 0.5s; a transfer per listener per second would spam the chain
  and each tx has CPU/NET cost. Every real streaming service batches.

### The missing piece: LISTENER CUSTODY
The standard production architecture (what Spotify-like crypto services do):

  1. DEPOSIT: listener sends XPR from their wallet → app custody account
     (ondastream), ONCE, signed by the listener's wallet (real on-chain transfer).
     The deposit credits the listener's in-app balance.
  2. STREAM: meter debits the CUSTODY balance (real deposited funds, off-chain
     accounting) per second, and credits the artist's accrual.
  3. SETTLE: scheduled runner transfers custody → artist wallets in batches
     (already built: settle_all.mjs).

What exists: step 2 (meter) and step 3 (settlement runner).
What's MISSING: step 1 — the deposit flow. Specifically:
  a. A "Top up / Add funds" UI in the player (show custody address + memo tag).
  b. A chain-watcher: poll get_currency_balance / get_actions on ondastream for
     incoming transfers with the listener's account in the memo, credit their
     custody balance.
  c. Switch the meter's balance source from the chain-read+local-file hybrid to
     the custody balance (so the debit is against real deposited funds).
  d. Decide custody accounting: per-listener balance in token-balances.json
     works, but must be funded ONLY by verified deposits (not seeded).

### Security considerations for whoever builds this
- The deposit watcher must verify incoming transfers on-chain (get_actions /
  hyperion) — never trust a client-asserted "I sent X".
- Memo-tag attribution: transfer memo must contain the listener's account name;
  without it, deposits can't be attributed.
- The custody account (ondastream) key must stay off the web server (currently
  only on Felix's Mac — keep it that way; the watcher only READS).
- Replay/double-credit: track consumed deposit tx_ids in the ledger.

### Current account state (testnet, verified 2026-08-23)
- felixpaw:     5034.5541 XPR, 99.9751 XUSDC (the test listener)
- ondastream:   19.9978 XPR (treasury/custody — underfunded vs ~400 XPR owed)
- musictesting: Chapel Deep's payout account
- vulcanwallet: 5.0002 XPR (test wallet, 0 LOAN/METAL)

---

## 3. OTHER OPEN ITEMS (lower priority)
- Agent KYC: agentcore registry IS live on testnet (5 agents, all unclaimed
  owner:""). Human-link KYC = agent row's `owner` field. Build for mainnet
  (user decision). Needs: what KYC gates (playback? payouts? grant spend?).
- 34 seed songs have no payout_account (except per-song splits on Midnight Neon).
  Fix: artists set payout wallet on their profile, or backfill ondastream.
- Mainnet: fully wired ready (NETWORKS registry, network-aware RPC), gated by
  `mainnet_maintenance: true`. Flip = set appMode.network="mainnet" + maintenance
  false + pass "mainnet" to verify fns.
- Stale test playlists in playlists.json (diag-*, stale-*, dupe-* — session-scoped
  junk). Safe to prune.

---

## 4. KEY FILES
- app/server.js          — all API + meter wiring + real balance overlay
- app/stream-meter.js    — the billing engine (2s hold/vest/rebate)
- app/settle_payout.mjs  — single-artist settlement (manual)
- app/settle_all.mjs     — all-artist delta settlement (scheduled)
- app/auth.js            — identity-proof auth, NETWORKS registry
- app/catalog/           — songs/albums/artists/metrics/grants/balances/settlements
- app/web/desktop.html   — desktop client (single-file, ~4900 lines)
- app/web/mobile.html    — mobile client (single-file, ~4200 lines)
- ~/Desktop/XPR-Music-All-Songs/ — full backup of songs + art
- Server deploy: scp app/{server.js,stream-meter.js,auth.js} root@167.233.60.62:/opt/xpr-music/
  + web/*.html → /opt/xpr-music/web/ + `systemctl restart xpr-music`
