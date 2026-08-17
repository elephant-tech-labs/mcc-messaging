import {
  insertIncomingMessage,
  resolveInboundConversation,
  setConversationOptOut,
  updateIncomingSummary,
  type InboundMedia,
} from "@/lib/messaging/inbound-repository";
import { projectConversationToZoho } from "@/lib/messaging/crm-reconciliation";
import { requiredEnv } from "@/lib/env";
import { normalizePhone } from "@/lib/phone/normalize";
import {
  formDataToRecord,
  validateTwilioWebhook,
} from "@/lib/twilio/validate";
import {
  findZohoContactByPhone,
  getZohoContactById,
  type ZohoContact,
} from "@/lib/zoho/contacts";
import { sendIncomingSmsCliqNotification } from "@/lib/zoho-cliq/messages";

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

function contactDisplayName(contact: ZohoContact | null): string | null {
  if (!contact) return null;
  if (contact.Full_Name?.trim()) return contact.Full_Name.trim();
  const combined = [contact.First_Name, contact.Last_Name]
    .filter((value): value is string => Boolean(value?.trim()))
    .join(" ")
    .trim();
  return combined || null;
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

    if (twilioPhone !== configuredTwilioPhone) {
      return twiml();
    }

    const body = params.Body ?? "";
    const media = mediaFromParams(params);
    const occurredAt = new Date().toISOString();

    let zohoContactId: string | null = null;
    let contactName: string | null = null;
    try {
      const contact = await findZohoContactByPhone(customerPhone);
      zohoContactId = contact?.id ?? null;
      contactName = contactDisplayName(contact);
    } catch (error) {
      console.warn(
        "Inbound Zoho phone lookup unavailable; falling back to existing-thread matching",
        error instanceof Error ? error.message.slice(0, 180) : "Unknown Zoho lookup error",
      );
    }

    let conversation = await resolveInboundConversation({
      zohoContactId,
      customerPhone,
      twilioPhone,
    });

    if (!zohoContactId && conversation.zoho_contact_id) {
      zohoContactId = conversation.zoho_contact_id;
    }

    if (!contactName && zohoContactId) {
      try {
        contactName = contactDisplayName(await getZohoContactById(zohoContactId));
      } catch (error) {
        console.warn(
          "Inbound Zoho contact-name lookup failed; Cliq will show phone only",
          error instanceof Error ? error.message.slice(0, 180) : "Unknown Zoho contact lookup error",
        );
      }
    }

    const inserted = await insertIncomingMessage({
      conversationId: conversation.id,
      twilioMessageSid: messageSid,
      body,
      fromPhone: customerPhone,
      toPhone: twilioPhone,
      media,
    });

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
    if (STOP_WORDS.has(normalizedBody)) {
      conversation = await setConversationOptOut({
        conversationId: conversation.id,
        optedOut: true,
        occurredAt,
      });
    } else if (START_WORDS.has(normalizedBody)) {
      conversation = await setConversationOptOut({
        conversationId: conversation.id,
        optedOut: false,
        occurredAt,
      });
    }

    if (conversation.zoho_contact_id) {
      try {
        conversation = await projectConversationToZoho(conversation.id);
      } catch (error) {
        console.warn(
          "Inbound CRM projection deferred for reconciliation",
          error instanceof Error ? error.message.slice(0, 180) : "Unknown CRM sync error",
        );
      }
    }

    try {
      await sendIncomingSmsCliqNotification({
        conversationId: conversation.id,
        zohoContactId,
        contactName,
        customerPhone,
        body: summaryBody,
        mediaCount: media.length,
      });
    } catch (error) {
      console.warn(
        "Inbound Cliq notification failed after durable message storage",
        error instanceof Error ? error.message.slice(0, 220) : "Unknown Cliq notification error",
      );
    }

    return twiml();
  } catch (error) {
    console.error(
      "Inbound SMS persistence failed",
      error instanceof Error ? error.message.slice(0, 220) : "Unknown inbound error",
    );
    return twiml(500);
  }
}
