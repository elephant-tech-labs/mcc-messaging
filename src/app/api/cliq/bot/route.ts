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

function responseUrl(payload: UnknownRecord): string | null {
  return stringValue(payload.response_url, payload.responseUrl);
}

function isAllowedCliqResponseUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && /^cliq\.zoho\.[a-z.]+$/i.test(url.hostname);
  } catch {
    return false;
  }
}

async function sendCliqResponse(payload: UnknownRecord, text: string): Promise<boolean> {
  const callbackUrl = responseUrl(payload);
  if (!callbackUrl || !isAllowedCliqResponseUrl(callbackUrl)) return false;

  const response = await fetch(callbackUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ output: { text } }),
    cache: "no-store",
  });

  if (!response.ok) {
    const body = (await response.text()).slice(0, 500);
    console.error("Zoho Cliq response callback failed", {
      status: response.status,
      body,
    });
    return false;
  }

  return true;
}

async function reply(payload: UnknownRecord, text: string): Promise<NextResponse> {
  const delivered = await sendCliqResponse(payload, text);

  if (delivered) {
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ output: { text } });
}

function silent(): Response {
  return new Response(null, { status: 204 });
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
  const params = record(payload.params);
  console.info("Zoho Cliq bot event received", {
    handlerType: type ?? "unknown",
    payloadKeys: Object.keys(payload).slice(0, 20),
    paramKeys: Object.keys(params).slice(0, 20),
    hasResponseUrl: Boolean(responseUrl(payload)),
  });

  if (type === "welcome_handler") {
    return reply(
      payload,
      "MCC Messages is connected. You’ll be able to receive and reply to MCC SMS conversations here.",
    );
  }

  // Ordinary messages should not generate generic bot chatter. Future reply/search
  // actions will be explicit button, form, menu, or command handlers.
  if (type === "message_handler") {
    return silent();
  }

  // Unknown/unhandled bot events are intentionally acknowledged without a message.
  return silent();
}
