import { NextResponse } from "next/server";
import { hasValidWidgetKey } from "@/lib/auth/widget-key";
import {
  createBulkSmsJob,
  getBulkSmsJobStatus,
  listBulkSmsJobs,
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
  getContactThreadPage,
  getConversationById,
  getConversationMessagesPage,
} from "@/lib/messaging/repository";
import {
  cancelScheduledSms,
  createScheduledSms,
  listScheduledSms,
  updateScheduledSms,
} from "@/lib/messaging/scheduled-sms";
import { sendSms, SmsSendError } from "@/lib/messaging/send-service";
import { renderSmsTemplate } from "@/lib/messaging/template-render";
import {
  createMessagingTemplate,
  duplicateMessagingTemplate,
  listMessagingTemplates,
  setMessagingTemplateStatus,
  updateMessagingTemplate,
} from "@/lib/messaging/templates";
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
  | "historyPoll"
  | "historyOlder"
  | "send"
  | "inbox"
  | "conversation"
  | "conversationPoll"
  | "conversationOlder"
  | "searchContacts"
  | "bulkPreview"
  | "bulkCreate"
  | "bulkProcess"
  | "bulkStatus"
  | "bulkList"
  | "templateList"
  | "templateCreate"
  | "templateUpdate"
  | "templateArchive"
  | "templateRestore"
  | "templateDuplicate"
  | "scheduledList"
  | "scheduledCreate"
  | "scheduledUpdate"
  | "scheduledCancel";

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
  before?: string;
  includeContacts?: boolean;
  includeArchived?: boolean;
  templateId?: string;
  templateName?: string;
  templateBody?: string;
  templateCategory?: string;
  scheduledId?: string;
  scheduledFor?: string;
  timezone?: string;
  scheduledMode?: "upcoming" | "history" | "all";
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

function validUuid(value: string | undefined): value is string {
  return Boolean(value && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value));
}

function validJobId(value: string | undefined): value is string {
  return validUuid(value);
}

function validBefore(value: string | undefined): value is string {
  return Boolean(value && !Number.isNaN(new Date(value).getTime()));
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

async function renderWidgetMessage(
  body: string,
  zohoContactId?: string,
  conversationId?: string,
): Promise<string> {
  if (!/\{\{\s*(First_Name|Last_Name|Full_Name)\s*\}\}/.test(body)) return body;

  let contactId = validContactId(zohoContactId) ? zohoContactId : undefined;
  if (!contactId && conversationId) {
    const conversation = await getConversationById(conversationId);
    contactId = conversation?.zoho_contact_id ?? undefined;
  }
  if (!contactId) throw new Error("A Zoho Contact is required to render SMS merge fields");

  const contact = await getZohoContactById(contactId);
  if (!contact) throw new Error("Zoho Contact not found while rendering SMS merge fields");
  const rendered = renderSmsTemplate(body, contact).trim();
  if (!rendered) throw new Error("The rendered SMS message is empty");
  if (rendered.length > 1600) throw new Error("The rendered SMS message exceeds 1600 characters");
  return rendered;
}

async function loadConversationForOpen(conversationId: string) {
  let conversation = await getConversationById(conversationId);
  if (!conversation) return null;

  if (conversation.unread_count > 0) {
    conversation = await markConversationRead(conversation.id);
    if (conversation.zoho_conversation_id) {
      try {
        await updateZohoMessagingConversation(conversation.zoho_conversation_id, { unreadCount: 0 });
      } catch {
        // Supabase is canonical; CRM summary reconciliation can repair this later.
      }
    }
  }

  return conversation;
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
    "history", "historyPoll", "historyOlder", "send", "inbox",
    "conversation", "conversationPoll", "conversationOlder", "searchContacts",
    "bulkPreview", "bulkCreate", "bulkProcess", "bulkStatus", "bulkList",
    "templateList", "templateCreate", "templateUpdate", "templateArchive",
    "templateRestore", "templateDuplicate", "scheduledList", "scheduledCreate",
    "scheduledUpdate", "scheduledCancel",
  ];
  if (!action || !supported.includes(action)) {
    return NextResponse.json({ error: "Unsupported widget action" }, { status: 400 });
  }

  try {
    if (action === "templateList") {
      const templates = await listMessagingTemplates({
        includeArchived: input.includeArchived === true,
        limit: 200,
      });
      return NextResponse.json({ ok: true, templates });
    }

    if (action === "templateCreate") {
      const templateName = cleanText(input.templateName);
      const templateBody = cleanText(input.templateBody);
      if (!templateName) return NextResponse.json({ error: "Template name is required" }, { status: 400 });
      if (!templateBody) return NextResponse.json({ error: "Template message is required" }, { status: 400 });
      const template = await createMessagingTemplate({
        name: templateName,
        body: templateBody,
        category: cleanText(input.templateCategory),
        zohoUserId: cleanText(input.sentByZohoUserId),
        userName: cleanText(input.sentByName),
      });
      return NextResponse.json({ ok: true, template }, { status: 201 });
    }

    if (action === "templateUpdate") {
      const templateId = cleanText(input.templateId);
      const templateName = cleanText(input.templateName);
      const templateBody = cleanText(input.templateBody);
      if (!validUuid(templateId)) return NextResponse.json({ error: "Valid templateId is required" }, { status: 400 });
      if (!templateName) return NextResponse.json({ error: "Template name is required" }, { status: 400 });
      if (!templateBody) return NextResponse.json({ error: "Template message is required" }, { status: 400 });
      const template = await updateMessagingTemplate({
        id: templateId,
        name: templateName,
        body: templateBody,
        category: cleanText(input.templateCategory),
        zohoUserId: cleanText(input.sentByZohoUserId),
        userName: cleanText(input.sentByName),
      });
      return NextResponse.json({ ok: true, template });
    }

    if (action === "templateArchive" || action === "templateRestore") {
      const templateId = cleanText(input.templateId);
      if (!validUuid(templateId)) return NextResponse.json({ error: "Valid templateId is required" }, { status: 400 });
      const template = await setMessagingTemplateStatus({
        id: templateId,
        status: action === "templateArchive" ? "Archived" : "Active",
        zohoUserId: cleanText(input.sentByZohoUserId),
        userName: cleanText(input.sentByName),
      });
      return NextResponse.json({ ok: true, template });
    }

    if (action === "templateDuplicate") {
      const templateId = cleanText(input.templateId);
      if (!validUuid(templateId)) return NextResponse.json({ error: "Valid templateId is required" }, { status: 400 });
      const template = await duplicateMessagingTemplate({
        id: templateId,
        zohoUserId: cleanText(input.sentByZohoUserId),
        userName: cleanText(input.sentByName),
      });
      return NextResponse.json({ ok: true, template }, { status: 201 });
    }

    if (action === "scheduledList") {
      const scheduledContactId = cleanText(input.zohoContactId);
      if (scheduledContactId && !validContactId(scheduledContactId)) {
        return NextResponse.json({ error: "Valid zohoContactId is required" }, { status: 400 });
      }
      const scheduled = await listScheduledSms({
        mode: input.scheduledMode ?? "upcoming",
        limit: 150,
        zohoContactId: scheduledContactId,
      });
      return NextResponse.json({ ok: true, scheduled });
    }

    if (action === "scheduledCreate") {
      const zohoContactId = cleanText(input.zohoContactId);
      const body = cleanText(input.body);
      const scheduledFor = cleanText(input.scheduledFor);
      if (!validContactId(zohoContactId)) return NextResponse.json({ error: "Valid zohoContactId is required" }, { status: 400 });
      if (!body) return NextResponse.json({ error: "Message is required" }, { status: 400 });
      if (!scheduledFor || Number.isNaN(new Date(scheduledFor).getTime())) {
        return NextResponse.json({ error: "Valid scheduledFor is required" }, { status: 400 });
      }
      const scheduled = await createScheduledSms({
        zohoContactId,
        messageBody: body,
        scheduledFor,
        timezone: cleanText(input.timezone),
        templateId: cleanText(input.templateId),
        createdByZohoUserId: cleanText(input.sentByZohoUserId),
        createdByName: cleanText(input.sentByName),
      });
      return NextResponse.json({ ok: true, scheduled }, { status: 201 });
    }

    if (action === "scheduledUpdate") {
      const scheduledId = cleanText(input.scheduledId);
      const body = cleanText(input.body);
      const scheduledFor = cleanText(input.scheduledFor);
      if (!validUuid(scheduledId)) return NextResponse.json({ error: "Valid scheduledId is required" }, { status: 400 });
      if (!body) return NextResponse.json({ error: "Message is required" }, { status: 400 });
      if (!scheduledFor || Number.isNaN(new Date(scheduledFor).getTime())) {
        return NextResponse.json({ error: "Valid scheduledFor is required" }, { status: 400 });
      }
      const scheduled = await updateScheduledSms({
        id: scheduledId,
        messageBody: body,
        scheduledFor,
        timezone: cleanText(input.timezone),
        templateId: cleanText(input.templateId),
        updatedByZohoUserId: cleanText(input.sentByZohoUserId),
        updatedByName: cleanText(input.sentByName),
      });
      return NextResponse.json({ ok: true, scheduled });
    }

    if (action === "scheduledCancel") {
      const scheduledId = cleanText(input.scheduledId);
      if (!validUuid(scheduledId)) return NextResponse.json({ error: "Valid scheduledId is required" }, { status: 400 });
      const scheduled = await cancelScheduledSms({
        id: scheduledId,
        updatedByZohoUserId: cleanText(input.sentByZohoUserId),
        updatedByName: cleanText(input.sentByName),
      });
      return NextResponse.json({ ok: true, scheduled });
    }

    if (action === "bulkList") {
      const jobs = await listBulkSmsJobs(30);
      return NextResponse.json({ ok: true, jobs });
    }

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

    if (action === "history" || action === "historyPoll" || action === "historyOlder") {
      const zohoContactId = cleanText(input.zohoContactId);
      if (!validContactId(zohoContactId)) return NextResponse.json({ error: "Valid zohoContactId is required" }, { status: 400 });

      if (action === "historyOlder") {
        const before = cleanText(input.before);
        if (!validBefore(before)) return NextResponse.json({ error: "Valid before timestamp is required" }, { status: 400 });
        const page = await getContactThreadPage(zohoContactId, { limit: 100, before });
        return NextResponse.json({
          ok: true,
          conversations: page.conversations,
          messages: page.messages,
          has_more: page.has_more,
          next_before: page.next_before,
        });
      }

      if (action === "historyPoll") {
        const page = await getContactThreadPage(zohoContactId, { limit: 50 });
        return NextResponse.json({
          ok: true,
          conversations: page.conversations,
          messages: page.messages,
        });
      }

      const [contact, page] = await Promise.all([
        getZohoContactById(zohoContactId),
        getContactThreadPage(zohoContactId, { limit: 100 }),
      ]);
      if (!contact) return NextResponse.json({ error: "Zoho Contact not found" }, { status: 404 });
      return NextResponse.json({
        ok: true,
        contact: contactView(contact),
        conversations: page.conversations,
        messages: page.messages,
        has_more: page.has_more,
        next_before: page.next_before,
      });
    }

    if (action === "inbox") {
      const mode: MessagingInboxMode = input.mode === "unread" ? "unread" : "recent";
      const includeContacts = input.includeContacts !== false;
      const [conversations, unreadCount] = await Promise.all([
        listInboxConversations({ mode, limit: 75 }),
        countUnreadConversations(),
      ]);

      let contactMap = new Map<string, ZohoContact>();
      if (includeContacts) {
        const contactIds = conversations.map((conversation) => conversation.zoho_contact_id).filter((id): id is string => Boolean(id));
        const contacts = await getZohoContactsByIds(contactIds);
        contactMap = new Map(contacts.map((contact) => [contact.id, contact]));
      }

      return NextResponse.json({
        ok: true,
        mode,
        include_contacts: includeContacts,
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
          contact: includeContacts && conversation.zoho_contact_id ? contactView(contactMap.get(conversation.zoho_contact_id)) : null,
        })),
      });
    }

    if (action === "conversation" || action === "conversationPoll" || action === "conversationOlder") {
      const conversationId = cleanText(input.conversationId);
      if (!conversationId) return NextResponse.json({ error: "conversationId is required" }, { status: 400 });

      if (action === "conversationOlder") {
        const before = cleanText(input.before);
        if (!validBefore(before)) return NextResponse.json({ error: "Valid before timestamp is required" }, { status: 400 });
        const existing = await getConversationById(conversationId);
        if (!existing) return NextResponse.json({ error: "Messaging conversation not found" }, { status: 404 });
        const page = await getConversationMessagesPage(conversationId, { limit: 100, before });
        return NextResponse.json({
          ok: true,
          conversation: existing,
          messages: page.messages,
          has_more: page.has_more,
          next_before: page.next_before,
        });
      }

      const conversation = await loadConversationForOpen(conversationId);
      if (!conversation) return NextResponse.json({ error: "Messaging conversation not found" }, { status: 404 });
      const page = await getConversationMessagesPage(conversation.id, {
        limit: action === "conversationPoll" ? 50 : 100,
      });

      if (action === "conversationPoll") {
        return NextResponse.json({ ok: true, conversation, messages: page.messages });
      }

      const contact = conversation.zoho_contact_id
        ? await getZohoContactById(conversation.zoho_contact_id)
        : null;
      return NextResponse.json({
        ok: true,
        conversation,
        contact: contactView(contact),
        messages: page.messages,
        has_more: page.has_more,
        next_before: page.next_before,
      });
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

    const renderedBody = await renderWidgetMessage(body, zohoContactId, conversationId);
    const result = await sendSms({
      zohoContactId,
      conversationId,
      body: renderedBody,
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
