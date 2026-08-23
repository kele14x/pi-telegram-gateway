/**
 * Renders one agent run (one user message → agent_end) into Telegram.
 * Text accumulates into an editable message; when it grows past MAX_CHUNK the
 * full part is sealed and a fresh follow-up message continues the stream, so
 * long outputs never hit Telegram's single-message size limit.
 *
 * Concurrency model:
 * - Every Telegram send/edit is serialized through a private promise chain
 *   (ioChain), so two overlapping operations can never both observe
 *   `msgId === null` for the same segment → no duplicate messages.
 * - State is snapshotted per run. `reset()` swaps in a fresh segments array;
 *   I/O already in flight keeps operating on its own snapshot, so a previous
 *   run still finalizing after `reset()` cannot corrupt the new run's state
 *   (and `finished` is only ever set before the first await, never after a
 *   reset).
 * - 429 retries capture the exact segment+text they belong to, so a late
 *   retry can never apply an older run's text to a newer run's message.
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
}

export class TelegramStream {
  private bot: Telegraf;
  private chatId: number;
  private segments: Segment[] = [{ text: "", msgId: null }];
  /** Deltas not yet moved into a segment (overflow buffer). */
  private pending = "";
  private status = "…";
  private lastEditAt = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** Pending retries of rate-limited edits (429); each targets its own snapshot. */
  private retryOps: { seg: Segment; text: string }[] = [];
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private finished = false;
  /** Bumped by reset(); lets throttled flush timers from an older run bail out. */
  private runId = 0;
  /** Serializes every Telegram send/edit so no two ops race on msgId. */
  private ioChain: Promise<void> = Promise.resolve();

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
    this.pending = "";
    this.segments = [{ text: "", msgId: null }];
    this.status = "…";
    this.lastEditAt = 0;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    // A pending 429 retry targets its own captured seg+text, so it may safely
    // outlive this reset; it is deliberately NOT cleared here.
  }

  setStatus(text: string) {
    this.status = text;
    this.scheduleEdit(true);
  }

  append(delta: string) {
    if (this.finished || !delta) return;
    this.pending += delta;
    // Move pending into segments immediately; full segments are sealed here so
    // their text is never clipped by Telegram's 4096-char message limit.
    while (this.pending.length > 0) {
      const seg = this.open;
      const room = MAX_CHUNK - seg.text.length;
      if (room <= 0) {
        this.segments.push({ text: "", msgId: null });
        continue;
      }
      const take = Math.min(room, this.pending.length);
      seg.text += this.pending.slice(0, take);
      this.pending = this.pending.slice(take);
    }
    this.scheduleEdit(false);
  }

  private scheduleEdit(forceSoon: boolean) {
    if (this.timer) return;
    const runId = this.runId;
    const delay = forceSoon
      ? 120
      : Math.max(EDIT_MIN_INTERVAL_MS - (Date.now() - this.lastEditAt), 0);
    this.timer = setTimeout(() => {
      this.timer = null;
      if (runId !== this.runId) return; // superseded by a newer run
      this.flush();
    }, delay);
  }

  /** Create or update a segment's message. Runs on the serialized I/O chain. */
  private editOrSend(seg: Segment, text: string): Promise<void> {
    const op = this.ioChain.then(async () => {
      if (!text) return;
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
        // - "message is not modified" (identical content) is a no-op we can ignore.
        // - 429 rate limits: schedule a retry of THIS exact edit (seg+text
        //   captured) so the message still ends up correct (Telegram limits how
        //   fast a single message can be edited).
        const msg = String((err as Error)?.message ?? err);
        if (msg.includes("message is not modified")) return;
        log(`[edit] ${msg}`);
        const m = /retry after (\d+)/i.exec(msg);
        if (m) {
          this.retryOps.push({ seg, text });
          if (!this.retryTimer) {
            const delayMs = Math.min(Number(m[1]) * 1000 + 1500, 30_000);
            this.retryTimer = setTimeout(() => {
              this.retryTimer = null;
              const ops = this.retryOps.splice(0);
              for (const o of ops) void this.editOrSend(o.seg, o.text);
            }, delayMs);
          }
        }
      }
    });
    this.ioChain = op.catch(() => {});
    return op;
  }

  /** Groom pass for the current run (throttled timer). */
  private flush() {
    const segs = this.segments;
    const status = this.status;
    void (async () => {
      // Post any sealed segments that never got a message.
      for (let i = 0; i < segs.length - 1; i++) {
        const seg = segs[i];
        if (seg.msgId === null) await this.editOrSend(seg, seg.text);
      }
      let seg = segs[segs.length - 1];
      if (seg.text.length >= MAX_CHUNK) {
        await this.editOrSend(seg, seg.text);
        segs.push({ text: "", msgId: null });
        seg = segs[segs.length - 1];
      }
      await this.editOrSend(seg, seg.text || (status !== "…" ? status : ""));
    })();
  }

  /** Finalize the run: flush everything, append `extra` if given. */
  async finalize(extra?: string) {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    // `finished` is set synchronously here, before any await. If a reset()
    // lands while this finalize is still draining, the new run re-enables
    // appends; this run's ops keep working on the snapshot below.
    this.finished = true;
    const segs = this.segments;
    const status = this.status;

    // Plan the entire delivery against the snapshot, then drain it through
    // the serialized I/O chain.
    const ops: { seg: Segment; text: string }[] = [];
    // Post any sealed segments that never got a message.
    for (let i = 0; i < segs.length - 1; i++) {
      const seg = segs[i];
      if (seg.msgId === null) ops.push({ seg, text: seg.text });
    }
    let seg = segs[segs.length - 1];
    if (seg.text.length >= MAX_CHUNK) {
      ops.push({ seg, text: seg.text });
      segs.push({ text: "", msgId: null });
      seg = segs[segs.length - 1];
    }

    let lastText = seg.text;
    if (extra) lastText = lastText ? `${lastText}\n${extra}` : extra;
    if (!lastText && status && status !== "…") lastText = status;

    if (lastText) {
      // First ≤4096 chars go into the open segment's message; the rest become
      // additional messages.
      ops.push({ seg, text: lastText });
      for (let i = 4096; i < lastText.length; i += 4096) {
        ops.push({
          seg: { text: lastText.slice(i, i + 4096), msgId: null },
          text: lastText.slice(i, i + 4096),
        });
      }
    }

    for (const op of ops) void this.editOrSend(op.seg, op.text);
    // Resolve once everything enqueued above has been executed.
    await this.ioChain;
  }
}