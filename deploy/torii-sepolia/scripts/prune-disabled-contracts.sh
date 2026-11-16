#!/usr/bin/env bash
# Drops the `contracts` rows of contracts that are disabled in contracts.json AND were never
# indexed (head IS NULL). Usage: prune-disabled-contracts.sh <path to torii.db>
#
# Why: torii builds its contract list from the db, not the config, so `enabled: false` alone
# does not stop a contract that already has a row. One that cannot complete its first fetch
# (the backfill request times out) fails the whole batch and stalls every other contract.
#
# Safe by construction: a row with no head has never completed a cycle, so nothing was indexed
# for it. Rows with a head are never touched, and neither are rows that are not listed in
# contracts.json (torii adds its own for externally registered contracts).
#
# Must run while torii is stopped — torii holds the write lock for as long as it runs.
# Never fails the boot: a problem here is logged and torii starts anyway.
set -uo pipefail

DB_FILE="${1:?usage: prune-disabled-contracts.sh <path to torii.db>}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

[[ -f "$DB_FILE" ]] || exit 0   # first boot: nothing to prune

if ! addresses="$(node "$HERE/generate-torii-config.mjs" --disabled-addresses)"; then
  echo "WARNING: prune skipped — could not list disabled contracts" >&2
  exit 0
fi
[[ -n "$addresses" ]] || exit 0

in_list="$(printf '%s\n' "$addresses" | sed "s/.*/'&'/" | paste -sd, -)"
if ! pruned="$(sqlite3 "$DB_FILE" "DELETE FROM contracts WHERE head IS NULL AND lower(contract_address) IN (${in_list}) RETURNING contract_address;" 2>&1)"; then
  echo "WARNING: prune skipped — sqlite3: ${pruned}" >&2
  exit 0
fi

if [[ -n "$pruned" ]]; then
  echo "pruned never-indexed disabled contracts:"
  printf '  %s\n' $pruned
fi
