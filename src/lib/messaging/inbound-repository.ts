import { getSupabaseAdmin } from "@/lib/supabase/admin";
import {
  findConversation,
  findOrCreateConversation,
  getMessageBySid,
  type MessagingConversation,
  type MessagingMessage,
} from "@/lib/messaging/repository";

export type InboundMedia = {
  url: string;
  contentType: string | null;
};

function throwIfError(error: { message?: string } | null, context: string): void {
  if (error) throw new Error(`${context}: ${error.message ?? "database error"}`);
}

export async function findUnmatchedConversation(input: {
  customerPhone: string;
  twilioPhone: string;
}): Promise<MessagingConversation | null> {
  const { data, error } = await getSupabaseAdmin()
    .from("messaging_conversations")
    .select("*")
    .is("zoho_contact_id", null)
    .eq("customer_phone", input.customerPhone)
    .eq("twilio_phone", input.twilioPhone)
    .eq("channel", "SMS")
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();

  throwIfError(error, "Find unmatched messaging conversation failed");
  return (data as MessagingConversation | null) ?? null;
}

export async function findUniqueAssociatedConversationByPhone(input: {
  customerPhone: string;
  twilioPhone: string;
}): Promise<MessagingConversation | null> {
  const { data, error } = await getSupabaseAdmin()
    .from("messaging_conversations")
    .select("*")
    .not("zoho_contact_id", "is", null)
    .eq("customer_phone", input.customerPhone)
    .eq("twilio_phone", input.twilioPhone)
    .eq("channel", "SMS")
    .order("updated_at", { ascending: false })
    .limit(2);

  throwIfError(error, "Find associated messaging conversation by phone failed");
  const matches = (data ?? []) as MessagingConversation[];

  // Phone numbers are not guaranteed to be unique across Contacts. Only infer
  // identity from the existing thread when exactly one associated conversation
  // exists for this customer/sender pair. Otherwise let Zoho search disambiguate.
  return matches.length === 1 ? matches[0] : null;
}

async function createUnmatchedConversation(input: {
  customerPhone: string;
  twilioPhone: string;
}): Promise<MessagingConversation> {
  // Application-level find-before-create prevents normal duplicates. A partial
  // unique index for NULL zoho_contact_id can be added later as DB hardening.
  const existing = await findUnmatchedConversation(input);
  if (existing) return existing;

  const { data, error } = await getSupabaseAdmin()
    .from("messaging_conversations")
    .insert({
      zoho_contact_id: null,
      customer_phone: input.customerPhone,
      twilio_phone: input.twilioPhone,
      channel: "SMS",
      status: "Active",
      opt_out_status: "Active",
      unread_count: 0,
      created_from: "Incoming SMS",
    })
    .select("*")
    .single();

  throwIfError(error, "Create unmatched messaging conversation failed");
  return data as MessagingConversation;
}

async function claimUnmatchedConversation(input: {
  conversation: MessagingConversation;
  zohoContactId: string;
  customerPhone: string;
  twilioPhone: string;
}): Promise<MessagingConversation> {
  const exact = await findConversation({
    zohoContactId: input.zohoContactId,
    customerPhone: input.customerPhone,
    twilioPhone: input.twilioPhone,
  });
  if (exact) return exact;

  const { data, error } = await getSupabaseAdmin()
    .from("messaging_conversations")
    .update({ zoho_contact_id: input.zohoContactId })
    .eq("id", input.conversation.id)
    .is("zoho_contact_id", null)
    .select("*")
    .maybeSingle();

  if (error && "code" in error && error.code === "23505") {
    const concurrent = await findConversation({
      zohoContactId: input.zohoContactId,
      customerPhone: input.customerPhone,
      twilioPhone: input.twilioPhone,
    });
    if (concurrent) return concurrent;
  }

  throwIfError(error, "Attach Zoho Contact to inbound conversation failed");
  if (data) return data as MessagingConversation;

  return (
    (await findConversation({
      zohoContactId: input.zohoContactId,
      customerPhone: input.customerPhone,
      twilioPhone: input.twilioPhone,
    })) ?? input.conversation
  );
}

export async function resolveInboundConversation(input: {
  zohoContactId: string | null;
  customerPhone: string;
  twilioPhone: string;
}): Promise<MessagingConversation> {
  if (input.zohoContactId) {
    const exact = await findConversation({
      zohoContactId: input.zohoContactId,
      customerPhone: input.customerPhone,
      twilioPhone: input.twilioPhone,
    });
    if (exact) return exact;

    const unmatched = await findUnmatchedConversation(input);
    if (unmatched) {
      return claimUnmatchedConversation({
        conversation: unmatched,
        zohoContactId: input.zohoContactId,
        customerPhone: input.customerPhone,
        twilioPhone: input.twilioPhone,
      });
    }

    return findOrCreateConversation({
      zohoContactId: input.zohoContactId,
      customerPhone: input.customerPhone,
      twilioPhone: input.twilioPhone,
      createdFrom: "Incoming SMS",
    });
  }

  const existingAssociated = await findUniqueAssociatedConversationByPhone(input);
  if (existingAssociated) return existingAssociated;

  return createUnmatchedConversation(input);
}

export async function insertIncomingMessage(input: {
  conversationId: string;
  twilioMessageSid: string;
  body: string;
  fromPhone: string;
  toPhone: string;
  media: InboundMedia[];
}): Promise<{ message: MessagingMessage; inserted: boolean }> {
  const existing = await getMessageBySid(input.twilioMessageSid);
  if (existing) return { message: existing, inserted: false };

  const { data, error } = await getSupabaseAdmin()
    .from("messaging_messages")
    .insert({
      conversation_id: input.conversationId,
      twilio_message_sid: input.twilioMessageSid,
      direction: "Incoming",
      body: input.body || null,
      status: "received",
      from_phone: input.fromPhone,
      to_phone: input.toPhone,
      num_media: input.media.length,
      media: input.media,
      sent_by_zoho_user_id: null,
      sent_by_name: null,
      source: "Incoming SMS",
      twilio_date_created: null,
      twilio_date_sent: null,
    })
    .select("*")
    .single();

  if (error && "code" in error && error.code === "23505") {
    const duplicate = await getMessageBySid(input.twilioMessageSid);
    if (duplicate) return { message: duplicate, inserted: false };
  }

  throwIfError(error, "Persist incoming SMS failed");
  return { message: data as MessagingMessage, inserted: true };
}

function unreadValue(data: unknown): number | null {
  if (typeof data === "number") return data;
  if (Array.isArray(data) && typeof data[0] === "number") return data[0];
  return null;
}

export async function updateIncomingSummary(input: {
  conversationId: string;
  body: string;
  occurredAt: string;
}): Promise<MessagingConversation> {
  const { data: unreadData, error: unreadError } = await getSupabaseAdmin().rpc(
    "increment_messaging_unread",
    { p_conversation_id: input.conversationId },
  );
  throwIfError(unreadError, "Increment inbound unread count failed");

  const summary = input.body || "[Incoming MMS]";
  const { data, error } = await getSupabaseAdmin()
    .from("messaging_conversations")
    .update({
      last_message: summary,
      last_message_at: input.occurredAt,
      last_message_direction: "Incoming",
      last_message_status: "received",
      last_incoming_at: input.occurredAt,
      ...(unreadValue(unreadData) === null
        ? {}
        : { unread_count: unreadValue(unreadData) }),
    })
    .eq("id", input.conversationId)
    .select("*")
    .single();

  throwIfError(error, "Update incoming conversation summary failed");
  return data as MessagingConversation;
}

export async function setConversationOptOut(input: {
  conversationId: string;
  optedOut: boolean;
  occurredAt: string;
}): Promise<MessagingConversation> {
  const { data, error } = await getSupabaseAdmin()
    .from("messaging_conversations")
    .update({
      opt_out_status: input.optedOut ? "Opted Out" : "Active",
      opt_out_at: input.optedOut ? input.occurredAt : null,
    })
    .eq("id", input.conversationId)
    .select("*")
    .single();

  throwIfError(error, "Update messaging opt-out state failed");
  return data as MessagingConversation;
}
