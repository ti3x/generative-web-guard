import { test } from "node:test";
import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import { decodeCheckerAsset } from "../src/checker-asset.js";

test("[R-CHECK-ACCEPTANCE] embedded checker codecs fail closed on corrupt, oversized and missing-codec inputs", async () => {
  const bytes = Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]);
  for (const encoding of ["base64", "gzip-base64"]) {
    const encoded = encoding === "base64" ? bytes : gzipSync(bytes);
    const asset = { bytes: bytes.length, encoding, base64: encoded.toString("base64") };
    assert.deepEqual([...await decodeCheckerAsset(asset)], [...bytes]);
    await assert.rejects(decodeCheckerAsset({ ...asset, bytes: 9 }));
    await assert.rejects(decodeCheckerAsset({ ...asset, base64: "not base64 !" }));
    await assert.rejects(decodeCheckerAsset({ ...asset, encoding: "other" }));
  }
  const large = Buffer.concat([bytes, Buffer.alloc(200000)]);
  await assert.rejects(decodeCheckerAsset({ bytes: 8, encoding: "gzip-base64", base64: gzipSync(large).toString("base64") }), /expanded beyond/);
  const original = globalThis.DecompressionStream;
  try {
    globalThis.DecompressionStream = undefined;
    await assert.rejects(decodeCheckerAsset({ bytes: 8, encoding: "gzip-base64", base64: gzipSync(bytes).toString("base64") }), /unavailable/);
  } finally { globalThis.DecompressionStream = original; }
});
