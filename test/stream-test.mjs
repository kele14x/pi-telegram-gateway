// Offline test for TelegramStream using a mock bot. No Telegram or models needed.
// Run: node test/stream-test.mjs

import { TelegramStream, chunkEnd } from "../telegram-stream.ts";
import { renderMarkdown, splitFormatted } from "../telegram-format.ts";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeMockBot() {
  const calls = { send: [], edit: [], delete: [] };
  const messages = new Map(); // message_id -> latest text
  const formatted = new Map();
  let nextId = 1;
  const bot = {
    telegram: {
      async sendMessage(chatId, text, extra = {}) {
        const message_id = nextId++;
        calls.send.push({ chatId, message_id, text, ...extra });
        messages.set(message_id, text);
        formatted.set(message_id, { text, ...extra });
        return { message_id };
      },
      async editMessageText(chatId, message_id, _inline, text, extra = {}) {
        calls.edit.push({ chatId, message_id, text, ...extra });
        messages.set(message_id, text);
        formatted.set(message_id, { text, ...extra });
        return { ok: true };
      },
      async deleteMessage(chatId, message_id) {
        calls.delete.push({ chatId, message_id });
        messages.delete(message_id);
        formatted.delete(message_id);
        return true;
      },
    },
  };
  const finalState = () => [...messages.values()].join("");
  return { bot, calls, finalState, formatted };
}

async function waitFor(predicate) {
  const deadline = Date.now() + 2500;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for mock delivery");
    await sleep(10);
  }
}

function validEntities({ text, entities = [] }) {
  return text.isWellFormed() && text.length <= 4096 && entities.every(entity => {
    const end = entity.offset + entity.length;
    return entity.offset >= 0 && entity.length > 0 && end <= text.length &&
      text.slice(0, entity.offset).isWellFormed() && text.slice(entity.offset, end).isWellFormed();
  }) && entities.every((entity, index) => entities.slice(index + 1).every(other => {
    const end = entity.offset + entity.length;
    const last = other.offset + other.length;
    if (end <= other.offset || last <= entity.offset) return true;
    if ([entity.type, other.type].some(type => type === "code" || type === "pre")) return false;
    const nested = (entity.offset <= other.offset && end >= last) ||
      (other.offset <= entity.offset && last >= end);
    return nested && [entity.type, other.type].some(type => ["bold", "italic", "strikethrough"].includes(type));
  }));
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
  await s.finalize();         // edit retries three times, then succeeds
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
  await sleep(900); // edit of "ab" fails and enters its bounded retry delay
  s.append("c");
  await sleep(1000); // stale retry exits; newer "abc" edit succeeds
  await s.finalize();
  assert(messages.get(1) === "abc", `newer content remains (got ${JSON.stringify(messages.get(1))})`);
  assert(calls.some((c) => c.text === "ab") && calls.some((c) => c.text === "abc"), "both edits were attempted");
}

// ── Scenario K: exact chunk boundary must not create a status-only message ──
{
  console.log("K) exact 3900-char boundary");
  const { bot, calls, finalState } = makeMockBot();
  const s = new TelegramStream(bot, 77);
  s.setStatus("⏳ thinking…");
  s.append("X".repeat(3900));
  await s.finalize();
  assert(calls.send.length === 1, `exactly one message sent (got ${calls.send.length})`);
  assert(finalState() === "X".repeat(3900), "no stray status-only continuation");
}

// ── Scenario L: transient non-429 transport errors are retried ──────────────
{
  console.log("L) transient ECONNRESET retry");
  let attempts = 0;
  const messages = [];
  const bot = {
    telegram: {
      async sendMessage(_chatId, text) {
        attempts++;
        if (attempts <= 2) {
          const err = new Error("socket hang up");
          err.code = "ECONNRESET";
          throw err;
        }
        messages.push(text);
        return { message_id: 1 };
      },
      async editMessageText() {
        return { ok: true };
      },
    },
  };
  const s = new TelegramStream(bot, 77);
  s.append("eventually delivered");
  await s.finalize();
  assert(attempts === 3, `delivery succeeded on third attempt (got ${attempts})`);
  assert(messages[0] === "eventually delivered", "transient failure did not lose the answer");
}

// ── Scenario M: exhausted transport retries make finalize reject ────────────
{
  console.log("M) exhausted transport retries are observable");
  let attempts = 0;
  const bot = {
    telegram: {
      async sendMessage() {
        attempts++;
        const err = new Error("connection reset");
        err.code = "ECONNRESET";
        throw err;
      },
      async editMessageText() {
        return { ok: true };
      },
    },
  };
  const s = new TelegramStream(bot, 77);
  s.append("cannot deliver");
  let rejected = false;
  try {
    await s.finalize();
  } catch (err) {
    rejected = String(err?.message ?? err).includes("delivery failed");
  }
  assert(attempts === 4, `retry bound is four attempts (got ${attempts})`);
  assert(rejected, "finalize reports terminal delivery failure");
}

// Unicode must remain valid in every API call, not just after rejoining chunks.
{
  console.log("N) emoji across streaming and finalization boundaries");
  for (const mode of ["burst", "split-delta", "final-extra"]) {
    const { bot, calls, finalState } = makeMockBot();
    const s = new TelegramStream(bot, 77);
    let expected;
    if (mode === "final-extra") {
      s.append("a");
      const extra = "b".repeat(4093) + "😀" + "c".repeat(4094) + "😀";
      expected = "a\n" + extra;
      await s.finalize(extra);
    } else {
      expected = "a".repeat(3899) + "😀" + "b";
      if (mode === "split-delta") {
        s.append(expected.slice(0, 3900));
        await sleep(50); // allow delivery before the low surrogate arrives
        s.append(expected.slice(3900));
      } else s.append(expected);
      await s.finalize();
    }
    const posted = [...calls.send, ...calls.edit].map(call => call.text);
    assert(posted.every(text => text.isWellFormed() && text.length <= 4096), `${mode}: all API payloads are valid and within the limit`);
    assert(finalState() === expected, `${mode}: complete content preserved`);
  }
}

{
  console.log("O) shared truncation boundary at the Telegram message limit");
  const astral = "\u{1D11E}";
  assert(chunkEnd("", 4096) === 0, "empty text has an empty boundary");
  assert(chunkEnd("short", 4096) === 5, "short text is preserved");
  assert(chunkEnd("a".repeat(4097), 4096) === 4096, "ASCII text uses the full limit");
  assert(chunkEnd("a".repeat(4095) + astral, 4096) === 4095, "straddling surrogate pair is excluded");
  assert(chunkEnd("a".repeat(4094) + astral + "tail", 4096) === 4096, "fitting surrogate pair is preserved");
}

// Formatting is native Telegram text/entities, without parse-mode escaping.
{
  console.log("P) screenshot-style Markdown and literal source text");
  const source = "😀 测试全绿，**明显的质量问题**\n\n### 1. `commands-scope.mjs` 文档\n- `npm test` **不包含**它\n- [文档](https://example.com/docs?q=a&b=c)\n\n<b>literal</b> & a < b; user_name; \\*literal\\*";
  const expected = "😀 测试全绿，明显的质量问题\n\n1. commands-scope.mjs 文档\n• npm test 不包含它\n• 文档\n\n<b>literal</b> & a < b; user_name; *literal*";
  const result = renderMarkdown(source);
  assert(result.text === expected, "Markdown markers become readable text; HTML and punctuation stay literal");
  assert(result.entities.some(entity => entity.type === "bold" &&
    result.text.slice(entity.offset, entity.offset + entity.length) === "明显的质量问题"), "Chinese bold has correct UTF-16 offsets after emoji");
  assert(result.entities.some(entity => entity.type === "code" &&
    result.text.slice(entity.offset, entity.offset + entity.length) === "commands-scope.mjs"), "inline filenames have code styling");
  assert(result.entities.some(entity => entity.type === "text_link" && entity.url.includes("q=a&b=c")), "links carry their destination as native entities");
  assert(validEntities(result), "heading styling never overlaps inline code");
  const { bot, calls, finalState } = makeMockBot();
  const s = new TelegramStream(bot, 77);
  s.append(source);
  await s.finalize();
  assert(finalState() === expected && calls.send[0]?.entities.length > 0, "gateway sends rendered text with entities");
}

{
  console.log("Q) code fences and bold across multiple messages");
  const code = 'const html = "<b>&😀</b>";\n'.repeat(400);
  const bold = "重要😀".repeat(1100);
  const source = "Intro\n\n```typescript\n" + code + "```\n\n**" + bold + "**";
  const expected = "Intro\n\n" + code.slice(0, -1) + "\n\n" + bold;
  const { bot, calls, formatted, finalState } = makeMockBot();
  const s = new TelegramStream(bot, 77);
  for (let i = 0; i < source.length; i += 137) s.append(source.slice(i, i + 137));
  await s.finalize();
  assert(finalState() === expected, "formatted chunks preserve all code and prose");
  assert([...calls.send, ...calls.edit].every(validEntities), "every payload and entity boundary is valid UTF-16");
  const entities = [...formatted.values()].flatMap(message => message.entities);
  assert(entities.filter(entity => entity.type === "pre" && entity.language === "typescript").length >= 3, "code styling and language survive message splits");
  assert(entities.filter(entity => entity.type === "bold").length >= 2, "bold survives a message split");
  assert(splitFormatted(renderMarkdown(source), 3900).every(chunk => chunk.text.length <= 3900), "chunking measures rendered text");
}

{
  console.log("R) incomplete Markdown is reconciled when delimiters arrive");
  const { bot, calls, formatted, finalState } = makeMockBot();
  const s = new TelegramStream(bot, 77);
  s.append("### Result\n**partial");
  await waitFor(() => calls.send.length > 0);
  assert(finalState().includes("**partial"), "unclosed inline markup stays readable during streaming");
  s.append(" answer**\n```js\nconst x = '<&>';\n");
  await waitFor(() => calls.edit.length > 0);
  assert([...formatted.values()].some(message => message.entities.some(entity => entity.type === "pre")), "open code fence streams as code");
  s.append("```\nDone");
  await s.finalize();
  assert(finalState() === "Result\npartial answer\nconst x = '<&>';\nDone", "completed delimiters update the existing message");
  assert([...calls.send, ...calls.edit].every(validEntities), "partial and complete rendering use valid entities");
}

{
  console.log("S) finishing a long link removes surplus streamed messages");
  const { bot, calls, formatted, finalState } = makeMockBot();
  const s = new TelegramStream(bot, 77);
  s.append("See [guide](https://example.com/" + "a".repeat(8000));
  await waitFor(() => calls.send.length >= 3);
  s.append(")");
  await s.finalize();
  assert(finalState() === "See guide", "final link label replaces its partial source across all chunks");
  assert(calls.delete.length === 2 && formatted.size === 1, "surplus temporary messages are removed on finalization");
  assert([...formatted.values()][0].entities.some(entity => entity.type === "text_link"), "the completed long link is still clickable");
}

{
  console.log("T) Telegram formatting rejection falls back once to plain text");
  for (const operation of ["send", "edit"]) {
    const { bot, calls, finalState, formatted } = makeMockBot();
    const s = new TelegramStream(bot, 77, () => {});
    if (operation === "edit") {
      s.setStatus("🔧 tool_name…");
      await waitFor(() => calls.send.length > 0);
      assert(calls.send[0].entities.length === 0, "status text is literal");
    }
    const method = operation === "send" ? "sendMessage" : "editMessageText";
    const deliver = bot.telegram[method];
    let attempts = 0;
    bot.telegram[method] = async (...args) => {
      attempts++;
      const extra = args[operation === "send" ? 2 : 4];
      if (extra.entities.length) {
        const err = new Error("Bad Request: can't parse entities");
        err.response = { error_code: 400 };
        throw err;
      }
      return deliver(...args);
    };
    s.append("**The answer** and `code`");
    await s.finalize();
    assert(attempts === 2 && finalState() === "The answer and code", `${operation}: one fallback delivers the complete answer`);
    assert([...formatted.values()][0].entities.length === 0, `${operation}: fallback explicitly clears formatting`);
  }
}

{
  console.log("U) native entities survive rate-limit retry");
  const { bot, calls } = makeMockBot();
  const deliver = bot.telegram.sendMessage;
  let attempts = 0;
  bot.telegram.sendMessage = async (...args) => {
    if (++attempts === 1) {
      const err = new Error("Too Many Requests");
      err.response = { error_code: 429, parameters: { retry_after: 0 } };
      throw err;
    }
    return deliver(...args);
  };
  const s = new TelegramStream(bot, 77, () => {});
  s.append("**Retry me**");
  await s.finalize();
  assert(attempts === 2 && calls.send[0].entities[0].type === "bold", "retry preserves the formatting payload");
}

{
  console.log("V) nested formats, tables, unsupported links, and empty fences");
  for (const source of ["**bold *italic* `code`**", "> [link](https://example.com) and `code`", "> > nested quote", "```\n```", "| A | B |\n|---|---|\n| x | y |", "[file](./a.ts) [unsafe](javascript:alert) \\_literal\\_", "1. one\n2. two\n   - [x] done\n   - [ ] todo"]) {
    const result = renderMarkdown(source);
    assert(result.text.length > 0 && validEntities(result), `${JSON.stringify(source)} has readable text and valid nesting`);
  }
  const invalid = renderMarkdown("[file](./a.ts) [unsafe](javascript:alert)");
  assert(invalid.entities.length === 0 && invalid.text.includes("javascript:alert"), "unsupported destinations stay visible without creating invalid entities");
  const boundary = splitFormatted(renderMarkdown("**" + "x".repeat(3900) + "**\n"), 3900);
  assert(boundary.length === 1 && boundary[0].text.length === 3900, "trailing newline at the chunk boundary cannot create an empty message");
}

{
  console.log("W) Markdown shrink during an in-flight continuation send");
  const { bot, calls, formatted, finalState } = makeMockBot();
  const deliver = bot.telegram.sendMessage;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let attempts = 0;
  bot.telegram.sendMessage = async (...args) => {
    if (++attempts === 2) await gate;
    return deliver(...args);
  };
  const s = new TelegramStream(bot, 77);
  s.append("See [guide](https://example.com/" + "a".repeat(8000));
  await waitFor(() => attempts === 2);
  s.append(")");
  const finishing = s.finalize();
  release();
  await finishing;
  assert(finalState() === "See guide" && formatted.size === 1, "late message id is removed after the final rendering shrinks");
  assert(calls.delete.length === 1, "only the continuation that actually posted is deleted");
}

if (failures === 0) {
  console.log("\nAll stream tests passed ✅");
} else {
  console.error(`\n${failures} test(s) failed ❌`);
  process.exit(1);
}
