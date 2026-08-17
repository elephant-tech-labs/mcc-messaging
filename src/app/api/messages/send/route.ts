import { NextResponse } from "next/server";
import { hasValidServiceKey } from "@/lib/auth/service-key";
import { sendSms, SmsSendError } from "@/lib/messaging/send-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type SendRequest = {
  zohoContactId?: string;
  body?: string;
  sentByZohoUserId?: string;
  sentByName?: string;
};

function message(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 300) : "Unknown error";
}

export async function POST(request: Request) {
  if (!hasValidServiceKey(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let input: SendRequest;
  try {
    input = (await request.json()) as SendRequest;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  try {
    const result = await sendSms({
      zohoContactId: input.zohoContactId,
      body: input.body ?? "",
      sentByZohoUserId: input.sentByZohoUserId,
      sentByName: input.sentByName,
      idempotencyKey: request.headers.get("idempotency-key"),
      source: "CRM Widget",
    });

    return NextResponse.json({ ok: true, ...result }, { status: 201 });
  } catch (error) {
    if (error instanceof SmsSendError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }

    return NextResponse.json(
      { error: "SMS send failed", detail: message(error) },
      { status: 502 },
    );
  }
}
