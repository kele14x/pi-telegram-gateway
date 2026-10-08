# Known issues

Findings from a full code-base review, covering the TypeScript
core (`index.ts`, `telegram-stream.ts`, `chat-*.ts`, `history.ts`,
`instance-lock.ts`, `session-errors.ts`, `scripts/`, `test/`) and the Windows
ops scripts (`setup-autostart.ps1`, `remove-autostart.ps1`,
`start-gateway.ps1`, `stop.ps1`, `status.ps1`).

Initial review baseline: `npm run typecheck` and `npm test` both pass, and a
scan of the working tree and every commit in history found no bot-token-shaped
strings.

Follow-up review on 2026-10-08 checked `af49d54` after pulling the Linux service
management and dependency upgrades. Typechecking and all offline tests passed
on macOS with the locked dependencies. The earlier gateway findings remain
open; finding 23 demonstrates that clean source/history scans do not rule out
runtime secret exposure. The Windows service-test portability issue was fixed
locally in `aa8f877` (see resolved finding 26). Windows paths and filename rules
were simulated for that fix; native Windows and systemd execution remain
unverified.

Numbering is retained from the review conversations. The tables below list only
open findings.

Priority is the triage bucket (**P0** blocking/security · **P1** critical, must
be solved · **P2** optional/improvement). Severity is the raw impact assessment
and deliberately does not always agree with priority — see
[Priority classification](#priority-classification-p0p1p2).

| # | Priority | Severity | Area | Summary |
| --- | --- | --- | --- | --- |
| [2](#2--high--cd-moves-the-tools-but-leaves-the-system-prompt-describing-the-launch-folder) | **P1** | High | Sessions | `/cd` moves the tools but leaves the system prompt describing the launch folder |
| [3](#3--medium--cd-silently-discards-queued-messages) | **P1** | Medium | Commands | `/cd` silently discards queued messages |
| [4](#4--medium--shutdown-truncates-in-flight-replies) | **P1** | Medium | Lifecycle | `shutdown()` truncates in-flight replies |
| [5](#5--medium--unthrottled-this-bot-is-private-replies) | **P1** | Medium | Security | Unthrottled "This bot is private" replies |
| [6](#6--medium--withretry-has-no-backoff) | **P2** | Medium | Networking | `withRetry` has no backoff despite its name and comment |
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
| [21](#21--low--agent-replies-and-error-notices-lose-the-forum-topic) | **P2** | Low | Delivery | Streamed replies, queue acknowledgments, and command errors lose the forum topic |
| [22](#22--low--command-error-redaction-tests-only-check-an-identifier-name) | **P2** | Low | Tests | Command-error redaction tests only check an identifier name |
| [23](#23--high--startup-failures-can-log-the-bot-token) | **P0** | High | Security | Startup failures bypass redaction and can log the bot token |
| [24](#24--medium--tool-status-updates-bypass-the-edit-throttle) | **P2** | Medium | Streaming | Tool status updates bypass the 800 ms edit interval |
| [25](#25--medium--stopps1-can-end-another-checkouts-scheduled-task) | **P2** | Medium | Ops | `stop.ps1` ends the globally named task before verifying repository ownership |

**Open tally (22 findings):** 1 × P0 · 6 × P1 · 15 × P2.

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
| [23](#23--high--startup-failures-can-log-the-bot-token) | Startup errors expose the bot token in logs | A reproduced secret exposure meets this register's P0 criterion. Normal log redaction does not cover the fatal handler. |

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
| [8](#8--low--model-and-thinking-create-a-session-just-to-read-state) | Read-only commands create a session | Wasteful, not incorrect. |
| [9](#9--low--stale-queued-commands-vanish-without-feedback) | Dropped commands get no reply | UX polish; the drop itself is intentional. |
| [10](#10--low--instance-lock-compromise-crashes-via-an-uncaught-throw) | Lock compromise crashes unlogged | Already fail-closed, which is the correct outcome for rule 2. Only diagnosability is missing. |
| [11](#11--low--documentation-drift) | Doc drift | Docs only. Revisit after finding 2 lands. |
| [12](#12--low--lock-and-log-location-is-not-configurable) | Hardcoded `logs/` path | Possibly intentional — the ops scripts depend on this exact location. |
| [15](#15--medium--start-gatewayps1-can-truncate-an-un-rotated-log-and-fights-the-task) | Log truncation + task conflict | See the divergence note below. |
| [16](#16--low--statusps1-can-abort-on-a-corrupt-lock) | `status.ps1` aborts on garbage lock | Diagnostic tool only; needs an already-corrupt lock file. |
| [17](#17--low--userid-is-interpolated-unescaped-into-the-task-xml) | Unescaped `<UserId>` | Needs `&`, `<`, or `>` in a Windows logon name — practically impossible. |
| [18](#18--low--log-retention-sort-uses-locale-collation) | Locale-dependent retention sort | Retention count is already correct; theoretical mis-ordering only. |
| [19](#19--low--the-single-instance-lock-is-per-repo-not-per-bot) | Lock is per-repo, not per-bot | Requires two checkouts pointed at one token — outside the documented single-machine deployment. Silent message loss if it happens, so worth documenting even if not fixed. |
| [21](#21--low--agent-replies-and-error-notices-lose-the-forum-topic) | Agent replies and notices lose their topic | Affects forum-topic routing; ordinary-chat delivery and command-error redaction still work. |
| [22](#22--low--command-error-redaction-tests-only-check-an-identifier-name) | Fragile redaction regression guard | A coverage gap, not a demonstrated token leak in the current handlers. |
| [24](#24--medium--tool-status-updates-bypass-the-edit-throttle) | Status edits arrive too quickly | Can provoke Telegram rate limits, but retries remain bounded; no demonstrated permanent output loss. |
| [25](#25--medium--stopps1-can-end-another-checkouts-scheduled-task) | Stop bypasses task ownership checks | Requires multiple checkouts; ends the registered task even when its action belongs to another repository path. |

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

1. **Finding 23** (P0) — redact fatal startup errors and add an offline
   regression before the next push.
2. **Finding 14** (P1, one `if`) — cheapest P1, and it un-masks finding 17.
3. **Finding 13** (P1) — then re-check finding 15 and include finding 25's task
   ownership checks when changing the stop path.
4. **Finding 2** (P1, largest change) — per-cwd loader/settings cache, plus a
   `test/cd-test.mjs` assertion so it cannot regress.
5. **Findings 3 and 4** (P1) — cover directory-validation races and shutdown
   delivery in addition to queued-message cancellation.
6. **Findings 21, 22, and 24** (P2) — preserve topic routing for prompts and
   notices, test command errors behaviourally, and throttle status updates.
7. **Finding 11** last, so the docs describe the post-fix behaviour.

---

## High

### 23 · High — Startup failures can log the bot token

**Where:** `index.ts:1161` (`getMe()`), `index.ts:1218-1220` (fatal handler).

If the startup `getMe()` request exhausts its retries, the error propagates to
`main().catch(...)`. That handler uses `console.error("FATAL:", err)` directly,
bypassing `log()` and `redactSecrets()`. Telegram transport and response-parsing
errors can include the request URL, whose path contains the bot token. Managed
launches write this raw error into their stderr or combined gateway log.

**Evidence.** An offline `node-fetch` response-parsing failure for a synthetic
`getMe` URL produced an error containing a synthetic token. Executing the real
fatal handler with that error retained the token in captured console output.
The reproduction still succeeded after the dependency upgrade in `af49d54`.
No real credentials or Telegram requests were used.

**Suggested fix.** Send a formatted fatal error message through `log()` or
explicitly redact it before writing to stderr. Add an offline startup-failure
regression that captures console output and asserts that synthetic bot tokens
and proxy credentials are absent, including after retry exhaustion.

**Status:** open (P0 under this register's secret-exposure criterion).

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

**Where:** `index.ts:851-880`.

`/cd` refuses only when `st.session?.isStreaming` (`index.ts:858`); it never
checks `st.busy`. It then calls `advanceChatGeneration(st)` (`index.ts:873`),
which invalidates every queued `submitPrompt` job — each logs
"dropped queued message after cancellation" (`index.ts:517`) and returns. The
reply (`index.ts:877-879`) says only *"Conversation history is kept — your next
message continues in this folder"*, with no mention that N queued messages were
just thrown away. `/stop` is explicit about this ("dropped queued messages");
`/cd` is not.

There is also a race across `await stat(target)` (`index.ts:864`): a prompt can
start after the streaming check but before directory validation completes.
The handler does not re-check activity before changing the generation and
replacing the session, so it can abort that newly active run while reporting a
successful folder switch.

**Evidence.** Offline execution with two reserved prompts delivered neither
prompt after `/cd`, and the success reply did not mention dropped work. A
separate fixture started a mock run while directory validation was pending;
completing validation caused its session to be aborted and the cwd to change.

**Suggested fix.** Refuse when `st.busy > 0` as well as when streaming, and
re-check the captured generation and activity after directory validation before
committing the switch. Alternatively serialize the switch with prompt work and
explicitly report any intended cancellation. Cover both queued prompts and the
directory-validation race with offline behavioural tests.

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

### 24 · Medium — Tool status updates bypass the edit throttle

**Where:** `telegram-stream.ts:155-161` (`setStatus()`),
`telegram-stream.ts:202-212` (`scheduleEdit()`), `index.ts:278-284` (tool events).

`setStatus()` calls `scheduleEdit(true)`, whose `forceSoon` branch always waits
120 ms without considering `lastEditAt`. Tool start/end events spaced far
enough apart for each timer to fire can therefore issue successive API edits
well inside the documented 800 ms interval. Status events can also schedule
redundant edits when the open segment already has answer text.

**Evidence.** An offline mock receiving three different statuses 150 ms apart
recorded three delivery calls with 151 ms between consecutive calls. This was
reproduced again on `af49d54`. The existing stream tests cover bounded retries
but do not assert the interval for repeated status updates.

**Suggested fix.** Apply the minimum edit interval to status updates after the
first delivery, coalesce intervening status changes, and avoid editing an
unchanged answer solely because a tool status changed. Add a scenario to
`test/stream-test.mjs` that exercises repeated tool statuses and checks the
delivery cadence while preserving the existing bounded retry behaviour.

**Status:** open (P2).

---

### 25 · Medium — `stop.ps1` can end another checkout's scheduled task

**Where:** `stop.ps1:14`, `stop.ps1:16-43`, `start-gateway.ps1:14`.

The script calls `schtasks /End /TN "pi-telegram-gateway"` before checking the
registered task's action path. Task names are shared across repository copies.
If checkout A owns the registered task, invoking `stop.ps1` from checkout B
still ends A's task, despite the script's promise to stop only the instance
owned by the current repository. The later entry-path and lock-metadata checks
protect the explicit process-tree kills, not the preceding task stop. Manual
startup from B inherits this side effect because it calls `stop.ps1` first.

**Evidence.** Source inspection confirms the unconditional task stop precedes
all repository ownership checks. This has not been executed on native Windows;
no running gateway or scheduled task was stopped during review.

**Suggested fix.** Read the registered task XML and verify its launcher or entry
path belongs to this checkout before issuing `/End`. Fail clearly on an
ownership mismatch, preserving the existing checks for directly launched
processes. Add offline task-manager mocks for matching and foreign checkout
paths and assert that the foreign task is never ended.

**Status:** open (P2; separate from finding 13's task-disable behaviour).

---

## Low

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

### 21 · Low — Agent replies and error notices lose the forum topic

**Where:** `index.ts:393` (stream creation), `index.ts:937` (text submission),
`telegram-stream.ts:225` (streamed sends), and `safeSend()` at
`index.ts:597-600` (notices and command errors).

Commit `aeaa467` routes `/model` and `/thinking` caught errors through `safeSend()`.
This fixes token exposure, but unlike `ctx.reply()`, that helper does not forward
`message_thread_id`. Error notices therefore no longer target the command's
originating forum topic.

The follow-up review found that this also affects ordinary agent output: text
and photo handlers submit prompts using only the chat ID, and `TelegramStream`
sends messages without the originating topic ID. Queue acknowledgments and
other notices delivered by `safeSend()` have the same omission. A prompt in a
forum topic can therefore receive its answer or notice outside that topic.

**Evidence.** Offline before/after execution of both handlers with Telegraf's
real `Context` and mocked delivery preserved synthetic thread id `77` before the
change and omitted it afterwards. Both session-creation and reply-failure paths
were checked; the current handlers successfully redacted the synthetic token.
Additional offline execution of a text prompt from synthetic topic `77`
produced a streamed `sendMessage()` call with no topic option.

**Suggested fix.** Capture the originating topic in each queued prompt or
command operation and carry it into streamed sends and notices. Keep delivery
routing bound to the originating run so later prompts in another topic cannot
redirect an earlier run's pending output. Preserve `safeSend()`'s redaction and
Unicode-safe truncation. Cover topic and ordinary-chat delivery, including
queued prompts from different topics and the command failures in finding 22.

**Status:** open (P2).

---

### 22 · Low — Command error redaction tests only check an identifier name

**Where:** `test/residual-test.mjs:138-168`.

The AST guard rejects `ctx.reply(...)` arguments referencing an identifier
literally named `err`; it does not execute `/model` or `/thinking`. Renaming or
aliasing the caught error, or omitting error delivery entirely, can pass the guard.
This is a regression-coverage gap, not a demonstrated token leak in the current
handlers. The existing photo-error and shared `safeSend()` tests remain useful.

**Suggested fix.** Add offline behavioural tests for both command handlers. Force
session-creation and reply failures containing synthetic secrets, then assert
redacted delivery to the correct chat and originating forum topic. Keep the AST
guard as supplemental protection rather than the sole command-error test.

**Status:** open (P2).

---

## Resolved follow-up findings

### 26 · Low — Service-test filesystem fixtures were invalid on Windows

**Where:** `test/service-test.mjs:29-36`, `test/service-test.mjs:119-124`.

The Linux lifecycle test originally created a directory containing double
quotes, which Windows forbids. Because `package.json` includes this test in
every `npm test`, the fixture prevented the full offline suite from completing
on Windows. Its repository-migration assertion also compared a raw Windows
entry path with the backslash-escaped command argument in the generated unit.

**Fix.** Commit `aa8f877` uses a Windows-safe directory name for real filesystem
fixtures, keeps quote/backslash coverage in a separate string-only unit
generation check, and compares the migrated entry path using its escaped unit
representation. No gateway or service-manager runtime behaviour changed.

**Validation.** Typechecking and the full offline suite passed on macOS. The
service test also passed with simulated Windows paths and filename restrictions
using an in-memory filesystem and fake service manager. Native Windows
execution remains unverified.

**Status:** resolved in `aa8f877`; excluded from the open tally.
