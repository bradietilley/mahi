# Installation

## Requirements

- **Node.js 22 or later.** Mahi uses top-level `await`, `node:` protocol
  imports, and modern `AsyncLocalStorage` semantics throughout.
- A package manager: npm, pnpm, yarn, or bun.

Two native dependencies are compiled on install: `better-sqlite3` (the
default database driver) and `argon2` (password hashing). Both ship
prebuilt binaries for common platforms.

## Creating an application

```bash
npm create mahi@latest my-app
```

Or with another package manager:

```bash
pnpm create mahi my-app
yarn create mahi my-app
bun create mahi my-app
```

The installer scaffolds the application, installs dependencies, writes a
`.env`, generates an application key, creates
`my-app/database/database.sqlite`, and runs the initial migrations. When
it finishes:

```bash
cd my-app
./artisan serve
```

Your API is on `http://127.0.0.1:8000`. It ships with working
registration, login, logout, and "current user" endpoints:

```bash
curl -X POST http://127.0.0.1:8000/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"name":"Ada","email":"ada@example.com","password":"correct-horse-battery"}'
```

```json
{
  "user": { "id": "427185966743560456", "name": "Ada", "email": "ada@example.com", "createdAt": "..." },
  "token": "9c7b531f-...|lu8aN1IBZLiVzEi27XDpn_Pks9JYebFTWEWGOWrlMiQ"
}
```

### Installer options

```
npm create mahi@latest <directory> [options]

  --pm <npm|pnpm|yarn|bun>   Package manager (default: auto-detected)
  --no-install               Skip installing dependencies
  --no-migrate               Skip the initial database migration
  --no-git                   Skip git initialisation
  --force                    Scaffold into a non-empty directory
  -y, --yes                  Accept defaults without prompting
```

`--no-install` also skips key generation and migration, since both run
through `./artisan`, which needs the dependencies present. The installer
prints the remaining commands to run by hand.

## What you get

```
my-app/
├── artisan                  CLI entrypoint — ./artisan <command>
├── bin/
│   ├── bootstrap.ts         Builds and boots the Application (shared by every entrypoint)
│   ├── console.ts           CLI entrypoint
│   └── server.ts            Production HTTP entrypoint
├── config/                  One file per subsystem; app.ts lists service providers
├── database/
│   ├── database.sqlite      The default SQLite database
│   ├── migrations/          Your schema
│   ├── factories/           Model factories for tests and seeders
│   └── seeders/             DatabaseSeeder
├── src/
│   ├── models/              User
│   ├── http/
│   │   ├── controllers/     register, login, logout, me
│   │   ├── requests/        Form requests (validation + authorization)
│   │   └── resources/       API resources (wire-format shaping)
│   ├── providers/           AppServiceProvider — where you wire things up
│   └── routes/              Route definitions
├── storage/                 Logs, uploads, cache and lock files (gitignored)
└── tests/                   Vitest suites
```

Start in `src/providers/app.provider.ts`. Every hook the framework
collects from a provider is documented inline there.

## Configuration

The installer writes a `.env` from `.env.example` and fills in `APP_KEY`.
The defaults run without any external services: SQLite for the database,
in-memory cache, synchronous queue, and a log mailer that writes messages
to the application log rather than sending them.

See [Configuration](../configuration/) for the full picture, including how
to move the cache, queue, and broadcasting onto Redis when you scale past
a single process.

## Adding Mahi to an existing project

Mahi is a set of packages; there is nothing that requires the generated
layout. Install the pieces you want:

```bash
npm install @mahiframework/core @mahiframework/http @mahiframework/database
```

The minimum viable application is an `Application`, some config, and a
provider list:

```ts
import { Application } from "@mahiframework/core";
import { DatabaseServiceProvider } from "@mahiframework/database";
import { HttpServiceProvider, listenHttpServer } from "@mahiframework/http";

const app = new Application();

app.config.set("database", {
  default: "sqlite",
  connections: { sqlite: { filename: "database/database.sqlite" } },
});

app.register(DatabaseServiceProvider);
app.register(HttpServiceProvider);

await app.bootstrap();
await listenHttpServer(app, { port: 8000 });
```

Provider order matters — see [Service providers](../providers/) for the
constraints and [Application lifecycle](../lifecycle/) for what `bootstrap()`
actually does.

## Running the application

For day-to-day development, use the `dev` script — it runs the server under
`tsx watch`, so it reloads on **any** source change, not just `.env`:

```bash
npm run dev                      # http://127.0.0.1:8000, reloads on file changes
```

`./artisan serve` runs the same server without the source-file watcher (it
only watches `.env`). Reach for it when you want to pick a host/port or run
outside the `dev` loop:

```bash
./artisan serve                  # http://127.0.0.1:8000
./artisan serve --port 8080
./artisan serve --host 0.0.0.0
```

Both are development servers, **not** for production — see
[Deployment](../deployment/). Pass `--no-reload` to `serve` to disable its
`.env` watcher.

Other commands you'll want early:

```bash
./artisan migrate           # run pending migrations
./artisan migrate:fresh     # drop everything and re-migrate
./artisan db:seed           # run DatabaseSeeder
./artisan route:list        # every registered route
./artisan --help            # everything else
```

## Running tests

The generated app includes a working test suite:

```bash
npm test
```

Tests boot the real application against a throwaway SQLite database and
dispatch requests in-process — no server, no port. See
[Testing](../testing/).

## Upgrading

Mahi packages are versioned together. Update them as a set:

```bash
npm update '@mahiframework/*'
```
