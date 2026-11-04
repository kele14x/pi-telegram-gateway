// Offline process and real SDK regressions. Run: node test/agent-process-test.mjs
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import ts from "typescript";
import { AgentProcess, agentEnvironment } from "../agent-process.ts";
import { AgentOperationCancelled, AgentWorkerUnavailable } from "../agent-protocol.ts";

const execFileAsync = promisify(execFile);
const workerPath = fileURLToPath(new URL("./agent-worker-fixture.mjs", import.meta.url));
const syntheticRoot = join(tmpdir(), `pi-agent-process-offline-${process.pid}`);
// These are inert path labels, not directories to create/read/write.
const fixtureEnv = {
  PATH: process.env.PATH ?? "",
  HOME: syntheticRoot,
  PI_CODING_AGENT_DIR: join(syntheticRoot, "fake-agent-config"),
  ANTHROPIC_API_KEY: "synthetic-anthropic-key-not-a-credential",
  OPENAI_API_KEY: "synthetic-openai-key-not-a-credential",
  HTTPS_PROXY: "http://synthetic-proxy.invalid:9",
  TELEGRAM_BOT_TOKEN: "synthetic-bot-token-not-a-credential",
  TELEGRAM_PROXY: "http://synthetic-telegram-proxy.invalid:9",
  ALLOWED_TELEGRAM_IDS: "42,43",
  NODE_OPTIONS: "--no-warnings",
};
const text = (action, tag, extra = {}) => JSON.stringify({ action, tag, ...extra });
const command = chatId => ({
  chatId, cwd: join(syntheticRoot, `project-${chatId}`),
  sessionsDir: join(syntheticRoot, "fake-history"),
  appendSystemPrompt: ["Synthetic offline context"],
});
const outcome = promise => Promise.resolve(promise).then(
  value => ({ ok: true, value }), error => ({ ok: false, error }),
);
function rejected(result, ErrorType = AgentWorkerUnavailable) {
  assert.equal(result.ok, false, "operation must reach a rejected terminal state");
  assert(result.error instanceof ErrorType, `expected ${ErrorType.name}, got ${result.error?.name}: ${result.error?.message}`);
}
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
async function bounded(promise, label, ms = 5000) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), ms); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
function assertExited(pid) {
  assert.throws(() => process.kill(pid, 0), error => error.code === "ESRCH", `worker ${pid} must be reaped`);
}

class FixtureJournal {
  entries = [];
  waiters = new Set();
  buffer = "";

  accept(chunk) {
    this.buffer += chunk;
    let newline;
    while ((newline = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (!line.startsWith("AGENT_FIXTURE ")) continue;
      const entry = JSON.parse(line.slice("AGENT_FIXTURE ".length));
      this.entries.push(entry);
      for (const waiter of [...this.waiters]) {
        if (waiter.predicate(entry)) {
          this.waiters.delete(waiter);
          waiter.resolve(entry);
        }
      }
    }
  }

  async wait(predicate, label, ms = 5000) {
    const existing = this.entries.find(predicate);
    if (existing) return existing;
    const gate = deferred();
    const waiter = { predicate, resolve: gate.resolve };
    this.waiters.add(waiter);
    try { return await bounded(gate.promise, label, ms); }
    finally { this.waiters.delete(waiter); }
  }

  find(kind, chatId, tag) {
    return this.entries.filter(entry => entry.kind === kind &&
      (chatId === undefined || entry.chatId === chatId) &&
      (tag === undefined || entry.tag === tag));
  }
}

async function withWorker(body, options = {}) {
  const journal = new FixtureJournal();
  const failures = [];
  const worker = new AgentProcess({
    workerPath, env: fixtureEnv,
    startupTimeoutMs: 10_000, requestTimeoutMs: 5000,
    // AgentProcess starts heartbeat only after ready, not during SDK imports.
    heartbeatMs: 100, stallTimeoutMs: 10_000, cancellationTimeoutMs: 500,
    ...options,
    onLog: chunk => journal.accept(chunk),
    onFailure: error => failures.push(error),
  });
  try {
    await worker.start(); // Intentionally never inspect its internal connection.
    const boot = await journal.wait(entry => entry.kind === "boot", "fixture boot", 10_000);
    assert.notEqual(boot.pid, process.pid, "SDK session runs in a distinct OS process");
    return await body({ worker, journal, failures, pid: boot.pid });
  } finally {
    await worker.stop(1000);
    for (const entry of journal.find("boot")) assertExited(entry.pid);
  }
}

async function environmentCase() {
  assert(process.execArgv.some(arg => arg.startsWith("--env-file=")), "parent really launched with --env-file");
  assert(process.execArgv.some(arg => arg.startsWith("--env-file-if-exists=")), "parent really launched with optional env-file");
  const original = { ...fixtureEnv };
  const clean = agentEnvironment(original);
  assert.deepEqual(original, fixtureEnv, "environment sanitizer must not mutate caller input");
  for (const key of ["TELEGRAM_BOT_TOKEN", "TELEGRAM_PROXY", "ALLOWED_TELEGRAM_IDS", "NODE_OPTIONS"]) {
    assert.equal(clean[key], undefined);
  }
  for (const key of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "PI_CODING_AGENT_DIR", "HTTPS_PROXY"]) {
    assert.equal(clean[key], fixtureEnv[key], `model environment ${key} must survive`);
  }
  await withWorker(async ({ journal, failures }) => {
    const boot = journal.find("boot")[0];
    assert.deepEqual(boot.execArgv, [], "worker inherits neither env-file arguments nor any parent execArgv");
    for (const key of ["TELEGRAM_BOT_TOKEN", "TELEGRAM_PROXY", "ALLOWED_TELEGRAM_IDS", "NODE_OPTIONS"]) {
      assert.equal(boot.environment[key], null, `${key} must not enter worker`);
    }
    for (const key of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "PI_CODING_AGENT_DIR", "HTTPS_PROXY"]) {
      assert.equal(boot.environment[key], fixtureEnv[key]);
    }
    assert.equal(failures.length, 0);
  });
}

async function streamAndSettingsCase() {
  await withWorker(async ({ worker, journal, failures }) => {
    const a = await worker.createSession(command(42));
    const b = await worker.createSession({ ...command(43), thinking: "low" });
    assert.deepEqual(a.model, { provider: "fixture", id: "alpha" });
    assert.equal(a.thinkingLevel, "off");
    assert.equal(b.thinkingLevel, "low");
    assert.equal(a.sessionFile, `${command(42).sessionsDir}/chat-42.jsonl`);
    assert.equal(a.messageCount, 0);
    assert.equal(a.isStreaming, false);
    assert.deepEqual(journal.find("created").map(entry => entry.chatId), [42, 43]);
    const created = journal.find("created", 42)[0];
    assert.equal(created.cwd, command(42).cwd);
    assert.equal(created.sessionsDir, command(42).sessionsDir);
    assert.deepEqual(created.appendSystemPrompt, command(42).appendSystemPrompt);

    const eventsA = [], eventsB = [];
    const startedA = deferred();
    const unsubscribe = a.subscribe(event => {
      eventsA.push({ event, streaming: a.isStreaming, count: a.messageCount });
      if (event.type === "agent_start") startedA.resolve();
    });
    b.subscribe(event => eventsB.push(event));
    const images = [{ type: "image", data: "c3ludGhldGlj", mimeType: "image/png" }];
    const accepted = [];
    const active = outcome(a.prompt(text("hold", "a-active"), {
      images, streamingBehavior: "followUp", preflightResult: value => accepted.push(value),
    }));
    await bounded(startedA.promise, "A streamed start");
    assert.equal(a.isStreaming, true);
    assert.equal(a.messageCount, 1, "event subscribers see the updated snapshot");
    assert.equal(b.isStreaming, false);
    assert.equal(b.messageCount, 0);
    assert.equal(accepted.length, 1);
    const started = await journal.wait(entry => entry.kind === "started" && entry.tag === "a-active", "A started");
    assert.deepEqual(started.images, images);
    assert.equal(started.streamingBehavior, "followUp");

    await b.prompt(text("echo", "b-complete"));
    assert.equal(b.messageCount, 2);
    assert.equal(b.isStreaming, false);
    assert.equal(a.isStreaming, true, "another chat can finish without unblocking A");
    assert(eventsB.some(event => event.type === "message_update" && event.assistantMessageEvent.delta === "reply:43:b-complete"));
    assert(!eventsA.some(({ event }) => event.assistantMessageEvent?.delta?.includes("reply:43:")));
    assert(!eventsB.some(event => event.assistantMessageEvent?.delta?.includes("reply:42:")));

    await a.abort();
    assert.equal((await bounded(active, "aborted prompt")).ok, true);
    assert.equal(a.isStreaming, false, "prompt reply publishes post-agent_end state");
    assert.equal(a.messageCount, 2);
    assert.deepEqual(eventsA.map(({ event }) => event.type), [
      "agent_start", "message_start", "message_update", "tool_execution_start",
      "tool_execution_end", "message_end", "agent_end",
    ]);
    assert.equal(eventsA.find(({ event }) => event.type === "message_end").event.message.stopReason, "aborted");
    assert.equal(eventsA.at(-1).streaming, true, "fixture leaves final snapshot refresh to the RPC reply");
    assert.equal(eventsA.at(-1).event.willRetry, false);

    await a.setThinkingLevel("high");
    assert.equal(a.thinkingLevel, "high");
    assert.equal(b.thinkingLevel, "low");
    assert.equal(await a.cycleThinkingLevel(), "off");
    assert.equal(a.thinkingLevel, "off");
    // Model-name parsing belongs to worker/session.modelRuntime. This fixture
    // intentionally tests SDK cycleModel, not a fake parent-side name resolver.
    assert.equal(await a.cycleModel(), true);
    assert.deepEqual(a.model, { provider: "fixture", id: "beta" });
    assert.deepEqual(b.model, { provider: "fixture", id: "alpha" });
    await assert.rejects(a.prompt(text("reject", "expected-error")), /Synthetic fixture prompt failure/);
    await a.prompt(text("echo", "after-error"));
    assert.equal(a.messageCount, 4, "ordinary SDK rejection does not poison a worker");
    assert.equal(failures.length, 0);

    const beforeUnsubscribe = eventsA.length;
    unsubscribe();
    await a.prompt(text("echo", "unsubscribed"));
    assert.equal(eventsA.length, beforeUnsubscribe);
    const disposal = a.dispose();
    assert.equal(a.dispose(), disposal, "dispose is idempotent");
    await disposal;
    await journal.wait(entry => entry.kind === "dispose" && entry.chatId === 42, "A disposal");
    await assert.rejects(a.prompt(text("echo", "disposed-must-not-start")));
    await b.prompt(text("echo", "other-chat-survives-dispose"));
    assert.equal(journal.find("started", 42, "disposed-must-not-start").length, 0);

    const controller = new AbortController();
    controller.abort();
    await assert.rejects(worker.createSession(command(44), controller.signal), AgentOperationCancelled);
    assert.equal(journal.find("created", 44).length, 0);
  });
}

async function processApiCase() {
  await withWorker(async ({ worker, journal, failures }) => {
    const session = await worker.createSession(command(42));
    await session.prompt(text("process-api", "native-child-process-contract"));
    const outputs = journal.find("process-api");
    assert.equal(outputs.length, 4);
    for (const output of outputs) {
      assert.equal(output.stdout, "stdout", `${output.name} retains stdout`);
      assert.equal(output.stderr, "stderr", `${output.name} retains stderr`);
      assert.equal(output.child, true, `${output.name} retains promise.child`);
      assert.equal(output.buffers, output.encoding === "buffer");
    }
    const errors = journal.find("process-api-error");
    assert.equal(errors.length, 2);
    for (const error of errors) {
      assert.equal(error.code, 7);
      assert.equal(error.stdout, "failed");
      assert.equal(error.stderr, "error");
      assert.equal(error.child, true);
    }
    assert.equal(journal.find("process-api-killed")[0]?.signal, "SIGTERM");
    assert.equal(failures.length, 0);
  });
}

async function creationCancellationCase() {
  await withWorker(async ({ worker, journal, failures }) => {
    const control = await worker.createSession(command(43));
    const controller = new AbortController();
    let settled = false;
    const pending = outcome(worker.createSession(command(44), controller.signal));
    void pending.then(() => { settled = true; });
    await journal.wait(entry => entry.kind === "creation-waiting", "asynchronous session creation");
    controller.abort();
    await control.prompt(text("echo", "responsive-during-creation"));
    assert.equal(settled, false, "cancelled creation must wait for disposal before history can be reset");
    assert.equal(journal.find("created", 44).length, 0);
    await control.prompt(text("release-creation", "release-cancelled-creation", { chatId: 44 }));
    rejected(await bounded(pending, "cancelled creation disposal"), AgentOperationCancelled);
    assert.equal(journal.find("created", 44).length, 1);
    assert.equal(journal.find("dispose", 44).length, 1);
    assert.equal(journal.find("started", 44).length, 0);
    assert.equal(failures.length, 0);
  });
}

async function cancellationCase() {
  await withWorker(async ({ worker, journal, failures }) => {
    const a = await worker.createSession(command(42));
    const control = await worker.createSession(command(43));
    const active = outcome(a.prompt(text("hold", "active")));
    await journal.wait(entry => entry.kind === "started" && entry.tag === "active", "active run");
    await a.prompt(text("echo", "queued-must-not-start"), { streamingBehavior: "followUp" });
    await journal.wait(entry => entry.kind === "queued" && entry.tag === "queued-must-not-start", "SDK follow-up queued");
    await a.cancel();
    assert.equal((await bounded(active, "cancel active")).ok, true);
    assert(journal.find("clear", 42).some(entry => entry.dropped.includes("queued-must-not-start")));
    await a.prompt(text("echo", "new-generation"));
    assert.equal(journal.find("started", 42, "queued-must-not-start").length, 0);
    assert.equal(a.messageCount, 4);
    assert.equal(control.messageCount, 0);

    // An old-generation request is inside SDK input preflight, not a mock
    // gateway queue. The second can be concurrently preparing or serialized
    // behind it; both must be rejected without starting after cancellation.
    const old = ["old-preflight-1", "old-preflight-2"].map(tag => ({
      tag, result: outcome(a.prompt(text("preflight", tag))),
    }));
    await journal.wait(entry => entry.kind === "preflight-waiting" && entry.tag === old[0].tag,
      "SDK input preflight entered");
    const clearCount = journal.find("clear", 42).length;
    await bounded(a.cancel(), "cancel must not wait for input preflight");
    assert(journal.find("clear", 42).length > clearCount);
    await control.prompt(text("release-preflight", "release-old", { chatId: 42 }));
    for (const { tag, result } of old) {
      rejected(await bounded(result, `${tag} terminal rejection`), AgentOperationCancelled);
      assert.equal(journal.find("started", 42, tag).length, 0, "generation check runs before agent_start");
    }
    await a.prompt(text("echo", "after-preflight-cancel"));
    assert.equal(a.messageCount, 6, "obsolete preflights append no history");
    assert.equal(a.isStreaming, false);

    const clearRun = outcome(a.prompt(text("hold", "clearQueue-active")));
    await journal.wait(entry => entry.kind === "started" && entry.tag === "clearQueue-active", "clearQueue run");
    const aborts = journal.find("abort", 42).length;
    assert.equal(a.clearQueue(), undefined, "clearQueue remains fire-and-forget");
    await journal.wait(entry => entry.kind === "abort" && entry.chatId === 42 &&
      journal.find("abort", 42).length > aborts, "clearQueue cancellation");
    assert.equal((await bounded(clearRun, "clearQueue active termination")).ok, true);
    assert.equal(failures.length, 0);
  });
}

async function cancellationBoundaryCase() {
  await withWorker(async ({ worker, journal, failures }) => {
    const session = await worker.createSession(command(42));
    let cancellation;
    let stopped;
    const unsubscribe = session.subscribe(event => {
      if (event.type === "agent_end" && !cancellation) {
        cancellation = session.cancel();
        stopped = session.abort();
      }
    });
    try {
      await session.prompt(text("echo", "finishing-before-stop"));
      assert(cancellation && stopped, "stop races with the finishing prompt reply");
      const next = outcome(session.prompt(text("hold", "fresh-after-stop")));
      await bounded(stopped, "old cancellation drain");
      await journal.wait(entry => entry.kind === "started" && entry.tag === "fresh-after-stop", "fresh prompt starts");
      await session.setThinkingLevel("high");
      assert.equal(session.isStreaming, true, "old abort acknowledgments must not stop the new run");
      assert.equal(journal.find("finished", 42, "fresh-after-stop").length, 0);
      await session.abort();
      assert.equal((await bounded(next, "explicit new-run abort")).ok, true);
      assert.equal(session.isStreaming, false);
      assert.equal(failures.length, 0);
    } finally {
      unsubscribe();
    }
  });
}

async function terminalAndRecovery({ worker, journal, failures, pid }, stale, pending) {
  for (const operation of pending) rejected(await bounded(operation, "pending request failure"));
  assert.equal(failures.length, 1, "one worker failure notification, not one per request/session");
  for (const handle of stale) {
    rejected(await outcome(handle.prompt(text("echo", "stale-must-not-replay"))));
    rejected(await outcome(handle.setThinkingLevel("high")));
    rejected(await outcome(handle.abort()));
    assert.equal(handle.clearQueue(), undefined);
    await handle.dispose();
  }
  const fresh = await worker.createSession(command(99));
  const replacement = await journal.wait(entry => entry.kind === "created" && entry.chatId === 99, "replacement session", 10_000);
  assert.notEqual(replacement.pid, pid, "recovery starts a fresh OS process");
  assertExited(pid);
  assert.equal(fresh.messageCount, 0);
  assert.equal(fresh.isStreaming, false);
  assert.deepEqual(journal.entries.filter(entry => entry.pid === replacement.pid && entry.kind === "created").map(entry => entry.chatId), [99],
    "old sessions are never automatically recreated/replayed");
  await fresh.prompt(text("echo", "recovered"));
  assert.equal(fresh.messageCount, 2);
  assert.equal(journal.find("started", undefined, "stale-must-not-replay").length, 0);
  assert.equal(failures.length, 1);
}

async function crashCase() {
  await withWorker(async context => {
    const { worker, journal } = context;
    const a = await worker.createSession(command(42));
    const b = await worker.createSession(command(43));
    const held = outcome(b.prompt(text("hold", "other-chat-pending")));
    await journal.wait(entry => entry.kind === "started" && entry.tag === "other-chat-pending", "other chat active");
    const crashed = outcome(a.prompt(text("crash", "crash-now")));
    await terminalAndRecovery(context, [a, b], [crashed, held]);
  });
}

async function shellCrashCase() {
  await withWorker(async context => {
    const { worker, journal } = context;
    const a = await worker.createSession(command(42));
    const crashed = outcome(a.prompt(text("spawn-crash", "crash-with-shell")));
    const descendant = await journal.wait(entry => entry.kind === "descendant", "shell PID before abrupt exit");
    await terminalAndRecovery(context, [a], [crashed]);
    try {
      process.kill(descendant.childPid, 0);
      const state = await execFileAsync("ps", ["-o", "stat=", "-p", String(descendant.childPid)]);
      assert.match(state.stdout.trim(), /^Z/, "detached shell must be terminated, not keep running after worker crash");
    } catch (error) {
      if (error.code !== "ESRCH" && error.code !== 1) throw error;
    }
  });
}

async function processOwnershipCase() {
  const source = readFileSync(new URL("../agent-process.ts", import.meta.url), "utf8");
  const ast = ts.createSourceFile("agent-process.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const declarations = ast.statements.filter(node => ts.isFunctionDeclaration(node) &&
    ["activeJournalProcesses", "terminateProcessTree"].includes(node.name?.text));
  assert.equal(declarations.length, 2);
  const startedAt = Date.parse("2026-01-01T00:00:00Z");
  const stamp = time => new Date(time).toUTCString();
  const records = [
    { type: "spawn", pid: 200, startedAt },
    { type: "spawn", pid: 201, startedAt, group: 200 },
    { type: "exit", pid: 200 },
    { type: "spawn", pid: 300, startedAt },
    { type: "spawn", pid: 401, startedAt, group: 400 },
    { type: "spawn", pid: 500, startedAt },
    { type: "spawn", pid: 601, startedAt, group: 600 },
  ];
  const rows = [
    `201 1 200 ${stamp(startedAt)}`,
    `202 1 200 ${stamp(startedAt + 10_000)}`,
    `301 1 300 ${stamp(startedAt + 10_000)}`,
    `401 1 400 ${stamp(startedAt + 10_000)}`,
    `501 1 100 ${stamp(startedAt + 10_000)}`,
    `601 1 700 ${stamp(startedAt)}`,
  ];
  const signals = [];
  const context = vm.createContext({
    readFileSync: () => records.map(record => JSON.stringify(record)).join("\n"),
    execFileAsync: async () => ({ stdout: rows.join("\n") }),
    process: { pid: 999, platform: "linux", env: {}, kill: (pid, signal) => signals.push([pid, signal]) },
  });
  vm.runInContext(ts.transpileModule(declarations.map(node => node.getText(ast)).join("\n"), {
    compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.None },
  }).outputText, context);
  const child = { pid: 100, exitCode: 23, signalCode: null };
  await context.terminateProcessTree(child, "synthetic-journal");
  assert.deepEqual(signals, [[-200, "SIGKILL"], [202, "SIGKILL"], [601, "SIGKILL"], [201, "SIGKILL"]],
    "a changed group retains PID ownership without authorizing either unverified group");
  signals.length = 0;
  records.push({ type: "spawn", pid: 701, startedAt }, { type: "spawn", pid: 701, startedAt, group: 100 });
  rows.push(`701 1 701 ${stamp(startedAt)}`, `702 1 701 ${stamp(startedAt + 10_000)}`);
  await context.terminateProcessTree(child, "synthetic-journal");
  assert.deepEqual(signals, [[-200, "SIGKILL"], [-701, "SIGKILL"], [702, "SIGKILL"], [202, "SIGKILL"], [701, "SIGKILL"], [601, "SIGKILL"], [201, "SIGKILL"]],
    "a tracked process that becomes a session leader still owns its new group");
  signals.length = 0;
  context.execFileAsync = async () => { throw new Error("ps unavailable"); };
  await context.terminateProcessTree(child, "synthetic-journal");
  assert.deepEqual(signals, [], "an exited worker does not authorize killing an unverifiable group");
  const live = { pid: 100, exitCode: null, signalCode: null, kill: signal => signals.push([100, signal]) };
  await context.terminateProcessTree(live, "synthetic-journal");
  assert.deepEqual(signals, [[100, "SIGSTOP"], [-100, "SIGKILL"], [100, "SIGKILL"]]);
}

async function backgroundDescendantCase(crash) {
  for (const api of ["spawn", "exec", "execFile"]) {
    await withWorker(async context => {
      const { worker, journal } = context;
      const session = await worker.createSession(command(42));
      await session.prompt(text("spawn-background", "exited-shell", { api }));
      const descendant = await journal.wait(entry => entry.kind === "background-descendant", "background child after shell exit");
      assert(Number.isSafeInteger(descendant.childPid) && descendant.childPid > 1);
      try {
        assertExited(descendant.shellPid);
        process.kill(descendant.childPid, 0);
        if (crash) {
          const crashed = outcome(session.prompt(text("crash", "crash-after-shell-exit")));
          await terminalAndRecovery(context, [session], [crashed]);
        } else {
          await worker.stop(1000);
        }
        try {
          const { stdout } = await execFileAsync("ps", ["-o", "stat=", "-p", String(descendant.childPid)]);
          assert.match(stdout.trim(), /^Z/, `${api} background child must not survive ${crash ? "crash" : "shutdown"}`);
        } catch (error) {
          if (error.code !== 1) throw error;
        }
      } finally {
        try { process.kill(descendant.childPid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; }
      }
    });
  }
}

async function blockingCase(useCancel) {
  await withWorker(async context => {
    const { worker, journal, failures } = context;
    const a = await worker.createSession(command(42));
    const b = await worker.createSession(command(43));
    const held = outcome(b.prompt(text("hold", "pending-during-block")));
    await journal.wait(entry => entry.kind === "started" && entry.tag === "pending-during-block", "second chat active");
    const blocked = outcome(a.prompt(text("block", "synchronous-block")));
    await journal.wait(entry => entry.kind === "blocked", "worker entered Atomics.wait");
    // A real parent timer must run while the child cannot process even a ping.
    let ticks = 0;
    const interval = setInterval(() => { ticks++; }, 10);
    try {
      await bounded(new Promise(resolve => setTimeout(resolve, 60)), "parent event loop responsive", 1000);
      assert(ticks > 0, "synchronous SDK blocking must not block the gateway process");
      assert.equal(failures.length, 0, "test reaches the blocked state before failure detection");
      const setting = outcome(b.setThinkingLevel("high"));
      const pending = [blocked, held, setting];
      if (useCancel) {
        const start = performance.now();
        const cancelled = await bounded(outcome(a.cancel()), "short cancellation timeout evicts blocked worker", 4000);
        rejected(cancelled);
        assert.match(cancelled.error.message, /timed out/);
        assert(performance.now() - start < 4000);
      }
      await terminalAndRecovery(context, [a, b], pending);
    } finally {
      clearInterval(interval);
    }
  }, useCancel
    ? { cancellationTimeoutMs: 300, stallTimeoutMs: 10_000 }
    : { heartbeatMs: 100, stallTimeoutMs: 1500, requestTimeoutMs: 10_000 });
}

async function asynchronousStallCase() {
  await withWorker(async context => {
    const { worker, journal, failures } = context;
    const a = await worker.createSession(command(42));
    const b = await worker.createSession(command(43));
    const pending = outcome(a.prompt(text("preflight", "never-resumed")));
    await journal.wait(entry => entry.kind === "preflight-waiting", "uninterruptible asynchronous preflight");
    await a.cancel();
    assert.equal(failures.length, 0, "responsive worker confirms the cancellation request");
    await terminalAndRecovery(context, [a, b], [pending]);
  }, { cancellationTimeoutMs: 300, stallTimeoutMs: 10_000 });
}

async function shutdownCase() {
  await withWorker(async ({ worker, journal, failures }) => {
    const handles = await Promise.all([worker.createSession(command(42)), worker.createSession(command(43))]);
    const pending = handles.map((handle, i) => outcome(handle.prompt(text("hold", `shutdown-${i}`))));
    for (let i = 0; i < handles.length; i++) {
      await journal.wait(entry => entry.kind === "started" && entry.tag === `shutdown-${i}`, "shutdown active session");
    }
    await bounded(worker.stop(2000), "graceful worker shutdown", 5000);
    for (const operation of pending) {
      const result = await bounded(operation, "shutdown prompt terminal state");
      if (!result.ok) rejected(result);
    }
    for (const chatId of [42, 43]) {
      await journal.wait(entry => entry.kind === "abort" && entry.chatId === chatId, "shutdown abort");
      assert.equal(journal.find("dispose", chatId).length, 1);
      assert(journal.find("clear", chatId).length > 0);
    }
    assert.equal(failures.length, 0, "intentional shutdown is not a crash notification");
    await assert.rejects(worker.start(), AgentWorkerUnavailable);
    await assert.rejects(worker.createSession(command(99)), AgentWorkerUnavailable);
    await worker.stop(100);
  });

  // The shutdown grace deadline also works when the SDK is synchronously stuck.
  await withWorker(async ({ worker, journal, failures }) => {
    const session = await worker.createSession(command(42));
    const blocked = outcome(session.prompt(text("block", "shutdown-block")));
    await journal.wait(entry => entry.kind === "blocked", "blocked shutdown");
    await bounded(worker.stop(200), "force shutdown after grace deadline", 4000);
    rejected(await bounded(blocked, "forced shutdown request rejected"));
    assert.equal(failures.length, 0);
    await session.dispose();
  });
}

async function realSdkCase() {
  const base = mkdtempSync(join(tmpdir(), "pi-agent-sdk-offline-"));
  const agentDir = join(base, "agent");
  const dirA = join(base, "project-a");
  const dirB = join(base, "project-b");
  const sessionsDir = join(base, "sessions");
  for (const dir of [agentDir, dirA, dirB, sessionsDir]) mkdirSync(dir);
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ compaction: { enabled: false }, cacheWarming: { enabled: false } }));
  writeFileSync(join(dirA, "AGENTS.md"), "SDK_PROJECT_A");
  writeFileSync(join(dirB, "AGENTS.md"), "SDK_PROJECT_B");
  const failures = [];
  const journal = new FixtureJournal();
  const worker = new AgentProcess({
    workerPath: fileURLToPath(new URL("./agent-sdk-fixture.mjs", import.meta.url)),
    env: { ...fixtureEnv, HOME: base, PI_CODING_AGENT_DIR: agentDir },
    onLog: chunk => journal.accept(chunk),
    onFailure: error => failures.push(error),
  });
  const create = (cwd, chatId = 77) => worker.createSession({
    chatId, cwd, sessionsDir, storedThinking: "low", appendSystemPrompt: ["SDK_GATEWAY_CONTEXT"],
  });
  const reply = async (session, prompt) => {
    let output = "";
    const unsubscribe = session.subscribe(event => { if (event.type === "message_update") output += event.assistantMessageEvent.delta; });
    try { await session.prompt(prompt); return output; }
    finally { unsubscribe(); }
  };
  try {
    const first = await create(dirA);
    assert.match(await reply(first, "remember-me"), /SDK_REPLY:remember-me:users=1/);
    assert.equal(first.thinkingLevel, "low");
    const model = first.model;
    await first.dispose();
    const second = await create(dirB);
    assert.equal(second.sessionFile, first.sessionFile);
    assert(second.messageCount >= 2, "real SDK history is reopened across IPC");
    assert.match(await reply(second, "READ_PROJECT"), /SDK_PROJECT_B/);
    assert.match(await reply(second, "RUN_SHELL"), /SHELL_OK:unset/);
    const selection = await second.setModel(`${model.provider}/${model.id}:medium`);
    assert.equal(selection.thinkingLevel, "medium");
    assert.equal(second.thinkingLevel, "medium");
    await second.setThinkingLevel("high");
    const kept = await second.setModel(`${model.provider}/${model.id}`);
    assert.equal(kept.thinkingLevel, "high", "plain model selection retains the chat preference");
    assert.equal(second.thinkingLevel, "high");
    const { plain } = await journal.wait(entry => entry.kind === "sdk-models", "plain SDK model");
    assert.equal((await second.setModel(`${plain.provider}/${plain.id}`)).thinkingLevel, "high");
    assert.equal(second.thinkingLevel, "off", "SDK still clamps unsupported thinking");
    await second.setModel(`${model.provider}/${model.id}`);
    assert.equal(second.thinkingLevel, "high", "unclamped preference survives a non-reasoning model");
    await second.dispose();
    const file = join(sessionsDir, "chat-77.jsonl");
    const persisted = readFileSync(file, "utf8");
    assert(persisted.includes("remember-me") && persisted.includes("SDK_PROJECT_B"));
    assert(persisted.includes("gateway-working-folder"));
    assert(!persisted.includes(fixtureEnv.TELEGRAM_BOT_TOKEN));

    const a = await create(dirB, 79);
    const control = await create(dirB, 78);
    for (const [prefix, tag] of [["WAIT_INPUT", "cancel-input"], ["WAIT_START", "cancel-start"]]) {
      const pending = outcome(a.prompt(`${prefix}:${tag}`));
      await journal.wait(entry => entry.kind === "sdk-waiting" && entry.tag === tag, tag);
      await a.cancel();
      await control.prompt(`RELEASE:79:${tag}`);
      rejected(await bounded(pending, tag), AgentOperationCancelled);
      await a.abort();
      assert.equal(a.isStreaming, false, "real SDK becomes idle after cancelled run preparation");
      await a.prompt(`after-${tag}`);
    }
    const streams = journal.find("sdk-stream-waiting").length;
    const held = outcome(a.prompt("HOLD_RESPONSE"));
    await journal.wait(entry => entry.kind === "sdk-stream-waiting" && journal.find("sdk-stream-waiting").length > streams, "held SDK response");
    const queued = outcome(a.prompt("WAIT_INPUT:obsolete-queue", { streamingBehavior: "followUp" }));
    await journal.wait(entry => entry.kind === "sdk-waiting" && entry.tag === "obsolete-queue", "queued input preflight");
    await a.cancel();
    assert.equal((await bounded(held, "aborted SDK response")).ok, true);
    const nextStreams = journal.find("sdk-stream-waiting").length;
    const next = outcome(a.prompt("HOLD_RESPONSE"));
    await journal.wait(entry => entry.kind === "sdk-stream-waiting" && journal.find("sdk-stream-waiting").length > nextStreams, "new-generation SDK response");
    await control.prompt("RELEASE:79:obsolete-queue");
    rejected(await bounded(queued, "obsolete SDK queue rejected before insertion"), AgentOperationCancelled);
    await a.abort();
    assert.equal((await bounded(next, "new SDK response cancelled")).ok, true);
    await a.prompt("after-queue-cancellation");
    let stopped;
    const unsubscribe = a.subscribe(event => {
      if (event.type === "agent_end" && !stopped) {
        void a.cancel().catch(() => {});
        stopped = outcome(a.abort());
      }
    });
    try {
      await a.prompt("finishing-at-stop-boundary");
      assert(stopped);
      const fresh = outcome(a.prompt("HOLD_RESPONSE"));
      assert.equal((await bounded(stopped, "SDK cancellation drain")).ok, true);
      await a.setThinkingLevel("low");
      assert.equal(a.isStreaming, true, "a delayed cancellation drain must leave the fresh SDK run active");
      await a.abort();
      assert.equal((await bounded(fresh, "fresh SDK run explicitly stopped")).ok, true);
    } finally {
      unsubscribe();
    }
    const history = readFileSync(join(sessionsDir, "chat-79.jsonl"), "utf8");
    assert(!history.includes("WAIT_INPUT:") && !history.includes("WAIT_START:"), "obsolete inputs never enter SDK history");
    await Promise.all([a.dispose(), worker.stop(2000)]);
    assert.equal(journal.find("sdk-dispose", 79).length, 1, "concurrent dispose/shutdown cleans SDK resources once");
    assert.equal(journal.find("sdk-shutdown", 79).length, 1, "extension shutdown lifecycle runs once");
    assert.equal(failures.length, 0);
  } finally {
    await worker.stop();
    rmSync(base, { recursive: true, force: true });
  }
}

const unhandled = [];
const onUnhandled = error => unhandled.push(error);
process.on("unhandledRejection", onUnhandled);
try {
  if (process.argv.includes("--environment-case")) {
    await environmentCase();
    console.log("PASS environment isolation with real parent env-file flags");
  } else {
    // /dev/null is an actual empty env-file, not a real .env or a new fixture
    // file. The nested parent itself receives only the synthetic environment.
    const environment = await execFileAsync(process.execPath, [
      "--env-file=/dev/null", "--env-file-if-exists=/dev/null",
      fileURLToPath(import.meta.url), "--environment-case",
    ], { env: fixtureEnv, timeout: 20_000, maxBuffer: 1024 * 1024 });
    assert.match(environment.stdout, /PASS environment isolation/);
    console.log("PASS environment and execArgv isolation");
    for (const [name, run] of [
      ["create, multichat streaming, cached state, settings and disposal", streamAndSettingsCase],
      ["native promisified subprocess results, errors and termination handles", processApiCase],
      ["cancellation during creation waits for disposal", creationCancellationCase],
      ["queue clearing and cancellation during SDK input preflight", cancellationCase],
      ["finishing-run cancellation cannot abort a newer prompt", cancellationBoundaryCase],
      ["crash terminal states and fresh-worker recovery without replay", crashCase],
      ["abrupt crash terminates an active detached shell", shellCrashCase],
      ["process cleanup rejects reused PIDs and unverified groups", processOwnershipCase],
      ["shutdown terminates descendants of exited shells", () => backgroundDescendantCase(false)],
      ["crash recovery terminates descendants of exited shells", () => backgroundDescendantCase(true)],
      ["real synchronous block, responsive parent, cancel timeout and recovery", () => blockingCase(true)],
      ["heartbeat eviction of synchronously blocked worker and recovery", () => blockingCase(false)],
      ["cancellation evicts asynchronously stuck preflight despite healthy heartbeat", asynchronousStallCase],
      ["graceful multi-session shutdown and forced shutdown deadline", shutdownCase],
      ["real SDK history, cwd tools, model selection and shell environment over IPC", realSdkCase],
    ]) {
      await run();
      console.log(`PASS ${name}`);
    }
  }
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(unhandled, [], "abandoned RPC/cancellation/disposal promises must not produce unhandled rejections");
} finally {
  process.removeListener("unhandledRejection", onUnhandled);
}
