import { createHash, timingSafeEqual } from "node:crypto";

// Only the SHA-256 digest is committed. The corresponding 256-bit plaintext
// credential lives server-side in the Zoho CRM proxy function and never ships
// to the browser or repository.
const WIDGET_KEY_SHA256 =
  "031df4f7f2259ee95316388f042fa81a9ceb431b7181cbff7736948cf5aac8d8";

export function hasValidWidgetKey(request: Request): boolean {
  const supplied = request.headers.get("x-mcc-widget-key") ?? "";
  if (!supplied) return false;

  const suppliedDigest = createHash("sha256").update(supplied).digest();
  const expectedDigest = Buffer.from(WIDGET_KEY_SHA256, "hex");

  if (suppliedDigest.length !== expectedDigest.length) return false;
  return timingSafeEqual(suppliedDigest, expectedDigest);
}
