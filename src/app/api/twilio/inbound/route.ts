import { attachZohoConversationId } from "@/lib/messaging/repository";
import {
  insertIncomingMessage,
  resolveInboundConversation,
  setConversationOptOut,
  updateIncomingSummary,
  type InboundMedia,
} from "@/lib/messaging/inbound-repository";
import { requiredEnv } from "@/lib/env";
import { normalizePhone } from "@/lib/phone/normalize";
import {
  formDataToRecord,
  validateTwilioWebhook,
} from "@/lib/twilio/validate";
import { findZohoContactByPhone } from "@/lib/zoho/contacts";
import {
  createZohoMessagingConversation,
  updateZohoMessagingConversation,
} from "@/lib/zoho/conversations";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const STOP_WORDS = new Set([
  "STOP",
  "STOPALL",
  "UNSUBSCRIBE",
  "CANCEL",
  "END",
  "QUIT",
]);
const START_WORDS = new Set(["START", "UNSTOP"]);

function twiml(status = 200): Response {
  return new Response("<?xml version=\"1.0\" encoding=\"UTF-8\"?><Response></Response>", {
    status,
    headers: { "Content-Type": "text/xml; charset=utf-8" },
  });
}

function mediaFromParams(params: Record<string, string>): InboundMedia[] {
  const count = Math.max(0, Math.min(10, Number.parseInt(params.NumMedia ?? "0", 10) || 0));
  const media: InboundMedia[] = [];

  for (let index = 0; index < count; index += 1) {
    const url = params[`MediaUrl${index}`];
    if (!url) continue;
    media.push({
      url,
      contentType: params[`MediaContentType${index}`] || null,
    });
  }

  return media;
}

function displayBody(body: string, mediaCount: number): string {
  if (body.trim()) return body.trim();
  return mediaCount > 0 ? `[Incoming MMS: ${mediaCount} attachment${mediaCount === 1 ? "" : "s"}]` : "[Incoming SMS]";
}

export async function POST(request: Request) {
  let params: Record<string, string>;
  try {
    const form = await request.formData();
    params = formDataToRecord(form);
  } catch {
    return twiml(400);
  }

  if (!validateTwilioWebhook(request, params)) {
    return twiml(403);
  }

  const messageSid = (params.MessageSid || params.SmsSid || "").trim();
  const from = params.From?.trim();
  const to = params.To?.trim();

  if (!messageSid || !from || !to) {
    return twiml(400);
  }

  try {
    const customerPhone = normalizePhone(from);
    const twilioPhone = normalizePhone(to);
    const configuredTwilioPhone = normalizePhone(requiredEnv("TWILIO_PHONE_NUMBER"));

    // A valid Twilio account can own multiple numbers. Only ingest traffic for
    // the MCC sender configured for this service.
    if (twilioPhone !== configuredTwilioPhone) {
      return twiml();
    }

    const body = params.Body ?? "";
    const media = mediaFromParams(params);
    const occurredAt = new Date().toISOString();

    // Phone lookup is intentionally best-effort until ZohoSearch.securesearch.READ
    // is added. A lookup failure must never cause an inbound SMS to be lost.
    let zohoContactId: string | null = null;
    try {
      const contact = await findZohoContactByPhone(customerPhone);
      zohoContactId = contact?.id ?? null;
    } catch (error) {
      console.warn(
        "Inbound Zoho phone lookup unavailable; storing unmatched conversation",
        error instanceof Error ? error.message.slice(0, 180) : "Unknown Zoho lookup error",
      );
    }

    let conversation = await resolveInboundConversation({
      zohoContactId,
      customerPhone,
      twilioPhone,
    });

    const inserted = await insertIncomingMessage({
      conversationId: conversation.id,
      twilioMessageSid: messageSid,
      body,
      fromPhone: customerPhone,
      toPhone: twilioPhone,
      media,
    });

    // Twilio may retry the same webhook. MessageSid idempotency prevents both a
    // duplicate message row and a second unread increment.
    if (!inserted.inserted) {
      return twiml();
    }

    const summaryBody = displayBody(body, media.length);
    conversation = await updateIncomingSummary({
      conversationId: conversation.id,
      body: summaryBody,
      occurredAt,
    });

    const normalizedBody = body.trim().toUpperCase();
    let optOutChanged = false;
    if (STOP_WORDS.has(normalizedBody)) {
      conversation = await setConversationOptOut({
        conversationId: conversation.id,
        optedOut: true,
        occurredAt,
      });
      optOutChanged = true;
    } else if (START_WORDS.has(normalizedBody)) {
      conversation = await setConversationOptOut({
        conversationId: conversation.id,
        optedOut: false,
        occurredAt,
      });
      optOutChanged = true;
    }

    // CRM is a summary/projection. Once Supabase has durably stored the inbound
    // message, CRM sync errors are recoverable and must not trigger Twilio retry.
    if (zohoContactId) {
      try {
        const crmSummary = {
          lastMessage: summaryBody,
          lastMessageAt: occurredAt,
          lastMessageDirection: "Incoming" as const,
          lastMessageStatus: "Received" as const,
          unreadCount: conversation.unread_count,
          lastIncomingAt: occurredAt,
          ...(optOutChanged
            ? {
                optOutStatus: conversation.opt_out_status as
                  | "Active"
                  | "Opted Out"
                  | "Do Not Message",
                optOutDate:
                  conversation.opt_out_status === "Active"
                    ? null
                    : occurredAt.slice(0, 10),
              }
            : {}),
        };

        if (!conversation.zoho_conversation_id) {
          const zohoConversationId = await createZohoMessagingConversation({
            contactId: zohoContactId,
            customerPhone,
            twilioPhone,
            externalConversationId: conversation.id,
            createdFrom: "Incoming SMS",
            summary: crmSummary,
          });
          conversation = await attachZohoConversationId(
            conversation.id,
            zohoConversationId,
          );
        } else {
          await updateZohoMessagingConversation(
            conversation.zoho_conversation_id,
            crmSummary,
          );
        }
      } catch (error) {
        console.warn(
          "Inbound CRM conversation sync failed after durable message storage",
          error instanceof Error ? error.message.slice(0, 180) : "Unknown CRM sync error",
        );
      }
    }

    return twiml();
  } catch (error) {
    // Persistence/validation failure should be visible to Twilio so its normal
    // webhook retry behavior can protect against message loss.
    console.error(
      "Inbound SMS persistence failed",
      error instanceof Error ? error.message.slice(0, 220) : "Unknown inbound error",
    );
    return twiml(500);
  }
}
