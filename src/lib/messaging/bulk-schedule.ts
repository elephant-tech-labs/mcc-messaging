import { previewBulkSmsRecipients } from "@/lib/messaging/bulk-sms";
import { renderSmsTemplate } from "@/lib/messaging/template-render";
import { getMessagingTemplate } from "@/lib/messaging/templates";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { getZohoContactsByIds } from "@/lib/zoho/contacts";

// Bulk scheduling intentionally fans out into the existing scheduled_sms queue so
// Contact and Bulk scheduling share one worker, idempotency path, and send-time safety checks.
function cleanIds(ids: string[]): string[] {
  return [...new Set(ids.map((id) => id.trim()).filter((id) => /^\d{10,25}$/.test(id)))].slice(0, 2000);
}

function cleanBody(value: string): string {
  const body = value.trim();
  if (!body) throw new Error("Message is required");
  if (body.length > 1600) throw new Error("SMS template must be 1600 characters or fewer");
  return body;
}

function cleanScheduledFor(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error("Scheduled date/time is invalid");
  if (date.getTime() < Date.now() + 15_000) throw new Error("Scheduled time must be in the future");
  return date.toISOString();
}

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

async function cleanupInserted(ids: string[]): Promise<void> {
  for (let index = 0; index < ids.length; index += 200) {
    await getSupabaseAdmin().from("scheduled_sms").delete().in("id", ids.slice(index, index + 200));
  }
}

export async function scheduleBulkSms(input: {
  contactIds: string[];
  messageTemplate: string;
  scheduledFor: string;
  timezone?: string | null;
  templateId?: string | null;
  createdByZohoUserId?: string | null;
  createdByName?: string | null;
}): Promise<{
  scheduledCount: number;
  skippedCount: number;
  scheduledFor: string;
  timezone: string;
}> {
  const ids = cleanIds(input.contactIds);
  if (ids.length === 0) throw new Error("Select at least one Contact");

  const body = cleanBody(input.messageTemplate);
  const scheduledFor = cleanScheduledFor(input.scheduledFor);
  const timezone = cleanTimezone(input.timezone);

  const preview = await previewBulkSmsRecipients(ids);
  if (preview.eligibleCount === 0) throw new Error("None of the selected Contacts are eligible for SMS");

  const contacts = await getZohoContactsByIds(ids);
  const contactMap = new Map(contacts.map((contact) => [contact.id, contact]));
  const previewMap = new Map(preview.recipients.map((recipient) => [recipient.zohoContactId, recipient]));

  const requestedTemplateId = input.templateId?.trim() || null;
  let templateId: string | null = null;
  let templateName: string | null = null;
  if (requestedTemplateId) {
    const template = await getMessagingTemplate(requestedTemplateId);
    if (!template) throw new Error("SMS template not found");
    templateId = template.id;
    templateName = template.name;
  }

  const now = new Date().toISOString();
  const rows: Array<Record<string, unknown>> = [];

  for (const id of ids) {
    const recipient = previewMap.get(id);
    const contact = contactMap.get(id);
    if (!recipient?.eligible || !contact || !recipient.normalizedPhone) continue;

    const rendered = renderSmsTemplate(body, contact).trim();
    if (!rendered || rendered.length > 1600) continue;

    rows.push({
      zoho_contact_id: id,
      template_id: templateId,
      template_name_snapshot: templateName,
      message_body: rendered,
      phone_at_scheduling: recipient.normalizedPhone,
      scheduled_for: scheduledFor,
      timezone,
      status: "Scheduled",
      created_by_zoho_user_id: input.createdByZohoUserId?.trim() || null,
      created_by_name: input.createdByName?.trim() || null,
      updated_by_zoho_user_id: input.createdByZohoUserId?.trim() || null,
      updated_by_name: input.createdByName?.trim() || null,
      created_at: now,
      updated_at: now,
    });
  }

  if (rows.length === 0) throw new Error("No selected Contacts produced a valid scheduled SMS");

  const insertedIds: string[] = [];
  try {
    for (let index = 0; index < rows.length; index += 200) {
      const chunk = rows.slice(index, index + 200);
      const { data, error } = await getSupabaseAdmin().from("scheduled_sms").insert(chunk).select("id");
      if (error) throw new Error(`Schedule bulk SMS failed: ${error.message}`);
      for (const row of data ?? []) {
        if (row.id) insertedIds.push(row.id);
      }
    }
  } catch (error) {
    if (insertedIds.length > 0) await cleanupInserted(insertedIds);
    throw error;
  }

  return {
    scheduledCount: rows.length,
    skippedCount: ids.length - rows.length,
    scheduledFor,
    timezone,
  };
}
