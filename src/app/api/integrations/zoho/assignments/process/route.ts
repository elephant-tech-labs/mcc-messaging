import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { hasValidServiceKey } from "@/lib/auth/service-key";
import { processZohoAssignmentJobs } from "@/lib/integrations/zoho-assignment-worker";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const WORKER_KEY_SHA256 = "66d15de932a531df2b21ee93e5a06ea7fc51b45c984b901eafb6724c813baa40";

function hasValidWorkerKey(request: Request): boolean {
  const supplied = request.headers.get("x-mcc-assignment-worker-key") ?? "";
  if (!supplied) return false;

  const suppliedHash = createHash("sha256").update(supplied).digest();
  const expectedHash = Buffer.from(WORKER_KEY_SHA256, "hex");
  if (suppliedHash.length !== expectedHash.length) return false;
  return timingSafeEqual(suppliedHash, expectedHash);
}

function isAuthorized(request: Request): boolean {
  if (hasValidWorkerKey(request)) return true;

  // Existing protected admin key remains useful for manual recovery/testing.
  // It is evaluated only server-side and is never returned to callers.
  try {
    return hasValidServiceKey(request);
  } catch {
    return false;
  }
}

async function run(request: Request) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const summary = await processZohoAssignmentJobs(10);
    return NextResponse.json({
      ok: true,
      claimed: summary.claimed,
      succeeded: summary.succeeded,
      retryScheduled: summary.retryScheduled,
      deadLettered: summary.deadLettered,
      processedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error("Zoho assignment worker invocation failed", error);
    return NextResponse.json(
      { ok: false, error: "Assignment synchronization worker failed" },
      { status: 500 },
    );
  }
}

export async function POST(request: Request) {
  return run(request);
}

export async function GET(request: Request) {
  return run(request);
}
