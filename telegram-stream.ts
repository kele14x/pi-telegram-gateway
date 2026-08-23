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

export class TelegramStream {
  private bot: Telegraf;
  private chatId: number;
  private segments: Segment[] = [{ text: "", msgId: null, version: 0 }];
  /** Deltas not yet moved into a segment (overflow buffer). */
  private pending = "";
  private status = "…";
  private lastEditAt = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** Pending retries of rate-limited edits (429). */
  private retryOps: DeliveryOp[] = [];
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
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
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    // A pending retry targets its own captured segment and may safely outlive
    // this reset. cancel() is used when the whole stream is being replaced.
  }

  /** Stop future delivery for this stream, retaining already in-flight calls. */
  cancel() {
    this.runId++;
    this.finished = true;
    this.canceled = true;
    this.pending = "";
    this.retryOps = [];
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
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
      try {
        if (seg.msgId === null) {
          const sent = await this.bot.telegram.sendMessage(this.chatId, clipped);
          seg.msgId = sent.message_id;
        } else {
          await this.bot.telegram.editMessageText(this.chatId, seg.msgId, undefined, clipped);
        }
        this.lastEditAt = Date.now();
      } catch (err) {
        // - "message is not modified" (identical content) is a no-op.
        // - 429 rate limits: retry this exact operation, unless a newer
        //   version has superseded it before the retry runs.
        const msg = String((err as Error)?.message ?? err);
        if (msg.includes("message is not modified")) return;
        log(`[edit] ${msg}`);
        const m = /retry after (\d+)/i.exec(msg);
        if (m && !this.canceled && version === seg.version) {
          this.retryOps.push({ seg, text, version });
          if (!this.retryTimer) {
            const delayMs = Math.min(Number(m[1]) * 1000 + 1500, 30_000);
            this.retryTimer = setTimeout(() => {
              this.retryTimer = null;
              const ops = this.retryOps.splice(0);
              for (const retry of ops) {
                void this.editOrSend(retry.seg, retry.text, retry.version);
              }
            }, delayMs);
          }
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
    // Post any sealed segments that never got a message.
    for (let i = 0; i < segs.length - 1; i++) {
      const seg = segs[i];
      if (seg.msgId === null) ops.push({ seg, text: seg.text, version: seg.version });
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
  }
}
