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

function throwIfError(error: { message?: string } | null, context: string): void {
  if (error) throw new Error(`${context}: ${error.message ?? "database error"}`);
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
  return (
    (await findConversation(input)) ??
    createConversation(input)
  );
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
  source: "CRM Widget" | "Automation";
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

  const { data: conversation, error: conversationError } = await getSupabaseAdmin()
    .from("messaging_conversations")
    .select("*")
    .eq("id", existing.conversation_id)
    .single();
  throwIfError(conversationError, "Load conversation for status sync failed");

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

  if (isLatestOutgoing) {
    const { error: summaryError } = await getSupabaseAdmin()
      .from("messaging_conversations")
      .update({ last_message_status: input.nextStatus })
      .eq("id", existing.conversation_id);
    throwIfError(summaryError, "Update conversation delivery status failed");
  }

  return {
    applied: true,
    message: updated as MessagingMessage,
    conversation: conversation as MessagingConversation,
    isLatestOutgoing,
  };
}

export async function getContactThread(zohoContactId: string): Promise<{
  conversations: MessagingConversation[];
  messages: MessagingMessage[];
}> {
  const { data: conversations, error: conversationError } = await getSupabaseAdmin()
    .from("messaging_conversations")
    .select("*")
    .eq("zoho_contact_id", zohoContactId)
    .order("last_message_at", { ascending: false, nullsFirst: false });
  throwIfError(conversationError, "Load contact conversations failed");

  const typedConversations = (conversations ?? []) as MessagingConversation[];
  const ids = typedConversations.map((conversation) => conversation.id);
  if (ids.length === 0) return { conversations: [], messages: [] };

  const { data: messages, error: messageError } = await getSupabaseAdmin()
    .from("messaging_messages")
    .select("*")
    .in("conversation_id", ids)
    .order("created_at", { ascending: true });
  throwIfError(messageError, "Load contact SMS history failed");

  return {
    conversations: typedConversations,
    messages: (messages ?? []) as MessagingMessage[],
  };
}
