<p align="center">
  <h1 align="center">pi-telegram-gateway</h1>
  <p align="center">Chat with a <a href="https://github.com/arendil-works/pi-coding-agent">pi coding agent</a> from Telegram — same agent, same tools, through a chat.</p>
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

- Node.js ≥ 24 (runs TypeScript natively, no build step)
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

- Built on the [pi coding agent SDK](https://github.com/arendil-works/pi-coding-agent)

## 📄 License

MIT
