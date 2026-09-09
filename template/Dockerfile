# Torii indexer — TEMPLATE, not built from here.
#
# `pnpm build` copies template/ into deploy/torii-<net>/ with `ENV NETWORK=<net>` inserted
# below, plus the root contracts.json. Railway builds those folders (Root Directory =
# deploy/torii-<net>) and nothing else. Edit here, `pnpm build`, commit both.

# --- fetch the pinned torii release binary ---------------------------------
FROM debian:trixie-slim AS torii-bin

# Underware's torii fork (upstream dojoengine/torii is no longer tracked). Its release
# workflow publishes torii_<tag>_linux_<arch>.tar.gz for every annotated `uw-v*` tag, the
# same layout as upstream, so TORII_REPO=dojoengine/torii TORII_TAG=v1.8.16 is the way back.
ARG TORII_REPO=underware-gg/torii
ARG TORII_TAG=uw-v1.9.3
# Populated by BuildKit (amd64 on Railway, arm64 on Apple Silicon).
ARG TARGETARCH

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

RUN set -eux; \
    arch="${TARGETARCH:-$(dpkg --print-architecture)}"; \
    url="https://github.com/${TORII_REPO}/releases/download/${TORII_TAG}/torii_${TORII_TAG}_linux_${arch}.tar.gz"; \
    curl -fsSL "$url" -o /tmp/torii.tar.gz; \
    tar -xzf /tmp/torii.tar.gz -C /usr/local/bin torii; \
    chmod +x /usr/local/bin/torii

# --- runtime ----------------------------------------------------------------
# Debian 13 (glibc 2.41) — the amd64 torii release needs glibc >= 2.39, so
# bookworm (2.36) fails at the `torii --version` check below. Keep this base
# at trixie or newer.
FROM node:22-trixie-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates tini sqlite3 \
    && rm -rf /var/lib/apt/lists/*

COPY --from=torii-bin /usr/local/bin/torii /usr/local/bin/torii
RUN torii --version && ldd --version | head -1

# NETWORK is set only in the generated per-network Dockerfiles (`ENV NETWORK=…` is inserted
# right below this comment by scripts/build-deploy.mjs). No default in the template, so a
# stray build of it can't silently index the wrong chain — entrypoint.sh refuses to start.
ENV TORII_DB_DIR=/data/torii-db \
    TORII_ARTIFACTS_DIR=/data/static \
    CONTRACTS_JSON_PATH=/app/contracts.json \
    GENERATED_TORII_TOML=/app/torii.generated.toml \
    METRICS_PORT=9200

WORKDIR /app
COPY contracts.json /app/contracts.json
COPY scripts/ /app/scripts/
COPY entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

# 8080 is only the local default — Railway injects $PORT and the generated
# config binds to it. 9200 is metrics; keep it off the public domain.
EXPOSE 8080 9200

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["/app/entrypoint.sh"]
