/**
 * Renders one agent run (one user message → agent_end) into Telegram.
 * Markdown is rendered into native Telegram entities, then split at MAX_CHUNK.
 * Earlier messages are reconciled when completing Markdown changes their text
 * or formatting, so long outputs keep formatting across message boundaries.
 *
 * Concurrency model:
 * - Every Telegram send/edit is serialized through a private promise chain
 *   (ioChain), so two overlapping operations cannot both send an unposted
 *   segment.
 * - State is snapshotted per run. reset() swaps in a fresh segments array;
 *   in-flight I/O keeps operating on its own snapshot.
 * - Each segment has a version. Delayed retries for superseded content are
 *   discarded instead of overwriting a newer successful edit.
 */

import type { Telegraf } from "telegraf";
import { chunkEnd, renderMarkdown, splitFormatted, type FormattedText } from "./telegram-format.ts";
export { chunkEnd } from "./telegram-format.ts";

const MAX_CHUNK = 3900; // Telegram hard limit is 4096 chars
const EDIT_MIN_INTERVAL_MS = 800;
const MAX_DELIVERY_ATTEMPTS = 4;
const TRANSIENT_RETRY_BASE_MS = 500;

export type StreamLogger = (...args: unknown[]) => void;

const defaultLog: StreamLogger = (...args) => {
  console.log(new Date().toISOString(), ...args);
};

interface Segment extends FormattedText {
  msgId: number | null;
  delivered: string;
  /** Increments whenever the desired content for this segment changes. */
  version: number;
}

interface DeliveryOp {
  seg: Segment;
  text: string;
  entities: FormattedText["entities"];
  version: number;
  remove?: boolean;
}

function retryAfterSeconds(err: unknown): number | undefined {
  const response = (err as { response?: { parameters?: { retry_after?: unknown } } })?.response;
  const value = response?.parameters?.retry_after;
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
  const match = /retry after (\d+)/i.exec(String((err as Error)?.message ?? err));
  return match ? Number(match[1]) : undefined;
}

function errorStatus(err: unknown): number | undefined {
  const candidate = err as {
    response?: { error_code?: unknown; status?: unknown; statusCode?: unknown };
    status?: unknown;
    statusCode?: unknown;
  };
  for (const value of [candidate?.response?.error_code, candidate?.response?.status, candidate?.response?.statusCode, candidate?.status, candidate?.statusCode]) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
}

function isRetryableDeliveryError(err: unknown): boolean {
  if (retryAfterSeconds(err) !== undefined) return true;
  const status = errorStatus(err);
  if (status !== undefined) return status === 429 || status >= 500;
  const code = String((err as NodeJS.ErrnoException)?.code ?? "").toUpperCase();
  if (["ECONNRESET", "ECONNREFUSED", "EPIPE", "ETIMEDOUT", "EAI_AGAIN", "ENETUNREACH", "ENOTFOUND"].includes(code)) {
    return true;
  }
  // Errors without an HTTP/API status are normally transport/proxy failures.
  // Retry them within the same strict bound; known Telegram 4xx errors above
  // still fail immediately.
  return status === undefined;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

export class TelegramStream {
  private bot: Telegraf;
  private chatId: number;
  private segments: Segment[] = [];
  /** Markdown is retained for the whole run; message boundaries follow rendering. */
  private source = "";
  private status = "…";
  private lastEditAt = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** Terminal failures, keyed by the exact segment content version. */
  private deliveryFailures = new Map<Segment, number>();
  private finished = false;
  /** A canceled stream must not deliver operations planned before replacement. */
  private canceled = false;
  /** Bumped by reset(); lets throttled flush timers from an older run bail out. */
  private runId = 0;
  /** Serializes every Telegram send/edit so no two ops race on msgId. */
  private ioChain: Promise<void> = Promise.resolve();
  /** Flushes that have started planning operations but have not completed. */
  private activeFlushes: { segs: Segment[]; promise: Promise<void> }[] = [];
  private log: StreamLogger;

  constructor(bot: Telegraf, chatId: number, log: StreamLogger = defaultLog) {
    this.bot = bot;
    this.chatId = chatId;
    this.log = log;
  }

  hasText(): boolean {
    return this.source.length > 0;
  }

  /** Begin a new run (new user message). */
  reset() {
    this.runId++;
    this.finished = false;
    this.canceled = false;
    this.source = "";
    this.segments = [];
    this.status = "…";
    this.lastEditAt = 0;
    this.deliveryFailures.clear();
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /** Stop future delivery for this stream, retaining already in-flight calls. */
  cancel() {
    this.runId++;
    this.finished = true;
    this.canceled = true;
    this.invalidate();
    this.source = "";
    this.deliveryFailures.clear();
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  setStatus(text: string) {
    if (this.finished || this.canceled) return;
    // Status is only rendered when the run has no text. Treat a
    // status-only change as a segment-content change for retry invalidation.
    if (!this.hasText()) this.invalidate();
    this.status = text;
    this.scheduleEdit(true);
  }

  append(delta: string) {
    if (this.finished || this.canceled || !delta) return;
    // The initial "thinking" status is no longer useful once real answer text
    // exists. This also avoids a stray status-only message at exactly 3900 chars.
    this.status = "…";
    this.source += delta;
    this.invalidate();
    this.scheduleEdit(false);
  }

  private invalidate() {
    // A closing Markdown delimiter can change earlier text and entity offsets.
    // Invalidate retries for every segment before the next rendering pass.
    for (const seg of this.segments) seg.version++;
  }

  private reconcile(final = false, extra?: string): DeliveryOp[] {
    let source = this.source;
    const last = source.charCodeAt(source.length - 1);
    // Wait for the low surrogate if an emoji straddles provider deltas.
    if (last >= 0xd800 && last <= 0xdbff) {
      source = source.slice(0, -1) + (final ? "\ufffd" : "");
    }
    const value = source ? renderMarkdown(source) : { text: "", entities: [] };
    if (extra) value.text += (value.text ? "\n" : "") + extra;
    if (!value.text && !this.hasText() && this.status !== "…") value.text = this.status;
    const chunks = splitFormatted(value, MAX_CHUNK);
    const ops: DeliveryOp[] = [];
    for (let i = 0; i < Math.max(chunks.length, this.segments.length); i++) {
      const chunk = chunks[i] ?? { text: "", entities: [] };
      let seg = this.segments[i];
      if (!seg) {
        seg = { ...chunk, msgId: null, delivered: "", version: 0 };
        this.segments.push(seg);
      } else if (seg.text !== chunk.text || JSON.stringify(seg.entities) !== JSON.stringify(chunk.entities)) {
        seg.text = chunk.text;
        seg.entities = chunk.entities;
        seg.version++;
      }
      // A completed link/fence can shorten the rendering. Keep surplus message
      // slots until finalization so later deltas can reuse them in order.
      // Include unposted slots: an older send may still be in flight and assign
      // its message id before this removal reaches the serialized I/O chain.
      const remove = final && !chunk.text;
      const payload = JSON.stringify(chunk);
      if (remove || (chunk.text && (final || i === chunks.length - 1 || payload !== seg.delivered))) {
        ops.push({ seg, ...chunk, version: seg.version, remove });
      }
    }
    return ops;
  }

  private scheduleEdit(forceSoon: boolean) {
    if (this.timer || this.finished || this.canceled) return;
    const runId = this.runId;
    const delay = forceSoon
      ? 120
      : Math.max(EDIT_MIN_INTERVAL_MS - (Date.now() - this.lastEditAt), 0);
    this.timer = setTimeout(() => {
      this.timer = null;
      if (runId !== this.runId || this.finished || this.canceled) return;
      void this.flush();
    }, delay);
  }

  /** Create or update a segment's message on the serialized I/O chain. */
  private editOrSend({ seg, text, entities, version, remove }: DeliveryOp): Promise<void> {
    const op = this.ioChain.then(async () => {
      // A newer append/status/finalize has superseded this delivery operation.
      if (this.canceled || version !== seg.version || (!text && !remove)) return;
      const clipped = text.slice(0, chunkEnd(text, 4096));
      let useEntities = true;
      for (let attempt = 1; attempt <= MAX_DELIVERY_ATTEMPTS; attempt++) {
        if (this.canceled || version !== seg.version) return;
        try {
          if (remove) {
            if (seg.msgId !== null) await this.bot.telegram.deleteMessage(this.chatId, seg.msgId);
            seg.msgId = null;
          } else if (seg.msgId === null) {
            const sent = await this.bot.telegram.sendMessage(this.chatId, clipped, { entities: useEntities ? entities : [] });
            seg.msgId = sent.message_id;
          } else {
            await this.bot.telegram.editMessageText(this.chatId, seg.msgId, undefined, clipped, { entities: useEntities ? entities : [] });
          }
          seg.delivered = JSON.stringify({ text, entities });
          this.lastEditAt = Date.now();
          this.deliveryFailures.delete(seg);
          return;
        } catch (err) {
          const msg = String((err as Error)?.message ?? err);
          if (msg.includes("message is not modified")) {
            seg.delivered = JSON.stringify({ text, entities });
            this.deliveryFailures.delete(seg);
            return;
          }
          if (useEntities && entities.length && errorStatus(err) === 400 &&
              /(?:parse entities|entity|entities|unsupported url|wrong http url)/i.test(msg)) {
            // One formatting fallback, retaining the same transport retry bound.
            useEntities = false;
            attempt--;
            this.log("[edit] Telegram rejected formatting; retrying as plain text");
            continue;
          }
          const retryable = isRetryableDeliveryError(err);
          if (!retryable || attempt === MAX_DELIVERY_ATTEMPTS) {
            if (!this.canceled && version === seg.version) this.deliveryFailures.set(seg, version);
            this.log(`[edit] delivery failed after ${attempt} attempt${attempt === 1 ? "" : "s"}: ${msg}`);
            return;
          }
          const retryAfter = retryAfterSeconds(err);
          const delayMs = retryAfter === undefined
            ? Math.min(TRANSIENT_RETRY_BASE_MS * 2 ** (attempt - 1), 30_000)
            : Math.min(retryAfter * 1000 + 250, 30_000);
          this.log(`[edit] attempt ${attempt}/${MAX_DELIVERY_ATTEMPTS} failed: ${msg}; retrying in ${delayMs}ms`);
          await delay(delayMs);
        }
      }
    });
    this.ioChain = op.catch(() => {});
    return op;
  }

  /** Throttled edit pass for the current run. */
  private flush(): Promise<void> {
    const segs = this.segments;
    const ops = this.reconcile();
    const promise = (async () => {
      for (const op of ops) await this.editOrSend(op);
    })();
    const entry = { segs, promise };
    this.activeFlushes.push(entry);
    void promise.then(
      () => this.removeFlush(entry),
      () => this.removeFlush(entry),
    );
    return promise;
  }

  private removeFlush(entry: { segs: Segment[]; promise: Promise<void> }) {
    const index = this.activeFlushes.indexOf(entry);
    if (index >= 0) this.activeFlushes.splice(index, 1);
  }

  /** Finalize the run: flush everything, append `extra` if given. */
  async finalize(extra?: string) {
    if (this.finished || this.canceled) return;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    // `finished` is set synchronously before the first await. If reset() lands
    // while this finalize is waiting, the captured segment snapshot remains
    // independent from the new run.
    this.finished = true;
    const segs = this.segments;
    // Capture the rendering before yielding: reset() can start a new run while
    // this finalization waits for older I/O.
    this.invalidate();
    const ops = this.reconcile(true, extra);

    // Let an older flush drain before executing the captured final delivery.
    // Flushes from a later reset are excluded by the captured snapshot.
    await Promise.all(
      this.activeFlushes
        .filter((flush) => flush.segs === segs)
        .map((flush) => flush.promise),
    );

    for (const op of ops) void this.editOrSend(op);
    // Resolve once everything planned above has executed.
    await this.ioChain;
    if (ops.some((op) => this.deliveryFailures.get(op.seg) === op.version)) {
      throw new Error("Telegram delivery failed after retries");
    }
  }
}
