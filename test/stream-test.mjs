// Offline test for TelegramStream using a mock bot. No Telegram or models needed.
// Run: node test/stream-test.mjs

import { TelegramStream } from "../telegram-stream.ts";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeMockBot() {
  const calls = { send: [], edit: [] };
  const messages = new Map(); // message_id -> latest text
  let nextId = 1;
  const bot = {
    telegram: {
      async sendMessage(chatId, text) {
        const message_id = nextId++;
        calls.send.push({ chatId, message_id, text });
        messages.set(message_id, text);
        return { message_id };
      },
      async editMessageText(chatId, message_id, _inline, text) {
        calls.edit.push({ chatId, message_id, text });
        messages.set(message_id, text);
        return { ok: true };
      },
    },
  };
  const finalState = () => [...messages.values()].join("");
  return { bot, calls, finalState };
}

let failures = 0;
function assert(cond, label) {
  if (cond) {
    console.log(`  ✓ ${label}`);
  } else {
    failures++;
    console.error(`  ✗ ${label}`);
  }
}

// ── Scenario A: only a status, then finalize with no text ──────────────────
{
  console.log("A) status-only run");
  const { bot, calls } = makeMockBot();
  const s = new TelegramStream(bot, 77);
  s.setStatus("⏳ thinking…");
  await sleep(300);
  await s.finalize();
  await sleep(100);
  assert(calls.send.length === 1, "one message sent");
  assert(calls.send[0]?.text === "⏳ thinking…", `status text posted (got: ${JSON.stringify(calls.send[0])})`);
}

// ── Scenario B: short run, single streamed message ─────────────────────────
{
  console.log("B) short run");
  const { bot, calls } = makeMockBot();
  const s = new TelegramStream(bot, 77);
  s.setStatus("⏳ thinking…");
  await sleep(200);
  s.append("Hello ");
  s.append("world");
  await sleep(1000); // let throttled edits run
  await s.finalize();
  await sleep(100);
  assert(calls.send.length === 1, "one send");
  const edits = calls.edit.map((e) => e.text);
  assert(edits.some((t) => t === "Hello world"), "final text present in edits");
  // last message state = "Hello world"
  const last = calls.edit[calls.edit.length - 1];
  assert(last?.text === "Hello world", `final edit is 'Hello world' (got: ${JSON.stringify(last)})`);
}

// ── Scenario C: 12k chars → chunked into multiple messages, all content kept ─
{
  console.log("C) long run (12,340 chars)");
  const { bot, calls, finalState } = makeMockBot();
  const s = new TelegramStream(bot, 77);
  const big = "M".repeat(12_340);
  for (let i = 0; i < big.length; i += 137) s.append(big.slice(i, i + 137));
  await sleep(1200);
  await s.finalize();
  await sleep(150);
  const posted = [...calls.send, ...calls.edit].map((c) => c.text);
  assert(posted.length >= 5, "content spread over ≥5 posted texts");
  assert(posted.every((p) => p.length <= 4096), "no message exceeds 4096 chars");
  assert(finalState() === big, "all content preserved in final message state");
  assert(calls.send.length >= 3, "at least 3 real sends (chunks)");
}

// ── Scenario D: reset between runs ──────────────────────────────────────────
{
  console.log("D) reset between runs");
  const { bot, calls } = makeMockBot();
  const s = new TelegramStream(bot, 77);
  s.append("first run");
  await sleep(1000);
  await s.finalize();
  s.reset();
  s.append("second run");
  await sleep(1000);
  await s.finalize();
  await sleep(100);
  const texts = [...calls.send.map((c) => c.text), ...calls.edit.map((c) => c.text)];
  assert(texts.some((t) => t === "first run"), "first run delivered");
  assert(texts.some((t) => t === "second run"), "second run delivered");
}

// ── Scenario E: error note appended at finalize ─────────────────────────────
{
  console.log("E) error note");
  const { bot, calls } = makeMockBot();
  const s = new TelegramStream(bot, 77);
  s.append("partial answer");
  await sleep(1000);
  await s.finalize("\n\n⚠️ API error: boom");
  await sleep(100);
  const last = calls.edit[calls.edit.length - 1];
  assert(last?.text.includes("⚠️ API error: boom"), "error note appended to answer");
}

// ── Scenario F: 12k chars in a single append burst ─────────────────────────
{
  console.log("F) single burst (12,340 chars)");
  const { bot, calls, finalState } = makeMockBot();
  const s = new TelegramStream(bot, 77);
  const big = "Z".repeat(12_340);
  s.append(big);
  await sleep(1200);
  await s.finalize();
  await sleep(150);
  const posted = [...calls.send, ...calls.edit].map((c) => c.text);
  assert(calls.send.length >= 3, "content spread over ≥3 sends");
  assert(posted.every((p) => p.length <= 4096), "no message exceeds 4096 chars");
  assert(finalState() === big, "all content preserved in final message state");
}

// ── Scenario G: edit hits 429 rate limit, retry eventually lands ─────────
{
  console.log("G) 429 rate-limit retry");
  const calls = { send: [], edit: [] };
  const messages = new Map();
  let nextId = 1;
  let editFailuresLeft = 3;
  const bot = {
    telegram: {
      async sendMessage(chatId, text) {
        const message_id = nextId++;
        calls.send.push({ message_id, text });
        messages.set(message_id, text);
        return { message_id };
      },
      async editMessageText(chatId, message_id, _inline, text) {
        if (editFailuresLeft > 0) {
          editFailuresLeft--;
          throw new Error("Too Many Requests: retry after 1");
        }
        calls.edit.push({ message_id, text });
        messages.set(message_id, text);
        return { ok: true };
      },
    },
  };
  const s = new TelegramStream(bot, 77);
  s.append("rate limited?");
  await sleep(1000);          // initial send
  await s.finalize();         // edit → 429 (schedules retry)
  await sleep(3500);          // retry #1 → 429 again
  await sleep(3500);          // retry #2 → 429 again
  await sleep(3500);          // retry #3 → success
  assert([...messages.values()].join("") === "rate limited?", "final text landed after retries");
  assert(calls.send.length >= 1 && calls.edit.length >= 1, "send + successful edit recorded");
}

// ── Scenario H: slow API — overlapping flush and finalize must not double-send ─
{
  console.log("H) concurrent flush + finalize (slow sendMessage)");
  const sends = [];
  const edits = [];
  const nextId = [1];
  const bot = {
    telegram: {
      async sendMessage(chatId, text) {
        await sleep(50); // slow API: an unserialized stream used to double-send here
        const message_id = nextId[0]++;
        sends.push({ chatId, message_id, text });
        return { message_id };
      },
      async editMessageText(chatId, message_id, _inline, text) {
        edits.push({ chatId, message_id, text });
        return { ok: true };
      },
    },
  };
  const s = new TelegramStream(bot, 77);
  s.append("hello");
  await sleep(30); // throttled flush has started; its sendMessage is still pending
  await s.finalize(); // finalize must queue BEHIND the in-flight flush op
  await sleep(100);
  assert(sends.length === 1, `exactly one sendMessage (got ${sends.length})`);
  assert(sends[0]?.text === "hello", "content delivered");
  assert(edits.length >= 1, "second op was an edit, not a second send");
}

// ── Scenario I: slow API — reset while the previous run is still finalizing ──
{
  console.log("I) reset during an in-flight finalize (slow sendMessage)");
  const sends = [];
  const messages = new Map();
  const nextId = [1];
  const bot = {
    telegram: {
      async sendMessage(chatId, text) {
        await sleep(50);
        const message_id = nextId[0]++;
        sends.push({ chatId, message_id, text });
        messages.set(message_id, text);
        return { message_id };
      },
      async editMessageText(chatId, message_id, _inline, text) {
        messages.set(message_id, text);
        return { ok: true };
      },
    },
  };
  const s = new TelegramStream(bot, 77);
  s.append("first run");
  await sleep(30); // old run's send is pending in the I/O chain
  const fin = s.finalize();
  s.reset(); // new run starts while the old finalize is mid-flight
  s.append("second run");
  await sleep(200);
  await fin;
  await sleep(50);
  assert(sends.length === 2, `two messages sent (got ${sends.length})`);
  assert(sends[0]?.text === "first run", "old run delivered first");
  assert(sends[1]?.text === "second run", "new run delivered second");
  const state = [...messages.values()].join("|");
  assert(state.includes("first run") && state.includes("second run"), "both runs present, no cross-contamination");
}

// ── Scenario J: stale 429 retry must not overwrite a newer edit ─────────────
{
  console.log("J) stale 429 retry does not regress newer content");
  const calls = [];
  const messages = new Map([[1, "a"]]);
  let failNextEdit = true;
  const bot = {
    telegram: {
      async sendMessage(chatId, text) {
        calls.push({ type: "send", chatId, text });
        return { message_id: 1 };
      },
      async editMessageText(chatId, message_id, _inline, text) {
        calls.push({ type: "edit", chatId, message_id, text });
        if (failNextEdit) {
          failNextEdit = false;
          throw new Error("429: Too Many Requests: retry after 0");
        }
        messages.set(message_id, text);
        return { ok: true };
      },
    },
  };
  const s = new TelegramStream(bot, 77);
  s.append("a");
  await sleep(100);
  s.append("b");
  await sleep(900); // edit of "ab" fails and schedules a retry
  s.append("c");
  await sleep(300); // newer "abc" edit succeeds before the retry
  await sleep(1800); // allow retry timer to fire
  assert(messages.get(1) === "abc", `newer content remains (got ${JSON.stringify(messages.get(1))})`);
  assert(calls.some((c) => c.text === "ab") && calls.some((c) => c.text === "abc"), "both edits were attempted");
}

if (failures === 0) {
  console.log("\nAll stream tests passed ✅");
} else {
  console.error(`\n${failures} test(s) failed ❌`);
  process.exit(1);
}