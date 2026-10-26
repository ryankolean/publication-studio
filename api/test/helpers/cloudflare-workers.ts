/**
 * Stands in for the `cloudflare:workers` module under Node. The OAuth provider
 * imports it only to tell handler classes from handler objects with
 * `instanceof WorkerEntrypoint`, and this Worker passes objects, so an empty
 * class is all it needs.
 */
export class WorkerEntrypoint {}
