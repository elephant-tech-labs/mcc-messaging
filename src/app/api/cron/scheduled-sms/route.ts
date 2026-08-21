import { NextResponse } from "next/server";
import { hasValidSupabaseCronKey } from "@/lib/auth/cron-key";
import { processDueScheduledSms } from "@/lib/messaging/scheduled-sms";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

function authorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET?.trim();
  if (secret && request.headers.get("authorization") === `Bearer ${secret}`) return true;
  return hasValidSupabaseCronKey(request);
}

export async function GET(request: Request) {
  if (!authorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    let claimed = 0;
    let sent = 0;
    let failed = 0;

    // Keep each cron execution bounded while still draining normal MCC volume.
    for (let batch = 0; batch < 5; batch += 1) {
      const result = await processDueScheduledSms(10);
      claimed += result.claimed;
      sent += result.sent;
      failed += result.failed;
      if (result.claimed < 10) break;
    }

    return NextResponse.json({ ok: true, claimed, sent, failed });
  } catch (error) {
    return NextResponse.json(
      {
        error: "Scheduled SMS worker failed",
        detail: error instanceof Error ? error.message.slice(0, 500) : "Unknown error",
      },
      { status: 500 },
    );
  }
}
