import { SettingsManager } from "@earendil-works/pi-coding-agent";

/**
 * Create a settings manager with the same effective startup configuration as
 * the owner's pi installation, but backed only by memory. AgentSession writes
 * (notably /model and /thinking) therefore stay local to one Telegram chat.
 */
export function createChatSettingsManager(source: SettingsManager): SettingsManager {
  const isolated = SettingsManager.inMemory(source.getGlobalSettings(), {
    projectTrusted: source.isProjectTrusted(),
  });
  isolated.applyOverrides(source.getProjectSettings());
  return isolated;
}
