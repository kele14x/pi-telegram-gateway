// Offline regressions for terminal model errors and truthful history removal.

import { join } from "node:path";
import { removeChatHistory } from "../history.ts";
import { SessionErrorBuffer } from "../session-errors.ts";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

{
  const errors = new SessionErrorBuffer();
  errors.beginAttempt();
  errors.capture({ role: "assistant", stopReason: "error", errorMessage: "temporary outage" });
  assert(errors.finishAttempt(true) === undefined, "retryable error leaked into output");

  errors.beginAttempt();
  errors.capture({ role: "assistant", stopReason: "stop" });
  assert(errors.finishAttempt(false) === undefined, "successful retry inherited the old error");

  errors.beginAttempt();
  errors.capture({ role: "assistant", stopReason: "error", errorMessage: "terminal outage" });
  assert(errors.finishAttempt(false) === "terminal outage", "terminal error was not retained");
}

{
  let removedPath;
  removeChatHistory("C:/opaque-sessions", 42, (path, options) => {
    removedPath = path;
    assert(options.force === true, "history removal is not idempotent");
  });
  assert(removedPath === join("C:/opaque-sessions", "chat-42.jsonl"), "wrong history file selected");

  const expected = new Error("permission denied");
  let received;
  try {
    removeChatHistory("C:/opaque-sessions", 42, () => {
      throw expected;
    });
  } catch (err) {
    received = err;
  }
  assert(received === expected, "history removal failure was swallowed");
}

console.log("Deferred-error and history-removal regressions passed ✅");
