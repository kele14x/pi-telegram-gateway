// Inspect per-scope registered commands (Telegram supports scoped command lists).
// Usage: node test/commands-scope.mjs
import { readFileSync } from "node:fs";
import dns from "node:dns";
import https from "node:https";

const envLines = readFileSync(new URL("../.env", import.meta.url), "utf8").split(/\r?\n/);
const token = envLines.find((l) => l.startsWith("TELEGRAM_BOT_TOKEN="))?.slice("TELEGRAM_BOT_TOKEN=".length).trim() ?? "";
// Optional: check the scope bound to a specific chat. Use your own id.
const chatId = Number(
  envLines.find((l) => l.startsWith("ALLOWED_TELEGRAM_IDS="))?.split(",")[0]?.slice("ALLOWED_TELEGRAM_IDS=".length).trim() ?? NaN,
);

const ipv4Lookup = (hostname, options, callback) => {
  const opts = typeof options === "object" && options !== null ? options : {};
  dns.lookup(hostname, { ...opts, family: 4 }, (err, address, family) => callback(err, address, family));
};
const agent = new https.Agent({ lookup: ipv4Lookup });

function api(method, payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload ?? {});
    const req = https.request(
      { host: "api.telegram.org", servername: "api.telegram.org", family: 4, agent,
        path: `/bot${token}/${method}`, method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } },
      (res) => { let d = ""; res.on("data", (c) => (d += c)); res.on("end", () => { try { resolve(JSON.parse(d)); } catch { reject(new Error(d)); } }); },
    );
    req.on("error", reject);
    req.setTimeout(20000, () => { req.destroy(); reject(new Error("timeout")); });
    req.write(body);
    req.end();
  });
}

const scopes = [
  { label: "default (no scope)", payload: {} },
  { label: "all_private_chats", payload: { scope: { type: "all_private_chats" } } },
  { label: "all_group_chats", payload: { scope: { type: "all_group_chats" } } },
  { label: "all_chat_administrators", payload: { scope: { type: "all_chat_administrators" } } },
  { label: "all_channel_chats", payload: { scope: { type: "all_channel_chats" } } },
];
if (Number.isFinite(chatId)) {
  scopes.push({ label: `chat ${chatId}`, payload: { scope: { type: "chat", chat_id: chatId } } });
}

for (const s of scopes) {
  const j = await api("getMyCommands", s.payload);
  const cmds = j.ok ? j.result : [];
  console.log(`\n${s.label}: ${cmds.length} command(s)`);
  if (cmds.length) console.log("  " + cmds.map((c) => `/` + c.command).join(" "));
}