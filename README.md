<p align="center">
  <h1 align="center">pi-telegram-gateway</h1>
  <p align="center">Chat with a <a href="https://github.com/earendil-works/pi/tree/main/packages/coding-agent">pi coding agent</a> from Telegram — same agent, same tools, through a chat.</p>
</p>

> A chat gateway: your own full-coding-agent
> Telegram bot backed by the pi SDK, running on your machine.

## ✨ Features

- **One persistent agent session per Telegram chat** — history survives gateway
  restarts (pi's standard `.jsonl` session format, one file per chat)
- **Live streaming replies** — tokens are pushed into an editable message as
  they're generated (~800 ms cadence), so you watch the answer arrive
- **Formatted replies** — Markdown headings, bold/italic text, inline and fenced
  code, links, lists, and quotes render as native Telegram formatting on iOS,
  Android, and desktop. Formatting carries across continuation messages;
  tables remain readable monospace text. If Telegram rejects formatting, the
  same answer is retried as plain text.
- **Long-output handling** — output beyond Telegram's 4096-char limit is
  automatically split into continuation messages
- **Tool status inline** — watch the agent work: `🔧 read…` → `✅ read`
- **Photos** — send a picture and the agent sees it (as an image input)
- **Per-chat working folder** — `/cwd` shows the current folder;
  `/cwd <folder>` switches where the agent's tools operate and reloads that
  folder's project instructions and resources, persisted across restarts
- **Per-chat model & thinking** — `/model anthropic/claude-opus-4-5:high`,
  `/thinking medium`; choices are bound to the chat and survive `/cwd`, `/new`,
  and gateway restarts
- **Reuses your pi config** — same `~/.pi/agent` credentials, settings, models,
  and extensions as your terminal pi. No extra API keys.
- **Queueing** — messages sent while the agent is busy are queued
  (`📥 Queued`), or interrupt with `/stop`
- **Allowlist security** — only configured Telegram ids can talk to the agent

## 🧰 Requirements

- Node.js 26 LTS or newer (runs TypeScript natively, no build step)
- Linux with a systemd user manager for managed background operation;
  foreground operation uses `npm start`
- A pi install with a configured model key in `~/.pi/agent/auth.json`
- A bot token from [@BotFather](https://t.me/BotFather)

## 🚀 Quick start

```bash
git clone https://github.com/kele14x/pi-telegram-gateway.git
cd pi-telegram-gateway
npm install
cp .env.example .env        # edit it
npm start
```

`.env`:

```env
TELEGRAM_BOT_TOKEN=123456:ABC...     # from @BotFather
ALLOWED_TELEGRAM_IDS=123456789       # your Telegram user id(s), comma separated
```

**Don't know your Telegram id?** Start the gateway, send `/start` to your bot —
it replies with your numeric id, and the gateway logs it too. Add it to
`ALLOWED_TELEGRAM_IDS` and restart.

> ⚠️ **Security**: see the [Security](#-security) section. Short version — the
> agent has full access to your machine, and the allowlist is the only gate.

## 📖 Commands

| Command | What it does |
| --- | --- |
| `any text` | send to the agent (queued if it's busy) |
| 📷 photo (+ caption) | sent as an image to the agent |
| `/cwd [folder]` | show or switch this chat's working folder (absolute, relative, or `~`); history is kept |
| `/sessions` | conversation storage details (file, size, context count) |
| `/new` | fresh conversation (keeps the working folder) |
| `/model [name]` | show / switch model, e.g. `/model openai/gpt-5:medium` (persists per chat) |
| `/thinking [level]` | show / cycle thinking level (`off … max`) (persists per chat) |
| `/stop` | abort the current run and drop queued messages |
| `/status` | live activity, prompt queue, model, thinking, working folder |
| `/help` · `/start` | help text |

The bot's command menu (`/` button) is synced automatically at startup via
`setMyCommands`.

## ⚙️ Configuration

| Env var | Default | Meaning |
| --- | --- | --- |
| `TELEGRAM_BOT_TOKEN` | – (required) | bot token |
| `ALLOWED_TELEGRAM_IDS` | – (recommended) | comma-separated **user** ids allowed to chat; every group sender is checked individually; blocks everyone until set |
| `PI_TELEGRAM_CWD` | launch dir | default working folder for new chats (`/cwd` overrides per chat) |
| `PI_TELEGRAM_SESSIONS_DIR` | `./sessions` | where per-chat history is stored |
| `PI_TELEGRAM_MODEL` | session default | default model, e.g. `openai/gpt-5:medium` (pi `--model` syntax) |
| `PI_TELEGRAM_THINKING` | session default | initial thinking level |
| `PI_TELEGRAM_APPEND_PROMPT` | – | extra instructions appended to the system prompt |
| `TELEGRAM_PROXY` | – | HTTP(S) proxy for Telegram API calls (also honors `HTTPS_PROXY`/`HTTP_PROXY`) |
| `PI_TELEGRAM_IPV4_ONLY` | `false` | IPv4-first DNS + IPv4-only Telegram agent; enable only if broken IPv6 stalls calls (node-fetch v2 has no happy-eyeballs) |
| `PI_TELEGRAM_DROP_PENDING_UPDATES` | `false` | discard updates received while the gateway was offline; opt in only when abandoning that backlog intentionally |

## 🔄 Background operation and autostart

Managed background operation uses a Linux systemd user service:

```bash
npm run autostart:setup   # register/refresh autostart; does not start the bot
npm run start:daemon     # start the registered service now
npm run restart:daemon   # gracefully stop and restart it; start it if stopped
npm run status           # inspect service status
npm run stop             # stop the managed gateway and its child processes
npm run autostart:remove # stop and remove autostart; keep config/data/logs
```

Foreground operation remains `npm start`; stop it with Ctrl+C. Managed daemon
commands require Linux with a working systemd user manager. On other operating
systems or containers without systemd, use `npm start`.

The gateway holds an atomic, heartbeat-backed single-instance lock
(`logs/gateway.instance.lock`, with owner metadata in `logs/gateway.lock`) so
a manual `npm start` cannot run a second, conflicting poller in the same checkout.

The lock owner also appends lifecycle events to `logs/gateway-events.jsonl`, one
JSON object per line, keeping roughly the newest 500: `start`, `stopping`
(signal), `exit` (code), `fatal`, `shutdown_timeout`, `previous_run_unclean`
(the last run crashed or was killed), `run_cancelled` (`/stop`, `/new`, or
shutdown), `run_failed` (model, prompt, session, or photo errors), `settings_changed`
(`/cwd`, `/model`, `/thinking`), `model_fallback`, and `history_reset`.
Entries carry Telegram chat ids but never message text; known secrets are
redacted. The agent's system prompt names this file so it can explain restarts
or interrupted work.

On `SIGINT` (Ctrl+C) or `SIGTERM`, the gateway cancels queued work, requests
abort from all sessions concurrently, and waits for current jobs and pending
Telegram replies for up to **10 seconds total** before disposing sessions and
exiting. Chats with unfinished prompts receive an interruption notice when delivery
succeeds; resend unfinished requests after restarting. A forced process kill
bypasses this graceful shutdown.

Use `npm run restart:daemon` after changing code or `.env`. It runs
`systemctl --user restart pi-telegram-gateway.service`, following the same
graceful shutdown before starting again. It also starts an installed service
that is currently stopped. Active work and queued prompts are cancelled;
saved chat history is retained. Restart leaves autostart settings unchanged
and requires an existing service registered with `npm run autostart:setup`.

## 🐳 Docker

The gateway can also run in a container with its own pi configuration and
credentials, independent of the host's `~/.pi/agent`. No host pi installation
is required. The image uses Ubuntu 26.04 with Node.js 26 LTS and includes a minimal
tool set: `bash`, `git`, `curl`, `ripgrep`, and `fd-find` (`fdfind`). Add anything
else your projects need to the `Dockerfile`.

```bash
cp .env.example .env        # set TELEGRAM_BOT_TOKEN and ALLOWED_TELEGRAM_IDS
mkdir -p workspace          # or point PI_WORKSPACE at an existing writable folder
docker compose run --rm --build pi-setup
docker compose up -d --build
docker compose logs -f      # gateway output
docker compose down         # graceful stop (SIGTERM, 15 s grace period)
```

The setup command opens the bundled pi CLI inside Docker. Run `/login` to
configure an API key or OAuth login, then `/model` and press Ctrl+S to save a
default. Exit with `/quit` before starting the gateway. OAuth may require opening
a link in your host browser and pasting the result back into the CLI. Run setup
again whenever you need to change credentials or defaults; it does not start the
Telegram gateway or mount your host workspace. Custom endpoints can be configured
in `/data/pi-agent/models.json`; their addresses must be reachable from Docker.
Setup receives `HTTP_PROXY`, `HTTPS_PROXY`, and `NO_PROXY` from the shell or `.env`,
without receiving the bot token. `TELEGRAM_PROXY` remains Telegram-only. Proxy
addresses must be reachable inside the container; `127.0.0.1` is not the host.
Leave unused proxy variables unset, rather than blank or valueless in `.env`;
Podman Compose forwards those declarations instead of using saved pi defaults.

Compose mounts only your selected host workspace plus one Docker-managed volume:

| Mount | Container | Purpose |
| --- | --- | --- |
| `PI_WORKSPACE` (default `./workspace`) | `/workspace` | default working folder for new chats; read-write |
| volume `data` | `/data` | persistent pi configuration, Telegram history, and instance locks |

Inside the data volume:

- `/data/pi-agent`: API keys/OAuth tokens, settings, custom models, extensions,
  and Linux helper binaries. OAuth refreshes can update credentials here.
- `/data/sessions`: Telegram chat history and per-chat preferences (`meta.json`).
- `/data/logs`: instance locks and the lifecycle event log
  (`gateway-events.jsonl`); `/app/logs` points here so all gateway containers
  sharing the volume use the same lock.

Notes:

- Keep `.env` in the repository root. Compose reads it, but does not mount it.
  After editing it, run `docker compose up -d`; a plain restart does not reload it.
- Compose overrides `PI_TELEGRAM_CWD`, `PI_TELEGRAM_SESSIONS_DIR`, and
  `PI_CODING_AGENT_DIR` with container paths. `/cwd` accepts only container paths,
  such as `/workspace/my-project`.
- On Linux, set `PUID`/`PGID` in `.env` to your host user's ids (`id -u` / `id -g`)
  before first setup so files the agent creates in the workspace are owned by you.
  Keep the same ids for setup and gateway runs to retain access to saved credentials.
- Create the workspace folder before the first `up` (or set `PI_WORKSPACE` to an
  existing folder). If Docker has to create a missing bind-mount source, it
  creates it as `root`, and the container user cannot write to it.
- The Dockerfile copies sources and package files with `COPY --chmod=0644`, so a
  checkout with restrictive permissions (for example `0600`) is still readable
  by the non-root container user.
- `docker compose down` preserves the volume. **`docker compose down -v` deletes
  both credentials and conversation history.** Treat volume backups as secrets.
- Previous host pi configuration and separate Docker session/bin volumes are not
  imported or deleted. Authenticate separately; retain old volumes if you need
  to migrate history. `PI_AGENT_DIR` is no longer used by Compose.
- Don't run a host `npm start` and the container with the same bot token at the
  same time. Direct host operation still uses your host pi configuration.
- The agent can access its credentials and mounted workspace; Docker isolation
  does not protect these from the agent. Prefer dedicated provider credentials
  with appropriate spending limits, and mount only folders you intend to expose.
- Logs go to stdout (`docker compose logs`). The systemd `npm run *:daemon`
  and `autostart:*` commands don't apply. Compose's `restart: unless-stopped`
  handles crash recovery and restarts the container when Docker starts.

### Service setup

Run `npm run autostart:setup` as your normal user, without `sudo`. It writes
`~/.config/systemd/user/pi-telegram-gateway.service` (or
`$XDG_CONFIG_HOME/systemd/user/pi-telegram-gateway.service`) and enables it for
login startup. Start it immediately with `npm run start:daemon`. The service
restarts 1 minute after a failure. `npm run stop` requests graceful shutdown
and stops all child processes, including agent tools. A manual stop does not
trigger an automatic restart; start it again with `npm run start:daemon`.
Autostart remains enabled for the next user-manager startup (normally at login,
or at boot with lingering). Use `npm run autostart:remove` to remove autostart.

Node loads `.env` from the repository; credentials are never copied into the
unit. The service uses your existing pi configuration in `~/.pi/agent`, pins
the absolute Node and repository paths, and preserves the PATH available at
setup time. Put proxy configuration in `.env` so the service receives it even
when the user manager has a different environment from your shell.

Logs go to `logs/gateway.log` and `logs/gateway-err.log`. Before each managed
launch, non-empty logs are moved into `logs/archive/`; the newest 20 archives
are retained for each log type. `npm run status` shows service state and PID;
it does not print conversation history or log contents.

Re-run setup after moving the repo, changing your PATH, or upgrading Node.
Refreshing an existing service stops it; run `npm run start:daemon` afterward.
Removal stops the registered service even when it points at an older repo
location. Unrelated unit files and symlinks are rejected rather than replaced.

User services normally run while your login session is active. To keep the bot
running after logout and start it at boot, optionally enable lingering with
`loginctl enable-linger "$USER"` (your system may require administrator
authorization). See [systemd user lingering](https://www.freedesktop.org/software/systemd/man/latest/loginctl.html#enable-linger%20%5BUSER%E2%80%A6%5D).

## 🦭 Podman

The image and Compose stack also run under rootless Podman. Podman is a native
package (not Python); `podman-compose` is a separate Python provider. Keep
Podman-only settings in `compose.podman.yaml`, not in `docker-compose.yml`:

- Set `PUID`/`PGID` in `.env` to `id -u` / `id -g` before setup or credential
  import. `userns_mode: keep-id` preserves those host ids, but does not override
  Compose's explicit container user.
- The workspace bind mount uses `:Z` for a private SELinux label. Mount only a
  dedicated workspace: this relabels that folder and is not suitable for a
  folder shared with other containers requiring a different SELinux label.
- On hosts with broken IPv6, set `PI_TELEGRAM_IPV4_ONLY=true` in `.env`
  (node-fetch v2 has no happy-eyeballs). The tracked override does not force it.
- `--in-pod=false` is required because `podman-compose` otherwise creates a pod,
  and `userns_mode` cannot be combined with a pod.

Install the provider (Podman itself must already be installed):

```bash
# Distro package:
sudo apt install podman-compose

# Or the latest release in an isolated venv:
python3 -m venv ~/.local/venvs/podman-compose
~/.local/venvs/podman-compose/bin/pip install podman-compose
```

Add the venv's `bin` directory to `PATH`, or use the full path in the commands
below.

Manual start/stop:

```bash
export PATH="$HOME/.local/venvs/podman-compose/bin:$PATH"
mkdir -p workspace
podman-compose --in-pod=false -p pi-telegram-gateway -f docker-compose.yml -f compose.podman.yaml up -d gateway
podman-compose --in-pod=false -p pi-telegram-gateway -f docker-compose.yml -f compose.podman.yaml logs -f gateway
podman-compose --in-pod=false -p pi-telegram-gateway -f docker-compose.yml -f compose.podman.yaml down
```

All Podman commands and the user unit use the explicit project name
`pi-telegram-gateway`, regardless of the checkout folder or `COMPOSE_PROJECT_NAME`.
If you previously used another project name, retain its old volumes until you
have migrated credentials and history; do not run both stacks with the same bot.

The `data` volume layout is the same as Docker. Docker and Podman use separate
volume stores, so seeding one does not seed the other. To copy host credentials
into the Podman volume, the one-shot import container disables SELinux separation
for its read-only host mount rather than relabelling your host pi configuration:

```bash
podman run --rm --userns=keep-id --security-opt label=disable \
  -v pi-telegram-gateway_data:/data \
  -v "$HOME/.pi/agent:/host:ro" \
  pi-telegram-gateway:latest sh -ec '
    umask 077
    for f in auth.json settings.json models-store.json models.json; do
      if [ -f "/host/$f" ]; then
        cp "/host/$f" /data/pi-agent/
        chmod 600 "/data/pi-agent/$f"
      fi
    done
  '
```

### Podman autostart (systemd user service)

Render the tracked template and enable it:

```bash
COMPOSE_BIN="${COMPOSE_BIN:-${PODMAN_COMPOSE:-$(command -v podman-compose || true)}}"
COMPOSE_BIN="${COMPOSE_BIN:-$HOME/.local/venvs/podman-compose/bin/podman-compose}"
if [ -x "$COMPOSE_BIN" ]; then
  mkdir -p ~/.config/systemd/user &&
  sed -e "s|@PROJECT_DIR@|$PWD|g" \
      -e "s|@COMPOSE_BIN@|$COMPOSE_BIN|g" \
      -e "s|@COMPOSE_DIR@|$(dirname "$COMPOSE_BIN")|g" \
      contrib/pi-telegram-gateway-podman.service \
    > ~/.config/systemd/user/pi-telegram-gateway-podman.service &&
  systemctl --user daemon-reload &&
  systemctl --user enable --now pi-telegram-gateway-podman.service
else
  printf '%s\n' 'Set COMPOSE_BIN or PODMAN_COMPOSE to an installed executable.' >&2
fi
```

The unit runs `podman-compose up` in the foreground (not `up -d` + `podman wait`,
which systemd's cgroup cleanup can kill) and `down` on stop. `Restart=always`
restarts the stack after a crash. Manage it with `systemctl --user`; running
`podman-compose down` manually while the unit is active will be restarted by
systemd. Enable lingering for boot startup after logout:

```bash
loginctl enable-linger "$USER"
```

Do not run the host `npm run *:daemon`/autostart service and the Podman unit at
the same time: both would poll the same bot token.

## 🗃️ Sessions & working folders

- Every chat gets its own session: `sessions/chat-<chatid>.jsonl`
  (the same format pi uses), loaded lazily on first message and resumed on restart.
- `/cwd <folder>` keeps the same history file and re-opens it with the new folder
  as the agent's working directory — your conversation continues where you left off.
  It refuses to switch while work is queued or active. Wait for completion, or
  use `/stop` to explicitly cancel prompts before retrying `/cwd`.
- Per-chat folders persist across restarts in `sessions/meta.json`; per-chat
  model/thinking choices are stored there too, so they survive `/cwd`, `/new`,
  and restarts (a stored model that no longer exists falls back to the startup
  default).
- Project instructions (`AGENTS.md`, including applicable ancestors), settings,
  skills, prompts, and extensions are loaded from the chat's current folder.
  Each reopened session gets its own loader and isolated settings.
- After a folder switch, the next request replaces the active project instructions
  and includes a context notice identifying the current folder. Earlier messages
  remain in history; earlier project instructions apply only where still relevant
  to the current project. Switching to a folder with no applicable `AGENTS.md`
  removes the old active instruction section.

## 🔐 Security

This gateway gives a Telegram user full access to a pi agent that runs on your
machine — including the shell. Read this.

**Access is gated by two independent secrets, both outside this repository:**

1. **Bot token** — without it, nothing can speak to Telegram as your bot.
2. **User allowlist** (`ALLOWED_TELEGRAM_IDS`) — the gateway only answers
   senders with those Telegram user ids, including inside groups. A group id
   never grants access to every member. A leaked token *alone* is not enough:
   an attacker would also need one of your allowed accounts.

**What is *not* in this repository:** your bot token (`.env`), per-chat
conversation history (`sessions/`), or your pi model credentials
(`~/.pi/agent/auth.json`). They are excluded or external — secrets are never
committed.

**Supply-chain caveat:** anyone with write access to the repo could push code
that runs on your machine the next time you pull and start the gateway.
That holds for any software you run from git.

**Recommendations:**

- Add only trusted numeric user ids. `*` is not supported and blocks everyone.
- Don't `git pull` blindly; review the diff (or pin to a commit hash).
- Don't add collaborators you don't trust; keep 2FA on your GitHub account.
- If you add an auto-update feature, pin by signed tag or commit hash.
- Treat the host running the gateway as fully controlled: the agent is as
  powerful as you are at a terminal.

## 🔬 Development

```bash
npm test              # run the nine offline regression scripts
npm run typecheck     # tsc --noEmit
npm run selftest      # real model prompt using pi credentials (no Telegram bot needed)
node test/commands-scope.mjs  # online diagnostic: reads .env and calls Telegram
```

The `npm test` suite covers Markdown formatting/streaming/chunking/retries, `/cwd` and project context,
chat metadata, settings isolation, instance locking, errors/history removal/redaction,
shutdown, log rotation, and Linux service management. It uses mocks
and temporary fixtures without contacting Telegram or a model provider.
The command-scope diagnostic inspects the bot's registered menus and is run
manually, separately from the offline suite. `selftest` sends a real model prompt
and may incur model usage costs.

Layout:

```plaintext
index.ts             bot wiring, session hub, commands
chat-settings.ts     isolated per-chat pi settings
chat-meta.ts         per-chat cwd/model/thinking persistence (meta.json)
history.ts           failure-aware per-chat history removal
instance-lock.ts     atomic heartbeat-backed process lock
session-errors.ts    terminal-vs-retry model error buffering
telegram-stream.ts   live streaming + chunking into editable messages
telegram-format.ts   Markdown to native Telegram text/entities + safe chunking
scripts/rotate-logs.mjs  bounded pre-launch log rotation
scripts/linux-service.mjs  systemd user-service setup and management
Dockerfile, docker-compose.yml  container image and Compose deployment
test/                offline regressions, online command-menu diagnostic
sessions/            per-chat session files (gitignored)
```

## 🛠️ Troubleshooting

- **Gateway can't reach Telegram** (`ETIMEDOUT`): set `TELEGRAM_PROXY` or
  `HTTPS_PROXY`. If Telegram calls stall on a network with broken IPv6, set
  `PI_TELEGRAM_IPV4_ONLY=true` to force IPv4 DNS resolution (some Telegram
  CDN endpoints are only reachable via v4).
- **`No matching model` / no API key**: check `~/.pi/agent/auth.json` and
  `~/.pi/agent/settings.json` — the gateway uses the same config as normal pi.
- **Menu still shows old commands**: stale *scoped* lists from previous gateway
  software shadow the default list; the gateway resets
  `all_private_chats` / `all_group_chats` and default scopes at startup.

## 🙏 Credits

- Built on the [pi coding agent SDK](https://github.com/earendil-works/pi/tree/main/packages/coding-agent)

## 📄 License

MIT
