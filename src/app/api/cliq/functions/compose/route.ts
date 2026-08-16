import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { requiredEnv } from "@/lib/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NEW_SMS_FORM_FUNCTION = "mccnewsms";
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

function newSmsForm(): UnknownRecord {
  return {
    type: "form",
    title: "New MCC SMS",
    name: "mcc_new_sms",
    version: 1,
    hint: "Search a Zoho CRM Contact and send an SMS from the MCC Twilio number.",
    button_label: "Send SMS",
    action: {
      type: "invoke.function",
      name: NEW_SMS_FORM_FUNCTION,
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

async function respond(payload: UnknownRecord, output: UnknownRecord): Promise<NextResponse> {
  const callbackUrl = responseUrl(payload);
  if (callbackUrl && isAllowedCliqResponseUrl(callbackUrl)) {
    const response = await fetch(callbackUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ output }),
      cache: "no-store",
    });

    if (response.ok) return NextResponse.json({ ok: true });

    console.warn("Zoho Cliq compose form callback failed", {
      status: response.status,
    });
  }

  return NextResponse.json({ output });
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

  return respond(payload, newSmsForm());
}
