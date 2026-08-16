import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { requiredEnv } from "@/lib/env";
import { sendSms, SmsSendError } from "@/lib/messaging/send-service";
import { searchZohoContacts } from "@/lib/zoho/contacts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type UnknownRecord = Record<string, unknown>;

function record(value: unknown): UnknownRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as UnknownRecord)
    : {};
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
      if (key) mapped[key] = item.value ?? item.text ?? item.input ?? item.query;
    }
    return mapped;
  }
  return {};
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
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return null;
}

function handlerType(payload: UnknownRecord): string | null {
  const params = record(payload.params);
  const handler = record(payload.handler);
  const execution = record(payload.execution);
  const details = record(payload.execution_details);
  return stringValue(
    payload.handler_type,
    payload.handlerType,
    params.handler_type,
    params.handlerType,
    handler.type,
    execution.handler_type,
    execution.type,
    details.handler_type,
    details.type,
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

async function sendCliqResponse(payload: UnknownRecord, output: UnknownRecord): Promise<NextResponse> {
  const callbackUrl = responseUrl(payload);
  if (callbackUrl && isAllowedCliqResponseUrl(callbackUrl)) {
    const response = await fetch(callbackUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ output }),
      cache: "no-store",
    });
    if (response.ok) return NextResponse.json({ ok: true });
    console.warn("Zoho Cliq new-SMS response callback failed", { status: response.status });
  }
  return NextResponse.json({ output });
}

function selectedValue(value: unknown): string | null {
  if (typeof value === "string") return value.trim() || null;
  const item = mapFromUnknown(value);
  return stringValue(item.value, item.id);
}

function selectedLabel(value: unknown): string | null {
  if (typeof value === "string") return value.trim() || null;
  const item = mapFromUnknown(value);
  return stringValue(item.label, item.name);
}

function userIdentity(payload: UnknownRecord): { id: string | null; name: string | null } {
  const params = record(payload.params);
  const user = mapFromUnknown(params.user ?? payload.user);
  const name = stringValue(
    user.full_name,
    user.name,
    [stringValue(user.first_name), stringValue(user.last_name)].filter(Boolean).join(" "),
  );
  return {
    id: stringValue(user.id, user.user_id, user.zuid),
    name,
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
  const type = handlerType(payload);
  const target = mapFromUnknown(params.target ?? payload.target);
  const dynamicQuery = stringValue(
    target.query,
    target.search_query,
    target.searchQuery,
    params.query,
    payload.query,
  ) ?? "";

  if (type === "form_dynamic_select_handler" || type === "form_values_handler" || dynamicQuery) {
    console.info("Cliq New SMS dynamic contact search", {
      handlerType: type ?? "unknown",
      targetKeys: Object.keys(target).slice(0, 12),
      targetName: stringValue(target.name) ?? "unknown",
      queryLength: dynamicQuery.length,
    });

    if (dynamicQuery.length < 2) {
      return NextResponse.json({ output: { options: [] } });
    }

    try {
      const contacts = await searchZohoContacts(dynamicQuery, 20);
      console.info("Cliq New SMS dynamic contact search completed", {
        resultCount: contacts.length,
      });
      return NextResponse.json({
        output: {
          options: contacts.map((contact) => ({
            label: `${contact.Full_Name?.trim() || "Unnamed Contact"}${contact.Phone ? ` · ${contact.Phone}` : ""}`.slice(0, 100),
            value: contact.id,
          })),
        },
      });
    } catch (error) {
      console.warn(
        "Cliq New SMS contact search unavailable",
        error instanceof Error ? error.message.slice(0, 220) : "Unknown CRM contact search error",
      );
      return NextResponse.json({ output: { options: [] } });
    }
  }

  const form = mapFromUnknown(params.form ?? payload.form);
  const action = stringValue(form.action);
  if (action?.toLowerCase() === "cancel") {
    return sendCliqResponse(payload, { text: "New SMS cancelled." });
  }

  const values = mapFromUnknown(form.values);
  const contactField = values.contact;
  const contactId = selectedValue(contactField);
  const contactLabel = selectedLabel(contactField);
  const body = stringValue(values.message, values.body);

  if (!contactId || contactId === "scope_required") {
    return NextResponse.json({
      type: "form_error",
      text: "Choose a CRM Contact before sending.",
      inputs: { contact: "Search for and choose a CRM Contact." },
    });
  }
  if (!body) {
    return NextResponse.json({
      type: "form_error",
      text: "Enter an SMS message before sending.",
      inputs: { message: "Message is required." },
    });
  }

  try {
    const user = userIdentity(payload);
    const result = await sendSms({
      zohoContactId: contactId,
      body,
      source: "Cliq",
      sentByZohoUserId: user.id,
      sentByName: user.name,
    });

    return sendCliqResponse(payload, {
      text: `✅ SMS sent${contactLabel ? ` to ${contactLabel}` : ""}. Delivery status will sync automatically.`,
      buttons: [
        {
          label: "View Conversation",
          type: "+",
          key: `view:${result.conversationId}`,
          action: { type: "invoke.function", data: { name: "mccsmsview" } },
          arguments: { conversationId: result.conversationId },
        },
      ],
    });
  } catch (error) {
    const text =
      error instanceof SmsSendError
        ? error.message
        : "SMS could not be sent right now. Please try again.";
    console.error(
      "Cliq New SMS send failed",
      error instanceof Error ? error.message.slice(0, 220) : "Unknown New SMS error",
    );
    return sendCliqResponse(payload, { text: `❌ ${text}` });
  }
}
