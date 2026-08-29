# Handoff — Claude Code, 2026-08-19 → 08-21

For whoever picks this up. Everything claimed here has a verification command.
Assume nothing; run them.

**Scope note:** I am not the only agent on this project. Everything in `music/`
dated **2026-08-19 23:58 or later** (`generate_piano_house.py`,
`generate_artwork_porchlight.py`, `register_porchlight.py`, `instruments.py`,
`recipes/`, `MANAGER.md`, `DEPLOY.md`, `HOW-TO-MAKE-A-SONG.md`,
`HOW-TO-EXPORT-TIDAL.md`, `PROVENANCE-all-i-need-tonight.md`) is **another
agent's work** — the Porchlight artist and the songwriting playbook. I built the
generator pattern they extended (`generate_house.py`, `generate_artwork.py`,
`register_chapel_deep.py`). Do not attribute their work to this report, and read
`music/MANAGER.md` before making a song — it supersedes anything I wrote about
generation.

---

## 0. State right now

```bash
# all three should say "deployed", service "active"
cd app
for f in server.js web/desktop.html web/mobile.html; do
  case $f in web/*) r="/opt/xpr-music/web/$(basename $f)";; *) r="/opt/xpr-music/$(basename $f)";; esac
  l=$(md5 -q "$f"); p=$(ssh root@167.233.60.62 "md5sum $r|cut -d' ' -f1")
  echo "$f $([ "$l" = "$p" ] && echo deployed || echo UNDEPLOYED)"
done
ssh root@167.233.60.62 "systemctl is-active xpr-music"
```

Live: `https://music.project-testing.xyz` · server `167.233.60.62:/opt/xpr-music`
Deploy = scp + `systemctl restart xpr-music` (restart only if `server.js` changed;
it drops every in-flight listening session).

---

## 1. ⚠️ READ THIS BEFORE YOU DEPLOY

**`catalog/*.json` on prod is LIVE USER STATE. Merge, never overwrite.**

The site writes those files as Gabriel uses it. Your local copies are stale by
definition. A normal push deletes his work **silently** — identical
"uploaded, checksums match" output as a successful deploy.

This bit for real twice in two days:
- an album "hey hey" and an edited `xprmusic` bio existed only on prod
- **Porchlight's "All I Need Tonight" existed only on prod** — a straight push
  of `songs.json` would have deleted the other agent's entire artist

Correct pattern (this is how the subcategory tags shipped):
```bash
ssh root@167.233.60.62 "cat /opt/xpr-music/catalog/songs.json" > /tmp/prod-songs.json
# merge YOUR field onto PROD's rows, keep every prod row, then upload
```
- **Code** (`server.js`, `desktop.html`, `mobile.html`, `xpr-login.js`): overwrite is correct.
- **Catalog** (`songs/albums/artists/playlists/balances/grants/recents`): merge only.

---

## 2. Known broken — fix these first

### 2.1 `recents.json` grows without bound  ⚠️ my bug
One row per scope; guests are scoped by session id, so **every guest session
that plays a track writes a permanent row nothing prunes**, and the whole file
is read+rewritten on every play.
```bash
ssh root@167.233.60.62 "python3 -c \"
import json,collections; d=json.load(open('/opt/xpr-music/catalog/recents.json'))
print(len(d), collections.Counter(r['scope_kind'] for r in d))\""
# 2026-08-21: 8 rows, {'sid': 6, 'actor': 2} — the sid count is the problem
```
Fix: TTL/cap the `sid` rows, or don't persist guest recents at all. Actor rows
are fine (bounded by users). Added by me in `server.js` `/api/recents`.

### 2.2 Spend over-credits by one tick at the balance floor
When a balance hits zero mid-tick the full tick still lands in `spend` while the
balance clamps at 0 (observed `spend 0.00083` vs balance `0.0006`). Harmless
while simulated. **Must be fixed before real money.** `tick()`, the
`if (played > 0 && isPaymentEligible(song))` block.

### 2.3 `payments_enabled: false`
Balances are mock seeds. Nobody's real money goes IN. The payout leg out is
proven (§4).

---

## 3. What I built (verifiable)

**Payments** — single-currency spend at `USD_PER_SEC = 0.00005`, USD as source of
truth, per-currency balances counting down, playback stops at zero, free CC
tracks never accrue. Currency picker shows *balance*, the bar pill shows *spend*.

**Artist system** — profile (bio + photo) written **once** and resolved onto every
song by `songView()`, so editing the bio updates all of them; album art inherited
by every track on the album; instant publish (no approval queue); two-step album
delete that unfiles songs rather than cascading.

**Agent grants** — three scopes replacing the old read/write:
`read` (now-playing, library, playlists, stats) · `control` (change track,
favourite, playlists) · `spend` (top-up — **never** implied). Legacy `write:true`
migrates to `control` only, deliberately dropping money access.
```bash
# proves control ≠ spend
curl -s -X POST -H "Authorization: Bearer <agent>" -H 'Content-Type: application/json' \
  -d '{"account":"xprmusic","amount":5}' http://127.0.0.1:8788/api/account/topup
# {"error":"no spend access to this account — top-up requires the spend scope"}
```

**Account-scoped now-playing** — `GET /api/now-playing`, `POST /api/now-playing/track`.
Playback lived in a browser-keyed session so agents couldn't see or change it.
The server **cannot make sound** (browser owns the audio element), so a track
change is *queued* and delivered in `agent_request` on the next `/api/session/state`
poll.

**Agent lookup surfaces** — `GET /api/search` (ranked; sub-genre weighted above
category), `POST /api/playlists/add-by-name` (resolves playlist AND song by name,
creates on request, **reports ambiguity rather than guessing**),
`GET /api/metrics/song/:id` and `/api/metrics/artist-public/:name` (public — the
artist panel showed "—" to everyone but the artist).

**Sub-genres** — `SUBCATEGORIES` map; House under Electronic, not beside it.
Server rejects a mismatched pair. Dependent picker on both upload forms.
```bash
curl -s "https://music.project-testing.xyz/api/search?q=house" | head -c 200
# 3 hits — this query returned 0 before
```

**Cross-device recents** — was localStorage-only, so desktop history never reached
mobile. Now account-scoped server-side, same pattern as the library.

**Mobile** — scoped playback queue (next at the end of a playlist stayed in the
playlist), Media Session lock-screen controls with artwork (was ±10s seek and a
black tile), real cover art on the play page (was a procedural gradient that
never read `song.cover`), playlist detail view, Settings screen, Agents screen,
swipe-to-close on all overlays.

**Chapel Deep** — fictional artist, 3 house tracks, `music/generate_house.py`.
Vocals are additive formant synthesis (vowels on pitch, not words) because the
project policy forbids voice models. Artwork `music/generate_artwork.py`.

---

## 4. Chain facts

- **Payout proven once on testnet.** `ondastream → musictesting`, 0.0031 XPR,
  tx `5008aa41419fc5c1c98b5fb54c1f2aac2ecaab03e253550672c47245117f1eab`,
  derived from $0.0013 accrued at the 0.42 peg.
- Settlement is `app/settle_payout.mjs`, a **local script on purpose** — signing
  needs a key and the web server must never hold one.
- **`xprmusic` cannot pay anything** — zero staked NET/CPU, fails
  "transaction net usage is too high". Use **`ondastream`** as treasury.
- `chapeldeep` is **not** a chain account; its `payout_account` is `musictesting`.
- Login runs on `ondastream` via `web/xpr-login.js` (Grok Build's, nonce-signed).
  **It carries the comment "Do not go back to unpkg v5" — respect it.** I broke
  login once by swapping the SDK on an unfinished diagnosis; Grok reverted it.

---

## 5. Never verified — needs a human

- **Real wallet login.** Headless cannot complete a wallet round-trip. Everything
  up to "Connecting…" is verified; past that is unproven by me.
- **Lock-screen controls on a real phone.** Verified in headless Chromium only.
- **Whether the Chapel Deep tracks sound good.** I measured them (peak 0.81–0.85,
  RMS ~0.20, breakdown drops sub-bass to 0%) but never heard them.

---

## 6. Next, in order

1. **Client acts on `agent_request`** — the endpoint queues a track change; neither
   page switches yet, so "agent changes the song" is half-wired.
2. **`@onda/mcp`** — now unblocked. Copy `~/projects/agent-mail/mcp/` shape: MCP
   server + CLI twin, creds at `~/.onda/credentials.json`, and its invariant —
   **store the 7-day token, never the private key.** Tools: `now_playing`,
   `search`, `add_to_playlist`, `favorite`, `play`/`next`/`previous`,
   `playlists`, `balance`, `whoami`.
3. **Grant acceptance flow** — grants are still **unilateral**. Anyone can grant
   your wallet access; there is no signature making it inert until accepted.
   MailSigil's third safety layer, genuinely missing here.
4. Tag Porchlight's track with a sub-genre (currently `Electronic/—`).

---

## 7. Recovery

Every prod file has `*.bak-pre-<label>-<date>` beside it. Local history is in
`app/web/.versions/` (112 snapshots; `iterate-file-version.sh --seat claude-code`).
Longer defect list with detail: `RECHECK-2026-08-20.md`.
