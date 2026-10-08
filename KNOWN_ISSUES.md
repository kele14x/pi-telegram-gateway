# Known issues

Open issues: **21** — P0: **0**, P1: **6**, P2: **15**.

Issue IDs are retained from earlier reviews and stay unchanged when resolved.

## P0 — Security blockers

Secret exposure or access-control failures. Fix before the next push.

No open issues.

## P1 — Must fix

Issues that lose user work, break core features, or disrupt normal operation.

- **#2 — `/cd` loads the wrong project's instructions.** Tools use the new folder,
  but the shared resource loader and project settings still use the launch
  folder. This loads the wrong `AGENTS.md`, project resources, and trust settings.
  **Where:** `index.ts` (`main`, `createChatSession`), `chat-settings.ts`.
  **Fix:** Create loaders and project settings for each chat cwd. Test that
  switching folders loads the target project's instructions.

- **#3 — `/cd` silently drops queued prompts and can abort a newly started run.**
  It checks streaming but not queued work, then invalidates queued jobs.
  A run can also start while directory validation is pending.
  **Where:** `index.ts` (`/cd` handler).
  **Fix:** Check busy state and re-check generation/activity after validation,
  or serialize the switch. Report any intended cancellation and test both cases.

- **#4 — Shutdown truncates replies.** Sessions are disposed and the process exits
  before pending stream delivery or agent work finishes.
  **Where:** `index.ts` (`shutdown`).
  **Fix:** Abort active sessions and finalize streams or send an interruption
  notice under a bounded timeout before disposal and exit.

- **#5 — Blocked-user replies are unthrottled.** Every unauthorized update receives
  "This bot is private", allowing group spam to trigger Telegram rate limits
  and disrupt replies to the owner. The access guard itself still holds.
  **Where:** `index.ts` (allowlist middleware).
  **Fix:** Apply a cooldown per sender/chat, or reply only to an explicit `/start`.

- **#13 — `stop.ps1` leaves autostart enabled.** The gateway starts again at the next
  logon after reporting that it stopped. An immediate crash-restart race is
  plausible but unconfirmed.
  **Where:** `stop.ps1`, `start-gateway.ps1`.
  **Fix:** Disable the owned scheduled task before stopping it and re-enable
  it on managed start, or document that stopping is temporary.

- **#14 — Autostart setup reports success when task creation fails.** A non-zero
  `schtasks /Create` exit code is ignored, so setup can succeed without a task.
  **Where:** `setup-autostart.ps1` (task registration).
  **Fix:** Check `$LASTEXITCODE` immediately after creation and fail clearly.

## P2 — Improvements

Lower-impact behavior, diagnostic gaps, and documentation or test improvements.

- **#6 — Retry documentation promises backoff, but delays are constant.**
  The current bounded retry behavior is acceptable; the comment is misleading.
  **Where:** `index.ts` (`withRetry`).
  **Fix:** Correct the comment or implement increasing delays.

- **#8 — Reading model/thinking settings creates a session.** Calling `/model` or
  `/thinking` without arguments unnecessarily creates an agent and history file.
  **Where:** `index.ts` (`/model`, `/thinking` handlers).
  **Fix:** Read chat metadata and startup defaults without creating a session.

- **#9 — Cancelled queued commands disappear without feedback.** Commands queued
  behind a run return silently when `/stop` invalidates their generation.
  **Where:** `index.ts` (`enqueueChatOp`).
  **Fix:** Send a short cancellation notice or at least log the drop.

- **#10 — Lock compromise crashes without a gateway diagnostic.** The lock library's
  default callback throws asynchronously. Exiting preserves instance safety,
  but the reason is not logged through the gateway.
  **Where:** `instance-lock.ts`.
  **Fix:** Add an explicit `onCompromised` callback that logs safely and exits.

- **#11 — Development documentation is out of date.** The test lists omit coverage
  and describe `commands-scope.mjs` as offline even though it reads `.env` and
  calls Telegram. The consequences of `/cd` loading launch-folder context
  also need clarification.
  **Where:** `AGENTS.md`, `README.md`, `scripts/help.mjs`.
  **Fix:** Update test descriptions and cwd guidance after the runtime fix.

- **#12 — Lock/log location is fixed to the checkout.** Sessions have a configurable
  directory, while the gateway lock and logs remain under the repository.
  **Where:** `index.ts` (lock paths), lifecycle scripts.
  **Fix:** Document this contract or add configuration consistently across
  runtime and lifecycle scripts.

- **#15 — Manual start can overwrite logs and conflict with the scheduled task.**
  It continues after failed rotation, then truncates the existing log.
  Leaving autostart enabled can also cause repeated launch/rotation attempts.
  **Where:** `start-gateway.ps1`.
  **Fix:** Stop or warn clearly when rotation fails, and coordinate direct
  startup with the owned task's enabled state.

- **#16 — Status can fail on corrupt lock metadata.** The fallback integer cast
  throws for empty or invalid data.
  **Where:** `status.ps1` (lock parsing).
  **Fix:** Use `TryParse` and show an unknown or invalid status on failure.

- **#17 — Task XML does not escape the user ID.** An account value containing XML
  characters could make registration fail; the precondition is unlikely.
  **Where:** `setup-autostart.ps1` (`<UserId>`).
  **Fix:** Apply the existing `XmlEscape` helper to the user value.

- **#18 — Log retention uses locale-dependent ordering.** Retention counts are
  correct, but archive ordering depends on the host locale.
  **Where:** `scripts/rotate-logs.mjs`.
  **Fix:** Use ordinal comparison for timestamp-based archive names.

- **#19 — The instance lock is per checkout, not per bot.** Two checkouts using the
  same token can both start and split or lose Telegram updates.
  **Where:** `index.ts` (lock paths), `instance-lock.ts`.
  **Fix:** Document the limitation or use a shared lock keyed by a token hash.

- **#21 — Replies and notices lose their forum topic.** Streamed output, queue
  acknowledgments, and command errors omit the originating `message_thread_id`.
  Ordinary chats and secret redaction still work.
  **Where:** `index.ts` (prompt submission, `safeSend`), `telegram-stream.ts`.
  **Fix:** Carry the topic with each queued operation and run. Test prompts
  queued from different topics so later work cannot redirect earlier output.

- **#22 — Command-error redaction tests rely on the name `err`.** The AST guard
  can pass if the error is renamed or delivery disappears; it does not execute
  the model/thinking handlers.
  **Where:** `test/residual-test.mjs`.
  **Fix:** Add behavioral tests for both handlers, forcing session/reply
  failures and checking redacted delivery to the originating chat and topic.

- **#24 — Tool status updates bypass the edit throttle.** The 120 ms status timer
  ignores the normal 800 ms interval and can edit unchanged answer text.
  Offline reproduction recorded consecutive calls about 151 ms apart.
  **Where:** `telegram-stream.ts` (`setStatus`, `scheduleEdit`).
  **Fix:** Enforce the interval after first delivery, coalesce statuses, skip
  unchanged edits, and add a cadence regression to `test/stream-test.mjs`.

- **#25 — Stop can end another checkout's scheduled task.** The globally named task
  is ended before its action path is checked. Manual start inherits this risk.
  This finding is based on source inspection, not native Windows execution.
  **Where:** `stop.ps1`, `start-gateway.ps1`.
  **Fix:** Verify task ownership before ending it. Test matching and foreign
  checkout paths with task-manager mocks.

## Resolved

- **#23 — Startup errors exposed the bot token in logs.** Fixed in `419fb78`:
  fatal errors now pass through the redacting logger. Offline regressions cover
  synthetic bot/proxy credentials, retry exhaustion, and exit code 1.

- **#26 — Service-test fixtures were invalid on Windows.** Fixed in `aa8f877`:
  real filesystem paths are portable; quote/backslash escaping uses string-only
  fixtures, and migration checks compare escaped paths. Simulated Windows
  validation passed; native Windows execution remains unverified.
