// Offline test: instance acquisition must be atomic and metadata owner-safe.

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  if (first.previous) throw new Error("fresh lock reported a previous owner");

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
  if (third.previous) throw new Error("clean release was reported as an unclean exit");
  third.release();

  // Metadata left behind by a crashed owner is reported to the next owner.
  writeFileSync(metadata, JSON.stringify({ pid: 4242, token: "dead", entry, startedAt: "2026-01-01T00:00:00.000Z" }));
  const fourth = acquireInstanceLock(target, metadata, entry, 5_000);
  if (!fourth) throw new Error("lock was not acquirable with leftover metadata");
  if (fourth.previous?.pid !== 4242 || fourth.previous?.startedAt !== "2026-01-01T00:00:00.000Z") {
    throw new Error("leftover owner metadata was not reported");
  }
  fourth.release();

  console.log("Atomic instance lock test passed ✅");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
