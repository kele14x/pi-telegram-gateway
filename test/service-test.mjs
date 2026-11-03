// Offline lifecycle tests: only temporary files and a fake systemctl are used.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildLinuxUnit, manageLinuxService, UNIT_NAME } from "../scripts/linux-service.mjs";

assert.throws(() => manageLinuxService("delete-everything"), /Unknown Linux service action/);
assert.throws(() => buildLinuxUnit("/repo\nExecStart=bad", process.execPath, "/bin"), /control characters/);

// Exercise quote/backslash escaping independently of filesystem fixtures.
const escapingUnit = buildLinuxUnit('/synthetic/repo 中文 $cash %name "quote" \\path', process.execPath, '/custom/bin:$PATH:/quoted " bin');
assert(escapingUnit.includes('\\"quote\\"') && escapingUnit.includes('\\\\path'));

const temporary = mkdtempSync(join(tmpdir(), "pi-gateway-service-"));
try {
  const root = join(temporary, "repo 中文 $cash %name");
  const home = join(temporary, "home");
  const config = join(temporary, "custom config");
  const unitPath = join(config, "systemd", "user", UNIT_NAME);
  const calls = [];
  const output = [];
  let loadedPath = "";
  let active = false;
  let failure;
  const run = (command, args, options) => {
    assert.equal(command, "systemctl");
    assert.equal(args[0], "--user");
    assert.equal(options.stdio, "pipe");
    calls.push(args.slice(1));
    if (failure === args[1]) return { status: 1, stdout: "", stderr: "synthetic-secret-do-not-print" };
    if (args[1] === "show" && args.includes(UNIT_NAME)) {
      return { status: 0, stdout: `LoadState=${loadedPath ? "loaded" : "not-found"}\nFragmentPath=${loadedPath}\nActiveState=${active ? "active" : "inactive"}\nSubState=${active ? "running" : "dead"}\nMainPID=${active ? "123" : "0"}\nResult=success\n` };
    }
    if (args[1] === "daemon-reload") loadedPath = existsSync(unitPath) ? unitPath : "";
    if (args[1] === "start" || args[1] === "restart") active = true;
    if (args[1] === "stop") active = false;
    return { status: 0, stdout: "", stderr: "" };
  };
  const options = { root, home, env: { XDG_CONFIG_HOME: config, PATH: '/custom/bin:$PATH:/quoted " bin' }, run, print: line => output.push(line) };
  const perform = action => manageLinuxService(action, options);
  const changes = () => calls.filter(args => args[0] !== "show").map(args => args[0]);
  const reset = () => { calls.length = 0; output.length = 0; };

  mkdirSync(join(root, "sessions"), { recursive: true });
  writeFileSync(join(root, ".env"), "SYNTHETIC_CONFIG=keep\n");
  writeFileSync(join(root, "sessions", "placeholder.jsonl"), "synthetic history\n");

  assert.throws(() => perform("start:daemon"), /autostart:setup first/);
  assert.throws(() => perform("restart:daemon"), /autostart:setup first/);
  assert.deepEqual(changes(), []);
  reset();
  perform("autostart:remove");
  assert.deepEqual(changes(), []);
  assert(!existsSync(unitPath));
  reset();

  perform("autostart:setup");
  assert.deepEqual(changes(), ["daemon-reload", "enable"]);
  assert(!active, "setup must not start the bot");
  assert(existsSync(join(root, "logs")));
  const unit = readFileSync(unitPath, "utf8");
  assert(unit.includes("Restart=on-failure\nRestartSec=60s"));
  assert(unit.includes("KillMode=control-group"));
  assert(unit.includes("TimeoutStopSec=30s"), "systemd must allow the gateway's ten-second graceful shutdown");
  assert(unit.includes("--env-file-if-exists=.env"));
  assert(unit.includes("%" + "%name"), "systemd specifiers must be escaped");
  assert(unit.includes('$cash'), "literal dollar signs must survive command generation");
  assert(unit.includes('ExecStart=:"'), "systemd variable substitution must be disabled");
  assert(!unit.includes("SYNTHETIC_CONFIG"), "unit must not embed .env contents");
  assert.equal(statSync(unitPath).mode & 0o777, 0o600);
  reset();

  perform("start:daemon");
  assert(active);
  assert.deepEqual(changes(), ["start"]);
  reset();
  perform("restart:daemon");
  assert(active);
  assert.deepEqual(changes(), ["restart"], "native restart must not change autostart or rewrite the service");
  assert.deepEqual(calls.at(-1), ["restart", UNIT_NAME]);
  assert(output.includes("Gateway user service restarted."));
  assert.equal(readFileSync(unitPath, "utf8"), unit);
  reset();
  perform("status");
  assert(output.some(line => line.includes("active (running)")));
  assert.deepEqual(changes(), [], "status must be read-only");
  reset();
  perform("stop");
  assert(!active);
  assert.deepEqual(changes(), ["stop"]);
  reset();

  perform("restart:daemon");
  assert(active, "restart must also start a stopped service");
  assert.deepEqual(changes(), ["restart"]);
  assert.equal(readFileSync(unitPath, "utf8"), unit);
  reset();

  failure = "restart";
  assert.throws(() => perform("restart:daemon"), error => {
    assert.match(error.message, /restart failed/);
    assert(!error.message.includes("synthetic-secret"), "service-manager output must not leak in errors");
    return true;
  });
  assert.deepEqual(changes(), ["restart"]);
  assert.equal(output.length, 0, "failed restart must not report success");
  assert.equal(readFileSync(unitPath, "utf8"), unit);
  failure = undefined;
  reset();

  perform("autostart:setup");
  assert.deepEqual(changes(), ["stop", "disable", "daemon-reload", "enable"]);
  reset();

  // A failure to stop must retain the unit and never disable/remove it.
  failure = "stop";
  assert.throws(() => perform("autostart:remove"), /stop failed/);
  assert(existsSync(unitPath));
  assert.deepEqual(changes(), ["stop"]);
  failure = undefined;
  reset();
  assert.throws(() => manageLinuxService("autostart:setup", { ...options, env: { ...options.env, PATH: "invalid\nPATH" } }), /control characters/);
  assert.deepEqual(changes(), [], "invalid configuration must not stop the existing service");
  reset();

  // Refresh/removal must stop the unit previously registered at an old root.
  const movedRoot = join(temporary, "moved repo");
  manageLinuxService("autostart:setup", { ...options, root: movedRoot });
  const movedEntry = join(movedRoot, "index.ts");
  assert(readFileSync(unitPath, "utf8").includes(movedEntry));
  assert.deepEqual(changes(), ["stop", "disable", "daemon-reload", "enable"]);
  reset();
  perform("autostart:remove");
  assert.deepEqual(changes(), ["stop", "disable", "daemon-reload"]);
  assert(!existsSync(unitPath));
  assert.equal(readFileSync(join(root, ".env"), "utf8"), "SYNTHETIC_CONFIG=keep\n");
  assert.equal(readFileSync(join(root, "sessions", "placeholder.jsonl"), "utf8"), "synthetic history\n");
  assert(existsSync(join(root, "logs")));
  reset();
  perform("autostart:remove");
  assert.deepEqual(changes(), []);
  reset();

  failure = "show";
  assert.throws(() => perform("autostart:setup"), /user systemd session/);
  assert(!existsSync(unitPath), "manager failure must not install a unit");
  assert(!output.join("\n").includes("synthetic-secret"));
  failure = undefined;
  reset();

  writeFileSync(unitPath, "# unrelated service\n[Service]\nExecStart=/bin/true\n");
  assert.throws(() => perform("autostart:setup"), /not managed/);
  assert.throws(() => perform("autostart:remove"), /not managed/);
  assert.throws(() => perform("restart:daemon"), /not managed/);
  assert.deepEqual(changes(), []);
  rmSync(unitPath);
  reset();

  loadedPath = join(temporary, "foreign", UNIT_NAME);
  assert.throws(() => perform("autostart:setup"), /another location/);
  assert.throws(() => perform("stop"), /another location/);
  assert.throws(() => perform("restart:daemon"), /another location/);
  assert.deepEqual(changes(), []);
  loadedPath = "";
  reset();

  loadedPath = unitPath;
  assert.throws(() => perform("autostart:setup"), /file is missing/);
  assert.throws(() => perform("restart:daemon"), /file is missing/);
  assert.deepEqual(changes(), []);
  loadedPath = "";
  reset();

  const foreign = join(temporary, "foreign.service");
  writeFileSync(foreign, buildLinuxUnit(root, process.execPath, "/bin"));
  symlinkSync(foreign, unitPath);
  assert.throws(() => perform("autostart:setup"), /not managed/);
  assert.throws(() => perform("restart:daemon"), /not managed/);
  assert.deepEqual(changes(), []);
  rmSync(unitPath);

  assert.throws(() => manageLinuxService("autostart:setup", { ...options, env: { XDG_CONFIG_HOME: "relative" } }), /absolute path/);
  assert(!existsSync(join(home, ".config")), "XDG config override was ignored");
  // Also exercise the normal ~/.config path without touching the real home.
  manageLinuxService("autostart:setup", { ...options, env: { PATH: "/bin" } });
  assert(existsSync(join(home, ".config", "systemd", "user", UNIT_NAME)));

  console.log("Linux user-service tests passed ✅");
} finally {
  rmSync(temporary, { recursive: true, force: true });
}

const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
const compose = readFileSync(new URL("../docker-compose.yml", import.meta.url), "utf8");
const podman = readFileSync(new URL("../compose.podman.yaml", import.meta.url), "utf8");
const podmanUnit = readFileSync(new URL("../contrib/pi-telegram-gateway-podman.service", import.meta.url), "utf8");
const help = readFileSync(new URL("../scripts/help.mjs", import.meta.url), "utf8");
const setupService = compose.split("\n  pi-setup:\n")[1].split("\nvolumes:\n")[0];
for (const name of ["HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY"]) {
  assert.match(setupService, new RegExp(`^      ${name}:$`, "m"), "unset proxies must stay unset rather than suppress saved settings");
}
assert(!setupService.includes("env_file:") && !setupService.includes("TELEGRAM_BOT_TOKEN"), "setup must not receive Telegram credentials");
assert(!compose.includes("userns_mode:") && !compose.includes("/workspace:Z"), "Podman settings must not leak into Docker");
assert.match(podman, /\/workspace:Z/, "only the Podman workspace mount gets a private SELinux label");
assert.match(readme, /--userns=keep-id --security-opt label=disable/, "credential import must not relabel host pi configuration");
assert.match(readme, /agent:\/host:ro"/, "credential import must keep the host mount read-only");
assert.match(readme, /sh -ec '\n    umask 077/, "credential import must fail on errors and create private files");
assert.match(readme, /-v pi-telegram-gateway_data:\/data/);
const podmanCommands = [readme, podman, help].flatMap(text => text.match(/podman-compose --in-pod=false[^\n]+/g) ?? []);
assert(podmanCommands.length >= 5);
for (const command of podmanCommands) assert(command.includes("-p pi-telegram-gateway"), "all Podman commands must share the user unit's project name");
for (const action of ["ExecStart", "ExecStop"]) {
  assert.match(podmanUnit, new RegExp(`^${action}=.* -p pi-telegram-gateway `, "m"));
}

const setupRecipe = readme.match(/```bash\n(COMPOSE_BIN=[\s\S]*?)\n```/)[1];
const providerSelection = setupRecipe.split("\nif [ -x")[0];
const providerTemporary = mkdtempSync(join(tmpdir(), "pi-gateway-podman-provider-"));
try {
  const home = join(providerTemporary, "home");
  const bin = join(providerTemporary, "bin");
  const emptyBin = join(providerTemporary, "empty-bin");
  const venvBin = join(home, ".local", "venvs", "podman-compose", "bin");
  for (const directory of [bin, emptyBin, venvBin]) mkdirSync(directory, { recursive: true });
  const distroProvider = join(bin, "podman-compose");
  const venvProvider = join(venvBin, "podman-compose");
  const customProvider = join(bin, "custom-provider");
  const envProvider = join(bin, "env-provider");
  for (const path of [distroProvider, venvProvider, customProvider, envProvider]) {
    writeFileSync(path, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  }
  const env = { HOME: home, PATH: bin, COMPOSE_BIN: "", PODMAN_COMPOSE: "" };
  for (const [overrides, expected] of [
    [{ COMPOSE_BIN: customProvider, PODMAN_COMPOSE: envProvider }, customProvider],
    [{ PODMAN_COMPOSE: envProvider }, envProvider],
    [{}, distroProvider],
    [{ PATH: emptyBin }, venvProvider],
  ]) {
    const selected = execFileSync("/bin/sh", ["-c", providerSelection + '\nprintf "%s" "$COMPOSE_BIN"'], {
      env: { ...env, ...overrides }, encoding: "utf8",
    });
    assert.equal(selected, expected, "provider selection must preserve overrides and support distro and venv installs");
  }
  const missing = spawnSync("/bin/sh", ["-c", setupRecipe], {
    env: { ...env, COMPOSE_BIN: join(bin, "missing-provider") }, encoding: "utf8",
  });
  assert.equal(missing.status, 0);
  assert.match(missing.stderr, /Set COMPOSE_BIN or PODMAN_COMPOSE/);
  assert(!existsSync(join(home, ".config")), "missing providers must not render or register a unit");
  writeFileSync(join(bin, "systemctl"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  execFileSync("/bin/sh", ["-c", setupRecipe], {
    cwd: new URL("../", import.meta.url),
    env: { ...env, PATH: `${bin}:/usr/bin:/bin`, COMPOSE_BIN: customProvider },
  });
  const renderedUnit = readFileSync(join(home, ".config", "systemd", "user", "pi-telegram-gateway-podman.service"), "utf8");
  assert(renderedUnit.includes(`ExecStart=${customProvider} --in-pod=false -p pi-telegram-gateway`), "the rendered unit must use the selected provider and shared project name");
  assert(!renderedUnit.includes("@COMPOSE_BIN@"));

  const importHost = join(providerTemporary, "import-host");
  const importAgent = join(providerTemporary, "import-agent");
  mkdirSync(importHost);
  mkdirSync(importAgent);
  writeFileSync(join(importHost, "auth.json"), "{}\n", { mode: 0o644 });
  const importRecipe = readme.match(/pi-telegram-gateway:latest sh -ec '([\s\S]*?)\n  '/)[1];
  const importScript = importRecipe.replaceAll("/host/", `${importHost}/`).replaceAll("/data/pi-agent/", `${importAgent}/`);
  execFileSync("/bin/sh", ["-ec", importScript]);
  assert.equal(readFileSync(join(importAgent, "auth.json"), "utf8"), "{}\n");
  assert.equal(statSync(join(importAgent, "auth.json")).mode & 0o777, 0o600, "imported credentials must be private");
  const failedImport = spawnSync("/bin/sh", ["-ec", importScript.replaceAll(`${importAgent}/`, `${providerTemporary}/missing-agent/`)]);
  assert.notEqual(failedImport.status, 0, "credential copy failures must not be hidden");
} finally {
  rmSync(providerTemporary, { recursive: true, force: true });
}
console.log("Container deployment recipe tests passed.");
