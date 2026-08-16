import { requiredEnv } from "@/lib/env";
import { tryNormalizePhone } from "@/lib/phone/normalize";
import { sendSms } from "@/lib/messaging/send-service";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { getZohoContactsByIds, type ZohoContact } from "@/lib/zoho/contacts";

export type BulkPreviewRecipient = {
  zohoContactId: string;
  name: string;
  firstName: string;
  lastName: string;
  phone: string | null;
  normalizedPhone: string | null;
  eligible: boolean;
  skipReason: string | null;
};

export type BulkSmsJobSummary = {
  id: string;
  name: string | null;
  message_template: string;
  status: string;
  total_selected: number;
  eligible_count: number;
  skipped_count: number;
  created_by_name: string | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
  pendingCount: number;
  deliveredCount: number;
  acceptedCount: number;
  failedCount: number;
  skippedCount: number;
};

type BulkRecipientRow = {
  id: string;
  job_id: string;
  zoho_contact_id: string;
  contact_name: string | null;
  customer_phone: string | null;
  rendered_body: string | null;
  status: string;
  twilio_message_sid: string | null;
  attempt_count: number;
};

function contactName(contact: ZohoContact): string {
  return (
    contact.Full_Name?.trim() ||
    [contact.First_Name, contact.Last_Name].filter(Boolean).join(" ").trim() ||
    "Contact"
  );
}

function cleanIds(ids: string[]): string[] {
  return [...new Set(ids.map((id) => id.trim()).filter((id) => /^\d{10,25}$/.test(id)))].slice(0, 2000);
}

function renderTemplate(template: string, contact: ZohoContact): string {
  const values: Record<string, string> = {
    First_Name: contact.First_Name?.trim() ?? "",
    Last_Name: contact.Last_Name?.trim() ?? "",
    Full_Name: contactName(contact),
  };
  return template.replace(/\{\{\s*(First_Name|Last_Name|Full_Name)\s*\}\}/g, (_match, key: string) => values[key] ?? "");
}

async function optedOutPhones(phones: string[], twilioPhone: string): Promise<Set<string>> {
  const result = new Set<string>();
  const unique = [...new Set(phones)].filter(Boolean);
  for (let index = 0; index < unique.length; index += 200) {
    const chunk = unique.slice(index, index + 200);
    const { data, error } = await getSupabaseAdmin()
      .from("messaging_conversations")
      .select("customer_phone,opt_out_status")
      .eq("twilio_phone", twilioPhone)
      .in("customer_phone", chunk)
      .neq("opt_out_status", "Active");
    if (error) throw new Error(`Check bulk SMS opt-outs failed: ${error.message}`);
    for (const row of data ?? []) {
      if (row.customer_phone) result.add(row.customer_phone);
    }
  }
  return result;
}

export async function previewBulkSmsRecipients(contactIds: string[]): Promise<{
  totalSelected: number;
  eligibleCount: number;
  skippedCount: number;
  recipients: BulkPreviewRecipient[];
}> {
  const ids = cleanIds(contactIds);
  if (ids.length === 0) throw new Error("Select at least one Contact");

  const contacts = await getZohoContactsByIds(ids);
  const byId = new Map(contacts.map((contact) => [contact.id, contact]));
  const twilioPhone = tryNormalizePhone(requiredEnv("TWILIO_PHONE_NUMBER"));
  if (!twilioPhone) throw new Error("MCC Twilio sender number is invalid");

  const normalizedById = new Map<string, string | null>();
  for (const id of ids) {
    const contact = byId.get(id);
    normalizedById.set(id, tryNormalizePhone(contact?.Phone));
  }
  const optOuts = await optedOutPhones(
    [...normalizedById.values()].filter((phone): phone is string => Boolean(phone)),
    twilioPhone,
  );

  const seenPhones = new Set<string>();
  const recipients: BulkPreviewRecipient[] = ids.map((id) => {
    const contact = byId.get(id);
    const normalized = normalizedById.get(id) ?? null;
    let skipReason: string | null = null;

    if (!contact) skipReason = "Contact could not be loaded";
    else if (!contact.Phone?.trim()) skipReason = "Missing Phone";
    else if (!normalized) skipReason = "Invalid Phone";
    else if (normalized === twilioPhone) skipReason = "Phone is the MCC sender number";
    else if (seenPhones.has(normalized)) skipReason = "Duplicate phone in selection";
    else if (optOuts.has(normalized)) skipReason = "Opted out / Do Not Message";

    if (normalized && !skipReason) seenPhones.add(normalized);

    return {
      zohoContactId: id,
      name: contact ? contactName(contact) : `Contact ${id}`,
      firstName: contact?.First_Name?.trim() ?? "",
      lastName: contact?.Last_Name?.trim() ?? "",
      phone: contact?.Phone ?? null,
      normalizedPhone: normalized,
      eligible: !skipReason,
      skipReason,
    };
  });

  const eligibleCount = recipients.filter((recipient) => recipient.eligible).length;
  return {
    totalSelected: ids.length,
    eligibleCount,
    skippedCount: ids.length - eligibleCount,
    recipients,
  };
}

export async function createBulkSmsJob(input: {
  contactIds: string[];
  messageTemplate: string;
  name?: string | null;
  createdByZohoUserId?: string | null;
  createdByName?: string | null;
}): Promise<{ jobId: string; eligibleCount: number; skippedCount: number }> {
  const template = input.messageTemplate.trim();
  if (!template) throw new Error("Message is required");
  if (template.length > 1600) throw new Error("SMS template must be 1600 characters or fewer");

  const ids = cleanIds(input.contactIds);
  const preview = await previewBulkSmsRecipients(ids);
  if (preview.eligibleCount === 0) throw new Error("None of the selected Contacts are eligible for SMS");
  const contacts = await getZohoContactsByIds(ids);
  const byId = new Map(contacts.map((contact) => [contact.id, contact]));

  const { data: job, error: jobError } = await getSupabaseAdmin()
    .from("bulk_sms_jobs")
    .insert({
      name: input.name?.trim() || null,
      message_template: template,
      status: "queued",
      total_selected: preview.totalSelected,
      eligible_count: preview.eligibleCount,
      skipped_count: preview.skippedCount,
      created_by_zoho_user_id: input.createdByZohoUserId?.trim() || null,
      created_by_name: input.createdByName?.trim() || null,
    })
    .select("id")
    .single();
  if (jobError || !job) throw new Error(`Create bulk SMS job failed: ${jobError?.message ?? "unknown error"}`);

  const previewMap = new Map(preview.recipients.map((recipient) => [recipient.zohoContactId, recipient]));
  const recipientRows = ids.map((id) => {
    const contact = byId.get(id);
    const item = previewMap.get(id)!;
    const rendered = contact ? renderTemplate(template, contact).trim() : "";
    const tooLong = item.eligible && rendered.length > 1600;
    return {
      job_id: job.id,
      zoho_contact_id: id,
      contact_name: item.name,
      first_name: item.firstName || null,
      last_name: item.lastName || null,
      phone_raw: item.phone,
      customer_phone: item.normalizedPhone,
      rendered_body: rendered || null,
      status: item.eligible && !tooLong ? "queued" : "skipped",
      skip_reason: tooLong ? "Personalized message exceeds 1600 characters" : item.skipReason,
    };
  });

  const { error: recipientError } = await getSupabaseAdmin().from("bulk_sms_recipients").insert(recipientRows);
  if (recipientError) {
    await getSupabaseAdmin().from("bulk_sms_jobs").delete().eq("id", job.id);
    throw new Error(`Create bulk SMS recipients failed: ${recipientError.message}`);
  }

  const actualEligible = recipientRows.filter((row) => row.status === "queued").length;
  const actualSkipped = recipientRows.length - actualEligible;
  if (actualEligible !== preview.eligibleCount || actualSkipped !== preview.skippedCount) {
    await getSupabaseAdmin()
      .from("bulk_sms_jobs")
      .update({ eligible_count: actualEligible, skipped_count: actualSkipped, updated_at: new Date().toISOString() })
      .eq("id", job.id);
  }

  return { jobId: job.id, eligibleCount: actualEligible, skippedCount: actualSkipped };
}

function normalizeRecipientStatus(status: string): "accepted" | "sent" | "delivered" | "failed" | "undelivered" {
  switch (status.toLowerCase()) {
    case "sent":
      return "sent";
    case "delivered":
    case "read":
      return "delivered";
    case "failed":
    case "canceled":
      return "failed";
    case "undelivered":
      return "undelivered";
    default:
      return "accepted";
  }
}

export async function processBulkSmsBatch(jobId: string, batchSize = 8): Promise<{ processed: number; done: boolean }> {
  const { data: job, error: jobError } = await getSupabaseAdmin()
    .from("bulk_sms_jobs")
    .select("id,status,started_at,created_by_zoho_user_id,created_by_name")
    .eq("id", jobId)
    .single();
  if (jobError || !job) throw new Error("Bulk SMS job not found");
  if (["completed", "partial", "failed", "canceled"].includes(job.status)) return { processed: 0, done: true };

  if (!job.started_at) {
    await getSupabaseAdmin()
      .from("bulk_sms_jobs")
      .update({ status: "processing", started_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq("id", jobId);
  }

  const { data: claimed, error: claimError } = await getSupabaseAdmin().rpc("claim_bulk_sms_recipients", {
    p_job_id: jobId,
    p_limit: Math.max(1, Math.min(25, batchSize)),
  });
  if (claimError) throw new Error(`Claim bulk SMS recipients failed: ${claimError.message}`);
  const recipients = (claimed ?? []) as BulkRecipientRow[];

  await Promise.all(
    recipients.map(async (recipient) => {
      try {
        if (!recipient.rendered_body) throw new Error("Prepared message is empty");
        const result = await sendSms({
          zohoContactId: recipient.zoho_contact_id,
          body: recipient.rendered_body,
          source: "Bulk SMS",
          sentByZohoUserId: job.created_by_zoho_user_id,
          sentByName: job.created_by_name,
        });
        await getSupabaseAdmin()
          .from("bulk_sms_recipients")
          .update({
            status: normalizeRecipientStatus(result.status),
            twilio_message_sid: result.messageSid,
            conversation_id: result.conversationId,
            sent_at: new Date().toISOString(),
            processing_started_at: null,
            updated_at: new Date().toISOString(),
          })
          .eq("id", recipient.id);
      } catch (error) {
        await getSupabaseAdmin()
          .from("bulk_sms_recipients")
          .update({
            status: "failed",
            error_message: error instanceof Error ? error.message.slice(0, 500) : "Unknown send error",
            processing_started_at: null,
            updated_at: new Date().toISOString(),
          })
          .eq("id", recipient.id);
      }
    }),
  );

  const status = await getBulkSmsJobStatus(jobId);
  return { processed: recipients.length, done: status.pendingCount === 0 };
}

export async function listBulkSmsJobs(limit = 30): Promise<BulkSmsJobSummary[]> {
  const safeLimit = Math.max(1, Math.min(100, limit));
  const { data: jobs, error: jobsError } = await getSupabaseAdmin()
    .from("bulk_sms_jobs")
    .select("id,name,message_template,status,total_selected,eligible_count,skipped_count,created_by_name,started_at,completed_at,created_at")
    .order("created_at", { ascending: false })
    .limit(safeLimit);
  if (jobsError) throw new Error(`Load bulk SMS jobs failed: ${jobsError.message}`);
  if (!jobs || jobs.length === 0) return [];

  const jobIds = jobs.map((job) => job.id);
  const { data: recipientStatuses, error: recipientsError } = await getSupabaseAdmin()
    .from("bulk_sms_recipients")
    .select("job_id,status")
    .in("job_id", jobIds);
  if (recipientsError) throw new Error(`Load bulk SMS job counts failed: ${recipientsError.message}`);

  const counts = new Map<string, Record<string, number>>();
  for (const row of recipientStatuses ?? []) {
    const current = counts.get(row.job_id) ?? {};
    current[row.status] = (current[row.status] ?? 0) + 1;
    counts.set(row.job_id, current);
  }

  return jobs.map((job) => {
    const count = counts.get(job.id) ?? {};
    return {
      ...job,
      pendingCount: (count.queued ?? 0) + (count.processing ?? 0),
      deliveredCount: count.delivered ?? 0,
      acceptedCount: (count.accepted ?? 0) + (count.sent ?? 0),
      failedCount: (count.failed ?? 0) + (count.undelivered ?? 0),
      skippedCount: count.skipped ?? 0,
    } as BulkSmsJobSummary;
  });
}

export async function getBulkSmsJobStatus(jobId: string) {
  const { data: job, error: jobError } = await getSupabaseAdmin()
    .from("bulk_sms_jobs")
    .select("*")
    .eq("id", jobId)
    .single();
  if (jobError || !job) throw new Error("Bulk SMS job not found");

  const { data: rows, error: rowsError } = await getSupabaseAdmin()
    .from("bulk_sms_recipients")
    .select("id,zoho_contact_id,contact_name,customer_phone,status,skip_reason,error_code,error_message,twilio_message_sid")
    .eq("job_id", jobId);
  if (rowsError) throw new Error(`Load bulk SMS recipients failed: ${rowsError.message}`);

  const recipients = rows ?? [];
  const count = (statuses: string[]) => recipients.filter((row) => statuses.includes(row.status)).length;
  const pendingCount = count(["queued", "processing"]);
  const deliveredCount = count(["delivered"]);
  const acceptedCount = count(["accepted", "sent"]);
  const failedCount = count(["failed", "undelivered"]);
  const skippedCount = count(["skipped"]);

  if (pendingCount === 0 && !["completed", "partial", "failed", "canceled"].includes(job.status)) {
    const finalStatus = failedCount > 0 ? (deliveredCount + acceptedCount > 0 ? "partial" : "failed") : "completed";
    await getSupabaseAdmin()
      .from("bulk_sms_jobs")
      .update({ status: finalStatus, completed_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq("id", jobId);
    job.status = finalStatus;
  }

  return {
    job,
    pendingCount,
    deliveredCount,
    acceptedCount,
    failedCount,
    skippedCount,
    recipients: recipients.filter((row) => row.status === "skipped" || row.status === "failed" || row.status === "undelivered").slice(0, 100),
  };
}

export async function syncBulkSmsRecipientStatus(input: {
  twilioMessageSid: string;
  status: string;
  errorCode?: string | null;
  errorMessage?: string | null;
}): Promise<void> {
  const nextStatus = normalizeRecipientStatus(input.status);
  const patch: Record<string, unknown> = {
    status: nextStatus,
    error_code: input.errorCode ?? null,
    error_message: input.errorMessage ?? null,
    updated_at: new Date().toISOString(),
  };
  if (nextStatus === "delivered") patch.delivered_at = new Date().toISOString();

  const { error } = await getSupabaseAdmin()
    .from("bulk_sms_recipients")
    .update(patch)
    .eq("twilio_message_sid", input.twilioMessageSid);
  if (error) throw new Error(`Sync bulk SMS recipient status failed: ${error.message}`);
}
