import { createHash } from "node:crypto";
import { getSupabaseAdmin } from "@/lib/supabase/admin";

export type IdempotentSendResult = {
  messageSid: string;
  status: string;
  conversationId: string;
  zohoConversationId: string | null;
  crmSynced: boolean;
  crmSyncError?: string;
};

type SendRequestRow = {
  idempotency_key: string;
  request_hash: string;
  source: string;
  status: "processing" | "completed" | "failed";
  zoho_contact_id: string | null;
  conversation_id: string | null;
  twilio_message_sid: string | null;
  result_status: string | null;
  result_conversation_id: string | null;
  zoho_conversation_id: string | null;
  crm_synced: boolean | null;
  crm_sync_error: string | null;
  error_message: string | null;
  created_at: string;
};

export type SendReservationInput = {
  explicitKey?: string | null;
  source: string;
  zohoContactId: string;
  conversationId: string;
  customerPhone: string;
  twilioPhone: string;
  body: string;
  sentByZohoUserId?: string | null;
};

export type SendReservation = {
  key: string;
  requestHash: string;
  cachedResult?: IdempotentSendResult;
};

const AUTO_DEDUPE_WINDOW_MS = 2 * 60 * 1000;

function hashRequest(input: SendReservationInput): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        source: input.source,
        zohoContactId: input.zohoContactId,
        conversationId: input.conversationId,
        customerPhone: input.customerPhone,
        twilioPhone: input.twilioPhone,
        body: input.body,
        sentByZohoUserId: input.sentByZohoUserId?.trim() || null,
      }),
    )
    .digest("hex");
}

function cleanExplicitKey(value?: string | null): string | null {
  const key = value?.trim();
  if (!key) return null;
  if (key.length < 8 || key.length > 200) {
    throw new Error("Idempotency key must be between 8 and 200 characters");
  }
  return key;
}

function cachedResult(row: SendRequestRow): IdempotentSendResult | null {
  if (
    row.status !== "completed" ||
    !row.twilio_message_sid ||
    !row.result_status ||
    !row.result_conversation_id ||
    row.crm_synced === null
  ) {
    return null;
  }
  return {
    messageSid: row.twilio_message_sid,
    status: row.result_status,
    conversationId: row.result_conversation_id,
    zohoConversationId: row.zoho_conversation_id,
    crmSynced: row.crm_synced,
    ...(row.crm_sync_error ? { crmSyncError: row.crm_sync_error } : {}),
  };
}

async function loadByKey(key: string): Promise<SendRequestRow | null> {
  const { data, error } = await getSupabaseAdmin()
    .from("messaging_send_requests")
    .select("*")
    .eq("idempotency_key", key)
    .maybeSingle();
  if (error) throw new Error(`Load SMS idempotency request failed: ${error.message}`);
  return (data as SendRequestRow | null) ?? null;
}

async function existingRecentHash(requestHash: string): Promise<SendRequestRow | null> {
  const cutoff = new Date(Date.now() - AUTO_DEDUPE_WINDOW_MS).toISOString();
  const { data, error } = await getSupabaseAdmin()
    .from("messaging_send_requests")
    .select("*")
    .eq("request_hash", requestHash)
    .gte("created_at", cutoff)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`Check recent SMS send failed: ${error.message}`);
  return (data as SendRequestRow | null) ?? null;
}

function interpretExisting(row: SendRequestRow, requestHash: string): SendReservation {
  if (row.request_hash !== requestHash) {
    throw new Error("Idempotency key was already used for a different SMS request");
  }
  const cached = cachedResult(row);
  if (cached) return { key: row.idempotency_key, requestHash, cachedResult: cached };
  if (row.status === "processing") {
    throw new Error("This SMS send is already processing. Refresh the conversation before retrying.");
  }
  throw new Error(
    row.error_message
      ? `The previous SMS attempt failed and was not retried automatically: ${row.error_message}`
      : "The previous SMS attempt failed. Start a new send to retry safely.",
  );
}

export async function reserveSmsSend(input: SendReservationInput): Promise<SendReservation> {
  const requestHash = hashRequest(input);
  const explicitKey = cleanExplicitKey(input.explicitKey);

  if (explicitKey) {
    const existing = await loadByKey(explicitKey);
    if (existing) return interpretExisting(existing, requestHash);
  } else {
    const recent = await existingRecentHash(requestHash);
    if (recent) return interpretExisting(recent, requestHash);
  }

  const bucket = Math.floor(Date.now() / AUTO_DEDUPE_WINDOW_MS);
  const key = explicitKey ?? `auto:${requestHash}:${bucket}`;
  const { error } = await getSupabaseAdmin().from("messaging_send_requests").insert({
    idempotency_key: key,
    request_hash: requestHash,
    source: input.source,
    status: "processing",
    zoho_contact_id: input.zohoContactId,
    conversation_id: input.conversationId,
  });

  if (!error) return { key, requestHash };
  if (error.code === "23505") {
    const existing = await loadByKey(key);
    if (existing) return interpretExisting(existing, requestHash);
  }
  throw new Error(`Reserve SMS send failed: ${error.message}`);
}

export async function recordSmsTransportAccepted(
  key: string,
  input: { twilioMessageSid: string; status: string; conversationId: string; zohoConversationId: string | null },
): Promise<void> {
  const { error } = await getSupabaseAdmin()
    .from("messaging_send_requests")
    .update({
      twilio_message_sid: input.twilioMessageSid,
      result_status: input.status,
      result_conversation_id: input.conversationId,
      zoho_conversation_id: input.zohoConversationId,
      updated_at: new Date().toISOString(),
    })
    .eq("idempotency_key", key);
  if (error) throw new Error(`Record Twilio acceptance failed: ${error.message}`);
}

export async function completeSmsSend(key: string, result: IdempotentSendResult): Promise<void> {
  const now = new Date().toISOString();
  const { error } = await getSupabaseAdmin()
    .from("messaging_send_requests")
    .update({
      status: "completed",
      twilio_message_sid: result.messageSid,
      result_status: result.status,
      result_conversation_id: result.conversationId,
      zoho_conversation_id: result.zohoConversationId,
      crm_synced: result.crmSynced,
      crm_sync_error: result.crmSyncError ?? null,
      error_message: null,
      completed_at: now,
      updated_at: now,
    })
    .eq("idempotency_key", key);
  if (error) throw new Error(`Complete SMS idempotency request failed: ${error.message}`);
}

export async function failSmsSend(key: string, errorValue: unknown): Promise<void> {
  const errorMessage = errorValue instanceof Error ? errorValue.message.slice(0, 500) : "Unknown SMS send error";
  const { error } = await getSupabaseAdmin()
    .from("messaging_send_requests")
    .update({
      status: "failed",
      error_message: errorMessage,
      updated_at: new Date().toISOString(),
    })
    .eq("idempotency_key", key);
  if (error) console.error("Failed to persist SMS idempotency failure", error.message);
}
