// Validates that a session file created in folder A can be reopened with a
// different cwd override (B) — the mechanic behind the bot's /cd command.
// No LLM call is made (session creation only). Run: node test/cd-test.mjs

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  createEventBus,
  SettingsManager,
  SessionManager,
} from "@earendil-works/pi-coding-agent";

const dirA = "C:/Users/Kele";
const dirB = "C:/Users/Kele/pi-telegram-gateway";
const sessionsDir = mkdtempSync(join(tmpdir(), "pi-gw-cd-"));

const loader = new DefaultResourceLoader({ cwd: dirA, agentDir: getAgentDir() });
await loader.reload();
const modelRuntime = await (await import("@earendil-works/pi-coding-agent")).ModelRuntime.create();

let failed = false;
const assert = (cond, label) => {
  console.log(cond ? `  ✓ ${label}` : `  ✗ ${label}`);
  if (!cond) failed = true;
};

const file = join(sessionsDir, "chat-42.jsonl");

// 1) create with cwd A
const { session: sA } = await createAgentSession({
  cwd: dirA,
  agentDir: getAgentDir(),
  modelRuntime,
  settingsManager: SettingsManager.create(dirA, getAgentDir()),
  resourceLoader: loader,
  sessionManager: SessionManager.open(file, sessionsDir, dirA),
});
assert(sA.sessionFile === file, `first session persisted at ${file}`);
sA.dispose();

// 2) reopen SAME file with cwd override B (what /cd does)
const { session: sB } = await createAgentSession({
  cwd: dirB,
  agentDir: getAgentDir(),
  modelRuntime,
  settingsManager: SettingsManager.create(dirB, getAgentDir()),
  resourceLoader: loader,
  sessionManager: SessionManager.open(file, sessionsDir, dirB),
});
assert(sB.sessionFile === file, "session reopened on the same file after /cd");
assert(sB.messages.length === 0, "history is empty (fresh) but wiring works");

// 3) quick agent sanity through the new cwd (no LLM network call needed)
assert(typeof sB.prompt === "function" && typeof sB.abort === "function", "agent API available");
console.log("  cwd override active for tools:",
  JSON.stringify(sB.agent.state.tools.map((t) => t.name).slice(0, 4)));
sB.dispose();
rmSync(sessionsDir, { recursive: true, force: true });

console.log(failed ? "\ncd-test FAILED ❌" : "\ncd-test passed ✅");
process.exit(failed ? 1 : 0);