import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  base_path,
  clearBasePath,
  database_path,
  resolvedBasePath,
  resource_path,
  setBasePath,
  storage_path,
} from "../src/paths.js";

describe("paths", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    clearBasePath();
  });

  describe("base_path", () => {
    it("returns process.cwd() when called with no arguments", () => {
      expect(base_path()).toBe(process.cwd());
    });

    it("joins any number of string segments onto process.cwd()", () => {
      expect(base_path("storage", "app", "public")).toBe(
        path.join(process.cwd(), "storage", "app", "public"),
      );
    });

    it("strips null and undefined segments before joining", () => {
      expect(base_path("storage", null, "app", undefined, "public")).toBe(
        path.join(process.cwd(), "storage", "app", "public"),
      );
    });

    it("resolves relative to whatever process.cwd() currently reports", () => {
      vi.spyOn(process, "cwd").mockReturnValue("/srv/my-app");

      expect(base_path("config")).toBe(path.join("/srv/my-app", "config"));
    });
  });

  describe("storage_path", () => {
    it("is base_path('storage', ...)", () => {
      expect(storage_path("app", "public")).toBe(
        path.join(process.cwd(), "storage", "app", "public"),
      );
    });

    it("returns the bare storage directory with no arguments", () => {
      expect(storage_path()).toBe(path.join(process.cwd(), "storage"));
    });
  });

  describe("resource_path", () => {
    it("is base_path('resources', ...)", () => {
      expect(resource_path("views", "welcome.html")).toBe(
        path.join(process.cwd(), "resources", "views", "welcome.html"),
      );
    });
  });

  describe("database_path", () => {
    it("is base_path('database', ...)", () => {
      expect(database_path("migrations")).toBe(path.join(process.cwd(), "database", "migrations"));
    });
  });

  /**
   * The compiled-CLI case: an installed binary can be run from any
   * directory, so cwd is meaningless to it and it pins its own data root
   * instead. Everything else must follow without being told.
   */
  describe("setBasePath", () => {
    it("overrides process.cwd() as base_path()'s root", () => {
      setBasePath("/home/someone/.config/myapp");

      expect(base_path()).toBe("/home/someone/.config/myapp");
      expect(base_path("token")).toBe(path.join("/home/someone/.config/myapp", "token"));
    });

    it("is ignored by default, so existing apps are unaffected", () => {
      expect(base_path()).toBe(process.cwd());
      expect(resolvedBasePath()).toBe(process.cwd());
    });

    it("wins over process.cwd() even as cwd changes underneath it", () => {
      setBasePath("/home/someone/.config/myapp");
      vi.spyOn(process, "cwd").mockReturnValue("/tmp/somewhere-else");

      expect(base_path()).toBe("/home/someone/.config/myapp");
    });

    /**
     * The derived helpers take no part in this — they already delegate to
     * `base_path()`. Asserted anyway because it is the entire point: an
     * app sets one root and its database, storage and logs all relocate
     * with it.
     */
    it("relocates storage_path/database_path/resource_path with it", () => {
      setBasePath("/home/someone/.config/myapp");

      expect(storage_path("logs/app.log")).toBe(
        path.join("/home/someone/.config/myapp", "storage", "logs/app.log"),
      );
      expect(database_path("app.sqlite")).toBe(
        path.join("/home/someone/.config/myapp", "database", "app.sqlite"),
      );
      expect(resource_path("views")).toBe(
        path.join("/home/someone/.config/myapp", "resources", "views"),
      );
    });

    it("is undone by clearBasePath(), restoring the cwd default", () => {
      setBasePath("/home/someone/.config/myapp");
      clearBasePath();

      expect(base_path()).toBe(process.cwd());
    });

    it("reports the chosen root through resolvedBasePath(), for diagnostics", () => {
      setBasePath("/home/someone/.config/myapp");

      expect(resolvedBasePath()).toBe("/home/someone/.config/myapp");
    });
  });
});
