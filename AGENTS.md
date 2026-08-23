# AGENTS.md — pi-telegram-gateway

Context for AI agents (like pi) working in this repository.

## What this project is

A chat gateway: users talk to a **pi coding agent** from Telegram. The gateway
runs on the owner's machine, spawns one pi `AgentSession` per Telegram chat,
and streams replies into editable Telegram messages. Built on the
[@earendil-works/pi-coding-agent SDK](https://github.com/arendil-works/pi-coding-agent)
+ [telegraf](https://github.com/telegraf/telegraf).

It is NOT a terminal UI and NOT an LLM provider — it reuses the owner's pi
config (`~/.pi/agent` auth/settings/models/extensions) as-is.

## How it works (data flow)

```
Telegram user ──> telegraf long-polling ──> index.ts handlers
                     │  (allowlist check: ALLOWED_TELEGRAM_IDS)
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
- **Streaming**: `message_update` `text_delta` events are appended to a
  `TelegramStream`; `tool_execution_start/end` update a status line; the run is
  finalized on `agent_end` (NOT `message_end` — multiple assistant turns per
  run). `agent_start` resets the stream.
- **Queueing**: if busy, `session.prompt(text, { streamingBehavior: "followUp" })`
  queues; per-chat `ChatState.chain` serializes submissions.

## Key files

| File | Responsibility |
| --- | --- |
| `index.ts` | entrypoint: config (.env), telegraf wiring, allowlist, commands, per-chat session hub, single-instance lock, bootstrap (ModelRuntime / DefaultResourceLoader / SettingsManager) |
| `telegram-stream.ts` | `TelegramStream`: live edits, chunking >3900 chars, ~800 ms edit throttle, 429 retry (retry-after honored, cap 30 s) |
| `setup-autostart.ps1` | registers Windows Scheduled Task `pi-telegram-gateway` (logon start, crash-restart, hidden window via generated `gateway-hidden.vbs`) |
| `start-gateway.ps1` / `stop.ps1` / `status.ps1` | manual start (detached), clean stop (kills leaked task tree), status overview |
| `scripts/help.mjs` | `npm run help` cheat sheet |
| `test/` | offline tests: `stream-test.mjs` (chunking/retry), `cd-test.mjs` (cwd override reopen), `commands-scope.mjs` (per-scope command menus) |
| `sessions/` | runtime data: per-chat `.jsonl` histories + `meta.json` (per-chat cwd) — **gitignored** |

## Non-negotiable rules

1. **Never touch or print secrets.** `.env` (bot token), `sessions/`,
   `logs/`, and `node_modules/` are gitignored — keep it that way. Never add
   them to a commit, never echo the token, never commit real Telegram ids.
   When changing code, search for accidental secrets before committing.
2. **Preserve the single-instance guarantee.** `index.ts` acquires
   `logs/gateway.lock` (PID) at startup and refuses to run if another instance
   is alive (`isSelftest` skips this). Do not weaken it; the scheduled task's
   crash-restart depends on it.
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
6. **IPv4-first networking is required here.** Host IPv6 is broken; keep
   `dns.setDefaultResultOrder("ipv4first")` and telegraf's IPv4-only agent
   (`ipv4Lookup`). Do not remove without verifying `api.telegram.org` over v6.
7. **Session manager is opaque** — use the documented API (`SessionManager.open`,
   `createAgentSession`), don't hand-edit `.jsonl` session files.
8. **Never push to the remote automatically.** Commit locally, run the full
   validation, and push ONLY when the user explicitly asks. Pushed mistakes are
   hard to correct: history rewrites require force-push (bad for any
   collaborator or mirror), and on a public repo a leaked credential or id may
   already be cached/copied by the time it's scrubbed. When in doubt, ask.

## Configuration (.env)

| Var | Meaning |
| --- | --- |
| `TELEGRAM_BOT_TOKEN` | bot token (required; from BotFather) |
| `ALLOWED_TELEGRAM_IDS` | comma-separated allowed ids; everyone else is blocked |
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
    `logs/archive/` keeps rotated pre-restart logs.
  - `git pull` from upstream is fine but review diffs — the gateway holds
    shell access to the machine (public repo; supply-chain caution).
- Runs on Windows (paths, PowerShell scripts); keep cross-platform where free,
  but never break Windows behavior (IPv4 agent, task scripts).

## Repo hygiene

- Commit messages: imperative, concise, prefixed by area when relevant
  (e.g. `Stream: ...`, `Docs: ...`, `Autostart: ...`).
- Branch `main` is the only branch. Commits stay local until the user asks to
  push (see rule 8).
- Public repo — no secrets, no personal ids (real Telegram chat ids in tests
  must be placeholders or read from `.env`).