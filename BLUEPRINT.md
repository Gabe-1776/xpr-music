# XPR Music — Blueprint

Web3 music streaming dapp on XPR Network. Songs are NFTs; listening streams
per-second micropayments to the creator. Spotify/Tidal-caliber UX, XPR-native
under the hood.

**Sequencing (Gabriel's call, 2026-08-08): front-end first, backend next,
smart contracts last.** This doc captures real architecture decisions made
during front-end/research work so they aren't lost before the later phases
start — not an implementation yet.

## Status

- [x] **Now Playing slide-up (2026-08-12)** — dblclick mini player chrome →
      full playing-mode sheet (center art, prev/play/next, Lyrics | Artist).
      Layout: Luna mobile nowplaying; style: desktop black/gold. Deep-link
      `?nowplaying=1`. Grok review PASS (+ shuffle/repeat active sync AUTO-FIX).
      Future: artist login dashboard, metrics, recs, real lyrics/API.
- [x] Front-end mockups (mobile + desktop) generated and reviewed —
      `frontend_mockups/`. DeepSeek-V4-Flash's payment-UI economics
      (multi-token XPR/USDC/LOAN display) and Luna's visual polish were the
      strongest; MiniMax-M3's structure was fine but visually generic
      ("missing design a bit" per review).
- [x] Real on-chain research into XPR Network's native streaming-payment
      primitive (below) — ground-truthed via live chain queries, not docs
      (several Metal X doc pages were bot-blocked; queried the real chain
      state instead).
- [x] "Now Playing" screen mockups (mobile web + desktop) generated and
      reviewed — `~/knowledge/models/grunt-orchestrator-bench-2026-08-07/frontend_bench_xpr_music_nowplaying_outputs/`.
      Real spectrum found, same shape as the browse-screen round: DeepSeek =
      maximum payment-transparency detail (power-user fit), Luna = maximum
      simplicity (best fit to the "minimal bloat" guiding principle), M3 =
      balanced middle. **Mobile web finalists (Gabriel, 2026-08-09): Luna +
      M3** — liked elements from both, plans to combine them later in an
      editing session with Vulcan. Desktop finalist not yet decided.
      **Real desktop layout defect, confirmed by inspecting both screenshots
      directly (2026-08-09)**: both M3 and Luna use a left-album-art /
      right-everything-else side-by-side split in the CENTER column, leaving
      dead empty space below the controls, instead of a centered vertical
      stack (big art on top, centered; title/artist under it; progress +
      controls under that) — the pattern that actually reads well
      (Spotify/Apple Music expanded view). Sidebar (left) and queue/payment
      panel (right) are fine in both — fix is specifically the center
      column's internal structure. Flag this explicitly when
      redoing/combining these mockups later.
      **Resolved (2026-08-09), both desktop finalists now clean**: M3 fixed
      in one pass (`minimax-m3-desktop-v2.html`). Luna took two — v2 fixed
      the center-column split but introduced a new overlap with its fixed
      bottom mini-player bar; Gabriel's better fix (remove the redundant bar
      entirely rather than pad around it, migrating its unique controls —
      volume, lyrics-view toggle, queue-view toggle — into the main card)
      produced `gpt-5.6-luna-desktop-v3.html`, clean. **Current desktop
      references: `minimax-m3-desktop-v2.html` + `gpt-5.6-luna-desktop-v3.html`.**
- [x] Custom stream contract **testnet** `ondastream` (2026-08-19) — 2s vest +
      song registry. App still simulated. See `contracts/ondastream/README.md`.
      Session write-up: `PROGRESS-2026-08-19.md`.
- [ ] NFT mint ↔ stream join — **blueprint only:**
      `BLUEPRINT-nft-ondastream.md` (payee = registry, NFT = collector).
- [ ] Backend (partial: local/Hetzner app; chain payments not wired)
- [ ] Smart contract mainnet / `payments_enabled` (not started)

## Prior art: `ny-mock` already explored this exact primitive

Found while registering this project in `~/PROJECTS.md` — `~/projects/ny-mock/`
(a static NYT-style mockup, built 2026-07-07) already designed a two-tier
`vest`-based streaming paywall (humans pay 0.0001 XPR/sec via `vest`, AI
agents pay a flat per-article fee client-UA-detected). **Never implemented**
— its README's `startvest`/`claimvest` field names are an approximation
written before real chain verification (its
`startvest(vestName, recipient, amount, duration)` doesn't match the real ABI
this session verified: `vestName, deposit, startTime, endTime, from, to,
stoppable`) — treat this session's on-chain-verified ABI below as ground
truth, ny-mock's README as an earlier, unverified sketch.

**Real, useful lead from it**: a reference implementation exists at
[`github.com/charliebot87/mpp-xpr`](https://github.com/charliebot87/mpp-xpr),
described as wrapping this exact pattern in HTTP 402 + `Authorization:
Payment` headers, with a `session()` method matching the per-second streaming
pattern. Not yet checked this session — worth pulling real source from it
before writing the custom contract, per the standing source-code-context
rule (pull real source, don't invent APIs).

**Also useful**: `paywall.js` comments name a settlement cadence — "server
`claimvest` every 5 sec while page is visible" — a real prior hypothesis
for rolling-window timing, though also unverified/never tested. Worth
treating as a starting point to test, not a given.

## Real on-chain research: the `vest` contract (2026-08-08)

XPR Network / Metal X has a native "Payment Streaming" feature (beta).
Verified for real by having Gabriel execute a live test transaction with the
`felixpaw` mainnet account, then pulling the actual on-chain result rather
than trusting marketing docs (several Metal X dev-doc pages 403'd/bot-blocked
when fetched).

**Contract account: `vest`** (mainnet). Actions: `startvest`, `stopvest`,
`claimvest`, `withdraw`, `setactor`, `setglobals`, `settoken`. Tables: `vest`,
`balances`, `allowedactor`, `allowedtoken`, `allowglobals`, `vestglobal`.

**Real test transaction** (trx `e05c8745...`, block 397135988):
```
startvest({
  vestName: "test",
  deposit: { quantity: "10.0000 XPR", contract: "eosio.token" },
  startTime: 1786256379,
  endTime: 1786342740,   // ~24h window
  from: "felixpaw",
  to: "felixpawbot",
  stoppable: true
})
```

**Mechanics, confirmed from the real `vest` table row + ABI structs (not
assumed):**
- `deposit` is locked upfront in ONE transaction (`startvest`).
- The contract tracks `vestPerSecond` and `remainingVest`, updated against
  `lastVestTime` — continuous linear accrual computed on-chain, not
  simulated by an off-chain timer.
- `claimvest(from, vestName)` — settles vested-since-`lastVestTime` into the
  `balances` table (presumably for `to`).
- `withdraw(actor, tokens[], nfts[])` — moves claimed balance to real liquid
  balance. Two-step claim-then-withdraw, standard vesting-contract pattern.
- `stopvest(from, vestName)` — **no destination override parameter.** The
  unvested remainder always returns to the ORIGINAL `from` (the listener),
  automatically. Confirmed structurally, not just assumed from the docs.
- **`allowedactor` table is EMPTY on mainnet** — no allowlist. Any account
  can `startvest` to any other account. Fully permissionless.
- **`allowedtoken` table is EMPTY too**, but real existing rows in the
  `vest` table use both `eosio.token` (XPR) and `loan.token` (LOAN) —
  multi-token already proven live on-chain, matching the XPR/USDC/LOAN spec.

**Real structural constraint this creates:** `to` is fixed per vest record.
A listening SESSION that moves across multiple songs by different artists
cannot be one continuous stream — each song change needs its own
`stopvest` (old artist) + `startvest` (new artist) pair. Cheap and fast given
XPR's zero gas fees and 0.5s blocks, but a real design fact, not a detail to
skip.

## Why the generic `vest` contract isn't enough as-is

Gabriel, 2026-08-08: "the vesting is kind of too simple for us, we might
need something more custom. we can still use its structure or logic though."

Real gaps for the music use case:
- No authoritative song/payee registry — `to` is just a raw account name the
  CALLER supplies. Nothing on-chain verifies the song or its approved artist
  payout account.
- No built-in small/rolling deposit pattern — `vest` supports arbitrarily
  large upfront locks; nothing enforces a tight, safety-conscious bound.

**Decision: build a custom contract, reusing `vest`'s proven shape** (linear
accrual, `lastVestTime`-based settlement, separate claim/withdraw steps, a
stop-with-bounded-loss safety valve) but adding:
- Stream records linked to an immutable `song_id`, not a bare account name.
- Payee resolved from the contract's artist-controlled song registry, not
  supplied blindly by the caller and not inferred from a transferable
  collector NFT.
- Small rolling deposit windows (**2s** of runway as of 2026-08-19, auto-renewed
  while playback continues; was 15–30s) instead of one big per-song upfront
  lock — see safety rationale below.

## Payment safety design (Gabriel's core requirement)

Gabriel, 2026-08-08: "we don't want to drain people's wallets if something
breaks" — the reason an escrow/locked-deposit model (rather than direct
continuous wallet-to-wallet drain) matters is that it BOUNDS the blast radius
of a stuck/non-stopped stream (app crash, dropped `stopvest` call, client
bug) to whatever was locked, never the listener's full balance.

**Resolved, not in tension:** the underlying accrual is already continuous
per-second math on-chain (`vestPerSecond`) — what determines "does this feel
live" is just how much is locked upfront, not the accrual itself. Locking a
SMALL rolling window (**2s** as of 2026-08-19, auto-topped-up while listening
continues) gets both: genuinely live per-second billing AND a tight, bounded
worst-case loss if something breaks — tighter than locking a whole song's cost
upfront.
This is the custom contract's real design target, not just "copy `vest`."

## Song identity and payout resolution — v1 revised after rights review

**v1 (decided): separate artist payout authority from collector ownership.**
Each song registry row is controlled by its verified artist account and stores
the approved `payoutAccount` plus a hash of the song's rights/provenance
manifest. A transferable collector NFT may reference the same `song_id`, but
owning or transferring that NFT does not redirect streaming income and does
not by itself convey copyright, master rights, or royalty rights.

This replaces the earlier `payee = current NFT owner` design. Selling an asset
whose holder receives future listener payments changes it from a plain
collectible into an income-bearing product, materially increasing securities
and financial-regulatory risk. Separately, an on-chain token transfer does not
execute the signed writing required to transfer U.S. copyright ownership.

**Future option, not v1:** a true master-rights token may redirect payments only
when paired with a signed off-chain rights assignment, separate composition and
sound-recording ownership schedules, identity/eligibility checks, and specialist
legal review. The token would evidence that agreement; it would not replace it.

## Agent connectivity (Gabriel, 2026-08-09)

Two genuinely different features, worth keeping cleanly separate so the
near-term build doesn't chase the speculative one:

**Near-term, real, buildable: MCP tools for agent-assisted control of a
human's own account.** "I would like to just tell my agent to turn on my
music, skip song, and top up my account." Same shape as Sigil Mail's
existing MCP tool surface (agent gets scoped tools acting on the human's own
session/wallet, not a separate agent identity) — reuse that proven pattern,
don't design a new one from scratch. Tool surface: `play`, `pause`,
`skip_song`, `add_to_playlist`, `top_up_account` at minimum.

**Speculative future, not a v1 requirement: agents as autonomous listeners**
with their own wallet, paying to stream on their own behalf ("unless agents
in the future want to listen to music"). This is the one scenario where
x402/mpp-xpr's agent-payment pattern would actually fit this project — an
agent-as-independent-economic-actor case — whereas the near-term
account-management tools above don't need it at all. Noted for later, not
scoped into the current build.

**Mechanism correction (checked against the actual skill docs, not
assumed): this is NOT a KYC feature.** KYC (`webauth-identity.md`) is
real-world identity verification for compliance — verification providers,
KYC levels, contract-side checks — unrelated to letting an agent act on your
behalf. What agent delegation actually needs is a **scoped custom
permission** on the user's XPR account (same pattern already proven in
Sigil Data's `sigildatasb2@collector` — a separate permission key, authorized
for only specific limited actions like `play`/`skip`/`top_up`, never
`withdraw everything`, handed to the agent while the user keeps
`active`/`owner`). KYC stays a separate, later concern — only relevant if
real regulated payments ever require verifying a human isn't a bot or need
identity above some payout threshold.

**Reuse Mailsigil's grants-drawer UI as the reference base for this**
(per the standing copy-and-adapt-bases practice — check for an existing
proven base before designing fresh). Mailsigil already has a live,
human-facing UI for exactly this shape of feature: granting/viewing/revoking
an agent's scoped access to your account. Gabriel's framing, 2026-08-09:
"we are pretty much helping build ai agent standards for xpr network" —
this is the second product (after Sigil Mail) independently landing on the
same scoped-permission-delegation shape; worth treating as an emerging
in-house pattern, not a one-off.

## Resolved architecture: three access surfaces, one settlement engine (2026-08-09)

Bringing MPP/x402 back in (Gabriel: "now we can bring in mpp and the 402 in
the mix") resolves cleanly into three surfaces sharing the same underlying
custom contract, not a fourth competing payment system:

1. **Human app** (native mobile/desktop) — the custom vest-based contract,
   rolling 2s windows, NFT-resolved payee. Primary experience.
2. **The user's own agent, acting on their behalf** — MCP tools
   (`play`/`skip_song`/`add_to_playlist`/`top_up_account`) via a scoped
   custom permission (Sigil Data `@collector` pattern, Mailsigil grants UI
   as the reference base). Not a payment negotiation — the agent operates
   the user's already-funded account.
3. **Any third-party AI agent, as its own independent economic actor** —
   this is where x402/mpp-xpr actually earns a place. An x402-aware agent
   (not something we built — any agent speaking the standard) hits a
   song's streaming endpoint, gets a machine-readable 402 challenge, pays
   from its own wallet, gets access. Modernizes `ny-mock`'s original
   "AI agent flat-rate tier" idea (fragile client-side UA-sniffing) into a
   real, interoperable standard.

**Why this doesn't fragment into competing systems**: x402's static
per-service `recipient` (the earlier-identified limitation) isn't a blocker
here — for surface 3, the x402 recipient is simply *the platform account*,
which then internally resolves and routes payment to the current song's
NFT-designated payee using the SAME custom contract mechanics surface 1
uses. Two front doors (native UI, x402 endpoint), one settlement engine
underneath.

## Third-party funding: agent tops up the human's account from its own wallet (2026-08-09)

Gabriel: "ai agent being able to top up your account from the agents wallet
would be nice too... things are leaning towards you give an agent its own
money account and it pays for your stuff. but human can also pay for
himself from his account."

**Not new infrastructure to build — this pattern already runs live in the
ecosystem.** The testnet wallet fleet already has agent-persona accounts
with their own real balances (`felixpawbot`, `vulcanwallet`) — "agents hold
their own money" is proven, not hypothetical, here.

**Design implication for the custom contract's top-up/deposit action**:
treat **payer** and **beneficiary** as separate fields from day one, not
"from == to" implicitly. Any account — the human's own wallet, their agent's
separate wallet, in principle anyone gifting credit — can fund a *specified*
account's balance. Build this as a first-class path now rather than an
awkward retrofit later if the deposit action is only designed for
self-funding initially.

**Resulting model**: humans fund themselves directly, OR rely on their own
agent to fund them from the agent's separate treasury — both paths land in
the same place (a top-up into the human's balance), settled identically
underneath.

## Additional pricing tiers beyond streaming (Gabriel, 2026-08-09)

Two new ideas, deliberately kept simple per the guiding principle below —
neither needs the vest-based streaming mechanics at all:

**Buy-to-own (permanent download)**: a flat, one-time payment — shape is
closer to `xpr.charge()` than `vest`, no per-second logic. Open product
decision: buying a download should NOT transfer any NFT rights — it's a
personal-use copy; the NFT (and its royalty-collecting role) stays with the
creator. Keeps "NFT = rights/royalty instrument" and "download = personal
copy" as two clean separate things instead of tangled together.

**Offline listening**: real complexity flagged, then deliberately avoided
for v1. If offline plays paid the creator per-second like live streaming,
the app would need to track plays locally while offline and reconcile once
reconnected — a real trust/spoofing problem (a local play-log is easy to
fake without heavy client-side tamper-resistance work). Decided: sidestep
this for v1 — **charge a flat fee for offline access** (one-time or
time-boxed download-for-offline purchase, priced to approximate expected
plays), not metered per-second. No offline-verification problem to solve.
Precise offline metering can be revisited later if it turns out to matter.

## Guiding principle (Gabriel, 2026-08-08)

**"Simple, easy to use, user friendly, minimal bloat."** Stated as the main
thing to optimize for across this whole project — applies to every future
decision (backend, contract design, UI), not just the payment mechanics.
When in doubt between a more sophisticated option and a simpler one that's
seamless for the user, default to simple.

## Decided

- **Rolling deposit window: 2 seconds.** Gabriel 2026-08-19 — same vest
  shape as the earlier 15–30s call, faster scale. Hold 2s of runway in
  escrow; vest actual play into spend; **rebate unused escrow on pause /
  skip / track end**. Crash (no heartbeat for > 3s = 2s window + 1s grace)
  vests the open window, no rebate — max loss $0.00010. Accrual is still
  per-second USD (`USD_PER_SEC`). Live in `app/stream-meter.js` (simulated;
  `payments_enabled` still false). On-chain claims stay quantum (XPR 4dp).

## Open, not yet decided

- Whether `claimvest`-equivalent settlement happens per top-up cycle or is
  batched less often.
- Royalty splits (multiple payees per song) — not discussed yet.
- Whether the custom contract forks/extends `vest` directly or is written
  fresh using it only as a reference.

## Base decisions (Gabriel, 2026-08-11)

- **Now Playing mobile base:** `gpt-5.6-luna-mobile.html` (from `~/knowledge/models/grunt-orchestrator-bench-2026-08-07/frontend_bench_xpr_music_nowplaying_outputs/`) — picked by Gabriel as "best mobile" from the full mockup lineup (DeepSeek/Luna/M3, browse + now-playing rounds).
- **Desktop browse base:** `gpt-5.6-luna-desktop.html` (layout/structure — Gabriel: "this was good")
- **Desktop styling base:** `deepseek-v4-flash-desktop.html` (visual styling — Gabriel: "this styling was good")
- **Direction:** Luna shell + DeepSeek style language on desktop; Luna Now Playing on mobile. Payment components inherit DeepSeek's multi-token economics where relevant.
- **Feature set (from DeepSeek "Onda" — Gabriel approved 2026-08-11):** live network payout ticker; multi-token per-second rates (XPR/USDC/LOAN) + token switcher; session spend accumulator; NFT-native badges + "Newly minted" shelf; creator-visible live payouts; wallet-connected header state. Brand concept name on file: "Onda".

## Design confirmations from live testing (Gabriel, 2026-08-11)

- **Mobile Now Playing view (web/mobile.html): APPROVED** — "love this style, flows so good." The Luna-based flow (art → track → meter) is the confirmed mobile design language; keep future mobile screens in this idiom.


## Hosting analysis — recommended topology, not yet deployed (2026-08-11)

The useful comparison is not "Hetzner versus wherever xpragents.com runs" as
one all-or-nothing host. The application has three different traffic shapes
and should split them:

1. **Static player UI:** a global edge host such as Cloudflare Pages or
   Vercel. Live headers checked on 2026-08-11 show `xpragents.com` is served
   by Vercel (`server: Vercel`, `x-vercel-cache: HIT`, observed edge
   `fra1`), not from a special XPR-adjacent application server. Co-locating
   with that site gives no blockchain advantage.
2. **Session/payment/catalog API:** a small persistent Node service on
   Hetzner is the least disruptive fit for the current zero-dependency
   server. Keep this control plane out of the audio byte path. A dedicated
   service/VM is preferable to adding another heavy tenant to the existing
   mailsigil production box.
3. **Audio delivery:** Cloudflare R2 Standard behind a production custom
   domain such as `media.<music-domain>`, with Cloudflare Cache. R2 has free
   Internet egress, 10 GB-month and 10 million Class B reads/month free, and
   Standard storage is $0.015/GB-month beyond that. Cloudflare caches MP3 by
   default and serves client Range requests as `206 Partial Content` when
   the object has `Content-Length`. This is the part that makes playback
   globally fast; neither a single Falkenstein server nor Vercel functions
   should carry every audio byte.

Why not put everything on Vercel: Vercel is good for the UI, but audio is
metered Fast Data Transfer. Its published regional pricing lists the first
1 TB included for the applicable plan and then $0.15-$0.35/GB. R2's Internet
egress is free. Why not direct Hetzner Object Storage: the existing account
already includes pooled storage/egress and is useful as an origin or backup,
but its storage locations are FSN1/NBG1/HEL1 rather than a global playback
edge. Adding a CDN in front recreates the R2/custom-domain shape with more
origin plumbing.

Current demo media is 31.68 MiB across 934 seconds (average 284.5 kbps), or
about 122.1 MiB per listener-hour. At that rate 10,000 listener-hours is
roughly 1.2 TiB. Audio egress—not catalog JSON or XPR RPC latency—is the
scaling cost.

Before deployment, fix two concrete delivery issues:

- `app/server.js::serveStatic` always responds `200` and streams the whole
  file; it does not implement `Range`, `Content-Range`, `Accept-Ranges`, or
  `206`.
- Both web views use `preload="auto"` for the current and next track. That
  can fetch two high-bitrate files before the user listens. Use metadata-only
  loading for the demo and let the media CDN handle seeks.

For the public demo, immutable versioned MP3 objects with long cache headers
and Range support are sufficient. Before real per-second payments, do not
hand out a permanent public full-track URL: issue a short-lived playback
token after funding the rolling window and validate it at the media edge.
If bypass-resistant per-second metering becomes a launch requirement, move
to short HLS segments aligned with the 2 second rolling deposit window;
do not add HLS merely for the five-song demo.

Official references:

- Cloudflare R2 pricing: https://developers.cloudflare.com/r2/pricing/
- R2 public buckets/custom-domain caching:
  https://developers.cloudflare.com/r2/buckets/public-buckets/
- Cloudflare cache Range behavior:
  https://developers.cloudflare.com/cache/concepts/default-cache-behavior/
- R2 durability and availability:
  https://developers.cloudflare.com/r2/reference/durability/
- Vercel CDN pricing:
  https://vercel.com/docs/pricing/regional-pricing
- Hetzner Object Storage locations and included quotas:
  https://www.hetzner.com/storage/object-storage/

## AI-music NFT launch guardrails (rights and regulatory review, 2026-08-11)

This is a U.S.-oriented product-risk analysis, not legal clearance. Mainnet
sales and the streaming escrow should receive review from counsel experienced
in music rights and digital assets before public launch.

### What is safe to build first

Use a **collector NFT**, not a "song ownership" or revenue-share NFT:

- The buyer owns the token. The token does not transfer copyright, master
  rights, publishing rights, streaming revenue, equity, profit share, or a
  promise of appreciation.
- Collector ownership never changes the artist's streaming `payoutAccount`.
- Do not fractionalize it, promise yield/buybacks/floor support, or market it
  as an investment. Creator secondary-sale fees may be configured where the
  marketplace honors them, but must not be described as guaranteed.
- Metadata and sale terms must say exactly what the buyer receives. Safe v1:
  the collectible, provenance, and a personal display/listening license to the
  NFT artwork/preview. Public playback rights remain governed separately.

The five current demo tracks are Kevin MacLeod works distributed under CC BY
4.0. That license permits commercial reuse with attribution, but it does not
make XPR Music or Gabriel the author or exclusive owner. Keep those tracks as
licensed demo content; do not sell them as artist-owned or exclusive music NFTs.

### Clearance required for each separately AI-generated song

Create a rights/provenance manifest before even a testnet mint:

1. Song title and immutable audio hash; separate composition and sound-recording
   ownership conclusions.
2. Generator/service, model, account plan, generation date, and a saved copy or
   hash of the commercial-use terms that applied on that date.
3. Prompts, human-written lyrics/melody/MIDI/stems, DAW project, edits,
   arrangement, performance, and production notes showing the human contribution.
4. Every collaborator's signed split/release; every sample, loop, cover-art,
   voice, likeness, and trademark license.
5. An explicit AI-assistance disclosure and a confirmation that the song does
   not imitate an identifiable person's voice or persona without consent.

Commercial-use permission in a generator's terms is necessary but is not proof
that the output has copyright protection. The U.S. Copyright Office's January
2025 report says prompts alone ordinarily do not supply sufficient human
authorship. Copyright may cover perceptible human-authored expression and
sufficiently creative human selection, arrangement, or modification. Any
registration must disclose more-than-de-minimis AI-generated material and claim
only the human-authored parts.

Music also contains two distinct works: the **musical composition** and the
**sound recording**. A clearance manifest must address both. No uncleared
samples and no cloned or confusingly similar celebrity voice should reach the
catalog, IPFS/R2, testnet, or mainnet.

### Testnet-to-mainnet sequence

1. **Local dry run:** prepare one provenance manifest, buyer-facing NFT terms,
   metadata, and hashes. Review every claim in the mint/listing UI.
2. **Testnet, free only:** create a dedicated test collection/schema/template
   with AtomicAssets and mint one clearly labeled test collector asset directly
   to a controlled MailSigil-created test wallet. Do not call AtomicMarket
   `announcesale`, set a sale price, or expose buy/checkout controls. Test mint,
   free transfer between controlled wallets, burn policy, metadata rendering,
   and payout non-interference. Use a Music Originals track or neutral dummy
   asset—not the Kevin MacLeod placeholders. Testnet is public and durable, so
   the metadata must say `TESTNET`, `NO SALE`, and `NO RIGHTS TRANSFER`.
3. **Mainnet pilot:** after rights review and counsel sign-off, mint one
   one-of-one or small fixed edition through AtomicAssets and list through an
   established marketplace flow. Keep sale proceeds buyer-to-market-to-seller;
   do not add a platform-custodied balance or custom exchange for v1.
4. **Operations:** retain transaction IDs, wallet/account identities, the USD
   fair market value at each receipt/disposition, fees, basis, and rights-term
   versions. Digital-asset income is taxable even when paid in XPR.
5. **Compliance gate:** screen the business model for OFAC/sanctions exposure.
   Obtain a specific FinCEN/state money-transmission analysis before operating
   the rolling-deposit contract for third-party listeners and artists; FinCEN
   classifies by actual acceptance/transmission activity, not by "dapp" or
   "noncustodial" labels.

### Explicitly out of v1

- Selling the current demo tracks as owned originals.
- "Buy this song," "own the master," "earn streaming royalties," or equivalent
  claims for a collector token.
- Current-NFT-owner payment routing, fractional rights, revenue shares, staking,
  yield, redemption, buybacks, or price-support promises.
- A platform-run custodial NFT marketplace, internal customer balances, fiat
  conversion, or off-ramp.

If a later product truly sells master or publishing rights, it is a different
regulated product. U.S. copyright ownership transfer requires a signed writing
under 17 U.S.C. § 204(a); token transfer alone is insufficient. The agreement
must separately identify composition and sound-recording rights, scope,
territory, term, royalties/accounting, prior licenses, representations,
termination, and what happens when token and contract ownership diverge. The
NFT should contain a hash/reference to the executed agreement, and transfer
should be restricted until identity, agreement, and securities review pass.

Primary references:

- U.S. Copyright Office, *Copyright and Artificial Intelligence, Part 2:
  Copyrightability*:
  https://www.copyright.gov/ai/Copyright-and-Artificial-Intelligence-Part-2-Copyrightability-Report.pdf
- U.S. Copyright Office/USPTO, *Non-Fungible Tokens and Intellectual Property*:
  https://www.copyright.gov/policy/nft-study/Joint-USPTO-USCO-Report-on-NFTs-and-Intellectual-Property.pdf
- Copyright ownership/transfer, 17 U.S.C. §§ 202 and 204:
  https://www.copyright.gov/title17/92chap2.html
- Copyright Office, musical compositions versus sound recordings:
  https://www.copyright.gov/register/pa-sr.html
- Creative Commons Attribution 4.0:
  https://creativecommons.org/licenses/by/4.0/
- SEC Release No. 33-11412, digital collectibles and investment contracts:
  https://www.sec.gov/rule-release/33-11412
- FinCEN FIN-2019-G001, CVC business models and DApps:
  https://www.fincen.gov/system/files/2019-05/FinCEN%20Guidance%20CVC%20FINAL%20508.pdf
- OFAC virtual-currency sanctions guidance:
  https://ofac.treasury.gov/system/files/126/virtual_currency_guidance_brochure.pdf
- IRS digital-asset reporting:
  https://www.irs.gov/filing/digital-assets

## Music Originals — first local catalog (2026-08-11)

Gabriel's naming decision: **Music Originals**, not "XPR Music Originals."
The XPR network remains the payment/minting substrate, not part of the
collection name.

Three original instrumental demos are now in the local player:

| Track | Tempo | Key | Rendered duration |
|---|---:|---|---:|
| Signal Bloom | 112 BPM | B minor / D major | 1:45 |
| Night Ledger | 96 BPM | F minor | 2:03 |
| Open Circuit | 124 BPM | A minor / C major | 1:36 |

The deterministic source arrangement and synthesizer is
`music/generate_originals.py`; rendered MP3s are under
`app/media/songs/`; `music/provenance.json` records exact SHA-256 hashes,
composition seeds, creation method, and rights status. The tracks use only
generated oscillators/noise—no third-party samples, loops, or voice models.
They are clearly marked `minted: false` and "Original AI-assisted demo";
human creative revision and rights review still precede any copyright or
rights-transfer claim.

MailSigil-created XPR testnet wallets are available for the later
AtomicAssets mint/transfer/burn smoke. Account names and signing material must
be resolved from the existing wallet setup at execution time; no credentials
belong in this blueprint.

## Desktop interaction cutover (2026-08-11)

The desktop prototype now uses explicit views rather than inert sidebar
buttons:

- **Home** restores the hero and Music Originals.
- **Browse** shows the full catalog and applies search plus categories read
  from `catalog/songs.json`; the category picker is no longer decorative.
- **Library** and the default **Favorites** playlist are the same persisted
  saved-song set.
- **Pulse Radio** requests a randomized catalog seed from `/api/radio` and
  enables shuffle playback.
- The playlist sidebar starts with Favorites only. Users can create named
  playlists, add or remove songs, open them, and delete them through persisted
  `/api/playlists` routes backed by `catalog/playlists.json`.

The local backend is explicitly in free testnet mode. Playback advances session
position but never accrues mock spend, initiates a token transfer, or exposes a
sale/charge control. Restart recovery reuses the browser's prior session UUID
so Favorites and playlists remain attached to that local profile.

Mainnet payment eligibility is catalog-enforced: only AI-assisted tracks in
**Music Originals** may set `payment_eligible: true` and carry payment rates.
Creative Commons/Kevin MacLeod tracks set `payment_eligible: false`, expose no
rates, and must remain free playback on every network. This is the eligibility
policy for the future wallet/contract payment path; the current local backend
still performs no chain transfer.

## Wallet login + account-scoped state (2026-08-16)

Backend now authenticates XPR wallets using the **MailSigil identity-proof
pattern** (`~/projects/agent-mail/auth/src/identity-proof.ts`), not a
browser-asserted actor:

- Client calls `@proton/web-sdk` ConnectWallet (esm.sh, same as MailSigil's
  `auth/public/xpr-login.js`); the wallet's login already produces a
  cryptographic IdentityProof with no transaction or token transfer.
- `POST /api/auth/verify-proof` (`app/auth.js`) parses the proof, checks the
  chain id, looks up the actor's LIVE on-chain authority via testnet RPC,
  recovers the signing key, and honors the permission weight threshold.
- Proofs are **single-use, retained forever** (`catalog/used-proofs.json`) —
  closes replay of a captured proof (Sol P1 in MailSigil; same fix here).
- Verified actors get a 7-day HS256 session token (`catalog/auth-secret.json`
  persisted so restarts keep sessions valid). Token scope is
  `wallet-ownership` only — it grants no payment capability.
- Favorites and playlists are now **account-scoped**: with a Bearer token the
  state belongs to the verified actor and follows them across browsers;
  without one it stays session-scoped (guest). Legacy `sid`-keyed rows are
  migrated in place on first load.
- `GET /api/auth/me` validates the token; the desktop player's wallet pill
  and profile block reflect the signed-in actor, and signing out returns the
  guest profile.
- NFT-song linkage is exposed at `GET /api/nfts`: for each payment-eligible
  song it reports the planned AtomicAssets `xprmusic::song` template and any
  live testnet-minted assets. Template matching is by `immutable_data.song_id`
  (the blueprint's collector-NFT reference), not a name. Nothing is minted yet.
- The replayable auth test is `test/verify-auth.mjs`: it signs REAL testnet
  identity proofs from `~/.xpr-testnet/wallets.json` keys (read at runtime,
  never embedded), verifies login, replay rejection, `/api/auth/me`,
  account-scoped favorites/playlists, and guest isolation. Run:
  `node test/verify-auth.mjs [account]`.

WebAuth login (re-gated 2026-08-20, login logic fixed same day): both
players use MailSigil's two-path helper `app/web/xpr-login.js` —
`esm.sh @proton/web-sdk@4` + `@proton/link@3` (the SDK from
`desktop.html.bak-pre-spentlabel`, which actually completed logins). Do
**not** load unpkg `@proton/web-sdk@5.1.0-rc-4`; v5's closed-shadow
`<dialog>` overlay plus `{error}` return is what broke desktop+mobile after
the ungate/re-port. Path 1: `loginResult.proof` → `POST /api/auth/verify-proof`.
Path 2 (webauth.com desktop popup returns a session and **no** proof):
`POST /api/auth/nonce` then sign `sigillogin::login` with `broadcast:false`
→ `POST /api/auth/verify`. Mobile restore now requires a Bearer token and
`GET /api/auth/me` — ungated `{connected, actor}` blobs without a token
painted Logout while play 401'd. Replayable: `node test/verify-auth.mjs`
(proof + nonce + play gate). Live rollback: `/opt/xpr-music/*.bak-pre-webauth-login-20260820T0222Z`.

### Guest access rule (2026-08-16, playback OPENED 2026-08-17, **RE-GATED 2026-08-20**)
Guests may **browse, search, filter by category, save favorites, and build
playlists**. Playback requires a verified wallet again
(`POST /api/session/play` → `401 "wallet login required to play"`).

**RE-GATE CHECKLIST** (applied 2026-08-20) — these four:

1. `app/server.js` — restore the Bearer check in `/api/session/play` (before
   `tick(sess)`): reject when `auth.verifyToken` returns null. The current
   code already re-derives `actor` from the header; add back the `401`.
2. `app/server.js` — flip `mode.playback_requires_wallet` back to `true`
   (line ~511 in `/api/catalog`).
3. `web/desktop.html` — `requireWalletPlayback()` is a no-op returning `true`;
   restore the toast + wallet-pill nudge + `return false` when not authed.
4. `web/mobile.html` — `playSong()` lost its `state.wallet.connected &&
   state.wallet.token` guard; restore the status message + early return.

The artist-metrics chart (`loadArtistChart`) remains wallet-gated — leave it.
Deploy = tarball server.js + both views → `/opt/xpr-music` → `systemctl
restart xpr-music`. Rationale to re-gate later: playback is the surface that
accrues payments on mainnet, so it should belong to a verified wallet identity
before real per-second billing ships.

## Agent-wallet grants (2026-08-16)

Desktop nav reorganized: **Settings** is now the user's account card (wallet
identity, network, balance, sign out) — not admin. **Admin** is its own
dashboard entry (PIN-gated listening metrics). New **Agents** dashboard
manages wallet-to-wallet grants, mirroring MailSigil's grant model:

- `catalog/grants.json` stores `{ id, owner, grantee, read, write, created_at,
  revoked_at }`. Owner = the main wallet; grantee = an agent wallet.
- `POST /api/grants` (owner Bearer) creates a grant with **read** (browse
  account: library/playlists/metrics) and **write** (mutate + top up) toggles.
  Validation: grantee is a valid XPR account name, not self, no duplicate
  active grant. `GET /api/grants` lists owner's grants; `POST
  /api/grants/:id/revoke` revokes (audit trail kept, row stays).
- **Account scoping**: a granted agent sends `X-Account-Actor: <owner>` with
  their own Bearer token; `scopeFor` resolves the owner's account scope with
  the grant's permissions. Read-only grants get `403` on every mutation
  (`writeGate`) — library save/remove, playlist create/add/remove/delete.
- **Top-up mock** (`POST /api/account/topup`, `GET /api/account/balance`):
  write-capable wallet (self or granted agent) credits the target account in
  `catalog/balances.json`. Testnet mock only — no chain transfer.

Verified end-to-end: read-only grant can browse owner's library but is denied
writes and top-up; write grant can top up (balance reflects it); revoke
removes access. Desktop Agents UI: grant form (agent wallet + read/write
checkboxes), grant list with per-row Revoke. Deployed live at
https://music.project-testing.xyz/.