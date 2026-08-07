import { parsePhoneNumberFromString } from "libphonenumber-js";

export function normalizePhone(input: string, defaultCountry: "US" = "US"): string {
  const parsed = parsePhoneNumberFromString(input, defaultCountry);
  if (!parsed || !parsed.isPossible()) {
    throw new Error(`Invalid phone number: ${input}`);
  }
  return parsed.number;
}

export function tryNormalizePhone(input?: string | null): string | null {
  if (!input) return null;
  try {
    return normalizePhone(input);
  } catch {
    return null;
  }
}
