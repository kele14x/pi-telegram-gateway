import { SettingsManager } from "@earendil-works/pi-coding-agent";

/**
 * Create a settings manager with the same effective configuration as
 * the owner's pi installation, but backed only by memory. AgentSession writes
 * (notably /model and /thinking) therefore stay local to one Telegram chat.
 */
export function createChatSettingsManager(source: SettingsManager): SettingsManager {
  // Preserve both scopes: resource discovery reads project settings separately,
  // and loader.reload() must retain them without touching the owner's files.
  const contents = {
    global: JSON.stringify(source.getGlobalSettings()),
    project: JSON.stringify(source.getProjectSettings()),
  };
  return SettingsManager.fromStorage({
    withLock(scope, fn) {
      const next = fn(contents[scope]);
      if (next !== undefined) contents[scope] = next;
    },
  }, {
    projectTrusted: source.isProjectTrusted(),
  });
}
