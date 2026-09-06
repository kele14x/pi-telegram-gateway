# AGENTS.md — pi-telegram-gateway

Context for AI agents (like pi) working in this repository.

## What this project is

A chat gateway: users talk to a **pi coding agent** from Telegram. The gateway
runs on the owner's machine, spawns one pi `AgentSession` per Telegram chat,
and streams replies into editable Telegram messages. Built on the
[@earendil-works/pi-coding-agent SDK](https://github.com/arendil-works/pi-coding-agent)

- [telegraf](https://github.com/telegraf/telegraf).

It is NOT a terminal UI and NOT an LLM provider — it reuses the owner's pi
config (`~/.pi/agent` auth/settings/models/extensions) as-is.

## How it works (data flow)

```plaintext
Telegram user ──> telegraf long-polling ──> index.ts handlers
                     │  (sender user allowlist: ALLOWED_TELEGRAM_IDS)
                     ▼
              ChatState (per chat id)
                     │  lazy: createAgentSession({cwd: chatCwd, sessionManager,
                     │        SessionManager.open(sessions/chat-<id>.jsonl, dir, cwdOverride)})
                     ▼
              AgentSession events ──> TelegramStream (editable messages)
```

- **One session per chat**, persisted as `sessions/chat-<chatid>.jsonl`
  (pi's own session format; survives restarts, resumed on next message).
- **Per-chat working folder** (`/cd`): stored in `sessions/meta.json`, applied
  via `SessionManager.open(file, dir, cwdOverride)` + `createAgentSession({cwd})`.
  A session file's header cwd may be older than the current chat cwd — that's
  intentional; always pass the chat cwd, never rely on the header.
- **Per-chat model/thinking** (`/model`, `/thinking`): also stored in
  `sessions/meta.json` and restored in `createChatSession` (meta → env
  `PI_TELEGRAM_MODEL`/`PI_TELEGRAM_THINKING` → pi default), so they survive
  `/cd`, `/new`, and restarts. A stored model that no longer resolves degrades
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

## Key files

| File | Responsibility |
| --- | --- |
| `index.ts` | entrypoint: config (.env), telegraf wiring, user allowlist, commands, per-chat session hub, bootstrap (ModelRuntime / DefaultResourceLoader / SettingsManager) |
| `chat-settings.ts` | creates an in-memory settings layer per Telegram chat so model/thinking changes never rewrite the owner's pi settings |
| `chat-meta.ts` | parses/atomically writes `sessions/meta.json` (per-chat cwd + model/thinking) |
| `history.ts` | deletes one per-chat SDK history file and deliberately propagates failure to `/new` |
| `instance-lock.ts` | atomic, heartbeat-backed single-instance lock plus ownership metadata |
| `session-errors.ts` | defers assistant error rendering until `agent_end` determines whether the attempt will retry |
| `telegram-stream.ts` | `TelegramStream`: live edits, chunking >3900 chars, ~800 ms edit throttle, 429 retry (retry-after honored, cap 30 s) |
| `scripts/rotate-logs.mjs` | archives non-empty logs before managed launches and retains 20 archives per log type |
| `setup-autostart.ps1` | safely replaces and registers Windows Scheduled Task `pi-telegram-gateway` (logon start, crash-restart, hidden window via generated `gateway-hidden.vbs`) |
| `remove-autostart.ps1` | idempotent task/launcher cleanup; reads the existing task XML so a task registered from an old repo path can be removed safely without deleting config/data/logs |
| `start-gateway.ps1` / `stop.ps1` / `status.ps1` | manual start (detached), clean stop (kills leaked task tree), status overview |
| `scripts/help.mjs` | `npm run help` cheat sheet |
| `test/` | offline tests: `stream-test.mjs` (chunking/retry), `cd-test.mjs` (cwd override reopen), `chat-meta-test.mjs` (meta.json parse/write), `commands-scope.mjs` (per-scope command menus) |
| `sessions/` | runtime data: per-chat `.jsonl` histories + `meta.json` (per-chat cwd/model/thinking) — **gitignored** |

## Non-negotiable rules

1. **Never touch or print secrets.** `.env` (bot token), `sessions/`,
   `logs/`, and `node_modules/` are gitignored — keep it that way. Never add
   them to a commit, never echo the token, never commit real Telegram ids.
   When changing code, search for accidental secrets before committing.
2. **Preserve the single-instance guarantee.** `index.ts` atomically acquires
   the heartbeat lock `logs/gateway.instance.lock` and writes owner metadata to
   `logs/gateway.lock` (`isSelftest` skips this). Do not weaken it; the scheduled
   task's crash-restart depends on stale-lock recovery and owner-safe release.
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

## Configuration (.env)

| Var | Meaning |
| --- | --- |
| `TELEGRAM_BOT_TOKEN` | bot token (required; from BotFather) |
| `ALLOWED_TELEGRAM_IDS` | comma-separated allowed **user** ids; group ids never grant group-wide access |
| `PI_TELEGRAM_DROP_PENDING_UPDATES` | opt-in discard of updates accumulated while offline; default false |
| `PI_TELEGRAM_CWD` | default working folder for new chats |
| `PI_TELEGRAM_SESSIONS_DIR` | where `sessions/` lives |
| `PI_TELEGRAM_MODEL` / `PI_TELEGRAM_THINKING` | startup model / thinking level |
| `PI_TELEGRAM_APPEND_PROMPT` | extra system-prompt instructions |
| `TELEGRAM_PROXY` / `HTTPS_PROXY` | optional proxy for Telegram API |

Model credentials come from `~/.pi/agent/` — never embed keys in code.

## Development workflow

- **Node ≥ 24, TypeScript run natively by Node (no build step).** Plain TS only:
  no enums, no parameter properties, no namespaces — Node strips types but
  rejects those constructs (`ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`).
  `/^\|` mixing `??` and `||` needs parentheses; relative imports need `.ts`.
- **Validation before done:** `npm run typecheck` (tsc --noEmit),
  `npm test` (offline). `npm run selftest` runs a REAL model prompt (costs a
  few tokens) — use sparingly, never to iterate.
- **Tests mirror the areas they cover:** streaming/chunking changes → add a
  scenario to `test/stream-test.mjs`; session/cwd logic → extend
  `test/cd-test.mjs`. Keep tests offline (mock bots, no Telegram).
- **Ops on the dev machine (Windows):**
  - `npm run start` (foreground, debugging) / `npm run start:daemon`
    (background via scheduled task, hidden window, crash-restart) /
    `npm run stop` / `npm run status`.
  - gateway runs detached via Task Scheduler; logs to `logs/gateway.log`;
    `logs/archive/` keeps the newest 20 rotated pre-launch logs per log type.
  - `git pull` from upstream is fine but review diffs — the gateway holds
    shell access to the machine (public repo; supply-chain caution).
- Runs on Windows (paths, PowerShell scripts); keep cross-platform where free,
  but never break Windows behavior (hidden-window task scripts).

## Repo hygiene

- Commit messages: imperative, concise, prefixed by area when relevant
  (e.g. `Stream: ...`, `Docs: ...`, `Autostart: ...`).
- Branch `main` is the only branch. Commits stay local until the user asks to
  push (see rule 8).
- Public repo — no secrets, no personal ids (real Telegram chat ids in tests
  must be placeholders or read from `.env`).
