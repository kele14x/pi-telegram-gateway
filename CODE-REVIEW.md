# pi-telegram-gateway Code Review

This review covers the tracked TypeScript source, Telegram integration, session handling, tests, PowerShell operational scripts, documentation, and installed dependency behavior.

## Validation

- `npm run typecheck` — passed
- `npm test` — passed
- `npm audit --registry=https://registry.npmjs.org --omit=dev` — 0 vulnerabilities
- `git diff --check` — passed

The latest changes reviewed include commits `cc1a31a`, `a977dcb`, `c9ab6b9`, and `715bd77`; item numbers are unchanged.

## High-priority findings

### 1. Long-running agent prompts block Telegram polling

**Status: Mostly fixed; residual network paths remain**

**Files:** `index.ts:448-511`, `index.ts:613-745`, `index.ts:819-857`

Text prompts, model/thinking commands, session replacement commands, and photo processing now dispatch long-running work in the background. This removes the main polling blockage and allows `/stop` to be fetched while an agent prompt is running. Prompt jobs also receive immediate queue acknowledgments in the normal case.

Remaining concerns are outside the model prompt itself:

- Telegram reply calls can still block if the Telegram API connection hangs.
- Photo downloads now run in the background and have a 30-second timeout, but they still bypass the configured proxy and IPv4 agent; see item 7.
- A queue acknowledgment is not guaranteed when multiple updates arrive in the same polling batch before the first job increments `busy`.

**Recommendation:** Keep agent and photo work non-blocking, add robust timeouts/retries to all Telegram reply paths, and make queue accounting synchronous at enqueue time.

### 2. `TelegramStream` has concurrent flush/finalize/reset races

**Status: Fixed for the reviewed concurrency cases; delivery issues remain in item 9**

**Files:** `index.ts:276-287`, `telegram-stream.ts:105-262`, `test/stream-test.mjs:175-274`

`TelegramStream` now serializes send/edit operations through `ioChain`, snapshots segment state per run, tracks active flushes, supports canceling a replaced stream, and versions segment content. The H/I tests cover flush/finalize and reset overlap, and the new J test covers stale retry regression; all pass.

The original duplicate-send, cross-run mutable-state, and stale-retry problems are addressed. Remaining delivery reliability concerns, including generic network failures and rate-limit scheduling, are tracked in item 9.

**Recommendation:** Keep the current concurrency model and add the remaining transport-failure tests described in item 9.

### 3. Session lifecycle commands are not synchronized with prompts

**Status: Mostly fixed; residual SDK-boundary race remains**

**Files:** `index.ts:324-544`, `index.ts:613-778`

The gateway now deduplicates session initialization, tracks currently running jobs separately from queued jobs, invalidates stale generations, waits for session replacement through `sessionReset`, and makes `/model`/`/thinking` operations generation-aware. `/new` and `/cd` replace sessions in the background while new jobs wait for the replacement to finish.

The main lifecycle resurrection scenarios are addressed. A remaining edge case exists when an already-entered `AgentSession.prompt()` is still in SDK preflight while `/cd` or `/new` changes the generation. The SDK prompt API has no cancellation option for that preflight, so the old operation may cross the generation boundary before the gateway's post-call check runs. Read-only status commands also remain outside the operation queue.

**Recommendation:** Add an explicit per-chat prompt-start gate or cancellation hook around SDK preflight, and add integration tests for concurrent `/new`, `/cd`, `/stop`, model changes, and session initialization.

### 4. `/new` does not clear persisted history after a restart

**Status: Mostly fixed; deletion/error edge cases remain**

**File:** `index.ts:613-641`

`/new` removes `sessions/chat-<id>.jsonl` even when there is no in-memory session, fixing the original post-restart behavior. With a live state, it also invalidates old jobs and waits for session cleanup in the background before deleting history.

A file-removal failure is logged but does not produce a user-visible failure response. The command also relies on the remaining lifecycle and stream-boundary handling in item 3.

**Recommendation:** Surface history-removal failures to the user and retain the generation/session-reset coordination.

### 5. Model and thinking settings are not truly per-chat

**Status: Open**

**Files:** `index.ts:649-650`, `index.ts:679`, `index.ts:928-935`

The README advertises per-chat model and thinking settings, but all sessions share one `SettingsManager`:

```ts
settingsManager = SettingsManager.create(DEFAULT_CWD, AGENT_DIR);
```

The SDK's `setModel()` and `setThinkingLevel()` persist changes through that manager. Changing the model or thinking level in one Telegram chat therefore changes global pi defaults, affecting new Telegram chats and potentially other pi processes using the same settings.

The current chat's session history does preserve its own model change, so the behavior is partially per-chat, but global defaults are still modified.

**Recommendation:** Use a per-chat settings layer or avoid writing per-chat changes into the shared global `SettingsManager`.

### 6. Proxy credentials can be written to logs

**Status: Fixed for the reported log leak**

**Files:** `index.ts:884-909`, `index.ts:1006`

The gateway now logs only the proxy origin through `proxyOrigin()`, excluding credentials, path, query, and fragment. `redactSecrets()` also removes the configured bot token and full proxy URL from string and `Error` arguments passed through `log()`.

The direct proxy URL leak is fixed. Future logging should continue to use `log()` rather than unsanitized `console.error()` calls for network/model errors.

**Recommendation:** Keep origin-only proxy logging and route all potentially sensitive errors through the sanitizing logger.

### 7. Photo downloads bypass the configured proxy and IPv4 handling

**Status: Open; timeout added, proxy handling remains**

**Files:** `index.ts:836-857`

Telegram API calls use the configured Telegraf agent, but the actual photo download uses Node's global `fetch()`:

```ts
const res = await fetch(href, { signal: AbortSignal.timeout(30_000) });
```

The download now runs in the background and has a 30-second timeout, but the configured `HttpsProxyAgent` is still not used by this fetch. As a result:

- Photo handling can fail on networks where Telegram requires `TELEGRAM_PROXY`.
- `PI_TELEGRAM_IPV4_ONLY=true` does not force IPv4 for the photo download.
- The entire response is still buffered without an explicit size limit.

**Recommendation:** Use one configured HTTP client for Telegram API calls and file downloads, enforce a maximum response size, and pass the IPv4 lookup function into the proxy agent when IPv4-only mode is enabled.

### 8. The single-instance lock is not atomic

**Status: Open**

**Files:** `index.ts:57-81`

Lock acquisition uses a check-then-write sequence:

```ts
readFileSync(LOCK_FILE)
process.kill(pid, 0)
writeFileSync(LOCK_FILE, String(process.pid))
```

Two processes can both observe a stale or missing lock and then both continue. `releaseLock()` also removes the lock unconditionally, so one process can remove a lock belonging to another process after a race.

This directly weakens the project's single-instance guarantee.

**Recommendation:** Use exclusive file creation such as `openSync(..., "wx")`, make release conditional on ownership, and perform stale-lock takeover atomically.

## Medium-priority findings

### 9. Stream delivery silently loses messages on non-429 failures

**Status: Open; stale-retry regression fixed**

**File:** `telegram-stream.ts:118-166`

The `ioChain` and segment versions now prevent duplicate sends and prevent an older 429 retry from regressing newer content. Scenario J covers that regression.

`editOrSend()` still retries only errors whose message contains `retry after N`. Transient failures such as `ECONNRESET`, `ETIMEDOUT`, proxy disconnects, or Telegram 5xx responses are logged and discarded. `finalize()` still resolves, so the caller can believe the response was delivered.

Normal timers can still enqueue edits while a 429 retry is pending.

**Recommendation:** Add bounded retries for transient failures, suppress or coalesce edits during rate limiting, and report permanent delivery failures.

### 10. Retryable model errors are displayed as final errors

**Status: Open**

**Files:** `index.ts:254-287`

The gateway appends an error as soon as it receives `message_end`, before it knows whether the SDK will retry. With automatic retries enabled, a transient error can appear in the final successful answer:

```text
⚠️ The model returned an error...

successful response
```

**Recommendation:** Buffer retryable errors until `agent_end`, or omit the error when `event.willRetry` is true.

### 11. Prompt initialization errors do not reach the user

**Status: Fixed for prompt/session initialization errors**

**File:** `index.ts:448-511`

`getChatSession()` is now inside an error-handling path in `submitPrompt()`. Session creation errors are logged and sent to the user through `safeSend()` instead of disappearing into `bot.catch()`.

This fixes the original issue. The general lifecycle races in item 3 can still produce secondary session-state problems, and `safeSend()` itself is best-effort.

**Recommendation:** Retain this handling and add tests for corrupt sessions, invalid cwd values, and failed resource loading.

### 12. `/stop` does not clear queued follow-ups

**Status: Mostly fixed; SDK preflight edge remains**

**File:** `index.ts:705-723`

`/stop` now increments the per-chat generation token, clears the SDK queue with `session.clearQueue()`, starts abort without awaiting it, and drops queued prompt and model/thinking jobs carrying the old generation.

The command is responsive for normal text prompts. A job that has already entered SDK prompt preflight can still cross the generation boundary before the post-call cancellation check. Session initialization is canceled by generation validation, but may finish cleanup in the background.

**Recommendation:** Add an SDK prompt-start gate or cancellation hook and add tests for cancellation during session initialization and prompt preflight.

### 13. Self-test can report success incorrectly

**Status: Fixed, with intentional whitespace normalization**

**File:** `index.ts:945-991`

The self-test now uses a temporary session directory, cleans it up, disposes the session even when prompting fails, records prompt failures, and rejects responses other than `GATEWAY OK`.

The comparison uses `trim()` intentionally to tolerate the trailing newline models commonly append. If the requirement is literal byte-for-byte equality, that normalization should be removed.

**Recommendation:** Keep the current cleanup and failure handling. Add an automated test around wrong output and prompt failure if the self-test is refactored for dependency injection.

## Operational and maintenance findings

### 14. PowerShell process matching is dangerously broad

**Status: Open**

**Files:** `start-gateway.ps1:11-14`, `stop.ps1:11-19`

The scripts match any process containing `index.ts`, `gateway-hidden`, or `npm-cli ... start`, regardless of repository path. They can terminate unrelated Node applications or development servers.

`stop.ps1` also removes `gateway.lock` even if a matching process remains, allowing a new gateway to start while another one is still alive.

**Recommendation:** Match the exact repository path, prefer the PID from the lock file, verify process ownership, and only remove the lock after confirming that the target process has exited.

### 15. Log rotation is documented but not implemented

**Status: Open**

**Files:** `setup-autostart.ps1:31`, `start-gateway.ps1:21-22`, `scripts/help.mjs:46-47`

The scheduled task appends to `logs/gateway.log` indefinitely. No code rotates files into `logs/archive/`, despite the helper documentation describing that directory.

**Recommendation:** Add size- or time-based rotation, or use an external log-management mechanism.

### 16. Metadata writes are not crash-safe

**Status: Fixed for crash-safe replacement**

**Files:** `index.ts:136-148`

`saveChatMeta()` now writes a complete temporary file and replaces `meta.json` with `renameSync()`. This is the correct same-directory atomic replacement pattern for preventing a crash from leaving a truncated metadata file. Malformed metadata is also now surfaced in the log instead of being silently ignored.

Remaining caveats are concurrent writers, stale temporary files after an I/O failure, and persistence errors still being reported only in the log while `/cd` can reply as though persistence succeeded. The unresolved process-lock race in item 8 makes concurrent writers possible in principle.

**Recommendation:** Retain the atomic replacement, add cleanup/error reporting, and test concurrent or interrupted saves.

### 17. Test coverage misses the highest-risk paths

**Status: Improved; still open**

New stream scenarios H/I/J cover concurrent flush/finalize, reset, and stale-429-retry behavior. They do not cover generic transport failures, long-segment boundary races, or interaction with `/new` and session replacement.

There are still no automated tests for:

- Telegram polling behavior during a long prompt or stalled photo download.
- `/stop` responsiveness and cancellation during SDK preflight.
- Concurrent session initialization and lifecycle replacement.
- `/new` after restart or during session initialization.
- `/cd` during an active or queued operation.
- Proxy/photo download behavior.
- Lock acquisition races.
- PowerShell process matching.

`test/cd-test.mjs` does not actually verify the effective cwd. It uses hardcoded non-existent paths and only checks that tool names exist. It should assert the session manager or tool execution cwd directly.

`test/commands-scope.mjs` is not offline: it reads `.env` unconditionally and performs real Telegram API requests. This is acceptable as a manual diagnostic, but it should not be treated as a normal offline test.

## Positive aspects

- Clear separation between bot wiring, session management, and `TelegramStream`.
- Correct use of `SessionManager.open(..., cwdOverride)` for preserving history across `/cd`.
- Telegram message chunking conservatively respects the 4096-character limit.
- Streaming edits are throttled.
- 429 handling includes `retry_after` support and a maximum delay.
- Allowlist middleware runs before agent access.
- `.env`, sessions, logs, and generated launcher files are excluded from git.
- Strict TypeScript checking and dependency audit currently pass.

## Recommended implementation order

1. Add an SDK prompt-start cancellation gate for the remaining lifecycle/preflight race.
2. Add bounded transport retries and rate-limit coalescing to `TelegramStream`.
3. Fix proxy-aware photo downloads and enforce a response-size limit.
4. Fix per-chat settings isolation.
5. Replace the lock with an atomic, ownership-aware implementation.
6. Add integration tests for cancellation, restart behavior, lifecycle races, stream transport failures, proxy handling, and lock contention.
