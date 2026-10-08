// npm run help — prints a cheat sheet for operating the gateway.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(root, "..", "package.json"), "utf8"));
const manager = process.platform === "win32" ? "Windows scheduled task"
  : process.platform === "linux" ? "Linux systemd user service" : "supported OS service manager";

const SCRIPT_DESC = {
  start: "run the gateway in the foreground (visible output)",
  "start:daemon": `start it in the background via the ${manager}`,
  "autostart:setup": `register or safely refresh the ${manager}`,
  "autostart:remove": "stop and remove autostart; keep config/data/logs",
  stop: "stop the managed gateway and its child processes",
  status: "show service/task status and process PID",
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
if (process.platform === "win32") console.log(`
  setup-autostart.ps1    register/refresh the scheduled task
  remove-autostart.ps1   stop and remove the task; keep config/data/logs
  generated launcher: ./gateway-hidden.vbs`);
else if (process.platform === "linux") console.log(`
  Linux: systemctl --user (no sudo); autostart runs at login.
  Unit: ~/.config/systemd/user/pi-telegram-gateway.service
        or $XDG_CONFIG_HOME/systemd/user/pi-telegram-gateway.service
  Setup registers the service; npm run start:daemon starts it now.
  A foreground npm start is stopped with Ctrl+C.`);
else console.log("\n  Managed startup supports Windows and Linux; use npm start on this OS.");

console.log("TELEGRAM BOT COMMANDS (send to @your_bot in chat):\n");
const botCmds = [
  ["/start", "welcome message and quick guide"],
  ["/help", "show available commands"],
  ["/cd <folder>", "switch folder and reload project instructions (keeps history)"],
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
  logs/gateway.log      runtime log
  logs/gateway-err.log  managed stderr log on Linux / manual Windows launches
  logs/archive/         newest 20 pre-launch archives per log type
  sessions/chat-<id>.jsonl   per-chat conversation history
  .env                  config (bot token, allowlist) — never committed

DOCS: https://github.com/kele14x/pi-telegram-gateway
`.trimEnd());
