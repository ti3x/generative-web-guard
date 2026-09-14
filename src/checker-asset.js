// Trusted startup codec for a fixed build artifact, never generated content.
// No fetch, imports or fallback. Expanded length is checked while streaming.
export async function decodeCheckerAsset(asset) {
  const text = atob(asset.base64);
  // A direct copy avoids per-character iterator/callback overhead on the
  // uncompressed 1.6 MB path (measured in the Phase 6 startup sweep).
  const encoded = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) encoded[i] = text.charCodeAt(i);
  if (!Number.isSafeInteger(asset.bytes) || asset.bytes < 8 || asset.bytes > 8_000_000) {
    throw new Error("lean-module: invalid checker byte length");
  }
  let out;
  if (asset.encoding === "base64") {
    out = encoded;
  } else if (asset.encoding === "gzip-base64") {
    if (typeof DecompressionStream !== "function") throw new Error("lean-module: DecompressionStream unavailable");
    const reader = new Blob([encoded]).stream().pipeThrough(new DecompressionStream("gzip")).getReader();
    out = new Uint8Array(asset.bytes);
    let offset = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value.length > out.length - offset) throw new Error("lean-module: checker expanded beyond recorded length");
        out.set(value, offset); offset += value.length;
      }
      if (offset !== out.length) throw new Error("lean-module: truncated checker");
    } catch (error) {
      await reader.cancel().catch(() => {});
      throw error;
    } finally { reader.releaseLock(); }
  } else throw new Error("lean-module: unknown checker encoding");
  if (out.length !== asset.bytes) throw new Error("lean-module: checker length mismatch");
  if (out[0] !== 0 || out[1] !== 97 || out[2] !== 115 || out[3] !== 109) throw new Error("lean-module: checker magic mismatch");
  return out;
}
