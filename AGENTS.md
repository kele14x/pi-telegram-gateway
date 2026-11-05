# AGENTS.md — pi-telegram-gateway

Context for AI agents (like pi) working in this repository.

## What this project is

A chat gateway: users talk to a **pi coding agent** from Telegram. The gateway
runs as a **Docker Compose service** on the owner's machine, spawns one pi
`AgentSession` per Telegram chat, and streams replies into editable Telegram
messages. Rootless Podman Compose is also supported. Built on the
[@earendil-works/pi-coding-agent SDK](https://github.com/arendil-works/pi-coding-agent)

- [telegraf](https://github.com/telegraf/telegraf).

It is NOT a terminal UI and NOT an LLM provider. Docker and Podman use isolated
pi configuration in the managed `data` volume (`/data/pi-agent`). Running the
gateway directly on the host is not supported; the former Linux systemd helper
is preserved only as an unsupported reference in `examples/systemd/`.

## How it works (data flow)

```plaintext
Telegram user ──> telegraf long-polling ──> index.ts handlers
                     │  (sender user allowlist: ALLOWED_TELEGRAM_IDS)
                     ▼
              ChatState (per chat id)
                     │  lazy: createAgentSession({cwd: chatCwd, sessionManager,
                     │        SessionManager.open(/data/sessions/chat-<id>.jsonl, dir, cwdOverride)})
                     ▼
              AgentSession events ──> TelegramStream (editable messages)
```

- **One session per chat**, persisted as `/data/sessions/chat-<chatid>.jsonl`
  (pi's own session format; survives restarts, resumed on next message).
- **Per-chat working folder** (`/cwd`): stored in `/data/sessions/meta.json`,
  applied via `SessionManager.open(file, dir, cwdOverride)` +
  `createAgentSession({cwd})`.
  A session file's header cwd may be older than the current chat cwd — that's
  intentional; always pass the chat cwd, never rely on the header.
- **Per-chat project context:** session creation uses a fresh resource loader and
  isolated settings for the chat cwd. On resume, a persisted context notice
  identifies the current folder and scopes earlier instructions as historical.
  The SDK replaces/removes active project instructions on the next prompt;
  conversation history remains intact.
- **Per-chat model/thinking** (`/model`, `/thinking`): also stored in
  `/data/sessions/meta.json` and restored in `createChatSession` (meta → env
  `PI_TELEGRAM_MODEL`/`PI_TELEGRAM_THINKING` → pi default), so they survive
  `/cwd`, `/new`, and restarts. A stored model that no longer resolves degrades
  to the startup default with a log line. Runtime isolation still comes from
  `chat-settings.ts` (in-memory settings layer).
- **Streaming**: `message_update` `text_delta` events are appended to a
  `TelegramStream`; `tool_execution_start/end` update a status line; the run is
  finalized on `agent_end` (NOT `message_end` — multiple assistant turns per
  run). `agent_start` resets the stream.
- **Queueing**: handlers are non-blocking — they dispatch into a per-chat
  `ChatState.chain` and return, so Telegram polling (and `/stop`) is never
  held up by a long agent run. If a prompt is already running, an immediate
  `📥 Queued` acknowledgment is sent; the SDK's `followUp` queue is a fallback.
- **Cancellation**: `/stop` bumps a per-chat generation token (queued chain
  jobs check it and drop themselves), clears the SDK queue, and aborts the
  active run. `/new` does the same before disposing the session and deleting
  the history file. `/model`/`/thinking` are serialized behind the prompt
  chain via `enqueueChatOp`.
- **Shutdown**: `SIGINT`/`SIGTERM` close ingress and invalidate all chat
  generations, clear SDK queues, and abort sessions concurrently. Current jobs,
  session creation/replacement, stream finalization, and notices share a 10 s
  deadline before disposal and exit. Background finalization promises are tracked
  even when a second `finalize()` call returns early. Forced kills bypass this.
- **Lifecycle events**: the lock owner records start/stop/exit/fatal, unclean
  previous runs, cancelled/failed runs, setting changes, model fallbacks, and
  history resets via `recordEvent()` into `/data/logs/gateway-events.jsonl`.
  `CHAT_HINT` tells the agent where it is. Never record message text or secrets;
  selftest records nothing.

## Key files

| File | Responsibility |
| --- | --- |
| `index.ts` | entrypoint: config (.env), telegraf wiring, user allowlist, commands, per-chat session hub, bootstrap (ModelRuntime / DefaultResourceLoader / SettingsManager) |
| `chat-settings.ts` | creates an in-memory settings layer per Telegram chat so model/thinking changes never rewrite the owner's pi settings |
| `chat-resources.ts` | loads resources/settings for the current chat cwd and records a context boundary when reopening retained history |
| `chat-meta.ts` | parses/atomically writes `/data/sessions/meta.json` (per-chat cwd + model/thinking) |
| `history.ts` | deletes one per-chat SDK history file and deliberately propagates failure to `/new` |
| `instance-lock.ts` | atomic, heartbeat-backed single-instance lock plus ownership metadata; reports metadata left by a dead owner |
| `gateway-events.ts` | bounded JSON-lines lifecycle log (`/data/logs/gateway-events.jsonl`, ~500 entries) for the agent; redacted, metadata only, never throws |
| `session-errors.ts` | defers assistant error rendering until `agent_end` determines whether the attempt will retry |
| `agent-process.ts` / `agent-protocol.ts` / `agent-worker.ts` | isolated agent execution: parent process, worker bootstrap, and worker protocol |
| `telegram-stream.ts` | `TelegramStream`: live edits, chunking >3900 chars, ~800 ms edit throttle, 429 retry (retry-after honored, cap 30 s) |
| `telegram-format.ts` | Markdown to native Telegram text/entities; UTF-16-safe chunking after rendering so formatting spans survive message splits |
| `scripts/help.mjs` | `npm run help` cheat sheet |
| `Dockerfile` / `docker-compose.yml` / `.dockerignore` | single-stage `node:26-slim` (Debian 13) with Node 26 LTS + bash/git/curl/ripgrep/fd-find; one managed data volume for isolated pi config, history, and locks; interactive pi setup; only the workspace is host-mounted |
| `compose.podman.yaml` | Podman-only Compose override: `userns_mode: keep-id` and private SELinux workspace label; never merge into `docker-compose.yml` |
| `contrib/pi-telegram-gateway-docker.service` | systemd system unit template for Docker Compose autostart; rootful Docker, foreground `up`, `down` on stop |
| `contrib/pi-telegram-gateway-podman.service` | systemd user unit template for rootless Podman Compose autostart; foreground `up`, `down` on stop |
| `examples/systemd/` | unsupported direct-host systemd helper, log rotation, and their manual tests; kept for reference only, never wired into `package.json` or `npm test` |
| `test/` | `npm test` runs ten offline scripts: `stream-test.mjs` (formatting/chunking/retry), `cd-test.mjs` (cwd override reopen), `chat-meta-test.mjs` (meta.json parse/write), `settings-test.mjs` (settings isolation), `lock-test.mjs` (instance lock), `events-test.mjs` (lifecycle event log), `residual-test.mjs` (errors/history removal/redaction), `shutdown-test.mjs` (abort/delivery/deadline), `agent-process-test.mjs` (isolated agent execution), `container-test.mjs` (Compose/Podman recipes and docs) |
| `test/commands-scope.mjs` | manual online command-menu diagnostic: reads `.env` and calls Telegram; excluded from `npm test` |
| `sessions/` | host-side runtime data for the unsupported example only: per-chat `.jsonl` histories + `meta.json` — **gitignored**; Compose uses `/data/sessions` |

## Non-negotiable rules

1. **Never touch or print secrets.** `.env` (bot token), `sessions/`,
   `logs/`, and `node_modules/` are gitignored — keep it that way. Never add
   them to a commit, never echo the token, never commit real Telegram ids.
   When changing code, search for accidental secrets before committing.
2. **Preserve the single-instance guarantee.** `index.ts` atomically acquires
   the heartbeat lock `/data/logs/gateway.instance.lock` and writes owner metadata
   to `/data/logs/gateway.lock` (`isSelftest` skips this). Do not weaken it;
   Compose restarts and stale-lock recovery depend on owner-safe release.
3. **Keep Telegram constraints enforced in `TelegramStream`:** 4096-char
   message limit (seal at 3900), throttled edits, 429 retry. Telegram has no
   patience for rapid edits; do not add unbounded edit loops.
4. **Per-chat cwd is the truth for tools.** Always resolve chat cwd from
   `ChatState`/`meta.json`; never global `DEFAULT_CWD` in per-chat paths.
5. **Command changes must stay in sync.** Adding/renaming a bot command
   requires updating ALL of: the handler, `KNOWN_COMMANDS`,
   `BOT_COMMANDS` (also re-synced on startup via `setMyCommands` — scopes:
   default, `all_private_chats`, `all_group_chats`; stale scoped lists shadow
   defaults, see `test/commands-scope.mjs`), `scripts/help.mjs`, and README.
6. **IPv4-only networking is opt-in via `PI_TELEGRAM_IPV4_ONLY=true`.** The
   default is normal dual-stack. Only enable the env switch on machines where
   broken IPv6 stalls node-fetch v2 (it has no happy-eyeballs) — don't
   hardcode `dns.setDefaultResultOrder("ipv4first")` unconditionally.
7. **Session manager is opaque** — use the documented API (`SessionManager.open`,
   `createAgentSession`), don't hand-edit `.jsonl` session files.
8. **Never push to the remote automatically.** Commit locally, run the full
   validation, and push ONLY when the user explicitly asks.
9. **Keep Podman-only settings out of Docker.** `userns_mode: keep-id` and
   `--in-pod=false` belong in `compose.podman.yaml` / Podman commands, never in
   `docker-compose.yml`. The user unit in
   `contrib/pi-telegram-gateway-podman.service` must run `podman-compose up` in
   the foreground: `up -d` + `podman wait` can be killed by systemd cgroup
   cleanup.
10. **Compose is the only supported deployment.** Docker Compose is canonical;
    rootless Podman Compose is the supported equivalent. Do not reintroduce
    `npm start`, host daemon scripts, or host systemd units as supported paths.
    `examples/systemd/` is reference-only and must stay out of `package.json`,
    `npm test`, and the documented workflow. The optional systemd units in
    `contrib/pi-telegram-gateway-docker.service` (system/rootful Docker) and
    `contrib/pi-telegram-gateway-podman.service` (user/rootless Podman) must
    keep supervising a Compose stack, not a direct host process.

## Configuration (.env)

| Var | Meaning |
| --- | --- |
| `TELEGRAM_BOT_TOKEN` | bot token (required; from BotFather) |
| `ALLOWED_TELEGRAM_IDS` | comma-separated allowed **user** ids; group ids never grant group-wide access |
| `PI_TELEGRAM_DROP_PENDING_UPDATES` | opt-in discard of updates accumulated while offline; default false |
| `PI_TELEGRAM_CWD` | default working folder for new chats (Compose sets `/workspace`) |
| `PI_TELEGRAM_SESSIONS_DIR` | where per-chat history lives (Compose sets `/data/sessions`) |
| `PI_TELEGRAM_MODEL` / `PI_TELEGRAM_THINKING` | startup model / thinking level |
| `PI_TELEGRAM_APPEND_PROMPT` | extra system-prompt instructions |
| `TELEGRAM_PROXY` / `HTTPS_PROXY` | optional proxy for Telegram API |

Model credentials live in the Compose `data` volume at `/data/pi-agent/`
(Docker or Podman) — never embed keys in code.

## Development workflow

- **Node ≥ 26 (LTS), TypeScript run natively by Node (no build step).** Plain TS only:
  no enums, no parameter properties, no namespaces — Node strips types but
  rejects those constructs (`ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`).
  `/^\|` mixing `??` and `||` needs parentheses; relative imports need `.ts`.
- **Validation before done:** `npm run typecheck` (tsc --noEmit),
  `npm test` (offline). `npm run selftest` is a host development diagnostic that
  runs a REAL model prompt (costs a few tokens) — use sparingly, never to iterate.
- **Tests mirror the areas they cover:** streaming/chunking changes → add a
  scenario to `test/stream-test.mjs`; session/cwd logic → extend
  `test/cd-test.mjs`; agent process/protocol changes → extend
  `test/agent-process-test.mjs`; Compose/Podman recipe changes → extend
  `test/container-test.mjs`. Keep tests offline (mock bots, no Telegram).
- **Deployment is Compose-only.** Run the gateway with `docker compose` or the
  rootless Podman equivalent. Do not add `start`/daemon/autostart scripts back
  to `package.json`; the former Linux systemd helper lives in `examples/systemd/`
  as unsupported reference only. Its manual tests are not part of `npm test`.
- **Docker:** first `docker compose run --rm --build pi-setup` for `/login` and
  `/model`, then `docker compose up -d --build`. Setup uses the bundled pi CLI
  and runs only on demand (the `setup` profile); no host pi install is needed.
  Both services share one `data` volume at `/data`: pi config in `/data/pi-agent`,
  Telegram history in `/data/sessions`, locks in `/data/logs` via `/app/logs`.
  Only the gateway mounts the selected host workspace. Setup receives configured
  HTTP_PROXY/HTTPS_PROXY/NO_PROXY without the bot token. Never mount host pi
  config into the Compose services or bake credentials, `.env`, or history into
  the image. Compose forces container cwd/sessions/agent-dir paths. `down` keeps
  data; `down -v` destroys credentials and history. Keep setup/gateway PUID/PGID consistent
  and the 15 s stop grace period above the gateway's 10 s shutdown deadline.
  The Dockerfile copies sources with `COPY --chmod=0644`, so a checkout with
  restrictive modes (e.g. `0600`) does not break the non-root container user.
  Optional systemd system-unit autostart for the Docker Compose stack lives in
  `contrib/pi-telegram-gateway-docker.service`; install it under
  `/etc/systemd/system/` and manage it with `sudo systemctl`.
- **Rootless Podman:** install `podman-compose` separately (Podman is a native
  package, not Python). Use `podman-compose --in-pod=false -p pi-telegram-gateway
  -f docker-compose.yml -f compose.podman.yaml ...` consistently with the user unit
  and credential import volume. Match PUID/PGID to the host ids for `keep-id`.
  The Podman override privately relabels only the workspace with `:Z`; the
  one-shot credential import disables SELinux separation to avoid relabelling
  host pi configuration. Set `PI_TELEGRAM_IPV4_ONLY=true` in `.env` only on hosts
  with broken IPv6; do not force it in the shared override. Autostart uses
  `contrib/pi-telegram-gateway-podman.service`; manage it with `systemctl --user`.
  A manual `podman-compose down` while the unit is active is restarted by systemd.
- `git pull` from upstream is fine but review diffs — the gateway holds
  shell access to the machine (public repo; supply-chain caution).

## Repo hygiene

- Commit messages: imperative, concise, prefixed by area when relevant
  (e.g. `Stream: ...`, `Docs: ...`, `Docker: ...`, `Podman: ...`).
- Branch `main` is the only branch. Commits stay local until the user asks to
  push (see rule 8).
- Public repo — no secrets, no personal ids (real Telegram chat ids in tests
  must be placeholders or read from `.env`).
