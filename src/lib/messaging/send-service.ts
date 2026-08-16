import { requiredEnv } from "@/lib/env";
import {
  attachZohoConversationId,
  findOrCreateConversation,
  getConversationById,
  insertOutgoingMessage,
  updateOutgoingSummary,
  type MessagingConversation,
} from "@/lib/messaging/repository";
import { normalizePhone } from "@/lib/phone/normalize";
import { getTwilioClient } from "@/lib/twilio/client";
import { toZohoMessageStatus } from "@/lib/twilio/status";
import { getZohoContactById } from "@/lib/zoho/contacts";
import {
  createZohoMessagingConversation,
  updateZohoMessagingConversation,
} from "@/lib/zoho/conversations";

export type SmsSendSource = "CRM Widget" | "Cliq" | "Bulk SMS" | "Automation";

export class SmsSendError extends Error {
  status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "SmsSendError";
    this.status = status;
  }
}

export type SendSmsInput = {
  body: string;
  source: SmsSendSource;
  zohoContactId?: string | null;
  conversationId?: string | null;
  sentByZohoUserId?: string | null;
  sentByName?: string | null;
};

export type SendSmsResult = {
  messageSid: string;
  status: string;
  conversationId: string;
  zohoConversationId: string | null;
  crmSynced: boolean;
  crmSyncError?: string;
};

function message(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 300) : "Unknown error";
}

function conversationOrigin(source: SmsSendSource): "CRM Widget" | "Automation" {
  return source === "Automation" || source === "Bulk SMS" ? "Automation" : "CRM Widget";
}

async function resolveConversation(input: SendSmsInput): Promise<{
  conversation: MessagingConversation;
  zohoContactId: string;
  customerPhone: string;
  twilioPhone: string;
}> {
  const configuredTwilioPhone = normalizePhone(requiredEnv("TWILIO_PHONE_NUMBER"));

  if (input.conversationId?.trim()) {
    const conversation = await getConversationById(input.conversationId.trim());
    if (!conversation) throw new SmsSendError("Messaging conversation not found", 404);
    if (conversation.channel !== "SMS") throw new SmsSendError("Only SMS conversations can be replied to", 409);
    if (!conversation.zoho_contact_id) {
      throw new SmsSendError("This conversation is not matched to a Zoho Contact yet, so sending is blocked.", 409);
    }
    if (normalizePhone(conversation.twilio_phone) !== configuredTwilioPhone) {
      throw new SmsSendError("Conversation belongs to a different MCC sender number", 409);
    }
    const customerPhone = normalizePhone(conversation.customer_phone);
    if (customerPhone === configuredTwilioPhone) {
      throw new SmsSendError("Sending to the MCC Twilio sender number is blocked", 409);
    }
    return { conversation, zohoContactId: conversation.zoho_contact_id, customerPhone, twilioPhone: configuredTwilioPhone };
  }

  const zohoContactId = input.zohoContactId?.trim();
  if (!zohoContactId) throw new SmsSendError("zohoContactId or conversationId is required", 400);
  const contact = await getZohoContactById(zohoContactId);
  if (!contact) throw new SmsSendError("Zoho Contact not found", 404);
  if (!contact.Phone) {
    throw new SmsSendError("Zoho Contact has no Phone value. Contacts.Phone is required for MCC SMS.", 409);
  }

  const customerPhone = normalizePhone(contact.Phone);
  if (customerPhone === configuredTwilioPhone) {
    throw new SmsSendError("Sending to the MCC Twilio sender number is blocked", 409);
  }

  const conversation = await findOrCreateConversation({
    zohoContactId,
    customerPhone,
    twilioPhone: configuredTwilioPhone,
    createdFrom: conversationOrigin(input.source),
  });
  return { conversation, zohoContactId, customerPhone, twilioPhone: configuredTwilioPhone };
}

export async function sendSms(input: SendSmsInput): Promise<SendSmsResult> {
  const body = input.body.trim();
  if (!body) throw new SmsSendError("body is required", 400);
  if (body.length > 1600) throw new SmsSendError("SMS body must be 1600 characters or fewer", 400);

  let { conversation, zohoContactId, customerPhone, twilioPhone } = await resolveConversation(input);
  if (conversation.opt_out_status !== "Active") {
    throw new SmsSendError(`Messaging blocked by opt-out status: ${conversation.opt_out_status}`, 409);
  }

  if (!conversation.zoho_conversation_id) {
    const zohoConversationId = await createZohoMessagingConversation({
      contactId: zohoContactId,
      customerPhone,
      twilioPhone,
      externalConversationId: conversation.id,
      createdFrom: conversationOrigin(input.source),
    });
    conversation = await attachZohoConversationId(conversation.id, zohoConversationId);
  }

  const baseUrl = requiredEnv("APP_BASE_URL").replace(/\/$/, "");
  const twilioMessage = await getTwilioClient().messages.create({
    body,
    to: customerPhone,
    from: twilioPhone,
    statusCallback: `${baseUrl}/api/twilio/status`,
  });

  const occurredAt = (twilioMessage.dateCreated instanceof Date ? twilioMessage.dateCreated : new Date()).toISOString();

  await insertOutgoingMessage({
    conversationId: conversation.id,
    twilioMessageSid: twilioMessage.sid,
    body,
    status: twilioMessage.status,
    fromPhone: twilioPhone,
    toPhone: customerPhone,
    sentByZohoUserId: input.sentByZohoUserId?.trim() || null,
    sentByName: input.sentByName?.trim() || null,
    source: input.source as "CRM Widget" | "Cliq" | "Automation",
    twilioDateCreated: twilioMessage.dateCreated instanceof Date ? twilioMessage.dateCreated : null,
    twilioDateSent: twilioMessage.dateSent instanceof Date ? twilioMessage.dateSent : null,
  });

  conversation = await updateOutgoingSummary({ conversationId: conversation.id, body, status: twilioMessage.status, occurredAt });

  let crmSynced = true;
  let crmSyncError: string | undefined;
  if (conversation.zoho_conversation_id) {
    try {
      await updateZohoMessagingConversation(conversation.zoho_conversation_id, {
        lastMessage: body,
        lastMessageAt: occurredAt,
        lastMessageDirection: "Outgoing",
        lastMessageStatus: toZohoMessageStatus(twilioMessage.status),
        unreadCount: 0,
        lastOutgoingAt: occurredAt,
      });
    } catch (error) {
      crmSynced = false;
      crmSyncError = message(error);
    }
  }

  return {
    messageSid: twilioMessage.sid,
    status: twilioMessage.status,
    conversationId: conversation.id,
    zohoConversationId: conversation.zoho_conversation_id,
    crmSynced,
    ...(crmSyncError ? { crmSyncError } : {}),
  };
}
