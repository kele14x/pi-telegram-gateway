import { AsyncLocalStorage } from "node:async_hooks";
import childProcess, { type ChildProcess } from "node:child_process";
import { writeSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import dns from "node:dns";
import {
  createAgentSession, getAgentDir, ModelRuntime, resolveCliModel, SessionManager,
  type AgentSession, type AgentSessionEvent,
} from "@earendil-works/pi-coding-agent";
import { createChatResources, syncChatCwdContext } from "./chat-resources.ts";
import {
  AgentOperationCancelled, type CreateSessionCommand, type GatewayAgentEvent,
  type SessionSnapshot, type ThinkingLevel, type WorkerCommand, type WorkerMessage, type WorkerRequest,
} from "./agent-protocol.ts";

const AGENT_DIR = getAgentDir();
let runtimePromise: Promise<ModelRuntime> | undefined;

function send(message: WorkerMessage): Promise<void> {
  return new Promise((resolveSend, rejectSend) => {
    if (!process.connected || !process.send) { rejectSend(new Error("Gateway disconnected")); return; }
    process.send(message, error => error ? rejectSend(error) : resolveSend());
  });
}

function log(text: string) { void send({ type: "log", text }).catch(() => {}); }

function observeWorkerChildren() {
  const tracked = new Set<number>();
  const record = (fields: { type: "spawn" | "exit"; pid: number; startedAt?: number; group?: number }) => {
    // The inherited journal survives an abrupt exit before IPC buffers flush.
    try { writeSync(4, `${JSON.stringify(fields)}\n`); } catch { /* live PPID cleanup remains available */ }
  };
  const retainGroupMembers = (exitedPid: number) => {
    if (process.platform === "win32") return;
    try {
      const exitedAt = Date.now();
      const stdout = childProcess.execFileSync("ps", ["-axo", "pid=,pgid=,lstart="], {
        env: { ...process.env, LC_ALL: "C" }, timeout: 1000, maxBuffer: 1024 * 1024, encoding: "utf8",
      });
      for (const line of stdout.split("\n")) {
        const match = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
        if (!match) continue;
        const group = Number(match[2]);
        if (group !== exitedPid && group !== process.pid) continue;
        const pid = Number(match[1]);
        const startedAt = Date.parse(match[3]);
        if (pid !== exitedPid && pid > 1 && pid !== process.pid && startedAt <= exitedAt + 1000) {
          record({ type: "spawn", pid, startedAt, group });
        }
      }
    } catch { /* unverifiable or empty groups are not retained */ }
  };
  const track = (child: ChildProcess): ChildProcess => {
    const pid = child.pid;
    if (pid && !tracked.has(pid)) {
      tracked.add(pid);
      record({ type: "spawn", pid, startedAt: Date.now() });
      child.once("exit", () => {
        // Preserve live group-member identities before forgetting an exited leader.
        retainGroupMembers(pid);
        tracked.delete(pid);
        record({ type: "exit", pid });
      });
    }
    return child;
  };
  const observe = <T extends (...args: never[]) => ChildProcess>(original: T): T => {
    const wrapped = ((...args: Parameters<T>) => track(Reflect.apply(original, childProcess, args))) as T;
    const custom = Reflect.get(original, promisify.custom);
    if (typeof custom === "function") {
      Object.defineProperty(wrapped, promisify.custom, {
        value: (...args: Parameters<T>) => {
          const pending = Reflect.apply(custom, childProcess, args) as Promise<unknown> & { child: ChildProcess };
          track(pending.child);
          return pending;
        },
      });
    }
    return wrapped;
  };
  childProcess.spawn = observe(childProcess.spawn);
  childProcess.exec = observe(childProcess.exec);
  childProcess.execFile = observe(childProcess.execFile);
  childProcess.fork = observe(childProcess.fork);
  syncBuiltinESMExports();
}

async function getModelRuntime(): Promise<ModelRuntime> {
  if (!runtimePromise) {
    runtimePromise = ModelRuntime.create().then(runtime => {
      void runtime.refresh({ allowNetwork: true, signal: AbortSignal.timeout(15_000) }).catch(() => {});
      return runtime;
    }).catch(error => { runtimePromise = undefined; throw error; });
  }
  return runtimePromise;
}

export async function createChatSession(command: CreateSessionCommand): Promise<AgentSession> {
  const { chatId, cwd, sessionsDir } = command;
  const modelRuntime = await getModelRuntime();
  const sessionFile = join(sessionsDir, `chat-${chatId}.jsonl`);
  const sm = SessionManager.open(sessionFile, sessionsDir, cwd);
  type SessionOptions = NonNullable<Parameters<typeof createAgentSession>[0]>;
  let cliModel = command.storedModel ?? command.model;
  const thinkingPref = command.storedThinking ?? command.thinking;
  let model: SessionOptions["model"];
  let thinkingLevel = thinkingPref as SessionOptions["thinkingLevel"];
  if (cliModel) {
    let r = resolveCliModel({ cliModel, modelRuntime });
    if (r.error && command.storedModel) {
      log(`[chat ${chatId}] stored model "${command.storedModel}" no longer resolves (${r.error}); using startup default`);
      void send({ type: "lifecycle", event: "model_fallback", fields: {
        chat: chatId, stored: command.storedModel, error: r.error, using: command.model ?? "pi default",
      } }).catch(() => {});
      cliModel = command.model;
      if (cliModel) r = resolveCliModel({ cliModel, modelRuntime });
    }
    if (cliModel) {
      if (r.error) throw new Error(`Bad PI_TELEGRAM_MODEL: ${r.error}`);
      model = r.model;
      if (r.thinkingLevel) thinkingLevel = r.thinkingLevel as SessionOptions["thinkingLevel"];
    }
  }
  const resources = await createChatResources(cwd, AGENT_DIR, command.appendSystemPrompt);
  const { session } = await createAgentSession({ cwd, agentDir: AGENT_DIR, modelRuntime, ...resources, sessionManager: sm, model, thinkingLevel });
  try {
    await syncChatCwdContext(session, cwd);
  } catch (error) {
    session.dispose();
    throw error;
  }
  return session;
}

function snapshot(session: AgentSession): SessionSnapshot {
  return {
    model: session.model ? { provider: session.model.provider, id: session.model.id } : undefined,
    thinkingLevel: session.thinkingLevel, sessionFile: session.sessionFile,
    messageCount: session.messages.length, isStreaming: session.isStreaming,
  };
}

function gatewayEvent(event: AgentSessionEvent): GatewayAgentEvent | undefined {
  switch (event.type) {
    case "agent_start": case "message_start": return { type: event.type };
    case "message_update":
      if (event.assistantMessageEvent.type === "text_delta") return {
        type: "message_update", assistantMessageEvent: { type: "text_delta", delta: event.assistantMessageEvent.delta },
      };
      return undefined;
    case "message_end": {
      const message = event.message as { role: string; stopReason?: string; errorMessage?: string };
      return { type: "message_end", message: { role: message.role, stopReason: message.stopReason, errorMessage: message.errorMessage } };
    }
    case "tool_execution_start": return { type: event.type, toolName: event.toolName };
    case "tool_execution_end": return { type: event.type, toolName: event.toolName, isError: event.isError };
    case "agent_end": return { type: event.type, willRetry: event.willRetry };
    case "auto_retry_end": return { type: event.type, success: event.success, finalError: event.finalError };
    case "compaction_end": return { type: event.type, errorMessage: event.errorMessage };
    default: return undefined;
  }
}

const promptContext = new AsyncLocalStorage<() => boolean>();

function guardSessionPrompts(session: AgentSession) {
  const check = () => {
    if (promptContext.getStore()?.() === false) {
      session.clearQueue();
      throw new AgentOperationCancelled();
    }
  };
  // SDK preflightResult is observational; its started callback runs outside the cleanup boundary.
  const prompt = session.agent.prompt.bind(session.agent);
  session.agent.prompt = ((...args: Parameters<typeof prompt>) => {
    check();
    return prompt(...args);
  }) as typeof session.agent.prompt;
  const followUp = session.agent.followUp.bind(session.agent);
  session.agent.followUp = message => { check(); followUp(message); };
  const steer = session.agent.steer.bind(session.agent);
  session.agent.steer = message => { check(); steer(message); };
}

interface SessionEntry {
  generation: number;
  creation: Promise<AgentSession>;
  session?: AgentSession;
  operations: Set<Promise<unknown>>;
  abort?: Promise<void>;
  cancellation?: Promise<void>;
  disposal?: Promise<void>;
  thinkingPreference?: ThinkingLevel;
  disposed: boolean;
}

export function startAgentWorker(factory: (command: CreateSessionCommand) => Promise<AgentSession> = createChatSession) {
  observeWorkerChildren();
  const sessions = new Map<number, SessionEntry>();
  let shuttingDown = false;
  let shutdownPromise: Promise<void> | undefined;

  function abort(entry: SessionEntry): Promise<void> {
    if (!entry.session) return Promise.resolve();
    if (!entry.abort) {
      entry.session.clearQueue();
      const pending = Promise.resolve().then(() => entry.session!.abort());
      entry.abort = pending;
      void pending.finally(() => { if (entry.abort === pending) entry.abort = undefined; }).catch(() => {});
    }
    return entry.abort;
  }

  function dispose(entry: SessionEntry, reason: "new" | "quit" = "new"): Promise<void> {
    if (!entry.disposal) {
      entry.disposed = true;
      entry.generation++;
      entry.disposal = (async () => {
        const session = await entry.creation.catch(() => undefined);
        if (!session) return;
        try {
          await abort(entry);
          await Promise.allSettled([...entry.operations]);
          await session.extensionRunner.emit({ type: "session_shutdown", reason });
        } finally {
          session.dispose();
        }
      })();
    }
    return entry.disposal;
  }

  function shutdown(): Promise<void> {
    if (!shutdownPromise) {
      shuttingDown = true;
      shutdownPromise = Promise.all([...sessions.values()].map(entry => dispose(entry, "quit"))).then(() => { sessions.clear(); });
    }
    return shutdownPromise;
  }

  async function dispatch(command: WorkerCommand): Promise<{ state?: SessionSnapshot; result?: unknown }> {
    if (command.method === "shutdown") { await shutdown(); return {}; }
    if (shuttingDown) throw new AgentOperationCancelled();
    if (command.method === "create") {
      const entry: SessionEntry = {
        generation: 0, creation: Promise.resolve().then(() => factory(command)), operations: new Set(), disposed: false,
      };
      sessions.set(command.sessionId, entry);
      try {
        const session = await entry.creation;
        entry.session = session;
        entry.thinkingPreference = (command.storedThinking ?? command.thinking) as ThinkingLevel | undefined ?? session.thinkingLevel;
        guardSessionPrompts(session);
        session.subscribe(event => {
          const forwarded = gatewayEvent(event);
          if (forwarded) void send({ type: "event", sessionId: command.sessionId, event: forwarded, state: snapshot(session) }).catch(() => {});
        });
        if (entry.disposed || shuttingDown) throw new AgentOperationCancelled();
        return { state: snapshot(session) };
      } catch (error) {
        sessions.delete(command.sessionId);
        throw error;
      }
    }
    const entry = sessions.get(command.sessionId);
    if (!entry) throw new AgentOperationCancelled();
    if (command.method === "cancel") {
      entry.generation = Math.max(entry.generation, command.generation);
      const operations = [...entry.operations];
      const stopped = entry.session ? abort(entry) : entry.creation.then(() => abort(entry));
      entry.cancellation = Promise.all([stopped, Promise.allSettled(operations)]).then(() => {});
      void entry.cancellation.catch(error => log(`[agent] abort: ${String(error?.message ?? error)}`));
      return { state: entry.session ? snapshot(entry.session) : undefined };
    }
    if (command.method === "dispose") {
      await dispose(entry);
      sessions.delete(command.sessionId);
      return {};
    }
    const session = await entry.creation;
    if (entry.disposed || shuttingDown) throw new AgentOperationCancelled();
    if (command.method === "abort") {
      // A delayed acknowledgment must only drain cancelled work, not abort a newer run.
      await entry.cancellation;
      return { state: snapshot(session) };
    }
    const operation = (async () => {
      switch (command.method) {
        case "prompt": {
          const current = () => !shuttingDown && !entry.disposed && entry.generation === command.generation;
          if (!current()) throw new AgentOperationCancelled();
          await entry.abort;
          if (!current()) throw new AgentOperationCancelled();
          await promptContext.run(current, () => session.prompt(command.text, {
            images: command.images, streamingBehavior: command.streamingBehavior,
          }));
          return undefined;
        }
        case "setModel": {
          const r = resolveCliModel({ cliModel: command.model, modelRuntime: session.modelRuntime });
          if (r.error || !r.model) throw new Error(r.error ?? "Model not found");
          await session.setModel(r.model);
          entry.thinkingPreference = r.thinkingLevel ?? entry.thinkingPreference ?? session.thinkingLevel;
          session.setThinkingLevel(entry.thinkingPreference);
          return { thinkingLevel: entry.thinkingPreference };
        }
        case "cycleModel": {
          const result = await session.cycleModel();
          if (result) entry.thinkingPreference = session.thinkingLevel;
          return !!result;
        }
        case "setThinking":
          entry.thinkingPreference = command.thinking;
          session.setThinkingLevel(command.thinking);
          return undefined;
        case "cycleThinking": {
          const level = session.cycleThinkingLevel();
          if (level) entry.thinkingPreference = level;
          return level ?? null;
        }
      }
    })();
    entry.operations.add(operation);
    try { return { result: await operation, state: snapshot(session) }; }
    finally { entry.operations.delete(operation); }
  }

  process.on("message", (message: WorkerRequest) => {
    if (message.type === "ping") { void send({ type: "pong" }).catch(() => {}); return; }
    if (message.type !== "request") return;
    void dispatch(message.command).then(
      result => send({ type: "reply", id: message.id, ...result }),
      error => send({ type: "reply", id: message.id, error: { name: error?.name ?? "Error", message: String(error?.message ?? error) } }),
    ).then(() => {
      if (message.command.method === "shutdown") { process.disconnect?.(); process.exit(0); }
    }).catch(() => {});
  });
  const exit = () => {
    const timer = setTimeout(() => process.exit(1), 5000);
    void shutdown().then(() => { clearTimeout(timer); process.exit(0); }, () => process.exit(1));
  };
  process.once("disconnect", exit);
  process.once("SIGINT", exit);
  process.once("SIGTERM", exit);
  void send({ type: "ready" }).catch(exit);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (["1", "true", "yes", "on"].includes((process.env.PI_TELEGRAM_IPV4_ONLY ?? "").trim().toLowerCase())) dns.setDefaultResultOrder("ipv4first");
  startAgentWorker();
}
