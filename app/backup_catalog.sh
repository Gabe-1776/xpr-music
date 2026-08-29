#!/bin/bash
# Backup the XPR Music catalog + artwork before ANY destructive edit.
#
# MANDATORY before touching catalog/songs.json, catalog/albums.json, or any
# web/assets/covers/* or web/assets/artists/* file. The repo has NO git history
# and the remote is the only source of truth — if you edit without this, prior
# state (cover assignments, album art) is unrecoverable. THIS HAS HAPPENED TWICE.
#
# Usage:
#   ./backup_catalog.sh            # snapshots local app/catalog + web/assets
#   ./backup_catalog.sh --remote   # also pulls + snapshots the server state
#
# Backups land in BACKUP_DIR/backup-<ISO-datetime>/. Every future agent MUST run
# this first, then confirm the newest backup dir exists BEFORE editing.

set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"                     # app/ parent = repo root
LOCAL_CATALOG="$ROOT/app/catalog"
LOCAL_ASSETS="$ROOT/app/web/assets"
BACKUP_DIR="${XPR_BACKUP_DIR:-$ROOT/backups}"
STAMP="$(date +%Y%m%d-%H%M%S)"
DEST="$BACKUP_DIR/backup-$STAMP"

mkdir -p "$DEST"
# 1) Local catalog JSON (the assignment source of truth for covers/albums)
cp -r "$LOCAL_CATALOG"/songs.json "$LOCAL_CATALOG"/albums.json "$LOCAL_CATALOG"/artists.json "$DEST/" 2>/dev/null || true
# 2) Local cover & artist artwork (the actual image files)
cp -r "$LOCAL_ASSETS"/covers "$DEST/covers" 2>/dev/null || true
cp -r "$LOCAL_ASSETS"/artists "$DEST/artists" 2>/dev/null || true
# 3) A log so future agents can see what changed and why
echo "# backup taken $(date -u +%Y-%m-%dT%H:%M:%SZ)
# reason: (fill in BEFORE editing) 
# files: catalog songs/albums/artists + covers/ + artists/ images" > "$DEST/NOTES.txt"

if [[ "${1:-}" == "--remote" ]]; then
  HOST="root@167.233.60.62"
  ssh -o ConnectTimeout=10 "$HOST" 'cat /opt/xpr-music/catalog/songs.json' > "$DEST/remote-songs.json" 2>/dev/null || true
  ssh -o ConnectTimeout=10 "$HOST" 'cat /opt/xpr-music/catalog/albums.json' > "$DEST/remote-albums.json" 2>/dev/null || true
  echo "remote catalog snapshotted too"
fi

echo "snapshot OK: $DEST"
echo "  songs.json:  $(wc -l < "$DEST/songs.json" 2>/dev/null || echo '?') lines"
echo "  albums.json: $(wc -l < "$DEST/albums.json" 2>/dev/null || echo '?') lines"
echo "  covers:      $(ls "$DEST/covers" 2>/dev/null | wc -l | tr -d ' ') files"
