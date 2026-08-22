# pi ↔ Telegram chat gateway

Talk to a **pi coding agent** from Telegram — same agent, same tools (read/write
files, shell, models), but through a chat. Built on the
[pi SDK](https://github.com/arendil-works/pi-coding-agent), similar in spirit to
the Hermes agent's chat gateway.

Reply text **streams into Telegram as it's generated** (editable message), long
outputs are split across multiple messages, tool calls show as status lines
(`🔧 read…` → `✅ read`), and photos you send are passed to the agent as images.

## Requirements

- Node.js ≥ 24 (uses native TypeScript execution, no build step)
- An existing pi install with a configured model API key in `~/.pi/agent/auth.json`
  (auth/settings/models are reused as-is)
- A Telegram bot token from [@BotFather](https://t.me/BotFather)

## Setup

```bash
cd pi-telegram-gateway
npm install
copy .env.example .env        # (Windows: `copy .env.example .env`)
```

Edit `.env`:

```env
TELEGRAM_BOT_TOKEN=123456:ABC...          # from @BotFather
ALLOWED_TELEGRAM_IDS=                     # your numeric id(s), comma separated
```

Then start:

```bash
npm start
```

**If you don't know your Telegram id:** start the gateway anyway and send
`/start` to your bot from Telegram. The gateway logs every blocked message with
the sender's numeric id — add it to `ALLOWED_TELEGRAM_IDS` and restart.

> ⚠️ **Security:** the agent has full access to your machine (shell included).
> The allowlist is mandatory — until `ALLOWED_TELEGRAM_IDS` is set the gateway
> blocks everyone (helpfully telling you your own id). Never set
> `ALLOWED_TELEGRAM_IDS=*`.

## Commands

| Command | What it does |
| --- | --- |
| `any text` | send to the agent (queued if it's busy with something) |
| 📷 photo (+ caption) | sent as an image to the agent |
| `/cd <folder>` | switch this chat's working folder (absolute, relative, or `~`; history is kept) |
| `/cwd` | show current working folder |
| `/sessions` | session details for this chat (file, size, context, model) |
| `/new` | fresh conversation in the same folder |
| `/model [name]` | show model, e.g. `/model anthropic/claude-opus-4-5:high` |
| `/thinking [level]` | set/cycle thinking level (`off … max`) |
| `/stop` | abort the current run |
| `/status` | model, context size, session file, working folder |
| `/help`, `/start` | help text |

## Configuration

| Env var | Default | Meaning |
| --- | --- | --- |
| `TELEGRAM_BOT_TOKEN` | – (required) | bot token |
| `ALLOWED_TELEGRAM_IDS` | – (recommended) | comma-separated Telegram user/chat ids; everyone is blocked until set |
| `PI_TELEGRAM_CWD` | launch dir | default working folder for all chats (each chat can override with `/cd`) |
| `PI_TELEGRAM_SESSIONS_DIR` | `./sessions` | per-chat conversation history |
| `PI_TELEGRAM_MODEL` | session default | e.g. `openai/gpt-5:medium` (pi `--model` syntax) |
| `PI_TELEGRAM_THINKING` | session default | `off, minimal, low, medium, high, xhigh, max` |
| `PI_TELEGRAM_APPEND_PROMPT` | – | extra instructions appended to the system prompt |
| `TELEGRAM_PROXY` | – | HTTP(S) proxy for Telegram API calls (also honors `HTTPS_PROXY`/`HTTP_PROXY`). Needed if api.telegram.org is blocked. e.g. `http://127.0.0.1:7890` |

## How it works

- **One agent session per Telegram chat**, persisted as
  `sessions/chat-<chatid>.jsonl` (same format pi uses), so history survives
  gateway restarts. `/new` discards the file; `/cd` keeps it and opens the same
  history in a new folder.
- **`/cd <folder>`** changes the per-chat working folder (stored in
  `sessions/meta.json`): the agent's read/write/shell tools then operate there.
  Project-level skills/prompts/AGENTS.md are still discovered from the gateway
  launch folder.
- **Responses stream live**: deltas are accumulated and pushed to an editable
  Telegram message (~800 ms throttle). Past ~3 900 characters the message is
  sealed and a continuation message is started, so nothing hits Telegram's
  4096-char limit.
- **While busy**, new messages queue via the SDK's `followUp` mechanism
  (you get a `📥 Queued` notice); use `/stop` to interrupt.
- **Model / thinking** can be changed per chat at runtime.
- Multiple allowed users each get their own isolated session.

## Tests

```bash
npm test          # offline unit tests for the streaming/chunking logic
npm run selftest  # creates a session and sends one prompt (no Telegram needed)
```

## Troubleshooting

- **Gateway can't reach Telegram** (`ETIMEDOUT` to api.telegram.org): set
  `TELEGRAM_PROXY` (or `HTTPS_PROXY`) to a reachable proxy and restart.
- **`No matching model` / no API key**: check `~/.pi/agent/auth.json` and
  `~/.pi/agent/settings.json` (the gateway uses the same config as normal pi).
- **First run takes a few seconds**: `ModelRuntime.create()` + model catalog
  refresh on startup.
- **Long bash outputs**: the agent summarizes by default (see the appended
  system hint); the gateway splits anything that still comes through.
- Telegram rate limits appear in the console log as `[edit] 429 ...` — the next
  edit performs the retry.