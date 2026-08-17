# MCC Messaging

Dedicated conversational messaging service for Military Creator Con.

This repository owns the secure messaging boundary between Zoho CRM, Twilio, Supabase, and the MCC staff messaging surfaces. It is intentionally deployed separately from the public MCC website so messaging webhooks and staff communications have an independent deployment lifecycle.

## Reference documentation

Before adapting this system for another client, read:

- [`docs/MESSAGING-REFERENCE-ARCHITECTURE.md`](docs/MESSAGING-REFERENCE-ARCHITECTURE.md) — architecture, invariants, failure handling, security, idempotency, reconciliation, bulk SMS, CRM/Cliq surfaces, and reusable design decisions.
- [`docs/ZOHO-TWILIO-MESSAGING-ADAPTATION-PLAYBOOK.md`](docs/ZOHO-TWILIO-MESSAGING-ADAPTATION-PLAYBOOK.md) — step-by-step client adaptation playbook, including the Trident Inspection Group kickoff prompt.

MCC is the proven **reference implementation**. Do not copy MCC-specific Zoho IDs, Twilio configuration, Supabase/Vercel identifiers, OAuth credentials, profile/layout IDs, or business assumptions into another client deployment.

## Current responsibilities

- Receive and validate inbound Twilio SMS webhooks.
- Resolve inbound numbers safely against the configured Zoho CRM Contact phone field.
- Persist matched and unmatched conversations/messages canonically in Supabase.
- Send one-to-one SMS from Zoho CRM and Zoho Cliq.
- Provide a Contact `Message` quick action and related-list conversation widget.
- Provide the shared `MCC Messages` CRM Web Tab.
- Receive and normalize Twilio delivery-status callbacks.
- Enforce STOP/START opt-out state.
- Protect outbound sends with server-side idempotency.
- Maintain a self-healing, versioned Supabase → Zoho CRM conversation projection.
- Provide persistent bulk SMS jobs, recipient processing, and delivery reporting.
- Provide the `MCC Bulk Sends` reporting Web Tab.
- Provide MCC team messaging access through Zoho Cliq.

## Infrastructure

- Runtime: Next.js on Vercel
- Messaging transport: Twilio Programmable Messaging
- CRM: Zoho CRM API
- Canonical messaging database: Military Creator Con Supabase project
- CRM conversation projection module API name: `Messaging_Conversations`

## Core system rule

Supabase is canonical for conversation/message state. Zoho CRM is the customer/business system of record and receives a recoverable conversation-summary projection. Twilio is transport.

Historical conversation phone snapshots are preserved when a CRM Contact phone changes, and inbound identity is never guessed when multiple CRM Contacts share the same normalized phone number.

## Local setup

1. Copy `.env.example` to `.env.local`.
2. Add server-side credentials only. Never commit secrets.
3. Run `npm install`.
4. Run `npm run dev`.

## Security boundary

Twilio, Zoho OAuth, service keys, and Supabase privileged credentials are server-only. CRM widgets and future mobile clients must never contain those secrets.

Twilio webhook signatures are validated before processing. Browser-facing CRM widgets use a secure server-side gateway/proxy rather than calling Twilio or privileged Supabase APIs directly.
