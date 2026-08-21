import { requiredEnv } from "@/lib/env";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { tryNormalizePhone } from "@/lib/phone/normalize";
import { getZohoContactById, getZohoContactsByIds, type ZohoContact } from "@/lib/zoho/contacts";
import { getMessagingTemplate } from "@/lib/messaging/templates";
import { renderSmsTemplate, zohoContactDisplayName } from "@/lib/messaging/template-render";
import { sendSms } from "@/lib/messaging/send-service";

export type ScheduledSmsStatus = "Scheduled" | "Processing" | "Sent" | "Failed" | "Canceled";

export type ScheduledSmsRow = {
  id: string;
  zoho_contact_id: string;
  conversation_id: string | null;
  template_id: string | null;
  template_name_snapshot: string | null;
  message_body: string;
  phone_at_scheduling: string | null;
  phone_sent_to: string | null;
  scheduled_for: string;
  timezone: string;
  status: ScheduledSmsStatus;
  created_by_zoho_user_id: string | null;
  created_by_name: string | null;
  updated_by_zoho_user_id: string | null;
  updated_by_name: string | null;
  twilio_message_sid: string | null;
  sent_conversation_id: string | null;
  attempt_count: number;
  processing_started_at: string | null;
  sent_at: string | null;
  canceled_at: string | null;
  error_code: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
};

export type ScheduledSmsView = ScheduledSmsRow & {
  contact: {
    id: string;
    name: string;
    phone: string | null;
  } | null;
  delivery_status: string | null;
};

function cleanTimezone(value?: string | null): string {
  const timezone = value?.trim() || "UTC";
  if (timezone.length > 100) throw new Error("Timezone is invalid");
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(new Date());
  } catch {
    throw new Error("Timezone is invalid");
  }
  return timezone;
}

function cleanScheduledFor(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error("Scheduled date/time is invalid");
  if (date.getTime() < Date.now() + 15_000) {
    throw new Error("Scheduled time must be in the future");
  }
  return date.toISOString();
}

function cleanBody(value: string): string {
  const body = value.trim();
  if (!body) throw new Error("Message is required");
  if (body.length > 1600) throw new Error("SMS message must be 1600 characters or fewer");
  return body;
}

function scheduledContactView(contact: ZohoContact | undefined) {
  if (!contact) return null;
  return {
    id: contact.id,
    name: zohoContactDisplayName(contact),
    phone: contact.Phone?.trim() || null,
  };
}

async function assertSchedulableContact(zohoContactId: string): Promise<{
  contact: ZohoContact;
  phone: string;
  twilioPhone: string;
}> {
  const contact = await getZohoContactById(zohoContactId);
  if (!contact) throw new Error("Zoho Contact not found");
  if (!contact.Phone?.trim()) throw new Error("Zoho Contact has no Phone value");

  const phone = tryNormalizePhone(contact.Phone);
  if (!phone) throw new Error("Zoho Contact Phone is invalid");

  const twilioPhone = tryNormalizePhone(requiredEnv("TWILIO_PHONE_NUMBER"));
  if (!twilioPhone) throw new Error("MCC Twilio sender number is invalid");
  if (phone === twilioPhone) throw new Error("Sending to the MCC Twilio sender number is blocked");

  const { data: blocked, error } = await getSupabaseAdmin()
    .from("messaging_conversations")
    .select("opt_out_status")
    .eq("customer_phone", phone)
    .eq("twilio_phone", twilioPhone)
    .neq("opt_out_status", "Active")
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`Check SMS opt-out status failed: ${error.message}`);
  if (blocked?.opt_out_status) {
    throw new Error(`Messaging blocked by opt-out status: ${blocked.opt_out_status}`);
  }

  return { contact, phone, twilioPhone };
}

async function templateSnapshot(templateId?: string | null): Promise<{ id: string | null; name: string | null }> {
  const id = templateId?.trim() || null;
  if (!id) return { id: null, name: null };
  const template = await getMessagingTemplate(id);
  if (!template) throw new Error("SMS template not found");
  return { id: template.id, name: template.name };
}

export async function createScheduledSms(input: {
  zohoContactId: string;
  messageBody: string;
  scheduledFor: string;
  timezone?: string | null;
  templateId?: string | null;
  createdByZohoUserId?: string | null;
  createdByName?: string | null;
}): Promise<ScheduledSmsRow> {
  const zohoContactId = input.zohoContactId.trim();
  if (!/^\d{10,25}$/.test(zohoContactId)) throw new Error("Valid Zoho Contact ID is required");

  const [{ contact, phone }, template] = await Promise.all([
    assertSchedulableContact(zohoContactId),
    templateSnapshot(input.templateId),
  ]);
  const rendered = cleanBody(renderSmsTemplate(cleanBody(input.messageBody), contact));
  const scheduledFor = cleanScheduledFor(input.scheduledFor);
  const timezone = cleanTimezone(input.timezone);
  const now = new Date().toISOString();

  const { data, error } = await getSupabaseAdmin()
    .from("scheduled_sms")
    .insert({
      zoho_contact_id: zohoContactId,
      template_id: template.id,
      template_name_snapshot: template.name,
      message_body: rendered,
      phone_at_scheduling: phone,
      scheduled_for: scheduledFor,
      timezone,
      status: "Scheduled",
      created_by_zoho_user_id: input.createdByZohoUserId?.trim() || null,
      created_by_name: input.createdByName?.trim() || null,
      updated_by_zoho_user_id: input.createdByZohoUserId?.trim() || null,
      updated_by_name: input.createdByName?.trim() || null,
      created_at: now,
      updated_at: now,
    })
    .select("*")
    .single();

  if (error || !data) throw new Error(`Schedule SMS failed: ${error?.message ?? "unknown error"}`);
  return data as ScheduledSmsRow;
}

export async function updateScheduledSms(input: {
  id: string;
  messageBody: string;
  scheduledFor: string;
  timezone?: string | null;
  templateId?: string | null;
  updatedByZohoUserId?: string | null;
  updatedByName?: string | null;
}): Promise<ScheduledSmsRow> {
  const { data: existing, error: loadError } = await getSupabaseAdmin()
    .from("scheduled_sms")
    .select("*")
    .eq("id", input.id)
    .single();
  if (loadError || !existing) throw new Error("Scheduled SMS not found");
  if (existing.status !== "Scheduled") throw new Error("Only pending scheduled SMS can be edited");

  const [{ contact, phone }, template] = await Promise.all([
    assertSchedulableContact(existing.zoho_contact_id),
    templateSnapshot(input.templateId),
  ]);
  const rendered = cleanBody(renderSmsTemplate(cleanBody(input.messageBody), contact));

  const { data, error } = await getSupabaseAdmin()
    .from("scheduled_sms")
    .update({
      template_id: template.id,
      template_name_snapshot: template.name,
      message_body: rendered,
      phone_at_scheduling: phone,
      scheduled_for: cleanScheduledFor(input.scheduledFor),
      timezone: cleanTimezone(input.timezone),
      updated_by_zoho_user_id: input.updatedByZohoUserId?.trim() || null,
      updated_by_name: input.updatedByName?.trim() || null,
      updated_at: new Date().toISOString(),
      error_code: null,
      error_message: null,
    })
    .eq("id", input.id)
    .eq("status", "Scheduled")
    .select("*")
    .single();

  if (error || !data) throw new Error(`Update scheduled SMS failed: ${error?.message ?? "unknown error"}`);
  return data as ScheduledSmsRow;
}

export async function cancelScheduledSms(input: {
  id: string;
  updatedByZohoUserId?: string | null;
  updatedByName?: string | null;
}): Promise<ScheduledSmsRow> {
  const now = new Date().toISOString();
  const { data, error } = await getSupabaseAdmin()
    .from("scheduled_sms")
    .update({
      status: "Canceled",
      canceled_at: now,
      updated_at: now,
      updated_by_zoho_user_id: input.updatedByZohoUserId?.trim() || null,
      updated_by_name: input.updatedByName?.trim() || null,
    })
    .eq("id", input.id)
    .eq("status", "Scheduled")
    .select("*")
    .maybeSingle();

  if (error) throw new Error(`Cancel scheduled SMS failed: ${error.message}`);
  if (!data) throw new Error("Scheduled SMS can no longer be canceled because processing has started");
  return data as ScheduledSmsRow;
}

export async function listScheduledSms(input: {
  mode?: "upcoming" | "history" | "all";
  limit?: number;
} = {}): Promise<ScheduledSmsView[]> {
  const mode = input.mode ?? "upcoming";
  const limit = Math.max(1, Math.min(200, input.limit ?? 100));
  let query = getSupabaseAdmin()
    .from("scheduled_sms")
    .select("*")
    .order("scheduled_for", { ascending: mode !== "history" })
    .limit(limit);

  if (mode === "upcoming") query = query.in("status", ["Scheduled", "Processing"]);
  if (mode === "history") query = query.in("status", ["Sent", "Failed", "Canceled"]);

  const { data, error } = await query;
  if (error) throw new Error(`Load scheduled SMS failed: ${error.message}`);
  const rows = (data ?? []) as ScheduledSmsRow[];
  if (rows.length === 0) return [];

  const contactIds = [...new Set(rows.map((row) => row.zoho_contact_id))];
  let contacts: ZohoContact[] = [];
  try {
    contacts = await getZohoContactsByIds(contactIds);
  } catch {
    // Scheduled history remains usable even if Zoho contact enrichment is temporarily unavailable.
  }
  const contactMap = new Map(contacts.map((contact) => [contact.id, contact]));

  const sids = rows.map((row) => row.twilio_message_sid).filter((sid): sid is string => Boolean(sid));
  const deliveryMap = new Map<string, string>();
  if (sids.length > 0) {
    const { data: messages } = await getSupabaseAdmin()
      .from("messaging_messages")
      .select("twilio_message_sid,status")
      .in("twilio_message_sid", sids);
    for (const message of messages ?? []) {
      if (message.twilio_message_sid) deliveryMap.set(message.twilio_message_sid, message.status);
    }
  }

  return rows.map((row) => ({
    ...row,
    contact: scheduledContactView(contactMap.get(row.zoho_contact_id)),
    delivery_status: row.twilio_message_sid ? deliveryMap.get(row.twilio_message_sid) ?? null : null,
  }));
}

export async function processDueScheduledSms(limit = 10): Promise<{
  claimed: number;
  sent: number;
  failed: number;
}> {
  const { data, error } = await getSupabaseAdmin().rpc("claim_due_scheduled_sms", {
    p_limit: Math.max(1, Math.min(25, limit)),
  });
  if (error) throw new Error(`Claim due scheduled SMS failed: ${error.message}`);
  const rows = (data ?? []) as ScheduledSmsRow[];
  if (rows.length === 0) return { claimed: 0, sent: 0, failed: 0 };

  let sent = 0;
  let failed = 0;

  for (let index = 0; index < rows.length; index += 5) {
    const chunk = rows.slice(index, index + 5);
    await Promise.all(
      chunk.map(async (row) => {
        try {
          const contact = await getZohoContactById(row.zoho_contact_id);
          const currentPhone = tryNormalizePhone(contact?.Phone) ?? null;
          const result = await sendSms({
            zohoContactId: row.zoho_contact_id,
            body: row.message_body,
            source: "Automation",
            sentByZohoUserId: row.created_by_zoho_user_id,
            sentByName: row.created_by_name,
            idempotencyKey: `scheduled:${row.id}`,
          });

          const now = new Date().toISOString();
          const { error: updateError } = await getSupabaseAdmin()
            .from("scheduled_sms")
            .update({
              status: "Sent",
              phone_sent_to: currentPhone,
              twilio_message_sid: result.messageSid,
              sent_conversation_id: result.conversationId,
              conversation_id: result.conversationId,
              sent_at: now,
              processing_started_at: null,
              error_code: null,
              error_message: null,
              updated_at: now,
            })
            .eq("id", row.id);
          if (updateError) throw new Error(`Record scheduled SMS result failed: ${updateError.message}`);
          sent += 1;
        } catch (sendError) {
          const now = new Date().toISOString();
          const errorMessage = sendError instanceof Error ? sendError.message.slice(0, 500) : "Unknown scheduled send error";
          await getSupabaseAdmin()
            .from("scheduled_sms")
            .update({
              status: "Failed",
              processing_started_at: null,
              error_message: errorMessage,
              updated_at: now,
            })
            .eq("id", row.id);
          failed += 1;
        }
      }),
    );
  }

  return { claimed: rows.length, sent, failed };
}
