import { tryNormalizePhone } from "@/lib/phone/normalize";
import { zohoFetch } from "@/lib/zoho/client";

export type ZohoContact = {
  id: string;
  Full_Name?: string;
  First_Name?: string;
  Last_Name?: string;
  Phone?: string;
  Mobile?: string;
  Email?: string;
  Status?: string;
  Owner?: {
    id?: string;
    name?: string;
    email?: string;
  };
};

type ZohoDataResponse<T> = { data?: T[] };

const CONTACT_FIELDS = "Full_Name,First_Name,Last_Name,Phone,Mobile,Email,Status,Owner";

export async function getZohoContactById(id: string): Promise<ZohoContact | null> {
  const response = await zohoFetch<ZohoDataResponse<ZohoContact>>(
    `/crm/v8/Contacts/${encodeURIComponent(id)}?fields=${CONTACT_FIELDS}`,
  );

  return response.data?.[0] ?? null;
}

export async function getZohoContactsByIds(ids: string[]): Promise<ZohoContact[]> {
  const uniqueIds = [...new Set(ids.map((id) => id.trim()).filter(Boolean))].slice(0, 2000);
  if (uniqueIds.length === 0) return [];

  const chunks: string[][] = [];
  for (let index = 0; index < uniqueIds.length; index += 100) {
    chunks.push(uniqueIds.slice(index, index + 100));
  }

  const contacts: ZohoContact[] = [];
  for (let index = 0; index < chunks.length; index += 4) {
    const batch = chunks.slice(index, index + 4);
    const responses = await Promise.all(
      batch.map((chunk) =>
        zohoFetch<ZohoDataResponse<ZohoContact>>(
          `/crm/v8/Contacts?ids=${encodeURIComponent(chunk.join(","))}&fields=${CONTACT_FIELDS}&per_page=100`,
        ),
      ),
    );
    for (const response of responses) contacts.push(...(response.data ?? []));
  }

  return contacts;
}

export async function findZohoContactByPhone(e164Phone: string): Promise<ZohoContact | null> {
  const response = await zohoFetch<ZohoDataResponse<ZohoContact>>(
    `/crm/v8/Contacts/search?phone=${encodeURIComponent(e164Phone)}&fields=${CONTACT_FIELDS}&per_page=20`,
  );

  const matches = (response.data ?? []).filter(
    (contact) => tryNormalizePhone(contact.Phone) === e164Phone,
  );

  // Never guess between two CRM Contacts that share the same canonical Phone value.
  return matches.length === 1 ? matches[0] : null;
}

export async function searchZohoContacts(
  query: string,
  limit = 20,
): Promise<ZohoContact[]> {
  const word = query.trim();
  if (word.length < 2) return [];

  const response = await zohoFetch<ZohoDataResponse<ZohoContact>>(
    `/crm/v8/Contacts/search?word=${encodeURIComponent(word)}&fields=${CONTACT_FIELDS}&per_page=${Math.max(1, Math.min(200, limit))}`,
  );

  // Only Contacts.Phone is eligible for MCC SMS. Mobile-only matches are shown
  // nowhere so staff cannot accidentally send through the wrong field.
  return (response.data ?? [])
    .filter((contact) => Boolean(contact.Phone?.trim()))
    .slice(0, Math.max(1, Math.min(100, limit)));
}
