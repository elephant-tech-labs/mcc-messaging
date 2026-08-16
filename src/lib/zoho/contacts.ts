import { tryNormalizePhone } from "@/lib/phone/normalize";
import { zohoFetch } from "@/lib/zoho/client";

export type ZohoContact = {
  id: string;
  Full_Name?: string;
  First_Name?: string;
  Last_Name?: string;
  Phone?: string;
  Mobile?: string;
};

type ZohoDataResponse<T> = { data?: T[] };

export async function getZohoContactById(id: string): Promise<ZohoContact | null> {
  const response = await zohoFetch<ZohoDataResponse<ZohoContact>>(
    `/crm/v8/Contacts/${encodeURIComponent(id)}?fields=Full_Name,First_Name,Last_Name,Phone,Mobile`,
  );

  return response.data?.[0] ?? null;
}

export async function findZohoContactByPhone(e164Phone: string): Promise<ZohoContact | null> {
  const response = await zohoFetch<ZohoDataResponse<ZohoContact>>(
    `/crm/v8/Contacts/search?phone=${encodeURIComponent(e164Phone)}&fields=Full_Name,First_Name,Last_Name,Phone,Mobile&per_page=20`,
  );

  const matches = response.data ?? [];

  // Contacts.Phone is the canonical MCC SMS field. Zoho's phone search checks all
  // phone fields, so explicitly reject a result that matched only Mobile.
  return (
    matches.find((contact) => tryNormalizePhone(contact.Phone) === e164Phone) ?? null
  );
}

export async function searchZohoContacts(
  query: string,
  limit = 20,
): Promise<ZohoContact[]> {
  const word = query.trim();
  if (word.length < 2) return [];

  const response = await zohoFetch<ZohoDataResponse<ZohoContact>>(
    `/crm/v8/Contacts/search?word=${encodeURIComponent(word)}&fields=Full_Name,First_Name,Last_Name,Phone,Mobile&per_page=${Math.max(1, Math.min(200, limit))}`,
  );

  // Only Contacts.Phone is eligible for MCC SMS. Mobile-only matches are shown
  // nowhere in Cliq so staff cannot accidentally send through the wrong field.
  return (response.data ?? [])
    .filter((contact) => Boolean(contact.Phone?.trim()))
    .slice(0, Math.max(1, Math.min(100, limit)));
}
