FROM node:26-slim AS node-runtime
FROM ubuntu:26.04

# safe.directory: bind-mounted workspaces may be owned by a different uid than the container user.
RUN apt-get update \
  && apt-get install -y --no-install-recommends bash ca-certificates curl git ripgrep fd-find libatomic1 libstdc++6 procps \
  && rm -rf /var/lib/apt/lists/* \
  && git config --system safe.directory '*' \
  && useradd --create-home --user-group node

COPY --from=node-runtime /usr/local/ /usr/local/

WORKDIR /app
# --chmod: host checkout permissions must not decide whether the non-root
# container user can read the sources (e.g. umask 077 checkouts).
COPY --chmod=0644 package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --chmod=0644 *.ts ./

# New volumes inherit these permissions so any configured host uid can initialize them.
RUN mkdir -p /data/pi-agent/bin /data/sessions /data/logs /workspace \
  && chmod 1777 /data /data/pi-agent /data/pi-agent/bin /data/sessions /data/logs /workspace /home/node \
  && ln -s /data/logs /app/logs

ENV NODE_ENV=production \
  HOME=/home/node \
  PI_CODING_AGENT_DIR=/data/pi-agent \
  PI_TELEGRAM_CWD=/workspace \
  PI_TELEGRAM_SESSIONS_DIR=/data/sessions

USER node
STOPSIGNAL SIGTERM
CMD ["node", "index.ts"]
