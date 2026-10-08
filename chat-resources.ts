import { DefaultResourceLoader, SettingsManager, type AgentSession } from "@earendil-works/pi-coding-agent";
import { createChatSettingsManager } from "./chat-settings.ts";

/** Fresh, isolated resources for a session's current folder, including on resume. */
export async function createChatResources(cwd: string, agentDir: string, appendSystemPrompt: string[] = []) {
  const settingsManager = createChatSettingsManager(SettingsManager.create(cwd, agentDir));
  const resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, appendSystemPrompt });
  await resourceLoader.reload();
  return { settingsManager, resourceLoader };
}

/** Keep history while making the current folder's instruction scope explicit. */
export async function syncChatCwdContext(session: AgentSession, cwd: string): Promise<void> {
  if (session.messages.length === 0) return;
  const content = [
    `Working-folder context: the current working folder is ${JSON.stringify(cwd)}.`,
    "Use the current project instructions and resources loaded for this folder, including applicable ancestor instructions.",
    "Earlier project instructions in the conversation are historical and apply only where they are still part of the current project's instructions.",
    "Conversation history is retained; do not assume that earlier relative paths or project-specific decisions refer to this folder.",
  ].join("\n");
  const previous = session.messages.findLast((message) =>
    message.role === "custom" && message.customType === "gateway-working-folder",
  );
  if (previous?.role === "custom" && previous.content === content) return;
  await session.sendCustomMessage({
    customType: "gateway-working-folder", content, display: false, details: { cwd },
  }, { triggerTurn: false });
}
