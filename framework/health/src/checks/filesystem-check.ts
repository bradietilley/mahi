import { STORAGE_TOKEN, Str } from "@mahiframework/core";
import type { HealthCheck } from "../health-check.js";
import type { StorageManagerLike } from "./contracts.js";

/**
 * Writes, reads back, compares, and deletes a unique file on the default
 * disk.
 *
 * Same round-trip reasoning as `cacheCheck`, and here it matters more:
 * `LocalStorageDriver.put()` is `mkdir` + `writeFile`, which succeeds on a
 * filesystem that went read-only *after* the mount was cached, and on a
 * disk that is full only for larger writes.
 *
 * The `health-check/` prefix rather than the disk root keeps probe
 * artifacts in one directory an operator can identify and delete. Unlike
 * cache there is no TTL, so the `delete` in `finally` is the only cleanup,
 * hence the subdirectory: if deletes are what's broken, the accumulating
 * files are at least contained and diagnostic. A failed delete does not
 * fail the check.
 */
export const filesystemCheck: HealthCheck = {
  name: "filesystem",
  group: "core",

  async run(app) {
    if (!app.has(STORAGE_TOKEN)) {
      return null;
    }

    const disk = app.make<StorageManagerLike>(STORAGE_TOKEN).disk();
    const path = `health-check/${Str.uuid()}.txt`;
    const value = Str.uuid();

    try {
      await disk.put(path, value);
      const read = (await disk.get(path)).toString("utf8");

      if (read !== value) {
        return `Filesystem read back ${JSON.stringify(read)}, expected the written value.`;
      }
    } finally {
      await disk.delete(path).catch(() => {});
    }

    return true;
  },
};
