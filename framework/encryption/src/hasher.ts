/**
 * One-way password hashing via argon2 (OWASP-recommended, winner of the
 * Password Hashing Competition), for "verify a password without ever
 * storing it in a reversible form" use cases. Fundamentally different
 * from `Encrypter`: never decryptable, only comparable via `check()`.
 */

import * as argon2 from "argon2";

/**
 * Tunable argon2 cost parameters. Omit to accept the argon2 library's
 * current defaults, the base app ships no `hashing` config file, so most
 * apps never touch these. Provide them only to deliberately trade CPU/RAM
 * for resistance to offline cracking (or to lower cost in constrained
 * environments).
 */
export interface HasherOptions {
  /** KiB of memory per hash (argon2 `memoryCost`). */
  memory?: number;
  /** Iterations (argon2 `timeCost`). */
  time?: number;
  /** Degree of parallelism (argon2 `parallelism`). */
  threads?: number;
}

export class Hasher {
  constructor(private readonly options: HasherOptions = {}) {}

  /**
   * argon2id is pinned EXPLICITLY rather than relying on the `argon2`
   * package's current default (also argon2id today, but a default is not
   * a contract). argon2id is the OWASP-recommended variant, hybrid
   * resistance to both GPU and side-channel attacks, so this is the one
   * we want auditable at the call site, not implied.
   */
  async make(value: string): Promise<string> {
    return argon2.hash(value, this.argonOptions());
  }

  async check(value: string, hash: string): Promise<boolean> {
    try {
      return await argon2.verify(hash, value);
    } catch {
      return false; // malformed hash, wrong algorithm, etc. — treat as "doesn't match", don't throw
    }
  }

  /**
   * Whether `hash` was produced with different parameters than `make()`
   * currently uses, call after a successful `check()` to transparently
   * upgrade a user's stored hash when argon2 defaults change:
   *
   *   if (await hasher.check(password, user.password)) {
   *     if (hasher.needsRehash(user.password)) {
   *       await User.update(user.id, { password: await hasher.make(password) });
   *     }
   *   }
   *
   * A malformed/unparseable hash returns `true` (i.e. "rehash it"), the
   * safe direction, since the alternative is leaving a hash we can't
   * reason about in place forever.
   *
   * The ALGORITHM and PARALLELISM checks are ours, not the library's, and
   * they are the reason this method isn't a one-line delegation.
   * `argon2.needsRehash()` compares only `version`, `memoryCost` and
   * `timeCost`, so an `argon2i` hash (the GPU-weak variant this class
   * pins `argon2id` specifically to avoid) reports "no rehash needed" and
   * `check()` happily keeps accepting it forever. Same for a hash written
   * with a different `p=`. Both are silent downgrades that survive every
   * subsequent login, so the PHC string is parsed and compared here.
   */
  needsRehash(hash: string): boolean {
    const options = this.argonOptions();

    let parsed;
    try {
      if (argon2.needsRehash(hash, options)) {
        return true;
      }

      parsed = parsePhc(hash);
    } catch {
      return true;
    }

    if (parsed === null) {
      return true;
    }

    // `make()` always pins argon2id, so anything else is stale by
    // definition, including the argon2i/argon2d hashes `verify()` still
    // accepts.
    if (parsed.type !== "argon2id") {
      return true;
    }

    // Only when parallelism is explicitly configured: an unconfigured
    // Hasher takes the library's default, and pinning that here would
    // mean a library upgrade silently marked every stored hash stale.
    const parallelism = options.parallelism;

    if (parallelism !== undefined && parsed.parallelism !== parallelism) {
      return true;
    }

    return false;
  }

  /**
   * Build the argon2 options object, always pinning `type: argon2id` and
   * layering any configured cost overrides on top. Cost keys are only
   * included when set, so an unconfigured `Hasher` uses the library
   * defaults for everything except the (explicit) algorithm.
   */
  private argonOptions(): argon2.Options {
    const options: argon2.Options = { type: argon2.argon2id };

    if (this.options.memory !== undefined) {
      options.memoryCost = this.options.memory;
    }

    if (this.options.time !== undefined) {
      options.timeCost = this.options.time;
    }

    if (this.options.threads !== undefined) {
      options.parallelism = this.options.threads;
    }

    return options;
  }
}

/**
 * The algorithm and parallelism out of a PHC-format argon2 hash
 * (`$argon2id$v=19$m=65536,t=3,p=4$<salt>$<hash>`), or null if it isn't
 * one.
 *
 * Deliberately narrow: only the two fields `argon2.needsRehash()` fails
 * to compare. Everything else it already checks, and re-deriving those
 * here would be a second, divergeable source of truth.
 */
function parsePhc(hash: string): { type: string; parallelism: number | undefined } | null {
  const fields = hash.split("$");
  // ["", type, v=…, m=…,t=…,p=…, salt, hash]. The parameter segment is
  // optional in the PHC spec, so only the type is required here.
  const type = fields[1];

  if (fields[0] !== "" || type === undefined || !type.startsWith("argon2")) {
    return null;
  }

  const parameters = fields.find((field) => field.includes("m=") && field.includes("t="));
  const parallelism = parameters === undefined ? undefined : /(?:^|,)p=(\d+)/.exec(parameters)?.[1];

  return {
    type,
    parallelism: parallelism === undefined ? undefined : Number(parallelism),
  };
}
