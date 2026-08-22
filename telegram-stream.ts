/**
 * Renders one agent run (one user message → agent_end) into Telegram.
 * Text accumulates into an editable message; when it grows past MAX_CHUNK the
 * full part is sealed and a fresh follow-up message continues the stream, so
 * long outputs never hit Telegram's single-message size limit.
 */

import type { Telegraf } from "telegraf";

const MAX_CHUNK = 3900; // Telegram hard limit is 4096 chars
const EDIT_MIN_INTERVAL_MS = 800;

function log(...args: unknown[]) {
  console.log(new Date().toISOString(), ...args);
}

export class TelegramStream {
  private bot: Telegraf;
  private chatId: number;
  private segments: { text: string; msgId: number | null }[] = [
    { text: "", msgId: null },
  ];
  /** Deltas not yet moved into a segment (overflow buffer). */
  private pending = "";
  private status = "…";
  private lastEditAt = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private finished = false;

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
    this.finished = false;
    this.pending = "";
    this.segments = [{ text: "", msgId: null }];
    this.status = "…";
    this.lastEditAt = 0;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
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
    const delay = forceSoon
      ? 120
      : Math.max(EDIT_MIN_INTERVAL_MS - (Date.now() - this.lastEditAt), 0);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, delay);
  }

  /** Create or update a segment's Telegram message (sends if not yet posted). */
  private async editOrSend(seg: { text: string; msgId: number | null }, textOverride?: string) {
    const text = textOverride ?? (seg.text || (this.status !== "…" ? this.status : ""));
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
      // - transient errors (429 rate limits, network) are fine; the next
      //   flush / finalize retries.
      const msg = String((err as Error)?.message ?? err);
      if (!msg.includes("message is not modified")) log(`[edit] ${msg}`);
    }
  }

  /** Throttled edit pass: post sealed segments, update the open one. */
  private async flush() {
    // Post any sealed segments that never got a message (e.g. final burst
    // right before finalize, or content spilled during a single big delta).
    for (let i = 0; i < this.segments.length - 1; i++) {
      const seg = this.segments[i];
      if (seg.msgId === null) await this.editOrSend(seg);
    }
    let seg = this.open;
    if (seg.text.length >= MAX_CHUNK) {
      await this.editOrSend(seg);
      this.segments.push({ text: "", msgId: null });
      seg = this.open;
    }
    await this.editOrSend(seg);
  }

  /** Finalize the run: flush everything, append `extra` if given. */
  async finalize(extra?: string) {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.finished = true;

    // Post any sealed segments that never got a message.
    for (let i = 0; i < this.segments.length - 1; i++) {
      const seg = this.segments[i];
      if (seg.msgId === null) await this.editOrSend(seg);
    }

    let seg = this.open;
    if (seg.text.length >= MAX_CHUNK) {
      await this.editOrSend(seg);
      this.segments.push({ text: "", msgId: null });
      seg = this.open;
    }

    let lastText = seg.text;
    if (extra) lastText = lastText ? `${lastText}\n${extra}` : extra;
    if (!lastText && this.status && this.status !== "…") lastText = this.status;

    if (!lastText) return;

    // First ≤4096 chars go into the open segment's message; the rest become
    // additional messages.
    await this.editOrSend(seg, lastText);
    for (let i = 4096; i < lastText.length; i += 4096) {
      const chunk = lastText.slice(i, i + 4096);
      await this.editOrSend({ text: chunk, msgId: null }, chunk);
    }
  }
}