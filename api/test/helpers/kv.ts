/**
 * An in-memory KV namespace covering what the OAuth provider calls: get (text
 * or json), put (with metadata), delete and prefix list. Expiry is not
 * modelled; tests that need a lapsed token revoke it instead.
 */
export class TestKV {
  private readonly store = new Map<string, { value: string; metadata: unknown }>();

  get size(): number {
    return this.store.size;
  }

  async get(key: string, options?: { type?: string } | string) {
    const entry = this.store.get(key);
    if (entry === undefined) return null;
    const type = typeof options === "string" ? options : options?.type;
    return type === "json" ? JSON.parse(entry.value) : entry.value;
  }

  async put(key: string, value: string, options?: { metadata?: unknown }) {
    this.store.set(key, { value, metadata: options?.metadata });
  }

  async delete(key: string) {
    this.store.delete(key);
  }

  async list(options: { prefix?: string; limit?: number } = {}) {
    const keys = [...this.store.entries()]
      .filter(([name]) => name.startsWith(options.prefix ?? ""))
      .sort(([a], [b]) => a.localeCompare(b))
      .slice(0, options.limit ?? 1000)
      .map(([name, entry]) => ({ name, metadata: entry.metadata }));
    return { keys, list_complete: true, cacheStatus: null };
  }
}
