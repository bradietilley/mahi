// `QUEUE_TOKEN`'s canonical definition lives in `@mahi/core`'s
// `well-known-tokens` (it's resolved cross-package by
// `@mahi/schedule`); re-exported here so this package's own
// imports and public API are unchanged. `JOB_REGISTRY_TOKEN` is
// package-private and stays local.
export { QUEUE_TOKEN } from "@mahi/core";
export const JOB_REGISTRY_TOKEN = "queue.jobs";
