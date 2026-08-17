import { zohoFetch } from "@/lib/zoho/client";
import type { ZohoMessageStatus } from "@/lib/twilio/status";

export type ConversationCreatedFrom =
  | "Incoming SMS"
  | "CRM Widget"
  | "Automation"
  | "Import";

export type ConversationDirection = "Incoming" | "Outgoing";

export type ZohoConversationSummary = {
  lastMessage?: string | null;
  lastMessageAt?: string | null;
  lastMessageDirection?: ConversationDirection | null;
  lastMessageStatus?: ZohoMessageStatus | null;
  unreadCount?: number;
  lastIncomingAt?: string | null;
  lastOutgoingAt?: string | null;
  optOutStatus?: "Active" | "Opted Out" | "Do Not Message";
  optOutDate?: string | null;
};

export type ZohoConversationProjection = ZohoConversationSummary & {
  contactId: string;
  channel: "SMS" | "WhatsApp";
  customerPhone: string;
  twilioPhone: string;
  conversationStatus: "Active" | "Closed" | "Archived";
  externalConversationId: string;
  createdFrom: ConversationCreatedFrom;
};

type ZohoMutationResponse = {
  data?: Array<{
    code?: string;
    details?: { id?: string };
    message?: string;
    status?: string;
  }>;
};

type ZohoSearchResponse = {
  data?: Array<{ id?: string }>;
};

function cleanObject<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, fieldValue]) => fieldValue !== undefined),
  ) as T;
}

function toZohoDateTime(value?: string | null): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid Zoho messaging datetime: ${value}`);
  }

  return `${date.toISOString().slice(0, 19)}+00:00`;
}

function summaryRecord(summary: ZohoConversationSummary) {
  return cleanObject({
    Last_Message: summary.lastMessage,
    Last_Message_At: toZohoDateTime(summary.lastMessageAt),
    Last_Message_Direction: summary.lastMessageDirection,
    Last_Message_Status: summary.lastMessageStatus,
    Unread_Count: summary.unreadCount,
    Last_Incoming_At: toZohoDateTime(summary.lastIncomingAt),
    Last_Outgoing_At: toZohoDateTime(summary.lastOutgoingAt),
    Opt_Out_Status: summary.optOutStatus,
    Opt_Out_Date: summary.optOutDate,
  });
}

function projectionRecord(projection: ZohoConversationProjection) {
  return cleanObject({
    Contact: { id: projection.contactId },
    Channel: projection.channel,
    Customer_Phone: projection.customerPhone,
    Twilio_Phone: projection.twilioPhone,
    Conversation_Status: projection.conversationStatus,
    External_Conversation_ID: projection.externalConversationId,
    Created_From: projection.createdFrom,
    ...summaryRecord(projection),
  });
}

export async function findZohoMessagingConversationByExternalId(
  externalConversationId: string,
): Promise<string | null> {
  const criteria = `(External_Conversation_ID:equals:${externalConversationId})`;
  const response = await zohoFetch<ZohoSearchResponse>(
    `/crm/v8/Messaging_Conversations/search?criteria=${encodeURIComponent(criteria)}&fields=id&per_page=2`,
  );
  const matches = response.data ?? [];
  return matches.length === 1 ? matches[0]?.id ?? null : null;
}

export async function createZohoMessagingConversation(input: {
  contactId: string;
  customerPhone: string;
  twilioPhone: string;
  externalConversationId: string;
  createdFrom: ConversationCreatedFrom;
  summary?: ZohoConversationSummary;
}): Promise<string> {
  const summary = input.summary ?? {};
  const record = cleanObject({
    Contact: { id: input.contactId },
    Channel: "SMS",
    Customer_Phone: input.customerPhone,
    Twilio_Phone: input.twilioPhone,
    Conversation_Status: "Active",
    External_Conversation_ID: input.externalConversationId,
    ...summaryRecord({
      ...summary,
      unreadCount: summary.unreadCount ?? 0,
      optOutStatus: summary.optOutStatus ?? "Active",
    }),
    Created_From: input.createdFrom,
  });

  const response = await zohoFetch<ZohoMutationResponse>(
    "/crm/v8/Messaging_Conversations",
    {
      method: "POST",
      body: JSON.stringify({ data: [record] }),
    },
  );

  const result = response.data?.[0];
  const id = result?.details?.id;
  if (!id) {
    throw new Error(
      `Zoho Messaging Conversation create failed: ${result?.message ?? "missing record id"}`,
    );
  }

  return id;
}

export async function updateZohoMessagingConversation(
  zohoConversationId: string,
  summary: ZohoConversationSummary,
): Promise<void> {
  await zohoFetch<ZohoMutationResponse>(
    `/crm/v8/Messaging_Conversations/${encodeURIComponent(zohoConversationId)}`,
    {
      method: "PUT",
      body: JSON.stringify({ data: [summaryRecord(summary)] }),
    },
  );
}

export async function updateZohoMessagingConversationProjection(
  zohoConversationId: string,
  projection: ZohoConversationProjection,
): Promise<void> {
  await zohoFetch<ZohoMutationResponse>(
    `/crm/v8/Messaging_Conversations/${encodeURIComponent(zohoConversationId)}`,
    {
      method: "PUT",
      body: JSON.stringify({ data: [projectionRecord(projection)] }),
    },
  );
}
