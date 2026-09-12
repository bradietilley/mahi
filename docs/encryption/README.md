# Encryption & hashing

`@mahiframework/encryption` ships three primitives, and choosing between them is
the whole game:

| Class | Operation | Reversible | Use for |
|---|---|---|---|
| `Encrypter` | AES-256-GCM | **Yes**, with the key | "Store this securely, get the exact value back later" |
| `Hasher` | argon2id | **Never** | Passwords — verify without ever storing a reversible form |
| `Signer` | HMAC-SHA256 | N/A — the payload is public | "This value really came from us and hasn't been edited" |

```ts
import { Crypt, Hash } from "@mahiframework/encryption";

const sealed = Crypt.encrypt("sensitive value");
const original = Crypt.decrypt(sealed);

const hash = await Hash.make("user-password");
const matches = await Hash.check("user-password", hash);
```

All three are registered by `EncryptionServiceProvider`, which has no
ordering dependency on any other provider — but
[`@mahiframework/auth`](../authentication/) depends on it, so list it earlier than
`AuthServiceProvider`.

## The application key

Everything derives from one env var.

```bash
./artisan key:generate
```

```
APP_KEY=base64:qDIsZM+u4RnAWXO1zLbrxUZlHMi5aOoiVGCPnzsFYY0=
```

### `parseAppKey(raw)`

```ts
export function parseAppKey(raw: string | undefined): Buffer
```

Strips an optional `base64:` prefix, base64-decodes the rest, and asserts
the result is **exactly 32 bytes**. Anything else throws:

- Unset or empty →
  `"APP_KEY is not set. Run ./artisan key:generate and add the printed value to your .env file."`
- Wrong decoded length →
  `"APP_KEY must decode to exactly 32 bytes (got N)."`

The `base64:` prefix is optional on input — a bare base64 string parses
fine — but `key:generate` always writes it, matching Laravel, so the value
is self-describing in a `.env` file.

Failing at boot is deliberate. A short key would still "work" for AES only
because Node would reject it later, at a random call site, in production.

### `deriveKey(masterKey, context)`

```ts
export function deriveKey(masterKey: Buffer, context: string): Buffer
```

HKDF-SHA256 (RFC 5869), producing a 32-byte subkey. No salt is used, since
the master key is already a high-entropy secret; `context` is the HKDF
`info` parameter.

The provider derives exactly two:

```ts
new Encrypter(deriveKey(masterKey, "encryption"), /* ... */);
new Signer(deriveKey(masterKey, "signing"), /* ... */);
```

**Why separate keys rather than handing the raw `APP_KEY` to both?**
Reusing one key across two different primitives means a compromise of one
also exposes the other — leak the ciphertext key and you've leaked the
signing key, so an attacker can now forge session cookies and signed URLs
too, not merely read encrypted columns. Deriving per-purpose subkeys is
real defense-in-depth, and it costs the operator nothing: `APP_KEY`
remains the single value that needs generating, rotating, and backing up.

The derivation is one-way, so holding the encryption subkey tells you
nothing about the master key or the signing subkey.

### `parsePreviousAppKeys(raw)`

```ts
export function parsePreviousAppKeys(raw: string | undefined): Buffer[]
```

Parses `APP_PREVIOUS_KEYS` — a comma-separated list of previously-active
`APP_KEY` values, each optionally `base64:`-prefixed:

```bash
APP_PREVIOUS_KEYS=base64:oldkey1...,base64:oldkey2...
```

Unlike `parseAppKey()`, an unset or empty value is **not** an error — it
just means no previous keys, which is the common case. Individual
malformed entries **do** throw, on the theory that a typo'd previous key
should fail loudly at boot rather than silently making some old
ciphertexts undecryptable.

Each previous master key is HKDF-derived the same way and passed to
`Encrypter`/`Signer` as decrypt/verify-only fallbacks.

## `key:generate`

```bash
./artisan key:generate                 # writes APP_KEY if unset
./artisan key:generate --path .env.ci  # target a different file
./artisan key:generate --force         # rotate an existing key
```

| Flag | Default | Effect |
|---|---|---|
| `-p, --path <path>` | `.env` | The env file to write |
| `-f, --force` | `false` | Overwrite an existing `APP_KEY` |

Generates `base64:${randomBytes(32).toString("base64")}` and writes it
into the file, replacing an existing `APP_KEY=` line or appending one.

**It never overwrites an existing key without `--force`.** Doing so would
silently make any data already encrypted with the old key permanently
undecryptable, and any already-issued session cookie or signed URL
unverifiable. If a key is set, it prints a message and exits without
touching the file:

```
APP_KEY is already set in .env — leaving it unchanged. Pass --force to rotate it.
```

### Rotation, and the step it does not do for you

`--force` touches **only `APP_KEY`**. It never populates
`APP_PREVIOUS_KEYS`. That's Laravel parity, and it's deliberate: the
outgoing key is unrecoverable once overwritten, and the operator should
choose how many previous keys to retain (or none, if the old data is being
re-encrypted or discarded anyway) rather than having the list grow
unbounded automatically.

So the safe sequence is:

```bash
# 1. Copy the CURRENT value of APP_KEY into APP_PREVIOUS_KEYS by hand,
#    BEFORE rotating. The command cannot recover it afterwards.
#    APP_PREVIOUS_KEYS=base64:the-old-value

# 2. Now rotate.
./artisan key:generate --force

# 3. Restart. Encrypter/Signer pick up both keys.
```

After that, new writes use the new key and old ciphertexts/signatures
still resolve. Once you're confident nothing old is left — see
[re-encryption](#no-automatic-re-encryption) — drop the entry from
`APP_PREVIOUS_KEYS`.

## `Encrypter`

AES-256-GCM, built into `node:crypto` — no new dependency. **Authenticated
encryption**, so tampering with the ciphertext is detected on decrypt
(throws) rather than silently producing garbage or, worse,
plausible-looking incorrect plaintext.

```ts
class Encrypter {
  constructor(key: Buffer, previousKeys?: Buffer[]);
  encrypt(value: string, aad?: string): string;
  decrypt(payload: string, aad?: string): string;
}
```

The constructor asserts **every** key is exactly 32 bytes — the current
one and each previous one — so a bad rotation entry fails at boot, not on
the first decrypt that needs it.

### Wire format

```
base64url( version[1] || iv[12] || authTag[16] || ciphertext )
```

| Segment | Bytes | Source |
|---|---|---|
| Version | 1 | Always `0x01` |
| IV | 12 | `randomBytes(12)` — GCM's standard nonce size, fresh per call |
| Auth tag | 16 | `cipher.getAuthTag()` |
| Ciphertext | rest | The encrypted UTF-8 payload |

One base64url string, no JSON envelope. Because the IV is random per
call, encrypting the same value twice produces different output — that's
correct and required; a fixed IV under GCM is catastrophic.

The minimum valid payload is therefore **29 bytes** (an encrypted empty
string). Anything shorter, or carrying an unrecognised version byte, is
rejected before any crypto runs.

#### Why a version byte

It's the migration path. A v2 (different cipher, different KDF) can be
told apart from v1 by dispatching on the first byte, instead of guessing
at what a stored ciphertext is. Adding the byte *after* a release would
mean rewriting every encrypted value in every deployed database, so it is
there from the start.

The version byte is included in the GCM additional authenticated data, so
flipping it to force a downgrade to some weaker future format fails
authentication rather than being silently honoured.

### Auth tag length is enforced

`createDecipheriv` is passed `{ authTagLength: 16 }`, and `decrypt()`
length-checks the payload before slicing. Both matter:

```ts
if (raw.length < MIN_PAYLOAD_BYTES) throw ...
const decipher = createDecipheriv("aes-256-gcm", candidateKey, iv, { authTagLength: 16 });
```

Without `authTagLength`, **Node accepts 4, 8, 12 and 13–16-byte GCM
tags** — a payload carrying a 4-byte tag decrypts successfully. Against a
decrypt oracle that drops forgery cost from 2⁻¹²⁸ to 2⁻³² per attempt,
and a handful of successes recovers the GHASH subkey outright
(Ferguson's short-tag attack). The length guard is needed alongside it
because `Buffer.subarray` silently returns a short buffer rather than
throwing, so a truncated payload would otherwise reach `setAuthTag()`
with a stub tag. **Do not remove either.**

### Binding ciphertext to a context (`aad`)

Both methods take an optional additional-authenticated-data string. It is
authenticated but *not* encrypted, and **not stored in the payload** —
whatever `encrypt()` was given must be passed to `decrypt()` again by the
caller.

```ts
const stored = Crypt.encrypt(ssn, "users.ssn");

Crypt.decrypt(stored, "users.ssn");    // fine
Crypt.decrypt(stored, "users.notes");  // throws
Crypt.decrypt(stored);                 // throws
```

Use it to pin a value to where it lives. Without it, ciphertext is
portable: an attacker with write access to one column can copy an
encrypted value from another column or another row and have it decrypt
perfectly happily in its new home. With it, the value only decrypts in
the context it was encrypted for.

`decrypt()` slices the segments back out by fixed offsets.

### Key rotation on decrypt

`encrypt()` **always** uses the current key, never a previous one.
`decrypt()` tries the current key first, then each of `previousKeys` in
order; the first that decrypts *and* passes GCM's authentication check
wins:

```ts
for (const candidateKey of [this.key, ...this.previousKeys]) {
  try {
    const decipher = createDecipheriv("aes-256-gcm", candidateKey, iv, { authTagLength: 16 });
    decipher.setAAD(additionalData);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf-8");
  } catch {
    continue;
  }
}

throw new Error("Unable to decrypt payload — invalid key, corrupted data, or tampering detected.");
```

The GCM auth tag is what makes trying keys in sequence safe: a wrong key
doesn't produce wrong plaintext, it throws. Only a genuinely correct key
authenticates.

Every failure mode collapses into one error — wrong key, corrupted bytes,
deliberate tampering. That's intentional: distinguishing them tells an
attacker probing your endpoint which of those they achieved.

### No automatic re-encryption

Decrypting successfully under a **previous** key does not re-encrypt the
value under the current one. Same as Laravel. A silent write on a read
path would be a surprising side effect, would need a database handle the
`Encrypter` doesn't have, and would turn a read-only request into a write.

Callers that want re-encryption do it explicitly, as a deliberate
migration:

```ts
// A one-off command, run after rotating.
for (const row of await Document.query().get()) {
  await Document.update(row.id, { body: Crypt.encrypt(Crypt.decrypt(row.body)) });
}
```

Until that runs, keep the old key in `APP_PREVIOUS_KEYS`.

### `Crypt`

The facade over the `ENCRYPTER_TOKEN` singleton.

| Static | Returns |
|---|---|
| `Crypt.encrypt(value, aad?)` | `string` |
| `Crypt.decrypt(payload, aad?)` | `string` |

Prefer constructor-injecting `Encrypter` via `ENCRYPTER_TOKEN` where
that's practical — inside a `ServiceProvider` or `Command` that already
receives `app`. Reach for the facade only where threading
`app`/`Encrypter` through is genuinely inconvenient, the same guidance as
`app()` itself.

## `Hasher`

One-way password hashing via argon2 — OWASP-recommended, winner of the
Password Hashing Competition. Fundamentally different from `Encrypter`:
**never decryptable**, only comparable via `check()`.

```ts
class Hasher {
  constructor(options?: HasherOptions);
  make(value: string): Promise<string>;
  check(value: string, hash: string): Promise<boolean>;
  needsRehash(hash: string): boolean;
}
```

### argon2id is pinned explicitly

```ts
private argonOptions(): argon2.Options {
  const options: argon2.Options = { type: argon2.argon2id };
  // ...
}
```

The `argon2` package's current default is also argon2id, but **a default
is not a contract**. argon2id is the OWASP-recommended variant — hybrid
resistance to both GPU and side-channel attacks — so it's the one thing
here worth being auditable at the call site rather than implied.

### Cost parameters

```ts
export interface HasherOptions {
  memory?: number;    // KiB per hash (argon2 memoryCost)
  time?: number;      // iterations (argon2 timeCost)
  threads?: number;   // parallelism
}
```

Read from a `hashing` config namespace. **The base app ships no
`config/hashing.ts`**, so an absent namespace yields `{}` and the library
defaults apply — with argon2id still pinned. Cost keys are only included
when set, so an unconfigured `Hasher` never overrides a default it doesn't
mean to.

Provide them only to deliberately trade CPU/RAM for resistance to offline
cracking, or to lower cost in constrained environments.

### `check()` never throws

```ts
async check(value: string, hash: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, value);
  } catch {
    return false;   // malformed hash, wrong algorithm, etc.
  }
}
```

A malformed hash, a hash from a different algorithm, an empty string —
all return `false`. "Doesn't match" is the correct answer for a stored
value we can't parse; throwing would turn a bad row into a 500 on a login
route.

### `needsRehash()` and rehash-on-login

```ts
needsRehash(hash: string): boolean
```

Whether `hash` was produced with different parameters than `make()`
currently uses. Note the asymmetry with `check()`:

| Input | `check()` | `needsRehash()` |
|---|---|---|
| Valid hash, right password | `true` | per-parameters |
| Valid hash, wrong password | `false` | per-parameters |
| **Malformed / unparseable hash** | **`false`** | **`true`** |

Both directions are the safe one. `check()` failing closed means an
unreadable hash never authenticates; `needsRehash()` returning `true`
means it gets replaced rather than left in place forever as a value
nothing can reason about.

#### It checks the algorithm too, not just cost

`needsRehash()` compares four things: **argon2 variant**, `version`,
`memoryCost`, and `timeCost` — plus `parallelism` when you have
configured it explicitly.

The variant and parallelism checks are the framework's, not the `argon2`
library's. `argon2.needsRehash()` compares only version/memory/time, so
an `argon2i` hash — the GPU-weak variant `make()` pins `argon2id`
specifically to avoid — reported "no rehash needed" while `check()`
happily kept accepting it. A silent downgrade that survived every
subsequent login. Hashes with a different `p=` had the same problem.

Parallelism is only compared when `hashing.threads` is set. An
unconfigured `Hasher` takes the library's default, and pinning that would
mean a library upgrade silently marked every stored hash stale, forcing a
fleet-wide rehash nobody asked for.

Login is **the one moment the framework legitimately holds the
plaintext**, so it's the only place a stored hash can be transparently
upgraded. The base app's login controller does exactly this:

```ts
const user = await Auth.attempt<UserTable>({ email: body.email, password: body.password });

if (user === null) {
  throw HttpError.unauthorized("Invalid credentials.");
}

// Transparently upgrade the stored hash if argon2's parameters have
// moved on since it was written.
if (Hash.needsRehash(user.password)) {
  await User.update(user.id, { password: await Hash.make(body.password) });
}
```

Order matters: verify first, rehash second. Rehashing before verifying
would happily store a hash of whatever an attacker submitted.

The effect is that raising cost parameters in `config/hashing.ts` migrates
your user base gradually, as people log in, with no batch job and no
forced password reset — because you can't re-derive a stronger hash from a
weaker one, only from the plaintext.

### `Hash`

The facade over `HASHER_TOKEN`.

| Static | Returns |
|---|---|
| `Hash.make(value)` | `Promise<string>` |
| `Hash.check(value, hash)` | `Promise<boolean>` |
| `Hash.needsRehash(hash)` | `boolean` |

`Hash.make()` is what registration should use, and the hash is what the
model stores — never the plaintext, and the base app's `User` model lists
`password` in `static hidden` as defense-in-depth so it can't reach the
wire even if an instance is returned directly.

### Not for API tokens

`@mahiframework/auth`'s personal access tokens are hashed with **SHA-256, not
argon2**, and that is deliberate. argon2's slowness exists to make
brute-forcing *human-chosen* passwords infeasible; a 32-byte random token
has no low-entropy space to brute-force, so the slowness buys nothing
while costing ~50–100ms on every authenticated API request. Full reasoning
in [Authentication](../authentication/#why-sha-256-not-argon2).

Password **reset** tokens *are* argon2-hashed, because they're verified
once per reset rather than once per request.

## `Signer`

HMAC-SHA256 sign/verify for values that don't need to stay secret, just
verifiably unmodified.

```ts
class Signer {
  constructor(key: Buffer, previousKeys?: Buffer[]);
  for(purpose: string): Signer;           // purpose-scoped sub-signer
  sign(payload: string): string;          // `${payload}.${hmac}`
  verify(signedPayload: string): string | null;
}
```

```ts
const signed = signer.sign("session-id-here");
// "session-id-here.mfVYqDmvOMZTMcQi0ck7uHLElFqDFPvhTHXtwGDpEyU"

signer.verify(signed);       // "session-id-here"
signer.verify(tampered);     // null
```

`verify()` returns the **payload** on success and `null` on failure — not
a boolean — so a caller can't accidentally use an unverified value. The
session guard relies on this: `readSessionId()` is just
`this.signer.verify(rawCookie)`, and `null` (tampered, or signed with a
key no longer trusted) short-circuits before the store is ever queried.

### It splits on the last dot

```ts
const lastDot = signedPayload.lastIndexOf(".");
if (lastDot === -1) return null;

const payload = signedPayload.slice(0, lastDot);
const signature = signedPayload.slice(lastDot + 1);
```

**`lastIndexOf`, not `indexOf`.** The signature is base64url and never
contains a dot, but the payload might — `"user.42"`, a dotted filename, a
serialized path. Splitting on the *first* dot would corrupt any such
payload, and the HMAC would then be computed over the wrong string, so
every legitimate value with a dot in it would fail to verify.

### `timingSafeEqual`, not `===`

```ts
function signaturesMatch(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}
```

This is the one genuinely security-critical detail in the class. Naive
`a === b` string comparison short-circuits at the first differing byte, so
the time it takes to fail correlates with how many leading bytes an
attacker guessed correctly — enough, over many requests, to reconstruct a
valid signature byte by byte. **Do not "simplify" this back to `===`.**

The length check first is required, not an optimization:
`timingSafeEqual` throws on buffers of unequal length.

### Key rotation

Same shape as `Encrypter`: `sign()` always uses the current key,
`verify()` tries the current key then each of `previousKeys` in order. So
session cookies and signed URLs issued before a rotation keep verifying
afterwards, as long as the old key is retained in `APP_PREVIOUS_KEYS`.

### Key length

The constructor rejects any key (current or previous) shorter than **32
bytes** — HMAC-SHA256 will technically accept a shorter or even empty
key, but that's a silent downgrade of the whole scheme, so it fails loudly
instead. In practice every key comes from `deriveKey()` and is already 32
bytes.

### Purpose separation — `signer.for(purpose)`

`for()` returns a `Signer` whose keys are HKDF-derived under
`signing:<purpose>`, giving each consumer its own key space:

```ts
signer.for("session").sign(sessionId);   // session guard
signer.for("url").sign("/verify?id=1");  // signed URLs
```

A signature minted under one purpose does **not** verify under another:

```ts
const token = signer.for("url").sign("550e8400-e29b-41d4-a716-446655440000");
signer.for("session").verify(token);   // null
```

That's the point. Both consumers previously shared the raw `SIGNER_TOKEN`
key, and their payload shapes are the only thing that kept them apart —
session ids are bare UUIDs, URL payloads start with `/`. Any feature that
signed a user-controlled string could be used as an oracle: get it to sign
something shaped like a session id, and the resulting signature is a
valid session cookie for that session. Distinct derived keys remove the
overlap entirely rather than relying on payloads never colliding.

Both wirings are internal — `SessionGuard` narrows to `"session"` in its
constructor and `resolveSigner()` narrows to `"url"` — so callers get the
separation without doing anything. Apply `for()` to any new consumer that
signs its own payloads.

Rotation composes with it: previous keys are derived under the same
purpose, so `for("session")` on a rotated signer still verifies cookies
issued before the rotation.

## Signed URLs

`@mahiframework/http` wraps `Signer` into tamper-evident, optionally-expiring
links — the equivalent of Laravel's `URL::signedRoute()` plus the
`ValidateSignature` middleware. It uses `Signer` (HMAC) rather than
`Encrypter` because the payload doesn't need to stay secret, only
tamper-evident; key rotation comes for free.

```
/verify-email?id=427185966743560456&expires=1774000000&signature=<hmac>
```

The HMAC covers the path plus **every query param except `signature`
itself**, in sorted order so build and verify agree regardless of param
ordering. That's `canonicalPayload()`, shared by both sides.

Because `expires` participates in the signature, an attacker can't extend
the deadline; because `id` does, they can't swap in someone else's.

### Building

```ts
import { signedUrl, URL } from "@mahiframework/http";

// Raw path
const link = signedUrl("/verify-email", { id: user.id }, { expiresInSeconds: 3600 });

// Named route — substitutes {param} segments, then signs
const link = URL.signedRoute("verification.verify", { id: user.id }, { expiresInSeconds: 3600 });
```

| Option | Meaning |
|---|---|
| `expiresInSeconds` | Seconds from now. Omit for a non-expiring signature. |
| `signer` | Override the resolved `Signer` (tests) |
| `now` | Absolute unix-seconds override for "now" (tests) |

`signedRoute()` throws if `signature` or `expires` appear in your params —
they're reserved. It signs the **relative** path regardless of
`absolute`, because that's what the receiving end rebuilds.

### Verifying

```ts
import { validateSignature, hasValidSignature } from "@mahiframework/http";

router.get("/verify-email", VerifyEmailController)
  .middleware(validateSignature());
```

`validateSignature()` throws `HttpError.forbidden("Invalid signature.")`
for a missing, tampered, or expired signature. `hasValidSignature(request)`
is the non-throwing boolean form it's built on.

Expiry is checked before the HMAC, and a non-numeric `expires` fails
closed.

See [Routing](../routing/) for URL generation and
[Authentication](../authentication/#email-verification) for the full
email-verification flow.

## `timebox()`

```ts
export function timebox<T>(fn: () => T | Promise<T>, minMs: number): Promise<T>
```

Runs `fn`, then waits so the **total** elapsed time is at least `minMs`
regardless of which branch `fn` took.

```ts
import { timebox } from "@mahiframework/encryption";

const result = await timebox(() => broker.sendResetLink(body.email), 250);
```

This is the general-purpose form of the constant-time trick
`AuthManager.attempt()` open-codes — hashing a throwaway value so a
missing user costs the same as a wrong password. Flows like password reset
need the same property but have no natural "hash something" step to lean
on: a "no such account" path returns almost instantly, while "account
exists, mint a token, write a row, send mail" takes far longer. That
difference leaks account existence by timing alone, no matter how careful
the response body is.

Two behaviours worth knowing:

- If `fn` already takes longer than `minMs`, **no extra delay is added**.
  It's a floor, not a fixed duration.
- **A thrown error is delayed too**, then rethrown — so the error path
  can't be distinguished by timing either. That's the part a hand-rolled
  version usually gets wrong.

Pick `minMs` above the slow path's typical duration. Too low and the floor
never binds; too high and you've added latency for nothing.

## Container tokens

| Token | Bound to |
|---|---|
| `ENCRYPTER_TOKEN` (`"encrypter"`) | `Encrypter` |
| `HASHER_TOKEN` (`"hasher"`) | `Hasher` |
| `SIGNER_TOKEN` (`"signer"`) | `Signer` |

All three are singletons registered by `EncryptionServiceProvider`, which
also contributes the `key:generate` command.

```ts
import { HASHER_TOKEN, type Hasher } from "@mahiframework/encryption";

export class SomeServiceProvider extends ServiceProvider {
  boot(): void {
    const hasher = this.app.make<Hasher>(HASHER_TOKEN);
    // ...
  }
}
```

`@mahiframework/auth` resolves `HASHER_TOKEN` for passwords and `SIGNER_TOKEN` for
session cookies; `@mahiframework/http`'s signed URLs resolve `SIGNER_TOKEN`.

## Choosing between them

A quick decision table, because picking the wrong primitive is the most
common mistake here:

| You want to... | Use |
|---|---|
| Store a password | `Hash.make()` — never `Crypt.encrypt()` |
| Store an API key you must display again later | `Crypt.encrypt()` |
| Store an API key you only ever *verify* | A digest — see [token guard](../authentication/#why-sha-256-not-argon2) |
| Encrypt a sensitive column | `Crypt.encrypt()` |
| Prove a webhook body came from you | `Signer.sign()` |
| Issue a link that must not be edited | `signedUrl()` / `URL.signedRoute()` |
| Keep a session id in a cookie unforgeable | `Signer` — already done by the session guard |

If the value must be recoverable, it's `Encrypter`. If it must only be
*checked*, it's `Hasher` (for low-entropy human input) or a plain digest
(for high-entropy random secrets). If it's public but must not be edited,
it's `Signer`.

## Related

- [Authentication](../authentication/) — where `Hash` and `Signer` are used
- [Authorization](../authorization/) — the permission half
- [Routing](../routing/) — URL generation, `validateSignature()`
- [Configuration](../configuration/) — `.env`, `APP_KEY`, the `hashing` namespace
- [Service providers](../providers/) — `EncryptionServiceProvider` ordering
- [Console](../console/) — `key:generate`
- [Deployment](../deployment/) — key management in production
