# Responses

A handler returns a `ResponseInput`: either a framework `HttpResponse` (or
one of its subclasses) or a platform `Response`. Both work, everywhere.

```ts
export type ResponseInput = HttpResponse | Response;
```

```ts
return HttpResponse.json({ ok: true });        // framework builder
return Response.json({ ok: true });            // platform Response
```

`toWebResponse(value)` normalizes at the Hono boundary, framework
responses go through `toWeb()`, anything else passes through untouched.

## Why `HttpResponse` is not a `Response`

The platform `Response` has an **immutable body**: once constructed you
cannot change it. Middleware that wants to rewrite a payload on the way out,
or a handler that builds a response incrementally, can't. So `HttpResponse`
is a *builder*, mutable content, fluent status and headers, converted to a
real `Response` exactly once at the edge.

`headers` is a real `Headers` instance and stays mutable throughout, so
egress middleware can keep doing `response.headers.set(…)`. Which is what
`throttle()` does to attach its rate-limit headers after the handler runs.

Laravel makes the same split with `Illuminate\Http\Response`.

## `HttpResponse`

```ts
new HttpResponse(content?: BodyContent, status = 200, headers = {})
```

`BodyContent` is `string | Uint8Array | null`.

### Statics

| Static | Returns |
|---|---|
| `HttpResponse.make(content?, status?, headers?)` | `HttpResponse` |
| `HttpResponse.json(body, status?, headers?)` | `JsonResponse` |
| `HttpResponse.file(source, status?, headers?)` | `FileResponse` |
| `HttpResponse.redirect(destination, status?, headers?)` | `RedirectResponse` |

### Methods

| Method | Effect |
|---|---|
| `setContent(content)` | Set the body (fluent) |
| `getContent()` | Read the body |
| `status(code)` | Set the status (fluent) |
| `getStatus()` | Read the status |
| `header(key, value)` | Set one header (fluent) |
| `withHeaders(headers)` | Merge many headers (fluent) |
| `getHeader(key)` | Read one header, or `null` |
| `cookie(name, value, options?)` | Attach a cookie (fluent) |
| `forgetCookie(name, options?)` | Attach a cookie deletion (fluent) |
| `toWeb()` | Build the platform `Response`. May return a promise. |

### Cookies

```ts
return HttpResponse.json({ ok: true })
  .cookie("theme", "dark", { maxAge: 31_536_000 });
```

`cookie()` **appends** rather than setting, so several cookies each get
their own `Set-Cookie` header. `Set-Cookie` is the one header that
legitimately repeats, and `Headers.set()` would collapse them into a
single comma-joined value no browser will parse.

`forgetCookie()` writes an expiry (`Max-Age=0` plus a past `Expires`).
Its `path`/`domain` must match those the cookie was written with, or the
browser treats it as a different cookie and keeps the original.

Options are the same `CookieOptions` documented under
[Requests](../requests/#cookies), including the `__Host-`/`__Secure-`
prefixes.

Use this when the *handler* is setting the cookie. When a pipe or guard
needs to set one regardless of what the handler returns, queue it on the
request instead (`request.queueCookie(...)`).

## `JsonResponse`

```ts
new JsonResponse(data: unknown, status = 200, headers = {})
```

Holds the payload **un-serialized**, Laravel's `JsonResponse::getData()`.
So `getJson()` returns the object, not a string. Which is what makes
response assertions in tests readable.

| Method | Effect |
|---|---|
| `setJson(data)` | Replace the payload (fluent) |
| `getJson<T>()` | Read the payload |

`toWeb()` serializes via `Response.json()`, then merges any custom or
middleware-set headers **over** the JSON defaults, so setting
`Content-Type` explicitly wins.

```ts
return HttpResponse.json(await new PostResource(post).toJson(), 201);
```

## `RedirectResponse`

```ts
new RedirectResponse(destination: string, status = 302, headers = {})
```

Empty body, `Location` header set in the constructor.

| Method | Effect |
|---|---|
| `setRedirectUrl(url)` | Update the target and the `Location` header (fluent) |
| `getRedirectUrl()` | Read the target |

`toWeb()` builds the response by hand rather than calling
`Response.redirect()`, because the platform helper discards custom headers
and constrains the status.

```ts
return HttpResponse.redirect(URL.route("posts.show", { post: post.id }), 303);
```

## `FileResponse`

```ts
new FileResponse(source: FileSource, status = 200, headers = {})
```

`FileSource` is `string | File | Blob | Uint8Array`, a filesystem path, a
Web `File`/`Blob` (what `Request` parses inbound), or a raw byte buffer.

> **`FileResponse` is buffered, not streaming.** `toWeb()` reads the entire
> source into memory before constructing the response. That is fine for
> reports, avatars, and generated CSVs; it is not fine for multi-gigabyte
> downloads. Streaming is a follow-up. For serving a whole disk of static
> files, use `@mahiframework/storage`'s `servePublicDisk()` instead.

| Method | Effect |
|---|---|
| `setFile(source)` | Replace the source (fluent) |
| `getFile()` | Read the source |
| `contentType(type)` | Override the content type (fluent) |
| `cacheControl(value)` | Set `Cache-Control` (fluent) |
| `download(filename?)` | `Content-Disposition: attachment`, with an optional filename |
| `inline()` | `Content-Disposition: inline` |
| `deleteAfterSend(should = true)` | Unlink the backing file after reading |

```ts
return HttpResponse.file("/tmp/report.pdf").download("report.pdf");
return HttpResponse.file("/tmp/scratch.csv").deleteAfterSend();
```

### Content type resolution

At `toWeb()` time, in order:

1. An existing `Content-Type` header, if one was set.
2. `contentType(…)`, if called.
3. For a **path** source: the extension MIME map below.
4. For a **`File`/`Blob`**: its `.type`, when non-empty.
5. `application/octet-stream`.

`Content-Length` is always set from the buffered byte length.

The extension map is small and deliberately duplicated rather than imported
from `@mahiframework/storage`, so `@mahiframework/http` doesn't depend on it:

| Extension | MIME |
|---|---|
| `jpg`, `jpeg` | `image/jpeg` |
| `png` | `image/png` |
| `gif` | `image/gif` |
| `webp` | `image/webp` |
| `svg` | `image/svg+xml` |
| `json` | `application/json` |
| `txt` | `text/plain` |
| `html` | `text/html` |
| `css` | `text/css` |
| `js` | `text/javascript` |
| `pdf` | `application/pdf` |

Anything else is `application/octet-stream`.

### `download()` default filename

With no argument: `basename(path)` for a path source, `file.name` for a
`File`, and for a `Blob`/`Uint8Array` there's nothing to derive. The header
becomes a bare `attachment`.

### `download()` filename encoding

The name is emitted per RFC 6266: a sanitised ASCII `filename=` for old
clients, plus `filename*=UTF-8''…` carrying the real bytes when they
differ. That's what makes `rapport-café.pdf` arrive with its name intact
rather than as mojibake.

It's also an injection fix. Filenames routinely come from user input (an
upload, a user-titled export), and interpolated raw into a quoted header
value a `"` closes the string early and everything after it becomes
header parameters. Quotes, backslashes, control characters and path
separators are replaced in the ASCII form:

```ts
HttpResponse.file(f).download('evil".pdf');
// attachment; filename="evil_.pdf"; filename*=UTF-8''evil%22.pdf
```

### `deleteAfterSend()` caveats

The unlink fires **immediately after the bytes are read into memory**, not
after they're flushed to the client. Since the read is a full buffer, the
data is safe, but the file is gone before the response is written, so
don't rely on it existing for anything else. It's a no-op for `Blob` and
`Uint8Array` sources (nothing on disk to remove), errors are swallowed
(the file may already be gone), and it is fire-and-forget.

## `HttpError`

Throw from anywhere inside a handler or pipe to produce a structured JSON
error with a chosen status, instead of a generic 500.

```ts
export class HttpError extends Error {
  constructor(public status: number, message: string, public details?: unknown);
}
```

| Static | Status | Default message |
|---|---|---|
| `HttpError.badRequest(message?, details?)` | `400` | `"Bad Request"` |
| `HttpError.unauthorized(message?)` | `401` | `"Unauthorized"` |
| `HttpError.forbidden(message?)` | `403` | `"Forbidden"` |
| `HttpError.notFound(message?)` | `404` | `"Not Found"` |
| `HttpError.tooManyRequests(message?)` | `429` | `"Too Many Requests"` |

Any other status: `new HttpError(409, "Conflict")`.

Only `badRequest()` takes `details` through a static; use the constructor
for the rest.

```ts
const existing = await Like.query().where("user_id", userId).where("post_id", post.id).first();
if (existing) throw HttpError.badRequest("You already liked this post.");
```

**401 vs 403.** `unauthorized()` means "we don't know who you are";
authenticating differently could fix it. `forbidden()` means "we know who
you are and you may not do this"; no credential change will help. Use the
right one, clients branch on it.

## Error handling

Hono's `onError` is wired to `createErrorHandler(app, errorRenderers)` in
the `HttpKernel` constructor. Every uncaught error from a pipe or handler
lands there. Resolution order:

### 1. App-registered renderers

Consulted first, in registration order; the first matching predicate wins.

```ts
kernel.registerRenderer(
  (e): e is DatabaseError => e instanceof DatabaseError,
  (e, c) => c.json({ error: "Conflict", detail: e.detail }, 409),
);
```

The predicate should be a type guard so the renderer receives the error
already typed. The renderer also gets the Hono `Context`, for the rare case
that needs request data.

This is the extension point for errors whose throw site you don't control,
a third-party library's constraint violation that would otherwise fall
through to a generic 500. Registration is explicit and app-driven; there is
no auto-discovery. Typically done in a provider's `boot()`:

```ts
export class AppServiceProvider extends ServiceProvider {
  boot(): void {
    const kernel = this.app.make<HttpKernel>(HTTP_KERNEL_TOKEN);
    kernel.registerRenderer(/* … */);
  }
}
```

### 2. `HttpError`

```json
{ "message": "Post not found.", "details": undefined }
```

Status is `err.status`. `details` is whatever was passed to the
constructor, `undefined` when omitted, which `JSON.stringify` drops, so
the wire body is just `{"message":"Post not found."}`.

An `HttpError` may also carry response **headers**, which the handler
merges onto the response. Several statuses are defined by a header rather
than merely allowed one, a 401 without `WWW-Authenticate`, a 405 without
`Allow`, a 429 without `Retry-After` are all incomplete per RFC 9110:

```ts
throw HttpError.methodNotAllowed(["GET", "POST"]);          // sets Allow
throw HttpError.tooManyRequests("Slow down", 30);           // sets Retry-After
throw HttpError.unauthorized().withHeaders({
  "WWW-Authenticate": 'Bearer realm="api"',
});
```

### 3. `ValidationException`

Status `422`:

```json
{
  "message": "Validation failed",
  "errors": {
    "body": ["The body field is required."],
    "images.0": ["The images.0 field must be an image."]
  }
}
```

`errors` is always `Record<string, string[]>`. Nested fields use dotted keys.
See [validation](../validation/#nested-rules).

### 4. Hono's `HTTPException`

Raised by Hono's own built-in middleware, most often the request
body limit, which raises a `413`. Rendered into the same envelope with
its own status, rather than being swallowed into a generic 500 that
blames the server for the client's oversize upload.

### 5. Everything else

Logged via `app.logger.error("Unhandled error in HTTP request", { message, stack })`,
then rendered as `500`. The body depends on the environment:

| Environment | Body |
|---|---|
| `local`, `development`, `dev` | `{ "message": "<the real error message>" }` |
| Anything else | `{ "message": "Internal Server Error" }` |

The real message is exposed only in development environments. In
production it's suppressed because an unhandled exception message
frequently contains a SQL fragment, a file path, or a configuration
value. The full error and stack are always in the log either way.

`staging` and `test` get the production body. `development` is included
alongside `local` because nothing in this framework's tooling produces
`"local"`, `Application` seeds its environment from `NODE_ENV`, and the
scaffolded `config/env.ts` constrains that to
`development | test | production`, so a strict `isLocal()` check meant
the developer-facing branch was unreachable in every generated app.

### Not-found and method-not-allowed

These don't come from a thrown error, but they share the envelope:

```json
{ "message": "Not Found" }            // 404, unmatched route
{ "message": "Method Not Allowed" }   // 405, plus an `Allow` header
```

Hono's default 404 is plain text; returning JSON here means a client
never has to handle two different error shapes. See
[Built-in protections](../routing/#built-in-protections).

## API resources

A `Resource` wraps one model row and declares the API-facing shape
explicitly, decoupled from the database row shape. Laravel's
`JsonResource`, but a plain class, not a decorator or a magic
serialization layer. Every subclass writes its own `toJson()`.

```ts
export class UserResource extends Resource<UserTable, UserJson> {
  toJson(): UserJson {
    return {
      id: this.model.id,
      name: this.model.name,
      email: this.model.email,
      createdAt: this.model.created_at!,
    };
  }
}
```

```ts
return HttpResponse.json(new UserResource(user).toJson());
return HttpResponse.json(await UserResource.collection(rows));
```

Generate one with `./artisan make:resource`.

`Resource<TModel, TShape>` takes the input model type and the output shape.
`this.model` is `protected`. `toJson()` may be sync or async. A resource
that needs to `await` something (a per-row gate check, say) declares
`async toJson()`, and callers `await` it.

```ts
export class PostResource extends Resource<PostView, PostJson> {
  async toJson(): Promise<PostJson> {
    return {
      id: this.model.id,
      body: this.model.body,
      createdAt: this.model.created_at!,
      author: this.whenLoaded("author"),
      likesCount: this.whenAppended("likesCount"),
      can: await this.model.can(),
    };
  }
}
```

### `static collection()`

```ts
static collection<TModel, TShape>(models: TModel[]): Promise<TShape[]>
```

Maps an array through the resource, resolving in parallel via
`Promise.all`. Always returns a promise, even for a sync `toJson()`, so
always `await` it.

### Conditional fields

All four helpers rely on one trick: **a field whose value is `undefined`
disappears from the JSON entirely**, because `JSON.stringify` omits
`undefined`-valued keys, while it happily serializes `null`.

```ts
JSON.stringify({ a: undefined, b: null });   // '{"b":null}'
```

`Response.json()` runs `JSON.stringify`, so a field written as
`author: this.whenLoaded("author")` genuinely vanishes from the response
when the relation wasn't loaded, rather than appearing as `"author": null`.
That distinction matters: `null` says "this post has no author", while
absence says "we didn't fetch it".

The shape type reflects this. The fields are declared optional:

```ts
export interface PostJson {
  id: string;
  body: string;
  author?: UserJson;      // omitted when not eager-loaded
  likesCount?: number;    // omitted when not appended
}
```

| Helper | Includes when |
|---|---|
| `when(condition, value)` | `condition` is truthy. `value` may be a lazy `() => T`, only evaluated when it holds. |
| `whenLoaded(relation)` / `whenLoaded(relation, map)` | The relation key is not `undefined` on the model |
| `whenAppended(name)` / `whenAppended(name, map)` | `model.hasAppended(name)` is `true` |
| `whenNotNull(value)` | `value` is neither `null` nor `undefined` |
| `mergeWhen(condition, values)` | `condition` is truthy, spread the result |

```ts
avatarUrl: this.when(this.model.avatar_path !== null, () => this.buildAvatarUrl()),
author: this.whenLoaded("author", (u) => new UserResource(u).toJson()),
bio: this.whenNotNull(this.model.bio),
...this.mergeWhen(isAdmin, { internalNotes: this.model.notes }),
```

`whenLoaded` distinguishes "not loaded" (`undefined` → omitted) from
"loaded but empty" (an empty `hasMany` is `[]` → kept). `whenAppended`
distinguishes "never appended" (omitted) from "appended as `null`" (kept),
by asking the model's `hasAppended()` rather than checking the value, so a
deliberately-`null` appended value still reaches the wire.

`mergeWhen` returns `{}` when the condition is false, which spreads to
nothing.

### Automatic normalization

A `Resource`'s constructor wraps the subclass's own `toJson()` so its
output is post-processed by `normalizeResourceValue()` before reaching the
caller. This is why the no-mapper `whenLoaded()` form works:

```ts
author: this.whenLoaded("author"),   // emits UserResource's shape, not a raw model
```

`normalizeResourceValue` walks the returned value recursively:

| Encountered | Becomes |
|---|---|
| A **model instance** (has `toJsonResource()` and `toJSON()`) | `model.toJsonResource()?.toJson()`, itself normalized, falling back to `model.toJSON()` when the model declares no default resource |
| A **`Collection`** (anything with `toArray()`) | Its items, each normalized |
| An **array** | Each element, normalized |
| A **plain object** | Each own enumerable value, normalized. Keys with `undefined` values are **preserved**, so `JSON.stringify` still drops them and the omission trick keeps working. |
| Anything else: primitives, `Date`, class instances | Unchanged |

Models and collections are detected **structurally** (duck-typed), not with
`instanceof`, so `@mahiframework/http` needs no runtime import of `@mahiframework/database`
or `@mahiframework/core`.

Two properties worth knowing:

- **Sync-ness is preserved.** The walk only returns a `Promise` when
  something it reached was actually async. A resource whose shape and every
  nested resource are synchronous stays synchronous, so existing sync call
  sites (spreads, un-awaited `.map`) keep working.
- **It's idempotent.** A nested resource's `toJson()` is itself wrapped, so
  its output is already normalized and the outer walk is a cheap no-op over
  it.

`NormalizedRelation<T>` is the type-level mirror of the same walk, which is
why the no-mapper `whenLoaded()` overload returns the *converted* shape
rather than the raw model type.

Non-plain objects are left alone deliberately: `Date` has its own
`toJSON()` and walking it would produce garbage.

## Paginated resources

Two helpers turn a paginator result into a JSON envelope, transforming each
row through a resource.

### `paginatedResource(ResourceClass, result, options?)`

Takes a `LengthAwarePaginationResult<TModel>` from `paginate()` /
`Model.paginate()`.

Default envelope, metadata **spread at the top level**:

```json
{
  "data": [ /* … */ ],
  "page": 2,
  "perPage": 20,
  "total": 57,
  "totalPages": 3,
  "hasMore": true
}
```

With `{ nestMeta: true }`, Laravel's `AnonymousResourceCollection` shape:

```json
{
  "data": [ /* … */ ],
  "meta": { "page": 2, "perPage": 20, "total": 57, "totalPages": 3, "hasMore": true }
}
```

| Option | Effect |
|---|---|
| `additional` | `Record<string, unknown>` merged in at the top level, Laravel's `->additional([…])` |
| `nestMeta` | Nest the five metadata fields under `meta` |

```ts
const page = await Post.paginate(1, 20);
return HttpResponse.json(await paginatedResource(PostResource, page));
return HttpResponse.json(await paginatedResource(PostResource, page, { nestMeta: true }));
return HttpResponse.json(await paginatedResource(PostResource, page, { additional: { requestId } }));
```

### `cursorPaginatedResource(ResourceClass, result, options?)`

Takes a `CursorPaginationResult<TModel>`:

```json
{
  "nextCursor": "eyJpZCI6…",
  "prevCursor": null,
  "data": [ /* … */ ]
}
```

`additional` works the same way. There is no `nestMeta`, cursor pagination
has only two metadata fields.

> **There is no `links` key.** Laravel's paginator emits
> `links: { first, last, prev, next }` with fully-built URLs. Mahi's
> envelopes carry only the numbers and cursors. Building those URLs requires
> knowing the request's path and query, which the paginator doesn't have,
> and the guesses Laravel makes there are wrong often enough (behind a
> proxy, under a path prefix, with filters that must be preserved) to be a
> liability. Build them yourself with [`URL.route()`](../routing/#generating-urls)
> and `request.fullUrlWithQuery({ page })` if you need them.

Both helpers `await` every row's `toJson()` in parallel.

Nothing forces you to use them, hand-rolling the envelope is fine when the
shape is bespoke:

```ts
return HttpResponse.json({
  data: await PostResource.collection(loaded),
  nextCursor: result.nextCursor,
  prevCursor: result.prevCursor,
});
```

## Related

- [Requests](../requests/): reading input
- [Controllers](../controllers/): what returns these
- [Validation](../validation/): the source of `ValidationException`
- [Models](../models/): `hidden`, `toJSON()`, `toJsonResource()`, appended attributes
- [Pagination](../pagination/): the paginators these envelopes wrap
- [Storage](../storage/): `servePublicDisk()` for streaming static files
- [Logging](../logging/): where unhandled errors go
