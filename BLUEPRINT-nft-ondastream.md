# NFT mint ↔ `ondastream` — blueprint (do not implement until this is accepted)

**As of:** 2026-08-19 · **Seat:** Grok Build · **Status:** design only  
**Parent:** `BLUEPRINT.md` (rights review + 2s vest) · **Contract:** testnet `ondastream`  
**Live app:** https://music.project-testing.xyz still **simulated** (`payments_enabled: false`)

This is the join between “songs as NFTs” and the custom stream contract. It does **not** mint, does **not** change `ondastream` tables, and does **not** turn on chain payments.

---

## Law (already decided, restated so minting cannot undo it)

1. **Streaming payee is the song registry on `ondastream`, not the NFT owner.**  
   `setsong(artist, songId, payout)` is the only on-chain payout pointer.  
   A collector NFT **references** `song_id`. Transferring it must **not** move listen money.
2. **Why:** selling an NFT that captures future listener payments is an income-bearing product (securities / rights mess). Copyright does not move with an AtomicAssets transfer.
3. **Crash cap stays 2s** on `ondastream`. NFT minting does not change vest math.
4. **Testnet first.** Collection `xprmusic` is **not** created on AtomicAssets testnet yet (API returns empty templates). Mainnet mint is out of scope here.

The phrase “NFT-resolved payee” in the older architecture section of `BLUEPRINT.md` is **superseded**. Resolve payee from `ondastream.songs.payout`. Resolve *which song* from `song_id` on both the NFT template and the stream memo.

---

## Two objects, one join key

```
song_id  (catalog string, e.g. "signal-bloom")
    │
    ├─ catalog/songs.json          UI + eligibility
    ├─ ondastream.songs            artist + payout + active
    ├─ AtomicAssets template       immutable_data.song_id
    └─ transfer memo               s:<song_id>  →  start/top-up stream
```

| Object | What it is | Who owns it | Money |
|---|---|---|---|
| **Song row** | Identity + who gets streams | Artist (`setsong`) | **Yes** — `payout` |
| **Collector NFT** | Edition you can hold/sell | Whoever holds the asset | **No** — display + provenance only |
| **Stream row** | Open 2s vest for one listener | Listener (funds) / contract (RAM) | Drip to snapshotted `payout` |

Do **not** put `payout` in NFT immutable/mutable data. People will assume transfer redirects pay.

---

## What already exists (do not rebuild)

| Piece | State |
|---|---|
| Catalog originals | `signal-bloom`, `night-ledger`, `open-circuit` — `minted: false` |
| App NFT probe | `nftLinkageFor()` already matches `template.immutable_data.song_id` |
| Collection name in app | `NFT_COLLECTION = "xprmusic"`, schema `"song"` |
| Stream contract | Testnet `ondastream`, window 2s, memo `s:<songId>` |
| Registry smoke | `signal-bloom` → artist/payout `xprmusic` already on chain |
| AtomicAssets testnet | No `xprmusic` collection/templates yet |
| App payments | Still off-chain `stream-meter.js` |

---

## AtomicAssets layout (testnet)

**Contract:** `atomicassets` (standard). Author/minter: **`xprmusic`** (dapp account we already hold on testnet).

### Collection

- `collection_name`: `xprmusic`
- `author`: `xprmusic`
- `authorized_accounts`: `[xprmusic]` (add artist accounts later, not v1)
- `allow_notify`: `true` (future), **`notify_accounts`: []**  
  Do **not** notify `ondastream` on NFT transfer. That path is how people accidentally wire “new owner = new payee.”
- `market_fee`: small (e.g. 0.05) — collection fee on **sales**, unrelated to streaming.

### Schema `song`

Immutable-friendly types only for identity:

| Field | Type | On |
|---|---|---|
| `name` | string | template |
| `img` | string | template (IPFS hash later; local cover URL is fine for testnet demo) |
| `song_id` | string | **template immutable** — the join key |
| `artist` | string | template (display; not the payout Name) |
| `duration_s` | uint32 | template |
| `audio_sha256` | string | template (file provenance; from `music/` originals) |

No `payout`, no `xpr_account`, no `royalty_bps` on the NFT.

### Template (one per original track)

One template per catalog `song_id` for Music Originals. Editions = minted **assets** of that template.

- `transferable`: true (collectors can trade)
- `burnable`: true
- `max_supply`: 0 (unlimited) for v1 demo, or a small cap (e.g. 100) if we want scarcity — **product call, not a money call**
- `immutable_data.song_id` = catalog id, exact string (`signal-bloom`)

After `createtempl`, take `template_id` from the `lognewtempl` inline (indexer lag). Do not poll AA API immediately.

### Mint

v1 mint **one** asset per original to **`xprmusic`** (artist treasury / proof-of-issue). Collector sales / airdrops are later.

`mintasset`: `new_asset_owner = xprmusic`, `template_id` from above, empty extra data.

CC tracks (`carefree`, etc.): **do not mint, do not `setsong`.** They stay free and off the stream contract.

---

## How the NFT talks to `ondastream` (wiring)

The NFT never calls `ondastream`. The **app** (or a later mint script) keeps them in sync by `song_id`.

```
Artist / ops
  1. setsong(xprmusic, "signal-bloom", xprmusic)     # already done for bloom
  2. atomicassets: createcol / createschema / createtempl / mintasset
  3. catalog minted: true  (optional, UI badge)

Listener hits Play (eligible)
  4. Wallet signs eosio.token::transfer
       to: ondastream
       quantity: 2s of token  (min 0.0002 XPR today)
       memo: s:signal-bloom
  5. Contract looks up songs by hash(song_id), snapshots payout onto the stream row
  6. Pause → stopstream (rebate leftover, vest elapsed to payout)
```

**Payee snapshot:** already in `ondastream` — stream stores `payout` at start/top-up from the song row. Changing `setsong` payout does **not** rewrite an open 2s window. Next top-up / next song uses the new payout. NFT owner is never read.

**Do not** add `template_id` onto the existing `songs` table (row already live). If we want an on-chain “official template” pointer later, a **new** table `nftlink` (`songHash → template_id`) is the safe pattern. Not required to stream.

---

## App wiring (after mint, still testnet)

Keep `stream-meter.js` until wallet-signed transfers are proven in the UI.

| Step | Change | Not yet |
|---|---|---|
| 1 | Mint + catalog `minted: true` + `/api/nfts` lights up via existing matcher | — |
| 2 | Play eligible: if logged-in wallet, **also** (or instead) push `transfer` memo `s:<id>` | flipping `payments_enabled` |
| 3 | Pause: `stopstream` | — |
| 4 | Song change: new transfer after stop (contract already stops old stream on different `song_id`) | — |
| 5 | Display: “collector NFT” from `/api/nfts`, separate from “streaming to @payout” | paying NFT holder |

Guest play stays free/simulated. Only an authenticated XPR session should hit `ondastream`.

CC play: no transfer, no `setsong`.

---

## What we are not doing in this mint slice

- Mainnet collection or mainnet `ondastream`
- `notify_accounts` → `ondastream` on NFT transfer
- Payee = `atomicassets` asset owner
- Minting CC tracks
- Buy-to-own download as NFT transfer (already: download ≠ NFT)
- Master-rights token (BLUEPRINT “future option, not v1”)
- Pinata/IPFS requirement for the first testnet mint (local cover path is enough to prove the join key)
- Changing `ondastream` table schemas (songs already has a live row)

---

## Sequence (when implementing)

1. **Collection + schema** on AtomicAssets testnet as `xprmusic` (needs RAM on `xprmusic`; it is resource-poor today — `newaccres` / RAM top-up first).
2. **Template** for `signal-bloom` only (one song end-to-end).
3. **Mint** 1 asset to `xprmusic`. Confirm `/api/nfts` returns that `template_id` by `song_id`.
4. Repeat templates for `night-ledger`, `open-circuit` + `setsong` for the two not yet registered.
5. **Wallet smoke:** `musictesting` play path = transfer `s:signal-bloom` (already proven once via script) from the **app**, then `stopstream` on pause.
6. Only then discuss `payments_enabled` and invert SHIP.

---

## Open product calls (Gabriel)

1. Template `max_supply`: unlimited vs small edition cap.  
2. First minted asset: stay in `xprmusic` treasury vs airdrop to you.  
3. Covers: local URL for testnet vs IPFS before any public collector story.

None of these change the money join. Default if unspecified: unlimited supply, treasury-held proof mint, local covers.

---

## Verify when built (not now)

- AA testnet: collection `xprmusic`, schema `song`, template `immutable_data.song_id === "signal-bloom"`.
- `GET /api/nfts` lists that template and the minted asset.
- `ondastream.songs` payout still `xprmusic` after transferring the asset to `musictesting`.
- Transferring the NFT does **not** change the next stream’s `payout` snapshot.
- CC track still has no song row and no template.
