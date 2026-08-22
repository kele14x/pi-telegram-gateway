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

if (failures === 0) {
  console.log("\nAll stream tests passed ✅");
} else {
  console.error(`\n${failures} test(s) failed ❌`);
  process.exit(1);
}