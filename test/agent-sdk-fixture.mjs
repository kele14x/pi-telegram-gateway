import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { startAgentWorker, createChatSession } from "../agent-worker.ts";

const gates = new Map();
function record(kind, fields = {}) {
  console.log(`AGENT_FIXTURE ${JSON.stringify({ kind, pid: process.pid, ...fields })}`);
}
async function wait(chatId, tag) {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  gates.set(`${chatId}:${tag}`, resolve);
  record("sdk-waiting", { chatId, tag });
  await promise;
  gates.delete(`${chatId}:${tag}`);
}

const agentDir = process.env.PI_CODING_AGENT_DIR;
const runtime = await ModelRuntime.create({
  authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json"),
  modelsStorePath: join(agentDir, "catalog.json"), refreshOnCreate: false,
});
const model = runtime.getModels().find(value => value.type === "chat" && value.reasoning);
const plain = runtime.getModels().find(value => value.type === "chat" && !value.reasoning);
if (!model || !plain) throw new Error("No static models for the offline SDK test");
record("sdk-models", { plain: { provider: plain.provider, id: plain.id } });
runtime.getAvailable = async () => [model, plain];
runtime.getAvailableSnapshot = () => [model, plain];
runtime.hasConfiguredAuth = () => true;
runtime.checkAuth = async () => ({ type: "api_key", source: "offline fixture" });
runtime.refresh = async () => {};
runtime.streamSimple = (requestModel, context, options) => {
  const stream = createAssistantMessageEventStream();
  const latest = context.messages.at(-1);
  const input = typeof latest.content === "string" ? latest.content : latest.content.filter(value => value.type === "text").map(value => value.text).join("");
  let content;
  let stopReason = "stop";
  if (latest.role === "user" && input === "READ_PROJECT") {
    content = [{ type: "toolCall", id: "offline-read", name: "read", arguments: { path: "AGENTS.md" } }];
    stopReason = "toolUse";
  } else if (latest.role === "user" && input === "RUN_SHELL") {
    content = [{ type: "toolCall", id: "offline-bash", name: "bash", arguments: { command: "printf 'SHELL_OK:%s' \"${TELEGRAM_BOT_TOKEN-unset}\"" } }];
    stopReason = "toolUse";
  } else {
    const users = context.messages.filter(value => value.role === "user").length;
    content = [{ type: "text", text: latest.role === "toolResult" ? `SDK_TOOL:${input}` : `SDK_REPLY:${input}:users=${users}` }];
  }
  const message = {
    role: "assistant", content, api: requestModel.api, provider: requestModel.provider, model: requestModel.id,
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason, timestamp: Date.now(),
  };
  stream.push({ type: "start", partial: message });
  if (latest.role === "user" && input === "HOLD_RESPONSE") {
    const aborted = () => {
      message.stopReason = "aborted";
      stream.push({ type: "done", reason: "aborted", message });
      stream.end(message);
    };
    if (options.signal.aborted) aborted();
    else options.signal.addEventListener("abort", aborted, { once: true });
    record("sdk-stream-waiting");
    return stream;
  }
  if (content[0].type === "text") stream.push({ type: "text_delta", contentIndex: 0, delta: content[0].text, partial: message });
  stream.push({ type: "done", reason: stopReason, message });
  stream.end(message);
  return stream;
};
ModelRuntime.create = async () => runtime;
startAgentWorker(async command => {
  const session = await createChatSession(command);
  const runner = session.extensionRunner;
  const hasHandlers = runner.hasHandlers.bind(runner);
  runner.hasHandlers = event => event === "input" || hasHandlers(event);
  const emitInput = runner.emitInput.bind(runner);
  runner.emitInput = async (...args) => {
    const text = args[0];
    if (text.startsWith("RELEASE:")) gates.get(text.slice("RELEASE:".length))?.();
    if (text.startsWith("WAIT_INPUT:")) await wait(command.chatId, text.slice("WAIT_INPUT:".length));
    return emitInput(...args);
  };
  const before = runner.emitBeforeAgentStart.bind(runner);
  runner.emitBeforeAgentStart = async (...args) => {
    if (args[0].prompt?.startsWith("WAIT_START:")) await wait(command.chatId, args[0].prompt.slice("WAIT_START:".length));
    return before(...args);
  };
  const emit = runner.emit.bind(runner);
  runner.emit = async event => {
    if (event.type === "session_shutdown") {
      record("sdk-shutdown", { chatId: command.chatId });
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    return emit(event);
  };
  const dispose = session.dispose.bind(session);
  session.dispose = () => { record("sdk-dispose", { chatId: command.chatId }); dispose(); };
  return session;
});
