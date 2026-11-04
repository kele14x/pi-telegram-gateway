import { execFile, fork, type ChildProcess } from "node:child_process";
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ImageContent } from "@earendil-works/pi-ai";
import {
  AgentOperationCancelled, AgentWorkerUnavailable,
  type CreateSessionCommand, type GatewayAgentEvent, type ModelSelection,
  type SessionSnapshot, type ThinkingLevel, type WorkerCommand, type WorkerMessage,
} from "./agent-protocol.ts";

const execFileAsync = promisify(execFile);
type Reply = Extract<WorkerMessage, { type: "reply" }>;

interface Connection {
  child: ChildProcess;
  journalDir: string;
  journalPath: string;
  ready: Promise<void>;
  resolveReady: () => void;
  rejectReady: (error: Error) => void;
  exited: Promise<void>;
  resolveExit: () => void;
  pending: Map<number, { resolve: (reply: Reply) => void; reject: (error: Error) => void; timer?: ReturnType<typeof setTimeout> }>;
  sessions: Map<number, AgentSessionHandle>;
  lastSeen: number;
  readyTimer?: ReturnType<typeof setTimeout>;
  heartbeat?: ReturnType<typeof setInterval>;
  failed: boolean;
}

interface AgentProcessOptions {
  workerPath?: string;
  env?: NodeJS.ProcessEnv;
  heartbeatMs?: number;
  stallTimeoutMs?: number;
  startupTimeoutMs?: number;
  requestTimeoutMs?: number;
  cancellationTimeoutMs?: number;
  onFailure?: (error: AgentWorkerUnavailable) => void;
  onLog?: (text: string) => void;
  onLifecycle?: (event: "model_fallback", fields: { chat: number; stored: string; error?: string; using: string }) => void;
}

export function agentEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result = { ...env };
  for (const key of Object.keys(result)) {
    if (key.startsWith("TELEGRAM_") || key === "ALLOWED_TELEGRAM_IDS" || key === "NODE_OPTIONS") delete result[key];
  }
  return result;
}

function activeJournalProcesses(journalPath: string): Map<number, { startedAt?: number; group?: number }> {
  const active = new Map<number, { startedAt?: number; group?: number }>();
  let contents: string;
  try { contents = readFileSync(journalPath, "utf8"); } catch { return active; }
  for (const line of contents.split("\n")) {
    try {
      const record = JSON.parse(line);
      if (!record || !Number.isSafeInteger(record.pid) || record.pid <= 1 || record.pid === process.pid) continue;
      if (record.type === "spawn") {
        active.set(record.pid, {
          startedAt: typeof record.startedAt === "number" && Number.isFinite(record.startedAt) ? record.startedAt : undefined,
          group: Number.isSafeInteger(record.group) && record.group > 1 ? record.group : undefined,
        });
      } else if (record.type === "exit") {
        active.delete(record.pid);
      }
    } catch { /* ignore incomplete or malformed records */ }
  }
  return active;
}

function removeProcessJournal(journalDir: string): void {
  try { rmSync(journalDir, { recursive: true, force: true }); } catch { /* best-effort cleanup, without retries */ }
}

async function terminateProcessTree(child: ChildProcess, journalPath: string): Promise<void> {
  const pid = child.pid;
  const workerIsLive = () => !!pid && child.exitCode === null && child.signalCode === null;
  if (process.platform === "win32") {
    if (workerIsLive()) {
      await execFileAsync("taskkill", ["/PID", String(pid), "/T", "/F"]).catch(() => child.kill("SIGKILL"));
    }
    return;
  }
  if (workerIsLive()) {
    try { child.kill("SIGSTOP"); } catch { /* already exited */ }
  }
  // The stopped worker cannot append new spawns while we snapshot its journal.
  const active = activeJournalProcesses(journalPath);
  const descendants = new Set<number>();
  const groups = new Set<number>();
  try {
    const { stdout } = await execFileAsync("ps", ["-axo", "pid=,ppid=,pgid=,lstart="], {
      env: { ...process.env, LC_ALL: "C" }, timeout: 1000, maxBuffer: 1024 * 1024,
    });
    const rows = new Map<number, { parent: number; group: number; startedAt: number }>();
    for (const line of stdout.split("\n")) {
      const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
      if (match) rows.set(Number(match[1]), { parent: Number(match[2]), group: Number(match[3]), startedAt: Date.parse(match[4]) });
    }
    if (pid && workerIsLive()) {
      descendants.add(pid);
      groups.add(pid);
    }
    for (const [id, ownership] of active) {
      const row = rows.get(id);
      if (!row || ownership.startedAt === undefined) continue;
      const sameProcess = ownership.group === undefined
        ? Math.abs(row.startedAt - ownership.startedAt) <= 2000
        : row.startedAt === ownership.startedAt;
      if (!sameProcess) continue;
      descendants.add(id);
      if (row.group === ownership.group || row.group === pid) groups.add(row.group);
    }
    let changed = true;
    while (changed) {
      changed = false;
      for (const [id, row] of rows) {
        if (id <= 1 || id === process.pid) continue;
        if ((descendants.has(row.parent) || groups.has(row.group)) && !descendants.has(id)) {
          descendants.add(id);
          changed = true;
        }
        if (descendants.has(id) && row.group === id && !groups.has(id)) {
          groups.add(id);
          changed = true;
        }
      }
    }
  } catch {
    // Without ps, only the still-owned worker PID/group can safely be signalled.
    if (pid && workerIsLive()) {
      descendants.add(pid);
      groups.add(pid);
    }
  }
  const pids = [...descendants].reverse();
  for (const id of groups) {
    try { process.kill(-id, "SIGKILL"); } catch { /* group already exited or absent */ }
  }
  for (const id of pids) {
    try { process.kill(id, "SIGKILL"); } catch { /* already exited */ }
  }
}

export class AgentProcess {
  private options: AgentProcessOptions;
  private connection?: Connection;
  private reaping: Promise<void> = Promise.resolve();
  private nextRequestId = 0;
  private nextSessionId = 0;
  private stopping = false;

  constructor(options: AgentProcessOptions = {}) {
    this.options = options;
  }

  async start(): Promise<Connection> {
    if (this.stopping) throw new AgentWorkerUnavailable("Agent worker is shutting down");
    for (;;) {
      const reaping = this.reaping;
      await reaping;
      if (this.stopping) throw new AgentWorkerUnavailable("Agent worker is shutting down");
      if (reaping === this.reaping) break;
    }
    const existing = this.connection;
    if (existing) {
      await existing.ready;
      if (existing.failed) throw new AgentWorkerUnavailable("Agent worker is no longer available");
      return existing;
    }
    const journalDir = mkdtempSync(join(tmpdir(), "pi-telegram-agent-"));
    const journalPath = join(journalDir, "pids.jsonl");
    let child: ChildProcess;
    try {
      const journalFd = openSync(journalPath, "a", 0o600);
      try {
        child = fork(this.options.workerPath ?? join(import.meta.dirname, "agent-worker.ts"), [], {
          env: agentEnvironment(this.options.env ?? process.env),
          execArgv: [],
          serialization: "advanced",
          detached: process.platform !== "win32",
          stdio: ["ignore", "pipe", "pipe", "ipc", journalFd],
        });
      } finally {
        try { closeSync(journalFd); } catch { /* already closed */ }
      }
    } catch (error) {
      removeProcessJournal(journalDir);
      throw error;
    }
    let resolveReady!: () => void;
    let rejectReady!: (error: Error) => void;
    let resolveExit!: () => void;
    const connection: Connection = {
      child, journalDir, journalPath, ready: new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; }),
      resolveReady: () => resolveReady(), rejectReady: error => rejectReady(error),
      exited: new Promise(resolve => { resolveExit = resolve; }), resolveExit: () => resolveExit(),
      pending: new Map(), sessions: new Map(), lastSeen: Date.now(), failed: false,
    };
    this.connection = connection;
    connection.readyTimer = setTimeout(() => this.fail(connection, "Agent worker did not start in time"), this.options.startupTimeoutMs ?? 30_000);
    child.on("message", message => this.receive(connection, message as WorkerMessage));
    child.on("error", () => this.fail(connection, "Agent worker could not be started"));
    child.on("disconnect", () => this.fail(connection, "Agent worker disconnected"));
    child.on("exit", (code, signal) => {
      connection.resolveExit();
      this.fail(connection, `Agent worker exited (${signal ?? code ?? "unknown"})`);
    });
    for (const output of [child.stdout, child.stderr]) {
      output?.on("data", (chunk: Buffer) => this.options.onLog?.(chunk.toString("utf8")));
    }
    await connection.ready;
    return connection;
  }

  private receive(connection: Connection, message: WorkerMessage) {
    if (connection.failed) return;
    switch (message.type) {
      case "ready":
        clearTimeout(connection.readyTimer);
        connection.lastSeen = Date.now();
        connection.heartbeat = setInterval(() => {
          if (Date.now() - connection.lastSeen > (this.options.stallTimeoutMs ?? 15_000)) {
            this.fail(connection, "Agent worker stopped responding");
          } else {
            this.send(connection, { type: "ping" });
          }
        }, this.options.heartbeatMs ?? 1000);
        connection.resolveReady();
        break;
      case "pong":
        connection.lastSeen = Date.now();
        break;
      case "reply": {
        const pending = connection.pending.get(message.id);
        if (!pending) return;
        connection.pending.delete(message.id);
        clearTimeout(pending.timer);
        if (message.error) {
          const error = message.error.name === "AgentOperationCancelled" ? new AgentOperationCancelled() : new Error(message.error.message);
          pending.reject(error);
        } else {
          pending.resolve(message);
        }
        break;
      }
      case "event":
        connection.sessions.get(message.sessionId)?.receive(message.state, message.event);
        break;
      case "log":
        this.options.onLog?.(message.text);
        break;
      case "lifecycle":
        this.options.onLifecycle?.(message.event, message.fields);
        break;
    }
  }

  private send(connection: Connection, message: object) {
    if (connection.failed || !connection.child.connected) {
      this.fail(connection, "Agent worker disconnected");
      return;
    }
    try {
      connection.child.send(message, error => { if (error) this.fail(connection, "Agent worker communication failed"); });
    } catch {
      this.fail(connection, "Agent worker communication failed");
    }
  }

  private fail(connection: Connection, message: string) {
    if (connection.failed) return;
    connection.failed = true;
    clearTimeout(connection.readyTimer);
    clearInterval(connection.heartbeat);
    if (this.connection === connection) this.connection = undefined;
    const error = new AgentWorkerUnavailable(message);
    connection.rejectReady(error);
    for (const pending of connection.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    connection.pending.clear();
    for (const session of connection.sessions.values()) session.fail(error);
    this.reaping = terminateProcessTree(connection.child, connection.journalPath)
      .then(() => connection.child.pid ? connection.exited : undefined)
      .finally(() => removeProcessJournal(connection.journalDir));
    if (!this.stopping) this.options.onFailure?.(error);
  }

  request(connection: Connection, command: WorkerCommand, timeoutMs = this.options.requestTimeoutMs ?? 30_000): Promise<Reply> {
    if (connection.failed) return Promise.reject(new AgentWorkerUnavailable("Agent worker is no longer available"));
    const id = ++this.nextRequestId;
    return new Promise((resolve, reject) => {
      const timer = timeoutMs > 0 ? setTimeout(() => this.fail(connection, "Agent worker operation timed out"), timeoutMs) : undefined;
      connection.pending.set(id, { resolve, reject, timer });
      this.send(connection, { type: "request", id, command });
    });
  }

  async createSession(command: Omit<CreateSessionCommand, "method" | "sessionId">, signal?: AbortSignal): Promise<AgentSessionHandle> {
    const connection = await this.start();
    if (signal?.aborted) throw new AgentOperationCancelled();
    const sessionId = ++this.nextSessionId;
    const session = new AgentSessionHandle(this, connection, sessionId, this.options.cancellationTimeoutMs ?? 5000);
    connection.sessions.set(sessionId, session);
    const cancel = () => session.clearQueue();
    signal?.addEventListener("abort", cancel, { once: true });
    try {
      const reply = await this.request(connection, { ...command, method: "create", sessionId }, 60_000);
      session.update(reply.state!);
      if (signal?.aborted) {
        await session.dispose();
        throw new AgentOperationCancelled();
      }
      return session;
    } catch (error) {
      connection.sessions.delete(sessionId);
      throw error;
    } finally {
      signal?.removeEventListener("abort", cancel);
    }
  }

  async stop(graceMs = 5000): Promise<void> {
    this.stopping = true;
    const connection = this.connection;
    if (connection && !connection.failed) {
      let timer!: ReturnType<typeof setTimeout>;
      const graceful = this.request(connection, { method: "shutdown" }, 0).catch(() => {});
      await Promise.race([graceful, new Promise<void>(resolve => { timer = setTimeout(resolve, graceMs); })]);
      clearTimeout(timer);
      this.fail(connection, "Agent worker shut down");
    }
    await this.reaping;
  }
}

export class AgentSessionHandle {
  private process: AgentProcess;
  private connection: Connection;
  private sessionId: number;
  private cancellationTimeoutMs: number;
  private snapshot: SessionSnapshot = { thinkingLevel: "off", messageCount: 0, isStreaming: false };
  private listeners = new Set<(event: GatewayAgentEvent) => void>();
  private generation = 0;
  private failure?: Error;
  private cancellation?: Promise<void>;
  private disposal?: Promise<void>;

  constructor(process: AgentProcess, connection: Connection, sessionId: number, cancellationTimeoutMs: number) {
    this.process = process;
    this.connection = connection;
    this.sessionId = sessionId;
    this.cancellationTimeoutMs = cancellationTimeoutMs;
  }

  get model(): ModelSelection | undefined { return this.snapshot.model; }
  get thinkingLevel(): ThinkingLevel { return this.snapshot.thinkingLevel; }
  get sessionFile(): string | undefined { return this.snapshot.sessionFile; }
  get messageCount(): number { return this.snapshot.messageCount; }
  get isStreaming(): boolean { return this.snapshot.isStreaming; }

  update(snapshot: SessionSnapshot) { this.snapshot = snapshot; }
  fail(error: Error) { this.failure = error; }

  receive(snapshot: SessionSnapshot, event: GatewayAgentEvent) {
    if (this.disposal || this.failure) return;
    this.update(snapshot);
    for (const listener of this.listeners) listener(event);
  }

  subscribe(listener: (event: GatewayAgentEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private async invoke(command: WorkerCommand, timeoutMs?: number): Promise<unknown> {
    if (this.failure) throw this.failure;
    const reply = await this.process.request(this.connection, command, timeoutMs);
    if (reply.state) this.update(reply.state);
    return reply.result;
  }

  async prompt(text: string, options: { images?: ImageContent[]; streamingBehavior?: "followUp"; preflightResult?: (accepted: string) => void } = {}): Promise<void> {
    options.preflightResult?.("started");
    // A new prompt needs its own stop even if older preflight work is still draining.
    this.cancellation = undefined;
    await this.invoke({ method: "prompt", sessionId: this.sessionId, generation: this.generation, text, images: options.images, streamingBehavior: options.streamingBehavior }, 0);
  }

  cancel(): Promise<void> {
    const acknowledged = this.invoke({ method: "cancel", sessionId: this.sessionId, generation: ++this.generation }, this.cancellationTimeoutMs).then(() => {});
    const completed = acknowledged.then(() => this.invoke({ method: "abort", sessionId: this.sessionId }, this.cancellationTimeoutMs)).then(() => {});
    this.cancellation = completed;
    void completed.finally(() => {
      if (this.cancellation === completed) this.cancellation = undefined;
    }).catch(() => {});
    return acknowledged;
  }

  clearQueue(): void {
    if (!this.failure && !this.disposal) void this.cancel().catch(() => {});
  }

  abort(): Promise<void> {
    if (!this.cancellation) this.cancel();
    return this.cancellation!;
  }

  dispose(): Promise<void> {
    if (!this.disposal) {
      this.disposal = this.failure ? Promise.resolve() : this.invoke({ method: "dispose", sessionId: this.sessionId }).then(() => {});
      void this.disposal.finally(() => {
        this.listeners.clear();
        this.connection.sessions.delete(this.sessionId);
      }).catch(() => {});
    }
    return this.disposal;
  }

  async setModel(model: string): Promise<{ thinkingLevel?: ThinkingLevel }> {
    return await this.invoke({ method: "setModel", sessionId: this.sessionId, model }) as { thinkingLevel?: ThinkingLevel };
  }

  async cycleModel(): Promise<boolean> {
    return await this.invoke({ method: "cycleModel", sessionId: this.sessionId }) as boolean;
  }

  async setThinkingLevel(thinking: ThinkingLevel): Promise<void> {
    await this.invoke({ method: "setThinking", sessionId: this.sessionId, thinking });
  }

  async cycleThinkingLevel(): Promise<ThinkingLevel | null> {
    return await this.invoke({ method: "cycleThinking", sessionId: this.sessionId }) as ThinkingLevel | null;
  }
}
