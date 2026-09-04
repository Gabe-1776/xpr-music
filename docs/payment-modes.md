# Onda pay modes — settled design (2026-08-24)

Supersedes every earlier version of this file, including the vest-on-time
description at the top of the old one. Testnet only. Do not mainnet.

## The two modes, and which is the default

| | **Top-up** (default) | **Direct from wallet** (power user) |
|---|---|---|
| Audience | regular consumers | devs / tinkerers, behind an advanced toggle |
| Mental model | prepaid, like API credits | a standing debit authority |
| User signs | a plain `transfer`, memo `onda` | `updateauth` + `linkauth` + `grant`, **once ever** |
| Money moves 2s at a time from | the contract-held balance | **the listener's wallet** |
| Visible 2s ticks in the wallet | no (one deposit, then payouts from `ondastream`) | **yes** |
| Pause / skip | free | free |
| Worst case if the contract is compromised | **only the deposited balance** | **all XPR in the wallet** |
| Get money back | `withdraw`, any time — full remaining balance | nothing to get back — nothing was parked |

**Top-up is the default because of the last two rows, not because it is
simpler.** Gabriel, 2026-08-24: *"top up as default and direct from wallet as a
power user dev tinkering thing… top up for regular consumers."*

## Why a lock/buffer is not the answer (settled — stop re-deriving this)

Every `eosio.token::transfer` out of a wallet needs that wallet's signature.
So prepaid streaming time (the "lock") is what buys signature-free playback, and
its size trades directly against how often you sign:

| Buffer | Parked | Signatures/hour |
|---|---|---|
| 2s | 0.0002 XPR | 1800 |
| 30s | 0.0030 XPR | 120 |
| 180s (old `MAX_BUFFER`) | 0.0180 XPR | 20 |

Shrinking the buffer makes signing **worse**, not better. There is no constant
that gives both small commitment and no signatures — that requires either a
contract-held balance (top-up) or a standing permission (grant). Both modes below
therefore have **no lock at all**.

## Mode A — Top-up (default)

**Units: real token amounts, never a synthetic "credit".** Gabriel, 2026-08-24:
*"no need to use credits — just use the actual crypto values."* The balance IS
XPR (or XUSDC) held by the contract; show it as `0.0500 XPR`, not "500 credits"
and not raw units. The on-chain `amount` is already the token's raw integer
(XPR has 4 decimals, XUSDC 6) — divide for display, never invent a unit.
The API-credits comparison is a mental model for the *flow*, not a currency.

**Deposit.** `eosio.token::transfer` → `ondastream`, memo **`onda`** (never
`deposit` — Metal X DEX footgun, funds stick). Handled by `onTransfer`, credits
the `balances` row. **Uncapped**: the user picks the size.

**Stream.** Contract owns a 2s clock (`lastPull`). Keeper pokes while playing;
a full window pulls 2s of rate from `balances` to the song payout. No lock, no
buffer, **no re-sign** — the deposit is the only signature until it runs out.

**Pause / skip.** Poke immediately; leftover **whole second** is pulled (1s
pause → 1s charge). Not free, not a refund from the artist. Sub-second left
simple (floors away).

**Withdraw.** `withdraw(listener, token)` already exists and returns the full
remaining balance to the listener. Deposit and withdrawal are both on-chain
today; they only need UI.

**Empty balance.** `pullbal` fails `insufficient onda balance`. The server must
**stop playback and prompt a top-up** — never keep streaming audio nobody paid
for.

## Mode B — Direct from wallet (power user)

**Grant, once ever.** One atomic transaction:

```
eosio::updateauth   create `ondapull` on the listener, parent `active`,
                    authority = ondastream@eosio.code
eosio::linkauth     scope it to ONLY eosio.token::transfer
ondastream::grant   record perm + maxPerTick + budget + expiresAt
```

**Stream.** Keeper calls `pullpay(listener, songId)`; the contract sends a
transfer **from the listener** authorised by `listener@ondapull`. Real 2s
transfers leave the wallet. Nothing is prepaid.

**Revoke.** Two levels, and the UI must not conflate them:
- `ondastream::revoke` — soft, instant, only as honest as our code.
- `eosio::unlinkauth` — the real backstop. **Proven:** after unlinkauth a pull
  fails `declares irrelevant authority` even while the grants row still says it
  may pull. Offer this one.

### The security truth this design rests on

`linkauth` scopes **which action** may be signed — **never an amount, never a
recipient**. There is no such thing as a cryptographically limited spend right.
`maxPerTick` and `budget` are enforced in contract code **or nowhere**.

Therefore: whoever can `setcode` on `ondastream` can drain every granting wallet.
What the chain still bounds, and malicious code cannot escape: the link is to
`eosio.token::transfer` alone — it cannot change keys, cannot take the account,
and cannot touch XUSDC (`xtokens` is a different contract needing its own link).
Worst case is all XPR, not account takeover.

Mainnet gate: `eosio.msig` on `ondastream` at minimum; ideally `setowner` to a
separate admin account and then freeze the contract's keys, which makes the code
immutable while every toggle keeps working (all admin actions already
`requireAuth(cfg.owner)`). Never a `waits` timelock — it bricked `sigildatasub`.

## Mode selection and the silent-failure fallback

Two exclusive Settings switches. Default is **Top Up**. Switching to
**Direct Wallet (Advanced)** is the only way the keeper will `pullpay`.
A leftover `grants` row must not drain the wallet while Top Up is selected,
and parked `balances` must not drain while Direct Wallet is selected.

Persisted per actor in `catalog/pay-sources.json` (`"topup"` | `"wallet"`;
missing = topup) via `POST /api/session/pay-source`. The keeper reads
`paySource` on each live session — not grant-first chain order.

The grant UI is still behind the Direct Wallet switch, with the exposure
stated plainly and the cap visible.

**WebAuth's mobile app silently refuses to display `updateauth`/`linkauth`** —
no error, no rejection, nothing appears (proven on Gabriel's phone 2026-07-11;
it is why mailsigil pivoted). The axis is **wallet transport, not device**: a
desktop browser paired by QR to the phone fails identically. So the grant flow
must start a timer, and on timeout (~30–45s) fall back to top-up with an honest
message. Never leave a spinner waiting on a prompt that will never arrive.

## Failure handling (both modes)

| Failure | Meaning | Response |
|---|---|---|
| `declares irrelevant authority` | user revoked on-chain | mark grant dead, stop playback, offer re-grant |
| `insufficient onda balance` | credits exhausted | stop playback, prompt top-up |
| `budget exhausted` | our own cap hit | stop playback, offer to raise the budget |
| `no grant` / `no onda balance` | never set up | route to the top-up flow |

Today a failed pulse only logs. That is acceptable when money is prepaid; it is
**not** acceptable once a failure means audio is playing unpaid.

## RPC budget (hard rule)

**Never more than 1 RPC call per second, process-wide.** Enforced in
`app/rpc-budget.js`, which every chain caller shares — the keeper and the price
poller draw on ONE budget rather than each keeping their own promise.

Two things make that possible:
- **Batched pulls.** One transaction carries a slice for every playing listener,
  so RPC cost is flat in listener count. A batch is atomic, so one broke
  listener would revert everyone — on failure the next tick isolates
  per-listener to find the culprit, then resumes batching.
- **Cached `get_info`.** `transact` fetches it for TAPoS on EVERY transaction
  and never caches it; a ref block stays valid far longer, so a 10s cache
  halves spend.

Measured: **12 calls over 14s = 0.86/sec, worst 1-second window = 1**, with 5
concurrent listeners. Harness: `app/rpc-budget-test.mjs`.

**Trap for whoever measures this next:** `@proton/js`'s `JsonRpc(endpoints)`
constructor accepts ONLY endpoints — a `{ fetch }` option is in its docblock but
ignored by the implementation, so there is no transport hook. It binds
`cross-fetch` at import, so patching `globalThis.fetch` observes NOTHING, and
`app/` has its own `node_modules`, so patching the copy under `contracts/` is a
different module instance. Two false "0 calls/sec" readings came from exactly
that before the numbers above were trusted.

## Automated gate

`contracts/ondastream/scripts/pay-modes-smoke.mjs` — **14 assertions, testnet
only, restores all state on exit.** Rewritten 2026-08-24; the previous version
tested `startstream`/lock vesting, a design that no longer ships, so it would
have passed green while covering none of the live money paths.

Covers: deposit credits + sets the cap · `pullbal` pays the artist and debits
the balance · the cap BLOCKS an over-large tick · an unpriced token is refused ·
withdraw returns the remainder and clears the row · one transaction activates a
grant · `pullpay` **crosses accounts** · `unlinkauth` blocks the pull even while
the grants row still authorises it · nothing left behind.

Two deliberate design choices in the gate:
- **Cross-account pull is asserted explicitly.** A pull-payment contract is not
  tested until a pull from a DIFFERENT account succeeds — self-payment passes
  even when the authority is wrong. That exact hole shipped once in sigil-data.
- **The cap test lowers the LISTENER'S cap via `setcap`, never the global
  rate.** Rewriting `tokrates` races the live pricer's 30s poll, which resets it
  mid-window and turns a correct BLOCK into a false FAIL. Same guard, no shared
  state, no flake.

Cleanup is not cosmetic: a grant or balance left behind makes the live player
double-charge, because the keeper routes on their presence.

## Non-goals / do not revive
- No lock/buffer in either mode. `startstream` + `MAX_BUFFER` are legacy.
- No off-chain JSON debit meter. Rejected 2026-08-23: on-chain or nothing.
- No Face-ID per song, per skip, or per pause, in any mode.
- Payable tokens are **data, not code** — the on-chain `tokrates` table.
  Add/reprice/disable with `settokrate` (owner-auth); never hardcode a token again.

## Payable tokens (on-chain `tokrates`, 2026-08-24)

**Contract + symbol together are the identity** — `xtokens` hosts BOTH XUSDC and
METAL, so a contract name alone cannot name a token. `perSec` is in the token's
own raw integer units.

| Token | Contract | Precision | perSec | ≈ USD/sec |
|---|---|---|---|---|
| XPR | `eosio.token` | 4 | 1 | $0.00000018 |
| XUSDC | `xtokens` | 6 | 50 | $0.00005 |
| LOAN | `loan.token` | 4 | 1282 | $0.00005 |
| METAL | `xtokens` | 8 | 50000 | $0.00005 |
| XMD | `xmd.token` | 6 | 50 | $0.00005 |

**RESOLVED 2026-08-24 — all tokens now charge the same value per second.**
`app/onda-pricing.js` reads the on-chain `oracles` feeds and rewrites `tokrates`
so every token equals `ONDA_USD_PER_SEC` (default $0.00005/sec = $0.18/hour).
Applied once already: XPR 1 -> 178, METAL 50000 -> 21590. It only writes tokens
whose rate moved more than `ONDA_PRICE_MIN_CHANGE` (1%), and batches all
repricing into ONE transaction.

Feeds: XPR/USD (idx 3) and MTL/USD (idx 6) are live and refresh continuously.
XUSDC and XMD are **pegged at $1** in code — XMD's feed exists but has been
stale since 2022, so trusting it would be worse than the peg.
**LOAN has NO oracle feed on this chain** and is therefore a manual number
(`ONDA_LOAN_USD`); it is the one token whose price can silently go wrong.

**Deposits are capped (2026-08-24).** Every `balances` row carries `maxPerTick`,
set when money is deposited to `rate x windowSec x 8` from the price prevailing
at that moment. `pullbal` refuses a tick above it (`tick over cap`) and refuses
an unset cap (`cap unset`) rather than treating 0 as unlimited. This is what
stops a `settokrate` key from draining deposits by inflating a rate — proven
live: with the rate forced 178 -> 5000, the pull was BLOCKED and resumed
normally once restored. `setcap(listener, token, maxPerTick)` is the listener's
own escape hatch if an honest price move outgrows the cap.

**Owner split (2026-08-24).** `cfg.owner` is now **felixpaw**, not `ondastream`.
Proven both directions: felixpaw can `setwindow`; the contract's own key is
rejected with `missing authority of felixpaw`. Admin authority is off-server and
the freeze endgame is open.

**LIVE since 2026-08-24**, signed by **`felixpaw@ondarates`** — a permission
linked to `ondastream::settokrate` and nothing else. Scope verified in both
directions: ALLOWED for `settokrate`; REJECTED with *irrelevant authority* for
`setwindow`, `setowner` and `eosio.token::transfer`. Key lives in
`/opt/xpr-music/keeper.env` (0600) and in `~/.xpr-testnet/wallets.json` as
`felixpaw@ondarates`.

Never give a server the `ondastream` account key — it can `setcode` and redeploy
the contract to drain every wallet holding a grant. Worst case for THIS key is
that streams stop (`tick over cap`), because deposits are capped at the price
they were made under.

**Poll interval is 30s, not 6s.** The keeper and the pricer share ONE
1-call/sec RPC budget; at 6s the pair over-subscribes it and pulls start
queueing behind price reads. Prices do not move meaningfully in 30s, and the
drift that actually hurt (METAL at 2.3x) came from constants going stale for
weeks. Tune with `ONDA_PRICE_POLL_MS`.

**Superseded note, kept for history:** XPR is priced ~278x cheaper per
second than the others. `xprPerSec = 1` predates this work and is what all of
Gabriel's play-testing used; repricing it to USD parity (278) would make
playback 278x more expensive overnight. Decide before mainnet — either reprice
XPR to 278, or accept that XPR is the cheap tier.

Server-side mirror lives in `app/stream-meter.js` (`TOKEN_USD` /
`TOKEN_CONTRACTS`). Keep the two in step.
