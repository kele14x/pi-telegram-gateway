// Offline shutdown regressions: real gateway lifecycle and TelegramStream,
// fake SDK sessions, delivery gates, and a manually advanced shutdown deadline.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { SessionErrorBuffer } from "../session-errors.ts";
import { TelegramStream, chunkEnd } from "../telegram-stream.ts";

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return {promise, resolve, reject};
}

const source = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
const ast = ts.createSourceFile("index.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const names = new Set([
  "trackDelivery", "wireSession", "ensureChat", "isCurrentChat", "advanceChatGeneration",
  "abortable", "getChatSession", "replaceChatSession", "enqueueChatJob", "submitPrompt", "enqueueChatOp",
  "safeSend", "redactSecrets", "proxyOrigin", "log", "shutdown", "performShutdown",
  "ChatOperationCancelled",
]);
const declarations = ast.statements.filter(node =>
  (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && names.has(node.name?.text),
);
assert.equal(declarations.length, names.size, "all production shutdown dependencies are present");
const ingress = ast.statements.find(node => ts.isExpressionStatement(node) &&
  ts.isCallExpression(node.expression) && node.expression.expression.getText(ast) === "bot.use");
assert(ingress, "production ingress guard is present");
const code = ts.transpileModule([...declarations, ingress].map(node => node.getText(ast)).join("\n"), {
  compilerOptions: {target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.None},
}).outputText;

function makeGateway() {
  const events = [];
  const logs = [];
  const messages = new Map();
  const timers = new Map();
  let nextMessage = 0, nextTimer = 0, ingress;
  const bot = {
    use(handler) { ingress = handler; },
    stop() { events.push("bot-stop"); },
    telegram: {
      async sendMessage(chatId, text) {
        events.push(`send:${chatId}`);
        await bot.beforeDelivery(text);
        const message_id = ++nextMessage;
        messages.set(message_id, {chatId, text});
        events.push(`delivered:${chatId}`);
        return {message_id};
      },
      async editMessageText(chatId, messageId, inline, text) {
        await bot.beforeDelivery(text);
        messages.set(messageId, {chatId, text});
      },
    },
    beforeDelivery: async () => {},
  };
  const context = vm.createContext({
    AbortController, URL, TelegramStream, chunkEnd, SessionErrorBuffer,
    shuttingDown: false, shutdownPromise: null, SHUTDOWN_TIMEOUT_MS: 10_000,
    pendingDeliveries: new Set(), chats: new Map(), chatMeta: new Map(),
    DEFAULT_CWD: "synthetic-project", BOT_TOKEN: "synthetic-offline-token", PROXY_URL: undefined,
    bot, console: {log: (...args) => logs.push(args.join(" "))},
    process: {exit: status => events.push(`exit:${status}`)},
    setTimeout: (callback, delay) => { const id = ++nextTimer; timers.set(id, {callback, delay}); return id; },
    clearTimeout: id => timers.delete(id),
    createChatSession: () => { throw new Error("Unexpected session creation"); },
    removeChatHistory: () => { throw new Error("Shutdown must keep conversation history"); },
  });
  vm.runInContext(code, context);

  function addChat(chatId) {
    const state = context.ensureChat(chatId);
    let listener;
    const abortStarted = deferred();
    const session = {
      isStreaming: false,
      subscribe(fn) { listener = fn; },
      clearQueue() { events.push(`clear:${chatId}`); session.onClear(); },
      async abort() {
        events.push(`abort:${chatId}`);
        abortStarted.resolve();
        await session.onAbort();
        events.push(`aborted:${chatId}`);
      },
      dispose() { events.push(`dispose:${chatId}`); session.onDispose(); },
      prompt: () => { throw new Error("Unexpected prompt"); },
      onClear: () => {}, onAbort: async () => {}, onDispose: () => {},
    };
    state.session = session;
    state.stream = new TelegramStream(bot, chatId, context.log);
    context.wireSession(chatId, session, state.stream);
    return {state, session, abortStarted, emit: event => listener(event)};
  }

  const expireDeadline = () => {
    assert.equal(timers.size, 1, "shutdown uses one deadline across all chats");
    const timer = [...timers.values()][0];
    assert.equal(timer.delay, 10_000);
    timer.callback();
  };
  const assertWaiting = () => {
    assert(!events.some(event => event.startsWith("exit:")), "shutdown waits before exiting");
    assert(!events.some(event => event.startsWith("dispose:")), "sessions remain alive while cleanup is pending");
  };
  return {context, events, logs, messages, timers, bot, addChat, expireDeadline, assertWaiting,
    ingress: (...args) => ingress(...args)};
}

function append(chat, text) {
  chat.emit({type: "message_update", assistantMessageEvent: {type: "text_delta", delta: text}});
}

// Both sessions must receive abort while neither has yet completed. Gateway
// queued prompts and commands, late submissions, and incoming updates stay out.
{
  const gateway = makeGateway();
  const {context, events, messages, timers} = gateway;
  const chats = [gateway.addChat(42), gateway.addChat(43)];
  const releases = chats.map(() => deferred());
  const started = chats.map(() => deferred());
  for (const [index, chat] of chats.entries()) {
    chat.session.prompt = async (text, options) => {
      assert.equal(text, "active request", "queued and late prompts never start");
      options.preflightResult(true);
      chat.session.isStreaming = true;
      chat.emit({type: "agent_start"});
      append(chat, `partial-${chat.state.chatId}`);
      started[index].resolve();
      await releases[index].promise;
      append(chat, "-last-delta");
      chat.emit({type: "message_end", message: {role: "assistant", stopReason: "aborted"}});
      chat.emit({type: "agent_end", willRetry: false});
      chat.session.isStreaming = false;
    };
    chat.session.onAbort = async () => { await releases[index].promise; };
    context.submitPrompt(chat.state.chatId, "active request");
  }
  await Promise.all(started.map(gate => gate.promise));
  let queuedCommandRan = false, incomingUpdateRan = false;
  context.submitPrompt(42, "queued request");
  const queuedCommand = context.enqueueChatOp(42, async () => { queuedCommandRan = true; });
  const oldSignals = chats.map(chat => chat.state.generationController.signal);
  const shutdown = context.shutdown();
  assert.equal(context.shutdown(), shutdown, "repeated signals share the same shutdown promise");
  await Promise.all(chats.map(chat => chat.abortStarted.promise));
  gateway.assertWaiting();
  assert(oldSignals.every(signal => signal.aborted), "preparation signals are cancelled for every chat");
  assert(chats.every(chat => chat.state.generation === 1));
  context.submitPrompt(42, "late request");
  await gateway.ingress({from: {id: 7}}, () => { incomingUpdateRan = true; });
  assert.equal(incomingUpdateRan, false);
  for (const gate of releases) gate.resolve();
  await shutdown;
  await queuedCommand;
  assert.equal(queuedCommandRan, false);
  assert(chats.every(chat => chat.state.busy === 0 && chat.state.running.size === 0));
  for (const chat of chats) {
    const id = chat.state.chatId;
    const texts = [...messages.values()].filter(message => message.chatId === id).map(message => message.text);
    assert(texts.includes(`partial-${id}-last-delta`), "last abort-time delta is delivered intact");
    assert.equal(texts.filter(text => text.includes("Gateway shutting down")).length, 1);
    assert(events.indexOf(`clear:${id}`) < events.indexOf(`abort:${id}`));
    assert(events.lastIndexOf(`delivered:${id}`) < events.indexOf(`dispose:${id}`));
    assert.equal(events.filter(event => event === `dispose:${id}`).length, 1);
  }
  assert.equal(events.filter(event => event === "bot-stop").length, 1);
  assert.equal(events.filter(event => event === "exit:0").length, 1);
  assert.equal(timers.size, 0, "successful cleanup clears its deadline");
}

// agent_end finalized an old run before shutdown. A newer run also finalized,
// and calling finalize again returns early. Original promises must still drain.
{
  const gateway = makeGateway();
  const {context, bot, messages} = gateway;
  const chat = gateway.addChat(42);
  const sending = deferred(), delivery = deferred();
  bot.beforeDelivery = async text => {
    if (text.startsWith("R")) { sending.resolve(); await delivery.promise; }
  };
  chat.emit({type: "agent_start"});
  append(chat, "R".repeat(8_000));
  chat.emit({type: "agent_end", willRetry: false});
  await sending.promise;
  chat.emit({type: "agent_start"});
  append(chat, "newer reply");
  chat.emit({type: "agent_end", willRetry: false});
  const shutdown = context.shutdown();
  await chat.abortStarted.promise;
  gateway.assertWaiting();
  delivery.resolve();
  await shutdown;
  const text = [...messages.values()].map(message => message.text).join("");
  assert.equal(text, "R".repeat(8_000) + "newer reply", "all pending runs and chunks finish delivery before exit");
  assert.equal(context.pendingDeliveries.size, 0);
}

// A final-delivery failure starts a separate fallback notice. Wait for it too.
{
  const gateway = makeGateway();
  const {context, bot, messages} = gateway;
  const chat = gateway.addChat(42);
  const fallbackStarted = deferred(), fallback = deferred();
  bot.beforeDelivery = async text => {
    if (text === "FAILED_FINAL") {
      const error = new Error("synthetic delivery failure");
      error.response = {error_code: 400};
      throw error;
    }
    if (text.includes("final response could not be delivered")) {
      fallbackStarted.resolve();
      await fallback.promise;
    }
  };
  chat.emit({type: "agent_start"});
  append(chat, "FAILED_FINAL");
  chat.emit({type: "agent_end", willRetry: false});
  await fallbackStarted.promise;
  const shutdown = context.shutdown();
  await chat.abortStarted.promise;
  gateway.assertWaiting();
  fallback.resolve();
  await shutdown;
  assert([...messages.values()].some(message => message.text.includes("final response could not be delivered")));
}

// SDK preflight can resume after abort has already returned. Its final check
// must prevent an agent run from starting as the gateway is shutting down.
{
  const gateway = makeGateway();
  const {context, events} = gateway;
  const chat = gateway.addChat(42);
  const entered = deferred(), preflight = deferred();
  let agentStarted = false;
  chat.session.prompt = async (text, options) => {
    entered.resolve();
    await preflight.promise;
    options.preflightResult(true);
    agentStarted = true;
  };
  context.submitPrompt(42, "preflight request");
  await entered.promise;
  const shutdown = context.shutdown();
  await chat.abortStarted.promise;
  gateway.assertWaiting();
  preflight.resolve();
  await shutdown;
  assert.equal(agentStarted, false);
  assert.equal(chat.state.busy, 0);
  assert(events.includes("dispose:42"));
}

// An SDK retry cancellation has no subsequent agent_end, but its status-only
// finalization still needs to finish before disposal and exit.
{
  const gateway = makeGateway();
  const {context, bot, messages} = gateway;
  const chat = gateway.addChat(42);
  const ended = deferred(), sending = deferred(), delivery = deferred();
  chat.state.busy = 1;
  chat.state.chain = ended.promise;
  chat.emit({type: "agent_start"});
  chat.emit({type: "agent_end", willRetry: true});
  bot.beforeDelivery = async text => {
    if (text === "🛑 aborted") { sending.resolve(); await delivery.promise; }
  };
  chat.session.onAbort = async () => {
    chat.emit({type: "auto_retry_end", success: false, finalError: "Retry cancelled"});
    ended.resolve();
  };
  const shutdown = context.shutdown();
  await sending.promise;
  gateway.assertWaiting();
  delivery.resolve();
  await shutdown;
  assert([...messages.values()].some(message => message.text === "🛑 aborted"));
}

// Session replacement detaches its old session from ChatState. Its existing
// reset promise owns that session and must complete before shutdown exits.
{
  const gateway = makeGateway();
  const {context, events} = gateway;
  const chat = gateway.addChat(42);
  const abort = deferred();
  chat.session.onAbort = () => abort.promise;
  context.advanceChatGeneration(chat.state);
  const replacement = context.replaceChatSession(chat.state, false);
  await chat.abortStarted.promise;
  assert.equal(chat.state.session, null);
  const shutdown = context.shutdown();
  gateway.assertWaiting();
  abort.resolve();
  await replacement;
  await shutdown;
  assert.equal(events.filter(event => event === "dispose:42").length, 1);
  assert(events.indexOf("dispose:42") < events.indexOf("exit:0"));
}

// Pending initialization must self-dispose instead of wiring a live session.
{
  const gateway = makeGateway();
  const {context, events} = gateway;
  const chat = gateway.addChat(42);
  chat.state.session = null;
  chat.state.stream = null;
  const entered = deferred(), creation = deferred();
  context.createChatSession = () => { entered.resolve(); return creation.promise; };
  context.submitPrompt(42, "initializing request");
  await entered.promise;
  const shutdown = context.shutdown();
  gateway.assertWaiting();
  creation.resolve(chat.session);
  await shutdown;
  assert.equal(chat.state.session, null);
  assert.equal(chat.state.sessionInit, null);
  assert.equal(chat.state.busy, 0);
  assert.equal(events.filter(event => event === "dispose:42").length, 1);
}

// A photo download waiting indefinitely is cancelled through its signal.
{
  const gateway = makeGateway();
  const {context} = gateway;
  const chat = gateway.addChat(42);
  const photos = deferred();
  context.submitPrompt(42, "photo request", photos.promise);
  await Promise.resolve();
  assert.equal(chat.state.running.size, 1);
  await context.shutdown();
  assert.equal(chat.state.busy, 0);
  assert.equal(chat.state.running.size, 0);
}

// Stalled SDK aborts and prompt jobs in multiple chats share one ten-second
// deadline. Disposal and exit happen even though their promises never settled.
{
  const gateway = makeGateway();
  const {context, events, logs, timers} = gateway;
  const chats = [gateway.addChat(42), gateway.addChat(43)];
  const aborts = chats.map(() => deferred());
  const jobs = chats.map(() => deferred());
  for (const [index, chat] of chats.entries()) {
    chat.state.busy = 1;
    chat.session.isStreaming = true;
    chat.session.onAbort = () => aborts[index].promise;
    chat.state.chain = jobs[index].promise;
  }
  const shutdown = context.shutdown();
  await Promise.all(chats.map(chat => chat.abortStarted.promise));
  gateway.assertWaiting();
  gateway.expireDeadline();
  await shutdown;
  assert(chats.every(chat => events.includes(`dispose:${chat.state.chatId}`)));
  assert.equal(events.filter(event => event === "exit:0").length, 1);
  assert(logs.some(line => line.includes("cleanup timed out after 10000ms")));
  assert.equal(timers.size, 0);
  // Mocked exit leaves JS running: settle the abandoned promises and verify
  // a late rejection is handled and cleanup does not dispose or exit again.
  aborts[0].reject(new Error("late abort failure"));
  aborts[1].resolve();
  for (const job of jobs) job.resolve();
  await Promise.all(chats.map(chat => chat.state.chain));
  assert.equal(events.filter(event => event.startsWith("dispose:")).length, 2);
}

// A stuck Telegram request alone is also bounded, even with no active agent.
{
  const gateway = makeGateway();
  const {context, bot, events, logs} = gateway;
  const chat = gateway.addChat(42);
  const entered = deferred(), delivery = deferred();
  bot.beforeDelivery = async () => { entered.resolve(); await delivery.promise; };
  chat.emit({type: "agent_start"});
  append(chat, "pending reply");
  chat.emit({type: "agent_end", willRetry: false});
  await entered.promise;
  const shutdown = context.shutdown();
  await chat.abortStarted.promise;
  gateway.assertWaiting();
  gateway.expireDeadline();
  await shutdown;
  assert(events.includes("dispose:42") && events.includes("exit:0"));
  assert(logs.some(line => line.includes("cleanup timed out")));
  delivery.resolve();
  await Promise.allSettled([...context.pendingDeliveries]);
}

// One chat's failures do not skip the others; all diagnostics remain redacted.
{
  const gateway = makeGateway();
  const {context, bot, events, logs} = gateway;
  const first = gateway.addChat(42), second = gateway.addChat(43);
  bot.stop = () => { throw new Error("bot was not running"); };
  const failure = () => { throw new Error("failure containing synthetic-offline-token"); };
  first.session.onClear = failure;
  first.session.onAbort = failure;
  first.session.onDispose = failure;
  await context.shutdown();
  assert(events.includes("aborted:43") && events.includes("dispose:43") && events.includes("exit:0"));
  assert(logs.filter(line => line.includes("[shutdown]")).length === 3);
  assert(logs.every(line => !line.includes("synthetic-offline-token")));
  assert(logs.some(line => line.includes("<token>")));
  assert.equal(gateway.messages.size, 0, "idle chats receive no shutdown messages");
}

console.log("Concurrent abort, queue/preflight cancellation, delivery drain, timeout, and shutdown-failure regressions passed");
