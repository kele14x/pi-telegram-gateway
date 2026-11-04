import type { ImageContent } from "@earendil-works/pi-ai";
import type { AgentSession } from "@earendil-works/pi-coding-agent";

export type ThinkingLevel = AgentSession["thinkingLevel"];
export type ModelSelection = { provider: string; id: string };

export interface SessionSnapshot {
  model?: ModelSelection;
  thinkingLevel: ThinkingLevel;
  sessionFile?: string;
  messageCount: number;
  isStreaming: boolean;
}

export type GatewayAgentEvent =
  | { type: "agent_start" | "message_start" }
  | { type: "message_update"; assistantMessageEvent: { type: "text_delta"; delta: string } }
  | { type: "message_end"; message: { role: string; stopReason?: string; errorMessage?: string } }
  | { type: "tool_execution_start"; toolName: string }
  | { type: "tool_execution_end"; toolName: string; isError: boolean }
  | { type: "agent_end"; willRetry: boolean }
  | { type: "auto_retry_end"; success: boolean; finalError?: string }
  | { type: "compaction_end"; errorMessage?: string };

export interface CreateSessionCommand {
  method: "create";
  sessionId: number;
  chatId: number;
  cwd: string;
  sessionsDir: string;
  model?: string;
  thinking?: string;
  storedModel?: string;
  storedThinking?: string;
  appendSystemPrompt: string[];
}

export type WorkerCommand =
  | CreateSessionCommand
  | { method: "prompt"; sessionId: number; generation: number; text: string; images?: ImageContent[]; streamingBehavior?: "followUp" }
  | { method: "cancel"; sessionId: number; generation: number }
  | { method: "abort" | "dispose" | "cycleModel" | "cycleThinking"; sessionId: number }
  | { method: "setModel"; sessionId: number; model: string }
  | { method: "setThinking"; sessionId: number; thinking: ThinkingLevel }
  | { method: "shutdown" };

export type WorkerRequest = { type: "request"; id: number; command: WorkerCommand } | { type: "ping" };
export type WorkerMessage =
  | { type: "ready" | "pong" }
  | { type: "reply"; id: number; state?: SessionSnapshot; result?: unknown; error?: { name: string; message: string } }
  | { type: "event"; sessionId: number; event: GatewayAgentEvent; state: SessionSnapshot }
  | { type: "log"; text: string }
  | { type: "lifecycle"; event: "model_fallback"; fields: { chat: number; stored: string; error?: string; using: string } };

export class AgentOperationCancelled extends Error {
  constructor() {
    super("Chat operation was superseded");
    this.name = "AgentOperationCancelled";
  }
}

export class AgentWorkerUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentWorkerUnavailable";
  }
}
