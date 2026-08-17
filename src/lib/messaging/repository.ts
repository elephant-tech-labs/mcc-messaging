import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { shouldApplyTwilioStatus } from "@/lib/twilio/status";

export type MessagingConversation = {
  id: string;
  zoho_conversation_id: string | null;
  zoho_contact_id: string | null;
  customer_phone: string;
  twilio_phone: string;
  channel: string;
  status: string;
  last_message: string | null;
  last_message_at: string | null;
  last_message_direction: string | null;
  last_message_status: string | null;
  unread_count: number;
  last_incoming_at: string | null;
  last_outgoing_at: string | null;
  opt_out_status: string;
  opt_out_at: string | null;
  created_from: string | null;
  crm_sync_needed: boolean;
  crm_projection_version: number;
  crm_synced_version: number;
  crm_last_synced_at: string | null;
  crm_last_sync_attempt_at: string | null;
  crm_sync_error: string | null;
  created_at: string;
  updated_at: string;
};

export type MessagingMessage = {
  id: string;
  conversation_id: string;
  twilio_message_sid: string;
  direction: string;
  body: string | null;
  status: string;
  from_phone: string;
  to_phone: string;
  num_media: number;
  media: unknown;
  sent_by_zoho_user_id: string | null;
  sent_by_name: string | null;
  source: string | null;
  twilio_date_created: string | null;
  twilio_date_sent: string | null;
  delivered_at: string | null;
  error_code: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
};

export type MessagePage = {
  messages: MessagingMessage[];
  has_more: boolean;
  next_before: string | null;
};

function throwIfError(error: { message?: string } | null, context: string): void {
  if (error) throw new Error(`${context}: ${error.message ?? "database error"}`);
}

function safeMessageLimit(limit: number): number {
  return Math.max(1, Math.min(200, limit));
}

function toMessagePage(rows: MessagingMessage[], limit: number): MessagePage {
  const hasMore = rows.length > limit;
  const selected = rows.slice(0, limit);
  const oldest = selected[selected.length - 1] ?? null;
  return {
    messages: selected.reverse(),
    has_more: hasMore,
    next_before: hasMore && oldest ? oldest.created_at : null,
  };
}

export async function getConversationById(
  conversationId: string,
): Promise<MessagingConversation | null> {
  const { data, error } = await getSupabaseAdmin()
    .from("messaging_conversations")
    .select("*")
    .eq("id", conversationId)
    .maybeSingle();

  throwIfError(error, "Load messaging conversation failed");
  return (data as MessagingConversation | null) ?? null;
}

export async function findConversation(input: {
  zohoContactId: string;
  customerPhone: string;
  twilioPhone: string;
  channel?: "SMS";
}): Promise<MessagingConversation | null> {
  const { data, error } = await getSupabaseAdmin()
    .from("messaging_conversations")
    .select("*")
    .eq("zoho_contact_id", input.zohoContactId)
    .eq("customer_phone", input.customerPhone)
    .eq("twilio_phone", input.twilioPhone)
    .eq("channel", input.channel ?? "SMS")
    .maybeSingle();

  throwIfError(error, "Find messaging conversation failed");
  return (data as MessagingConversation | null) ?? null;
}

export async function createConversation(input: {
  zohoContactId: string;
  customerPhone: string;
  twilioPhone: string;
  createdFrom: "CRM Widget" | "Automation" | "Incoming SMS" | "Import";
}): Promise<MessagingConversation> {
  const payload = {
    zoho_contact_id: input.zohoContactId,
    customer_phone: input.customerPhone,
    twilio_phone: input.twilioPhone,
    channel: "SMS",
    status: "Active",
    opt_out_status: "Active",
    unread_count: 0,
    created_from: input.createdFrom,
  };

  const { data, error } = await getSupabaseAdmin()
    .from("messaging_conversations")
    .insert(payload)
    .select("*")
    .single();

  if (error && "code" in error && error.code === "23505") {
    const existing = await findConversation({
      zohoContactId: input.zohoContactId,
      customerPhone: input.customerPhone,
      twilioPhone: input.twilioPhone,
    });
    if (existing) return existing;
  }

  throwIfError(error, "Create messaging conversation failed");
  return data as MessagingConversation;
}

export async function findOrCreateConversation(input: {
  zohoContactId: string;
  customerPhone: string;
  twilioPhone: string;
  createdFrom: "CRM Widget" | "Automation" | "Incoming SMS" | "Import";
}): Promise<MessagingConversation> {
  return (await findConversation(input)) ?? createConversation(input);
}

export async function attachZohoConversationId(
  conversationId: string,
  zohoConversationId: string,
): Promise<MessagingConversation> {
  const { data, error } = await getSupabaseAdmin()
    .from("messaging_conversations")
    .update({ zoho_conversation_id: zohoConversationId })
    .eq("id", conversationId)
    .select("*")
    .single();

  throwIfError(error, "Attach Zoho conversation id failed");
  return data as MessagingConversation;
}

export async function insertOutgoingMessage(input: {
  conversationId: string;
  twilioMessageSid: string;
  body: string;
  status: string;
  fromPhone: string;
  toPhone: string;
  sentByZohoUserId?: string | null;
  sentByName?: string | null;
  source: "CRM Widget" | "Cliq" | "Bulk SMS" | "Automation";
  twilioDateCreated?: Date | null;
  twilioDateSent?: Date | null;
}): Promise<MessagingMessage> {
  const { data, error } = await getSupabaseAdmin()
    .from("messaging_messages")
    .insert({
      conversation_id: input.conversationId,
      twilio_message_sid: input.twilioMessageSid,
      direction: "Outgoing",
      body: input.body,
      status: input.status,
      from_phone: input.fromPhone,
      to_phone: input.toPhone,
      num_media: 0,
      media: [],
      sent_by_zoho_user_id: input.sentByZohoUserId ?? null,
      sent_by_name: input.sentByName ?? null,
      source: input.source,
      twilio_date_created: input.twilioDateCreated?.toISOString() ?? null,
      twilio_date_sent: input.twilioDateSent?.toISOString() ?? null,
    })
    .select("*")
    .single();

  throwIfError(error, "Persist outgoing SMS failed");
  return data as MessagingMessage;
}

export async function updateOutgoingSummary(input: {
  conversationId: string;
  body: string;
  status: string;
  occurredAt: string;
}): Promise<MessagingConversation> {
  const { data, error } = await getSupabaseAdmin()
    .from("messaging_conversations")
    .update({
      last_message: input.body,
      last_message_at: input.occurredAt,
      last_message_direction: "Outgoing",
      last_message_status: input.status,
      last_outgoing_at: input.occurredAt,
      unread_count: 0,
    })
    .eq("id", input.conversationId)
    .select("*")
    .single();

  throwIfError(error, "Update outgoing conversation summary failed");
  return data as MessagingConversation;
}

export async function getMessageBySid(
  twilioMessageSid: string,
): Promise<MessagingMessage | null> {
  const { data, error } = await getSupabaseAdmin()
    .from("messaging_messages")
    .select("*")
    .eq("twilio_message_sid", twilioMessageSid)
    .maybeSingle();

  throwIfError(error, "Find message by Twilio SID failed");
  return (data as MessagingMessage | null) ?? null;
}

export async function applyMessageStatus(input: {
  twilioMessageSid: string;
  nextStatus: string;
  errorCode?: string | null;
  errorMessage?: string | null;
}): Promise<{
  applied: boolean;
  message: MessagingMessage | null;
  conversation: MessagingConversation | null;
  isLatestOutgoing: boolean;
}> {
  const existing = await getMessageBySid(input.twilioMessageSid);
  if (!existing) {
    return { applied: false, message: null, conversation: null, isLatestOutgoing: false };
  }

  if (!shouldApplyTwilioStatus(existing.status, input.nextStatus)) {
    return {
      applied: false,
      message: existing,
      conversation: null,
      isLatestOutgoing: false,
    };
  }

  const delivered = ["delivered", "read"].includes(input.nextStatus.toLowerCase());
  const { data: updated, error: updateError } = await getSupabaseAdmin()
    .from("messaging_messages")
    .update({
      status: input.nextStatus,
      delivered_at: delivered ? new Date().toISOString() : existing.delivered_at,
      error_code: input.errorCode ?? existing.error_code,
      error_message: input.errorMessage ?? existing.error_message,
    })
    .eq("id", existing.id)
    .select("*")
    .single();

  throwIfError(updateError, "Update SMS delivery status failed");

  const { data: latest, error: latestError } = await getSupabaseAdmin()
    .from("messaging_messages")
    .select("twilio_message_sid")
    .eq("conversation_id", existing.conversation_id)
    .eq("direction", "Outgoing")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  throwIfError(latestError, "Find latest outgoing SMS failed");

  const isLatestOutgoing = latest?.twilio_message_sid === input.twilioMessageSid;
  let conversation: MessagingConversation | null = null;

  if (isLatestOutgoing) {
    const { data: updatedConversation, error: summaryError } = await getSupabaseAdmin()
      .from("messaging_conversations")
      .update({ last_message_status: input.nextStatus })
      .eq("id", existing.conversation_id)
      .select("*")
      .single();
    throwIfError(summaryError, "Update conversation delivery status failed");
    conversation = updatedConversation as MessagingConversation;
  } else {
    conversation = await getConversationById(existing.conversation_id);
  }

  return {
    applied: true,
    message: updated as MessagingMessage,
    conversation,
    isLatestOutgoing,
  };
}

export async function getConversationMessagesPage(
  conversationId: string,
  options: { limit?: number; before?: string | null } = {},
): Promise<MessagePage> {
  const limit = safeMessageLimit(options.limit ?? 100);
  let query = getSupabaseAdmin()
    .from("messaging_messages")
    .select("*")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: false })
    .limit(limit + 1);

  if (options.before) query = query.lt("created_at", options.before);

  const { data, error } = await query;
  throwIfError(error, "Load messaging conversation messages failed");
  return toMessagePage((data ?? []) as MessagingMessage[], limit);
}

export async function getConversationMessages(
  conversationId: string,
  limit = 100,
): Promise<MessagingMessage[]> {
  return (await getConversationMessagesPage(conversationId, { limit })).messages;
}

export async function getContactThreadPage(
  zohoContactId: string,
  options: { limit?: number; before?: string | null } = {},
): Promise<{
  conversations: MessagingConversation[];
  messages: MessagingMessage[];
  has_more: boolean;
  next_before: string | null;
}> {
  const { data: conversations, error: conversationError } = await getSupabaseAdmin()
    .from("messaging_conversations")
    .select("*")
    .eq("zoho_contact_id", zohoContactId)
    .order("last_message_at", { ascending: false, nullsFirst: false });
  throwIfError(conversationError, "Load contact conversations failed");

  const typedConversations = (conversations ?? []) as MessagingConversation[];
  const ids = typedConversations.map((conversation) => conversation.id);
  if (ids.length === 0) {
    return { conversations: [], messages: [], has_more: false, next_before: null };
  }

  const limit = safeMessageLimit(options.limit ?? 100);
  let messageQuery = getSupabaseAdmin()
    .from("messaging_messages")
    .select("*")
    .in("conversation_id", ids)
    .order("created_at", { ascending: false })
    .limit(limit + 1);

  if (options.before) messageQuery = messageQuery.lt("created_at", options.before);

  const { data: messages, error: messageError } = await messageQuery;
  throwIfError(messageError, "Load contact SMS history failed");
  const page = toMessagePage((messages ?? []) as MessagingMessage[], limit);

  return {
    conversations: typedConversations,
    messages: page.messages,
    has_more: page.has_more,
    next_before: page.next_before,
  };
}

export async function getContactThread(zohoContactId: string): Promise<{
  conversations: MessagingConversation[];
  messages: MessagingMessage[];
}> {
  const page = await getContactThreadPage(zohoContactId, { limit: 200 });
  return { conversations: page.conversations, messages: page.messages };
}
