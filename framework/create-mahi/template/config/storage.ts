import { storage_path } from "@mahi/core";
import type { StorageConfig } from "@mahi/storage";

/**
 * `default` is `local` — a PRIVATE disk under `storage/app/private`, served
 * to nobody unless a route deliberately streams a file from it (see
 * `serveStoredFile`). This matches Laravel: `Storage.put()` with no disk
 * argument must not land somewhere the whole internet can read.
 *
 * The `public` disk is the opposite: everything on it is reachable at its
 * `url` prefix. `AppServiceProvider.routes()` registers
 * `GET /storage/*` → `servePublicDisk("public")` so `Storage.disk("public")
 * .url(path)` actually resolves. Put a file there only when it's meant to
 * be downloadable without an auth check.
 */
export function storageConfig(): StorageConfig {
  return {
    default: "local",
    disks: {
      local: { root: storage_path("app/private") },
      public: { root: storage_path("app/public"), url: "/storage" },
    },
  };
}
