// Offline test for chat-meta.ts: meta.json parsing (incl. the legacy
// cwd-only format), field validation, and atomic write round-trip.
// Run: node test/chat-meta-test.mjs

import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseChatMeta, writeChatMeta } from "../chat-meta.ts";

let failures = 0;
function assert(cond, label) {
  if (cond) {
    console.log(`  ✓ ${label}`);
  } else {
    failures++;
    console.error(`  ✗ ${label}`);
  }
}

// ── Legacy cwd-only format stays readable ────────────────────────────────────
{
  const entries = parseChatMeta(JSON.stringify({ 42: { cwd: "/work/a" } }));
  const e = entries.get(42);
  assert(e?.cwd === "/work/a" && e.model === undefined && e.thinking === undefined, "legacy cwd-only entry parsed");
}

// ── Full entry with model/thinking ───────────────────────────────────────────
{
  const raw = JSON.stringify({
    7: { cwd: "/work/b", model: "anthropic/claude-opus-4-5", thinking: "high" },
  });
  const e = parseChatMeta(raw).get(7);
  assert(
    e?.cwd === "/work/b" && e.model === "anthropic/claude-opus-4-5" && e.thinking === "high",
    "cwd + model + thinking parsed",
  );
}

// ── Malformed ids and fields are skipped, not fatal ──────────────────────────
{
  const raw = JSON.stringify({
    "12.5": { cwd: "/x" },
    abc: { cwd: "/y" },
    3: { cwd: 99, model: null, thinking: ["high"] },
    4: {},
    5: { model: "openai/gpt-5" },
  });
  const entries = parseChatMeta(raw);
  assert(!entries.has(12.5) && !entries.has(Number("abc")), "non-integer chat ids skipped");
  assert(!entries.has(3), "entry without any valid string field skipped");
  assert(!entries.has(4), "empty entry skipped");
  assert(entries.get(5)?.model === "openai/gpt-5" && entries.get(5)?.cwd === undefined, "model-only entry kept");
}

// ── Corrupt JSON throws (caller surfaces it instead of resetting state) ──────
{
  let threw = false;
  try {
    parseChatMeta("{ not json");
  } catch {
    threw = true;
  }
  assert(threw, "invalid JSON throws");
}

// ── Atomic write round-trip; no temp file left behind ────────────────────────
{
  const dir = mkdtempSync(join(tmpdir(), "pi-gw-meta-"));
  const file = join(dir, "meta.json");
  try {
    const entries = new Map([
      [1, { cwd: "/a", model: "openai/gpt-5", thinking: "medium" }],
      [2, { cwd: "/b" }],
    ]);
    writeChatMeta(file, entries);
    const parsed = parseChatMeta(readFileSync(file, "utf8"));
    assert(
      parsed.get(1)?.model === "openai/gpt-5" && parsed.get(1)?.thinking === "medium" && parsed.get(2)?.cwd === "/b",
      "write/read round-trip preserves entries",
    );
    assert(!existsSync(`${file}.tmp`), "no temp file left behind");

    // Overwrite drops fields that are no longer present.
    writeChatMeta(file, new Map([[1, { cwd: "/a2" }]]));
    const again = parseChatMeta(readFileSync(file, "utf8"));
    assert(again.get(1)?.cwd === "/a2" && again.get(1)?.model === undefined && !again.has(2), "rewrite replaces state");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── writeChatMeta propagates failure (caller warns the user) ─────────────────
{
  let threw = false;
  try {
    writeChatMeta(join(tmpdir(), "pi-gw-meta-missing-dir", "meta.json"), new Map());
  } catch {
    threw = true;
  }
  assert(threw, "write failure propagates");
}

if (failures === 0) {
  console.log("\nchat-meta test passed ✅");
} else {
  console.error(`\n${failures} test(s) failed ❌`);
  process.exit(1);
}
