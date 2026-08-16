import { NextResponse } from "next/server";
import { hasValidWidgetKey } from "@/lib/auth/widget-key";
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
  | "searchContacts";

type WidgetRequest = {
  action?: WidgetAction;
  zohoContactId?: string;
  conversationId?: string;
  body?: string;
  mode?: MessagingInboxMode;
  query?: string;
  sentByZohoUserId?: string;
  sentByName?: string;
};

function cleanText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  return text || undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 300) : "Unknown error";
}

function contactName(contact: ZohoContact | null | undefined): string | null {
  if (!contact) return null;
  return (
    contact.Full_Name?.trim() ||
    [contact.First_Name, contact.Last_Name].filter(Boolean).join(" ").trim() ||
    null
  );
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
  if (!hasValidWidgetKey(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let input: WidgetRequest;
  try {
    input = (await request.json()) as WidgetRequest;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const action = input.action;
  if (!action || !["history", "send", "inbox", "conversation", "searchContacts"].includes(action)) {
    return NextResponse.json({ error: "Unsupported widget action" }, { status: 400 });
  }

  try {
    if (action === "history") {
      const zohoContactId = cleanText(input.zohoContactId);
      if (!validContactId(zohoContactId)) {
        return NextResponse.json({ error: "Valid zohoContactId is required" }, { status: 400 });
      }

      const [contact, thread] = await Promise.all([
        getZohoContactById(zohoContactId),
        getContactThread(zohoContactId),
      ]);
      if (!contact) {
        return NextResponse.json({ error: "Zoho Contact not found" }, { status: 404 });
      }

      return NextResponse.json({
        ok: true,
        contact: contactView(contact),
        conversations: thread.conversations,
        messages: thread.messages,
      });
    }

    if (action === "inbox") {
      const mode: MessagingInboxMode = input.mode === "unread" ? "unread" : "recent";
      const [conversations, unreadCount] = await Promise.all([
        listInboxConversations({ mode, limit: 75 }),
        countUnreadConversations(),
      ]);

      const contactIds = conversations
        .map((conversation) => conversation.zoho_contact_id)
        .filter((id): id is string => Boolean(id));
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
          contact: conversation.zoho_contact_id
            ? contactView(contactMap.get(conversation.zoho_contact_id))
            : null,
        })),
      });
    }

    if (action === "conversation") {
      const conversationId = cleanText(input.conversationId);
      if (!conversationId) {
        return NextResponse.json({ error: "conversationId is required" }, { status: 400 });
      }

      let conversation = await getConversationById(conversationId);
      if (!conversation) {
        return NextResponse.json({ error: "Messaging conversation not found" }, { status: 404 });
      }

      if (conversation.unread_count > 0) {
        conversation = await markConversationRead(conversation.id);
        if (conversation.zoho_conversation_id) {
          try {
            await updateZohoMessagingConversation(conversation.zoho_conversation_id, {
              unreadCount: 0,
            });
          } catch {
            // Supabase is canonical. A later reconciliation can repair CRM if needed.
          }
        }
      }

      const [messages, contact] = await Promise.all([
        getConversationMessages(conversation.id, 100),
        conversation.zoho_contact_id
          ? getZohoContactById(conversation.zoho_contact_id)
          : Promise.resolve(null),
      ]);

      return NextResponse.json({
        ok: true,
        conversation,
        contact: contactView(contact),
        messages,
      });
    }

    if (action === "searchContacts") {
      const query = cleanText(input.query) ?? "";
      if (query.length < 2) {
        return NextResponse.json({ ok: true, contacts: [] });
      }
      const contacts = await searchZohoContacts(query, 20);
      return NextResponse.json({
        ok: true,
        contacts: contacts.map((contact) => contactView(contact)),
      });
    }

    const body = cleanText(input.body);
    if (!body) {
      return NextResponse.json({ error: "body is required" }, { status: 400 });
    }

    const zohoContactId = cleanText(input.zohoContactId);
    const conversationId = cleanText(input.conversationId);
    if (!conversationId && !validContactId(zohoContactId)) {
      return NextResponse.json(
        { error: "Valid zohoContactId or conversationId is required" },
        { status: 400 },
      );
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
    if (error instanceof SmsSendError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return NextResponse.json(
      { error: "MCC messaging request failed", detail: errorMessage(error) },
      { status: 502 },
    );
  }
}
