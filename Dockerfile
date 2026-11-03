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

# World-writable so the container can run as any host uid (PUID/PGID).
RUN mkdir -p /app/sessions /app/logs /pi-agent/bin /workspace \
  && chmod 1777 /app/sessions /app/logs /pi-agent /pi-agent/bin /workspace /home/node

ENV NODE_ENV=production \
  HOME=/home/node \
  PI_CODING_AGENT_DIR=/pi-agent \
  PI_TELEGRAM_CWD=/workspace \
  PI_TELEGRAM_SESSIONS_DIR=/app/sessions

USER node
STOPSIGNAL SIGTERM
CMD ["node", "index.ts"]
