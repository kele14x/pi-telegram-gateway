// Offline regressions for terminal errors, history removal, and error redaction.

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { format } from "node:util";
import vm from "node:vm";
import ts from "typescript";
import { removeChatHistory } from "../history.ts";
import { SessionErrorBuffer } from "../session-errors.ts";
import * as stream from "../telegram-stream.ts";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

{
  const errors = new SessionErrorBuffer();
  errors.beginAttempt();
  errors.capture({ role: "assistant", stopReason: "error", errorMessage: "temporary outage" });
  assert(errors.finishAttempt(true) === undefined, "retryable error leaked into output");

  errors.beginAttempt();
  errors.capture({ role: "assistant", stopReason: "stop" });
  assert(errors.finishAttempt(false) === undefined, "successful retry inherited the old error");

  errors.beginAttempt();
  errors.capture({ role: "assistant", stopReason: "error", errorMessage: "terminal outage" });
  assert(errors.finishAttempt(false) === "terminal outage", "terminal error was not retained");
}

{
  let removedPath;
  removeChatHistory("C:/opaque-sessions", 42, (path, options) => {
    removedPath = path;
    assert(options.force === true, "history removal is not idempotent");
  });
  assert(removedPath === join("C:/opaque-sessions", "chat-42.jsonl"), "wrong history file selected");

  const expected = new Error("permission denied");
  let received;
  try {
    removeChatHistory("C:/opaque-sessions", 42, () => {
      throw expected;
    });
  } catch (err) {
    received = err;
  }
  assert(received === expected, "history removal failure was swallowed");
}

// Extract the real handlers without running bootstrap or loading owner credentials.
const source = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
const ast = ts.createSourceFile("index.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const names = new Set(["submitPrompt", "enqueueChatJob", "safeSend", "trackDelivery", "redactSecrets", "proxyOrigin", "log", "withRetry"]);
const handlers = ast.statements.filter(node => ts.isFunctionDeclaration(node) && names.has(node.name?.text));
assert(handlers.length === names.size, "gateway regression handlers could not be found");
const code = ts.transpileModule(handlers.map(node => node.getText(ast)).join("\n"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;
const fatalHandler = ast.statements.find(node =>
  ts.isExpressionStatement(node) && ts.isCallExpression(node.expression) &&
  ts.isPropertyAccessExpression(node.expression.expression) &&
  node.expression.expression.name.text === "catch" &&
  ts.isCallExpression(node.expression.expression.expression) &&
  node.expression.expression.expression.expression.getText(ast) === "main",
);
assert(fatalHandler, "gateway fatal startup handler could not be found");
const fatalCode = ts.transpileModule(fatalHandler.getText(ast), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;
const token = "123456789:synthetic-offline-token";
const proxy = "https://synthetic-user:synthetic-password@proxy.example:8443/private-path";

function makeGateway() {
  const sent = [];
  const logs = [];
  const state = {
    chatId: -42, generation: 0, generationController: new AbortController(),
    busy: 0, chain: Promise.resolve(), running: new Set(),
  };
  const bot = { telegram: { sendMessage: async (chatId, text) => sent.push({ chatId, text }) } };
  const context = vm.createContext({
    shuttingDown: false, pendingDeliveries: new Set(),
    Error, BOT_TOKEN: token, PROXY_URL: proxy, URL, bot, chunkEnd: stream.chunkEnd,
    console: {
      log: (...args) => logs.push(format(...args)),
      error: (...args) => logs.push(format(...args)),
    },
    isCurrentChat: (st, generation) => st === state && generation === state.generation,
    abortable: promise => promise,
    ChatOperationCancelled: class extends Error {},
    getChatSession: () => { throw new Error("A failed photo must not create a session"); },
  });
  vm.runInContext(code, context);
  return { context, state, sent, logs, bot };
}

const require = createRequire(import.meta.url);
const telegrafRequire = createRequire(require.resolve("telegraf"));
const { Response } = telegrafRequire("node-fetch");

// Run the actual retry helper and fatal catch with a mocked startup request.
// No bootstrap, owner configuration, process exit, or network call is performed.
{
  const response = new Response("<html>invalid API response</html>", {
    url: `https://api.telegram.org/bot${token}/getMe`, status: 200,
  });
  const parsingError = await response.json().catch(error => error);
  assert(parsingError instanceof Error && parsingError.message.includes(token),
    "startup parsing-error fixture must contain the synthetic token");
  const transportMessage = `request to https://api.telegram.org/bot${token}/getMe failed via ${proxy}`;
  for (const [scenario, error, hasProxy] of [
    ["invalid-json", parsingError, false],
    ["transport-error", new Error(transportMessage), true],
    ["string-rejection", transportMessage, true],
    ["object-rejection", { message: transportMessage, request: { token, proxy } }, true],
  ]) {
    const { context, bot, logs } = makeGateway();
    const exits = [];
    const delays = [];
    let attempts = 0;
    bot.telegram.getMe = async () => { attempts++; throw error; };
    context.setTimeout = (callback, delay) => { delays.push(delay); callback(); };
    context.process = { exit: code => exits.push(code) };
    context.main = () => context.withRetry(() => bot.telegram.getMe());
    await vm.runInContext(fatalCode, context);
    assert(attempts === 4 && delays.length === 3, `${scenario}: startup did not exhaust retries`);
    assert(exits.length === 1 && exits[0] === 1, `${scenario}: fatal startup did not exit with code 1`);
    const fatal = logs.filter(line => line.includes("FATAL:"));
    assert(logs.length === 4 && fatal.length === 1, `${scenario}: retry or fatal diagnostics were lost`);
    assert(!logs.some(line => line.includes(token)), `${scenario}: startup exposed the token in logs`);
    assert(fatal[0].includes("<token>"), `${scenario}: fatal token placeholder is missing`);
    if (hasProxy) {
      assert(!logs.some(line => line.includes(proxy) || line.includes("synthetic-password") || line.includes("synthetic-user")),
        `${scenario}: startup exposed proxy credentials in logs`);
      assert(fatal[0].includes("https://proxy.example:8443"), `${scenario}: proxy origin diagnostic was lost`);
    }
  }
}

for (const scenario of ["invalid-json", "body-stream"]) {
  const body = scenario === "invalid-json" ? "<html>invalid API response</html>" : new PassThrough();
  const response = new Response(body, { url: `https://api.telegram.org/bot${token}/getFile`, status: 200 });
  const failure = response.json().then(
    () => { throw new Error("Expected a response parsing failure"); },
    error => error,
  );
  if (scenario === "body-stream") body.destroy(new Error("simulated response stream failure"));
  const error = await failure;
  assert(error.message.includes(token), `${scenario}: fixture must contain the synthetic token`);
  const { context, state, sent, logs } = makeGateway();
  context.submitPrompt(state.chatId, "offline photo", Promise.reject(error), state, state.generation);
  await state.chain;
  assert(sent.length === 1 && sent[0].chatId === state.chatId, `${scenario}: photo error was not delivered`);
  assert(sent[0].text.includes("Couldn't process the photo:"), `${scenario}: photo failure feedback was lost`);
  assert(!sent[0].text.includes(token), `${scenario}: token leaked to the chat`);
  assert(sent[0].text.includes("<token>"), `${scenario}: token placeholder is missing`);
  assert(!logs.some(line => line.includes(token)), `${scenario}: token leaked to logs`);
  assert(state.busy === 0 && state.running.size === 0, `${scenario}: failed photo left the queue busy`);
}

{
  const { context, sent } = makeGateway();
  const astral = "\u{1D11E}";
  const cases = [
    ["plain", "plain"],
    ["x".repeat(4096), "x".repeat(4096)],
    ["x".repeat(4097), "x".repeat(4096)],
    ["x".repeat(4095) + astral, "x".repeat(4095)],
    ["x".repeat(4094) + astral + "tail", "x".repeat(4094) + astral],
    [`${token} ${token} ${proxy}`, "<token> <token> https://proxy.example:8443"],
    ["x".repeat(4088) + token, "x".repeat(4088) + "<token>"],
    [token + "x".repeat(4088) + astral, "<token>" + "x".repeat(4088)],
  ];
  for (const [input, expected] of cases) {
    await context.safeSend(-42, input);
    const text = sent.at(-1).text;
    assert(text === expected, "safeSend redaction/truncation output differs");
    assert(text.length <= 4096 && text.isWellFormed(), "safeSend produced an invalid Telegram payload");
  }
}

{
  const { context, bot, logs } = makeGateway();
  bot.telegram.sendMessage = async () => { throw new Error(`send failure: ${token} ${proxy}`); };
  await context.safeSend(-42, "plain");
  assert(logs.length === 1 && logs[0].includes("[send]"), "send failure was not logged");
  assert(logs[0].includes("<token>") && !logs[0].includes(token), "send failure exposed the token in logs");
  assert(!logs[0].includes("synthetic-password"), "send failure exposed proxy credentials in logs");
}

// Outbound error text must pass through safeSend's redaction: a caught error can
// carry the token-bearing Telegram API URL, so ctx.reply must never forward one.
{
  const referencesErr = (node) => {
    let found = false;
    const walk = (n) => {
      if (found) return;
      if (ts.isIdentifier(n) && n.text === "err") found = true;
      else ts.forEachChild(n, walk);
    };
    walk(node);
    return found;
  };
  const offenders = [];
  const visit = (node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "reply" &&
      node.expression.expression.getText(ast) === "ctx" &&
      node.arguments.some(referencesErr)
    ) {
      offenders.push(ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1);
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  assert(
    offenders.length === 0,
    `unredacted error text sent via ctx.reply at index.ts line(s) ${offenders.join(", ")} — use safeSend`,
  );
}

console.log("Deferred-error, history-removal, startup-redaction, outbound-redaction, and reply-redaction regressions passed");
