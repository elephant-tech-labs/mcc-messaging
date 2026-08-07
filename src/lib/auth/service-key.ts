import { timingSafeEqual } from "node:crypto";
import { requiredEnv } from "@/lib/env";

export function hasValidServiceKey(request: Request): boolean {
  const supplied = request.headers.get("x-mcc-service-key") ?? "";
  const expected = requiredEnv("MCC_SERVICE_KEY");

  const suppliedBuffer = Buffer.from(supplied);
  const expectedBuffer = Buffer.from(expected);

  if (suppliedBuffer.length !== expectedBuffer.length) return false;
  return timingSafeEqual(suppliedBuffer, expectedBuffer);
}
