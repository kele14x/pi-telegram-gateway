/**
 * Renders one agent run (one user message → agent_end) into Telegram.
 * Text accumulates into an editable message; when it grows past MAX_CHUNK the
 * full part is sealed and a fresh follow-up message continues the stream, so
 * long outputs never hit Telegram's single-message size limit.
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

const MAX_CHUNK = 3900; // Telegram hard limit is 4096 chars
const EDIT_MIN_INTERVAL_MS = 800;
const MAX_DELIVERY_ATTEMPTS = 4;
const TRANSIENT_RETRY_BASE_MS = 500;

function log(...args: unknown[]) {
  console.log(new Date().toISOString(), ...args);
}

interface Segment {
  text: string;
  msgId: number | null;
  /** Increments whenever the desired content for this segment changes. */
  version: number;
}

interface DeliveryOp {
  seg: Segment;
  text: string;
  version: number;
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
  private segments: Segment[] = [{ text: "", msgId: null, version: 0 }];
  /** Deltas not yet moved into a segment (overflow buffer). */
  private pending = "";
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

  constructor(bot: Telegraf, chatId: number) {
    this.bot = bot;
    this.chatId = chatId;
  }

  private get open() {
    return this.segments[this.segments.length - 1];
  }

  hasText(): boolean {
    return this.segments.some((s) => s.text.length > 0) || this.pending.length > 0;
  }

  /** Begin a new run (new user message). */
  reset() {
    this.runId++;
    this.finished = false;
    this.canceled = false;
    this.pending = "";
    this.segments = [{ text: "", msgId: null, version: 0 }];
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
    this.pending = "";
    this.deliveryFailures.clear();
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  setStatus(text: string) {
    if (this.finished || this.canceled) return;
    // Status is only rendered when the open segment has no text. Treat a
    // status-only change as a segment-content change for retry invalidation.
    if (this.open.text.length === 0) this.open.version++;
    this.status = text;
    this.scheduleEdit(true);
  }

  append(delta: string) {
    if (this.finished || this.canceled || !delta) return;
    // The initial "thinking" status is no longer useful once real answer text
    // exists. This also avoids a stray status-only message at exactly 3900 chars.
    this.status = "…";
    this.pending += delta;
    // Move pending into segments immediately; full segments are sealed here so
    // their text is never clipped by Telegram's 4096-char message limit.
    while (this.pending.length > 0) {
      const seg = this.open;
      const room = MAX_CHUNK - seg.text.length;
      if (room <= 0) {
        this.segments.push({ text: "", msgId: null, version: 0 });
        continue;
      }
      const take = Math.min(room, this.pending.length);
      seg.text += this.pending.slice(0, take);
      seg.version++;
      this.pending = this.pending.slice(take);
    }
    this.scheduleEdit(false);
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
  private editOrSend(seg: Segment, text: string, version = seg.version): Promise<void> {
    const op = this.ioChain.then(async () => {
      // A newer append/status/finalize has superseded this delivery operation.
      if (this.canceled || version !== seg.version || !text) return;
      const clipped = text.slice(0, 4096);
      for (let attempt = 1; attempt <= MAX_DELIVERY_ATTEMPTS; attempt++) {
        if (this.canceled || version !== seg.version) return;
        try {
          if (seg.msgId === null) {
            const sent = await this.bot.telegram.sendMessage(this.chatId, clipped);
            seg.msgId = sent.message_id;
          } else {
            await this.bot.telegram.editMessageText(this.chatId, seg.msgId, undefined, clipped);
          }
          this.lastEditAt = Date.now();
          this.deliveryFailures.delete(seg);
          return;
        } catch (err) {
          const msg = String((err as Error)?.message ?? err);
          if (msg.includes("message is not modified")) {
            this.deliveryFailures.delete(seg);
            return;
          }
          const retryable = isRetryableDeliveryError(err);
          if (!retryable || attempt === MAX_DELIVERY_ATTEMPTS) {
            if (!this.canceled && version === seg.version) this.deliveryFailures.set(seg, version);
            log(`[edit] delivery failed after ${attempt} attempt${attempt === 1 ? "" : "s"}: ${msg}`);
            return;
          }
          const retryAfter = retryAfterSeconds(err);
          const delayMs = retryAfter === undefined
            ? Math.min(TRANSIENT_RETRY_BASE_MS * 2 ** (attempt - 1), 30_000)
            : Math.min(retryAfter * 1000 + 250, 30_000);
          log(`[edit] attempt ${attempt}/${MAX_DELIVERY_ATTEMPTS} failed: ${msg}; retrying in ${delayMs}ms`);
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
    const status = this.status;
    const promise = (async () => {
      // Post any sealed segments that never got a message.
      for (let i = 0; i < segs.length - 1; i++) {
        const seg = segs[i];
        if (seg.msgId === null) await this.editOrSend(seg, seg.text, seg.version);
      }
      let seg = segs[segs.length - 1];
      if (seg.text.length >= MAX_CHUNK) {
        await this.editOrSend(seg, seg.text, seg.version);
        segs.push({ text: "", msgId: null, version: 0 });
        seg = segs[segs.length - 1];
      }
      await this.editOrSend(seg, seg.text || (status !== "…" ? status : ""), seg.version);
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
    const status = this.status;

    // Let a flush that already started finish planning against this snapshot
    // before planning the final delivery. Flushes from a later reset are not
    // included because the snapshot is captured above.
    await Promise.all(
      this.activeFlushes
        .filter((flush) => flush.segs === segs)
        .map((flush) => flush.promise),
    );

    // Plan the entire delivery against the snapshot, then drain it through the
    // serialized I/O chain.
    const ops: DeliveryOp[] = [];
    // Reconcile every sealed segment, including one whose final edit failed
    // after an earlier partial version had already received a message id.
    for (let i = 0; i < segs.length - 1; i++) {
      const seg = segs[i];
      ops.push({ seg, text: seg.text, version: seg.version });
    }

    let seg = segs[segs.length - 1];
    if (seg.text.length >= MAX_CHUNK) {
      ops.push({ seg, text: seg.text, version: seg.version });
      segs.push({ text: "", msgId: null, version: 0 });
      seg = segs[segs.length - 1];
    }

    let lastText = seg.text;
    if (extra) {
      // Invalidate any retry for the pre-extra content.
      seg.version++;
      lastText = lastText ? `${lastText}\n${extra}` : extra;
    }
    if (!lastText && status && status !== "…") lastText = status;

    if (lastText) {
      // First ≤4096 chars go into the open segment's message; the rest become
      // additional messages.
      ops.push({ seg, text: lastText, version: seg.version });
      for (let i = 4096; i < lastText.length; i += 4096) {
        const text = lastText.slice(i, i + 4096);
        ops.push({
          seg: { text, msgId: null, version: 0 },
          text,
          version: 0,
        });
      }
    }

    for (const op of ops) void this.editOrSend(op.seg, op.text, op.version);
    // Resolve once everything planned above has executed.
    await this.ioChain;
    if (ops.some((op) => this.deliveryFailures.get(op.seg) === op.version)) {
      throw new Error("Telegram delivery failed after retries");
    }
  }
}
