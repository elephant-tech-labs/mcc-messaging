import { getSupabaseAdmin } from "@/lib/supabase/admin";

export type MessagingTemplateStatus = "Active" | "Archived";

export type MessagingTemplate = {
  id: string;
  name: string;
  body: string;
  category: string | null;
  status: MessagingTemplateStatus;
  created_by_zoho_user_id: string | null;
  created_by_name: string | null;
  updated_by_zoho_user_id: string | null;
  updated_by_name: string | null;
  created_at: string;
  updated_at: string;
};

function cleanName(value: string): string {
  const name = value.trim();
  if (!name) throw new Error("Template name is required");
  if (name.length > 120) throw new Error("Template name must be 120 characters or fewer");
  return name;
}

function cleanBody(value: string): string {
  const body = value.trim();
  if (!body) throw new Error("Template message is required");
  if (body.length > 1600) throw new Error("Template message must be 1600 characters or fewer");
  return body;
}

function cleanCategory(value?: string | null): string | null {
  const category = value?.trim() || null;
  if (category && category.length > 80) throw new Error("Template category must be 80 characters or fewer");
  return category;
}

function duplicateNameError(error: { code?: string; message?: string } | null): boolean {
  return Boolean(error && error.code === "23505");
}

export async function listMessagingTemplates(options: {
  includeArchived?: boolean;
  limit?: number;
} = {}): Promise<MessagingTemplate[]> {
  const limit = Math.max(1, Math.min(250, options.limit ?? 100));
  let query = getSupabaseAdmin()
    .from("messaging_templates")
    .select("*")
    .order("updated_at", { ascending: false })
    .limit(limit);

  if (!options.includeArchived) query = query.eq("status", "Active");

  const { data, error } = await query;
  if (error) throw new Error(`Load SMS templates failed: ${error.message}`);
  return (data ?? []) as MessagingTemplate[];
}

export async function getMessagingTemplate(id: string): Promise<MessagingTemplate | null> {
  const { data, error } = await getSupabaseAdmin()
    .from("messaging_templates")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(`Load SMS template failed: ${error.message}`);
  return (data as MessagingTemplate | null) ?? null;
}

export async function createMessagingTemplate(input: {
  name: string;
  body: string;
  category?: string | null;
  zohoUserId?: string | null;
  userName?: string | null;
}): Promise<MessagingTemplate> {
  const now = new Date().toISOString();
  const { data, error } = await getSupabaseAdmin()
    .from("messaging_templates")
    .insert({
      name: cleanName(input.name),
      body: cleanBody(input.body),
      category: cleanCategory(input.category),
      status: "Active",
      created_by_zoho_user_id: input.zohoUserId?.trim() || null,
      created_by_name: input.userName?.trim() || null,
      updated_by_zoho_user_id: input.zohoUserId?.trim() || null,
      updated_by_name: input.userName?.trim() || null,
      created_at: now,
      updated_at: now,
    })
    .select("*")
    .single();

  if (duplicateNameError(error)) throw new Error("An active SMS template with this name already exists");
  if (error || !data) throw new Error(`Create SMS template failed: ${error?.message ?? "unknown error"}`);
  return data as MessagingTemplate;
}

export async function updateMessagingTemplate(input: {
  id: string;
  name: string;
  body: string;
  category?: string | null;
  zohoUserId?: string | null;
  userName?: string | null;
}): Promise<MessagingTemplate> {
  const { data, error } = await getSupabaseAdmin()
    .from("messaging_templates")
    .update({
      name: cleanName(input.name),
      body: cleanBody(input.body),
      category: cleanCategory(input.category),
      updated_by_zoho_user_id: input.zohoUserId?.trim() || null,
      updated_by_name: input.userName?.trim() || null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", input.id)
    .select("*")
    .single();

  if (duplicateNameError(error)) throw new Error("An active SMS template with this name already exists");
  if (error || !data) throw new Error(`Update SMS template failed: ${error?.message ?? "unknown error"}`);
  return data as MessagingTemplate;
}

export async function setMessagingTemplateStatus(input: {
  id: string;
  status: MessagingTemplateStatus;
  zohoUserId?: string | null;
  userName?: string | null;
}): Promise<MessagingTemplate> {
  const { data, error } = await getSupabaseAdmin()
    .from("messaging_templates")
    .update({
      status: input.status,
      updated_by_zoho_user_id: input.zohoUserId?.trim() || null,
      updated_by_name: input.userName?.trim() || null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", input.id)
    .select("*")
    .single();

  if (duplicateNameError(error)) throw new Error("Another active SMS template already uses this name");
  if (error || !data) throw new Error(`Update SMS template status failed: ${error?.message ?? "unknown error"}`);
  return data as MessagingTemplate;
}

export async function duplicateMessagingTemplate(input: {
  id: string;
  zohoUserId?: string | null;
  userName?: string | null;
}): Promise<MessagingTemplate> {
  const template = await getMessagingTemplate(input.id);
  if (!template) throw new Error("SMS template not found");

  const active = await listMessagingTemplates({ includeArchived: false, limit: 250 });
  const used = new Set(active.map((item) => item.name.trim().toLowerCase()));
  let name = `${template.name} Copy`;
  let suffix = 2;
  while (used.has(name.toLowerCase())) {
    name = `${template.name} Copy ${suffix}`;
    suffix += 1;
  }

  return createMessagingTemplate({
    name,
    body: template.body,
    category: template.category,
    zohoUserId: input.zohoUserId,
    userName: input.userName,
  });
}
