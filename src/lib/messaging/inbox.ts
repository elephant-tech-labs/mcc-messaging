import { getSupabaseAdmin } from "@/lib/supabase/admin";
import type { MessagingConversation } from "@/lib/messaging/repository";

export type MessagingInboxMode = "unread" | "recent";

function throwIfError(error: { message?: string } | null, context: string): void {
  if (error) throw new Error(`${context}: ${error.message ?? "database error"}`);
}

export async function listInboxConversations(input: {
  mode: MessagingInboxMode;
  limit?: number;
}): Promise<MessagingConversation[]> {
  const limit = Math.max(1, Math.min(100, input.limit ?? 5));
  let query = getSupabaseAdmin()
    .from("messaging_conversations")
    .select("*")
    .eq("channel", "SMS")
    .neq("status", "Archived")
    .not("last_message_at", "is", null)
    .order("last_message_at", { ascending: false })
    .limit(limit);

  if (input.mode === "unread") {
    query = query.gt("unread_count", 0);
  }

  const { data, error } = await query;
  throwIfError(error, "Load messaging inbox failed");
  return (data ?? []) as MessagingConversation[];
}

export async function countUnreadConversations(): Promise<number> {
  const { count, error } = await getSupabaseAdmin()
    .from("messaging_conversations")
    .select("id", { count: "exact", head: true })
    .eq("channel", "SMS")
    .neq("status", "Archived")
    .gt("unread_count", 0);

  throwIfError(error, "Count unread messaging conversations failed");
  return count ?? 0;
}

export async function markConversationRead(
  conversationId: string,
): Promise<MessagingConversation> {
  const { data, error } = await getSupabaseAdmin()
    .from("messaging_conversations")
    .update({ unread_count: 0 })
    .eq("id", conversationId)
    .select("*")
    .single();

  throwIfError(error, "Mark messaging conversation read failed");
  return data as MessagingConversation;
}
