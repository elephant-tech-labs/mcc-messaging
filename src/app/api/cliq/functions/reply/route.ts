import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { requiredEnv } from "@/lib/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type UnknownRecord = Record<string, unknown>;

function record(value: unknown): UnknownRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as UnknownRecord)
    : {};
}

function safeEqual(left: string | null, right: string): boolean {
  if (!left) return false;
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function POST(request: Request) {
  const url = new URL(request.url);
  if (!safeEqual(url.searchParams.get("secret"), requiredEnv("ZOHO_CLIQ_WEBHOOK_SECRET"))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let payload: UnknownRecord;
  try {
    payload = record(await request.json());
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const params = record(payload.params);
  const argumentsMap = record(payload.arguments);
  const target = record(payload.target);
  const user = record(payload.user);

  // Bootstrap observation only. Do not log reply text or full customer message.
  console.info("Zoho Cliq SMS reply function invoked", {
    payloadKeys: Object.keys(payload).slice(0, 20),
    paramKeys: Object.keys(params).slice(0, 20),
    argumentKeys: Object.keys(argumentsMap).slice(0, 20),
    targetKeys: Object.keys(target).slice(0, 20),
    hasTopLevelInput: typeof payload.input === "string" && payload.input.length > 0,
    hasArgumentInput: typeof argumentsMap.input === "string" && argumentsMap.input.length > 0,
    hasConversationId:
      typeof argumentsMap.conversationId === "string" ||
      typeof argumentsMap.conversation_id === "string",
    userId: typeof user.id === "string" ? user.id : null,
  });

  // First click is deliberately non-sending so we can verify Cliq's exact webhook
  // payload before any customer-facing SMS can be triggered from the new UI.
  return NextResponse.json({
    text: "Reply action connected. No SMS was sent during this verification step.",
  });
}
