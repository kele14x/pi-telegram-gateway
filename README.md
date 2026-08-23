<p align="center">
  <h1 align="center">pi-telegram-gateway</h1>
  <p align="center">Chat with a <a href="https://github.com/arendil-works/pi-coding-agent">pi coding agent</a> from Telegram — same agent, same tools, through a chat.</p>
</p>

> A chat gateway in the spirit of Hermes Agent: your own full-coding-agent
> Telegram bot backed by the pi SDK, running on your machine.

## ✨ Features

- **One persistent agent session per Telegram chat** — history survives gateway
  restarts (pi's standard `.jsonl` session format, one file per chat)
- **Live streaming replies** — tokens are pushed into an editable message as
  they're generated (~800 ms cadence), so you watch the answer arrive
- **Long-output handling** — output beyond Telegram's 4096-char limit is
  automatically split into continuation messages
- **Tool status inline** — watch the agent work: `🔧 read…` → `✅ read`
- **Photos** — send a picture and the agent sees it (as an image input)
- **Per-chat working folder** — `/cd <folder>` switches where the agent's
  files/shell tools operate, persisted across restarts
- **Per-chat model & thinking** — `/model anthropic/claude-opus-4-5:high`,
  `/thinking medium`
- **Reuses your pi config** — same `~/.pi/agent` credentials, settings, models,
  and extensions as your terminal pi. No extra API keys.
- **Queueing** — messages sent while the agent is busy are queued
  (`📥 Queued`), or interrupt with `/stop`
- **Allowlist security** — only configured Telegram ids can talk to the agent

## 🧰 Requirements

- Node.js ≥ 24 (runs TypeScript natively, no build step)
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
ALLOWED_TELEGRAM_IDS=123456789       # your Telegram numeric id(s), comma separated
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
| `/cd <folder>` | switch this chat's working folder (absolute, relative, or `~`); history is kept |
| `/cwd` | show the current working folder |
| `/sessions` | session details (file, size, context count, model) |
| `/new` | fresh conversation (keeps the working folder) |
| `/model [name]` | show / switch model, e.g. `/model openai/gpt-5:medium` |
| `/thinking [level]` | show / cycle thinking level (`off … max`) |
| `/stop` | abort the current run |
| `/status` | model, context size, session file, working folder |
| `/help` · `/start` | help text |

The bot's command menu (`/` button) is synced automatically at startup via
`setMyCommands`.

## ⚙️ Configuration

| Env var | Default | Meaning |
| --- | --- | --- |
| `TELEGRAM_BOT_TOKEN` | – (required) | bot token |
| `ALLOWED_TELEGRAM_IDS` | – (recommended) | comma-separated ids allowed to chat; blocks everyone until set |
| `PI_TELEGRAM_CWD` | launch dir | default working folder for new chats (`/cd` overrides per chat) |
| `PI_TELEGRAM_SESSIONS_DIR` | `./sessions` | where per-chat history is stored |
| `PI_TELEGRAM_MODEL` | session default | default model, e.g. `openai/gpt-5:medium` (pi `--model` syntax) |
| `PI_TELEGRAM_THINKING` | session default | initial thinking level |
| `PI_TELEGRAM_APPEND_PROMPT` | – | extra instructions appended to the system prompt |
| `TELEGRAM_PROXY` | – | HTTP(S) proxy for Telegram API calls (also honors `HTTPS_PROXY`/`HTTP_PROXY`) |
| `PI_TELEGRAM_IPV4_ONLY` | `false` | IPv4-first DNS + IPv4-only Telegram agent; enable only if broken IPv6 stalls calls (node-fetch v2 has no happy-eyeballs) |

## 🪟 Autostart (Windows)

A Scheduled Task keeps the gateway alive across logons and crashes:

```powershell
# one-time setup (registers 'pi-telegram-gateway' task)
powershell -ExecutionPolicy Bypass -File setup-autostart.ps1

# start it right now
schtasks /Run /TN "pi-telegram-gateway"

# check status
schtasks /Query /TN "pi-telegram-gateway"

# remove the task
schtasks /Delete /TN "pi-telegram-gateway" /F
```

The task runs the gateway in the foreground (logs to `logs/gateway.log`) so
Task Scheduler restarts it 1 minute after a crash. The gateway holds a
single-instance lock (`logs/gateway.lock`) so a manual `npm start` can never
run a second, conflicting poller. Re-run `setup-autostart.ps1` after moving the
repo or upgrading Node (it pins the Node path at setup time).

## 🗃️ Sessions & working folders

- Every chat gets its own session: `sessions/chat-<chatid>.jsonl`
  (the same format pi uses), loaded lazily on first message and resumed on restart.
- `/cd` keeps the same history file and re-opens it with the new folder as the
  agent's working directory — your conversation continues where you left off.
- Per-chat folders persist across restarts in `sessions/meta.json`.
- Project-level skills/prompts/`AGENTS.md` are still discovered from the launch
  folder (per-chat `/cd` affects file/shell tools).

## 🔐 Security

This gateway gives a Telegram user full access to a pi agent that runs on your
machine — including the shell. Read this.

**Access is gated by two independent secrets, both outside this repository:**

1. **Bot token** — without it, nothing can speak to Telegram as your bot.
2. **Allowlist** (`ALLOWED_TELEGRAM_IDS`) — the gateway only answers messages
   from those Telegram ids. A leaked token *alone* is not enough: an attacker
   would also need to send messages from one of your allowed accounts.

**What is *not* in this repository:** your bot token (`.env`), per-chat
conversation history (`sessions/`), or your pi model credentials
(`~/.pi/agent/auth.json`). They are excluded or external — secrets are never
committed.

**Supply-chain caveat:** anyone with write access to the repo could push code
that runs on your machine the next time you pull and start the gateway.
That holds for any software you run from git.

**Recommendations:**

- Never set `ALLOWED_TELEGRAM_IDS=*` — it disables the only real gate.
- Don't `git pull` blindly; review the diff (or pin to a commit hash).
- Don't add collaborators you don't trust; keep 2FA on your GitHub account.
- If you add an auto-update feature, pin by signed tag or commit hash.
- Treat the host running the gateway as fully controlled: the agent is as
  powerful as you are at a terminal.

## 🔬 Development

```bash
npm test          # offline unit tests: stream chunking + /cd cwd-override
npm run selftest  # create a session and run one prompt (no Telegram bot needed)
npm run typecheck # tsc --noEmit
node test/commands-scope.mjs  # inspect the bot's per-scope command menus
```

Layout:

```plaintext
index.ts             bot wiring, session hub, commands
telegram-stream.ts   live streaming + chunking into editable messages
test/                offline tests
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
- Gateway concept inspired by [Hermes Agent](https://github.com/1933Eran/Hermes.agent)

## 📄 License

MIT
