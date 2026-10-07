// OS-aware entry point for the npm lifecycle commands. Never invoke a shell.
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const windowsScripts = {
  "autostart:setup": "setup-autostart.ps1",
  "autostart:remove": "remove-autostart.ps1",
  stop: "stop.ps1",
  status: "status.ps1",
};

export function serviceCommand(action, platform = process.platform, gatewayRoot = root, nodePath = process.execPath) {
  if (!["start:daemon", ...Object.keys(windowsScripts)].includes(action)) {
    throw new Error("Usage: node scripts/service.mjs <autostart:setup|autostart:remove|start:daemon|stop|status>");
  }
  if (platform === "win32") {
    return action === "start:daemon"
      ? { command: "schtasks", args: ["/Run", "/TN", "pi-telegram-gateway"] }
      : { command: "powershell", args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(gatewayRoot, windowsScripts[action])] };
  }
  if (platform === "linux") {
    return { command: nodePath, args: [join(gatewayRoot, "scripts", "linux-service.mjs"), action] };
  }
  throw new Error(`Managed startup is unsupported on ${platform}; use npm start for foreground operation.`);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const { command, args } = serviceCommand(process.argv[2]);
    const result = spawnSync(command, args, { cwd: root, stdio: "inherit" });
    if (result.error) throw new Error(`Could not run ${command}; ensure it is installed and available on PATH.`);
    process.exitCode = result.status ?? 1;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
