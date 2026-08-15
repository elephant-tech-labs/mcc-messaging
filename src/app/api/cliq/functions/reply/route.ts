import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { requiredEnv } from "@/lib/env";
import { sendSms, SmsSendError } from "@/lib/messaging/send-service";

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

function stringValue(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function mapFromUnknown(value: unknown): UnknownRecord {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as UnknownRecord;
  }

  if (typeof value === "string" && value.trim().startsWith("{")) {
    try {
      return record(JSON.parse(value));
    } catch {
      return {};
    }
  }

  if (Array.isArray(value)) {
    const mapped: UnknownRecord = {};
    for (const entry of value) {
      const item = record(entry);
      const key = stringValue(item.name, item.key, item.param_name);
      if (key) mapped[key] = item.value ?? item.text ?? item.input;
    }
    return mapped;
  }

  return {};
}

function confirmationInput(argumentsMap: UnknownRecord, params: UnknownRecord): string | null {
  const inputMap = record(argumentsMap.input);
  const confirmMap = record(argumentsMap.confirm);

  return stringValue(
    argumentsMap.input,
    inputMap.value,
    inputMap.text,
    inputMap.input,
    argumentsMap.reply,
    argumentsMap.message,
    argumentsMap.confirmation_input,
    confirmMap.input,
    params.input,
  );
}

function senderIdentity(params: UnknownRecord): { id: string | null; name: string | null } {
  const user = record(params.user);
  const access = record(params.access);
  const accessUser = record(access.user);

  return {
    id: stringValue(user.id, user.zuid, access.user_id, access.userId, accessUser.id),
    name: stringValue(user.name, user.full_name, access.user_name, accessUser.name),
  };
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
  const argumentsMap = mapFromUnknown(params.arguments ?? payload.arguments);
  const target = mapFromUnknown(params.target ?? payload.target);
  const sender = senderIdentity(params);

  const conversationId = stringValue(
    argumentsMap.conversationId,
    argumentsMap.conversation_id,
    target.conversationId,
    target.conversation_id,
  );
  const body = confirmationInput(argumentsMap, params);

  // Keep logs metadata-only. Do not log the reply body, phone number, or customer message.
  console.info("Zoho Cliq SMS reply function invoked", {
    argumentKeys: Object.keys(argumentsMap).slice(0, 20),
    targetKeys: Object.keys(target).slice(0, 20),
    hasConversationId: Boolean(conversationId),
    hasReplyBody: Boolean(body),
    replyLength: body?.length ?? 0,
    hasUserId: Boolean(sender.id),
  });

  if (!conversationId) {
    return NextResponse.json({
      text: "Could not identify the SMS conversation. Please use Reply on a newly received MCC SMS alert.",
    });
  }

  if (!body) {
    return NextResponse.json({
      text: "No reply text was received. Please click Reply and enter your SMS message.",
    });
  }

  try {
    const result = await sendSms({
      conversationId,
      body,
      source: "Cliq",
      sentByZohoUserId: sender.id,
      sentByName: sender.name,
    });

    console.info("Zoho Cliq SMS reply accepted by Twilio", {
      conversationId: result.conversationId,
      status: result.status,
      crmSynced: result.crmSynced,
    });

    return NextResponse.json({
      text: result.crmSynced
        ? "✅ SMS sent. Delivery status will sync automatically."
        : "✅ SMS sent. CRM summary sync is delayed, but delivery tracking is active.",
    });
  } catch (error) {
    if (error instanceof SmsSendError) {
      return NextResponse.json({ text: `SMS not sent: ${error.message}` });
    }

    console.error(
      "Zoho Cliq SMS reply failed",
      error instanceof Error ? error.message.slice(0, 220) : "Unknown Cliq send error",
    );
    return NextResponse.json({
      text: "SMS could not be sent due to a server error. Please retry from the CRM conversation.",
    });
  }
}
