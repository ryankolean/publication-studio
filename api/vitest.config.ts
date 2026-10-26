import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: { "cloudflare:workers": new URL("./test/helpers/cloudflare-workers.ts", import.meta.url).pathname },
  },
  test: {
    // Inlined so Vite, not Node, resolves the provider's `cloudflare:workers` import.
    server: { deps: { inline: ["@cloudflare/workers-oauth-provider"] } },
    include: ["test/**/*.test.ts"],
    coverage: {
      include: ["src/domain/**/*.ts"],
      thresholds: { lines: 100, functions: 100, branches: 100, statements: 100 },
    },
  },
});
