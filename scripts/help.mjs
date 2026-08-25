// npm run help — prints a cheat sheet for operating the gateway.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(root, "..", "package.json"), "utf8"));

const SCRIPT_DESC = {
  start: "run the gateway in the foreground (visible output)",
  "start:daemon": "start it in the background via the Windows scheduled task (hidden)",
  "autostart:setup": "register or safely refresh the Windows scheduled task",
  "autostart:remove": "remove the task and generated hidden launcher",
  stop: "stop the gateway cleanly (kills the full process tree)",
  status: "show task status, process PID, recent log, sessions",
  help: "this cheat sheet",
  selftest: "send one prompt through the pi SDK (no Telegram bot needed)",
  test: "run the offline unit tests",
  "test:windows": "run offline Windows task-management tests",
  typecheck: "type-check the TypeScript sources (tsc --noEmit)",
};

console.log("pi-telegram-gateway — operating cheat sheet");
console.log("=".repeat(52));
console.log("\nLOCAL CONSOLE COMMANDS (run from this project folder):\n");
for (const [name, script] of Object.entries(pkg.scripts ?? {})) {
  const desc = SCRIPT_DESC[name] ?? "";
  console.log(`  npm run ${name.padEnd(18)} ${desc}`);
}
console.log(`
  setup-autostart.ps1    register/refresh the scheduled task
  remove-autostart.ps1   stop and remove the task; keep config/data/logs
  generated launcher: ./gateway-hidden.vbs`);

console.log("TELEGRAM BOT COMMANDS (send to @your_bot in chat):\n");
const botCmds = [
  ["/start", "welcome message and quick guide"],
  ["/help", "show available commands"],
  ["/cd <folder>", "switch this chat's working folder"],
  ["/cwd", "show working folder"],
  ["/sessions", "conversation storage details for this chat"],
  ["/new", "fresh conversation (keeps folder)"],
  ["/model [name]", "show / switch model"],
  ["/thinking [level]", "show / set thinking level"],
  ["/stop", "abort the current run and drop queued messages"],
  ["/status", "live activity, prompt queue, model, folder"],
];
for (const [cmd, desc] of botCmds) console.log(`  ${cmd.padEnd(18)} ${desc}`);

console.log(`
KEY PATHS:
  logs/gateway.log      runtime log (last 10 lines: npm run status)
  logs/archive/         newest 20 pre-launch archives per log type
  sessions/chat-<id>.jsonl   per-chat conversation history
  .env                  config (bot token, allowlist) — never committed

DOCS: https://github.com/kele14x/pi-telegram-gateway
`.trimEnd());
