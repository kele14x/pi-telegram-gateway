import { mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { basename, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

const LOG_NAMES = ["gateway.log", "gateway-err.log"];

function archiveName(logName, now = new Date()) {
  const timestamp = now.toISOString().replace(/[-:.]/g, "");
  return `${timestamp}-${process.pid}-${logName}`;
}

/** Archive non-empty gateway logs before launch and retain a bounded history. */
export function rotateGatewayLogs(root, keepPerLog = 20, now = new Date()) {
  if (!Number.isInteger(keepPerLog) || keepPerLog < 1) throw new Error("keepPerLog must be a positive integer");
  const resolvedRoot = resolve(root);
  const logDir = resolve(resolvedRoot, "logs");
  const archiveDir = resolve(logDir, "archive");
  const archivePrefix = `${archiveDir}${sep}`;
  mkdirSync(archiveDir, { recursive: true });

  for (const logName of LOG_NAMES) {
    const source = resolve(logDir, logName);
    try {
      if (statSync(source).isFile() && statSync(source).size > 0) {
        const destination = resolve(archiveDir, archiveName(logName, now));
        if (!destination.startsWith(archivePrefix)) throw new Error("refusing to archive outside the log directory");
        renameSync(source, destination);
      }
    } catch (err) {
      if ((err)?.code !== "ENOENT") throw err;
    }

    const archives = readdirSync(archiveDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(`-${logName}`))
      .map((entry) => resolve(archiveDir, entry.name))
      .sort((a, b) => basename(b).localeCompare(basename(a)));
    for (const stale of archives.slice(keepPerLog)) {
      if (!stale.startsWith(archivePrefix)) throw new Error("refusing to remove a log outside the archive directory");
      rmSync(stale, { force: true });
    }
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (invokedPath === import.meta.url) {
  const rootFlag = process.argv.indexOf("--root");
  const root = rootFlag >= 0 ? process.argv[rootFlag + 1] : undefined;
  if (!root) {
    console.error("Usage: node scripts/rotate-logs.mjs --root <gateway-root>");
    process.exitCode = 1;
  } else {
    try {
      rotateGatewayLogs(root);
    } catch (err) {
      console.error(`Log rotation failed: ${String(err?.message ?? err)}`);
      process.exitCode = 1;
    }
  }
}
