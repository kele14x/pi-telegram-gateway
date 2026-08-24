/**
 * pi ↔ Telegram chat gateway
 * --------------------------
 * Lets you talk to a pi coding agent from Telegram, the same way you'd chat
 * with pi in the terminal. Each Telegram chat gets its own persistent
 * AgentSession (history survives restarts). Replies stream into Telegram
 * as they are generated.
 *
 * Run:  npm start   (reads .env via --env-file-if-exists)
 * Test: npm run selftest   (creates a session and sends one prompt, no bot)
 */

import { mkdirSync, mkdtempSync, renameSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { stat } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import process from "node:process";
import dns from "node:dns";
import os from "node:os";
import { Agent as NodeHttpsAgent, get as httpsGet } from "node:https";
import type { LookupFunction } from "node:net";

// IPv4-only networking is opt-in via PI_TELEGRAM_IPV4_ONLY=true: on networks
// where IPv6 is broken (but DNS still returns AAAA records), node-fetch v2
// (telegraf) has no happy-eyeballs and can stall on the v6 attempt.
const IPV4_ONLY = ["1", "true", "yes", "on"].includes(
  (process.env.PI_TELEGRAM_IPV4_ONLY ?? "").trim().toLowerCase(),
);
const DROP_PENDING_UPDATES = ["1", "true", "yes", "on"].includes(
  (process.env.PI_TELEGRAM_DROP_PENDING_UPDATES ?? "").trim().toLowerCase(),
);
if (IPV4_ONLY) dns.setDefaultResultOrder("ipv4first");

// Telegraf bundles node-fetch v2, which does NOT do happy-eyeballs; when
// IPV4_ONLY is set, force IPv4 for its agent (used below).
const ipv4Lookup: LookupFunction = (hostname, options, callback) => {
  const opts = typeof options === "object" && options !== null ? options : {};
  dns.lookup(hostname, { ...opts, family: 4 }, (err, address, family) => {
    callback(err as NodeJS.ErrnoException | null, address, family);
  });
};
import { Telegraf } from "telegraf";
import { HttpsProxyAgent } from "https-proxy-agent";
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRuntime,
  resolveCliModel,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type AgentSessionEvent,
  type PromptOptions,
} from "@earendil-works/pi-coding-agent";
import type { ImageContent } from "@earendil-works/pi-ai";
import { createChatSettingsManager } from "./chat-settings.ts";
import { removeChatHistory } from "./history.ts";
import { acquireInstanceLock, type InstanceLock } from "./instance-lock.ts";
import { SessionErrorBuffer } from "./session-errors.ts";
import { TelegramStream } from "./telegram-stream.ts";

// ── Single-instance lock ────────────────────────────────────────────────────
// Prevents a duplicate gateway (e.g. Task Scheduler restart racing a manual
// start) from polling the same bot and stealing updates.
const LOCK_DIR = join(import.meta.dirname, "logs");
const LOCK_TARGET = join(LOCK_DIR, "gateway.instance");
const LOCK_FILE = join(LOCK_DIR, "gateway.lock");
const ENTRY_FILE = join(import.meta.dirname, "index.ts");
let instanceLock: InstanceLock | null = null;
function acquireLock(): boolean {
  instanceLock = acquireInstanceLock(LOCK_TARGET, LOCK_FILE, ENTRY_FILE);
  return instanceLock !== null;
}
function releaseLock() {
  try {
    instanceLock?.release();
    instanceLock = null;
  } catch {
    /* ignore */
  }
}

// ══════════════════════════════ Config ═══════════════════════════════════

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? "";

const ALLOWED_USER_IDS = new Set(
  (process.env.ALLOWED_TELEGRAM_IDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map(Number)
    .filter((n) => Number.isInteger(n)),
);

const DEFAULT_CWD = resolve(process.env.PI_TELEGRAM_CWD ?? process.cwd());
const AGENT_DIR = getAgentDir();
const SESSIONS_DIR = resolve(
  process.env.PI_TELEGRAM_SESSIONS_DIR ?? join(import.meta.dirname, "sessions"),
);
const MODEL_ARG = process.env.PI_TELEGRAM_MODEL?.trim() || undefined;
const THINKING_ARG = process.env.PI_TELEGRAM_THINKING?.trim() || undefined;
const APPEND_PROMPT = process.env.PI_TELEGRAM_APPEND_PROMPT?.trim() || undefined;

const PROXY_URL =
  process.env.TELEGRAM_PROXY?.trim() || process.env.HTTPS_PROXY?.trim() || process.env.HTTP_PROXY?.trim() || undefined;

const CHAT_HINT = [
  "You are pi, a coding agent, connected to the user through a Telegram chat gateway.",
  "You have your normal coding-agent capabilities (read/write files, shell, etc.) in the chat's working folder.",
  "The user talks to you in a chat; they may also send photos.",
  "Respond conversationally: keep replies focused and reasonably short, summarize large outputs instead of dumping raw content, and use Markdown (``` fences) for code snippets.",
];

// Per-chat state persisted across restarts (currently just the working folder).
const META_FILE = join(SESSIONS_DIR, "meta.json");
const chatMeta = new Map<number, string>();
function loadChatMeta() {
  // Remove a stale temp file left by a crash mid-save (the next save
  // overwrites it anyway, but keep the directory tidy).
  try {
    rmSync(`${META_FILE}.tmp`, { force: true });
  } catch {
    /* ignore */
  }
  let raw: string;
  try {
    raw = readFileSync(META_FILE, "utf8");
  } catch {
    return; // no meta file yet
  }
  try {
    const data = JSON.parse(raw) as Record<string, { cwd?: string }>;
    for (const [k, v] of Object.entries(data)) {
      const id = Number(k);
      if (Number.isFinite(id) && typeof v?.cwd === "string") chatMeta.set(id, v.cwd);
    }
  } catch (err) {
    // Don't silently drop every chat's cwd on a corrupt file — surface it.
    log(`[meta] ignoring unreadable ${META_FILE}: ${String((err as Error)?.message ?? err)}`);
  }
}
function saveChatMeta(chatId: number, cwd: string): boolean {
  chatMeta.set(chatId, cwd);
  try {
    mkdirSync(SESSIONS_DIR, { recursive: true });
    // Write to a temp file and rename so a crash mid-write can never leave
    // meta.json truncated/invalid (which would reset every chat's cwd to default).
    const tmp = `${META_FILE}.tmp`;
    writeFileSync(tmp, JSON.stringify(Object.fromEntries(chatMeta), null, 2));
    renameSync(tmp, META_FILE);
    return true;
  } catch (err) {
    log(`[meta] save failed: ${String((err as Error)?.message ?? err)}`);
    return false;
  }
}


// ═══════════════════════════ Chat session hub ═════════════════════════════

interface ChatState {
  chatId: number;
  /** Per-chat working folder. */
  cwd: string;
  session: AgentSession | null;
  stream: TelegramStream | null;
  /** Serializes prompt and queued command submission per chat. */
  chain: Promise<void>;
  /** Bumped by lifecycle/cancellation commands to invalidate old jobs. */
  generation: number;
  /** Aborts asynchronous preflight work owned by the current generation. */
  generationController: AbortController;
  /** In-flight session creation — dedupes concurrent getChatSession() calls. */
  sessionInit: Promise<AgentSession | undefined> | null;
  /** Session replacement in progress; new jobs wait for it before creating a session. */
  sessionReset: Promise<void> | null;
  /** Jobs currently executing; queued jobs are not included until they start. */
  running: Set<Promise<void>>;
  /** Prompt jobs reserved in the chain (drives the immediate "queued" ack). */
  busy: number;
}

class ChatOperationCancelled extends Error {
  constructor() {
    super("Chat operation was superseded");
    this.name = "ChatOperationCancelled";
  }
}

const chats = new Map<number, ChatState>();

function assertValidConfig() {
  const problems: string[] = [];
  if (!BOT_TOKEN) problems.push("TELEGRAM_BOT_TOKEN is not set (see .env / .env.example)");
  if (problems.length) {
    for (const p of problems) console.error(`✖ ${p}`);
    throw new Error("Configuration error");
  }
  if (ALLOWED_USER_IDS.size === 0) {
    console.warn("⚠ ALLOWED_TELEGRAM_IDS is not set — the bot will refuse everyone until configured.");
    console.warn("  Send /start to your bot; the gateway logs your numeric id, then add it to .env and restart.");
  }
}

function expandHome(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/") || p.startsWith(`~${sep}`)) return join(os.homedir(), p.slice(2));
  return p;
}

async function createChatSession(chatId: number, cwd: string, sessionsDir = SESSIONS_DIR): Promise<AgentSession> {
  const sessionFile = join(sessionsDir, `chat-${chatId}.jsonl`);
  // cwdOverride keeps tools working in the chat's current folder even though
  // the session file header may record an older cwd.
  const sm = SessionManager.open(sessionFile, sessionsDir, cwd);

  type SessionOptions = NonNullable<Parameters<typeof createAgentSession>[0]>;
  let model: SessionOptions["model"];
  let thinkingLevel: SessionOptions["thinkingLevel"];
  if (MODEL_ARG) {
    const r = resolveCliModel({ cliModel: MODEL_ARG, modelRuntime });
    if (r.error) throw new Error(`Bad PI_TELEGRAM_MODEL: ${r.error}`);
    model = r.model;
    thinkingLevel = (r.thinkingLevel ?? THINKING_ARG) as SessionOptions["thinkingLevel"];
  } else {
    thinkingLevel = THINKING_ARG as SessionOptions["thinkingLevel"];
  }

  const { session } = await createAgentSession({
    cwd,
    agentDir: AGENT_DIR,
    modelRuntime,
    // A chat may change its model/thinking level without rewriting the
    // owner's global pi settings or affecting another Telegram chat.
    settingsManager: createChatSettingsManager(settingsManager),
    resourceLoader: loader,
    sessionManager: sm,
    model,
    thinkingLevel,
  });
  return session;
}

function wireSession(chatId: number, session: AgentSession, stream: TelegramStream) {
  const errors = new SessionErrorBuffer();
  session.subscribe((event: AgentSessionEvent) => {
    switch (event.type) {
      case "agent_start": {
        errors.beginAttempt();
        stream.reset();
        stream.setStatus("⏳ thinking…");
        break;
      }
      case "message_start": {
        if (!stream.hasText()) stream.setStatus("⏳ thinking…");
        break;
      }
      case "message_update": {
        const e = event.assistantMessageEvent;
        if (e.type === "text_delta") stream.append(e.delta);
        break;
      }
      case "message_end": {
        errors.capture(event.message);
        if ((event.message as { stopReason?: string }).stopReason === "aborted") {
          stream.setStatus("🛑 aborted");
        }
        break;
      }
      case "tool_execution_start": {
        stream.setStatus(`🔧 ${event.toolName}…`);
        break;
      }
      case "tool_execution_end": {
        stream.setStatus(`✅ ${event.toolName}${event.isError ? " ❌" : ""}`);
        break;
      }
      case "agent_end": {
        const terminalError = errors.finishAttempt(event.willRetry);
        if (!event.willRetry) {
          if (terminalError) stream.append(`\n\n⚠️ ${terminalError}`);
          void stream.finalize().catch(async (err) => {
            log(`[chat ${chatId}] final response delivery failed: ${String((err as Error)?.message ?? err)}`);
            await safeSend(chatId, "⚠️ The final response could not be delivered after several retries.");
          });
        }
        else stream.setStatus("⏳ retrying…");
        break;
      }
      case "auto_retry_end": {
        // If /stop cancels the SDK during its retry backoff, there is no later
        // agent_end event. Finalize the status-only stream in that narrow case.
        if (!event.success && event.finalError === "Retry cancelled") {
          stream.setStatus("🛑 aborted");
          void stream.finalize().catch((err) => {
            log(`[chat ${chatId}] aborted response delivery failed: ${String((err as Error)?.message ?? err)}`);
          });
        }
        break;
      }
      case "compaction_end": {
        if (event.errorMessage) void safeSend(chatId, `⚠️ compaction: ${event.errorMessage}`);
        break;
      }
    }
  });
}

function ensureChat(chatId: number): ChatState {
  let st = chats.get(chatId);
  if (!st) {
    st = {
      chatId,
      cwd: chatMeta.get(chatId) ?? DEFAULT_CWD,
      session: null,
      stream: null,
      chain: Promise.resolve(),
      generation: 0,
      generationController: new AbortController(),
      sessionInit: null,
      sessionReset: null,
      running: new Set(),
      busy: 0,
    };
    chats.set(chatId, st);
  }
  return st;
}

function isCurrentChat(st: ChatState, generation: number): boolean {
  return chats.get(st.chatId) === st && st.generation === generation;
}

function advanceChatGeneration(st: ChatState) {
  st.generationController.abort();
  st.generation++;
  st.generationController = new AbortController();
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new ChatOperationCancelled());
  return new Promise<T>((resolvePromise, rejectPromise) => {
    const cancel = () => rejectPromise(new ChatOperationCancelled());
    signal.addEventListener("abort", cancel, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", cancel);
        resolvePromise(value);
      },
      (err) => {
        signal.removeEventListener("abort", cancel);
        rejectPromise(err);
      },
    );
  });
}

async function getChatSession(
  chatId: number,
  expectedState?: ChatState,
  expectedGeneration?: number,
): Promise<AgentSession> {
  const st = expectedState ?? ensureChat(chatId);
  const generation = expectedGeneration ?? st.generation;
  for (;;) {
    if (!isCurrentChat(st, generation)) throw new ChatOperationCancelled();
    if (st.sessionReset) {
      await st.sessionReset;
      continue;
    }
    if (st.session) return st.session;
    if (!st.sessionInit) {
      // Capture the state this creation belongs to; if /new or /cd supersede
      // it while the session is being built, discard the result instead of
      // wiring a stale cwd into the live chat state.
      const initGeneration = st.generation;
      const cwdAtCreate = st.cwd;
      st.sessionInit = createChatSession(chatId, cwdAtCreate)
        .then((session) => {
          if (!isCurrentChat(st, initGeneration) || st.cwd !== cwdAtCreate) {
            log(`[chat ${chatId}] discarding superseded session (raced with /new or /cd)`);
            session.dispose();
            return undefined;
          }
          st.session = session;
          st.stream = new TelegramStream(bot, chatId, log);
          wireSession(chatId, session, st.stream);
          const m = session.model;
          log(
            `[chat ${chatId}] session ready — model: ${m ? `${m.provider}/${m.id}` : "default"}, cwd: ${st.cwd}, file: ${session.sessionFile}`,
          );
          return session;
        })
        .finally(() => {
          st.sessionInit = null;
        });
    }
    const next = await st.sessionInit;
    if (next) {
      if (!isCurrentChat(st, generation)) {
        await next.abort().catch(() => {});
        next.dispose();
        throw new ChatOperationCancelled();
      }
      return next;
    }
    // Creation was superseded. The expected-generation check at the top either
    // drops this caller or allows an unscoped caller to retry the new state.
  }
}

/** Replace the active session without letting new jobs create one midway. */
function replaceChatSession(st: ChatState, removeHistory: boolean): Promise<void> {
  const oldSession = st.session;
  const oldStream = st.stream;
  const oldInit = st.sessionInit;
  const activeJobs = [...st.running];
  st.session = null;
  st.stream = null;
  oldStream?.cancel();

  const previousReset = st.sessionReset ?? Promise.resolve();
  const reset = previousReset.catch(() => {}).then(async () => {
    // A generation change makes an in-flight initialization self-discard, but
    // wait for it before deleting/reopening the history file.
    await oldInit?.catch(() => {});
    if (oldSession) {
      oldSession.clearQueue();
      await oldSession.abort().catch(() => {});
    }
    // Wait only for jobs that were already executing. Queued jobs are not
    // awaited here: their generation check will drop old jobs, while new jobs
    // wait on sessionReset. Awaiting the entire chain would deadlock those new
    // jobs against this reset.
    await Promise.all(activeJobs.map((job) => job.catch(() => {})));
    if (oldSession) {
      try {
        oldSession.dispose();
      } catch (err) {
        log(`[session] dispose: ${String((err as Error)?.message ?? err)}`);
      }
    }
    if (removeHistory) {
      removeChatHistory(SESSIONS_DIR, st.chatId);
    }
  });
  const result = reset.catch((err) => {
    log(`[session] replacement failed: ${String((err as Error)?.message ?? err)}`);
    throw err;
  });
  // The gate must always settle successfully so later prompts can reopen the
  // retained history. The returned result still rejects for truthful command UI.
  const gate = result.catch(() => {});
  st.sessionReset = gate;
  void gate.then(() => {
    if (st.sessionReset === gate) st.sessionReset = null;
  });
  return result;
}

/** Enqueue a job and track only the job currently executing. */
function enqueueChatJob(st: ChatState, fn: () => Promise<void>): Promise<void> {
  let resolveDone!: () => void;
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });
  const task = st.chain.then(async () => {
    st.running.add(done);
    try {
      await fn();
    } finally {
      st.running.delete(done);
      resolveDone();
    }
  });
  st.chain = task.catch(() => {});
  return task;
}

/** Dispatch a prompt to the per-chat queue. Never awaits the agent run — the
 * caller returns immediately so Telegram polling stays responsive. */
function submitPrompt(
  chatId: number,
  text: string,
  images?: ImageContent[] | Promise<ImageContent[]>,
  expectedState?: ChatState,
  expectedGeneration?: number,
) {
  const st = expectedState ?? ensureChat(chatId);
  const gen = expectedGeneration ?? st.generation;
  if (!isCurrentChat(st, gen)) return;
  const signal = st.generationController.signal;
  // Attach the rejection handler now: a queued photo download may fail before
  // its chain job starts, and must never become an unhandled rejection.
  const imageLoad = Promise.resolve(images ?? []).then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  if (st.busy > 0) {
    // Immediate acknowledgment so the user knows their message is queued.
    void safeSend(chatId, `📥 Queued (after current task): “${text.slice(0, 60)}…”`);
  }
  // Reserve the chain position synchronously. In particular, a photo keeps
  // its arrival order while Telegram file download happens in the background.
  st.busy++;
  enqueueChatJob(st, async () => {
    try {
      // Cancelled while still queued (e.g. /stop, /new, or /cd landed meanwhile).
      if (!isCurrentChat(st, gen)) {
        log(`[chat ${chatId}] dropped queued message after cancellation`);
        return;
      }
      const loaded = await abortable(imageLoad, signal);
      if (!loaded.ok) {
        const msg = loaded.error instanceof Error ? loaded.error.message : String(loaded.error);
        log(`[chat ${chatId}] photo preparation failed: ${msg}`);
        if (isCurrentChat(st, gen)) await safeSend(chatId, `⚠️ Couldn't process the photo: ${msg}`);
        return;
      }
      if (!isCurrentChat(st, gen)) return;
      let session: AgentSession;
      try {
        session = await getChatSession(chatId, st, gen);
      } catch (err) {
        if (err instanceof ChatOperationCancelled) {
          log(`[chat ${chatId}] dropped queued message after cancellation`);
          return;
        }
        // Session creation failures (corrupt history, bad config, …) must reach
        // the user instead of vanishing into bot.catch().
        const msg = err instanceof Error ? err.message : String(err);
        log(`[chat ${chatId}] session creation failed: ${msg}`);
        await safeSend(chatId, `⚠️ ${msg}`);
        return;
      }
      // /stop, /new, or /cd may have landed while the session was being created.
      if (!isCurrentChat(st, gen)) {
        await session.abort().catch(() => {});
        return;
      }
      try {
        const options: PromptOptions = {
          images: loaded.value,
          preflightResult: (accepted) => {
            // The SDK invokes this synchronously after async prompt preflight
            // and immediately before starting the agent. Throwing here closes
            // the last cancellation gap for /stop, /new, and /cd.
            if (accepted && !isCurrentChat(st, gen)) throw new ChatOperationCancelled();
          },
        };
        if (session.isStreaming) options.streamingBehavior = "followUp";
        await session.prompt(text, options);
        // A cancellation may have raced with prompt preflight/queueing.
        if (!isCurrentChat(st, gen)) session.clearQueue();
      } catch (err) {
        if (err instanceof ChatOperationCancelled) {
          session.clearQueue();
          log(`[chat ${chatId}] dropped prompt during cancellation preflight`);
          return;
        }
        const msg = err instanceof Error ? err.message : String(err);
        log(`[chat ${chatId}] prompt error: ${msg}`);
        await safeSend(chatId, `⚠️ ${msg}`);
      }
    } finally {
      st.busy--;
    }
  }).catch((err) => {
    if (err instanceof ChatOperationCancelled) return;
    log(`[chat ${chatId}] queued prompt failed: ${String((err as Error)?.message ?? err)}`);
  });
}

/**
 * Enqueue a non-prompt operation (e.g. /model, /thinking) behind the chat's
 * prompt chain. Stale operations are dropped after /stop, /new, or /cd.
 */
function enqueueChatOp(
  chatId: number,
  fn: (st: ChatState, generation: number) => Promise<void>,
): Promise<void> {
  const st = ensureChat(chatId);
  const generation = st.generation;
  return enqueueChatJob(st, async () => {
    if (!isCurrentChat(st, generation)) return;
    await fn(st, generation);
  });
}

async function safeSend(chatId: number, text: string) {
  try {
    await bot.telegram.sendMessage(chatId, text.slice(0, 4096));
  } catch (err) {
    log(`[send] ${String((err as Error)?.message ?? err)}`);
  }
}

// Retry a Telegram API call a few times with backoff: on flaky proxies a
// single dropped TLS connection (ECONNRESET/socket-disconnect) must not kill
// startup or break command sync.
async function withRetry<T>(
  fn: () => Promise<T>,
  attempts = 4,
  baseDelayMs = 1000,
): Promise<T> {
  let lastErr: unknown;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i === attempts) break;
      log(`[retry] ${i}/${attempts} failed (${String((err as Error)?.message ?? err)}), retrying in ${baseDelayMs}ms`);
      await new Promise((r) => setTimeout(r, baseDelayMs));
    }
  }
  throw lastErr;
}

// ═════════════════════════════ Telegram bot ═══════════════════════════════

// All agent work is dispatched in the background. Keep a finite ceiling so a
// future accidentally-blocking handler cannot stall Telegraf's update batch
// until the Telegram client request itself times out.
const botOptions: NonNullable<ConstructorParameters<typeof Telegraf>[1]> = {
  handlerTimeout: 60_000,
};
const telegramAgent = PROXY_URL
  ? new HttpsProxyAgent(PROXY_URL, IPV4_ONLY ? { lookup: ipv4Lookup } : undefined)
  : IPV4_ONLY
    ? new NodeHttpsAgent({ lookup: ipv4Lookup })
    : undefined;
if (telegramAgent) botOptions.telegram = { agent: telegramAgent };

const bot = new Telegraf(BOT_TOKEN, botOptions);

/** Access guard: only explicitly allowlisted users may talk to the agent. */
bot.use(async (ctx, next) => {
  const fromId = ctx.from?.id ?? -1;
  const chatId = ctx.chat?.id ?? -1;
  if (ALLOWED_USER_IDS.has(fromId)) return next();
  log(`blocked message from ${ctx.from?.username ?? fromId} (chat ${chatId})`);
  if (ctx.message || ctx.callbackQuery) {
    await ctx
      .reply(`⛔ This bot is private.\n\nYour Telegram id is ${fromId}. Add it to ALLOWED_TELEGRAM_IDS in the gateway's .env and restart.`)
      .catch(() => {});
  }
});

bot.command("start", async (ctx) => {
  await ctx.reply(
    "👋 I'm a gateway to your pi coding agent. Send me a message (or a photo) and I'll have pi work on it.\n\n" +
      "Commands:\n" +
      "/new — start a fresh conversation (clears history)\n" +
      "/cd <folder> — switch this chat's working folder\n" +
      "/sessions — session info for this chat\n" +
      "/model [name] — show / switch model (e.g. /model anthropic/claude-opus-4-5:high)\n" +
      "/thinking [level] — show / set thinking level (off…max)\n" +
      "/stop — abort the current run and drop queued messages\n" +
      "/status — session info\n" +
      "/cwd — show the current working folder\n" +
      "/help — this message",
  );
});

bot.command("help", async (ctx) => {
  await ctx.reply(
    "Just chat: send text or photos. The agent keeps a persistent conversation per chat.\n\n" +
      "/new — fresh conversation (keeps the working folder)\n" +
      "/cd <folder> — switch this chat's working folder (absolute or relative, ~ supported)\n" +
      "/sessions — session info for this chat\n" +
      "/model [name] — show or switch model\n" +
      "/thinking [level] — show or set thinking level (off/minimal/low/medium/high/xhigh/max)\n" +
      "/stop — abort the current run and drop queued messages\n" +
      "/status — session info\n" +
      "/cwd — show the current working folder\n" +
      "/help — this message",
  );
});

bot.command("new", async (ctx) => {
  const chatId = ctx.chat.id;
  const st = chats.get(chatId);
  if (st) {
    // Invalidate old jobs synchronously, then replace the session in the
    // background. New jobs on this state wait for sessionReset to finish.
    advanceChatGeneration(st);
    st.session?.clearQueue();
    void replaceChatSession(st, true).then(
      () => ctx.reply("🧹 Fresh session started (working folder kept). Send me anything to begin.").catch(() => {}),
      (err) => {
        // Drop messages submitted after /new but before its failed deletion was
        // discovered; they must not silently resume the retained history.
        advanceChatGeneration(st);
        st.session?.clearQueue();
        log(`[new] history removal failed: ${String((err as Error)?.message ?? err)}`);
        return ctx.reply("⚠️ Couldn't clear the saved conversation. Its history was kept; please check the gateway log and try again.").catch(() => {});
      },
    );
  } else {
    // After a restart there is no ChatState, but the persisted history still
    // needs to be removed.
    try {
      removeChatHistory(SESSIONS_DIR, chatId);
    } catch (err) {
      log(`[new] history removal failed: ${String((err as Error)?.message ?? err)}`);
      await ctx.reply("⚠️ Couldn't clear the saved conversation. Its history was kept; please check the gateway log and try again.").catch(() => {});
      return;
    }
    await ctx.reply("🧹 Fresh session started (working folder kept). Send me anything to begin.");
  }
});

bot.command("model", async (ctx) => {
  const arg = ctx.payload.trim();
  // Serialized behind the prompt chain. Dispatch without awaiting so a
  // command waiting behind a long run cannot block Telegram polling.
  void enqueueChatOp(ctx.chat.id, async (st, generation) => {
    try {
      const session = await getChatSession(ctx.chat.id, st, generation);
      if (!isCurrentChat(st, generation)) return;
      if (!arg) {
        const m = session.model;
        await ctx.reply(
          `Model: ${m ? `${m.provider}/${m.id}` : "(default)"}\nThinking: ${session.thinkingLevel}\n\n` +
            "Switch with /model <name>, e.g. /model openai/gpt-5:medium",
        );
        return;
      }
      if (arg === "cycle") {
        const r = await session.cycleModel();
        const m = session.model;
        await ctx.reply(`🔄 ${r ? "Cycled" : "No models to cycle through"} — now: ${m ? `${m.provider}/${m.id}` : "?"}`);
        return;
      }
      const r = resolveCliModel({ cliModel: arg, modelRuntime });
      if (r.error || !r.model) {
        await ctx.reply(`⚠️ ${r.error ?? "Model not found"}`);
        return;
      }
      if (!isCurrentChat(st, generation)) return;
      await session.setModel(r.model);
      if (r.thinkingLevel) await session.setThinkingLevel(r.thinkingLevel);
      if (isCurrentChat(st, generation)) await ctx.reply(`✓ Model set to ${r.model.provider}/${r.model.id}`);
    } catch (err) {
      if (err instanceof ChatOperationCancelled) return;
      await ctx.reply(`⚠️ ${err instanceof Error ? err.message : String(err)}`).catch(() => {});
    }
  });
});

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

bot.command("thinking", async (ctx) => {
  const arg = ctx.payload.trim().toLowerCase();
  // Serialized behind the prompt chain, same as /model. Dispatch without
  // awaiting so Telegram polling stays responsive.
  void enqueueChatOp(ctx.chat.id, async (st, generation) => {
    try {
      const session = await getChatSession(ctx.chat.id, st, generation);
      if (!isCurrentChat(st, generation)) return;
      if (!arg) {
        await ctx.reply(`Thinking: ${session.thinkingLevel}\nSet with /thinking ${THINKING_LEVELS.join(" / ")} or /thinking cycle`);
        return;
      }
      if (arg === "cycle") {
        const level = session.cycleThinkingLevel();
        await ctx.reply(`🔄 thinking level: ${level}`);
        return;
      }
      if (!(THINKING_LEVELS as readonly string[]).includes(arg)) {
        await ctx.reply(`Valid levels: ${THINKING_LEVELS.join(", ")}`);
        return;
      }
      if (!isCurrentChat(st, generation)) return;
      session.setThinkingLevel(arg as (typeof THINKING_LEVELS)[number]);
      if (isCurrentChat(st, generation)) await ctx.reply(`✓ thinking level: ${arg}`);
    } catch (err) {
      if (err instanceof ChatOperationCancelled) return;
      await ctx.reply(`⚠️ ${err instanceof Error ? err.message : String(err)}`).catch(() => {});
    }
  });
});

bot.command("stop", async (ctx) => {
  const st = chats.get(ctx.chat.id);
  if (!st || (st.busy === 0 && !st.session?.isStreaming)) {
    await ctx.reply("Nothing is running.");
    return;
  }
  // Cancel-all semantics: bump the generation so queued st.chain submissions
  // are dropped too (the SDK queue is cleared separately — it would otherwise
  // drain via continue() after the abort).
  advanceChatGeneration(st);
  const session = st.session;
  session?.clearQueue();
  // Abort is deliberately not awaited: the update handler must return so
  // polling remains responsive while the provider winds down.
  if (session) void session.abort().catch((err) => log(`[stop] abort: ${String((err as Error)?.message ?? err)}`));
  await ctx.reply("🛑 Aborted the current run and dropped queued messages.");
});

bot.command("status", async (ctx) => {
  const st = ensureChat(ctx.chat.id);
  if (!st.session) {
    await ctx.reply(`No session yet — send a message to start one.\nWorking folder: ${st.cwd}`);
    return;
  }
  const s = st.session;
  await ctx.reply(
    `Status: ${s.isStreaming ? "🟢 working" : "⚪ idle"}\n` +
      `Model: ${s.model ? `${s.model.provider}/${s.model.id}` : "(default)"}\n` +
      `Thinking: ${s.thinkingLevel}\n` +
      `Messages in context: ${s.messages.length}\n` +
      `Session file: ${s.sessionFile ?? "(none)"}\n` +
      `Working folder: ${st.cwd}`,
  );
});

bot.command("cwd", async (ctx) => {
  const st = ensureChat(ctx.chat.id);
  await ctx.reply(`📁 ${st.cwd}\n\nChange it with /cd <folder> (use /sessions for session details).`);
});

bot.command("cd", async (ctx) => {
  const raw = ctx.payload.trim();
  const st = ensureChat(ctx.chat.id);
  if (!raw) {
    await ctx.reply(`📁 Current: ${st.cwd}\n\nUsage: /cd <path> — absolute, relative to the current folder, or ~ based.`);
    return;
  }
  if (st.session?.isStreaming) {
    await ctx.reply("⏳ The agent is busy — /stop it first, then /cd.").catch(() => {});
    return;
  }
  const target = resolve(st.cwd, expandHome(raw));
  try {
    if (!(await stat(target)).isDirectory()) throw new Error("not a directory");
  } catch {
    await ctx.reply(`⚠️ No such directory: ${target}`).catch(() => {});
    return;
  }
  st.cwd = target;
  const persisted = saveChatMeta(ctx.chat.id, target);
  // Invalidate queued submissions and any in-flight session creation, so
  // nothing from the old folder runs after the switch.
  advanceChatGeneration(st);
  st.session?.clearQueue();
  void replaceChatSession(st, false);
  log(`[chat ${ctx.chat.id}] cwd -> ${target}`);
  await ctx.reply(
    `📁 Working folder set to:\n${target}\n\nConversation history is kept — your next message continues in this folder.` +
      (persisted ? "" : "\n\n⚠️ Couldn't save this folder to meta.json — it will revert after a restart."),
  );
});

bot.command("sessions", async (ctx) => {
  const st = ensureChat(ctx.chat.id);
  if (!st.session) {
    await ctx.reply(`No active session yet — send a message to start one.\nWorking folder: ${st.cwd}`);
    return;
  }
  const s = st.session;
  const file = s.sessionFile ?? "(none)";
  let size = "?";
  try {
    size = `${(await stat(file)).size} bytes`;
  } catch {
    /* ignore */
  }
  await ctx.reply(
    `🗂 Session for this chat\n` +
      `File: ${file}\n` +
      `Size: ${size}\n` +
      `Messages in context: ${s.messages.length}\n` +
      `Model: ${s.model ? `${s.model.provider}/${s.model.id}` : "(default)"}\n` +
      `Thinking: ${s.thinkingLevel}\n` +
      `Working folder: ${st.cwd}\n\n` +
      `Use /new for a fresh conversation (same folder), /cd <folder> to change folder.`,
  );
});

const KNOWN_COMMANDS = new Set(["start", "help", "new", "cd", "sessions", "model", "thinking", "stop", "status", "cwd"]);

/** Shown in the Telegram command menu ("/" button); synced at startup. */
const BOT_COMMANDS = [
  { command: "start", description: "Welcome message and quick guide" },
  { command: "help", description: "Show available commands" },
  { command: "new", description: "Start a fresh conversation (keeps working folder)" },
  { command: "cd", description: "Change this chat’s working folder, e.g. /cd ~/Desktop" },
  { command: "cwd", description: "Show the current working folder" },
  { command: "sessions", description: "Show session details for this chat" },
  { command: "model", description: "Show or switch model, e.g. /model anthropic/claude-opus-4-5:high" },
  { command: "thinking", description: "Show or set thinking level (off…max)" },
  { command: "status", description: "Show model, context size, working folder" },
  { command: "stop", description: "Abort the current run and drop queued messages" },
];

bot.on("text", async (ctx) => {
  const text = ctx.message.text;
  if (!text.trim()) return;
  // Telegram-style bot commands that we don't handle should never reach the agent.
  if (text.startsWith("/")) {
    const name = text.slice(1).split(/[\s@]/)[0];
    if (name && !KNOWN_COMMANDS.has(name)) {
      await ctx.reply("🤷 Unknown command. Send /help for the list.").catch(() => {});
    }
    return;
  }
  // Non-blocking by design: submitPrompt dispatches into the per-chat chain
  // and returns immediately, so Telegram polling stays responsive (/stop,
  // other chats and commands are not held up by a long agent run).
  submitPrompt(ctx.chat.id, text);
});

const MAX_PHOTO_BYTES = 20 * 1024 * 1024;

function downloadTelegramFile(
  url: string,
  signal: AbortSignal,
  redirectsRemaining = 3,
): Promise<{ data: Buffer; contentType?: string }> {
  return new Promise((resolveDownload, rejectDownload) => {
    let settled = false;
    const fail = (err: unknown) => {
      if (settled) return;
      settled = true;
      rejectDownload(err);
    };
    const request = httpsGet(url, { agent: telegramAgent, signal }, (response) => {
      const status = response.statusCode ?? 0;
      if (status >= 300 && status < 400 && response.headers.location) {
        response.resume();
        if (redirectsRemaining <= 0) {
          fail(new Error("too many redirects while downloading photo"));
          return;
        }
        const redirected = new URL(response.headers.location, url).href;
        void downloadTelegramFile(redirected, signal, redirectsRemaining - 1).then(
          (value) => {
            if (settled) return;
            settled = true;
            resolveDownload(value);
          },
          fail,
        );
        return;
      }
      if (status < 200 || status >= 300) {
        response.resume();
        fail(new Error(`download failed: ${status}`));
        return;
      }
      const declaredSize = Number(response.headers["content-length"] ?? 0);
      if (Number.isFinite(declaredSize) && declaredSize > MAX_PHOTO_BYTES) {
        response.resume();
        fail(new Error("photo is larger than 20 MiB"));
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      response.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_PHOTO_BYTES) {
          request.destroy(new Error("photo is larger than 20 MiB"));
          return;
        }
        chunks.push(chunk);
      });
      response.on("error", fail);
      response.on("end", () => {
        if (settled) return;
        settled = true;
        const header = response.headers["content-type"];
        resolveDownload({
          data: Buffer.concat(chunks),
          contentType: (Array.isArray(header) ? header[0] : header)?.split(";", 1)[0]?.trim().toLowerCase(),
        });
      });
    });
    request.setTimeout(30_000, () => request.destroy(new Error("photo download timed out")));
    request.on("error", fail);
  });
}

bot.on("photo", (ctx) => {
  // Reserve the prompt position immediately, while the file download proceeds
  // asynchronously. Later updates for this chat cannot overtake the photo.
  const st = ensureChat(ctx.chat.id);
  const generation = st.generation;
  const signal = st.generationController.signal;
  const photo = ctx.message.photo![ctx.message.photo!.length - 1];
  const caption = ctx.message.caption?.trim();
  const images = (async (): Promise<ImageContent[]> => {
    const link = await abortable(ctx.telegram.getFileLink(photo.file_id), signal);
    const href = typeof link === "string" ? link : (link as { href: string }).href;
    const downloadSignal = AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
    const downloaded = await downloadTelegramFile(href, downloadSignal);
    const ext = new URL(href).pathname.split(".").pop()?.toLowerCase() ?? "";
    const fallbackType =
      ext === "png" ? "image/png" : ext === "gif" ? "image/gif" : ext === "webp" ? "image/webp" : "image/jpeg";
    const mediaType = downloaded.contentType?.startsWith("image/") ? downloaded.contentType : fallbackType;
    return [{ type: "image", data: downloaded.data.toString("base64"), mimeType: mediaType }];
  })();
  submitPrompt(
    ctx.chat.id,
    caption || "What can you tell me about this image?",
    images,
    st,
    generation,
  );
});

bot.on("document", async (ctx) => {
  await ctx.reply("📄 File uploads aren't supported yet — send text or photos.").catch(() => {});
});

bot.on("voice", async (ctx) => {
  await ctx.reply("🎙️ Voice messages aren't supported yet — send text or photos.").catch(() => {});
});

bot.catch((err, ctx) => {
  log(`[bot error] ${String((err as Error)?.message ?? err)}`);
});

// ══════════════════════════════ Bootstrap ═════════════════════════════════

/** Redact known secrets (bot token, full proxy URL) from anything we log. */
function redactSecrets(text: string): string {
  let s = text;
  if (BOT_TOKEN) s = s.split(BOT_TOKEN).join("<token>");
  if (PROXY_URL) s = s.split(PROXY_URL).join(proxyOrigin(PROXY_URL));
  return s;
}

function log(...args: unknown[]) {
  console.log(
    new Date().toISOString(),
    ...args.map((a) =>
      typeof a === "string" ? redactSecrets(a) : a instanceof Error ? redactSecrets(String(a.message ?? a)) : a,
    ),
  );
}

/** Log only the proxy's origin — never credentials or the full URL. */
function proxyOrigin(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.hostname}${u.port ? `:${u.port}` : ""}`;
  } catch {
    return "(unparseable proxy URL)";
  }
}

const isSelftest = process.argv.includes("--selftest");

let modelRuntime!: ModelRuntime;
let settingsManager!: SettingsManager;
let loader!: DefaultResourceLoader;

async function main() {
  if (!isSelftest && !acquireLock()) {
    console.error("Another gateway instance is already running. Exiting.");
    process.exit(0);
  }
  if (!isSelftest) process.once("exit", releaseLock);
  mkdirSync(SESSIONS_DIR, { recursive: true });
  loadChatMeta();

  if (!isSelftest) assertValidConfig();

  modelRuntime = await ModelRuntime.create();
  settingsManager = SettingsManager.create(DEFAULT_CWD, AGENT_DIR);
  loader = new DefaultResourceLoader({
    cwd: DEFAULT_CWD,
    agentDir: AGENT_DIR,
    settingsManager,
    appendSystemPrompt: APPEND_PROMPT ? [...CHAT_HINT, "", APPEND_PROMPT] : CHAT_HINT,
  });
  await loader.reload();

  // Refresh model catalogs in the background (best-effort).
  modelRuntime
    .refresh({ allowNetwork: true, signal: AbortSignal.timeout(15_000) })
    .catch(() => {});

  if (isSelftest) {
    log("selftest: creating a session and sending one prompt (no Telegram involved)…");
    // Use a throwaway sessions dir so the selftest never pollutes ./sessions.
    const tmpSessions = mkdtempSync(join(os.tmpdir(), "pi-gw-selftest-"));
    const out: string[] = [];
    let failed: unknown = null;
    let session: AgentSession | undefined;
    try {
      session = await createChatSession(0x0bad0bad, DEFAULT_CWD, tmpSessions);
      session.subscribe((event) => {
        if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
          out.push(event.assistantMessageEvent.delta);
        }
      });
      await session.prompt("Reply with exactly: GATEWAY OK");
      await new Promise((r) => setTimeout(r, 500));
      console.log("── agent reply ──");
      console.log(out.join(""));
      console.log("──────────────────");
    } catch (err) {
      failed = err;
    } finally {
      // Dispose even when the prompt failed, then remove the temp sessions dir.
      try {
        session?.dispose();
      } catch {
        /* ignore */
      }
      try {
        rmSync(tmpSessions, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
    // Assert the expected output instead of reporting success blindly.
    // trim() only strips the trailing newline models routinely append; the
    // content itself must still match exactly.
    const reply = out.join("").trim();
    if (failed) {
      console.error(`✖ selftest FAILED: ${String((failed as Error)?.message ?? failed)}`);
      process.exit(1);
    }
    if (reply !== "GATEWAY OK") {
      console.error(`✖ selftest FAILED — expected exactly 'GATEWAY OK', got: ${JSON.stringify(reply)}`);
      process.exit(1);
    }
    log("selftest passed.");
    return;
  }

  const me = await withRetry(() => bot.telegram.getMe());
  log(`🤖 running as @${me.username}`);
  // Keep the Telegram command menu in sync with this gateway. Scoped lists
  // (all_private_chats / all_group_chats) shadow the default list, so push to
  // every scope to avoid stale menus left by previous gateway software.
  const scopes = [
    undefined,
    { type: "all_private_chats" as const },
    { type: "all_group_chats" as const },
  ];
  for (const scope of scopes) {
    await withRetry(() => bot.telegram.setMyCommands(BOT_COMMANDS, scope ? { scope } : undefined), 3)
      .catch((err) => log(`[commands] sync failed (${scope?.type ?? "default"}): ${String((err as Error)?.message ?? err)}`));
  }
  if (PROXY_URL) log(`   proxy       : ${proxyOrigin(PROXY_URL)}`);
  if (IPV4_ONLY) log("   ipv4 only   : on (PI_TELEGRAM_IPV4_ONLY=true)");
  log(`   working dir : ${DEFAULT_CWD}`);
  log(`   sessions    : ${SESSIONS_DIR}`);
  log(`   allowed users: ${[...ALLOWED_USER_IDS].join(", ") || "(none)"}`);
  if (DROP_PENDING_UPDATES) log("   drop pending : on (PI_TELEGRAM_DROP_PENDING_UPDATES=true)");
  log(`   model       : ${MODEL_ARG ?? "default from settings"}`);
  log("Waiting for messages. Ctrl+C to stop.");

  // NOTE: in telegraf v4, launch() resolves only after the bot is stopped,
  // so everything after this line runs at shutdown time.
  // telegraf v4: launch() rejects on network errors (e.g. deleteWebhook),
  // resolves only after the bot is stopped. Retry transient proxy drops
  // instead of dying; give up only after retries (crash-restart takes over).
  try {
    await withRetry(() => bot.launch({ dropPendingUpdates: DROP_PENDING_UPDATES }), 4, 1500);
  } catch (err) {
    log(`FATAL: bot launch failed after retries: ${String((err as Error)?.message ?? err)}`);
    process.exit(1);
  }
  log("bot stopped.");
}

async function shutdown() {
  log("shutting down…");
  try {
    bot.stop("shutdown");
  } catch {
    /* ignore */
  }
  for (const st of chats.values()) {
    try {
      st.session?.dispose();
    } catch {
      /* ignore */
    }
  }
  process.exit(0);
}

process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
