import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export type EventFields = Record<string, string | number | boolean | null | undefined>;

export interface GatewayEventLog {
  readonly file: string;
  record(event: string, fields?: EventFields): void;
}

export interface EventLogOptions {
  maxLines?: number;
  redact?: (text: string) => string;
  /** Called on the first write failure after a success; recording never throws. */
  onError?: (err: unknown) => void;
}

const MAX_VALUE_LENGTH = 300;

function readLines(file: string): string[] {
  try {
    return readFileSync(file, "utf8").split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

/** Append-only JSON-lines lifecycle log that keeps roughly the newest `maxLines` entries. */
export function createEventLog(file: string, options: EventLogOptions = {}): GatewayEventLog {
  const maxLines = options.maxLines ?? 500;
  // Trim in batches so steady logging does not rewrite the file on every event.
  const trimAt = maxLines + Math.ceil(maxLines / 10);
  const redact = options.redact ?? ((text: string) => text);
  let lineCount: number | undefined;
  let failing = false;

  return {
    file,
    record(event, fields = {}) {
      const entry: Record<string, string | number | boolean | null> = { ts: new Date().toISOString(), event };
      for (const [key, value] of Object.entries(fields)) {
        if (value === undefined) continue;
        entry[key] = typeof value === "string" ? redact(value).slice(0, MAX_VALUE_LENGTH) : value;
      }
      try {
        mkdirSync(dirname(file), { recursive: true });
        lineCount ??= readLines(file).length;
        appendFileSync(file, `${JSON.stringify(entry)}\n`);
        lineCount++;
        if (lineCount > trimAt) {
          const kept = readLines(file).slice(-maxLines);
          writeFileSync(`${file}.tmp`, kept.map((line) => `${line}\n`).join(""));
          renameSync(`${file}.tmp`, file);
          lineCount = kept.length;
        }
        failing = false;
      } catch (err) {
        if (!failing) options.onError?.(err);
        failing = true;
        lineCount = undefined;
      }
    },
  };
}
