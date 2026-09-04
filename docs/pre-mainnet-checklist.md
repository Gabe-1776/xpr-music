# Onda — Pre-Mainnet Checklist & Status (2026-09-04)

**Date:** 2026-09-04  
**Author:** Onda Engineering Team  
**Status:** All core playback, billing, and auth features verified live on testnet (`music.project-testing.xyz`).

---

## 1. Verified Working (Done)

- **Top Up playback mode:**
  - Debits contract piggy (`ondastream::balances`) on a 2-second block cadence via keeper `pullbal`.
  - Under-billing clamp (max 2s billable per pull) protects listener.
  - Settle remainder clears clock and leftover billing on pause/skip.
- **Direct Wallet (Straight-to-Wallet) mode:**
  - One-time grant via `updateauth` (`ondapull` permission) + `linkauth` (`eosio.token:transfer`) + `ondastream::grant`.
  - Bills directly from wallet via keeper `pullpay` on same 2s cadence and rate ($0.0346 XPR/tick to artist `musictesting`).
  - Remaining budget tracked and remainder settled on pause.
- **Deposit & Partial Withdrawal:**
  - Contract `withdrawamt` action deployed (code hash `04bbeec5…`).
  - Full withdrawal and partial withdrawal live in UI.
  - Post-transaction auto-refresh (`refreshOndaBalancesAfterTx`) updates piggy, wallet balances, and credits ~1s after transaction without manual page reload.
- **Top Up / Wallet UI Separation:**
  - Top Up section simplified to single selector listing parked amounts + unified Deposit/Withdraw action.
  - "Your wallet" section displays liquid on-chain token balances and USD valuations.
- **Safety Watchdog (Auto-pause):**
  - Detects user inactivity during playback.
  - Default set to 30 minutes (options: Off / 15m / 30m / 60m).
  - Prompts with 5-minute live countdown before pausing session and settling remainder on-chain.
- **Timed Lyrics:**
  - All 34 catalog songs have `{t, text}` timestamped lyrics.
  - Desktop and mobile both highlight active line based on playback position and smooth-scroll the sheet.
- **Auth & Session Hardening:**
  - `USED_FILE` reference error fixed in `auth.js`.
  - Bearer fallback added to `/api/onda/wallet` so server restarts do not blank client wallet balances.
  - `POST /api/albums` token auth enforced (closes ONDA-API-001).
  - `writeGate(scope)` applied to all playlist mutations (closes ONDA-API-002).
  - Constant-time `checkAdminPin` with `timingSafeEqual` applied across all admin routes (closes ONDA-AUTH-003).
  - Permanent anti-replay retention in `claimProofUse` (closes ONDA-AUTH-002).
  - Full findings report written to [`security-audit.md`](./security-audit.md).

---

## 2. Remaining Checklist Before Mainnet

### A. Ops & Key Security (Pre-Mainnet)
1. **Keeper Key Isolation:**
   - Migrate `ONDA_KEEPER_PRIVATE_KEY` off broad `active` permission to a dedicated scoped permission (`ondapull` / `ondarates`).
   - Freeze or secure contract owner keys in offline keystore.
2. **Re-pin Production Hashes:**
   - Update `PRODUCTION-PIN.md` with final wasm hash (`04bbeec5…`) and app file checksums once mainnet branch cut is complete.
3. **Independent Ship-Gate Review:**
   - Assign external/independent review seat to audit final contract and server build prior to mainnet deployment.

### B. Product & Policy Decisions (Gabriel)
1. **Unknown-Memo Policy (Decision H2):**
   - Choose contract behavior for unrecognized transfer memos sent to `@ondastream`:
     - *Revert* (safer, prevents stuck funds)
     - *Refund* (automatic return)
     - *Retain* (current behavior, requires admin intervention)
2. **Guarddog Configuration Defaults:**
   - Current settings in `server.js`: `autoTimeout: false`, `tarpit: false`, `kycGate: true`.
   - Confirm whether KYC gate should remain active or revert to automated velocity timeout defaults for launch.
3. **"MPR Player" Clarification:**
   - Clarify intended scope/meaning if tuning is needed for a specific media player component or external integration.
