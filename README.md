# MCC Messaging

Dedicated messaging service for Military Creator Con.

This repository owns the secure messaging boundary between Zoho CRM, Twilio, and the MCC Supabase project. It is intentionally deployed separately from the public MCC website so messaging webhooks and staff communications have an independent deployment lifecycle.

## V1 responsibilities

- Receive inbound Twilio SMS webhooks
- Validate `X-Twilio-Signature`
- Match inbound phone numbers to `Contacts.Phone` in Zoho CRM
- Create/find a Messaging Conversation
- Persist conversations and individual messages in Supabase
- Send outbound SMS from the future Zoho CRM widget
- Receive Twilio delivery status callbacks
- Update the Zoho `Messaging_Conversations` summary record

## Infrastructure

- Runtime: Next.js 16 on Vercel
- Messaging: Twilio Programmable Messaging
- CRM: Zoho CRM API v8
- Database: existing Military Creator Con Supabase project
- CRM conversation module API name: `Messaging_Conversations`

## Local setup

1. Copy `.env.example` to `.env.local`.
2. Add server-side credentials only. Never commit secrets.
3. Run `npm install`.
4. Run `npm run dev`.

## Security boundary

Twilio and Zoho credentials are server-only. Supabase service-role credentials are server-only. The Zoho widget must never contain Twilio, Zoho OAuth, or Supabase admin credentials.

Twilio webhooks are signature-validated before processing. The outbound API is protected by a server-side service key until the Zoho widget authentication bridge is added.
