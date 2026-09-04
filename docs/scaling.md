# BLUEPRINT-scale — pagination + concurrent-listener ceilings (2026-08-30)

Supersedes nothing; extends BLUEPRINT-pay-modes.md's RPC budget section with
the scaling constraints found while debugging the 2026-08-30 cadence bug.
Scope: testnet now, mainnet later. Four fixes, ordered by trigger threshold —
each is inert below its trigger and safe to ship early.

## Background: what already scales flat

- **Keeper billing is O(1) in listeners.** One `pullbal` action per playing
  listener, batched into a SINGLE transaction per 2s tick. RPC cost per tick:
  1 `get_info` + 1 `push_transaction`, whether 1 or 100 listeners play.
- **State polls are O(1) in chain load.** `/api/session/state` is a pure
  in-memory tick (server.js `sessionState`) — zero chain reads per poll after
  the 2026-08-30 refactor (mode map + piggy cached 60s, wallet display cached
  15s, USD conversion from the pricing cache).
- **Media** is static signed files off box disk with HTTP Range support —
  node/nginx-standard; scales to whatever the box's bandwidth allows.

So the ceilings are only these four:

## 1. Flat 500-row table reads (trigger: ~400 accounts)

Every grants/balances read uses `limit: 500` with **no pagination**. A
listener whose row sorts past 500 is invisible to the keeper: `pickMode`
returns null → classified `unfunded`/`nofunds` → playback stopped for a
paying user. Same for the server's `refreshOndaModes` piggy map.

**Fix (shipped in this pass):** `rows()`/`ondaRows()` gained automatic
pagination — follow `data.more`/`lower_bound` until exhausted, one page per
rate-limit slot so the 1 RPC/sec budget still holds (a 500-row page ≈ 1
call; a second page lands in the next slot, not the same second). Cap pages
at 20 (10k rows) as a runaway guard.

**Files:** `app/onda-pulse.js` (`rows`), `app/server.js` (`ondaRows`).

## 2. Batch size ceiling (trigger: ~150-200 playing listeners)

One tx with one `pullbal` per listener: at some action count the contract's
CPU/frame limits fail the whole tx (the blueprint already notes a batch is
atomic). The existing `isolateNext` fallback covers correctness — it splits
into per-listener txs on the next tick — but per-listener txs are O(N) RPC,
which collides with the 1/s budget past ~2 concurrent failures.

**Fix (shipped):** batch splitter with a fixed max-actions-per-tx (default
**25**, env `ONDA_BATCH_MAX`). Above the max, one tick sends ceil(N/25)
sequential batched txs (still flat-ish RPC: 4 txs/min for 100 listeners) —
it only degrades to per-listener isolation on an actual revert. The
TAPOS-freshness fix (invalidate after every transact) keeps each of those
txs unique.

**Files:** `app/onda-pulse.js` (`payAll` splits `targets` into chunks).

## 3. Per-play wallet hydration (trigger: high play-start churn)

`/api/session/play` → `hydrateWalletBalances(actor)` = 4 `get_currency_balance`
RPCs. 15s cache per actor:cur absorbs repeats, but a busy scene where users
hop songs every few seconds re-hydrates per play event. At 10 new
play-sessions/min that's ~40 RPC/min extra on top of the ~30/min keeper
load.

**Fix (shipped):** hydrate is still there (balances must be fresh at the
moment playback starts — it gates the piggy), but the four currency reads
are issued through the priority path (they're gating a user-visible action)
and the 15s cache dedupes the rest. Churn beyond that needs the 3-process
split below.

## 4. Single-process ceiling (trigger: ~300+ concurrent listeners / multi-box)

One `node server.js`: sessions, keeper, display cache, and HTTP all share
one event loop and one in-memory state. The three-concern split (playback
session server / keeper / display-pricing) is already cleanly separated in
code — each has its own module and single responsibility:

| Concern | Module | State it owns |
|---|---|---|
| Playback session + display | `server.js` + `stream-meter.js` | in-memory `sessions`, playhead/position, metrics |
| Keeper/biller | `onda-pulse.js` | mode map + piggy cache (60s TTL) |
| Display/pricing | `onda-wallet.js` + `onda-pricing.js` | liquid wallet cache (15s), tokrates |

Splitting later = three systemd units or one process per role behind
nginx — no protocol change: the keeper already talks only to the chain, the
pricer only to oracles+chain, and the session server only to browsers. The
keeper's `getPlaying()` callback becomes an HTTP/IPC call to the session
server (the one new transport). Not done now: zero listeners near this.

## Non-goals / do-not

- Do not remove the priority split (push/get_info bypass) — that is what
  restored the 2s cadence after the duplicate-txid regression.
- Do not re-add TAPOS caching — cached get_info = duplicate txids = the
  2026-08-30 regression. Fresh ref block per transact is the invariant.
- Do not revive the lock/buffer (BLUEPRINT-pay-modes.md, settled).

## Acceptance

- `rpc-budget-test.mjs` still passes (1/s read spacing, priority bypass).
- With 3+ playing listeners the keeper tick completes inside 2s (log check:
  no `busy` skips, no `duplicate transaction`).
- Pagination: with a synthetic >500-row table (or lowered page size), the
  keeper still sees listeners past page 1 and bills them.

---

## APPENDIX: PulseVM / A-Chain — the "native timer" question (researched 2026-09-02)

The XPR/Metal ecosystem is building **PulseVM**: an XPR-compatible
Antelope/WASM VM that runs as a subnet on Metal Blockchain (the "A-Chain").
Relevant to this blueprint's cadence problem — could a subnet give Onda a
native billing timer?

**Answer: no on-chain timer exists there either, and it never will on this
VM family.**

- PulseVM's PROTOCOL.md explicitly omits `wait_level` from the authority
  model: "does not intend to support deferred transactions." Antelope
  already deprecated/removed deferred txs entirely.
- Blocks are TRANSACTION-DRIVEN: no txs = no blocks. 500ms is a target, not
  a clock tick. Block counts ≠ elapsed time; block timestamps only.
- So an external keeper/relayer remains mandatory on ANY chain in this
  family. Our onda-pulse.js keeper is the pattern their docs prescribe.

**Where a subnet DOES change things:** a subnet operator defines its own
execution logic, tx policies, and infrastructure. A dedicated Onda subnet
could ship a native scheduler/automation layer built into the chain itself —
the only form of "the contract pulls itself" that can ever exist. Also:
running our own validator nodes gives localhost RPC (~5-20ms vs 230-600ms),
which fixes the cadence jitter at the infrastructure level.

**Status (2026-09-02):**
- PulseVM: active development, v0.7.1 (Aug 20), releases include
  pulsevm + pulse-cli + keosd binaries (linux amd64/arm64).
- A-Chain "Alpine" testnet exists (protonnz runs it) but its public endpoint
  was unreachable from our network during testing (443/9650 closed/filtered
  — IP-allowlisted or down). Community CLI tooling exists; no official
  Metallicus mainnet-launch announcement.
- Permissioned subnet deployment is supported by metal-cli (create/deploy/
  addValidator/join) on Tahoe testnet + Mainnet.

**Cost to run a dedicated Onda subnet (mainnet numbers):**
- 5+ validators (7 recommended), EACH must already validate Metal Primary
  Network with 2,000 METAL minimum staked = 10,000+ METAL total stake.
- Subnet creation ~2 METAL + 0.001/validator-add (verify live fees).
- 7 independent operators recommended (no single failure domain >20% weight).
- PulseVM itself is not yet a turnkey metal-cli VM option — custom-VM path
  (own genesis + pulsevm binary as plugin in metalgo).

**Onda port path when the time comes:** proton-tsc contracts compile to
PulseVM WASM (same account/permission/action/table model). Keeper stays as
the external trigger (per PulseVM docs' own recommendation) unless we build
the custom scheduler as subnet operators. Migration is a redeploy + wallet/
session chain-id change, not a rewrite.
