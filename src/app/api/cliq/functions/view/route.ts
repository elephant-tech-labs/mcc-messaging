import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { requiredEnv } from "@/lib/env";
import { getConversationById, type MessagingMessage } from "@/lib/messaging/repository";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { getZohoContactById } from "@/lib/zoho/contacts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const REPLY_FUNCTION_NAME = "mccsmsreply";
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

function preview(value: string | null, limit = 260): string {
  const body = value?.trim() || "[No text]";
  return body.length <= limit ? body : `${body.slice(0, limit - 3)}...`;
}

function messageLine(message: MessagingMessage): string {
  const incoming = message.direction.toLowerCase() === "incoming";
  const speaker = incoming ? "Customer" : "MCC";
  const status = incoming ? "" : ` · ${message.status}`;
  return `${incoming ? "⬅️" : "➡️"} ${speaker}${status}\n${preview(message.body)}`;
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

    console.warn("Zoho Cliq conversation response callback failed", {
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

  const params = record(payload.params);
  const argumentsMap = mapFromUnknown(params.arguments ?? payload.arguments);
  const conversationId = stringValue(
    argumentsMap.conversationId,
    argumentsMap.conversation_id,
  );

  if (!conversationId) {
    return sendCliqResponse(payload, {
      text: "Could not identify this SMS conversation. Please use View Conversation on a newly received MCC SMS alert.",
    });
  }

  try {
    const conversation = await getConversationById(conversationId);
    if (!conversation) {
      return sendCliqResponse(payload, { text: "This SMS conversation could not be found." });
    }

    const { data, error } = await getSupabaseAdmin()
      .from("messaging_messages")
      .select("*")
      .eq("conversation_id", conversation.id)
      .order("created_at", { ascending: false })
      .limit(10);

    if (error) throw new Error(`Load conversation messages failed: ${error.message}`);

    const messages = ((data ?? []) as MessagingMessage[]).reverse();
    let contactName: string | null = null;
    if (conversation.zoho_contact_id) {
      try {
        const contact = await getZohoContactById(conversation.zoho_contact_id);
        contactName = contact?.Full_Name?.trim() || null;
      } catch {
        // The Supabase thread is enough to render the view if CRM is temporarily unavailable.
      }
    }

    const label = contactName || conversation.customer_phone;
    const transcript = messages.length
      ? messages.map(messageLine).join("\n\n")
      : "No messages are stored in this conversation yet.";

    const text = `💬 Recent SMS with ${label}\n${conversation.customer_phone}\n\n${transcript}`;

    const output: UnknownRecord = {
      text,
      buttons: [
        {
          label: "Reply",
          type: "+",
          key: `reply:${conversation.id}`,
          action: {
            type: "invoke.function",
            data: { name: REPLY_FUNCTION_NAME },
            confirm: {
              title: `Reply to ${label}`.slice(0, 100),
              description: `Send an SMS reply to ${conversation.customer_phone}`.slice(0, 100),
              input: "Type your SMS reply",
              emotion: "positive",
              button_label: "Send SMS",
              cancel_button_label: "Cancel",
              mandatory: "true",
            },
          },
          arguments: { conversationId: conversation.id },
        },
      ],
    };

    return sendCliqResponse(payload, output);
  } catch (error) {
    console.error(
      "Zoho Cliq conversation view failed",
      error instanceof Error ? error.message.slice(0, 220) : "Unknown conversation view error",
    );
    return sendCliqResponse(payload, {
      text: "Conversation history could not be loaded right now. Please retry from the latest SMS alert.",
    });
  }
}
