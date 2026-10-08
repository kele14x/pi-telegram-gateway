// Offline /cd regressions: handler races, persisted SDK history, and mocked model requests.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import vm from "node:vm";
import ts from "typescript";
import { createAgentSession, ModelRuntime, SessionManager, resolveCliModel } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, getCurrentSystemPrompt, resolveTranscript } from "@earendil-works/pi-ai";
import { parseChatMeta, serializeChatMeta } from "../chat-meta.ts";
import { createChatResources, syncChatCwdContext } from "../chat-resources.ts";

function assert(condition, message) {
  if (!condition) throw new Error(message);
  console.log(`  ✓ ${message}`);
}

function deferred() {
  let resolvePromise;
  const promise = new Promise(resolve => { resolvePromise = resolve; });
  return {promise, resolve: resolvePromise};
}

async function testCdCommand(ast, dirA, dirB, dirEmpty) {
  // Execute the actual command and queue/session lifecycle, with no bootstrap,
  // credentials, Telegram requests, or model calls. Gates control each race.
  const names = new Set([
    "ensureChat", "isCurrentChat", "advanceChatGeneration", "abortable",
    "getChatSession", "replaceChatSession", "enqueueChatJob", "submitPrompt", "enqueueChatOp",
    "ChatOperationCancelled",
  ]);
  const declarations = ast.statements.filter(node =>
    (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && names.has(node.name?.text),
  );
  const command = ast.statements.find(node =>
    ts.isExpressionStatement(node) && ts.isCallExpression(node.expression) &&
    node.expression.expression.getText(ast) === "bot.command" &&
    node.expression.arguments[0]?.text === "cd",
  );
  assert(declarations.length === names.size && command, "production /cd handler and lifecycle are present");
  const code = ts.transpileModule([...declarations, command].map(node => node.getText(ast)).join("\n"), {
    compilerOptions: {target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.None},
  }).outputText;

  function makeGateway() {
    const replies = [];
    const sent = [];
    const prompts = [];
    const metadata = new Map();
    const effects = {stats: 0, aborts: 0, disposals: 0, clears: 0, cancels: 0, removals: 0};
    let runPrompt = async () => {};
    let cd;
    function makeSession(cwd) {
      const session = {
        isStreaming: false,
        async prompt(text, options) {
          options.preflightResult(true);
          session.isStreaming = true;
          prompts.push({text, cwd});
          try { await runPrompt(text); }
          finally { session.isStreaming = false; }
        },
        clearQueue() { effects.clears++; },
        async abort() { effects.aborts++; },
        dispose() { effects.disposals++; },
      };
      return session;
    }
    class FakeStream {
      cancel() { effects.cancels++; }
    }
    const context = vm.createContext({
      shuttingDown: false,
      AbortController, resolve, expandHome: path => path, chats: new Map(), chatMeta: metadata,
      DEFAULT_CWD: dirA, SESSIONS_DIR: dirA, log: () => {},
      bot: {command: (name, handler) => { if (name === "cd") cd = handler; }},
      stat: async () => { effects.stats++; return {isDirectory: () => true}; },
      saveChatMeta: (id, patch) => { metadata.set(id, {...metadata.get(id), ...patch}); return true; },
      removeChatHistory: () => { effects.removals++; },
      safeSend: async (chatId, text) => { sent.push({chatId, text}); },
      createChatSession: async (chatId, cwd) => makeSession(cwd),
      TelegramStream: FakeStream, wireSession: () => {},
    });
    vm.runInContext(code, context);
    const state = context.ensureChat(-42);
    state.session = makeSession(dirA);
    state.stream = new FakeStream();
    const changeFolder = path => cd({chat: {id: state.chatId}, payload: path, reply: async text => { replies.push(text); }});
    return {context, state, replies, sent, prompts, metadata, effects, changeFolder,
      setRunPrompt: fn => { runPrompt = fn; }};
  }

  function assertUntouched(gateway, message) {
    const {state, metadata, effects} = gateway;
    assert(state.cwd === dirA && state.generation === 0 && metadata.size === 0 &&
      effects.aborts === 0 && effects.disposals === 0 && effects.clears === 0 && effects.cancels === 0,
    message);
  }

  {
    const gateway = makeGateway();
    const {context, state, prompts, replies, sent, effects} = gateway;
    const queue = deferred();
    state.chain = queue.promise;
    context.submitPrompt(state.chatId, "first queued prompt");
    context.submitPrompt(state.chatId, "second queued prompt");
    assert(state.busy === 2 && state.running.size === 0 && !state.session.isStreaming,
      "queued-prompt fixture has no active streaming run");
    await gateway.changeFolder(dirB);
    assert(replies.length === 1 && replies[0].includes("queued or active work") && effects.stats === 0,
      "/cd refuses queued prompts with feedback before validating the path");
    assertUntouched(gateway, "refusing /cd keeps the queued prompts and old session intact");
    queue.resolve();
    await state.chain;
    assert(prompts.map(prompt => prompt.text).join(",") === "first queued prompt,second queued prompt" &&
      prompts.every(prompt => prompt.cwd === dirA) && state.busy === 0 && sent.length === 1,
    "both queued prompts still run in arrival order in the original folder");
  }

  {
    const gateway = makeGateway();
    const {context, state, prompts} = gateway;
    const photos = deferred();
    context.submitPrompt(state.chatId, "photo preparation", photos.promise);
    await Promise.resolve();
    assert(state.running.size === 1 && !state.session.isStreaming,
      "photo-preparation fixture is active before SDK streaming starts");
    await gateway.changeFolder(dirB);
    assertUntouched(gateway, "/cd preserves a prompt waiting for photo preparation before streaming");
    photos.resolve([]);
    await state.chain;
    assert(prompts.length === 1 && prompts[0].cwd === dirA && state.busy === 0,
      "photo preparation completes and the prompt runs after /cd is refused");
  }

  {
    const gateway = makeGateway();
    const {context, state, replies, prompts} = gateway;
    const validation = deferred();
    const started = deferred();
    const run = deferred();
    context.stat = () => validation.promise;
    gateway.setRunPrompt(async text => {
      if (text === "run during validation") { started.resolve(); await run.promise; }
    });
    const switching = gateway.changeFolder(dirB);
    context.submitPrompt(state.chatId, "run during validation");
    await started.promise;
    context.submitPrompt(state.chatId, "queued during validation");
    validation.resolve({isDirectory: () => true});
    await switching;
    assert(state.session.isStreaming && replies[0]?.includes("Chat activity changed"),
      "/cd detects a run that starts during directory validation and reports refusal");
    assertUntouched(gateway, "a validation race neither aborts the new run nor drops its queued follow-up");
    run.resolve();
    await state.chain;
    assert(prompts.length === 2 && prompts.every(prompt => prompt.cwd === dirA) && state.busy === 0,
      "the racing run and queued follow-up both finish in the original folder");
  }

  {
    const gateway = makeGateway();
    const {context, state, replies} = gateway;
    const validation = deferred();
    context.stat = () => validation.promise;
    const switching = gateway.changeFolder(dirB);
    // Even activity that finishes during validation must make /cd retry.
    await context.enqueueChatOp(state.chatId, async () => {});
    validation.resolve({isDirectory: () => true});
    await switching;
    assert(replies[0]?.includes("Chat activity changed"), "/cd notices command activity completed during validation");
    assertUntouched(gateway, "completed command activity cannot be overwritten by a stale /cd");
  }

  {
    const gateway = makeGateway();
    const {context, state, replies, metadata, effects} = gateway;
    const validation = deferred();
    context.stat = () => validation.promise;
    const switching = gateway.changeFolder(dirB);
    context.advanceChatGeneration(state);
    validation.resolve({isDirectory: () => true});
    await switching;
    assert(state.cwd === dirA && state.generation === 1 && metadata.size === 0 && effects.aborts === 0 &&
      effects.disposals === 0 && replies[0]?.includes("Folder change cancelled"),
    "a lifecycle generation change cancels pending /cd with feedback");
  }

  {
    const gateway = makeGateway();
    const {context, state, metadata, replies, effects, prompts} = gateway;
    const earlier = deferred();
    const later = deferred();
    context.stat = path => path === dirB ? earlier.promise : later.promise;
    const first = gateway.changeFolder(dirB);
    const second = gateway.changeFolder(dirEmpty);
    later.resolve({isDirectory: () => true});
    await second;
    await state.sessionReset;
    earlier.resolve({isDirectory: () => true});
    await first;
    assert(state.cwd === dirEmpty && metadata.get(state.chatId)?.cwd === dirEmpty && state.generation === 1 &&
      replies.some(reply => reply.includes("Folder change cancelled")),
    "an older /cd cannot overwrite a newer completed folder switch");
    assert(effects.disposals === 1 && effects.removals === 0,
      "an idle folder switch replaces the session once and keeps history");
    context.submitPrompt(state.chatId, "continue in new folder");
    await state.chain;
    assert(prompts.length === 1 && prompts[0].cwd === dirEmpty,
      "the next prompt after an idle switch uses the new folder");
  }
}

const base = mkdtempSync(join(tmpdir(), "pi-gw-cd-"));
const agentDir = join(base, "agent");
const sessionsDir = join(base, "sessions");
const dirA = join(base, "folder-a");
const dirB = join(base, "folder-b");
const dirEmpty = join(base, "empty-project");
const sessions = new Set();
try {
  for (const dir of [agentDir, sessionsDir, dirEmpty, join(dirA, ".pi"), join(dirB, ".pi")]) mkdirSync(dir, {recursive: true});
  const globalSettings = JSON.stringify({compaction: {enabled: false}, cacheWarming: {enabled: false}});
  writeFileSync(join(agentDir, "settings.json"), globalSettings);
  for (const [dir, marker, thinking] of [[dirA, "PROJECT_A_ONLY", "low"], [dirB, "PROJECT_B_ONLY", "high"]]) {
    writeFileSync(join(dir, "AGENTS.md"), marker);
    writeFileSync(join(dir, ".pi", "settings.json"), JSON.stringify({defaultThinkingLevel: thinking, prompts: ["configured.md"]}));
    writeFileSync(join(dir, ".pi", "configured.md"), marker + " prompt");
  }
  // Temp credential/catalog paths ensure the test never reads the owner\'s pi config.
  const runtime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json"),
    modelsStorePath: join(agentDir, "catalog.json"), refreshOnCreate: false,
  });
  const model = runtime.getModels().find(model => model.type === "chat");
  assert(model, "a static model is available for offline request construction");
  runtime.hasConfiguredAuth = () => true;
  const requests = [];
  runtime.streamSimple = (requestModel, context) => {
    requests.push(structuredClone(context));
    const stream = createAssistantMessageEventStream();
    const message = {
      role: "assistant", content: [{type: "text", text: "OFFLINE_REPLY"}],
      api: requestModel.api, provider: requestModel.provider, model: requestModel.id,
      usage: {input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0}},
      stopReason: "stop", timestamp: Date.now(),
    };
    stream.push({type: "done", reason: "stop", message});
    stream.end(message);
    return stream;
  };

  // Extract and execute production session creation without gateway bootstrap.
  const source = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
  const ast = ts.createSourceFile("index.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const factory = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "createChatSession");
  assert(factory, "production chat-session factory is present");
  const chatMeta = new Map([[42, {thinking: "medium"}]]);
  const sandbox = vm.createContext({
    join, SessionManager, createChatResources, syncChatCwdContext, resolveCliModel,
    SESSIONS_DIR: sessionsDir, AGENT_DIR: agentDir, modelRuntime: runtime, chatMeta,
    MODEL_ARG: undefined, THINKING_ARG: undefined, APPEND_PROMPT: "GATEWAY_APPEND_ONLY",
    CHAT_HINT: ["GATEWAY_HINT_ONLY"], log: () => {},
    createAgentSession: async options => {
      const result = await createAgentSession({...options, model: options.model ?? model});
      sessions.add(result.session);
      return result;
    },
  });
  vm.runInContext(ts.transpileModule(factory.getText(ast), {compilerOptions: {target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.None}}).outputText, sandbox);

  const folders = new Map([[42, "D:/synthetic-project"], [43, "D:/中文 folder"]]);
  const restored = parseChatMeta(serializeChatMeta(new Map([...folders].map(([id, cwd]) => [id, {cwd}]))));
  assert([...folders].every(([id, cwd]) => restored.get(id)?.cwd === cwd), "cwd metadata survives a restart round trip");
  const legacy = parseChatMeta('{"42":"D:/legacy","43":{"cwd":"D:/structured"},"44":null}');
  assert(legacy.get(42)?.cwd === "D:/legacy" && !legacy.has(44), "legacy metadata remains readable and invalid entries are ignored");

  const create = cwd => sandbox.createChatSession(42, cwd);
  const file = join(sessionsDir, "chat-42.jsonl");
  const first = await create(dirA);
  await first.prompt("Remember our existing conversation");
  assert(first.sessionFile === file, "first run uses the per-chat history file");
  assert(getCurrentSystemPrompt(requests.at(-1).messages).includes("PROJECT_A_ONLY"), "first request includes project A instructions");
  assert(first.messages.every(message => message.customType !== "gateway-working-folder"), "fresh conversation needs no folder-change boundary");
  first.dispose();

  const second = await create(dirB);
  assert(second.sessionFile === file, "/cd retains the same history file");
  assert(second.messages.some(message => message.role === "user" && JSON.stringify(message.content).includes("Remember our existing conversation")), "/cd retains prior conversation messages");
  assert(second.settingsManager.getProjectSettings().defaultThinkingLevel === "high", "project settings come from B and survive loader reload");
  assert(second.thinkingLevel === "medium", "per-chat thinking preference survives the folder switch");
  assert(second.resourceLoader.getPrompts().prompts.some(prompt => prompt.content.includes("PROJECT_B_ONLY")), "project-configured prompt resources come from B");
  const readTool = second.agent.state.tools.find(tool => tool.name === "read");
  const readResult = await readTool.execute("offline-cwd-check", {path: "AGENTS.md"});
  assert(JSON.stringify(readResult.content).includes("PROJECT_B_ONLY"), "file tools resolve relative paths in the new folder");
  const boundary = second.messages.findLast(message => message.customType === "gateway-working-folder");
  assert(boundary?.details.cwd === dirB && boundary.content.includes("historical"), "folder boundary identifies B and scopes earlier instructions");
  const before = second.messages.length;
  await syncChatCwdContext(second, dirB);
  assert(second.messages.length === before, "reopening the same folder does not duplicate the boundary");
  await second.prompt("Continue in the new folder");
  const requestB = requests.at(-1);
  const activeB = getCurrentSystemPrompt(requestB.messages);
  assert(activeB.includes("PROJECT_B_ONLY") && !activeB.includes("PROJECT_A_ONLY"), "next request replaces the active project instructions");
  assert(activeB.includes("GATEWAY_HINT_ONLY") && activeB.includes("GATEWAY_APPEND_ONLY"), "gateway instructions remain in the new prompt");
  assert(!JSON.stringify(resolveTranscript(requestB, false)).includes("PROJECT_A_ONLY"), "collapsed provider request omits historical project A instructions");
  assert(requestB.messages.some(message => message.role === "system" && message.sections?.project_context?.includes("PROJECT_B_ONLY")), "native transcript carries a project-context replacement");
  const other = await sandbox.createChatSession(43, dirA);
  assert(other.resourceLoader !== second.resourceLoader && other.settingsManager !== second.settingsManager, "chats do not share mutable loaders or settings");
  assert(other.settingsManager.getProjectSettings().defaultThinkingLevel === "low", "another chat keeps project A settings");
  second.settingsManager.setDefaultModelAndProvider("synthetic-provider", "synthetic-model");
  await second.settingsManager.flush();
  assert(readFileSync(join(agentDir, "settings.json"), "utf8") === globalSettings, "runtime settings changes never rewrite owner configuration");
  assert(JSON.parse(readFileSync(join(dirB, ".pi", "settings.json"), "utf8")).defaultThinkingLevel === "high", "project settings file remains unchanged");
  other.dispose();
  second.dispose();

  const empty = await create(dirEmpty);
  await empty.prompt("Continue without project-specific rules");
  const requestEmpty = requests.at(-1);
  assert(!getCurrentSystemPrompt(requestEmpty.messages).includes("PROJECT_B_ONLY"), "folder without AGENTS.md removes old active instructions");
  assert(requestEmpty.messages.some(message => message.role === "system" && message.sections?.project_context === null), "native transcript explicitly removes the old instruction section");
  empty.dispose();
  writeFileSync(join(dirA, "AGENTS.md"), "PROJECT_A_UPDATED");
  const returned = await create(dirA);
  await returned.prompt("Return to the first project");
  assert(getCurrentSystemPrompt(requests.at(-1).messages).includes("PROJECT_A_UPDATED"), "returning to a folder reloads changed instructions");
  assert(returned.messages.filter(message => message.customType === "gateway-working-folder").length === 3, "folder boundaries persist across switches and reopening");
  assert(returned.messages.some(message => message.role === "assistant" && message.content[0]?.text === "OFFLINE_REPLY"), "assistant history survives all folder switches");
  returned.dispose();
  await testCdCommand(ast, dirA, dirB, dirEmpty);
  console.log("\ncd-test passed ✅");
} finally {
  for (const session of sessions) session.dispose();
  rmSync(base, {recursive: true, force: true});
}
