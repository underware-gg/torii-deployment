#!/usr/bin/env bash
set -euo pipefail

# Railway injects PORT — never set it manually.
NETWORK="${NETWORK:?NETWORK must be set (SN_MAIN or SN_SEPOLIA)}"
DB_DIR="${TORII_DB_DIR:-/data/torii-db}"
# Token image cache behind /static — same volume as the db, or it is lost on every redeploy.
export TORII_ARTIFACTS_DIR="${TORII_ARTIFACTS_DIR:-$(dirname "$DB_DIR")/static}"
CONFIG="${GENERATED_TORII_TOML:-/app/torii.generated.toml}"
VOLUME_ROOT="$(dirname "$DB_DIR")"

# --- persistent storage check ----------------------------------------------
# Without a volume mounted at $VOLUME_ROOT every redeploy re-indexes from
# scratch. Set REQUIRE_PERSISTENT_DB=false to run without one (local testing).
if ! awk -v p="$VOLUME_ROOT" '$2 == p { found = 1 } END { exit !found }' /proc/mounts; then
  if [[ "${REQUIRE_PERSISTENT_DB:-true}" == "true" ]]; then
    echo "ERROR: ${VOLUME_ROOT} is not a mounted volume." >&2
    echo "       Attach a Railway Volume at ${VOLUME_ROOT} (or set REQUIRE_PERSISTENT_DB=false)," >&2
    echo "       otherwise the index is lost on every redeploy." >&2
    exit 1
  fi
  echo "WARNING: ${VOLUME_ROOT} is not a mounted volume — the index will NOT survive a redeploy." >&2
fi

mkdir -p "$DB_DIR" "$TORII_ARTIFACTS_DIR"
echo "$(torii --version) | network=${NETWORK} | db_dir=${DB_DIR} ($(du -sh "$DB_DIR" 2>/dev/null | cut -f1) used) | artifacts=${TORII_ARTIFACTS_DIR} ($(du -sh "$TORII_ARTIFACTS_DIR" 2>/dev/null | cut -f1) used)"

node /app/scripts/generate-torii-config.mjs --out "$CONFIG"

exec torii --config "$CONFIG"
