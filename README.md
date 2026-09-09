# torii-deployment

[Torii](https://github.com/underware-gg/torii) indexer (Underware's fork of
[dojoengine/torii](https://github.com/dojoengine/torii)) for the Pistols token contracts on Starknet
mainnet and sepolia, deployed on Railway. One config file, one build command, one generated
Docker folder per network.

## What's here

```
contracts.json          what to index and which torii (repo + tag), per network — the file you normally edit
template/               what ships in the image: Dockerfile (torii pin filled in per network), entrypoint.sh,
                        scripts/generate-torii-config.mjs (contracts.json → torii TOML, at boot)
scripts/
  build-deploy.mjs      template/ + contracts.json → deploy/torii-<net>/
  find-deploy-block.mjs finds a contract's deployment block over RPC
  compare-reference.mjs generated config vs the original pistols configs, side by side
test/                   node:test — generator output, validation, parity with reference/, torii boot
reference/pistols/      frozen copies of the original pistols torii_*.toml (never shipped)
deploy/torii-mainnet/   GENERATED — what Railway builds. Don't edit.
deploy/torii-sepolia/   GENERATED
```

## Operate

```bash
pnpm build      regenerate deploy/ from the root files
pnpm check      validate contracts.json, fail if deploy/ is stale
pnpm test       generator + validation + reference parity; boots torii if TORII_BIN (or PATH) is the pinned build
pnpm compare    print generated vs reference/pistols/ (a report, not a gate)
pnpm blocks     fill in any "block": 0 from the chain
git push        Railway rebuilds whichever folder changed
```

**Add a token:** add it to the right network in `contracts.json` with `"block": 0` and
`"enabled": true`, then `pnpm blocks && pnpm build && pnpm check`, commit, push. It backfills
next to the existing index.

**Remove a token:** `enabled: false` stops nothing once indexed — Torii reads its contract list
from the db. Delete its rows (or wipe the volume). Torii never indexes backwards; details in
[`CLAUDE.md`](./CLAUDE.md).

**Enable the pistols world / LORDS:** flip `enabled` in `contracts.json` (world under `worlds`, `lords`
under `contracts`), `pnpm build && pnpm check && pnpm test`, commit, push. `indexing.historical`,
`preconfirmed` and `raw_events` are already in place; they had to land before the world's first
backfill. The world starts at the oldest enabled block, not its own — see `CLAUDE.md`.

**Release torii:** in `../torii-underware` on a clean `main` at `origin/main`, tag and push only
the tag — the [Underware release](https://github.com/underware-gg/torii/actions/workflows/release.yml)
workflow builds the binaries, publishes the GitHub release and `ghcr.io/underware-gg/torii:<tag>`:

```bash
git tag -a uw-v1.9.3 -m "..." origin/main && git push origin uw-v1.9.3     # or ./scripts/release.sh candidate 1.9.3
```

When the run reaches `publish` it waits — approve the `underware-release` deployment on the run
page. Then the release is public and the tarballs download.

**Bump torii:** `torii.tag` under the network in `contracts.json` (each network pins its own
`torii: { repo, tag }`), `pnpm build && pnpm check && pnpm test`, push. `repo: dojoengine/torii`
+ `tag: v1.8.16` goes back to an upstream release.

## Railway — set once per service

|                | mainnet                     | sepolia                     |
| -------------- | --------------------------- | --------------------------- |
| project        | `pistols-torii-mainnet` | `pistols-torii-sepolia` |
| service        | `torii`                     | `torii`                     |
| Root Directory | `deploy/torii-mainnet`      | `deploy/torii-sepolia`      |
| Volume         | `/data`                     | `/data`                     |

Generate a domain on the app port; keep `9200` (metrics) private. Never set `PORT`.
`CORS_ORIGINS` is the only optional variable (default `*`).

The volume holds both the index (`/data/torii-db`) and the token-image cache behind `/static`
(`/data/static`, `TORII_ARTIFACTS_DIR`). Without it torii writes images to a temp dir that is
thrown away on every redeploy.

## Local

The fork is not on asdf. Download `torii_uw-v1.9.3_darwin_arm64.tar.gz` from the
[release](https://github.com/underware-gg/torii/releases) (or `cargo build --release --bin torii`
in `../torii-underware`) and point `TORII_BIN` at it; unset, `torii` on PATH is used.

```bash
TORII_BIN=~/bin/torii pnpm dev      db in ./data/torii-db, images in ./data/static
DEPLOY=sepolia pnpm docker:build    build a deploy folder (docker:run / docker:shell likewise)
pnpm docker:build:amd64             what Railway runs — catches the glibc ≥ 2.39 requirement
pnpm health:mainnet                 curl the live /health
```

Endpoints: `/graphql` · `/sql` · `/mcp` · `/health` · `/static/<contract>/<token_id>/image` ·
gRPC on the same port · metrics on `:9200`.
