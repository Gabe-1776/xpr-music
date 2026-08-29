# Fix proposal — pay for time actually listened, not per keeper tick

author: claude-code · 2026-08-27 · **testnet only, not deployed**
reviewer: Vulcan-Venice-GLM53F (cross-model, independent — findings pending)

## The defect

`pullbal` charges a constant:

```ts
const due: u64 = rate * <u64>cfg.windowSec;      // always exactly 2s
```

It never reads how long it has actually been since `lastPull`. The keeper is
supposed to call it every 2s, so the two agree — but only if every tick lands.

They don't. In `onda-pulse.js`:

- `setInterval(..., 2000)` fires every 2s, but `if (busy) return` **discards**
  any tick that fires while the previous one is still in flight.
- `send()` awaits `transact()`, which waits for the node to accept the tx.
- Every chain call queues through one global 1-call-per-second budget
  (`rpc-budget.js`), shared with the price poller and `/api/onda/wallet`.

So one tick costs: wait for an RPC slot, broadcast, wait for acceptance. When
that exceeds 2s, the intervening ticks are dropped and never made up.

Observed live: sends at 44:27, 44:47, 44:56 — 29s of listening, 3 sends of one
window each. **6s paid out of 29s. The artist lost 79%.**

Fails in the safe direction (never double-charges, because `fuse` enforces a
minimum gap) but systematically underpays the artist.

## Why the naive fix is wrong

The obvious change — `due = rate * (now - lastPull)` — introduces a worse bug
in the other direction.

Pause is currently free precisely because the keeper stops calling. Under a
pure wall-clock charge, a listener who pauses for 60s and resumes would be
billed on the next pull for 60s they did not listen to. **That converts a
shortfall into an overcharge**, which is the direction that actually matters.

## Proposed change

Let the keeper state how much *played* time it is claiming, and have the
contract refuse to take its word for more than the clock allows.

```ts
@action("pullbal")
pullbal(listener: Name, songId: string, token: ExtendedSymbol, playedSec: u32): void {
  ...
  const now = <u32>currentTimeSec();
  const p = this.pulls.get(listener.N);

  let billable: u32 = playedSec;
  if (p != null) {
    check(now >= p.lastPull + cfg.windowSec, "fuse");   // keep the min gap
    const wall: u32 = now - p.lastPull;
    if (billable > wall) billable = wall;               // never beyond the clock
  }
  if (billable > MAX_CATCHUP) billable = MAX_CATCHUP;   // bound worst case
  check(billable >= cfg.windowSec, "below window");

  const due: u64 = rate * <u64>billable;
  ...
}
```

Three clamps, each closing a different hole:

| clamp | closes |
|---|---|
| `billable <= wall` | a buggy or hostile keeper inflating played time |
| `billable <= MAX_CATCHUP` | one call draining a large deposit |
| `billable >= windowSec` | dust-sized pulls burning RPC for nothing |

The keeper already tracks per-session play time (it only pays sessions
`getPlaying()` returns), so `playedSec` is information it genuinely has and the
contract genuinely cannot derive.

## Interaction with the deposit cap — must not be missed

`maxPerTick` is set at deposit time to `rate * windowSec * CAP_MULTIPLIER`
= 8 windows = **16 seconds** of headroom. `pullbal` enforces
`check(due <= bal.maxPerTick, "tick over cap")`.

So `MAX_CATCHUP` must be **<= CAP_MULTIPLIER * windowSec = 16s**, or a
legitimate catch-up trips the cap and the stream dies with `tickcap`. Setting
`MAX_CATCHUP = 16` exactly consumes the existing headroom; raising catch-up
beyond that requires raising `CAP_MULTIPLIER` **and** re-capping every existing
deposit, because caps are stamped at deposit time on purpose (a later
repricing must not outrun what the depositor agreed to).

## The security tradeoff, stated plainly

Today the worst a leaked keeper key can take per call is **one window (2s)**.
After this change it is **MAX_CATCHUP (16s)** — an 8x increase in per-call
exposure. The `fuse` still bounds call frequency, so the per-hour ceiling is
unchanged; only the granularity gets coarser.

That is the actual cost of this fix and it should be an explicit decision, not
a side effect.

## Also worth fixing (keeper side, no contract change)

1. `payAll()` sets `isolateNext = true` and **returns without paying anyone**
   when a batch fails. One listener's error costs every listener that tick.
2. `send()` awaiting full acceptance is what makes ticks overrun 2s. Broadcast
   without awaiting confirmation, or raise the RPC budget, would shrink the
   gaps — but cannot recover a gap already missed, which is why the contract
   change is the one that matters.

## Not done / not decided

- Nothing deployed. Testnet `setcode` is Gabriel's call.
- `playedSec` changes the action's ABI — the keeper must ship with the
  contract, or old keeper calls will fail to deserialise.
- Needs the cross-model review to land before it is worth deploying.
