import { getConversationById, attachZohoConversationId, type MessagingConversation } from "@/lib/messaging/repository";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { toZohoMessageStatus } from "@/lib/twilio/status";
import {
  createZohoMessagingConversation,
  findZohoMessagingConversationByExternalId,
  updateZohoMessagingConversationProjection,
  type ConversationCreatedFrom,
  type ZohoConversationProjection,
} from "@/lib/zoho/conversations";

const OPPORTUNISTIC_INTERVAL_MS = 30_000;
let lastOpportunisticRunAt = 0;
let opportunisticRun: Promise<void> | null = null;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 500) : "Unknown CRM projection error";
}

function createdFrom(value: string | null): ConversationCreatedFrom {
  if (value === "Incoming SMS" || value === "CRM Widget" || value === "Automation" || value === "Import") {
    return value;
  }
  return "Import";
}

function conversationStatus(value: string): "Active" | "Closed" | "Archived" {
  if (value === "Closed" || value === "Archived") return value;
  return "Active";
}

function projectionFor(conversation: MessagingConversation): ZohoConversationProjection {
  if (!conversation.zoho_contact_id) {
    throw new Error("Cannot project an unmatched conversation into Zoho CRM");
  }

  return {
    contactId: conversation.zoho_contact_id,
    channel: conversation.channel === "WhatsApp" ? "WhatsApp" : "SMS",
    customerPhone: conversation.customer_phone,
    twilioPhone: conversation.twilio_phone,
    conversationStatus: conversationStatus(conversation.status),
    externalConversationId: conversation.id,
    createdFrom: createdFrom(conversation.created_from),
    lastMessage: conversation.last_message,
    lastMessageAt: conversation.last_message_at,
    lastMessageDirection:
      conversation.last_message_direction === "Incoming" || conversation.last_message_direction === "Outgoing"
        ? conversation.last_message_direction
        : null,
    lastMessageStatus: conversation.last_message_status
      ? toZohoMessageStatus(conversation.last_message_status)
      : null,
    unreadCount: conversation.unread_count,
    lastIncomingAt: conversation.last_incoming_at,
    lastOutgoingAt: conversation.last_outgoing_at,
    optOutStatus:
      conversation.opt_out_status === "Opted Out" || conversation.opt_out_status === "Do Not Message"
        ? conversation.opt_out_status
        : "Active",
    optOutDate:
      conversation.opt_out_status === "Active" || !conversation.opt_out_at
        ? null
        : conversation.opt_out_at.slice(0, 10),
  };
}

async function markAttempt(conversationId: string, version: number): Promise<void> {
  await getSupabaseAdmin()
    .from("messaging_conversations")
    .update({
      crm_last_sync_attempt_at: new Date().toISOString(),
      crm_sync_error: null,
    })
    .eq("id", conversationId)
    .eq("crm_projection_version", version);
}

async function markFailure(conversationId: string, version: number, error: unknown): Promise<void> {
  await getSupabaseAdmin()
    .from("messaging_conversations")
    .update({
      crm_sync_needed: true,
      crm_last_sync_attempt_at: new Date().toISOString(),
      crm_sync_error: errorMessage(error),
    })
    .eq("id", conversationId)
    .eq("crm_projection_version", version);
}

async function markSuccess(conversationId: string, version: number): Promise<boolean> {
  const now = new Date().toISOString();
  const { data, error } = await getSupabaseAdmin()
    .from("messaging_conversations")
    .update({
      crm_sync_needed: false,
      crm_synced_version: version,
      crm_last_synced_at: now,
      crm_last_sync_attempt_at: now,
      crm_sync_error: null,
    })
    .eq("id", conversationId)
    .eq("crm_projection_version", version)
    .select("id")
    .maybeSingle();

  if (error) throw new Error(`Mark CRM projection synced failed: ${error.message}`);
  return Boolean(data?.id);
}

async function ensureZohoConversationId(conversation: MessagingConversation): Promise<string> {
  if (conversation.zoho_conversation_id) return conversation.zoho_conversation_id;
  if (!conversation.zoho_contact_id) throw new Error("Cannot create CRM projection without a Zoho Contact");

  const existing = await findZohoMessagingConversationByExternalId(conversation.id);
  if (existing) {
    await attachZohoConversationId(conversation.id, existing);
    return existing;
  }

  const projection = projectionFor(conversation);
  const created = await createZohoMessagingConversation({
    contactId: projection.contactId,
    customerPhone: projection.customerPhone,
    twilioPhone: projection.twilioPhone,
    externalConversationId: projection.externalConversationId,
    createdFrom: projection.createdFrom,
    summary: {
      lastMessage: projection.lastMessage,
      lastMessageAt: projection.lastMessageAt,
      lastMessageDirection: projection.lastMessageDirection,
      lastMessageStatus: projection.lastMessageStatus,
      unreadCount: projection.unreadCount,
      lastIncomingAt: projection.lastIncomingAt,
      lastOutgoingAt: projection.lastOutgoingAt,
      optOutStatus: projection.optOutStatus,
      optOutDate: projection.optOutDate,
    },
  });
  await attachZohoConversationId(conversation.id, created);
  return created;
}

export async function projectConversationToZoho(
  conversationId: string,
  maxCycles = 3,
): Promise<MessagingConversation> {
  const cycles = Math.max(1, Math.min(5, maxCycles));
  let latest: MessagingConversation | null = null;

  for (let cycle = 0; cycle < cycles; cycle += 1) {
    latest = await getConversationById(conversationId);
    if (!latest) throw new Error("Messaging conversation not found for CRM projection");
    if (!latest.zoho_contact_id) return latest;

    const version = latest.crm_projection_version;
    await markAttempt(latest.id, version);

    try {
      const zohoConversationId = await ensureZohoConversationId(latest);
      await updateZohoMessagingConversationProjection(zohoConversationId, projectionFor(latest));

      if (await markSuccess(latest.id, version)) {
        return (await getConversationById(latest.id)) ?? latest;
      }

      // Canonical state changed while the remote write was in flight. Loop and
      // immediately project the newest version so an older snapshot cannot be
      // left as the final CRM state.
    } catch (error) {
      await markFailure(latest.id, version, error);
      throw error;
    }
  }

  return (await getConversationById(conversationId)) ?? latest!;
}

export async function reconcileDirtyCrmProjections(limit = 3): Promise<{
  attempted: number;
  repaired: number;
  failed: number;
}> {
  const safeLimit = Math.max(1, Math.min(20, limit));
  const { data, error } = await getSupabaseAdmin()
    .from("messaging_conversations")
    .select("id")
    .eq("crm_sync_needed", true)
    .not("zoho_contact_id", "is", null)
    .order("updated_at", { ascending: true })
    .limit(safeLimit);

  if (error) throw new Error(`Load dirty CRM projections failed: ${error.message}`);

  let repaired = 0;
  let failed = 0;
  for (const row of data ?? []) {
    try {
      const projected = await projectConversationToZoho(row.id);
      if (!projected.crm_sync_needed) repaired += 1;
    } catch (projectionError) {
      failed += 1;
      console.warn("CRM projection reconciliation failed", errorMessage(projectionError));
    }
  }

  return { attempted: (data ?? []).length, repaired, failed };
}

export async function runCrmReconciliationOpportunistically(): Promise<void> {
  const now = Date.now();
  if (opportunisticRun) return opportunisticRun;
  if (now - lastOpportunisticRunAt < OPPORTUNISTIC_INTERVAL_MS) return;

  lastOpportunisticRunAt = now;
  opportunisticRun = reconcileDirtyCrmProjections(3)
    .then(() => undefined)
    .catch((error) => {
      console.warn("Opportunistic CRM reconciliation failed", errorMessage(error));
    })
    .finally(() => {
      opportunisticRun = null;
    });

  return opportunisticRun;
}
