# Mahi application

A [Mahi](https://github.com/mahiframework/mahi) application.

## Getting started

```bash
npm run dev              # http://127.0.0.1:8000, restarts on file changes
./artisan serve         # same server, no hot reload
```

`npm run dev` runs the server under `tsx watch`, so edits restart it
automatically, the usual development loop. `./artisan serve` is the plain
one-shot equivalent.

Other useful commands:

```bash
./artisan migrate         # run pending migrations
./artisan migrate:fresh   # drop everything and re-migrate
./artisan db:seed         # run DatabaseSeeder
./artisan route:list      # every registered route
./artisan queue:work      # process queued jobs
./artisan schedule:work   # run due scheduled tasks
./artisan --help          # everything else
```

Run the test suite:

```bash
npm test
```

## Layout

```
bin/          Entrypoints — bootstrap (shared), console (CLI), server (production HTTP)
config/       Configuration, one file per subsystem. `app.ts` lists service providers.
database/     Migrations, factories, seeders
src/
  models/       Eloquent-style models
  http/         Controllers, form requests, API resources
  providers/    Service providers — where your app wires itself up
  routes/       Route definitions, registered from a provider's routes() hook
storage/      Logs, file uploads, cache/lock files (gitignored)
tests/        Vitest suites
```

Start in `src/providers/app.provider.ts`, every hook the framework
collects is documented there.

## Documentation

See the [Mahi documentation](https://github.com/mahiframework/mahi/tree/main/docs).
