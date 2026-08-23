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

console.log("Per-chat settings isolation test passed ✅");
