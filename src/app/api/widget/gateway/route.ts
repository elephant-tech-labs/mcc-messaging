import { NextResponse } from "next/server";
import { hasValidWidgetKey } from "@/lib/auth/widget-key";
import {
  createBulkSmsJob,
  getBulkSmsJobStatus,
  previewBulkSmsRecipients,
  processBulkSmsBatch,
} from "@/lib/messaging/bulk-sms";
import {
  countUnreadConversations,
  listInboxConversations,
  markConversationRead,
  type MessagingInboxMode,
} from "@/lib/messaging/inbox";
import {
  getContactThread,
  getConversationById,
  getConversationMessages,
} from "@/lib/messaging/repository";
import { sendSms, SmsSendError } from "@/lib/messaging/send-service";
import {
  getZohoContactById,
  getZohoContactsByIds,
  searchZohoContacts,
  type ZohoContact,
} from "@/lib/zoho/contacts";
import { updateZohoMessagingConversation } from "@/lib/zoho/conversations";
import { zohoContactRecordUrl } from "@/lib/zoho/crm-url";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type WidgetAction =
  | "history"
  | "send"
  | "inbox"
  | "conversation"
  | "searchContacts"
  | "bulkPreview"
  | "bulkCreate"
  | "bulkProcess"
  | "bulkStatus";

type WidgetRequest = {
  action?: WidgetAction;
  zohoContactId?: string;
  conversationId?: string;
  body?: string;
  mode?: MessagingInboxMode;
  query?: string;
  sentByZohoUserId?: string;
  sentByName?: string;
  contactIds?: unknown;
  messageTemplate?: string;
  jobName?: string;
  jobId?: string;
};

function cleanText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  return text || undefined;
}

function cleanContactIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter((item) => /^\d{10,25}$/.test(item)))].slice(0, 2000);
}

function validJobId(value: string | undefined): value is string {
  return Boolean(value && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 300) : "Unknown error";
}

function contactName(contact: ZohoContact | null | undefined): string | null {
  if (!contact) return null;
  return contact.Full_Name?.trim() || [contact.First_Name, contact.Last_Name].filter(Boolean).join(" ").trim() || null;
}

function contactView(contact: ZohoContact | null | undefined) {
  if (!contact) return null;
  return {
    id: contact.id,
    name: contactName(contact),
    phone: contact.Phone ?? null,
    mobile: contact.Mobile ?? null,
    email: contact.Email ?? null,
    status: contact.Status ?? null,
    owner: contact.Owner?.name ?? null,
    crm_url: zohoContactRecordUrl(contact.id),
  };
}

function validContactId(value: string | undefined): value is string {
  return Boolean(value && /^\d{10,25}$/.test(value));
}

export async function POST(request: Request) {
  if (!hasValidWidgetKey(request)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let input: WidgetRequest;
  try {
    input = (await request.json()) as WidgetRequest;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const action = input.action;
  const supported: WidgetAction[] = [
    "history", "send", "inbox", "conversation", "searchContacts",
    "bulkPreview", "bulkCreate", "bulkProcess", "bulkStatus",
  ];
  if (!action || !supported.includes(action)) {
    return NextResponse.json({ error: "Unsupported widget action" }, { status: 400 });
  }

  try {
    if (action === "bulkPreview") {
      const contactIds = cleanContactIds(input.contactIds);
      if (contactIds.length === 0) return NextResponse.json({ error: "Select at least one Contact" }, { status: 400 });
      const preview = await previewBulkSmsRecipients(contactIds);
      return NextResponse.json({ ok: true, ...preview });
    }

    if (action === "bulkCreate") {
      const contactIds = cleanContactIds(input.contactIds);
      const messageTemplate = cleanText(input.messageTemplate);
      if (contactIds.length === 0) return NextResponse.json({ error: "Select at least one Contact" }, { status: 400 });
      if (!messageTemplate) return NextResponse.json({ error: "Message is required" }, { status: 400 });
      const result = await createBulkSmsJob({
        contactIds,
        messageTemplate,
        name: cleanText(input.jobName),
        createdByZohoUserId: cleanText(input.sentByZohoUserId),
        createdByName: cleanText(input.sentByName),
      });
      return NextResponse.json({ ok: true, ...result }, { status: 201 });
    }

    if (action === "bulkProcess") {
      const jobId = cleanText(input.jobId);
      if (!validJobId(jobId)) return NextResponse.json({ error: "Valid jobId is required" }, { status: 400 });
      const result = await processBulkSmsBatch(jobId, 8);
      const status = await getBulkSmsJobStatus(jobId);
      return NextResponse.json({ ok: true, ...result, status });
    }

    if (action === "bulkStatus") {
      const jobId = cleanText(input.jobId);
      if (!validJobId(jobId)) return NextResponse.json({ error: "Valid jobId is required" }, { status: 400 });
      const status = await getBulkSmsJobStatus(jobId);
      return NextResponse.json({ ok: true, status });
    }

    if (action === "history") {
      const zohoContactId = cleanText(input.zohoContactId);
      if (!validContactId(zohoContactId)) return NextResponse.json({ error: "Valid zohoContactId is required" }, { status: 400 });
      const [contact, thread] = await Promise.all([getZohoContactById(zohoContactId), getContactThread(zohoContactId)]);
      if (!contact) return NextResponse.json({ error: "Zoho Contact not found" }, { status: 404 });
      return NextResponse.json({ ok: true, contact: contactView(contact), conversations: thread.conversations, messages: thread.messages });
    }

    if (action === "inbox") {
      const mode: MessagingInboxMode = input.mode === "unread" ? "unread" : "recent";
      const [conversations, unreadCount] = await Promise.all([
        listInboxConversations({ mode, limit: 75 }),
        countUnreadConversations(),
      ]);
      const contactIds = conversations.map((conversation) => conversation.zoho_contact_id).filter((id): id is string => Boolean(id));
      const contacts = await getZohoContactsByIds(contactIds);
      const contactMap = new Map(contacts.map((contact) => [contact.id, contact]));
      return NextResponse.json({
        ok: true,
        mode,
        unread_count: unreadCount,
        conversations: conversations.map((conversation) => ({
          id: conversation.id,
          status: conversation.status,
          customer_phone: conversation.customer_phone,
          last_message: conversation.last_message,
          last_message_at: conversation.last_message_at,
          last_message_direction: conversation.last_message_direction,
          last_message_status: conversation.last_message_status,
          unread_count: conversation.unread_count,
          opt_out_status: conversation.opt_out_status,
          zoho_contact_id: conversation.zoho_contact_id,
          contact: conversation.zoho_contact_id ? contactView(contactMap.get(conversation.zoho_contact_id)) : null,
        })),
      });
    }

    if (action === "conversation") {
      const conversationId = cleanText(input.conversationId);
      if (!conversationId) return NextResponse.json({ error: "conversationId is required" }, { status: 400 });
      let conversation = await getConversationById(conversationId);
      if (!conversation) return NextResponse.json({ error: "Messaging conversation not found" }, { status: 404 });
      if (conversation.unread_count > 0) {
        conversation = await markConversationRead(conversation.id);
        if (conversation.zoho_conversation_id) {
          try {
            await updateZohoMessagingConversation(conversation.zoho_conversation_id, { unreadCount: 0 });
          } catch {}
        }
      }
      const [messages, contact] = await Promise.all([
        getConversationMessages(conversation.id, 100),
        conversation.zoho_contact_id ? getZohoContactById(conversation.zoho_contact_id) : Promise.resolve(null),
      ]);
      return NextResponse.json({ ok: true, conversation, contact: contactView(contact), messages });
    }

    if (action === "searchContacts") {
      const query = cleanText(input.query) ?? "";
      if (query.length < 2) return NextResponse.json({ ok: true, contacts: [] });
      const contacts = await searchZohoContacts(query, 20);
      return NextResponse.json({ ok: true, contacts: contacts.map((contact) => contactView(contact)) });
    }

    const body = cleanText(input.body);
    if (!body) return NextResponse.json({ error: "body is required" }, { status: 400 });
    const zohoContactId = cleanText(input.zohoContactId);
    const conversationId = cleanText(input.conversationId);
    if (!conversationId && !validContactId(zohoContactId)) {
      return NextResponse.json({ error: "Valid zohoContactId or conversationId is required" }, { status: 400 });
    }

    const result = await sendSms({
      zohoContactId,
      conversationId,
      body,
      sentByZohoUserId: cleanText(input.sentByZohoUserId),
      sentByName: cleanText(input.sentByName),
      source: "CRM Widget",
    });
    return NextResponse.json({ ok: true, ...result }, { status: 201 });
  } catch (error) {
    if (error instanceof SmsSendError) return NextResponse.json({ error: error.message }, { status: error.status });
    return NextResponse.json({ error: "MCC messaging request failed", detail: errorMessage(error) }, { status: 502 });
  }
}
