/**
 * Worker environment bindings.
 *
 * The D1 surface is declared structurally rather than pulled from
 * @cloudflare/workers-types, whose global declarations collide with @types/node
 * on fetch, Request, and Response -- and the test suite runs in Node. Declaring
 * only what we call keeps the contract explicit and lets the test shim
 * implement it exactly.
 */

import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";

export interface D1Result<T = Record<string, unknown>> {
  results: T[];
  success: boolean;
}

export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  run(): Promise<D1Result>;
}

export interface D1Database {
  prepare(query: string): D1PreparedStatement;
  /** Runs the statements in one transaction; either all land or none do. */
  batch<T = Record<string, unknown>>(
    statements: D1PreparedStatement[],
  ): Promise<D1Result<T>[]>;
}

export interface R2ObjectBody {
  body: ReadableStream | null;
  size: number;
  httpMetadata?: { contentType?: string | undefined } | undefined;
}

export interface R2Bucket {
  head(key: string): Promise<{ size: number } | null>;
  get(key: string): Promise<R2ObjectBody | null>;
  put(
    key: string,
    value: ArrayBuffer,
    options?: { httpMetadata?: { contentType?: string | undefined } | undefined },
  ): Promise<unknown>;
  delete(key: string): Promise<void>;
}

export interface Env {
  DB: D1Database;
  IMAGES: R2Bucket;

  /** Wrangler secret. Signs and verifies access and refresh tokens. */
  JWT_SECRET: string;

  /** Exact origin the SPA is served from; CORS is pinned to it. */
  ALLOWED_ORIGIN: string;

  /**
   * The OAuth provider's helpers. The provider in front of the app injects
   * them on every request (src/connector.ts); the app-only test harness has
   * none, which is why this is optional here and required in OAuthEnv.
   */
  OAUTH_PROVIDER?: OAuthHelpers;
}

/** What Cloudflare binds to the Worker: the app's bindings plus the Claude connector's. */
export interface WorkerEnv extends Env {
  /** KV namespace the OAuth provider keeps clients, grants and token hashes in. */
  OAUTH_KV: unknown;

  /** This Worker's public origin; the MCP resource is `${PUBLIC_ORIGIN}/mcp`. */
  PUBLIC_ORIGIN: string;
}

/** The same, once the OAuth provider has injected its helpers. */
export interface OAuthEnv extends WorkerEnv {
  OAUTH_PROVIDER: OAuthHelpers;
}
