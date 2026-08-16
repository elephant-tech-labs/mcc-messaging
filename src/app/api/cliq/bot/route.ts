import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { requiredEnv } from "@/lib/env";
import { cliqFetch } from "@/lib/zoho-cliq/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MCC_BOT_UNIQUE_NAME = "mccmessagesx";
const NEW_SMS_MENU_NAME = "New SMS";
const COMPOSE_FUNCTION_NAME = "mccsmscompose";
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
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return null;
}

function handlerType(payload: UnknownRecord): string | null {
  const params = record(payload.params);
  const handler = record(payload.handler);
  const execution = record(payload.execution);
  const executionDetails = record(payload.execution_details);
  return stringValue(
    payload.handler_type,
    payload.handlerType,
    params.handler_type,
    params.handlerType,
    handler.type,
    execution.handler_type,
    execution.type,
    executionDetails.handler_type,
    executionDetails.type,
    payload.type,
  );
}

function responseUrl(payload: UnknownRecord): string | null {
  const params = record(payload.params);
  return stringValue(payload.response_url, payload.responseUrl, params.response_url, params.responseUrl);
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
  if (delivered) return NextResponse.json({ ok: true });
  return NextResponse.json({ output: { text } });
}

function cliqUserId(payload: UnknownRecord): string | null {
  const params = record(payload.params);
  const user = record(params.user ?? payload.user);
  const access = record(params.access ?? payload.access);
  return stringValue(
    user.id,
    user.user_id,
    user.userId,
    user.zuid,
    access.user_id,
    access.userId,
    access.zuid,
    access.id,
  );
}

async function sendComposePrompt(userId: string): Promise<void> {
  const path = `/bots/${encodeURIComponent(MCC_BOT_UNIQUE_NAME)}/messages?user_ids=${encodeURIComponent(userId)}`;

  await cliqFetch(path, {
    method: "POST",
    body: JSON.stringify({
      text: "Start a new MCC SMS conversation.",
      buttons: [
        {
          label: "Compose SMS",
          type: "+",
          action: {
            type: "invoke.function",
            data: { name: COMPOSE_FUNCTION_NAME },
          },
        },
      ],
      sync_message: true,
      mark_as_read: true,
    }),
  });
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
  const handler = record(payload.handler);
  const handlerName = stringValue(handler.name);
  console.info("Zoho Cliq bot event received", {
    handlerType: type ?? "unknown",
    handlerName,
    handlerDeclaredType: stringValue(handler.type),
    payloadKeys: Object.keys(payload).slice(0, 20),
    paramKeys: Object.keys(params).slice(0, 20),
    hasResponseUrl: Boolean(responseUrl(payload)),
  });

  if (type === "welcome_handler") {
    return reply(
      payload,
      "MCC Messages is connected. You can receive and reply to MCC SMS conversations here, or use New SMS from the bot menu to start one.",
    );
  }

  if (
    (type === "menu_handler" || type === "action_handler") &&
    (!handlerName || handlerName.toLowerCase() === NEW_SMS_MENU_NAME.toLowerCase())
  ) {
    const userId = cliqUserId(payload);
    if (!userId) {
      const access = record(params.access ?? payload.access);
      const user = record(params.user ?? payload.user);
      console.warn("Cliq New SMS menu could not resolve the invoking user", {
        accessKeys: Object.keys(access).slice(0, 20),
        userKeys: Object.keys(user).slice(0, 20),
      });
      return silent();
    }

    try {
      await sendComposePrompt(userId);
    } catch (error) {
      console.error(
        "Cliq New SMS compose prompt failed",
        error instanceof Error ? error.message.slice(0, 220) : "Unknown compose prompt error",
      );
    }
    return silent();
  }

  if (type === "message_handler") return silent();

  return silent();
}
