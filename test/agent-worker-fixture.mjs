// Real worker RPC dispatch with in-memory SDK-shaped sessions only.
import { exec, execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { startAgentWorker } from "../agent-worker.ts";

const sessions = new Map();
const creations = new Map();
const never = () => new Promise(() => {});
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
function record(kind, fields = {}) {
  console.log(`AGENT_FIXTURE ${JSON.stringify({ kind, pid: process.pid, ...fields })}`);
}

// Deliberately report only synthetic test variables, never the whole environment.
record("boot", {
  execArgv: process.execArgv,
  environment: Object.fromEntries([
    "TELEGRAM_BOT_TOKEN", "TELEGRAM_PROXY", "ALLOWED_TELEGRAM_IDS", "NODE_OPTIONS",
    "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "PI_CODING_AGENT_DIR", "HTTPS_PROXY",
  ].map(key => [key, process.env[key] ?? null])),
});

class FakeSession {
  model = { provider: "fixture", id: "alpha", reasoning: true };
  thinkingLevel = "off";
  messages = [];
  isStreaming = false;
  isRetrying = false;
  listeners = new Set();
  queued = [];
  preflights = new Set();
  active = undefined;
  disposed = false;
  agent = {
    prompt: async () => {},
    followUp: entry => { this.queued.push(entry); },
    steer: () => {},
  };
  extensionRunner = {
    emit: async event => { record(event.type, { chatId: this.chatId }); },
  };

  constructor(command) {
    this.chatId = command.chatId;
    // A label only: the fixture never opens or writes a session file.
    this.sessionFile = `${command.sessionsDir}/chat-${command.chatId}.jsonl`;
    this.thinkingLevel = command.storedThinking ?? command.thinking ?? "off";
    record("created", {
      chatId: this.chatId, sessionId: command.sessionId,
      cwd: command.cwd, sessionsDir: command.sessionsDir,
      appendSystemPrompt: command.appendSystemPrompt,
    });
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event) {
    for (const listener of this.listeners) listener(event);
  }

  async prompt(text, options = {}) {
    const input = JSON.parse(text);
    if (this.disposed) throw new Error("Fixture session was disposed");
    if (input.action === "preflight") {
      const gate = deferred();
      this.preflights.add(gate);
      record("preflight-waiting", { chatId: this.chatId, tag: input.tag });
      await gate.promise;
      this.preflights.delete(gate);
      record("preflight-resumed", { chatId: this.chatId, tag: input.tag });
    }

    if (this.disposed) throw new Error("Fixture session was disposed");
    if (input.action === "release-preflight") {
      for (const gate of sessions.get(input.chatId)?.preflights ?? []) gate.resolve();
    }
    if (input.action === "release-creation") creations.get(input.chatId)?.resolve();
    if (input.action === "reject") throw new Error("Synthetic fixture prompt failure");
    if (input.action === "process-api") {
      for (const [name, execute, args] of [
        ["exec", exec, ["printf stdout; printf stderr >&2"]],
        ["execFile", execFile, [process.execPath, ["-e", "process.stdout.write('stdout'); process.stderr.write('stderr')"]]],
      ]) {
        for (const encoding of ["utf8", "buffer"]) {
          const pending = promisify(execute)(...args, { encoding });
          const result = await pending;
          record("process-api", {
            name, encoding, child: Number.isSafeInteger(pending.child?.pid),
            stdout: result.stdout?.toString(), stderr: result.stderr?.toString(),
            buffers: Buffer.isBuffer(result.stdout) && Buffer.isBuffer(result.stderr),
          });
        }
      }
      for (const [name, execute, args] of [
        ["exec", exec, ["printf failed; printf error >&2; exit 7"]],
        ["execFile", execFile, [process.execPath, ["-e", "process.stdout.write('failed'); process.stderr.write('error'); process.exit(7)"]]],
      ]) {
        const pending = promisify(execute)(...args);
        try { await pending; }
        catch (error) {
          record("process-api-error", { name, code: error.code, stdout: error.stdout, stderr: error.stderr, child: !!pending.child });
        }
      }
      const pending = promisify(execFile)(process.execPath, ["-e", "setTimeout(() => {}, 10000)"]);
      pending.child?.kill("SIGTERM");
      try { await pending; }
      catch (error) { record("process-api-killed", { signal: error.signal, killed: error.killed }); }
    }

    if (this.isStreaming) {
      if (options.streamingBehavior !== "followUp") throw new Error("Fixture session is already streaming");
      this.agent.followUp({ text, options, input });
      record("queued", { chatId: this.chatId, tag: input.tag });
      return;
    }

    await this.agent.prompt([]);
    const run = { gate: deferred(), aborted: false };
    this.active = run;
    this.isStreaming = true;
    this.messages.push({ role: "user", content: text });
    record("started", {
      chatId: this.chatId, tag: input.tag,
      images: options.images ?? null, streamingBehavior: options.streamingBehavior ?? null,
    });
    this.emit({ type: "agent_start" });
    this.emit({ type: "message_start", message: { role: "assistant", content: [] } });
    this.emit({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: `reply:${this.chatId}:${input.tag}` },
    });
    this.emit({ type: "tool_execution_start", toolName: "fixture_tool", toolCallId: "fake-call" });

    if (input.action === "spawn-background") {
      const script = '"$NODE_TEST_EXEC" -e \'setTimeout(() => {}, 30000)\' </dev/null >/dev/null 2>&1 & printf "%s\\n" "$!"';
      const options = { env: { ...process.env, NODE_TEST_EXEC: process.execPath }, detached: true };
      let shellPid, output;
      if (input.api === "spawn") {
        const child = spawn("bash", ["-c", script], { ...options, stdio: ["ignore", "pipe", "ignore"] });
        shellPid = child.pid;
        output = "";
        child.stdout.on("data", chunk => { output += chunk; });
        await new Promise((resolve, reject) => { child.once("close", resolve); child.once("error", reject); });
      } else {
        const pending = input.api === "exec"
          ? promisify(exec)(script, options)
          : promisify(execFile)("bash", ["-c", script], options);
        shellPid = pending.child.pid;
        output = (await pending).stdout;
      }
      record("background-descendant", { shellPid, childPid: Number(output.trim()), api: input.api });
    }
    if (input.action === "spawn-crash") {
      const child = spawn("bash", ["-c", "exec \"$NODE_TEST_EXEC\" -e 'setTimeout(() => {}, 10000)'"], {
        env: { ...process.env, NODE_TEST_EXEC: process.execPath }, detached: true, stdio: "ignore",
      });
      record("descendant", { childPid: child.pid });
      process.exit(23);
    }
    if (input.action === "crash") {
      record("crashing", { chatId: this.chatId, tag: input.tag });
      setImmediate(() => process.exit(23));
      await never();
    }
    if (input.action === "block") {
      // Give preceding IPC events a turn to flush, then genuinely block this
      // process's event loop. No timer, ping or cancellation can execute here.
      await new Promise(resolve => setImmediate(resolve));
      record("blocked", { chatId: this.chatId, tag: input.tag });
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
      throw new Error("The permanently blocked worker unexpectedly resumed");
    }
    if (input.action === "hold") await run.gate.promise;

    this.emit({ type: "tool_execution_end", toolName: "fixture_tool", toolCallId: "fake-call", isError: false });
    const message = {
      role: "assistant", content: [{ type: "text", text: `reply:${this.chatId}:${input.tag}` }],
      stopReason: run.aborted ? "aborted" : "stop",
    };
    this.messages.push(message);
    this.emit({ type: "message_end", message });
    // Final streaming=false is intentionally NOT published by another event;
    // the prompt reply must refresh the parent handle's cached snapshot.
    this.emit({ type: "agent_end", messages: this.messages, willRetry: false });
    this.isStreaming = false;
    this.active = undefined;
    record("finished", { chatId: this.chatId, tag: input.tag, aborted: run.aborted });

    const next = this.queued.shift();
    if (next) await this.prompt(next.text, next.options);
  }

  clearQueue() {
    const dropped = this.queued.map(entry => entry.input.tag);
    this.queued = [];
    record("clear", { chatId: this.chatId, dropped });
  }

  async abort() {
    record("abort", { chatId: this.chatId });
    if (this.active) {
      this.active.aborted = true;
      this.active.gate.resolve();
    }
    // SDK input preflight is not interrupted by abort; its generation guard
    // still has to run when it is explicitly released by another chat.
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.clearQueue();
    if (this.active) {
      this.active.aborted = true;
      this.active.gate.resolve();
    }
    for (const gate of this.preflights) gate.resolve();
    record("dispose", { chatId: this.chatId });
    this.listeners.clear();
  }

  async setModel(model) {
    this.model = model;
    record("set-model", { chatId: this.chatId, provider: model.provider, id: model.id });
  }

  async cycleModel() {
    this.model = { ...this.model, id: this.model.id === "alpha" ? "beta" : "alpha" };
    return { model: this.model, thinkingLevel: this.thinkingLevel };
  }

  setThinkingLevel(level) {
    this.thinkingLevel = level;
  }

  cycleThinkingLevel() {
    const levels = ["off", "low", "medium", "high"];
    this.thinkingLevel = levels[(levels.indexOf(this.thinkingLevel) + 1) % levels.length];
    return this.thinkingLevel;
  }
}

await startAgentWorker(async command => {
  if (command.chatId === 44) {
    const gate = deferred();
    creations.set(command.chatId, gate);
    record("creation-waiting", { chatId: command.chatId });
    await gate.promise;
    creations.delete(command.chatId);
  }
  const session = new FakeSession(command);
  sessions.set(command.chatId, session);
  return session;
});
