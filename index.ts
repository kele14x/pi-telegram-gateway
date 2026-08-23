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

import { mkdirSync, rmSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { join, resolve, sep, dirname } from "node:path";
import process from "node:process";
import dns from "node:dns";
import os from "node:os";
import { Agent as NodeHttpsAgent } from "node:https";
import type { LookupFunction } from "node:net";

// Resolve addresses IPv4-first: on networks where IPv6 is broken (but DNS
// returns AAAA records), node-fetch (telegraf) hangs on the v6 attempt.
dns.setDefaultResultOrder("ipv4first");

// Telegraf bundles node-fetch v2, which does NOT do happy-eyeballs and can
// stall on the first (broken) address family. Force IPv4 for its agent.
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
} from "@earendil-works/pi-coding-agent";
import type { ImageContent } from "@earendil-works/pi-ai";
import { TelegramStream } from "./telegram-stream.ts";

// ── Single-instance lock ────────────────────────────────────────────────────
// Prevents a duplicate gateway (e.g. Task Scheduler restart racing a manual
// start) from polling the same bot and stealing updates.
const LOCK_FILE = join(import.meta.dirname, "logs", "gateway.lock");
function acquireLock(): boolean {
  try {
    const pid = Number(readFileSync(LOCK_FILE, "utf8"));
    if (Number.isFinite(pid)) {
      try {
        process.kill(pid, 0); // throws if the pid is gone
        return false; // another gateway is alive
      } catch {
        /* stale lock from a crashed process — take over */
      }
    }
  } catch {
    /* no lock file yet */
  }
  mkdirSync(dirname(LOCK_FILE), { recursive: true });
  writeFileSync(LOCK_FILE, String(process.pid));
  return true;
}
function releaseLock() {
  try {
    rmSync(LOCK_FILE, { force: true });
  } catch {
    /* ignore */
  }
}

// ══════════════════════════════ Config ═══════════════════════════════════

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? "";

const ALLOWED_IDS = new Set(
  (process.env.ALLOWED_TELEGRAM_IDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map(Number)
    .filter((n) => Number.isFinite(n)),
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
  try {
    const data = JSON.parse(readFileSync(META_FILE, "utf8")) as Record<string, { cwd?: string }>;
    for (const [k, v] of Object.entries(data)) {
      const id = Number(k);
      if (Number.isFinite(id) && typeof v?.cwd === "string") chatMeta.set(id, v.cwd);
    }
  } catch {
    /* no meta file yet */
  }
}
function saveChatMeta(chatId: number, cwd: string) {
  chatMeta.set(chatId, cwd);
  try {
    mkdirSync(SESSIONS_DIR, { recursive: true });
    writeFileSync(META_FILE, JSON.stringify(Object.fromEntries(chatMeta), null, 2));
  } catch (err) {
    log(`[meta] save failed: ${String((err as Error)?.message ?? err)}`);
  }
}


// ═══════════════════════════ Chat session hub ═════════════════════════════

interface ChatState {
  chatId: number;
  /** Per-chat working folder. */
  cwd: string;
  session: AgentSession | null;
  stream: TelegramStream | null;
  /** Serializes prompt submission per chat. */
  chain: Promise<void>;
}

const chats = new Map<number, ChatState>();

function assertValidConfig() {
  const problems: string[] = [];
  if (!BOT_TOKEN) problems.push("TELEGRAM_BOT_TOKEN is not set (see .env / .env.example)");
  if (problems.length) {
    for (const p of problems) console.error(`✖ ${p}`);
    throw new Error("Configuration error");
  }
  if (ALLOWED_IDS.size === 0) {
    console.warn("⚠ ALLOWED_TELEGRAM_IDS is not set — the bot will refuse everyone until configured.");
    console.warn("  Send /start to your bot; the gateway logs your numeric id, then add it to .env and restart.");
  }
}

function getErrorMessage(msg: unknown): string | undefined {
  const m = msg as { errorMessage?: string; stopReason?: string };
  if (m?.errorMessage) return m.errorMessage;
  if (m?.stopReason === "error") return "The model returned an error. Check the gateway console for details.";
  return undefined;
}

function expandHome(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/") || p.startsWith(`~${sep}`)) return join(os.homedir(), p.slice(2));
  return p;
}

async function createChatSession(chatId: number, cwd: string): Promise<AgentSession> {
  const sessionFile = join(SESSIONS_DIR, `chat-${chatId}.jsonl`);
  // cwdOverride keeps tools working in the chat's current folder even though
  // the session file header may record an older cwd.
  const sm = SessionManager.open(sessionFile, SESSIONS_DIR, cwd);

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
    settingsManager,
    resourceLoader: loader,
    sessionManager: sm,
    model,
    thinkingLevel,
  });
  return session;
}

function wireSession(chatId: number, session: AgentSession, stream: TelegramStream) {
  session.subscribe((event: AgentSessionEvent) => {
    switch (event.type) {
      case "agent_start": {
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
        const err = getErrorMessage(event.message);
        if (err) stream.append(`\n\n⚠️ ${err}`);
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
      case "queue_update": {
        if (event.followUp.length > 0) {
          void safeSend(chatId, `📥 Queued (after current task): “${event.followUp[0].slice(0, 60)}…”`);
        }
        break;
      }
      case "agent_end": {
        if (!event.willRetry) void stream.finalize();
        else stream.setStatus("⏳ retrying…");
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
    };
    chats.set(chatId, st);
  }
  return st;
}

async function getChatSession(chatId: number): Promise<AgentSession> {
  const st = ensureChat(chatId);
  if (!st.session) {
    st.session = await createChatSession(chatId, st.cwd);
    st.stream = new TelegramStream(bot, chatId);
    wireSession(chatId, st.session, st.stream);
    const m = st.session.model;
    log(
      `[chat ${chatId}] session ready — model: ${m ? `${m.provider}/${m.id}` : "default"}, cwd: ${st.cwd}, file: ${st.session.sessionFile}`,
    );
  }
  return st.session;
}

async function submitPrompt(chatId: number, text: string, images?: ImageContent[]) {
  const st = ensureChat(chatId);
  const task = st.chain.then(async () => {
    const session = await getChatSession(chatId);
    try {
      if (session.isStreaming) {
        await session.prompt(text, { images, streamingBehavior: "followUp" });
      } else {
        await session.prompt(text, { images });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`[chat ${chatId}] prompt error: ${msg}`);
      await safeSend(chatId, `⚠️ ${msg}`);
    }
  });
  st.chain = task.catch(() => {});
  await task;
}

async function safeSend(chatId: number, text: string) {
  try {
    await bot.telegram.sendMessage(chatId, text.slice(0, 4096));
  } catch (err) {
    log(`[send] ${String((err as Error)?.message ?? err)}`);
  }
}

// ═════════════════════════════ Telegram bot ═══════════════════════════════

const bot = new Telegraf(
  BOT_TOKEN,
  PROXY_URL
    ? { telegram: { agent: new HttpsProxyAgent(PROXY_URL) } }
    : { telegram: { agent: new NodeHttpsAgent({ lookup: ipv4Lookup }) } },
);

/** Access guard: only allowlisted users/chats may talk to the agent. */
bot.use(async (ctx, next) => {
  const fromId = ctx.from?.id ?? -1;
  const chatId = ctx.chat?.id ?? -1;
  if (ALLOWED_IDS.has(fromId) || ALLOWED_IDS.has(chatId)) return next();
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
      "/stop — abort the current run\n" +
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
      "/stop — abort the current run (new messages queue up by default)\n" +
      "/status — session info\n" +
      "/cwd — show the current working folder\n" +
      "/help — this message",
  );
});

bot.command("new", async (ctx) => {
  const chatId = ctx.chat.id;
  const st = chats.get(chatId);
  if (st?.session) {
    const file = st.session.sessionFile;
    try {
      st.session.dispose();
    } catch (err) {
      log(`[new] dispose: ${String((err as Error)?.message ?? err)}`);
    }
    if (file) {
      try {
        rmSync(file, { force: true });
      } catch {
        /* ignore */
      }
    }
  }
  chats.delete(chatId);
  await ctx.reply("🧹 Fresh session started (working folder kept). Send me anything to begin.");
});

bot.command("model", async (ctx) => {
  const arg = ctx.payload.trim();
  try {
    const session = await getChatSession(ctx.chat.id);
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
    await session.setModel(r.model);
    if (r.thinkingLevel) await session.setThinkingLevel(r.thinkingLevel);
    await ctx.reply(`✓ Model set to ${r.model.provider}/${r.model.id}`);
  } catch (err) {
    await ctx.reply(`⚠️ ${err instanceof Error ? err.message : String(err)}`).catch(() => {});
  }
});

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

bot.command("thinking", async (ctx) => {
  const arg = ctx.payload.trim().toLowerCase();
  try {
    const session = await getChatSession(ctx.chat.id);
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
    session.setThinkingLevel(arg as (typeof THINKING_LEVELS)[number]);
    await ctx.reply(`✓ thinking level: ${arg}`);
  } catch (err) {
    await ctx.reply(`⚠️ ${err instanceof Error ? err.message : String(err)}`).catch(() => {});
  }
});

bot.command("stop", async (ctx) => {
  const st = chats.get(ctx.chat.id);
  if (!st?.session) {
    await ctx.reply("Nothing is running.");
    return;
  }
  await st.session.abort().catch(() => {});
  await ctx.reply("🛑 Aborted the current run.");
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
    if (!statSync(target).isDirectory()) throw new Error("not a directory");
  } catch {
    await ctx.reply(`⚠️ No such directory: ${target}`).catch(() => {});
    return;
  }
  st.cwd = target;
  saveChatMeta(ctx.chat.id, target);
  if (st.session) {
    // History is kept on disk; the session is rebuilt with the new folder on
    // the next message.
    try {
      st.session.dispose();
    } catch (err) {
      log(`[cd] dispose: ${String((err as Error)?.message ?? err)}`);
    }
    st.session = null;
    st.stream = null;
  }
  log(`[chat ${ctx.chat.id}] cwd -> ${target}`);
  await ctx.reply(`📁 Working folder set to:\n${target}\n\nConversation history is kept — your next message continues in this folder.`);
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
    size = `${statSync(file).size} bytes`;
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
  { command: "stop", description: "Abort the current run" },
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
  await submitPrompt(ctx.chat.id, text);
});

bot.on("photo", async (ctx) => {
  try {
    const photo = ctx.message.photo![ctx.message.photo!.length - 1];
    const link = await ctx.telegram.getFileLink(photo.file_id);
    const href = typeof link === "string" ? link : (link as { href: string }).href;
    const res = await fetch(href);
    if (!res.ok) throw new Error(`download failed: ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const ext = href.split(".").pop()?.toLowerCase() ?? "";
    const mediaType =
      ext === "png" ? "image/png" : ext === "gif" ? "image/gif" : ext === "webp" ? "image/webp" : "image/jpeg";
    const caption = ctx.message.caption?.trim();
    await submitPrompt(ctx.chat.id, caption || "What can you tell me about this image?", [
      { type: "image", data: buf.toString("base64"), mimeType: mediaType },
    ]);
  } catch (err) {
    await safeSend(ctx.chat.id, `⚠️ Couldn't process the photo: ${err instanceof Error ? err.message : String(err)}`);
  }
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

function log(...args: unknown[]) {
  console.log(new Date().toISOString(), ...args);
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
    const session = await createChatSession(0x0bad0bad, DEFAULT_CWD); // deterministic dummy chat
    const out: string[] = [];
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
    session.dispose();
    log("selftest passed.");
    return;
  }

  const me = await bot.telegram.getMe();
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
    await bot.telegram
      .setMyCommands(BOT_COMMANDS, scope ? { scope } : undefined)
      .catch((err) => log(`[commands] sync failed (${scope?.type ?? "default"}): ${String((err as Error)?.message ?? err)}`));
  }
  if (PROXY_URL) log(`   proxy       : ${PROXY_URL}`);
  log(`   working dir : ${DEFAULT_CWD}`);
  log(`   sessions    : ${SESSIONS_DIR}`);
  log(`   allowed ids : ${[...ALLOWED_IDS].join(", ") || "(none)"}`);
  log(`   model       : ${MODEL_ARG ?? "default from settings"}`);
  log("Waiting for messages. Ctrl+C to stop.");

  // NOTE: in telegraf v4, launch() resolves only after the bot is stopped,
  // so everything after this line runs at shutdown time.
  await bot.launch({ dropPendingUpdates: true });
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