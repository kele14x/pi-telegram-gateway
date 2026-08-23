import { rmSync } from "node:fs";
import { join } from "node:path";

type RemoveFile = (path: string, options: { force: true }) => void;

/** Remove one opaque SDK session file, propagating failure to the caller. */
export function removeChatHistory(
  sessionsDir: string,
  chatId: number,
  removeFile: RemoveFile = rmSync,
) {
  removeFile(join(sessionsDir, `chat-${chatId}.jsonl`), { force: true });
}
