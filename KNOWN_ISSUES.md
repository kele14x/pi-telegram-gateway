# Known issues

Findings from a full code-base review on 2026-09-10, covering the TypeScript
core (`index.ts`, `telegram-stream.ts`, `chat-*.ts`, `history.ts`,
`instance-lock.ts`, `session-errors.ts`, `scripts/`, `test/`) and the Windows
ops scripts (`setup-autostart.ps1`, `remove-autostart.ps1`,
`start-gateway.ps1`, `stop.ps1`, `status.ps1`).

Baseline at review time: `npm run typecheck` and `npm test` both pass, and a
scan of the working tree and every commit in history found no bot-token-shaped
strings.

Numbering below matches the review conversation. Each entry records the failure
mode, the evidence, and a suggested fix. **Status** is `open` unless noted.

Priority is the triage bucket (**P0** blocking/security · **P1** critical, must
be solved · **P2** optional/improvement). Severity is the raw impact assessment
and deliberately does not always agree with priority — see
[Priority classification](#priority-classification-p0p1p2).

| # | Priority | Severity | Area | Summary |
| --- | --- | --- | --- | --- |
| [1](#1--high--bot-token-can-be-posted-into-a-telegram-chat) | **P0** | High | Security | Bot token can be sent into a Telegram chat via an unredacted error message |
| [2](#2--high--cd-moves-the-tools-but-leaves-the-system-prompt-describing-the-launch-folder) | **P1** | High | Sessions | `/cd` moves the tools but leaves the system prompt describing the launch folder |
| [3](#3--medium--cd-silently-discards-queued-messages) | **P1** | Medium | Commands | `/cd` silently discards queued messages |
| [4](#4--medium--shutdown-truncates-in-flight-replies) | **P1** | Medium | Lifecycle | `shutdown()` truncates in-flight replies |
| [5](#5--medium--unthrottled-this-bot-is-private-replies) | **P1** | Medium | Security | Unthrottled "This bot is private" replies |
| [6](#6--medium--withretry-has-no-backoff) | **P2** | Medium | Networking | `withRetry` has no backoff despite its name and comment |
| [7](#7--low--safesend-slices-on-a-raw-utf-16-boundary) | **P2** | Low | Delivery | `safeSend` slices on a raw UTF-16 boundary |
| [8](#8--low--model-and-thinking-create-a-session-just-to-read-state) | **P2** | Low | Commands | `/model` and `/thinking` create a session just to read state |
| [9](#9--low--stale-queued-commands-vanish-without-feedback) | **P2** | Low | Commands | Stale queued commands vanish without feedback |
| [10](#10--low--instance-lock-compromise-crashes-via-an-uncaught-throw) | **P2** | Low | Locking | Instance-lock compromise crashes via an uncaught throw |
| [11](#11--low--documentation-drift) | **P2** | Low | Docs | Documentation drift in AGENTS.md and README |
| [12](#12--low--lock-and-log-location-is-not-configurable) | **P2** | Low | Config | Lock and log location is not configurable |
| [13](#13--medium--stopps1-never-disables-the-task) | **P1** | Medium | Ops | `stop.ps1` never disables the task, so the gateway comes back |
| [14](#14--medium--setup-autostartps1-reports-success-when-task-creation-fails) | **P1** | Medium | Ops | `setup-autostart.ps1` reports success when task creation fails |
| [15](#15--medium--start-gatewayps1-can-truncate-an-un-rotated-log-and-fights-the-task) | **P2** | Medium | Ops | `start-gateway.ps1` can truncate an un-rotated log and fights the task |
| [16](#16--low--statusps1-can-abort-on-a-corrupt-lock) | **P2** | Low | Ops | `status.ps1` can abort on a corrupt lock |
| [17](#17--low--userid-is-interpolated-unescaped-into-the-task-xml) | **P2** | Low | Ops | `<UserId>` is interpolated unescaped into the task XML |
| [18](#18--low--log-retention-sort-uses-locale-collation) | **P2** | Low | Ops | Log-retention sort uses locale collation |
| [19](#19--low--the-single-instance-lock-is-per-repo-not-per-bot) | **P2** | Low | Locking | The single-instance lock is per-repo, not per-bot |

**Tally:** 1 × P0 · 6 × P1 · 12 × P2

**Fixed (2026-09-22):** findings 1 and 7. **Open tally:** 0 × P0 · 6 × P1 · 11 × P2.
The priority classification below records review-time impact, including fixed issues.

---

## Priority classification (P0/P1/P2)

Criteria used:

- **P0 — blocking / security.** Exposes a secret, or breaks access control. Fix
  before the next push, since this repository is public.
- **P1 — critical, must be solved.** Silently loses user work, silently
  misbehaves in a core documented feature, or breaks an operational contract the
  user relies on. No secret exposure and no crash-loop, so not P0.
- **P2 — optional / improvement.** Cosmetic, diagnostic-only, very unlikely
  preconditions, or a comment/name that misdescribes working behaviour.

### P0 — fix before pushing

| # | Finding | Why P0 |
| --- | --- | --- |
| [1](#1--high--bot-token-can-be-posted-into-a-telegram-chat) | Token posted into a Telegram chat | Credential exposure. In a group the token becomes visible to every member and persists in Telegram's cloud. Violates AGENTS.md rule 1. One-line fix. |

### P1 — must be solved

| # | Finding | Why P1 |
| --- | --- | --- |
| [2](#2--high--cd-moves-the-tools-but-leaves-the-system-prompt-describing-the-launch-folder) | `/cd` keeps the launch folder's `AGENTS.md` | Breaks the core purpose of `/cd`: the agent is given the *wrong project's* instructions for the folder it is editing. Silent, affects every `/cd` session. |
| [3](#3--medium--cd-silently-discards-queued-messages) | `/cd` drops queued prompts | Silent loss of user work, with a reply that claims nothing was lost. |
| [4](#4--medium--shutdown-truncates-in-flight-replies) | `shutdown()` truncates replies | Silent loss of output on every planned restart while busy — a routine event (Task Scheduler, `npm run stop`). |
| [5](#5--medium--unthrottled-this-bot-is-private-replies) | Unthrottled block replies | Abuse vector: any group member can spam the bot into a Telegram 429, degrading it for the owner. See the divergence note below. |
| [13](#13--medium--stopps1-never-disables-the-task) | `stop.ps1` leaves the task enabled | Breaks an explicit operational contract — the script prints "Gateway stopped." and the gateway relaunches at next logon. `remove-autostart.ps1` already has the correct guard. |
| [14](#14--medium--setup-autostartps1-reports-success-when-task-creation-fails) | False success from setup | The primary setup path reports success on failure, so autostart silently does not exist and the gateway will not survive a reboot. Also masks finding 17. |

### P2 — optional / improvement

| # | Finding | Why P2 |
| --- | --- | --- |
| [6](#6--medium--withretry-has-no-backoff) | `withRetry` has no backoff | Behaviour is acceptable; only the comment and function name mislead. |
| [7](#7--low--safesend-slices-on-a-raw-utf-16-boundary) | `safeSend` surrogate split | Needs an error message over 4096 chars that also straddles a surrogate pair. **Free to fix alongside finding 1 — same line.** |
| [8](#8--low--model-and-thinking-create-a-session-just-to-read-state) | Read-only commands create a session | Wasteful, not incorrect. |
| [9](#9--low--stale-queued-commands-vanish-without-feedback) | Dropped commands get no reply | UX polish; the drop itself is intentional. |
| [10](#10--low--instance-lock-compromise-crashes-via-an-uncaught-throw) | Lock compromise crashes unlogged | Already fail-closed, which is the correct outcome for rule 2. Only diagnosability is missing. |
| [11](#11--low--documentation-drift) | Doc drift | Docs only. Revisit after findings 1 and 2 land. |
| [12](#12--low--lock-and-log-location-is-not-configurable) | Hardcoded `logs/` path | Possibly intentional — the ops scripts depend on this exact location. |
| [15](#15--medium--start-gatewayps1-can-truncate-an-un-rotated-log-and-fights-the-task) | Log truncation + task conflict | See the divergence note below. |
| [16](#16--low--statusps1-can-abort-on-a-corrupt-lock) | `status.ps1` aborts on garbage lock | Diagnostic tool only; needs an already-corrupt lock file. |
| [17](#17--low--userid-is-interpolated-unescaped-into-the-task-xml) | Unescaped `<UserId>` | Needs `&`, `<`, or `>` in a Windows logon name — practically impossible. |
| [18](#18--low--log-retention-sort-uses-locale-collation) | Locale-dependent retention sort | Retention count is already correct; theoretical mis-ordering only. |
| [19](#19--low--the-single-instance-lock-is-per-repo-not-per-bot) | Lock is per-repo, not per-bot | Requires two checkouts pointed at one token — outside the documented single-machine deployment. Silent message loss if it happens, so worth documenting even if not fixed. |

### Where severity and priority diverge

These three are judgment calls and are the ones most worth arguing with:

- **Finding 2 is High severity but P1, not P0.** It is the most damaging
  *functional* defect in the codebase, but it neither exposes a secret nor breaks
  access control, and `/cd` still works correctly for file/shell tools — the
  agent operates in the right folder with the wrong briefing. High impact, not
  blocking.
- **Finding 5 is Medium severity but P1.** The access-control boundary itself
  holds (no unauthorised agent access is possible), which is why it is not P0.
  It is promoted above the other Medium findings because the impact is
  availability of the owner's own bot, and because it is exploitable by anyone
  who can reach the bot rather than only by the owner.
- **Finding 15 is Medium severity but P2.** Only log data is at risk, and only
  on a path where rotation has already failed. Its "fights the enabled task"
  half is largely a consequence of finding 13, so fixing 13 removes most of it;
  the truncation half is a one-line guard. Promote to P1 if finding 13 is not
  fixed, since the two compound.
### Suggested order of work

1. **Findings 1 and 7 — done (2026-09-22).** Redaction and Unicode-safe truncation.
2. **Finding 14** (P1, one `if`) — cheapest P1, and it un-masks finding 17.
3. **Finding 13** (P1) — then re-check finding 15.
4. **Finding 2** (P1, largest change) — per-cwd loader/settings cache, plus a
   `test/cd-test.mjs` assertion so it cannot regress.
5. **Findings 3 and 4** (P1) — both are small, localised changes in `index.ts`.
6. **Finding 11** last, so the docs describe the post-fix behaviour.

---

## High

### 1 · High — Bot token can be posted into a Telegram chat

**Where:** `index.ts:597` (`safeSend`), reached from `index.ts:524`.

**Failure mode (before the fix).** `safeSend()` forwarded text verbatim;
only `log()` ran `redactSecrets()`. Response errors from Telegraf's bundled
node-fetch v2 can include `https://api.telegram.org/bot<TOKEN>/getFile`.

**Verification correction (2026-09-22).** The original connection/socket-failure
example was inaccurate: Telegraf 4.16.3 redacts initial fetch failures via
`.catch(redactToken)` (`node_modules/telegraf/lib/core/network/client.js:304`).
However, `res.json()` at line 312 is outside that protection. Invalid JSON in a
response with status below 500, or a response-body stream failure after headers
arrive, can include the full URL in the resulting error
(`node_modules/telegraf/node_modules/node-fetch/lib/index.js:273`, `:400`).
Both paths reproduced the token leak offline with a synthetic token.

Path: an allowed user sends a photo → `ctx.telegram.getFileLink()` receives a
response-parsing/body error → `imageLoad` captures it (`index.ts:502-505`) →
`index.ts:524` passes its message to `safeSend()`. If the subsequent send
succeeds, **every member of the originating group can see the token**, not just
the allowed sender. This violates AGENTS.md rule 1 ("never echo the token").

**Fix applied.** Redact known secrets at the shared `safeSend()` boundary before
truncating, including tokens that straddle the original 4096-character cutoff:

```ts
const redacted = redactSecrets(text);
await bot.telegram.sendMessage(chatId, redacted.slice(0, chunkEnd(redacted, 4096)));
```

The exported `chunkEnd()` also prevents splitting surrogate pairs (finding 7).
`test/residual-test.mjs` exercises the actual photo-error handlers with bundled
node-fetch JSON/body errors, mocked delivery, and synthetic credentials. It also
covers repeated tokens, proxy credentials, truncation ordering, Unicode
boundaries, and redacted logging when delivery fails; no Telegram calls are made.

**Status:** fixed (2026-09-22).

---

### 2 · High — `/cd` moves the tools but leaves the system prompt describing the launch folder

**Where:** `index.ts:1095` (single shared `DefaultResourceLoader`),
`index.ts:243` (`resourceLoader: loader`), `index.ts:1094` (`settingsManager`).

**Failure mode.** One `DefaultResourceLoader` is constructed with
`cwd: DEFAULT_CWD` at startup and shared by every chat session. That cwd — not
the chat's cwd — drives the loader's:

- `AGENTS.md` ancestor walk (`loadProjectContextFiles`, `resource-loader.js:373`)
- project `.pi/skills`, `.pi/prompts`, `.pi/themes`, `.pi/extensions` roots
  (`resource-loader.js:627-632`)
- extension resolution path (`resource-loader.js:411`, `:421`)
- project `SYSTEM.md` / `APPEND_SYSTEM.md` overrides (`resource-loader.js:809`, `:820`)

`settingsManager = SettingsManager.create(DEFAULT_CWD, AGENT_DIR)` has the same
problem: `chat-settings.ts` copies `getProjectSettings()` and
`isProjectTrusted()` from the launch folder into every chat's isolated layer, so
project trust is evaluated for the wrong directory.

**Evidence.** Verified empirically rather than inferred. Creating a session with
`cwd` set to a temporary `other-project` (containing its own `AGENTS.md`) while
passing a loader built from the repo root:

```text
prompt has MARKER_OTHER (target project's AGENTS.md) : false
loader agentsFiles : [ '<repo>/AGENTS.md' ]
```

So after `/cd <some-other-project>`, the agent's file/shell tools operate in the
new folder while its system prompt still contains the launch folder's
`AGENTS.md` — i.e. it is told it is working on the Telegram gateway, with this
repo's rules, while editing an unrelated project. `test/cd-test.mjs` passes
because it only asserts the tool cwd, not the loaded project context.

`README.md:136-137` documents the mechanism ("Project-level
skills/prompts/`AGENTS.md` are still discovered from the launch folder") but not
this consequence. It also sits awkwardly with AGENTS.md rule 4 ("Per-chat cwd is
the truth for tools … never global `DEFAULT_CWD` in per-chat paths").

**Suggested fix.** Build and cache a `DefaultResourceLoader` (and a
`SettingsManager`) per resolved cwd, keyed by path, with one `await
loader.reload()` per key; pass the chat's own loader in `createChatSession`.
Extend `test/cd-test.mjs` to assert the target project's `AGENTS.md` is present
in the session after a cwd change.

**Status:** open.

---

## Medium

### 3 · Medium — `/cd` silently discards queued messages

**Where:** `index.ts:848-878`.

`/cd` refuses only when `st.session?.isStreaming` (`index.ts:855`); it never
checks `st.busy`. It then calls `advanceChatGeneration(st)` (`index.ts:870`),
which invalidates every queued `submitPrompt` job — each logs
"dropped queued message after cancellation" (`index.ts:517`) and returns. The
reply (`index.ts:874-877`) says only *"Conversation history is kept — your next
message continues in this folder"*, with no mention that N queued messages were
just thrown away. `/stop` is explicit about this ("dropped queued messages");
`/cd` is not.

**Suggested fix.** Either refuse when `st.busy > 0` (mirroring the streaming
check), or report the dropped count in the reply.

**Status:** open.

---

### 4 · Medium — `shutdown()` truncates in-flight replies

**Where:** `index.ts:1195-1209`.

`shutdown()` calls `bot.stop()` inside a `try`/`catch` without awaiting it, then
disposes every session synchronously and calls `process.exit(0)`. Nothing waits
for pending `TelegramStream` flushes or for an in-flight agent run to wind down.

On SIGTERM mid-run — a planned restart, `npm run stop`, or machine shutdown — the
user is left with a truncated message and no indication that it was cut off, and
sessions are disposed without `abort()`, so a provider request may be left
dangling.

**Suggested fix.** Await pending stream finalization (or at least post a
"🛑 gateway restarting" status) under a bounded timeout before exiting, and
`abort()` sessions before `dispose()`.

**Status:** open.

---

### 5 · Medium — Unthrottled "This bot is private" replies

**Where:** `index.ts:645-655`.

The access-guard middleware replies to *every* update from a non-allowlisted
sender, with no per-sender cooldown or rate limit. If the bot is added to a
group, any member can spam it and the bot will answer every message, eventually
drawing a Telegram 429 — and it advertises the allowlist mechanism to strangers.

**Suggested fix.** Reply at most once per (sender, chat) per time window, or
only reply to an explicit `/start`.

**Status:** open.

---

### 6 · Medium — `withRetry` has no backoff

**Where:** `index.ts:605-625`.

The doc comment says "retry a few times with backoff", but the delay is a
constant `baseDelayMs` on every attempt (`index.ts:621`). The log line happens to
report the true delay, so only the comment and function name mislead.

Behaviourally acceptable as-is (for `bot.launch()` it is 4 attempts at a fixed
1500 ms), but under sustained failure it retries at a fixed interval rather than
backing off.

**Suggested fix.** Either implement exponential backoff or correct the comment.

**Status:** open.

---

## Low

### 7 · Low — `safeSend` slices on a raw UTF-16 boundary

**Where:** `index.ts:597` (`safeSend`).

Before the fix, `text.slice(0, 4096)` could split a surrogate pair, producing
an invalid Telegram payload when a long error straddled the cutoff.

**Fix applied.** Exported `chunkEnd()` from `telegram-stream.ts` and used it in
`safeSend()` after redaction. `test/stream-test.mjs` tests the shared helper at
4096 characters, and `test/residual-test.mjs` checks outbound payloads,
including a surrogate boundary shifted by redaction.

**Status:** fixed (2026-09-22), alongside finding 1.

---

### 8 · Low — `/model` and `/thinking` create a session just to read state

**Where:** `index.ts:727`, `index.ts:776`.

Both handlers call `getChatSession(...)` unconditionally, so `/model` with no
argument — a pure read — spawns a full `AgentSession` and writes a session file
for a chat that had none. `/status` and `/cwd` correctly avoid this by reading
`ChatState` directly.

**Suggested fix.** For the no-argument case, report from `chatMeta` /
`PI_TELEGRAM_MODEL` / `PI_TELEGRAM_THINKING` defaults without creating a
session.

**Status:** open.

---

### 9 · Low — Stale queued commands vanish without feedback

**Where:** `index.ts:585-595`.

`enqueueChatOp` captures the generation at enqueue time and returns silently at
`index.ts:592` when it no longer matches. If `/stop` lands while `/model x` is
queued behind a long run, the user gets no reply at all, which reads as the bot
ignoring them.

**Suggested fix.** Reply with a short "superseded by /stop" notice, or at minimum
log the drop.

**Status:** open.

---

### 10 · Low — Instance-lock compromise crashes via an uncaught throw

**Where:** `instance-lock.ts:43-48`.

`lockSync` is called without an `onCompromised` option, so proper-lockfile's
default applies — `(err) => { throw err; }`
(`node_modules/proper-lockfile/lib/lockfile.js:212`) — invoked from inside a
`setTimeout` (`lockfile.js:200`), producing an `uncaughtException` that kills the
process with no gateway log line.

This is *fail-closed* and therefore largely correct for AGENTS.md rule 2: if
another instance genuinely stole the lock, dying is the right outcome. Sleep and
busy-event-loop stalls are explicitly recovered from by the mtime-ours check
(`lockfile.js:128-133`), so compromise only fires on a real takeover. The issue
is that the behaviour is accidental and undiagnosable.

**Suggested fix.** Pass an explicit `onCompromised` that logs via `log()` and
exits deliberately.

**Status:** open.

---

### 11 · Low — Documentation drift

- **AGENTS.md** describes `test/` as "offline tests" and lists
  `commands-scope.mjs` among them, but that script reads the real `.env`
  (`test/commands-scope.mjs:7-8`) and calls `api.telegram.org` (`:23-26`). It is
  correctly excluded from `npm test`, but an agent following rule 5 in an offline
  context will be misled. The same table omits `settings-test.mjs`,
  `lock-test.mjs`, `residual-test.mjs`, `rotation-test.mjs`, and
  `autostart-test.ps1`.
- **README.md:173** lists `npm test` as covering "stream, /cd, settings
  isolation, instance lock"; the actual chain (`package.json:17`) also runs
  `chat-meta-test`, `residual-test`, and `rotation-test`.
- Neither `README.md` nor `scripts/help.mjs` mentions the finding-2 consequence
  (wrong project context after `/cd`) beyond the mechanism note at
  `README.md:136`.

**Suggested fix.** Correct the AGENTS.md test table (and mark
`commands-scope.mjs` as a live-network diagnostic), sync the README test list,
and document finding 2 until it is fixed.

**Status:** open.

---

### 12 · Low — Lock and log location is not configurable

**Where:** `index.ts:66-68`.

`LOCK_DIR` is hardcoded to `join(import.meta.dirname, "logs")` while
`SESSIONS_DIR` honours `PI_TELEGRAM_SESSIONS_DIR`. Minor asymmetry; it also means
the ops scripts and the gateway must always agree on the repo-relative `logs/`
location.

**Status:** open (may be intentional — the ops scripts depend on this path).

---

### 13 · Medium — `stop.ps1` never disables the task

**Where:** `stop.ps1:14`, `stop.ps1:47`; interacts with
`setup-autostart.ps1:123-126`.

`stop.ps1` only calls `schtasks /End` — there is no `/Disable` anywhere in the
file — then taskkills the process tree, and finally prints "Gateway stopped."
(`stop.ps1:88`). The task remains registered and enabled with `RestartOnFailure`
`Interval PT1M` / `Count 999` plus a logon trigger.

Two consequences:

- **Certain:** the task stays enabled, so the logon trigger relaunches the
  gateway at the next logon despite an explicit stop.
- **Plausible but unconfirmed:** if `schtasks /End` has not fully retired the
  instance before `taskkill` kills the wscript/cmd wrapper, Task Scheduler may
  attribute the non-zero exit to the action and fire `RestartOnFailure` about a
  minute later.

The telling detail is that `remove-autostart.ps1:197` does exactly the right
thing, with the comment *"Disable first so Task Scheduler cannot race cleanup
with RestartOnFailure."* `stop.ps1` omits that same guard.

**Suggested fix.** `schtasks /Change /TN "pi-telegram-gateway" /Disable` before
killing (and re-enable from `start-gateway.ps1`), or document that `stop` is
temporary and only `autostart:remove` persists.

**Status:** open.

---

### 14 · Medium — `setup-autostart.ps1` reports success when task creation fails

**Where:** `setup-autostart.ps1:140`, `:143`.

`schtasks /Create /F /TN … /XML $tmp /RU $user | Out-Null` is followed by no
`$LASTEXITCODE` check — the file contains no `$LASTEXITCODE` reference at all. A
native command's non-zero exit does not throw under
`$ErrorActionPreference = "Stop"` (stderr is not redirected here), so on failure
(access denied, malformed XML, bad `/RU`) the script still removes the temp file
(`:141`), prints *"Scheduled task … registered"* (`:143`), and
`npm run autostart:setup` exits 0.

Note that `start-gateway.ps1:19` *does* check `$LASTEXITCODE` after its rotate
call, so the pattern is already established in this repo — it is simply missing
here. This also masks finding 17.

**Suggested fix.**

```powershell
if ($LASTEXITCODE -ne 0) { throw "schtasks /Create failed ($LASTEXITCODE)" }
```

immediately after line 140.

**Status:** open.

---

### 15 · Medium — `start-gateway.ps1` can truncate an un-rotated log, and fights the task

**Where:** `start-gateway.ps1:14`, `:18-21`, `:22-27`.

Two separate problems on the same path:

- **Log truncation.** The scheduled-task launcher *appends* (`>> "{LOG}"`,
  `setup-autostart.ps1:42`), but `start-gateway.ps1:25` uses
  `-RedirectStandardOutput`, which **truncates**. If rotation failed at line 18,
  the script warns and continues (`:19-21`) — then overwrites the existing
  `gateway.log` it just declined to archive.
- **Conflict with the enabled task.** Line 14 calls `stop.ps1`, which leaves the
  task enabled (finding 13). The directly-started node then holds the per-repo
  lock while the task can relaunch every minute; each task launch re-runs
  rotation against a log the direct process is actively writing. On Windows that
  rename fails safe (EPERM/EBUSY, and the rotate exit code is ignored), so there
  is no data loss — but it is needless churn and confusing log output.

**Suggested fix.** Disable the task for the duration of a direct run (or refuse
to start directly while it is enabled), and warn that `gateway.log` will be
overwritten when rotation failed.

**Status:** open.

---

### 16 · Low — `status.ps1` can abort on a corrupt lock

**Where:** `status.ps1:17-27`.

The `catch` for non-JSON lock metadata does `$gpid = [int]$rawLock`
(`status.ps1:24`). For a genuinely corrupt or empty lock file (neither JSON nor
an integer) that cast throws a statement-terminating exception, which
`$ErrorActionPreference = "SilentlyContinue"` does not suppress — so `status`
aborts before printing its "Recent log" and "Sessions" sections.

(A bare-PID lock actually parses as a JSON number, so `$record.pid` is null and
the display shows "PID 0"; only the garbage path reaches the cast.)

**Suggested fix.** `[int]::TryParse($rawLock.Trim(), [ref]$gpid)` with a
fallback.

**Status:** open.

---

### 17 · Low — `<UserId>` is interpolated unescaped into the task XML

**Where:** `setup-autostart.ps1:98`, `:103`.

`<UserId>$user</UserId>` is interpolated raw, while the command, arguments, and
working directory all go through `XmlEscape` (`:85-87`, defined at `:80-82`). An
account name containing `&`, `<`, or `>` would produce malformed XML, causing
`/Create` to fail — silently, per finding 14. Practically near-impossible for a
valid Windows logon name, hence Low.

**Suggested fix.** `$xmlUser = XmlEscape $user` and interpolate that.

**Status:** open.

---

### 18 · Low — Log-retention sort uses locale collation

**Where:** `scripts/rotate-logs.mjs:36-37`.

Archives are sorted with `basename(b).localeCompare(basename(a))` (descending)
and then `slice(keepPerLog)`. The retention *count* is correct — it keeps the
newest 20 per log type with no off-by-one, and `gateway.log` /
`gateway-err.log` do not cross-match — but `localeCompare` is locale-dependent
rather than ordinal. For the fixed-width `<timestamp>-<pid>-<name>` format it is
chronological in practice; ICU punctuation/numeric collation is a theoretical
mis-ordering risk.

**Suggested fix.** Use an ordinal comparison (`a < b` / `a > b`) on the
fixed-width names.

**Status:** open.

---

### 19 · Low — The single-instance lock is per-repo, not per-bot

**Where:** `index.ts:66-67`, `instance-lock.ts`.

`LOCK_TARGET` lives under each checkout's `logs/` directory, so two clones of
this repo pointed at the same bot token can both acquire their own lock and
double-poll, producing Telegram `409 Conflict` and split/lost updates. AGENTS.md
rule 2 treats the single-instance guarantee as absolute; it currently holds only
within one repository copy on one machine.

**Suggested fix.** Either document the limitation, or key the lock on something
bot-scoped (e.g. a hash of the bot token) under a shared location.

**Status:** open.

---

## Reviewed and found correct

Recorded so future reviews do not re-litigate these.

**Streaming (`telegram-stream.ts`).** The strongest file in the codebase. The
serialized `ioChain`, per-segment `version` counters, and per-run segment
snapshots correctly handle overlapping flush/finalize/reset races. All 14
offline scenarios in `test/stream-test.mjs` pass, including surrogate-pair
boundaries across streaming and finalization, stale-429-retry invalidation, and
the exact 3900-char chunk boundary. `flush()` rejections are handled by the
`activeFlushes` entry (`:278-281`), so `void this.flush()` cannot become an
unhandled rejection.

**Cancellation.** The generation-token design — `advanceChatGeneration`,
`isCurrentChat`, and the `preflightResult` hook (`index.ts:551-556`) — closes the
cancellation gaps properly, including the in-flight-session-creation race
(`index.ts:385-403`), which self-discards a superseded session rather than
wiring a stale cwd into live state.

**Session replacement.** `replaceChatSession`'s gate/result split
(`index.ts:454-465`) is subtle but correct: `result` can never become an
unhandled rejection because `gate` attaches a handler to it, and the gate always
settles successfully so later prompts can reopen retained history. `void
replaceChatSession(st, false)` at `index.ts:872` is therefore safe.

**Metadata persistence.** `chat-meta.ts` writes via temp file + `renameSync`
(same directory, so atomic), `loadChatMeta` clears a crash-left `.tmp` and
surfaces corruption instead of silently resetting every chat, and both legacy
string-valued and structured entries parse.

**Command synchronisation (AGENTS.md rule 5).** All 10 commands are in sync
across the handlers, `KNOWN_COMMANDS`, `BOT_COMMANDS`, the `/start` and `/help`
texts, the `README.md` table, and `scripts/help.mjs`.

**Ops scripts — deletion safety.** Every `Remove-Item` is scoped to lock files
under `logs\` (guarded by `StartsWith($LogsRoot)`, e.g. `stop.ps1:81-86`,
`remove-autostart.ps1:126-143`) or to a file named exactly `gateway-hidden.vbs`
(`remove-autostart.ps1:246-247`). Nothing touches `.env`, `sessions/`, or
`*.log`.

**Ops scripts — quoting.** The VBS launcher doubles `"` correctly, and the
`cmd /d /s /c ""NODE" …"` leading-double-quote trick survives `/s`'s
strip-first/last-quote rule. Apostrophes are safe inside VBS/cmd quoted strings.
`test/autostart-test.ps1:42-60` exercises paths containing spaces end-to-end.

**Ops scripts — cross-repo removal.** `remove-autostart.ps1` reads the
registered task XML and derives the old launcher/root (`Get-TaskLauncher`,
`:23-52`), refusing to act (`throw`, `:189-190`) when the action is not a
verifiable `gateway-hidden.vbs`. A task registered from a different repository
path is therefore removable without deleting config, data, or logs.

**Ops scripts — idempotency.** Setup-twice (remove-then-recreate, `:63`),
remove-twice, and remove-when-nothing-was-installed all no-op cleanly.

**Ops scripts — lock cleanup.** `stop.ps1` removes `gateway.instance.lock` and
`gateway.lock` only when the recorded owner PID is gone *and* `entry` matches, so
a stopped gateway does not leave a stale lock blocking the next start, and a
foreign gateway's artifacts are never removed.

**Repo hygiene.** Only `.env.example` (with empty values) is tracked; `.env`,
`sessions/`, `logs/`, `*.log`, and the generated `gateway-hidden.vbs` are all
gitignored. No bot-token-shaped strings appear in the working tree or in any
commit in history.
