import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { requiredEnv } from "@/lib/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type UnknownRecord = Record<string, unknown>;

function safeEqual(left: string | null, right: string): boolean {
  if (!left) return false;
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function record(value: unknown): UnknownRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as UnknownRecord)
    : {};
}

function stringValue(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function handlerType(payload: UnknownRecord): string | null {
  const handler = record(payload.handler);
  const execution = record(payload.execution);
  const executionDetails = record(payload.execution_details);
  return stringValue(
    payload.handler_type,
    payload.handlerType,
    handler.type,
    execution.handler_type,
    execution.type,
    executionDetails.handler_type,
    executionDetails.type,
    payload.type,
  );
}

function messageText(payload: UnknownRecord): string | null {
  const message = record(payload.message);
  return stringValue(message.text, payload.text);
}

export async function POST(request: Request) {
  const url = new URL(request.url);
  const suppliedSecret = url.searchParams.get("secret");
  if (!safeEqual(suppliedSecret, requiredEnv("ZOHO_CLIQ_WEBHOOK_SECRET"))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let payload: UnknownRecord;
  try {
    payload = record(await request.json());
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const type = handlerType(payload);
  console.info("Zoho Cliq bot event received", {
    handlerType: type ?? "unknown",
    payloadKeys: Object.keys(payload).slice(0, 20),
  });

  if (type === "welcome_handler") {
    return NextResponse.json({
      text: "MCC Messages is connected. You’ll be able to receive and reply to MCC SMS conversations here.",
    });
  }

  if (type === "message_handler") {
    const text = messageText(payload);
    if (text) {
      return NextResponse.json({
        text: "MCC Messages is connected. Contact search and SMS reply actions are the next step being enabled.",
      });
    }
  }

  return NextResponse.json({
    text: "MCC Messages is connected.",
  });
}
