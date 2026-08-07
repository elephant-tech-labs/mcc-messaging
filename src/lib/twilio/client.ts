import twilio, { type Twilio } from "twilio";
import { requiredEnv } from "@/lib/env";

let client: Twilio | null = null;

export function getTwilioClient(): Twilio {
  if (!client) {
    client = twilio(
      requiredEnv("TWILIO_ACCOUNT_SID"),
      requiredEnv("TWILIO_AUTH_TOKEN"),
    );
  }

  return client;
}
