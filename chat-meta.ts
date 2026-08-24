import { renameSync, writeFileSync } from "node:fs";

/** Per-chat state persisted across restarts and session replacements. */
export interface ChatMetaEntry {
  /** Working folder (set by /cd). */
  cwd?: string;
  /** Resolved model id, e.g. "anthropic/claude-opus-4-5" (set by /model). */
  model?: string;
  /** Thinking level: off/minimal/low/medium/high/xhigh/max (set by /thinking). */
  thinking?: string;
}

/**
 * Parse meta.json content. Malformed chat ids and non-string fields are
 * skipped; invalid JSON throws so the caller can surface corruption
 * instead of silently resetting every chat's state.
 */
export function parseChatMeta(raw: string): Map<number, ChatMetaEntry> {
  const data = JSON.parse(raw) as Record<string, Partial<ChatMetaEntry> | null>;
  const entries = new Map<number, ChatMetaEntry>();
  for (const [key, value] of Object.entries(data)) {
    const id = Number(key);
    if (!Number.isInteger(id)) continue;
    const entry: ChatMetaEntry = {};
    if (typeof value?.cwd === "string") entry.cwd = value.cwd;
    if (typeof value?.model === "string") entry.model = value.model;
    if (typeof value?.thinking === "string") entry.thinking = value.thinking;
    if (entry.cwd !== undefined || entry.model !== undefined || entry.thinking !== undefined) {
      entries.set(id, entry);
    }
  }
  return entries;
}

/**
 * Atomically write the full meta map: temp file + rename, so a crash
 * mid-write can never leave meta.json truncated/invalid.
 */
export function writeChatMeta(metaFile: string, entries: Map<number, ChatMetaEntry>): void {
  const tmp = `${metaFile}.tmp`;
  writeFileSync(tmp, JSON.stringify(Object.fromEntries(entries), null, 2));
  renameSync(tmp, metaFile);
}
