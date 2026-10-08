// Offline test: per-chat settings must never mutate the owner's/global state.

import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { createChatSettingsManager } from "../chat-settings.ts";

const owner = SettingsManager.inMemory({
  defaultProvider: "provider-owner",
  defaultModel: "model-owner",
  defaultThinkingLevel: "medium",
});
const chatA = createChatSettingsManager(owner);
const chatB = createChatSettingsManager(owner);

chatA.setDefaultModelAndProvider("provider-a", "model-a");
chatA.setDefaultThinkingLevel("high");

if (owner.getDefaultProvider() !== "provider-owner" || owner.getDefaultModel() !== "model-owner") {
  throw new Error("chat A changed the owner's default model");
}
if (owner.getDefaultThinkingLevel() !== "medium") {
  throw new Error("chat A changed the owner's thinking level");
}
if (chatB.getDefaultProvider() !== "provider-owner" || chatB.getDefaultModel() !== "model-owner") {
  throw new Error("chat A changed chat B's model");
}
if (chatB.getDefaultThinkingLevel() !== "medium") {
  throw new Error("chat A changed chat B's thinking level");
}
if (chatA.getDefaultProvider() !== "provider-a" || chatA.getDefaultModel() !== "model-a") {
  throw new Error("chat A did not retain its isolated model");
}

// Resource loaders reload settings and read project scope separately from global.
const scopes = {
  global: JSON.stringify({ defaultThinkingLevel: "low" }),
  project: JSON.stringify({ defaultThinkingLevel: "high", prompts: ["project-prompt.md"] }),
};
const projectOwner = SettingsManager.fromStorage({
  withLock(scope, fn) {
    const next = fn(scopes[scope]);
    if (next !== undefined) scopes[scope] = next;
  },
});
const projectChat = createChatSettingsManager(projectOwner);
await projectChat.reload();
if (projectChat.getDefaultThinkingLevel() !== "high" || projectChat.getProjectSettings().prompts?.[0] !== "project-prompt.md") {
  throw new Error("isolated reload lost the project settings scope");
}
projectChat.setDefaultThinkingLevel("medium");
await projectChat.flush();
if (projectOwner.getGlobalSettings().defaultThinkingLevel !== "low" || projectOwner.getProjectSettings().defaultThinkingLevel !== "high") {
  throw new Error("isolated writes changed the source settings scopes");
}
const untrusted = createChatSettingsManager(SettingsManager.inMemory({}, { projectTrusted: false }));
await untrusted.reload();
if (untrusted.isProjectTrusted()) throw new Error("isolation changed project trust");

console.log("Per-chat settings isolation test passed ✅");
