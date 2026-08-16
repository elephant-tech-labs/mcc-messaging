import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { requiredEnv } from "@/lib/env";
import {
  countUnreadConversations,
  listInboxConversations,
  type MessagingInboxMode,
} from "@/lib/messaging/inbox";
import { getZohoContactById } from "@/lib/zoho/contacts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const VIEW_FUNCTION_NAME = "mccsmsview";
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
      if (key) mapped[key] = item.value ?? item.text ?? item.input;
    }
    return mapped;
  }
  return {};
}

function stringValue(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return null;
}

function safeEqual(left: string | null, right: string): boolean {
  if (!left) return false;
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
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
    console.warn("Zoho Cliq inbox response callback failed", { status: response.status });
  }

  return NextResponse.json({ output });
}

function preview(value: string | null, limit = 92): string {
  const body = value?.replace(/\s+/g, " ").trim() || "[No text]";
  return body.length <= limit ? body : `${body.slice(0, limit - 3)}...`;
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
  const requestedMode = stringValue(argumentsMap.mode)?.toLowerCase();
  const mode: MessagingInboxMode = requestedMode === "recent" ? "recent" : "unread";

  try {
    const [conversations, unreadTotal] = await Promise.all([
      listInboxConversations({ mode, limit: 5 }),
      countUnreadConversations(),
    ]);

    if (conversations.length === 0) {
      if (mode === "unread") {
        return sendCliqResponse(payload, {
          text: `📥 MCC SMS Inbox\n\nNo unread SMS conversations right now.`,
          buttons: [
            {
              label: "Show Recent",
              type: "+",
              key: "inbox:recent",
              action: { type: "invoke.function", data: { name: "mccsmsinbox" } },
              arguments: { mode: "recent" },
            },
          ],
        });
      }

      return sendCliqResponse(payload, {
        text: "📥 MCC SMS Inbox\n\nNo recent SMS conversations are available yet.",
      });
    }

    const contactNames = new Map<string, string>();
    await Promise.all(
      conversations.map(async (conversation) => {
        if (!conversation.zoho_contact_id || contactNames.has(conversation.zoho_contact_id)) return;
        try {
          const contact = await getZohoContactById(conversation.zoho_contact_id);
          const name = contact?.Full_Name?.trim();
          if (name) contactNames.set(conversation.zoho_contact_id, name);
        } catch {
          // Phone fallback is sufficient if CRM is temporarily unavailable.
        }
      }),
    );

    const lines = conversations.map((conversation, index) => {
      const label =
        (conversation.zoho_contact_id && contactNames.get(conversation.zoho_contact_id)) ||
        conversation.customer_phone;
      const incoming = conversation.last_message_direction?.toLowerCase() === "incoming";
      const direction = incoming ? "⬅️" : "➡️";
      const unread = conversation.unread_count > 0 ? ` · ${conversation.unread_count} unread` : "";
      return `${index + 1}. ${label}${unread}\n${direction} ${preview(conversation.last_message)}`;
    });

    const heading = mode === "unread" ? "Unread" : "Recent";
    const unreadLine = unreadTotal > 0 ? `${unreadTotal} unread conversation${unreadTotal === 1 ? "" : "s"}.` : "No unread conversations.";
    const text = `📥 MCC SMS Inbox · ${heading}\n${unreadLine}\n\n${lines.join("\n\n")}\n\nUse Inbox again to refresh.`;

    const buttons = conversations.map((conversation, index) => ({
      label: `View ${index + 1}`,
      type: "+",
      key: `inbox:view:${conversation.id}`,
      action: { type: "invoke.function", data: { name: VIEW_FUNCTION_NAME } },
      arguments: { conversationId: conversation.id },
    }));

    return sendCliqResponse(payload, { text, buttons });
  } catch (error) {
    console.error(
      "Zoho Cliq inbox failed",
      error instanceof Error ? error.message.slice(0, 220) : "Unknown inbox error",
    );
    return sendCliqResponse(payload, {
      text: "The MCC SMS inbox could not be loaded right now. Please try Inbox again.",
    });
  }
}
