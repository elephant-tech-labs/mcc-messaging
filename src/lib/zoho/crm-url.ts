import { optionalEnv } from "@/lib/env";

function crmWebBase(): string {
  return (optionalEnv("ZOHO_CRM_WEB_BASE", "https://crm.zoho.com") ?? "https://crm.zoho.com").replace(/\/$/, "");
}

export function zohoContactRecordUrl(contactId: string): string {
  return `${crmWebBase()}/crm/tab/Contacts/${encodeURIComponent(contactId)}`;
}
