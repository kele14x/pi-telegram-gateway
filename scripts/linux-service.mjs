// Per-user systemd management. Does not read .env or embed credentials in units.
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const UNIT_NAME = "pi-telegram-gateway.service";
const MARKER = "# Managed by pi-telegram-gateway (scripts/linux-service.mjs).";
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function checked(value) {
  if (typeof value !== "string" || /[\x00-\x1f\x7f]/.test(value)) {
    throw new Error("Service paths and PATH must not contain control characters.");
  }
  return value;
}

function specifiers(value) {
  return checked(value).replaceAll("%", "%%");
}

function quoted(value) {
  return `"${specifiers(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

export function buildLinuxUnit(root, nodePath, searchPath) {
  if (!isAbsolute(root) || !isAbsolute(nodePath)) throw new Error("Service paths must be absolute.");
  const command = (...args) => `:${args.map(quoted).join(" ")}`;
  return `${MARKER}
[Unit]
Description=pi Telegram coding-agent gateway

[Service]
Type=simple
WorkingDirectory=${specifiers(root)}/.
Environment=${quoted(`PATH=${searchPath}`)}
ExecStartPre=${command(nodePath, join(root, "scripts", "rotate-logs.mjs"), "--root", root)}
ExecStart=${command(nodePath, "--env-file-if-exists=.env", join(root, "index.ts"))}
Restart=on-failure
RestartSec=60s
KillMode=control-group
TimeoutStopSec=30s
UMask=0077
StandardOutput=append:${specifiers(join(root, "logs", "gateway.log"))}
StandardError=append:${specifiers(join(root, "logs", "gateway-err.log"))}

[Install]
WantedBy=default.target
`;
}

export function manageLinuxService(action, {
  root = repositoryRoot,
  nodePath = process.execPath,
  env = process.env,
  home = homedir(),
  run = spawnSync,
  print = console.log,
} = {}) {
  if (!["autostart:setup", "autostart:remove", "start:daemon", "stop", "status"].includes(action)) {
    throw new Error("Unknown Linux service action.");
  }
  const configHome = env.XDG_CONFIG_HOME || join(home, ".config");
  if (!isAbsolute(configHome)) throw new Error("XDG_CONFIG_HOME must be an absolute path.");
  const unitPath = join(configHome, "systemd", "user", UNIT_NAME);
  const systemctl = (args, allowFailure = false) => {
    const result = run("systemctl", ["--user", ...args], { encoding: "utf8", stdio: "pipe" });
    if (result.error?.code === "ENOENT") throw new Error("Linux managed startup requires systemctl; use npm start if systemd is unavailable.");
    if (!allowFailure && (result.error || result.status !== 0)) {
      throw new Error(`systemctl --user ${args[0]} failed. Check your user systemd session; use npm start in containers without systemd.`);
    }
    return result;
  };

  // Check the user manager before any file changes. Captured output is never
  // forwarded: systemctl status can include log lines and environment values.
  systemctl(["show", "--property=Version"]);
  let installed = false;
  try {
    const info = lstatSync(unitPath);
    if (!info.isFile() || !readFileSync(unitPath, "utf8").startsWith(`${MARKER}\n`)) {
      throw new Error("The existing service file is not managed by this gateway; refusing to change it.");
    }
    installed = true;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  const state = systemctl(["show", "--property=LoadState", "--property=FragmentPath", "--property=ActiveState", "--property=SubState", "--property=MainPID", "--property=Result", UNIT_NAME], true);
  const properties = Object.fromEntries((state.stdout ?? "").trim().split("\n").filter(line => line.includes("=")).map(line => {
    const split = line.indexOf("=");
    return [line.slice(0, split), line.slice(split + 1)];
  }));
  if (state.error || (state.status !== 0 && properties.LoadState !== "not-found")) {
    throw new Error("Could not inspect the gateway user service; no changes were made.");
  }
  if (properties.FragmentPath && resolve(properties.FragmentPath) !== resolve(unitPath)) {
    throw new Error("A gateway service is registered at another location; refusing to change an unverified unit.");
  }
  if (!installed && properties.FragmentPath) {
    throw new Error("The loaded gateway service file is missing; run systemctl --user daemon-reload before retrying.");
  }

  if (action === "status") {
    print(`User service: ${installed ? unitPath : "not installed"}`);
    print(`State: ${properties.ActiveState || "inactive"} (${properties.SubState || "unknown"})`);
    print(`Main PID: ${properties.MainPID || "0"}; result: ${properties.Result || "unknown"}`);
    print(`Logs: ${join(root, "logs", "gateway.log")} and gateway-err.log`);
    return;
  }
  if (!installed && action === "autostart:remove") {
    print("Gateway user service is already removed.");
    return;
  }
  if (!installed && action !== "autostart:setup") {
    if (action === "stop") {
      print("No managed gateway service is installed. Stop a foreground npm start with Ctrl+C.");
      return;
    }
    throw new Error("Gateway user service is not installed; run npm run autostart:setup first.");
  }

  if (action === "autostart:setup") {
    // Validate everything before stopping an existing service. Paths are pinned
    // so a Node version manager or a repository move cannot silently switch it.
    const content = buildLinuxUnit(resolve(root), nodePath, env.PATH || `${dirname(nodePath)}:/usr/local/bin:/usr/bin:/bin`);
    if (installed) {
      systemctl(["stop", UNIT_NAME]);
      systemctl(["disable", UNIT_NAME]);
    }
    mkdirSync(dirname(unitPath), { recursive: true, mode: 0o700 });
    mkdirSync(join(root, "logs"), { recursive: true, mode: 0o700 });
    const temporary = `${unitPath}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, content, { mode: 0o600, flag: "wx" });
      renameSync(temporary, unitPath);
    } finally {
      rmSync(temporary, { force: true });
    }
    systemctl(["daemon-reload"]);
    systemctl(["enable", UNIT_NAME]);
    print(`Registered user service: ${unitPath}`);
    print("Autostart is enabled for login. Start now with: npm run start:daemon");
  } else if (action === "autostart:remove") {
    // Stop the loaded unit before deleting its file, including after a repo move.
    systemctl(["stop", UNIT_NAME]);
    systemctl(["disable", UNIT_NAME]);
    rmSync(unitPath);
    systemctl(["daemon-reload"]);
    print("Gateway user service removed. Configuration, sessions, and logs were kept.");
  } else {
    systemctl([action === "start:daemon" ? "start" : "stop", UNIT_NAME]);
    print(action === "start:daemon" ? "Gateway user service started." : "Gateway user service stopped.");
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    if (process.platform !== "linux") throw new Error("Managed daemon commands require Linux with systemd; use npm start for foreground operation.");
    manageLinuxService(process.argv[2]);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
