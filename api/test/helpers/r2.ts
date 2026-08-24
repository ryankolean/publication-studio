import type { R2Bucket, R2ObjectBody } from "../../src/env.js";

/** An in-memory R2 stand-in holding exactly the surface the routes call. */
export interface TestR2 extends R2Bucket {
  contents(): string[];
  bytesOf(key: string): number | undefined;
}

export function createTestR2(): TestR2 {
  const objects = new Map<string, { bytes: Uint8Array; contentType: string | undefined }>();

  return {
    async head(key) {
      const object = objects.get(key);
      return object === undefined ? null : { size: object.bytes.byteLength };
    },
    async get(key): Promise<R2ObjectBody | null> {
      const object = objects.get(key);
      if (object === undefined) return null;
      return {
        size: object.bytes.byteLength,
        httpMetadata: { contentType: object.contentType },
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(object.bytes);
            controller.close();
          },
        }),
      };
    },
    async put(key, value, options) {
      objects.set(key, {
        bytes: new Uint8Array(value),
        contentType: options?.httpMetadata?.contentType,
      });
    },
    async delete(key) {
      objects.delete(key);
    },
    contents: () => [...objects.keys()].sort(),
    bytesOf: (key) => objects.get(key)?.bytes.byteLength,
  };
}
