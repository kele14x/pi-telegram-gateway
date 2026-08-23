import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { createRequire } from "node:module";

interface ProperLockfile {
  lockSync(
    file: string,
    options: { realpath: false; stale: number; update: number; retries: number },
  ): () => void;
}

export interface InstanceLockRecord {
  pid: number;
  token: string;
  entry: string;
  startedAt: string;
}

export interface InstanceLock {
  record: InstanceLockRecord;
  release(): void;
}

const properLockfile = createRequire(import.meta.url)("proper-lockfile") as ProperLockfile;

/**
 * Acquire an atomic, heartbeat-backed process lock. The target file is a
 * permanent sentinel; proper-lockfile owns `<target>.lock` while the process
 * is alive, and stale crash locks become reclaimable after `staleMs`.
 */
export function acquireInstanceLock(
  targetFile: string,
  metadataFile: string,
  entryFile: string,
  staleMs = 30_000,
): InstanceLock | null {
  mkdirSync(dirname(targetFile), { recursive: true });
  writeFileSync(targetFile, "", { flag: "a" });

  let releaseNative: (() => void) | undefined;
  try {
    releaseNative = properLockfile.lockSync(targetFile, {
      realpath: false,
      stale: staleMs,
      update: Math.max(1_000, Math.floor(staleMs / 3)),
      retries: 0,
    });
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ELOCKED") return null;
    throw err;
  }

  const record: InstanceLockRecord = {
    pid: process.pid,
    token: randomUUID(),
    entry: entryFile,
    startedAt: new Date().toISOString(),
  };

  try {
    writeFileSync(metadataFile, JSON.stringify(record));
  } catch (err) {
    releaseNative();
    throw err;
  }

  let released = false;
  return {
    record,
    release() {
      if (released) return;
      released = true;
      // Remove metadata while the native lock is still held, so a subsequent
      // owner can never have its record removed by this process.
      try {
        const current = JSON.parse(readFileSync(metadataFile, "utf8")) as Partial<InstanceLockRecord>;
        if (current.token === record.token) rmSync(metadataFile, { force: true });
      } catch {
        /* missing/corrupt metadata does not weaken the native lock release */
      }
      releaseNative?.();
    },
  };
}
