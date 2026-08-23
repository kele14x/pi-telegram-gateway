// Offline test: instance acquisition must be atomic and metadata owner-safe.

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { acquireInstanceLock } from "../instance-lock.ts";

const dir = mkdtempSync(join(tmpdir(), "pi-telegram-lock-"));
const target = join(dir, "gateway.instance");
const metadata = join(dir, "gateway.lock");
const entry = join(dir, "index.ts");

try {
  const first = acquireInstanceLock(target, metadata, entry, 5_000);
  if (!first) throw new Error("first acquisition unexpectedly failed");

  const second = acquireInstanceLock(target, metadata, entry, 5_000);
  if (second) throw new Error("two owners acquired the same instance lock");

  const record = JSON.parse(readFileSync(metadata, "utf8"));
  if (record.pid !== process.pid || record.entry !== entry || record.token !== first.record.token) {
    throw new Error("lock metadata does not describe its owner");
  }

  first.release();
  if (existsSync(metadata)) throw new Error("owner metadata remained after release");

  const third = acquireInstanceLock(target, metadata, entry, 5_000);
  if (!third) throw new Error("lock was not reacquirable after release");
  third.release();

  console.log("Atomic instance lock test passed ✅");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
