#!/bin/bash
# XPR Music — scheduled streaming settlement runner (LEGACY — GATED).
#
# DANGEROUS as-is: this pre-contract settler pays artists from the ondastream
# treasury a SECOND time for plays the on-chain contract already settles, and
# spends listener deposit funds. The launchd schedule was removed 2026-08-26.
# To run anyway you must set the escape hatch:
#   ONDA_LEGACY_SETTLE=1 ./run_settlement.sh

export PATH="/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin:$PATH"
LOG="$HOME/Library/Logs/xpr-settlement.log"

if [[ "${ONDA_LEGACY_SETTLE:-0}" != "1" ]]; then
  echo "=== $(date '+%Y-%m-%d %H:%M:%S') REFUSED (legacy gate) ===" >> "$LOG"
  echo "refusing to run: legacy settlement is gated — set ONDA_LEGACY_SETTLE=1 if you really mean it (see header)" >&2
  exit 78
fi

cd "$HOME/Developer/xpr-music/app" || exit 1
echo "=== $(date '+%Y-%m-%d %H:%M:%S') settlement run ===" >> "$LOG"
node settle_all.mjs ondastream >> "$LOG" 2>&1
echo "=== exit $? ===" >> "$LOG"
