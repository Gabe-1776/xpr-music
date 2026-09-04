# HANDOFF — Onda player: boxes / rectangles / planes

**For:** another **main** agent later (not MiniMax grunt unless Gabriel says).  
**From:** Grok Build 2026-08-13  
**Do not implement in this file.** Desktop bar is live and lean. This is the parked UI.

## Why this exists

Gabriel: keep **XPR only** on the stream chip *now*; **alter the rest later**.  
Also: mobile **phone shell = rectangles (planes)** — `PLANE-SWIPE-PLAN.md`.

He asked to **blueprint the boxes and rectangles** so a later seat can ship them without rediscovering the fight.

## Live truth (do not regress)

| Surface | File | Now |
|---------|------|-----|
| Desktop | `app/web/desktop.html` | One row. Heart+queue next to title. Seek under transport. Volume pill + **one gold XPR/s chip**. No USDC/LOAN. No testnet box under Favorites. |
| Mobile | `app/web/mobile.html` | Luna-attempt keep. Payment-card still has multi-token guts. Theme gold/black unless reopened. |
| Mobile plan | `PLANE-SWIPE-PLAN.md` | 2 stacked planes; swipe L/R; dots; artist / lyrics. **Not built.** |

Author: Luna + Grok on desktop. M3 must not “fix” desktop from a wrong source.

## Later desktop — metric **boxes** (rectangles)

Bring back **lean** extra economics **without** the old clutter (DEMO RATES, coin-pill soup, free/testnet).

```text
[ volume pill ]  [ XPR/s ]  [ USDC box ]  [ LOAN box ]
                 └ live     └ same height, rectangle not a second green card
```

Rules for the later agent:

1. **XPR stays the primary** pill (already live). USDC / LOAN are **sibling rectangles**, same 34px height, quieter (muted border, not competing gold).
2. Session totals: either a second thin row of 3 boxes **or** tap-to-expand the chip. Do **not** stack volume over payment again.
3. JS already has `state.spend.usdc/loan` and rates. Display only — don’t invent transfers.
4. No “Free playback” / TESTNET marketing copy.
5. One-hop PATHS: this file + `desktop.html` player-right CSS. Version with `iterate-file-version.sh` first.
6. Verify :8788, both desktop width and ~1100px (right cluster used to overflow).

Falsify: three numbers readable in one glance; bar still one visual row; shuffle height = prev.

## Later mobile — **planes** (rectangles)

From `PLANE-SWIPE-PLAN.md` (do not contradict):

- **Top plane:** swipe L/R = prev/next song. No “Now Playing” title. Center-top dot = swipe-down dismiss.
- **Bottom plane:** swipe L → artist, swipe R → lyrics. Dots between shuffle row and streaming box.
- Gesture math: two horizontal swipers + vertical dismiss. Keep audio wiring.

Truth mock: `gpt-5.6-luna-mobile.html` / live `mobile.html` (luna-attempt).

## Out of scope

- Hetzner / mainnet payments
- Changing catalog or `server.js` contracts
- Grunt “make it sleek” without this brief
- Re-adding the sidebar XPR TESTNET box

## return_trigger (when someone ships)

`DONE-v1 onda boxes/planes` + screenshot desktop 1440 and mobile 390. List what is still XPR-only vs boxed.

**quota_band:** include when dispatching. **invert:** author family ≠ reviewer.
