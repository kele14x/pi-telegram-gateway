// Offline lifecycle tests: only temporary files and a fake systemctl are used.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serviceCommand } from "../scripts/service.mjs";
import { buildLinuxUnit, manageLinuxService, UNIT_NAME } from "../scripts/linux-service.mjs";

const actions = ["autostart:setup", "autostart:remove", "start:daemon", "stop", "status"];
for (const action of actions) {
  const linux = serviceCommand(action, "linux", "/gateway with spaces", "/custom/node");
  assert.equal(linux.command, "/custom/node");
  assert.deepEqual(linux.args, [join("/gateway with spaces", "scripts", "linux-service.mjs"), action]);
  const windows = serviceCommand(action, "win32", "/gateway with spaces");
  if (action === "start:daemon") {
    assert.equal(windows.command, "schtasks");
    assert.deepEqual(windows.args, ["/Run", "/TN", "pi-telegram-gateway"]);
  } else {
    assert.equal(windows.command, "powershell");
    assert.deepEqual(windows.args.slice(0, 4), ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File"]);
    const script = { "autostart:setup": "setup-autostart.ps1", "autostart:remove": "remove-autostart.ps1", stop: "stop.ps1", status: "status.ps1" }[action];
    assert.equal(windows.args[4], join("/gateway with spaces", script));
  }
}
assert.throws(() => serviceCommand("status", "darwin"), /unsupported.*npm start/);
assert.throws(() => serviceCommand("delete-everything"), /Usage/);
assert.throws(() => buildLinuxUnit("/repo\nExecStart=bad", process.execPath, "/bin"), /control characters/);

const temporary = mkdtempSync(join(tmpdir(), "pi-gateway-service-"));
try {
  const root = join(temporary, 'repo 中文 $cash %name "quote" \\path');
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
    if (args[1] === "start") active = true;
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
  assert(unit.includes("--env-file-if-exists=.env"));
  assert(unit.includes("%" + "%name"), "systemd specifiers must be escaped");
  assert(unit.includes('$cash'), "literal dollar signs must survive command generation");
  assert(unit.includes('ExecStart=:"'), "systemd variable substitution must be disabled");
  assert(unit.includes('\\"quote\\"') && unit.includes('\\\\path'));
  assert(!unit.includes("SYNTHETIC_CONFIG"), "unit must not embed .env contents");
  if (process.platform !== "win32") assert.equal(statSync(unitPath).mode & 0o777, 0o600);
  reset();

  perform("start:daemon");
  assert(active);
  assert.deepEqual(changes(), ["start"]);
  reset();
  perform("status");
  assert(output.some(line => line.includes("active (running)")));
  assert.deepEqual(changes(), [], "status must be read-only");
  reset();
  perform("stop");
  assert(!active);
  assert.deepEqual(changes(), ["stop"]);
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
  assert(readFileSync(unitPath, "utf8").includes(join(movedRoot, "index.ts")));
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
  assert.deepEqual(changes(), []);
  rmSync(unitPath);
  reset();

  loadedPath = join(temporary, "foreign", UNIT_NAME);
  assert.throws(() => perform("autostart:setup"), /another location/);
  assert.throws(() => perform("stop"), /another location/);
  assert.deepEqual(changes(), []);
  loadedPath = "";
  reset();

  loadedPath = unitPath;
  assert.throws(() => perform("autostart:setup"), /file is missing/);
  assert.deepEqual(changes(), []);
  loadedPath = "";
  reset();

  if (process.platform !== "win32") {
    const foreign = join(temporary, "foreign.service");
    writeFileSync(foreign, buildLinuxUnit(root, process.execPath, "/bin"));
    symlinkSync(foreign, unitPath);
    assert.throws(() => perform("autostart:setup"), /not managed/);
    assert.deepEqual(changes(), []);
    rmSync(unitPath);
  }

  assert.throws(() => manageLinuxService("autostart:setup", { ...options, env: { XDG_CONFIG_HOME: "relative" } }), /absolute path/);
  assert(!existsSync(join(home, ".config")), "XDG config override was ignored");
  // Also exercise the normal ~/.config path without touching the real home.
  manageLinuxService("autostart:setup", { ...options, env: { PATH: "/bin" } });
  assert(existsSync(join(home, ".config", "systemd", "user", UNIT_NAME)));

  console.log("OS dispatch and Linux user-service tests passed ✅");
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
