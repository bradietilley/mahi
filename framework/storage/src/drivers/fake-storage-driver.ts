import { LocalStorageDriver } from "./local-storage-driver.js";

/**
 * The storage equivalent of Laravel's `Storage::fake($disk)`.
 *
 * A `LocalStorageDriver` pointed at an isolated temp directory, plus the
 * `assertExists`/`assertMissing` helpers a test wants. `@mahiframework/testing`'s
 * `createTestApplication({ fakeStorage: ["public"] })` builds one per named
 * disk (each with its own temp dir) and swaps it in via the manager, so
 * writes under test never touch the app's real disk roots.
 *
 * Assertions throw a plain `Error` on failure rather than using a vitest
 * matcher, keeping this package free of any test-runner dependency.
 */
export class FakeStorageDriver extends LocalStorageDriver {
  /**
   * @param root       the temp directory this fake disk is rooted at (used
   *                   only for error messages here — the parent resolves
   *                   against it).
   * @param urlPrefix  optional public URL prefix, mirroring a "public" disk.
   */
  constructor(
    private readonly rootDir: string,
    urlPrefix?: string,
  ) {
    super(rootDir, urlPrefix);
  }

  /** The temp directory backing this fake disk. */
  rootPath(): string {
    return this.rootDir;
  }

  /** Assert a file exists at `path`. Throws on failure. */
  async assertExists(path: string): Promise<void> {
    if (!(await this.exists(path))) {
      throw new Error(
        `Failed asserting that [${path}] exists on the fake disk (root: ${this.rootDir}).`,
      );
    }
  }

  /** Assert no file exists at `path`. Throws on failure. */
  async assertMissing(path: string): Promise<void> {
    if (await this.exists(path)) {
      throw new Error(
        `Failed asserting that [${path}] is missing on the fake disk (root: ${this.rootDir}).`,
      );
    }
  }
}
