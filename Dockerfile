FROM node:24-slim

# safe.directory: bind-mounted workspaces may be owned by a different uid than the container user.
RUN apt-get update \
  && apt-get install -y --no-install-recommends bash ca-certificates curl git ripgrep fd-find \
  && rm -rf /var/lib/apt/lists/* \
  && git config --system safe.directory '*'

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY *.ts ./

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
