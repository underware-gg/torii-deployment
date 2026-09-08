# CLAUDE.md

Guidance for Claude Code (claude.ai/code) when working in this repository.

## Working rules

**Git: never commit.** Only the user commits. Read-only git (`status`, `diff`, `log`, `show`, `blame`)
is always fine. Never rewrite history (`rebase`, `reset --hard`, `commit --amend`, `push --force`,
`filter-branch`) unless asked for that specific operation. Leave changes in the working tree and say
what you changed.

**Three docs, three jobs — don't blur them:**

- **`README.md`** — human operational instructions: run it, deploy it, add a token. Keep current, keep
  terse. Commands and steps, no prose.
- **`SPECS.md`** — the original hand-off spec, **frozen history**. The implementation deviates from it
  deliberately; trust the code and `README.md` over `SPECS.md` where they disagree. Don't update it to
  match reality — that's what the other two files are for.
- **this file** — architecture and behavior an agent needs before touching anything. Not a changelog,
  not a record of fixes: if a fact wouldn't stop a future mistake, leave it out; if the code already
  says it, leave it out.

**Starknet only.** Cairo/Dojo, Torii, Cartridge. Never bring an EVM library, address type or ABI
convention across.

## Repository state

Extracted from `underware-gg/pistols-solitaire`, where this lived as `torii/` + a root
`contracts.json` beside a Next.js client. Here it is standalone and **flattened**: `contracts.json`,
`Dockerfile`, `entrypoint.sh` and `scripts/` all sit at the repo root, and the Docker build context is
the root. If you port a change back to the original repo, mind that path shift.

**No build step, no npm dependencies.** Everything is plain Node ESM (≥20) and `pnpm install` is
never needed. Tests are `node:test` under `test/` (`pnpm test`); they need no packages either —
the TOML reader in `scripts/lib/toml.mjs` covers only the subset torii configs use. Check
`package.json` before suggesting a command.

## Layout

```
contracts.json                     # single source of truth for what gets indexed
template/                          # everything that ships in the image — the ONLY place to edit it
├── Dockerfile                     # pinned torii binary on node:22-trixie-slim, no NETWORK
├── entrypoint.sh                  # volume check → generate config → exec torii
└── scripts/generate-torii-config.mjs   # contracts.json → torii TOML, + --check validator
deploy/torii-<net>/                # GENERATED: template/ + ENV NETWORK + contracts.json. Railway builds these.
scripts/build-deploy.mjs           # template/ + contracts.json → deploy/; --check for drift
scripts/find-deploy-block.mjs      # binary-searches a contract's deployment block over RPC
scripts/compare-reference.mjs      # generated vs reference/pistols/, side by side (report only)
scripts/lib/toml.mjs               # subset TOML reader shared by tests and compare
test/                              # node:test: generator, validation, reference parity, torii boot
reference/pistols/                 # frozen originals we replace — compare against, never edit or ship
.tool-versions                     # pins torii for local runs (asdf)
.agents/skills/dojo-*              # vendored Dojo skills (see skills-lock.json)
```

## Design points

- **Single JSON source of truth.** `contracts.json` lists the ERC-20/ERC-721 contracts and Dojo worlds
  to index, keyed by chain id (`SN_MAIN`, `SN_SEPOLIA`). `generate-torii-config.mjs` converts it to a
  Torii TOML at container start. Adding a token should never require editing the Dockerfile,
  entrypoint, or TOML by hand.
- **Persistent storage is enforced.** `entrypoint.sh` refuses to boot if the parent of `TORII_DB_DIR`
  isn't a mount (`REQUIRE_PERSISTENT_DB=false` to bypass locally).
- **Token images live on the volume too.** `[erc] artifacts_path` is set to `TORII_ARTIFACTS_DIR`
  (default `<parent of TORII_DB_DIR>/static`, i.e. `/data/static`). Torii fills it lazily: the first
  request to `/static/<contract>/<token_id>/image` downloads the image from the token's metadata
  and writes it (plus `@medium`/`@small` variants) there; later requests are served from disk and
  re-fetched only when the token's `updated_at` moves. Unset, torii uses a fresh `TempDir` per
  process, so every restart used to drop the whole cache — a cost, not a data loss, since it is
  always rebuildable from metadata. Verified in 1.8.16 (`crates/runner/src/lib.rs`,
  `crates/server/src/handlers/static.rs`).
- **Two modes, one config path.** A world with `enabled: true` prepends a `WORLD:0x…` entry to the same
  `indexing.contracts` array the tokens use; `false` gives pure token-indexer mode. Torii ≥1.6.1 no
  longer requires a world address.
- **`indexing.historical` is an index-time decision.** Models listed there (→ `[sql] historical`) keep
  every emission in `event_messages_historical`; anything else collapses to latest-per-key as it is
  indexed, and Torii never indexes backwards. So the list must be in place *before* the world it
  belongs to is first enabled — which is why it is already set while the pistols world is still
  `enabled: false`. Same for `raw_events`. The pistols client needs `PlayerActivityEvent` and
  `LordsReleaseEvent` historical; Cartridge achievements need `TrophyProgression`.
- **Unknown `indexing` keys are rejected** by `--check` (`pending` is the pre-1.8 name of
  `preconfirmed`; the reference configs still use it).
- **`worlds` is an array.** Torii 1.8.16 indexes any number of worlds in one instance — verified — with
  a sync head per `WORLD:` entry and `models`/`entities` keyed by `world_address`. Disabled entries
  stay in the file as history. `indexing.namespaces`/`models` filters are **global**, not per-world.
- **The top-level `world_address` TOML key is not emitted** — the `WORLD:` entries in
  `indexing.contracts` are sufficient since Torii 1.6.1.
- **Torii config precedence:** CLI args > `--config` TOML > env vars > defaults.
- **Railway deployment.** Railway injects `PORT` — never set it manually. A Volume must be mounted at
  `/data` with `TORII_DB_DIR=/data/torii-db`, or every redeploy re-indexes from scratch.
  GraphQL/SQL/MCP/gRPC all share the one HTTP port; metrics (`9200`) must stay off the public domain.
- **Generated per-network build contexts — the user's explicit choice; do not re-architect.**
  `scripts/build-deploy.mjs` copies `template/` (inserting `ENV NETWORK=<net>` into the Dockerfile)
  plus the root `contracts.json` into `deploy/torii-<net>/`. Railway's only per-service setup is Root Directory = that folder, a volume
  at `/data`, and a domain. Then it's edit → `pnpm build` → commit → push. Rules:
  - **`deploy/` is generated and committed.** Never hand-edit it. `pnpm check` runs
    `build-deploy.mjs --check` and fails on drift, including stray files. Any change under `template/`
    or to `contracts.json` needs a regenerate in the same commit.
  - **Duplication is intentional.** Two copies of `contracts.json` etc. exist by design so each folder
    is a self-contained build context with no dependency on files outside it — that is what lets
    Root Directory do all the work. Don't "deduplicate" it with symlinks or `..` COPYs; Railway ships
    only the root-directory folder to the builder (that failure mode was hit: `"/entrypoint.sh": not found`).
  - **Rejected alternatives, don't reintroduce:** `railway.toml` config-as-code (deprecated, read
    until 2026-12-01, no new opt-ins); `.railway/railway.ts` IaC (works, but requires a per-folder
    `railway link` + CLI `apply` step — the user rejected any flow where deploying depends on a local
    CLI state that can rot); one root Dockerfile with `NETWORK` as a Railway variable (works, but
    moves the chain choice out of git and a missing variable was a silent wrong-chain risk).
- **Both services are literally named `torii`, in different projects** — `pistols-torii-mainnet`
  and `pistols-torii-sepolia`. The folder a service's Root Directory points at is what selects
  the chain. The mainnet domain was renamed from `pistols-solitaire-mainnet` on 2026-09-08; the
  pistols client (`sdk/src/games/pistols/config/networks.ts` in `underware-gg/pistols`) still
  points at the `pistols-solitaire-*` domains and needs updating separately.
- **The two services are not in the same situation.** Mainnet is **live** (torii 1.8.16, 13
  contracts, heads current) and its volume holds a warm index — a migration, never a re-index; do
  not recreate the volume. Sepolia has **never been deployed** (`pistols-torii-sepolia.up.railway.app`
  returns Railway's `Application not found`) even though clients already point at it
  (`client/src/dojo/profiles.ts` in `pistols-solitaire`). The domain is a dashboard step and must
  match what the clients use.
- **The pistols world and LORDS are prepared but disabled** (`enabled: false` on both networks, as of
  2026-09-08) — the user will enable them in a later update. Enabling the world backfills it from the
  global `world_block`, not its own block (see the 1.8.16 bug below); enabling LORDS lowers that to
  the LORDS deployment block and is by far the largest backfill. The pistols client reads LORDS
  balances from Torii's `token_balances`, so without LORDS indexed it shows none.
- **RPC spec version.** Torii 1.8.16 wants JSON-RPC 0.9 and only *warns* on a mismatch; the Cartridge
  `v0_9` and `v0_10` endpoints both report `0.10.2` today and the live mainnet indexes fine on
  `v0_10`. Torii 1.8.7 hard-fails on the same endpoint — if a local run dies with "Provider spec
  version is not supported", check `torii --version`: the asdf shim reads `.tool-versions` from the
  *working directory*, so a torii started from elsewhere is the global version.
- **Torii's TOML schema changes between minor versions.** `TORII_VERSION` is a Docker build arg pinned
  in `Dockerfile` and mirrored in `.tool-versions`; validate generated config against `torii --help`
  for the pinned version before trusting any flag, and read the release notes on a bump.
- **The base image must stay trixie or newer.** The amd64 torii release requires glibc ≥ 2.39 and
  bookworm ships 2.36. The arm64 release is linked against an older glibc, so this only breaks on
  amd64 (i.e. Railway) — reproduce locally with `pnpm docker:build:amd64`. The `RUN torii --version`
  line in the Dockerfile is what catches it.
- **Client-only fields.** `slug`, `bgColor` and `aspect` on a contract are for apps reading the same
  file; Torii never sees them, but `--check` validates them, because this is the one place the file
  is validated.
- **`find-deploy-block.mjs`** resolves a deployment block by binary searching `starknet_getClassHashAt`
  over block history (~21 RPC calls). Use it instead of guessing — `pnpm blocks` fills in any entry
  whose `block` is 0.

## Start blocks — Torii never indexes backwards

**The oldest enabled `block` becomes `indexing.world_block`, and that value is only a fallback for
contracts with no row in the db yet.** A contract already indexed resumes from its own stored `head`
and cannot be pulled backwards by lowering a `block` in `contracts.json`.

Verified in torii 1.8.16 (`/Users/roger/Dev/Dojo/torii` is stale at 1.5 — read the tag on GitHub):

- the engine's contract list comes from the **db**, not the config — `SELECT * FROM contracts`, each
  row's `head` becoming its cursor (`crates/indexer/engine/src/engine.rs`, `get_contracts`)
- the fetcher resolves, per contract, `from = cursor.head.map_or(world_block, |h| h + 1)`
  (`crates/indexer/fetcher/src/json_rpc.rs`)
- boot-time seeding from `contracts.json` is `INSERT OR IGNORE INTO contracts …`
  (`crates/sqlite/sqlite/src/lib.rs`), so an existing row keeps its `head` untouched

### When asked to index a contract older than the current index

Say this **before** editing `contracts.json` — the user's mental model is usually "this forces a long
re-sync", and that is not what happens:

- lowering `world_block` costs **nothing** for already-indexed contracts; they do not re-scan the gap
- the **new** contract does backfill from `world_block` (it has no row yet) — that part just works
- **re-indexing an *existing* contract from an earlier block requires wiping data**: the Railway
  volume (full re-sync of everything) or that contract's `contracts` row + its rows by hand
  (`pnpm ssh`, then `sqlite3 /data/torii-db/torii.db`). Warn, give both options, let the user choose —
  never wipe anything without being asked.
- `enabled: false` on an already-indexed contract **does not stop indexing it** either — same reason,
  the list comes from the db
- check reality before reasoning about it:
  `curl -sG <toriiUrl>/sql --data-urlencode "query=SELECT contract_address, head FROM contracts"`

### 1.8.16 bug — recheck on a version bump

A contract's own `block` never lands in the db. The seeding statement names four columns with three
placeholders (`id, contract_address, contract_type, updated_at`) and binds a fourth argument
(`starting_block - 1`) that has no matching placeholder and no `head` column; `head` is nullable with
no default. So a **new** contract starts at the global `world_block`, not at its own block — a wider
scan, not wrong data. This makes the generator's `TYPE:address:start_block` form effectively inert.

## Reference checkouts

**`/Users/roger/Dev/Dojo`** — local checkouts of `dojo`, `torii`, `dojo.js`, `dojo.c`, `controller`,
`origami`. Read these for authoritative Dojo/Torii behaviour instead of guessing or trusting stale
docs — but check the version they sit at against the pinned `TORII_VERSION` first.
