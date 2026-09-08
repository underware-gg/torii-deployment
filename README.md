# torii-deployment

[Torii](https://github.com/dojoengine/torii) indexer for the Pistols token contracts on Starknet
mainnet and sepolia, deployed on Railway. One config file, one build command, one generated
Docker folder per network.

## What's here

```
contracts.json          what to index, per network — the file you normally edit
template/               what ships in the image: Dockerfile (torii 1.8.16), entrypoint.sh,
                        scripts/generate-torii-config.mjs (contracts.json → torii TOML, at boot)
scripts/
  build-deploy.mjs      template/ + contracts.json → deploy/torii-<net>/
  find-deploy-block.mjs finds a contract's deployment block over RPC
deploy/torii-mainnet/   GENERATED — what Railway builds. Don't edit.
deploy/torii-sepolia/   GENERATED
```

## Operate

```bash
pnpm build      regenerate deploy/ from the root files
pnpm check      validate contracts.json, fail if deploy/ is stale
pnpm blocks     fill in any "block": 0 from the chain
git push        Railway rebuilds whichever folder changed
```

**Add a token:** add it to the right network in `contracts.json` with `"block": 0` and
`"enabled": true`, then `pnpm blocks && pnpm build && pnpm check`, commit, push. It backfills
next to the existing index.

**Remove a token:** `enabled: false` stops nothing once indexed — Torii reads its contract list
from the db. Delete its rows (or wipe the volume). Torii never indexes backwards; details in
[`CLAUDE.md`](./CLAUDE.md).

**Bump torii:** `ARG TORII_VERSION` in `template/Dockerfile` and `.tool-versions`, read the
[release notes](https://github.com/dojoengine/torii/releases), `pnpm build`, push.

## Railway — set once per service

|                | mainnet                     | sepolia                     |
| -------------- | --------------------------- | --------------------------- |
| project        | `pistols-solitaire-mainnet` | `pistols-solitaire-sepolia` |
| service        | `torii`                     | `torii`                     |
| Root Directory | `deploy/torii-mainnet`      | `deploy/torii-sepolia`      |
| Volume         | `/data`                     | `/data`                     |

Generate a domain on the app port; keep `9200` (metrics) private. Never set `PORT`.
`CORS_ORIGINS` is the only optional variable (default `*`).

## Local

```bash
pnpm dev                            torii via asdf, db in ./data/torii-db
DEPLOY=sepolia pnpm docker:build    build a deploy folder (docker:run / docker:shell likewise)
pnpm docker:build:amd64             what Railway runs — catches the glibc ≥ 2.39 requirement
pnpm health:mainnet                 curl the live /health
```

Endpoints: `/graphql` · `/sql` · `/mcp` · `/health` · gRPC on the same port · metrics on `:9200`.
