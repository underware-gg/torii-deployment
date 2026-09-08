# Torii Indexer — Build, Deploy & Manage Spec (Railway)

> **FROZEN HISTORY.** This is the original hand-off spec, kept as written. The implementation
> deviates from it deliberately, and the repo has since been extracted into a standalone,
> flattened layout (no `torii/` subdirectory). Where this file and
> [`README.md`](./README.md) / [`CLAUDE.md`](./CLAUDE.md) disagree, the code and those two win.
> Do not update this file to match reality.

> **Purpose of this doc:** This is an implementation spec, intended to be handed to Claude Code (or any engineer) to build out the Torii deployment for this project. It covers building a Docker image for the `torii` binary, generating its config dynamically from a project-local JSON file listing ERC-20/ERC-721 tokens (with or without a Dojo World), deploying it on Railway, and ongoing operations (updates, resource sizing, monitoring, debugging).
>
> Everything below reflects Torii's documented CLI/config behavior and Railway's documented platform behavior as of this writing. Config keys and schema can change between Torii versions — **verify against `torii --help` and the linked docs for the version actually pinned in the Dockerfile before relying on any specific flag.**

---

## 1. References & Documentation

**Torii / Dojo**
- Torii source repo: https://github.com/dojoengine/torii
- Torii releases: https://github.com/dojoengine/torii/releases
- Torii overview (Dojo Book): https://book.dojoengine.org/toolchain/torii
- Torii configuration guide (Dojo Book): https://book.dojoengine.org/toolchain/torii/configuration
- Torii GraphQL API reference: https://book.dojoengine.org/toolchain/torii/graphql
- Torii gRPC API reference: https://book.dojoengine.org/toolchain/torii/grpc
- Torii SQL endpoint reference: https://book.dojoengine.org/toolchain/torii/sql
- `asdf-torii` plugin (installs prebuilt `torii` binaries): https://github.com/dojoengine/asdf-torii
- Dojo installation guide (asdf toolchain): https://book.dojoengine.org/installation
- Official Dojo Dockerfile (reference pattern this spec is based on): https://github.com/dojoengine/dojo/blob/main/Dockerfile
- Torii Grafana dashboard setup (verify path against current `main` branch): https://github.com/dojoengine/torii/blob/main/docs/grafana-setup.md

**Railway**
- Public networking / `PORT` binding: https://docs.railway.com/public-networking
- Application failed to respond troubleshooting: https://docs.railway.com/networking/troubleshooting/application-failed-to-respond
- Private networking (`*.railway.internal`): https://docs.railway.com/private-networking
- Volumes reference: https://docs.railway.com/volumes/reference
- Using volumes (mount behavior, resize): https://docs.railway.com/volumes
- Managing volume backups via API: https://docs.railway.com/guides/manage-volumes
- CLI — `railway ssh`: https://docs.railway.com/cli/ssh
- CLI — `railway shell`: https://docs.railway.com/cli/shell
- Deployments / healthchecks / restart policy: https://docs.railway.com/deployments

---

## 2. Architecture Overview

Torii is a Starknet indexer. It can run in two modes, and this spec supports both, toggled entirely from a JSON config file (no code changes needed to switch):

1. **Dojo World mode** — indexes a Dojo `World` contract (ECS models/events) *plus* optionally any number of ERC-20/ERC-721 token contracts alongside it (e.g. a game's currency or item tokens that live outside the World).
2. **Pure token-indexer mode** — no Dojo World at all. As of Torii 1.6.1+, the world address is no longer required; Torii indexes whatever is listed in `indexing.contracts`. This is valid for projects that only need ERC-20/ERC-721 balance/transfer indexing.

Under the hood, a `world` value is just prepended into the same `contracts` array Torii uses for tokens — there's no structural difference between the two modes at the config level, which is what makes a single generator script work for both.

Torii serves everything from one HTTP port:
- GraphQL: `/graphql`
- SQL (beta): `/sql`
- MCP endpoint: `/mcp`
- gRPC: same port, binary protocol
- Prometheus metrics (if enabled): separate port, `/metrics`

---

## 3. Repository Layout

Add the following to the project:

```
torii/
├── Dockerfile
├── entrypoint.sh
├── scripts/
│   └── generate-torii-config.sh
├── config/
│   ├── tokens.json            # gitignored — real, per-environment values
│   └── tokens.example.json    # committed — template/example
└── README.md                  # short pointer back to this spec
```

Add to `.gitignore`:
```
torii/config/tokens.json
torii/*.generated.toml
```

`tokens.json` holds addresses/environment specifics and should be treated like config, not committed with production addresses baked in (use Railway environment variables to inject it, or generate it at deploy time — see §6).

---

## 4. Token Config Schema (`tokens.json`)

This is the single source of truth for what Torii indexes. It supports the with/without-World cases via `world.enabled`.

```json
{
  "world": {
    "enabled": true,
    "address": "0x_WORLD_CONTRACT_ADDRESS"
  },
  "rpc_url": "https://api.cartridge.gg/x/starknet/mainnet",
  "indexing": {
    "namespaces": ["game"],
    "models": [],
    "controllers": true,
    "pending": false
  },
  "tokens": [
    { "type": "ERC20",  "address": "0x_TOKEN_ADDRESS_1", "name": "GameGold" },
    { "type": "ERC20",  "address": "0x_TOKEN_ADDRESS_2", "name": "GemToken" },
    { "type": "ERC721", "address": "0x_NFT_ADDRESS_1",   "name": "GameItems" },
    { "type": "ERC721", "address": "0x_NFT_ADDRESS_2",   "name": "GameLand" }
  ]
}
```

Field notes:
- `world.enabled: false` (or the whole `world` block omitted) → pure token-indexer mode, no `WORLD:` entry is generated.
- `type` must be `ERC20` or `ERC721` (matches Torii's `contracts` array prefix syntax, e.g. `"ERC20:0x..."`).
- `name` is for humans/logging only — not passed to Torii, purely to make `tokens.json` self-documenting when there are many entries.
- `indexing.namespaces` / `indexing.models` are Dojo-World-specific filters; leave empty arrays in pure token mode.

`tokens.example.json` should be a committed copy of the above with placeholder addresses, so the real `tokens.json` is easy to bootstrap per environment.

---

## 5. Config Generation Logic (JSON → Torii TOML)

Torii's config priority is: **CLI args > `--config` TOML file > env vars > defaults.** This spec generates a full TOML file at container start from `tokens.json` plus a handful of deploy-time env vars, so the JSON stays the only thing a developer edits to add/remove tokens.

`scripts/generate-torii-config.sh` (reference implementation — adjust to match the exact TOML schema of the pinned Torii version; **validate with `torii --help` / a `torii --config <file> --dry-run`-style check if available before trusting in production**):

```bash
#!/usr/bin/env bash
set -euo pipefail

CONFIG_JSON="${TOKENS_CONFIG_PATH:-/app/config/tokens.json}"
OUTPUT_TOML="${GENERATED_TORII_TOML:-/tmp/torii.generated.toml}"

if [[ ! -f "$CONFIG_JSON" ]]; then
  echo "ERROR: tokens config not found at $CONFIG_JSON" >&2
  exit 1
fi

WORLD_ENABLED=$(jq -r '.world.enabled // false' "$CONFIG_JSON")
WORLD_ADDRESS=$(jq -r '.world.address // empty' "$CONFIG_JSON")
RPC_URL="${RPC_URL:-$(jq -r '.rpc_url // empty' "$CONFIG_JSON")}"
NAMESPACES=$(jq -r '.indexing.namespaces // [] | @json' "$CONFIG_JSON")
MODELS=$(jq -r '.indexing.models // [] | @json' "$CONFIG_JSON")
CONTROLLERS=$(jq -r '.indexing.controllers // false' "$CONFIG_JSON")
PENDING=$(jq -r '.indexing.pending // false' "$CONFIG_JSON")

CONTRACTS=()
if [[ "$WORLD_ENABLED" == "true" && -n "$WORLD_ADDRESS" ]]; then
  CONTRACTS+=("\"WORLD:${WORLD_ADDRESS}\"")
fi

while IFS= read -r row; do
  TYPE=$(echo "$row" | jq -r '.type')
  ADDR=$(echo "$row" | jq -r '.address')
  CONTRACTS+=("\"${TYPE}:${ADDR}\"")
done < <(jq -c '.tokens[]' "$CONFIG_JSON")

CONTRACTS_TOML=$(IFS=,; echo "${CONTRACTS[*]}")

cat > "$OUTPUT_TOML" <<EOF
rpc = "${RPC_URL}"
db_dir = "${TORII_DB_DIR:-/data/torii-db}"

[indexing]
contracts = [${CONTRACTS_TOML}]
namespaces = ${NAMESPACES}
models = ${MODELS}
controllers = ${CONTROLLERS}
pending = ${PENDING}

[server]
http_addr = "0.0.0.0"
http_port = ${PORT:-8080}
http_cors_origins = ["${CORS_ORIGINS:-*}"]

[metrics]
metrics = true
metrics_addr = "0.0.0.0"
metrics_port = ${METRICS_PORT:-9200}
EOF

echo "Generated Torii config at ${OUTPUT_TOML}:"
cat "$OUTPUT_TOML"
```

This lets `WORLD_ADDRESS` / `RPC_URL` still be overridden by Railway env vars for secrets-style values without editing the JSON, while the token list itself lives in version control (minus real addresses if you'd rather keep those out of git — either works, pick one convention for the team).

---

## 6. Dockerfile

```dockerfile
FROM ubuntu:24.04

RUN apt-get update && apt-get install -y --no-install-recommends \
      curl ca-certificates git tini jq \
    && rm -rf /var/lib/apt/lists/*

# --- asdf ---
ARG ASDF_VERSION=v0.18.0
ENV ASDF_DIR=/opt/asdf
ENV ASDF_BIN_DIR=${ASDF_DIR}/bin
ENV ASDF_DATA_DIR=${ASDF_DIR}
ENV PATH="${ASDF_BIN_DIR}:${ASDF_DATA_DIR}/shims:${PATH}"

RUN curl -L "https://github.com/asdf-vm/asdf/releases/download/${ASDF_VERSION}/asdf-${ASDF_VERSION}-linux-amd64.tar.gz" \
      -o /tmp/asdf.tar.gz \
    && mkdir -p "$ASDF_BIN_DIR" \
    && tar -xzf /tmp/asdf.tar.gz -C "$ASDF_BIN_DIR" \
    && rm /tmp/asdf.tar.gz \
    && chmod +x "$ASDF_BIN_DIR/asdf"

# --- torii (pin explicitly for reproducible builds) ---
ARG TORII_VERSION=1.7.0
RUN asdf plugin add torii https://github.com/dojoengine/asdf-torii.git \
    && asdf install torii ${TORII_VERSION} \
    && asdf global torii ${TORII_VERSION}

WORKDIR /app
COPY config/ /app/config/
COPY scripts/ /app/scripts/
COPY entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh /app/scripts/generate-torii-config.sh

ENTRYPOINT ["tini", "--"]
CMD ["/app/entrypoint.sh"]
```

Notes:
- Only the `torii` binary is installed — not `scarb`, `starknet-foundry`, `katana`, `sozo`. Those are only needed for building/migrating a World, which is assumed to happen elsewhere (CI, local dev), not in this runtime image.
- `TORII_VERSION` is a build arg so bumping it is a one-line change (§9).

`entrypoint.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail

/app/scripts/generate-torii-config.sh

exec torii --config "${GENERATED_TORII_TOML:-/tmp/torii.generated.toml}"
```

---

## 7. Local Testing (before deploying)

```bash
docker build -t my-torii --build-arg TORII_VERSION=1.7.0 ./torii

docker run --rm -p 8080:8080 -p 9200:9200 \
  -e RPC_URL="https://api.cartridge.gg/x/starknet/mainnet" \
  -e PORT=8080 \
  -v "$(pwd)/torii/config/tokens.json:/app/config/tokens.json:ro" \
  -v torii-local-db:/data \
  my-torii
```

Verify:
- `http://localhost:8080/graphql` responds
- `http://localhost:8080/sql` responds
- `http://localhost:9200/metrics` responds
- Logs show it discovering/indexing the configured contracts

---

## 8. Railway Deployment

1. **Build**: Railway auto-detects the `Dockerfile`. If it's not at the repo root, set the root/build directory in service settings, or add a `railway.toml`:

   ```toml
   [build]
   builder = "DOCKERFILE"
   dockerfilePath = "torii/Dockerfile"

   [deploy]
   restartPolicyType = "ON_FAILURE"
   ```

2. **Environment variables** (Railway dashboard → service → Variables):
   - `RPC_URL`
   - `TORII_DB_DIR` → `/data/torii-db`
   - `CORS_ORIGINS` (restrict in prod, don't leave `*`)
   - `WORLD_ADDRESS` (only if not hardcoded in `tokens.json`)
   - Do **not** set `PORT` — Railway injects this automatically, and the generator script reads it.

3. **Volume**: Attach a Railway Volume mounted at `/data`. Required for §10 (avoiding re-indexing) — without it, every redeploy starts from a blank DB.

4. **`tokens.json` at runtime**: two options —
   - Bake a real `tokens.json` into the image per-environment (separate Railway services/environments per branch, each with its own `config/tokens.json` committed to that branch), or
   - Mount it via a Railway-injected variable: set a `TOKENS_CONFIG_JSON` env var containing the full JSON blob, and have `entrypoint.sh` write it to `/app/config/tokens.json` before calling the generator, if you don't want per-environment files in git at all. Example addition to `entrypoint.sh`:
     ```bash
     if [[ -n "${TOKENS_CONFIG_JSON:-}" ]]; then
       echo "$TOKENS_CONFIG_JSON" > /app/config/tokens.json
     fi
     ```

5. **Public networking**: generate a domain once Railway detects the service listening; point it at the container's `$PORT`. GraphQL/gRPC/SQL/MCP are all on that one port. Keep the metrics port (`9200`) **off** the public domain — it should only be reachable over Railway's private network (`*.railway.internal:9200`) by an internal monitoring service, not exposed publicly.

6. **Healthcheck** (optional but recommended): point it at `/graphql` in service settings, per Railway's healthcheck config (https://docs.railway.com/deployments).

---

## 9. Managing & Updating

**Adding/removing a token**
- Edit `tokens.json` (or the `TOKENS_CONFIG_JSON` variable), commit/push, redeploy.
- Adding a contract is additive — Torii begins indexing its history alongside existing data; previously indexed contracts are unaffected.
- Removing a contract from the config stops *future* indexing of it, but does **not** retroactively delete its already-indexed rows from the SQLite DB — Torii doesn't document a "prune a contract" flag. If full removal of historical data is required, this needs either a manual SQL `DELETE` against the relevant tables in the DB (verify table names via the SQL endpoint schema first) or a fresh volume/`db_dir`. Flag this for manual verification against the exact Torii version in use before relying on it in production.

**Updating the Torii version**
- Bump `TORII_VERSION` build arg in the Dockerfile, rebuild, redeploy.
- Check the release notes on the GitHub Releases page (https://github.com/dojoengine/torii/releases) for TOML schema changes before rolling out — config keys have changed between minor versions historically (e.g. the world-address-optional change landed in 1.6.1).
- Roll back by redeploying a previous Railway deployment (Railway keeps deployment history) or re-pinning the previous `TORII_VERSION` and rebuilding.

**Data safety around version bumps / schema changes**
- Railway supports volume backups (https://docs.railway.com/guides/manage-volumes) — take one before any Torii version bump that touches indexing/schema logic.
- Redeploying a service with a volume attached causes a brief moment of downtime even with a healthcheck configured, since Railway won't run two deployments mounted to the same volume simultaneously — expect a short blip on every deploy, not just version bumps.

---

## 10. Persistent Storage & Avoiding Re-indexing

- `db_dir` (generated from `TORII_DB_DIR`) must point at the mounted Railway Volume path (`/data/torii-db`), not container-local storage.
- Torii persists indexed state (synced block height, entities, events) in that SQLite file; on restart with the same `db_dir`, it resumes rather than re-indexing from scratch. This is why the docs call persistent storage "recommended for production."
- Keep `WORLD_ADDRESS` / `RPC_URL` stable across restarts. Don't change `indexing.world_block` after the first cold start — it's only consulted on initial sync.
- Volumes are **not** mounted during build or pre-deploy on Railway — only at runtime — which is fine here since the DB is only touched by the running `torii` process, not the build.

---

## 11. Shell / Debug Access

Railway gives real interactive shell access to the running container:

```bash
railway ssh
```

Requires the Railway CLI locally and an SSH key registered to your Railway account (prompted on first use). Opens an interactive shell backed by a `tmux` session inside the container (Railway auto-installs `tmux` if missing), so a dropped connection reattaches rather than losing the session. Since the image is `ubuntu:24.04`, `bash`/`sh` are available by default. Useful for:

```bash
ls -lh /data/torii-db
sqlite3 /data/torii-db/torii.db "select name from sqlite_master limit 10;"
torii --version
cat /tmp/torii.generated.toml
```

(`railway shell`, by contrast, opens a **local** shell with the service's env vars injected — not a remote session into the container. Use `railway ssh` for actually being inside the deployed container.)

---

## 12. Resource Sizing & Monitoring

**Sizing factors**
- Number of indexed contracts (World + every ERC-20/ERC-721 entry) and their historical event volume — more contracts and more transfer/event history means more RPC calls during initial backfill and a larger DB.
- `indexing.max_concurrent_tasks`, `indexing.polling_interval`, `indexing.events_chunk_size`, `indexing.blocks_chunk_size` all trade RPC load / indexing speed against memory and CPU. Start with defaults, tune only if you see indexing lag or RPC rate-limit errors.
- `sql.cache_size` / `sql.page_size` affect SQLite performance under heavier query load (many tokens being queried concurrently via GraphQL/SQL) — the docs' "Production" example bumps `cache_size` to `-2000000` (2 GB) and `page_size` to `65536` for larger deployments.
- Disk grows monotonically (SQLite never shrinks automatically) — size the Railway Volume with headroom and revisit as more tokens/history accumulate.

**Starting point**
- Begin on a modest Railway plan/instance size, watch Railway's built-in service metrics (CPU, RAM, network) during the initial backfill of all configured contracts — that's the highest-load period.
- If backfill is slow relative to your needs, raise `max_concurrent_tasks` and/or `events_chunk_size` first before scaling compute.
- If RAM climbs steadily rather than plateauing, that's usually a sign of too many concurrent tasks relative to available memory, or SQL cache sizes set too high for the instance — scale one of those back before scaling compute up.

**Monitoring**
- Enable `[metrics]` (already on in the generated config, §5) — exposes Prometheus-format metrics at `/metrics` on port `9200`.
- Torii ships pre-configured Grafana dashboards; see the setup doc for wiring it up: https://github.com/dojoengine/torii/blob/main/docs/grafana-setup.md (verify this path against whatever branch/tag matches the pinned `TORII_VERSION`).
- Keep the metrics port private (Railway's internal network, `*.railway.internal:9200`) rather than exposing it on the public domain — point an internal Prometheus/Grafana instance (or Grafana Cloud agent, if it supports private-network scraping into your Railway project) at it rather than opening it to the internet.
- Track, at minimum: indexing lag (current block vs. chain head), RPC error rate, `/metrics` query latency for GraphQL/SQL endpoints under load, and Railway's own Volume disk-usage metric so you're not surprised by a full volume.
- Railway volumes auto-run an offline resize with integrity checks if they hit 100% capacity, which restarts the service — treat approaching capacity as an action item, not something to let happen automatically.

---

## 13. Security Notes

- Set `CORS_ORIGINS` to your actual frontend origin(s) in production rather than `*`.
- Don't expose the metrics port publicly (see §12).
- If you need TLS termination beyond what Railway's edge already provides, Torii supports `tls_cert_path` / `tls_key_path` under `[server]`, but this is typically unnecessary on Railway since Railway terminates TLS at its edge for the public domain.

---

## 14. Implementation Checklist (for Claude Code)

- [ ] Create `torii/Dockerfile` (§6)
- [ ] Create `torii/entrypoint.sh` (§6, plus optional `TOKENS_CONFIG_JSON` handling from §8.4)
- [ ] Create `torii/scripts/generate-torii-config.sh` (§5) — validate generated TOML against `torii --help` for the pinned version
- [ ] Create `torii/config/tokens.example.json` (§4), committed
- [ ] Create real `torii/config/tokens.json` per environment, gitignored (§3)
- [ ] Add `.gitignore` entries (§3)
- [ ] Add `railway.toml` if Dockerfile isn't at repo root (§8.1)
- [ ] Set Railway env vars: `RPC_URL`, `TORII_DB_DIR`, `CORS_ORIGINS`, `WORLD_ADDRESS`/`TOKENS_CONFIG_JSON` as applicable (§8.2)
- [ ] Attach Railway Volume at `/data` (§8.3)
- [ ] Configure Railway healthcheck at `/graphql` (§8.6)
- [ ] Confirm metrics port is not on the public domain (§12)
- [ ] Local `docker build` + `docker run` smoke test before first deploy (§7)
- [ ] After first deploy, confirm `/graphql`, `/sql`, `/mcp` all respond, and logs show all configured contracts syncing
- [ ] Document, in the project README, the steps to add a new ERC-20/ERC-721 token (edit `tokens.json` → redeploy)