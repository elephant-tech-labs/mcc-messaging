import { NextResponse } from "next/server";
import { hasValidServiceKey } from "@/lib/auth/service-key";
import { requiredEnv } from "@/lib/env";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { zohoFetch } from "@/lib/zoho/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type CheckResult = {
  ok: boolean;
  detail?: string;
};

function safeMessage(error: unknown): string {
  if (error instanceof Error) return error.message.slice(0, 300);
  return "Unknown error";
}

async function checkSupabase(): Promise<CheckResult> {
  try {
    const { error } = await getSupabaseAdmin()
      .from("messaging_conversations")
      .select("id")
      .limit(1);

    if (error) throw error;
    return { ok: true };
  } catch (error) {
    return { ok: false, detail: safeMessage(error) };
  }
}

async function checkZoho(): Promise<CheckResult> {
  try {
    await zohoFetch<{ data?: unknown[] }>(
      "/crm/v8/Contacts?fields=id,Phone&per_page=1",
    );
    return { ok: true };
  } catch (error) {
    return { ok: false, detail: safeMessage(error) };
  }
}

async function checkTwilio(): Promise<CheckResult> {
  try {
    const accountSid = requiredEnv("TWILIO_ACCOUNT_SID");
    const authToken = requiredEnv("TWILIO_AUTH_TOKEN");
    requiredEnv("TWILIO_PHONE_NUMBER");

    const credentials = Buffer.from(`${accountSid}:${authToken}`).toString("base64");
    const response = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(accountSid)}.json`,
      {
        headers: {
          Authorization: `Basic ${credentials}`,
        },
        cache: "no-store",
      },
    );

    if (!response.ok) {
      throw new Error(`Twilio credential check failed with HTTP ${response.status}`);
    }

    return { ok: true };
  } catch (error) {
    return { ok: false, detail: safeMessage(error) };
  }
}

export async function GET(request: Request) {
  if (!hasValidServiceKey(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const [supabase, zoho, twilio] = await Promise.all([
    checkSupabase(),
    checkZoho(),
    checkTwilio(),
  ]);

  const ok = supabase.ok && zoho.ok && twilio.ok;

  return NextResponse.json(
    {
      ok,
      checks: {
        supabase,
        zoho,
        twilio,
      },
      checkedAt: new Date().toISOString(),
    },
    { status: ok ? 200 : 503 },
  );
}
