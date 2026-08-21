import type { ZohoContact } from "@/lib/zoho/contacts";

export const SUPPORTED_SMS_MERGE_FIELDS = [
  "First_Name",
  "Last_Name",
  "Full_Name",
] as const;

export type SmsMergeField = (typeof SUPPORTED_SMS_MERGE_FIELDS)[number];

export function zohoContactDisplayName(contact: ZohoContact): string {
  return (
    contact.Full_Name?.trim() ||
    [contact.First_Name, contact.Last_Name].filter(Boolean).join(" ").trim() ||
    "Contact"
  );
}

export function renderSmsTemplate(template: string, contact: ZohoContact): string {
  const values: Record<SmsMergeField, string> = {
    First_Name: contact.First_Name?.trim() ?? "",
    Last_Name: contact.Last_Name?.trim() ?? "",
    Full_Name: zohoContactDisplayName(contact),
  };

  return template.replace(
    /\{\{\s*(First_Name|Last_Name|Full_Name)\s*\}\}/g,
    (_match, key: SmsMergeField) => values[key] ?? "",
  );
}
