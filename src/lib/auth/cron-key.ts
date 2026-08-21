import { createHash, timingSafeEqual } from "node:crypto";

// Only the SHA-256 digest is committed. The corresponding random credential
// is stored in Supabase Vault and supplied by the Supabase Cron request.
const SUPABASE_CRON_KEY_SHA256 =
  "499a0666f447996eec0f2a8114f6c0bc09f6aa94393ffd1effaec9851c6a222f";

export function hasValidSupabaseCronKey(request: Request): boolean {
  const authorization = request.headers.get("authorization") ?? "";
  const supplied = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  if (!supplied) return false;

  const suppliedDigest = createHash("sha256").update(supplied).digest();
  const expectedDigest = Buffer.from(SUPABASE_CRON_KEY_SHA256, "hex");
  if (suppliedDigest.length !== expectedDigest.length) return false;
  return timingSafeEqual(suppliedDigest, expectedDigest);
}
