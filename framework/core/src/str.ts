import { randomBytes, randomUUID } from "node:crypto";

function splitWords(value: string): string[] {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[\s\-_]+/)
    .filter((word) => word.length > 0)
    .map((word) => word.toLowerCase());
}

function wrapNeedles(needles: string | readonly string[]): string[] {
  return typeof needles === "string" ? [needles] : [...needles];
}

const ULID_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function encodeUlidTime(now: number): string {
  let time = now;
  let encoded = "";

  for (let i = 0; i < 10; i++) {
    encoded = ULID_ALPHABET[time % 32] + encoded;
    time = Math.floor(time / 32);
  }

  return encoded;
}

function encodeUlidRandom(): string {
  const bytes = randomBytes(10);
  let value = 0n;

  for (const byte of bytes) {
    value = (value << 8n) + BigInt(byte);
  }

  let encoded = "";

  for (let i = 0; i < 16; i++) {
    encoded = ULID_ALPHABET[Number(value % 32n)] + encoded;
    value /= 32n;
  }

  return encoded;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ULID_RE = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/i;

/** Escape a string so it can appear as a literal inside a `RegExp`. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Minimal English inflector, enough for model/table name derivation
// (`make:model`), not a full linguistics engine. Irregulars and the common
// suffix rules Laravel's Pluralizer covers most often.
const IRREGULAR_PLURALS: Record<string, string> = {
  child: "children",
  person: "people",
  man: "men",
  woman: "women",
  tooth: "teeth",
  foot: "feet",
  mouse: "mice",
  goose: "geese",
};
const IRREGULAR_SINGULARS: Record<string, string> = Object.fromEntries(
  Object.entries(IRREGULAR_PLURALS).map(([singular, plural]) => [plural, singular]),
);
const UNCOUNTABLE = new Set([
  "sheep",
  "fish",
  "series",
  "species",
  "money",
  "information",
  "equipment",
  "deer",
]);

function matchCase(source: string, target: string): string {
  if (source === source.toUpperCase() && source !== source.toLowerCase()) {
    return target.toUpperCase();
  }

  if (source.charAt(0) === source.charAt(0).toUpperCase()) {
    return target.charAt(0).toUpperCase() + target.slice(1);
  }

  return target;
}

export const Str = {
  slug(value: string, separator = "-"): string {
    const escaped = escapeRegExp(separator);

    return value
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, separator)
      .replace(new RegExp(`^(?:${escaped})+|(?:${escaped})+$`, "g"), "");
  },

  camel(value: string): string {
    const words = splitWords(value);

    return words
      .map((word, index) => (index === 0 ? word : word.charAt(0).toUpperCase() + word.slice(1)))
      .join("");
  },

  snake(value: string): string {
    return splitWords(value).join("_");
  },

  kebab(value: string): string {
    return splitWords(value).join("-");
  },

  studly(value: string): string {
    return splitWords(value)
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join("");
  },

  limit(value: string, length: number, suffix = "..."): string {
    return value.length <= length ? value : value.slice(0, length).trimEnd() + suffix;
  },

  random(length = 16): string {
    return randomBytes(Math.ceil(length / 2))
      .toString("hex")
      .slice(0, length);
  },

  contains(haystack: string, needles: string | readonly string[]): boolean {
    return wrapNeedles(needles).some((needle) => needle !== "" && haystack.includes(needle));
  },

  startsWith(haystack: string, needles: string | readonly string[]): boolean {
    return wrapNeedles(needles).some((needle) => needle !== "" && haystack.startsWith(needle));
  },

  endsWith(haystack: string, needles: string | readonly string[]): boolean {
    return wrapNeedles(needles).some((needle) => needle !== "" && haystack.endsWith(needle));
  },

  isUuid(value: string): boolean {
    return UUID_RE.test(value);
  },

  isUlid(value: string): boolean {
    return ULID_RE.test(value);
  },

  isJson(value: string): boolean {
    if (value.trim() === "") {
      return false;
    }

    try {
      JSON.parse(value);

      return true;
    } catch {
      return false;
    }
  },

  after(subject: string, search: string): string {
    if (search === "") {
      return subject;
    }

    const index = subject.indexOf(search);

    return index === -1 ? subject : subject.slice(index + search.length);
  },

  afterLast(subject: string, search: string): string {
    if (search === "") {
      return subject;
    }

    const index = subject.lastIndexOf(search);

    return index === -1 ? subject : subject.slice(index + search.length);
  },

  before(subject: string, search: string): string {
    if (search === "") {
      return subject;
    }

    const index = subject.indexOf(search);

    return index === -1 ? subject : subject.slice(0, index);
  },

  beforeLast(subject: string, search: string): string {
    if (search === "") {
      return subject;
    }

    const index = subject.lastIndexOf(search);

    return index === -1 ? subject : subject.slice(0, index);
  },

  /** Between the first `from` and the last `to` after it, Laravel's `Str::between`. */
  between(subject: string, from: string, to: string): string {
    return Str.beforeLast(Str.after(subject, from), to);
  },

  substr(value: string, start: number, length?: number): string {
    return length === undefined ? value.slice(start) : value.slice(start, start + length);
  },

  lower(value: string): string {
    return value.toLowerCase();
  },

  upper(value: string): string {
    return value.toUpperCase();
  },

  title(value: string): string {
    return value
      .toLowerCase()
      .replace(/(^|[^\p{L}\p{N}])(\p{L})/gu, (_match, boundary: string, letter: string) => {
        return boundary + letter.toUpperCase();
      });
  },

  ucfirst(value: string): string {
    return value.length === 0 ? value : value.charAt(0).toUpperCase() + value.slice(1);
  },

  words(value: string, words = 100, end = "..."): string {
    const match = value.match(new RegExp(`^\\s*(?:\\S+\\s*){1,${words}}`));

    if (!match || match[0].length >= value.length) {
      return value;
    }

    return match[0].trimEnd() + end;
  },

  uuid(): string {
    return randomUUID();
  },

  /**
   * A UUID version 7, RFC 9562: a 48-bit big-endian millisecond
   * timestamp, then 74 random bits, with the version and variant fields
   * in between.
   *
   * Unlike `uuid()` (v4, uniformly random) these sort lexicographically
   * in creation order, which is the whole point. A v4 primary key
   * scatters inserts across a B-tree at random, fragmenting the index and
   * dirtying a new page per write; v7 appends, so the hot leaf stays in
   * cache. The same property makes `order by id` a valid proxy for
   * `order by created_at` without a second index.
   *
   * The cost is that a v7 leaks its creation time to anyone holding one.
   * That is usually harmless for a row id and occasionally is not, do
   * not use it for a value that doubles as a capability, like an
   * unguessable share link, where the timestamp narrows a brute-force
   * search.
   */
  uuid7(): string {
    const bytes = randomBytes(16);
    const now = Date.now();

    // 48-bit timestamp, big-endian, across bytes 0-5. Written with
    // arithmetic rather than a DataView so the value stays exact: it is
    // well under 2^53, so `Math.floor(now / 2 ** 32)` loses nothing.
    bytes[0] = Math.floor(now / 2 ** 40) & 0xff;
    bytes[1] = Math.floor(now / 2 ** 32) & 0xff;
    bytes[2] = Math.floor(now / 2 ** 24) & 0xff;
    bytes[3] = Math.floor(now / 2 ** 16) & 0xff;
    bytes[4] = Math.floor(now / 2 ** 8) & 0xff;
    bytes[5] = now & 0xff;

    // Version 7 in the high nibble of byte 6, RFC 4122 variant (10xx) in
    // the top two bits of byte 8. The remaining bits stay random.
    bytes[6] = (bytes[6]! & 0x0f) | 0x70;
    bytes[8] = (bytes[8]! & 0x3f) | 0x80;

    const hex = bytes.toString("hex");

    return (
      `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-` +
      `${hex.slice(16, 20)}-${hex.slice(20)}`
    );
  },

  /**
   * A time-ordered UUID, currently an alias for `uuid7()`.
   *
   * Named for intent rather than version, matching Laravel's
   * `Str::orderedUuid()`. Use this when what you want is "a UUID
   * that sorts by creation time"; the RFC version delivering that is an
   * implementation detail that has already changed once (Laravel's
   * original used a COMB-style layout predating v7's standardisation).
   */
  orderedUuid(): string {
    return Str.uuid7();
  },

  ulid(): string {
    return encodeUlidTime(Date.now()) + encodeUlidRandom();
  },

  /** Naive English pluralization, preserving the case of `value`. Uncountable words are returned unchanged. */
  plural(value: string, count = 2): string {
    if (count === 1 || value === "") {
      return value;
    }

    const lower = value.toLowerCase();

    if (UNCOUNTABLE.has(lower)) {
      return value;
    }

    if (IRREGULAR_PLURALS[lower]) {
      return matchCase(value, IRREGULAR_PLURALS[lower]!);
    }

    if (/(s|x|z|ch|sh)$/i.test(value)) {
      return `${value}es`;
    }

    if (/[^aeiou]y$/i.test(value)) {
      return `${value.slice(0, -1)}ies`;
    }

    if (/(f|fe)$/i.test(value)) {
      return value.replace(/fe?$/i, "ves");
    }

    return `${value}s`;
  },

  /** Naive English singularization, preserving the case of `value`. */
  singular(value: string): string {
    if (value === "") {
      return value;
    }

    const lower = value.toLowerCase();

    if (UNCOUNTABLE.has(lower)) {
      return value;
    }

    if (IRREGULAR_SINGULARS[lower]) {
      return matchCase(value, IRREGULAR_SINGULARS[lower]!);
    }

    if (/ies$/i.test(value) && value.length > 3) {
      return `${value.slice(0, -3)}y`;
    }

    if (/ves$/i.test(value)) {
      return value.replace(/ves$/i, "f");
    }

    if (/(ses|xes|zes|ches|shes)$/i.test(value)) {
      return value.slice(0, -2);
    }

    if (/s$/i.test(value) && !/ss$/i.test(value)) {
      return value.slice(0, -1);
    }

    return value;
  },

  /** Pad the left of `value` up to `length` with `pad` (repeating). Laravel's `Str::padLeft`. */
  padLeft(value: string, length: number, pad = " "): string {
    if (pad === "" || value.length >= length) {
      return value;
    }

    return value.padStart(length, pad);
  },

  /** Pad the right of `value` up to `length` with `pad` (repeating). Laravel's `Str::padRight`. */
  padRight(value: string, length: number, pad = " "): string {
    if (pad === "" || value.length >= length) {
      return value;
    }

    return value.padEnd(length, pad);
  },

  /** Ensure `value` ends with `cap` (adding it only if absent). Laravel's `Str::finish`. */
  finish(value: string, cap: string): string {
    return value.endsWith(cap)
      ? value
      : `${value.replace(new RegExp(`(?:${escapeRegExp(cap)})+$`), "")}${cap}`;
  },

  /** Ensure `value` starts with `prefix` (adding it only if absent). Laravel's `Str::start`. */
  start(value: string, prefix: string): string {
    return value.startsWith(prefix)
      ? value
      : `${prefix}${value.replace(new RegExp(`^(?:${escapeRegExp(prefix)})+`), "")}`;
  },

  /** Replace the first occurrence of `search` in `subject`. Laravel's `Str::replaceFirst`. */
  replaceFirst(search: string, replace: string, subject: string): string {
    if (search === "") {
      return subject;
    }

    const index = subject.indexOf(search);

    return index === -1
      ? subject
      : subject.slice(0, index) + replace + subject.slice(index + search.length);
  },

  /** Replace the last occurrence of `search` in `subject`. Laravel's `Str::replaceLast`. */
  replaceLast(search: string, replace: string, subject: string): string {
    if (search === "") {
      return subject;
    }

    const index = subject.lastIndexOf(search);

    return index === -1
      ? subject
      : subject.slice(0, index) + replace + subject.slice(index + search.length);
  },

  /** Collapse all runs of whitespace to a single space and trim. Laravel's `Str::squish`. */
  squish(value: string): string {
    return value.replace(/\s+/g, " ").trim();
  },

  /** Count the words in `value`. Laravel's `Str::wordCount`. */
  wordCount(value: string): number {
    const match = value.match(/\S+/g);

    return match ? match.length : 0;
  },

  /**
   * Title-case a run of words in "Human Readable" form, splitting on
   * spaces/underscores/dashes and camelCase boundaries. Laravel's
   * `Str::headline`.
   */
  headline(value: string): string {
    return splitWords(value)
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(" ");
  },

  /**
   * Mask a portion of `value` with `character`, starting at `index` (a
   * negative index counts from the end) for `length` characters (or to the
   * end when `length` is omitted). Laravel's `Str::mask`.
   */
  mask(value: string, character: string, index: number, length?: number): string {
    if (character === "") {
      return value;
    }

    const mask = character.charAt(0);
    const start = index < 0 ? Math.max(value.length + index, 0) : Math.min(index, value.length);
    const end =
      length === undefined ? value.length : Math.min(start + Math.max(length, 0), value.length);

    return value.slice(0, start) + mask.repeat(Math.max(end - start, 0)) + value.slice(end);
  },

  /**
   * Whether `value` matches `pattern`, where `*` is a wildcard for any run
   * of characters (Laravel's `Str::is`). `pattern` may be one string or a
   * list, any match returns `true`.
   */
  is(pattern: string | readonly string[], value: string): boolean {
    for (const p of wrapNeedles(pattern)) {
      if (p === value) {
        return true;
      }

      const regex = new RegExp(`^${escapeRegExp(p).replace(/\\\*/g, ".*")}$`, "s");

      if (regex.test(value)) {
        return true;
      }
    }

    return false;
  },

  /**
   * HTML-escape the five characters that are significant in HTML text and
   * double-quoted attribute contexts (`&`, `<`, `>`, `"`, `'`), Laravel's
   * `e()` / `Str::escape` helper. Use it when interpolating untrusted data
   * into an HTML mail body (or any HTML string) built by hand:
   *
   *   `<p>Hi ${Str.escapeHtml(user.name)}</p>`
   *
   * `&` is replaced first so the entities produced for the other four are
   * not themselves re-escaped.
   */
  escapeHtml(value: string): string {
    return value
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  },
} as const;
