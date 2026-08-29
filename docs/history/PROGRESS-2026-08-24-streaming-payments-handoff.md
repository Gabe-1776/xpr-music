# Onda / XPR Music — handoff for the next main agent
**Date:** 2026-08-24  
**Author seat:** Grok Build  
**Site:** https://music.project-testing.xyz  
**Host:** Hetzner `167.233.60.62` `/opt/xpr-music` (`systemctl restart xpr-music`, Caddy → `:8788`)  
**Local:** `~/Developer/xpr-music` (not a git repo — backups + `app/**/.versions/`)  
**Testnet chain id:** `71ee83bcf52142d61019d95f9cc5427ba6a0d7ff8accd9e2088ae2abeaf3d3dd`  
**Contract:** `ondastream` (testnet only)  
**Live wasm sha256:** `dadb8c1b2c01cf68ad2649427edf8c49b7979e363638f7a7fc77a9bd0c041cd9`

Gabriel’s last words on the money UX (do **not** implement until he says go):

> the pot refill Face-ID is worthless UX. why do we even need a pot?

He asked for this report so another main agent can continue. **Do not mainnet. Do not setcode mainnet. Do not rsync `catalog/`.**

---

## 0. First 60 seconds

1. Read this file, then `BLUEPRINT-pay-modes.md` (intent) and `BLUEPRINT.md` (product).  
2. `lesson recall --seat <you> --topic "onda streaming pot vs 2s wallet payments"`.  
3. Hard constraints below. Then the **open design call** — that is the actual next product decision, not more catalog work.

**First safe action after this report:** do **not** ship another lock-buffer tweak. Talk through the grant-once vs pot decision with Gabriel. If you must touch live first: keeper pulses are **failing** (`transaction net usage is too high: 128 > 0` on `xprmusic`) so the 2s visible transfers are **not actually landing**.

---

## 1. Hard constraints (paid for in blood)

| Rule | Why |
|------|-----|
| Testnet only until Gabriel tests and says go | Mainnet `mainnet_maintenance: true`. No mainnet `setcode`. |
| On-chain money, not JSON debit | Gabriel 2026-08-23: off-chain `token-balances.json` is pointless if we’re on XPR. |
| Payable tokens: **XPR + XUSDC only** | Not LOAN/METAL. Contract `isAccepted`. |
| Top-up memo is **`onda`**, never `deposit` | Metal X DEX empty-memo / `deposit` footgun — funds stick. |
| Server never holds `ondastream` contract key or the listener’s key | Keeper is a **third** account (`xprmusic`) and may only `pulse`/`expire`. |
| Do not rsync `catalog/` blindly | Secrets + live catalog. scp specific JSON if needed. |
| Do not reshape live tables `config` / `streams` / `songs` / `claimed` | New tables only (`rates`, `balances`, `locks`, `ops`). |
| 2s is the fuse, **not** Face-ID cadence | WebAuth prompts on every `session.transact`. Face-ID every 2s is forbidden. |
| M3 is not for this HTML | Gabriel: “m3 arent good for coding.” Flash v4 for grunt HTML. |
| Fake catalog owners cannot `setsong` | `setsong` needs the artist’s signed wallet. Payout ≠ `ondastream`, no dots. |
| Add songs via dashboard API + CLI `setsong`, not JSON dump | Gabriel rejected catalog rewrite; then rejected headed Chrome Face-ID (“use CLI and MCP”). |
| Do **not** Face-ID Gabriel for catalog add | `POST /api/submissions` as `felixpaw` then `contracts/ondastream/scripts/setsong-catalog-felixpaw.mjs` (or `cli-publish-*.mjs`). |

---

## 2. What “done” looks like from here (not shipped)

Gabriel wants **Spotify-like streaming with a visible 2s ticker in the wallet**:

- Sign **once** to start listening (or once to grant Onda a limited spend right).
- Every **2 seconds** a **real small transfer** shows in the wallet / explorer.
- **Pause / skip = no Face-ID.**
- He does **not** want a 30–180s prepaid “pot” that makes him Face-ID again when it empties.

That last point is the **open call**. Current live code still uses a pot (see §5–6).

---

## 3. What’s live right now (verified 2026-08-24)

### Site / player
- https://music.project-testing.xyz
- `chain_pay_enabled: true` · `payments_enabled: false` (JSON meter is display-only) · `mainnet_maintenance: true`
- Player: `desktop.html` / `mobile.html` + `xpr-login.js?v=7`
- Settings toggle: **Pay from wallet** \| **Pay from Onda balance**
- Artist dashboard Publish → `ondaChain.setSong` (WebAuth). CLI path used for the 34-track republish.

### Catalog
- Live `/api/catalog` **n=34**. All `owner=felixpaw`, `payout_account=felixpaw`.
- Display artist name is **destiny** (`songView` overwrites `artist` from the `felixpaw` profile).
- IDs are dashboard-style `title-xxxxxx` (e.g. `deep-devotion-266973`). Old dump ids (`deep-devotion`) are **not** in the player; leftover rows still exist on-chain.
- Mac audio kept at `app/media/songs/` (55 mp3s). Live media also has the files. Do not delete.
- Source dump: `app/catalog/.songs-source-for-dashboard-20260824T072049Z.json`

### Contract (testnet `ondastream`)
- Rates singleton: `xprPerSec=1`, `xusdcPerSec=50` (1 raw XPR unit/sec = 0.0001 XPR/s).
- `ops.keeper = xprmusic`
- Actions: `claim expire init pausesong pulse setkeeper setpaused setrate setsong settle setwindow startstream stopstream switchsong withdraw`
- Tables: `balances claimed config locks ops rates songs streams`
- Wallet play still opens a lock via transfer memo `s:<songId>` (quantity = rate × buffer, buffer 30–180s, contract `MAX_BUFFER=180`).
- Keeper `pulse(listener, songId)` every 2s: **one fuse slice**, inline `transfer` to that song’s **payout** (memo `s:<songId>`). Not wall-clock catch-up.
- Pause: client does **not** `stopstream`. Server `expire(listener)` rebates leftover to source. No vest of paused time.
- Skip: same lock; next `pulse` uses the new `songId`.

### Keeper
- Code: `app/onda-pulse.js` (loaded from `app/server.js`)
- Live env: `/opt/xpr-music/keeper.env` (0600) + systemd drop-in `xpr-music.service.d/keeper.conf` → `EnvironmentFile=-/opt/xpr-music/keeper.env`
- Journal on last restart: `onda pulse: keeper xprmusic`
- **LIVE BUG:** pulses/expires fail:

```
onda pulse felixpaw sunrise-service-85353d transaction net usage is too high: 128 > 0
onda expire felixpaw transaction net usage is too high: 104 > 0
```

`xprmusic` has ~50 XPR liquid but **NET power is 0**. 2s visible payments are **not confirming**. Fix: powerup/stake NET (and CPU if needed) on `xprmusic`, then watch journal + explorer. Do **not** put `felixpaw` or `ondastream` keys on the web server.

---

## 4. How we got here (short)

1. Vulcan JSON-debit meter. Gabriel: must be on-chain.  
2. Two modes in Settings: wallet-direct vs on-chain top-up (`BLUEPRINT-pay-modes.md`).  
3. Contract rewritten (rates / balances / locks). Memo `onda` not `deposit`. Smoke `pay-modes-smoke.mjs` PASS.  
4. UI: M3 mid-edit killed (Gabriel: M3 aren’t for coding). Opus 5 429. Flash v4 landed pay-mode UI + Publish→`setSong`.  
5. Catalog dump unpayable (`chapeldeep` / payout `ondastream`). Wiped live catalog. Re-added 34 tracks via `POST /api/submissions` + CLI `setsong` as `felixpaw`.  
6. Wallet-direct Face-ID’d **every new song** (`playFromWallet` transfer per track). Reused lock on skip.  
7. Gabriel: that’s not streaming; he wants a **2s payment in the wallet**, not a lump on pause, and **no sign on pause/skip**.  
8. Switched vest-on-time → keeper `pulse` (2s inline to artist). Pot still exists as the prepaid stash so we don’t Face-ID every 2s.  
9. Gabriel: pot refill Face-ID is worthless. **Why do we even need a pot?** Asked for this handoff. **No further pot/lock UX changes until he decides.**

---

## 5. Why the pot exists (explain this, don’t “fix” it yet)

WebAuth Face-IDs **every** `eosio.token::transfer` from the listener’s account. The chain cannot nibble `felixpaw` every 2s without:

| Path | Signatures | Visible 2s txs from listener wallet? |
|------|------------|--------------------------------------|
| Face-ID every 2s | every tick | yes — **forbidden** |
| **Pot (current):** lock buffer, contract pays artist | once per buffer (30–180s) | **no** — listener sees one lock + rebate; artist sees 2s inbound from `ondastream` (once NET works) |
| **Grant-once custom permission** | once to `updateauth`/`linkauth` a limited `onda` perm | **yes** — 2s transfers from the listener, pause/skip unsigned, no refill until revoke / cap |

The pot is a workaround for (1). Gabriel is rejecting the workaround’s UX (refill every 3 min). He has **not** yet accepted the custom-permission design.

**Grant-once sketch (not built, not approved):**
- Face-ID once: add a session/custom key on the listener, `linkauth` **only** `ondastream::pulsefrom` (or similar) that may transfer at most `rate × windowSec` per fuse.
- Not `eosio.code` on the user’s `active`. Not a key that can drain the wallet.
- Pause/skip/next song: no signature.
- Revoke on logout / Settings.
- Server still must **not** hold that user key. Either the **browser session key** signs the 2s tick, or a **keeper** keeps pulsing from an already-granted contract pull (narrower than today’s pot).

Do not implement this until Gabriel picks it.

---

## 6. Current play path (wallet mode)

```
Play  → WebAuth transfer to ondastream memo s:<songId>  (opens locks row, 30–180s)
     → audio starts
     → every 2s server keeper xprmusic::pulse(actor, songId)
           → contract sends rate×2s to songs[songId].payout  (FAILING: NET 0)
Skip  → no Face-ID; lock reused; next pulse uses new songId
Pause → no Face-ID; POST /api/session/pause → keeper expire → rebate leftover
Empty pot + Play → Face-ID again   ← Gabriel’s “worthless”
```

Balance mode: `startstream` still a signed action to open the lock from `balances`; then the same pulse loop.

---

## 7. Files that matter

| Path | Role |
|------|------|
| `contracts/ondastream/assembly/ondastream.contract.ts` | Live ABI |
| `contracts/ondastream/scripts/buyram-redeploy.mjs` | Testnet setcode |
| `contracts/ondastream/scripts/setkeeper.mjs` | `ops.keeper` (sign as **ondastream**, owner is `ondastream` not felixpaw) |
| `contracts/ondastream/scripts/cli-publish-one.mjs` / `cli-publish-rest.mjs` / `setsong-catalog-felixpaw.mjs` | Catalog add + `setsong` |
| `contracts/ondastream/scripts/pay-modes-smoke.mjs` | Older lock/rebate smoke — **not** updated for `pulse` |
| `app/web/xpr-login.js` | `ondaChain` (`playFromWallet`, `startstream`, `switchSong`, `setSong`, …) |
| `app/web/desktop.html` `mobile.html` | `ensureChainLock` reuses lock; pause does not `stopstream` |
| `app/onda-pulse.js` + `app/server.js` | 2s pulse over `sessions` where `playing && actor && songId` |
| `app/server.js` `POST /api/submissions` | Artist dashboard publish (requires `isStreamPayout`) |
| `BLUEPRINT-pay-modes.md` | **Partially stale:** top still describes vest-on-time; pulse paragraph is the 2026-08-24 intent |
| `BLUEPRINT-nft-ondastream.md` | Payee = `setsong` artist, not NFT owner. Parked. |
| `~/knowledge/tech-stack/xpr-network/onda-streaming-tick-vs-vest-2026-08-19.md` | Old 2s hold notes |

Versions: `iterate-file-version.sh` under `app/web/.versions/`, `app/.versions/`, `contracts/ondastream/assembly/.versions/`.

---

## 8. Keys / accounts (do not print PVT)

| Account | Role |
|---------|------|
| `felixpaw` | Gabriel testnet wallet. Catalog owner/payout. Funder. Env `~/.openclaw/workspace/.env.xpr` |
| `ondastream` | Contract. Key in `~/.xpr-testnet/wallets.json` + `~/.xpr-testnet/ondastream.key.json`. **Not on Hetzner.** |
| `xprmusic` | Keeper (`pulse`/`expire`). ~50 XPR liquid. Key in wallets.json. Live copy `/opt/xpr-music/keeper.env` 0600 |
| `musictesting` | Historic listener smoke wallet (dots illegal — not `music.testing`) |

WebAuth testnet: https://testnet.webauth.com  
Skill: `~/.grok/skills/xpr-network-dev` v2.3.2 · https://xprstack.info

---

## 9. Deploy recipe (when you do change live)

```bash
# contract (testnet only)
cd ~/Developer/xpr-music/contracts/ondastream
npm run build
node scripts/buyram-redeploy.mjs

# player + server — specific files only
scp app/server.js app/onda-pulse.js root@167.233.60.62:/opt/xpr-music/
scp app/web/{desktop.html,mobile.html,xpr-login.js} root@167.233.60.62:/opt/xpr-music/web/
ssh root@167.233.60.62 'systemctl restart xpr-music'

# catalog JSON only if needed — never rsync catalog/
```

Bump `xpr-login.js?v=N` in both HTML files when you change that file.

---

## 10. Suggested next steps (ordered)

1. **Talk, don’t code:** pot vs grant-once custom permission. Gabriel already said the pot refill is worthless and asked why the pot exists.  
2. **If still testing current pulse path:** powerup NET on `xprmusic` so `pulse`/`expire` actually confirm. Then Gabriel play-test as `felixpaw`, hard-refresh, watch explorer for 2s `ondastream` → `felixpaw` (same account is listener and artist on this catalog).  
3. Update `pay-modes-smoke.mjs` only after the money machine is the one he wants.  
4. Mainnet: not until he tests, invert SHIP, production-security default.  
5. NFT payee / boxes-planes: parked. Don’t revive unless he asks.

---

## 11. Grunt / seats

- Frontier (this work): Grok Build. HTML grunt: **Vulcan-Flash-v4** (`deepseek-v4-flash`). Not MiniMax-M3.  
- Flash HANDOFFs: `~/.pi/coms/projects/vulcan-jobs/HANDOFF-onda-pay-modes-ui-2026-08-23.md`, `HANDOFF-onda-artist-setsong-2026-08-24.md`.  
- Cross-model invert required before any live/money SHIP.

---

**Blocked on:** Gabriel’s call — keep a prepaid pot (maybe much larger / user-sized top-up) vs grant-once limited spend so 2s payments leave the wallet with one Face-ID ever.  
**Also blocked on:** `xprmusic` NET=0 (pulses not landing) if anyone tries to demo the current 2s ticker before that call.

---

## 12. UPDATE 2026-08-24 (Claude Code) — keeper unblocked, catalog moved off felixpaw

Gabriel's calls this session: (a) desktop gets pull-from-wallet, mobile web gets
the top-up/credits contract — "similar to how api credits for ai models work";
(b) the songs should **not** be owned by `felixpaw`.

**Done + verified:**

1. **Keeper NET fixed.** `xprmusic` had `NET=0 CPU=0` — created 2026-08-19 by raw
   `newaccount`, never enrolled. Fix was `eosio.proton::newaccres` (FREE, one
   action; `felixpaw` first-authorizer fronts the bandwidth because the target
   can't pay for its own enrollment). **Never `stakexpr`.**
   Now `NET=452611 CPU=862832`. Proven with a *self-paid* `pulse` that reached
   contract logic (`unknown song`) instead of a resource error.
   Script: `contracts/ondastream/scripts/newaccres-xprmusic.mjs`,
   `verify-keeper-selfpay.mjs`.
2. **Catalog re-owned to `musictesting`.** Song rows are ownership-IMMUTABLE
   (`setsong` checks `row.artist == artist`; there is no `delsong`), so this
   required a full re-add under new ids — not a payout edit.
   - `republish-via-submissions.mjs` now takes `ONDA_ACTOR` / `ONDA_PAYOUT`
     (defaults unchanged: felixpaw).
   - `setsong-catalog-musictesting.mjs` wrote all 34 rows on-chain.
   - RAM: a song row is **159 bytes**, paid by the ARTIST. Measured with one
     probe, then `buyrambytes` 5289 bytes (payer felixpaw) = **11.75 XPR**.
     Probe row `zz-ram-probe-*` deactivated via `pausesong`.
   - Live now: 34 songs, `owner = payout = musictesting`, listener `felixpaw`.
     **Money finally crosses accounts** — self-payment was masking authority
     bugs exactly the way it did in sigil-data.
3. **Side effect, kept deliberately:** `songView` overwrites display artist from
   the OWNER's profile. Under felixpaw all 34 flattened to "destiny"; under
   `musictesting` (no profile) the **9 real artist names are back** (Chapel Deep,
   Porchlight, Whiskey Bend, Velvet Arcade, Lunar Drift, Sorrowful Violet,
   Ghostbell, Medianoche, Aurelle). Do NOT create an artist profile for
   `musictesting` or they collapse again.

**Backups:** live `songs.json`/`recents.json` → `/opt/xpr-music/catalog/*.pre-musictesting-*`;
local pre-change catalog → `app/catalog/.backups/live-catalog-pre-musictesting-*.json`.
`recents.json` was reset to `[]` (it referenced dead felixpaw ids).

**Left alone on purpose:** 102 orphan `felixpaw`-owned rows still on-chain and
active — they are unreachable from the player (not in the catalog) and the
contract has no delete. Deactivate with `pausesong` if they ever bother anyone.

**Still open (unchanged):** the §5 pot-vs-grant decision. Gabriel has now chosen
the SPLIT: desktop = grant-once pull-from-wallet, mobile web = top-up credits.
**Known blocker for the desktop half:** WebAuth's *mobile* app silently refuses to
DISPLAY `updateauth`/`linkauth` unless connected via the "Browser" wallet option
(proven on Gabriel's phone 2026-07-11; it is why mailsigil pivoted). The axis is
**wallet transport, not device** — a desktop browser paired by QR to the phone
hits the same wall, silently. So: top-up is the universal floor, grant-once is an
upgrade attempt with a timeout and automatic fallback.
Base to copy: `~/projects/sigil-data/contracts/subscription/` (deployed,
two-party-tested). Its trap: `sendTransferToken` defaults inline auth to
`from@active` and children never satisfy parents — build the `InlineAction` with
the custom permission explicitly or every real user fails while self-tests pass.
`felixpaw` already carries a dead `sigilsub` permission linked to
`eosio.token::transfer` (leftover 2026-07-07 scaffolding, grants
`felixpaw@eosio.code`, no live subscriber) — reusing that link avoids the
`linkauth` non-idempotence rejection.

**Next:** play-test as `felixpaw`, hard-refresh, watch the explorer for 2s
`ondastream` → `musictesting` transfers now that the keeper can actually sign.

---

## 13. UPDATE 2026-08-24 (Claude Code) — desktop grant-once BUILT + PROVEN on testnet

**Product decision (Gabriel):** **top-up = the default for regular consumers**;
**direct-from-wallet (grant) = a power-user / dev-tinkering toggle.** Rationale is
the exposure asymmetry, not taste: top-up's worst case is "the balance I
deposited", the grant's worst case is "every XPR in my wallet". Build the UI that
way — grant behind an advanced section, honest warning, visible cap.

**Live wasm now `b3c8a1643d8693236597523108bd9eb2d80ab970bbdb8101742a6a4a053fe405`.**
Added: `grants` table + `grant` / `revoke` / `pullpay` actions. Existing tables
untouched. The lock/credits path is unchanged and still the fallback.

### Proven, not assumed
- **Real cross-account pull:** keeper `xprmusic` called `pullpay` 3×;
  `felixpaw 4222.7373 → 4222.7367`, `musictesting 20.0180 → 20.0186`,
  grant `spent=6/1000`. The listener signed **nothing** at pull time.
  This is the test that matters — self-payment passes even with wrong authority.
- **Revocation backstop:** after `unlinkauth`, the pull fails
  `action declares irrelevant authority '{"actor":"felixpaw","permission":"ondapull"}'`
  **while the grants row still authorizes it**. The user's chain-level revoke
  beats our contract state. Re-linked after the test.

Scripts: `grant-ondapull.mjs`, `test-pullpay.mjs`, `test-revoke.mjs`.

### The thing §5 got wrong — read this before touching the design
`linkauth` scopes **which action** may be signed. **Never an amount, never a
recipient.** There is no such thing as a permission that "may transfer at most
rate × window". `maxPerTick` and `budget` are enforced in contract code **or
nowhere**. That relocates the whole security burden into the contract.

### Custody model (what "keep the key safe" actually means)
`ondastream` is `threshold=1`, one key, in `~/.xpr-testnet/ondastream.key.json`
+ `wallets.json`. Whoever holds it can `setcode` new code that drains every
wallet holding an `ondapull` grant — the caps are code, and malicious code
simply wouldn't check them. Users grant permission to *the code*; the key holder
can swap the code.

**What the chain bounds regardless, and malicious code cannot escape:** the link
is to `eosio.token::transfer` only. It cannot change keys, cannot take over the
account, and cannot touch **XUSDC** (`xtokens` is a different contract and needs
its own separate link). Worst case is all XPR, not account takeover.

### Freeze path (the "no key needed" endgame — Gabriel's hunch, and it works)
Every admin action (`setrate` / `setwindow` / `setkeeper` / `setpaused`) already
does `requireAuth(cfg.owner)`, **not** `requireAuth(this.receiver)`. So the
contract account's keys can be removed entirely — code becomes immutable and the
grant becomes genuinely trustless — while parameters stay tunable via the owner
account. **Blocker:** `cfg.owner` is currently `ondastream` itself and there is
**no `setowner` action**; `init` is already done. Sequence must be:
add `setowner` → deploy → repoint owner to a separate admin account →
*then* freeze. Do NOT use a `waits` timelock (that bricked `sigildatasub`);
`eosio.msig` is the middle ground if immutability is too strong.

### Wallet change Gabriel should know about
`felixpaw`'s dead `sigilsub` permission was **unlinked and replaced by
`ondapull`** — one `(account, contract, action)` pair carries only one
requirement, so `eosio.token::transfer` could not hold both. Nothing live used
`sigilsub` (sigil-data's real subscribers are `sigildattst2/3`). Normal wallet
transfers are unaffected: `ondapull`'s parent is `active`, and ancestors still
satisfy the link.

### Left to build
Client only: Settings grant/revoke flow (advanced section) with the
**timeout → credits fallback** for wallets that silently swallow `updateauth`,
and the keeper choosing `pullpay` over `pulse` when a grant row exists.
Also still open from §12: pause currently calls `expire` (`server.js:1340`),
destroying remaining credit and forcing a re-sign on the next song — dropping
that one call makes the existing lock behave like credits.

### 13b. `setowner` shipped — the freeze path is now open (2026-08-24)

Gabriel: *"i like the idea of freezing the contract but the toggle functionality
stays still."* That is exactly what this design gives, and `setowner` was the
missing piece. Live wasm now
`c49373a7833291e0d217d70171ae51f5b0482d992ac5b726739e09a6cc9abaf5`.

```
setrate / setwindow / setkeeper / setpaused / setowner  ->  requireAuth(cfg.owner)
setcode                                                 ->  the contract account's own key
```

Destroy the contract account's key and the code becomes immutable (the pull
grant becomes trustless), while every toggle keeps working through `cfg.owner`.

**NOT done, deliberately — needs Gabriel's explicit go, and order matters:**
1. `setowner` → a separate admin account (NOT `ondastream`; today `cfg.owner`
   is still `ondastream`, so freezing now would kill the toggles too).
2. Verify the toggles still work signed by that new owner.
3. Only then consider freezing / `eosio.msig` on `ondastream`.
Never a `waits` timelock (bricked `sigildatasub`).

Grant survived the redeploy (`spent=8/1000`), config unchanged.
