// Offline /cd regression: real gateway factory, persisted SDK history, and mocked model requests.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  console.log("\ncd-test passed ✅");
} finally {
  for (const session of sessions) session.dispose();
  rmSync(base, {recursive: true, force: true});
}
