// Offline test: lifecycle events are JSON lines, redacted, bounded, and never throw.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createEventLog } from "../gateway-events.ts";

const dir = mkdtempSync(join(tmpdir(), "pi-telegram-events-"));
const readEntries = (file) => readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));

try {
  const file = join(dir, "logs", "gateway-events.jsonl");
  const log = createEventLog(file, { redact: (text) => text.split("SECRET").join("<token>") });
  log.record("start", { pid: 42, model: undefined, ok: true });
  log.record("run_failed", { chat: 1, error: `bad SECRET ${"x".repeat(1000)}` });

  const [start, failed] = readEntries(file);
  if (start.event !== "start" || start.pid !== 42 || start.ok !== true || Number.isNaN(Date.parse(start.ts))) {
    throw new Error(`unexpected start entry: ${JSON.stringify(start)}`);
  }
  if ("model" in start) throw new Error("undefined fields must be omitted");
  if (failed.error.includes("SECRET") || !failed.error.startsWith("bad <token>")) throw new Error("strings were not redacted");
  if (failed.error.length > 300) throw new Error("long strings were not truncated");

  const bounded = join(dir, "bounded.jsonl");
  const small = createEventLog(bounded, { maxLines: 10 });
  for (let i = 0; i < 30; i++) small.record("tick", { i });
  let entries = readEntries(bounded);
  if (entries.length < 10 || entries.length > 11) throw new Error(`log was not trimmed: ${entries.length} lines`);
  if (entries.at(-1).i !== 29) throw new Error("newest entry was not retained");
  if (entries.some((entry, k) => k > 0 && entry.i !== entries[k - 1].i + 1)) throw new Error("trim did not keep a contiguous tail");

  // A reopened log counts existing lines, so restarts cannot grow it unbounded.
  writeFileSync(bounded, Array.from({ length: 10 }, (_, i) => `${JSON.stringify({ event: "old", i })}\n`).join(""));
  const reopened = createEventLog(bounded, { maxLines: 10 });
  reopened.record("new", {});
  reopened.record("new", {});
  entries = readEntries(bounded);
  if (entries.length !== 10 || entries.at(-1).event !== "new") throw new Error(`reopened log was not trimmed: ${entries.length} lines`);

  const blocker = join(dir, "not-a-dir");
  writeFileSync(blocker, "");
  const errors = [];
  const broken = createEventLog(join(blocker, "events.jsonl"), { onError: (err) => errors.push(err) });
  broken.record("start");
  broken.record("exit");
  if (errors.length !== 1) throw new Error(`write failures should be reported once, got ${errors.length}`);

  console.log("Gateway event log test passed ✅");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
