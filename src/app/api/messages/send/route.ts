import { NextResponse } from "next/server";
import { hasValidServiceKey } from "@/lib/auth/service-key";
import { requiredEnv } from "@/lib/env";
import {
  attachZohoConversationId,
  findOrCreateConversation,
  insertOutgoingMessage,
  updateOutgoingSummary,
} from "@/lib/messaging/repository";
import { normalizePhone } from "@/lib/phone/normalize";
import { getTwilioClient } from "@/lib/twilio/client";
import { toZohoMessageStatus } from "@/lib/twilio/status";
import { getZohoContactById } from "@/lib/zoho/contacts";
import {
  createZohoMessagingConversation,
  updateZohoMessagingConversation,
} from "@/lib/zoho/conversations";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type SendRequest = {
  zohoContactId?: string;
  body?: string;
  sentByZohoUserId?: string;
  sentByName?: string;
};

function message(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 300) : "Unknown error";
}

export async function POST(request: Request) {
  if (!hasValidServiceKey(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let input: SendRequest;
  try {
    input = (await request.json()) as SendRequest;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const zohoContactId = input.zohoContactId?.trim();
  const body = input.body?.trim();

  if (!zohoContactId) {
    return NextResponse.json({ error: "zohoContactId is required" }, { status: 400 });
  }
  if (!body) {
    return NextResponse.json({ error: "body is required" }, { status: 400 });
  }
  if (body.length > 1600) {
    return NextResponse.json(
      { error: "SMS body must be 1600 characters or fewer" },
      { status: 400 },
    );
  }

  try {
    const contact = await getZohoContactById(zohoContactId);
    if (!contact) {
      return NextResponse.json({ error: "Zoho Contact not found" }, { status: 404 });
    }
    if (!contact.Phone) {
      return NextResponse.json(
        { error: "Zoho Contact has no Phone value. Contacts.Phone is required for MCC SMS." },
        { status: 409 },
      );
    }

    const customerPhone = normalizePhone(contact.Phone);
    const twilioPhone = normalizePhone(requiredEnv("TWILIO_PHONE_NUMBER"));

    let conversation = await findOrCreateConversation({
      zohoContactId,
      customerPhone,
      twilioPhone,
      createdFrom: "CRM Widget",
    });

    if (conversation.opt_out_status !== "Active") {
      return NextResponse.json(
        {
          error: "Messaging blocked by opt-out status",
          optOutStatus: conversation.opt_out_status,
        },
        { status: 409 },
      );
    }

    if (!conversation.zoho_conversation_id) {
      const zohoConversationId = await createZohoMessagingConversation({
        contactId: zohoContactId,
        customerPhone,
        twilioPhone,
        externalConversationId: conversation.id,
        createdFrom: "CRM Widget",
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

    const occurredAt = (
      twilioMessage.dateCreated instanceof Date
        ? twilioMessage.dateCreated
        : new Date()
    ).toISOString();

    await insertOutgoingMessage({
      conversationId: conversation.id,
      twilioMessageSid: twilioMessage.sid,
      body,
      status: twilioMessage.status,
      fromPhone: twilioPhone,
      toPhone: customerPhone,
      sentByZohoUserId: input.sentByZohoUserId?.trim() || null,
      sentByName: input.sentByName?.trim() || null,
      source: "CRM Widget",
      twilioDateCreated:
        twilioMessage.dateCreated instanceof Date ? twilioMessage.dateCreated : null,
      twilioDateSent:
        twilioMessage.dateSent instanceof Date ? twilioMessage.dateSent : null,
    });

    conversation = await updateOutgoingSummary({
      conversationId: conversation.id,
      body,
      status: twilioMessage.status,
      occurredAt,
    });

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

    return NextResponse.json(
      {
        ok: true,
        messageSid: twilioMessage.sid,
        status: twilioMessage.status,
        conversationId: conversation.id,
        zohoConversationId: conversation.zoho_conversation_id,
        crmSynced,
        ...(crmSyncError ? { crmSyncError } : {}),
      },
      { status: 201 },
    );
  } catch (error) {
    return NextResponse.json(
      { error: "SMS send failed", detail: message(error) },
      { status: 502 },
    );
  }
}
