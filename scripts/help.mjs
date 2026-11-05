// npm run help — prints a cheat sheet for operating the gateway.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(root, "..", "package.json"), "utf8"));

const SCRIPT_DESC = {
  selftest: "development-only host diagnostic: one real model prompt, no bot",
  test: "run the ten offline regression scripts",
  typecheck: "type-check the TypeScript sources (tsc --noEmit)",
  help: "this cheat sheet",
};

console.log("pi-telegram-gateway — operating cheat sheet");
console.log("=".repeat(52));
console.log("\nDEVELOPMENT COMMANDS (run from this project folder):\n");
for (const [name, script] of Object.entries(pkg.scripts ?? {})) {
  const desc = SCRIPT_DESC[name] ?? "";
  console.log(`  npm run ${name.padEnd(18)} ${desc}`);
}
console.log(`
DOCKER COMPOSE (supported deployment):
  cp .env.example .env                  set TELEGRAM_BOT_TOKEN and ALLOWED_TELEGRAM_IDS
  mkdir -p workspace                    or point PI_WORKSPACE at an existing folder
  docker compose run --rm --build pi-setup
                                        /login, /model, then /quit
  docker compose up -d --build          start in the background
  docker compose logs -f                follow gateway output
  docker compose down                   graceful stop; keeps the data volume
  docker compose down -v                destructive: deletes credentials and history

Rootless Podman:
  podman-compose --in-pod=false -p pi-telegram-gateway -f docker-compose.yml -f compose.podman.yaml up -d gateway
  See README "Podman" and compose.podman.yaml.

Linux systemd autostart templates:
  contrib/pi-telegram-gateway-docker.service   system unit (rootful Docker)
  contrib/pi-telegram-gateway-podman.service   user unit (rootless Podman)

Host systemd helpers are no longer supported. The former direct-host scripts
live in examples/systemd/ as reference only.`);

console.log("\nTELEGRAM BOT COMMANDS (send to @your_bot in chat):\n");
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
CONTAINER PATHS:
  /workspace             mounted host workspace (default chat folder)
  /data/pi-agent         pi credentials, settings, models, extensions
  /data/sessions         per-chat conversation history and meta.json
  /data/logs             instance lock and gateway-events.jsonl
  logs/                  host-side output from the unsupported systemd example only

REPOSITORY:
  .env                  Compose configuration — never committed
  compose.podman.yaml   Podman-only Compose override (keep-id)
  examples/systemd/     unsupported direct-host systemd example
  test/commands-scope.mjs  manual online diagnostic; not part of npm test

DOCS: https://github.com/kele14x/pi-telegram-gateway
`.trimEnd());
