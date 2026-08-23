// Offline log-rotation test. Uses only an isolated temporary directory.

import { existsSync, mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rotateGatewayLogs } from "../scripts/rotate-logs.mjs";

const root = mkdtempSync(join(tmpdir(), "pi-gateway-rotation-"));
try {
  const logs = join(root, "logs");
  const archive = join(logs, "archive");
  mkdirSync(archive, { recursive: true });
  writeFileSync(join(logs, "gateway.log"), "current log\n");
  for (let i = 0; i < 22; i++) {
    writeFileSync(join(archive, `20260101T0000${String(i).padStart(2, "0")}Z-1-gateway.log`), `${i}\n`);
  }

  rotateGatewayLogs(root, 20, new Date("2026-08-23T12:34:56Z"));

  if (existsSync(join(logs, "gateway.log"))) throw new Error("active log was not archived");
  const retained = readdirSync(archive).filter((name) => name.endsWith("-gateway.log"));
  if (retained.length !== 20) throw new Error(`expected 20 retained logs, got ${retained.length}`);
  if (!retained.some((name) => name.startsWith("20260823T123456000Z-"))) throw new Error("new archive is missing");
  console.log("Bounded log-rotation test passed ✅");
} finally {
  rmSync(root, { recursive: true, force: true });
}
