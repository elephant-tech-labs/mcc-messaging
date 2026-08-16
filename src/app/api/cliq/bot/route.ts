import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { requiredEnv } from "@/lib/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NEW_SMS_FUNCTION_NAME = "mccnewsms";
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

function newSmsForm(): UnknownRecord {
  return {
    type: "form",
    title: "New MCC SMS",
    name: "mcc_new_sms",
    version: 1,
    hint: "Search a Zoho CRM Contact and send an SMS from the MCC Twilio number.",
    button_label: "Send SMS",
    trigger_on_cancel: true,
    action: {
      type: "invoke.function",
      name: NEW_SMS_FUNCTION_NAME,
    },
    inputs: [
      {
        type: "dynamic_select",
        name: "contact",
        label: "CRM Contact",
        hint: "Search by contact name. Only Contacts with a Phone value can be selected.",
        placeholder: "Start typing a contact name",
        mandatory: true,
        options: [
          {
            label: "Start typing to search CRM",
            value: "scope_required",
          },
        ],
      },
      {
        type: "textarea",
        name: "message",
        label: "SMS Message",
        hint: "The message will be sent through the existing MCC Twilio number.",
        placeholder: "Type your message",
        mandatory: true,
        min_length: 1,
        max_length: 1600,
      },
    ],
  };
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
  console.info("Zoho Cliq bot event received", {
    handlerType: type ?? "unknown",
    handlerName: stringValue(handler.name),
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

  // Zoho currently labels this webhook bot-menu invocation as action_handler.
  // Bot menu handlers support forms as synchronous responses, so return the
  // documented form object directly.
  if (type === "menu_handler" || type === "action_handler") {
    return NextResponse.json(newSmsForm());
  }

  if (type === "message_handler") return silent();

  return silent();
}
