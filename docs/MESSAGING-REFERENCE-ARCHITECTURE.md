# MCC Messaging Reference Architecture

> Reference implementation for Elephant Tech Labs: Zoho CRM + Twilio conversational SMS.
>
> Last updated: 2026-08-17
>
> This document describes the architectural decisions, invariants, failure handling, and reusable patterns behind the Military Creator Con messaging system. It is intentionally more than a code map. The repository shows *what* exists; this document explains *why* it exists and which rules must be preserved when adapting the system for another client.

---

## 1. Purpose

MCC Messaging turns a normal Twilio SMS number into a conversational messaging workspace centered around Zoho CRM Contacts.

The system provides:

- one-to-one SMS from a Zoho CRM Contact;
- a shared WhatsApp-style CRM inbox;
- inbound SMS capture and Contact matching;
- Twilio delivery-status tracking;
- unread counts;
- STOP / START opt-out handling;
- bulk SMS from selected CRM Contacts;
- bulk-send reporting;
- Zoho Cliq access for the MCC team;
- server-side send idempotency;
- self-healing Supabase-to-Zoho CRM projection;
- a backend architecture that can later support a dedicated mobile app or a multi-tenant Zoho Marketplace product.

The design objective is not merely "send SMS from Zoho." It is to maintain a durable, auditable conversation system that remains correct when Twilio, Zoho, a browser, a webhook, or a network request temporarily fails.

---

## 2. Core architecture

```text
                    Zoho CRM
          Contacts / Widgets / Web Tabs
                         |
                         | secure server calls
                         v
                  Vercel / Next.js
                 MCC Messaging Backend
                  /       |        \
                 /        |         \
                v         v          v
           Supabase     Twilio     Zoho CRM API
          canonical      SMS        projection
            store      transport
                |
                +--------------------------+
                |                          |
                v                          v
             Zoho Cliq                future mobile app
```

### Platform responsibilities

**Twilio**

- transports SMS;
- receives inbound SMS from carriers;
- emits delivery-status callbacks;
- owns transport-level message SIDs and carrier status.

**Supabase**

- is the canonical application store for conversations and messages;
- stores bulk jobs/recipients;
- stores idempotency reservations;
- tracks CRM projection health/versioning;
- must remain the source of truth when Zoho projection temporarily fails.

**Zoho CRM**

- is the business/customer system of record;
- owns Contacts and business context;
- contains a `Messaging Conversations` projection module;
- hosts the staff-facing messaging widgets and Web Tabs;
- is not the canonical message history database.

**Vercel / Next.js**

- contains all privileged backend logic;
- owns Twilio and Zoho credentials;
- validates webhook signatures;
- normalizes phones;
- enforces opt-out and self-send rules;
- performs identity resolution;
- exposes the secure application APIs used by CRM widgets/Cliq;
- never exposes Twilio/Zoho/Supabase service credentials to the browser.

**Zoho Cliq**

- is an alternate staff UI for message notifications and replies;
- does not become a second messaging backend;
- uses the same Vercel/Supabase/Twilio core.

---

## 3. Non-negotiable architectural invariants

These rules are more important than individual implementation details.

### 3.1 Supabase is canonical for messaging

If a message is persisted in Supabase but a Zoho CRM update fails, the message still exists and is considered authoritative.

The system must repair Zoho later. It must never make CRM projection failure equivalent to message loss.

### 3.2 Zoho CRM remains canonical for customer identity/business data

Contacts are not independently recreated as a second customer directory in Supabase.

Supabase conversation rows contain stable identifiers and snapshots needed for message history, but Zoho remains the authoritative source for Contact/business fields.

### 3.3 The transport phone field must be explicitly chosen per client

For MCC, the outbound phone source is:

`Contacts.Phone`

Do not silently switch to `Mobile`, even when both exist.

The same rule must be decided explicitly for every client implementation.

### 3.4 Phone numbers are normalized server-side

Phone identity must use canonical E.164 values.

Never rely on visual formatting such as:

- `(714) 555-1234`
- `714-555-1234`
- `+1 714 555 1234`

All routing/thread comparison uses normalized values.

### 3.5 A phone number is not guaranteed to uniquely identify a CRM Contact

Duplicate/shared numbers can exist.

Inbound matching must never guess between multiple Contacts that normalize to the same eligible phone value.

If identity is ambiguous, the inbound message must remain unmatched rather than being attached to the wrong person.

### 3.6 Historical thread identity is immutable

The conversation stores a snapshot of the customer phone used for that thread.

If a Contact's current Phone changes later:

- the historical thread keeps the old number;
- a new outbound message started from the Contact uses the current CRM Phone;
- replying inside an existing historical conversation uses that conversation's snapshotted phone.

This preserves correct history instead of rewriting old conversations.

### 3.7 Never send to the configured Twilio sender itself

The backend blocks any customer phone that normalizes to the MCC Twilio sender number.

This protects against CRM records accidentally containing the organization's own Twilio number.

### 3.8 Secrets live server-side only

Never place these in browser/mobile code:

- Twilio Auth Token;
- Zoho client secret;
- Zoho refresh token;
- Supabase service-role/secret key;
- MCC service key;
- widget gateway secret.

---

## 4. Canonical conversation identity

Conceptually, an SMS thread is keyed by:

```text
Zoho Contact ID
+ customer E.164 number
+ Twilio sender E.164 number
+ channel
```

For MCC the channel is currently `SMS`.

A typical uniqueness rule is therefore equivalent to:

```text
(zoho_contact_id, customer_phone, twilio_phone, channel)
```

This intentionally allows one Contact to have multiple historical conversations when the Contact's phone changes.

### Unmatched inbound conversations

Inbound messages may arrive from numbers that cannot be uniquely resolved to a CRM Contact.

Those messages are still durably stored with:

- customer phone;
- Twilio sender;
- channel;
- no Contact ID.

If a later inbound lookup can uniquely resolve the Contact, the unmatched conversation can be claimed/associated safely.

---

## 5. Supabase data model

The exact migration files in `supabase/migrations/` are the implementation source of truth. The important conceptual tables are below.

### 5.1 `messaging_conversations`

Stores one canonical row per conversation/thread.

Important state includes:

- internal UUID;
- Zoho Contact ID, nullable for unmatched inbound;
- Zoho Messaging Conversation record ID;
- customer phone snapshot;
- Twilio sender phone;
- channel;
- conversation status;
- last message summary;
- last message datetime;
- last message direction;
- last message status;
- unread count;
- last incoming/outgoing timestamps;
- opt-out status/date;
- created-from/source metadata;
- CRM reconciliation metadata.

### 5.2 `messaging_messages`

Canonical message history.

Important fields include:

- conversation UUID;
- unique Twilio Message SID;
- direction;
- body;
- transport status;
- from/to phone snapshots;
- media metadata;
- sender Zoho user ID/name when applicable;
- source (`Incoming SMS`, `CRM Widget`, `Cliq`, `Bulk SMS`, `Automation`, etc.);
- Twilio timestamps;
- delivery/error metadata.

Twilio Message SID uniqueness is an important duplicate-protection layer for webhook retries.

### 5.3 `bulk_sms_jobs`

Persistent bulk-send job header.

Stores:

- job metadata;
- template;
- status;
- selected/eligible/skipped counts;
- initiating Zoho user;
- timing.

### 5.4 `bulk_sms_recipients`

One persistent recipient row per selected Contact in a bulk job.

Stores:

- Contact snapshot;
- prepared/normalized phone;
- rendered message body;
- eligibility/skip reason;
- processing state;
- Twilio SID;
- conversation link;
- send/delivery errors;
- attempt metadata.

### 5.5 `messaging_send_requests`

Server-side send idempotency ledger.

Its purpose is to reserve an intentional send before Twilio transport is invoked so that browser/network/API retries cannot create duplicate SMS.

A completed reservation can return the original Twilio result instead of sending again.

### 5.6 CRM projection reconciliation metadata

`messaging_conversations` also tracks CRM projection health, including fields equivalent to:

- `crm_sync_needed`;
- `crm_projection_version`;
- `crm_synced_version`;
- `crm_last_synced_at`;
- `crm_last_sync_attempt_at`;
- `crm_sync_error`.

Canonical conversation mutations mark the Zoho projection dirty and increment the projection version.

---

## 6. Zoho CRM projection

### 6.1 `Messaging Conversations` module

MCC uses a custom CRM module with one record per messaging conversation, not one record per individual SMS.

The module includes business-readable fields such as:

- Contact lookup;
- Channel;
- Customer Phone;
- Twilio Phone;
- Conversation Status;
- External Conversation ID;
- Last Message;
- Last Message At;
- Last Message Direction;
- Last Message Status;
- Unread Count;
- Last Incoming At;
- Last Outgoing At;
- Opt Out Status;
- Opt Out Date;
- Created From.

Individual message history remains in Supabase.

### Why a projection module exists

It allows native Zoho CRM reporting/filtering/context without forcing thousands of individual SMS records into CRM.

The CRM record is a summary/projection of the canonical thread.

---

## 7. Staff-facing CRM surfaces

### 7.1 Contact `Message` quick action

A Contact custom button opens the same contextual message UI used by the related-list widget.

Use case:

- staff are already looking at a Contact;
- click `Message`;
- continue the conversation without navigating away.

### 7.2 Contact messaging related-list widget

Embedded conversational view on the Contact record.

Important UX behavior:

- internal message-pane scrolling;
- background polling does not move the CRM page;
- polling is Supabase-first;
- Contact metadata is not reloaded every poll;
- initial history is paginated;
- older messages load progressively;
- visible delivery-state changes are merged into the message list.

### 7.3 `MCC Messages` Web Tab

Shared WhatsApp-style messaging workspace.

Features include:

- recent conversations;
- unread mode;
- Contact search;
- selected conversation history;
- replies;
- New SMS flow;
- Contact context/Open CRM;
- read-state behavior;
- delivery indicators;
- incremental polling rather than repetitive full CRM reloads.

### 7.4 `MCC Bulk SMS` Contact mass action

Staff select Contacts from CRM list view and invoke the bulk workflow.

The workflow previews eligibility before creating a persistent job.

### 7.5 `MCC Bulk Sends` Web Tab

Operational/reporting view for recent bulk jobs, including:

- totals;
- delivered/sent/pending/failed/skipped counts;
- message/template;
- initiating staff member;
- problem-recipient details.

---

## 8. Outbound SMS lifecycle

Typical one-to-one send:

```text
CRM / Cliq / API
       |
       v
validate request
       |
       v
resolve Contact or existing conversation
       |
       v
normalize phone + self-send protection
       |
       v
check conversation opt-out
       |
       v
ensure/create canonical conversation
       |
       v
reserve idempotency request
       |
       v
Twilio messages.create()
       |
       v
record transport acceptance
       |
       v
persist messaging_messages row
       |
       v
update canonical conversation summary
       |
       +----> project to Zoho CRM immediately
       |
       +----> leave dirty for reconciliation if Zoho fails
```

### Important ordering principle

Idempotency reservation must happen before the Twilio send.

Once Twilio has accepted a message, backend failure handling must assume the SMS may be delivered and must never blindly repeat it.

---

## 9. Inbound SMS lifecycle

```text
Customer sends SMS
       |
       v
Twilio inbound webhook
       |
       v
validate Twilio signature
       |
       v
normalize From / To
       |
       v
confirm destination is configured MCC sender
       |
       v
attempt exact/unique Zoho Contact match
       |
       v
resolve matched or unmatched conversation
       |
       v
persist message by unique Twilio SID
       |
       v
update canonical summary + unread count
       |
       v
apply STOP / START state when applicable
       |
       +----> Zoho CRM projection
       |
       +----> Cliq notification
```

### Inbound identity safety

The system must not use "best-looking" Contact matching.

Exact normalized eligible phone matches only; if more than one Contact matches, leave the message unmatched.

---

## 10. Twilio delivery-status lifecycle

Twilio sends status callbacks after outbound acceptance.

The backend:

1. validates Twilio signature;
2. identifies the message by Message SID;
3. normalizes the incoming status;
4. applies only valid forward/terminal status transitions;
5. ignores stale/out-of-order regressions;
6. updates canonical message status;
7. updates the conversation's latest outgoing status when appropriate;
8. updates bulk-recipient projection only when the canonical callback was accepted;
9. reconciles Zoho CRM projection.

Examples of protection:

- `delivered` must not later regress to `sent` because of an out-of-order callback;
- a stale callback must not downgrade the bulk-send report.

---

## 11. Opt-out / STOP / START

Inbound standard opt-out words are processed centrally.

STOP-like keywords set the conversation to opted out.

START/UNSTOP-like keywords restore active messaging.

Outbound sending checks canonical opt-out state before transport.

This state is also projected into Zoho CRM.

When adapting to another client, review Twilio/carrier/legal messaging obligations rather than assuming the MCC keyword policy is sufficient for every jurisdiction/use case.

---

## 12. Server-side idempotency

### Problem

Without idempotency, any of the following can create duplicate customer messages:

- double click;
- browser retry;
- slow UI submission;
- reverse-proxy retry;
- API client retry;
- interrupted bulk processing.

### MCC solution

A server-side send request is reserved before Twilio is called.

The ledger records the request identity and eventual transport/result state.

The protected API also supports an explicit `Idempotency-Key` header.

Existing UI paths inherit duplicate protection through the shared send service.

A short automatic identical-request safety window is used as a fallback for legacy callers, while deterministic explicit keys are preferred where available.

### Critical safety rule

If Twilio may already have accepted the SMS, the server must fail closed against another send rather than assume the first attempt failed.

---

## 13. CRM self-healing reconciliation

Zoho CRM is a projection, and API calls can fail temporarily.

Canonical Supabase conversation mutations therefore mark the CRM projection dirty and increment a version.

Normal flow:

```text
canonical change
      |
      v
projection version N / dirty
      |
      v
immediate Zoho projection attempt
     / \
 success failure
   |       |
 clean    stays dirty
           |
           v
      repair worker
```

### Version-safety requirement

A repair attempt for version `N` must not mark the conversation clean if version `N+1` was created while the repair was running.

The reconciler re-reads/re-checks canonical version state before clearing the dirty flag.

### Current trigger for repair work

The current implementation performs opportunistic reconciliation during MCC messaging/inbox activity, throttled so normal UI requests are not overloaded.

A future timed Vercel Cron can be added for idle-time reconciliation if desired.

---

## 14. Bulk SMS architecture

Bulk sending is intentionally implemented as persistent jobs rather than the browser individually firing Twilio calls.

### Preparation

For each selected Contact the server:

- fetches CRM Contact data;
- uses the configured canonical phone field;
- normalizes to E.164;
- blocks the organization's sender number;
- checks opt-out;
- detects duplicate normalized phones within the selection;
- renders supported merge fields;
- validates message length;
- persists eligible/skipped recipient rows.

### Processing

Workers claim small recipient batches using database locking/claim semantics.

Each claimed recipient is sent through the same shared `sendSms()` service as individual SMS.

This means bulk messages inherit:

- phone normalization;
- self-send protection;
- opt-out enforcement;
- conversation creation;
- idempotency;
- canonical persistence;
- delivery callbacks;
- CRM projection.

### Crash philosophy

Do not automatically requeue an ambiguous mid-send `processing` row merely because the process stopped. If Twilio acceptance is uncertain, automatic retry can create a duplicate customer SMS.

Recovery must prefer reconciliation/idempotency over blind resend.

---

## 15. Zoho Cliq integration

Cliq is an alternate UI surface on top of the same backend.

Current capabilities include:

- inbound SMS notifications;
- reply;
- view conversation;
- open CRM;
- start new SMS through CRM Contact search;
- recent/unread inbox.

Cliq does not own message state.

The Cliq UX is considered stable/locked unless a client requirement specifically calls for changes.

---

## 16. Performance principles

The first implementation used frequent full reloads. It was later hardened for scale.

Current principles:

- polling should use Supabase for message/conversation state;
- do not re-fetch Zoho Contact metadata every few seconds;
- load a bounded recent message window;
- support older-message pagination;
- merge new/status-changed messages into existing UI state;
- preserve user scroll position;
- skip or reduce polling when the browser tab is hidden;
- avoid CRM API calls when CRM data is not actually changing.

---

## 17. Security model

### Server trust boundaries

CRM widgets never call Twilio directly.

```text
Zoho CRM widget
      |
      v
Zoho secure function/proxy
      |
      v
MCC Vercel gateway
      |
      +--> Supabase service client
      +--> Twilio
      +--> Zoho API
```

### Webhooks

Twilio inbound/status endpoints validate the Twilio request signature.

### Supabase browser exposure

Canonical messaging tables use RLS and are accessed through trusted backend code. Do not expose service-role privileges to browser code.

### Credentials

Document environment-variable names only. Never commit values.

Representative server-side variables include:

- `APP_BASE_URL`
- `MCC_SERVICE_KEY`
- `TWILIO_ACCOUNT_SID`
- `TWILIO_AUTH_TOKEN`
- `TWILIO_PHONE_NUMBER`
- `SUPABASE_URL`
- `SUPABASE_SECRET_KEY`
- `ZOHO_CLIENT_ID`
- `ZOHO_CLIENT_SECRET`
- `ZOHO_REFRESH_TOKEN`
- Zoho/Cliq endpoint configuration variables.

Any secret previously pasted into an interactive chat should eventually be rotated as production hygiene.

---

## 18. Failure-mode design

### Zoho unavailable during outbound

SMS + Supabase persistence remain authoritative. CRM projection is marked dirty and repaired later.

### Zoho unavailable during inbound identity lookup

Existing unique canonical conversation matching may be used where safe. Otherwise create/retain an unmatched conversation rather than drop the inbound SMS.

### Cliq unavailable

Inbound SMS remains canonical and CRM can still update. Cliq notification failure must not make Twilio retry already-persisted inbound data unnecessarily.

### Twilio status callback repeated/out of order

Message SID uniqueness + status transition rules prevent regression.

### Browser retries send

Server-side idempotency prevents duplicate Twilio messages.

### Contact phone changes

Historical conversation retains snapshot; new Contact-started conversation uses current CRM Phone.

### Duplicate Contact phone values

Never guess inbound Contact identity.

---

## 19. What is MCC-specific vs reusable

### Reusable patterns

- Supabase canonical message store;
- Zoho projection model;
- Twilio webhook/status handling;
- shared send service;
- phone normalization;
- immutable historical phone snapshots;
- unmatched inbound handling;
- duplicate-phone safety;
- idempotency ledger;
- projection reconciliation;
- paginated/polling CRM chat UI patterns;
- bulk job architecture;
- server-side security boundaries.

### MCC-specific configuration

Do not copy blindly:

- Zoho org/module/field/layout/profile IDs;
- widget IDs;
- custom button IDs;
- Web Tab IDs;
- Twilio account/number;
- Supabase project;
- Vercel project;
- OAuth clients/tokens;
- service/widget secrets;
- Cliq bot IDs;
- MCC-specific field picklist quirks;
- MCC-specific profile/layout access;
- MCC business/compliance assumptions.

---

## 20. Existing legacy systems and migration rule

During MCC implementation, older Zoho/Twilio/Flow functionality was deliberately left in place until the new equivalent was proven.

This is the recommended rollout pattern for every client:

1. audit current production SMS routes;
2. build the replacement in parallel;
3. run controlled tests;
4. prove inbound/outbound/status/bulk flows;
5. only then disable or remove legacy functionality;
6. preserve rollback capability until stable.

Never remove an old production path merely because a new implementation compiles.

---

## 21. Current maturity / remaining enhancements

The MCC system is production-capable and has proven one-to-one, inbound, CRM inbox, Contact quick action, Cliq and bulk SMS workflows.

Potential future improvements include:

- timed Vercel Cron for idle reconciliation;
- a dedicated admin/recovery surface for ambiguous bulk `processing` rows;
- additional large-scale rate/throughput governance;
- richer Twilio error/retry UX;
- per-user/team unread semantics if needed;
- multiple Twilio numbers/channels;
- deeper reporting;
- a dedicated MCC iOS app;
- conversion into a true multi-tenant Zoho Marketplace SaaS.

---

## 22. Future mobile-client architecture

A future MCC mobile app should be a new authenticated frontend, not a separate messaging backend.

Recommended pattern:

```text
React Native / Expo app
          |
          | authenticated API
          v
Vercel MCC backend
   |       |       |
Supabase  Zoho   Twilio
```

Zoho CRM remains the Contact/business source of truth. Twilio/Zoho secrets remain server-side. Push notification tokens can be stored per authenticated staff user/device.

---

## 23. Future Marketplace-product architecture

The MCC repository is a single-client reference implementation.

A Marketplace product must not simply package MCC configuration. It requires a multi-tenant foundation:

```text
Organizations
  -> Zoho org connection
  -> Twilio connection(s)
  -> users
  -> tenant-scoped conversations/messages
  -> tenant-scoped webhook routing
  -> plan/billing/configuration
```

Every query, credential and webhook must be tenant-isolated.

Use MCC for proven messaging logic and UX patterns, not as a substitute for multi-tenant product architecture.

---

## 24. Repository areas to inspect when adapting

At minimum, an engineer/agent should inspect:

- `src/lib/messaging/`
- `src/lib/zoho/`
- `src/lib/twilio/`
- `src/lib/supabase/`
- `src/app/api/twilio/`
- `src/app/api/messages/`
- `src/app/api/widget/`
- `src/app/widget/contact/`
- `src/app/widget/inbox/`
- `src/app/widget/bulk/`
- `src/app/widget/bulk-history/`
- `src/app/api/cliq/`
- `supabase/migrations/`

Do not rely only on this document if the repository has changed more recently. The implementation and migrations are the final technical source of truth; this document preserves the architectural intent behind them.
