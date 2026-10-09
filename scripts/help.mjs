// npm run help — prints a cheat sheet for operating the gateway.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(root, "..", "package.json"), "utf8"));

const SCRIPT_DESC = {
  start: "run the gateway in the foreground (visible output)",
  "start:daemon": "start it in the background via the Linux systemd user service",
  "autostart:setup": "register or safely refresh the Linux systemd user service",
  "autostart:remove": "stop and remove autostart; keep config/data/logs",
  stop: "stop the managed gateway and its child processes",
  status: "show user-service status and process PID",
  help: "this cheat sheet",
  selftest: "send one real model prompt through the pi SDK (may incur cost; no Telegram bot needed)",
  test: "run the nine offline regression scripts",
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
MANUAL ONLINE DIAGNOSTIC (excluded from npm test):
  node test/commands-scope.mjs
    inspect scoped command menus; reads .env and calls Telegram`);
if (process.platform === "linux") console.log(`
  Linux: systemctl --user (no sudo); autostart runs at login.
  Unit: ~/.config/systemd/user/pi-telegram-gateway.service
        or $XDG_CONFIG_HOME/systemd/user/pi-telegram-gateway.service
  Setup registers the service; npm run start:daemon starts it now.
  A foreground npm start is stopped with Ctrl+C.`);
else console.log("\n  Managed daemon commands require Linux with systemd; use npm start on this OS.");

console.log("TELEGRAM BOT COMMANDS (send to @your_bot in chat):\n");
const botCmds = [
  ["/start", "welcome message and quick guide"],
  ["/help", "show available commands"],
  ["/cwd [folder]", "show / switch folder; reload project instructions (keeps history)"],
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
  logs/gateway-err.log  managed stderr log
  logs/archive/         newest 20 pre-launch archives per log type
  sessions/chat-<id>.jsonl   per-chat conversation history
  .env                  config (bot token, allowlist) — never committed

DOCS: https://github.com/kele14x/pi-telegram-gateway
`.trimEnd());
