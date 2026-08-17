# Zoho + Twilio Messaging Adaptation Playbook

> How to adapt the proven MCC Messaging architecture to another Elephant Tech Labs client without copying client-specific configuration.
>
> Primary reference: `docs/MESSAGING-REFERENCE-ARCHITECTURE.md`
>
> Last updated: 2026-08-17

---

## 1. Purpose

This playbook exists because the MCC Messaging implementation is now a useful reference architecture, but it is **not** a generic drop-in package.

For a new client, reuse the proven architectural patterns while first auditing that client's real environment.

The correct mental model is:

```text
MCC Messaging
= proven reference implementation

New client
= new deployment based on the reference
  after client-specific audit and design
```

Do not turn a new implementation into a find-and-replace exercise.

---

## 2. Required operating mode for a new client chat/agent

Before writing code, the implementation chat should use all connected tools available to it.

For Elephant Tech Labs projects this may include direct access to:

- GitHub;
- Zoho CRM;
- Supabase;
- Vercel;
- other relevant connected services.

### Important instruction

If the chat can inspect a configuration itself, it should **inspect it instead of asking the user to manually copy IDs, schemas, field names, project settings or code**.

Examples:

- inspect Zoho CRM modules/fields/layouts/buttons/widgets;
- inspect the client's existing GitHub repositories;
- inspect Vercel project/deployment/environment-variable *names*;
- inspect Supabase schemas/migrations;
- inspect existing webhook routes/integrations in code;
- inspect current automation/functions before proposing replacements.

Never retrieve or echo secret values merely for documentation. Use secret names/configuration presence when possible.

---

## 3. Start read-only

The first pass must be an audit.

Do not immediately:

- create Zoho modules;
- change Twilio webhooks;
- deploy migrations;
- delete old extensions;
- disable Zoho Flow;
- repoint production numbers;
- add production buttons;
- replace existing SMS automation.

First understand what is already live.

---

## 4. Phase 0: Read the MCC reference implementation

Before client-specific design, read:

1. `docs/MESSAGING-REFERENCE-ARCHITECTURE.md`
2. this playbook;
3. the current `mcc-messaging` source code;
4. the current Supabase migrations.

Pay particular attention to:

- conversation identity;
- immutable phone snapshots;
- inbound ambiguous-phone handling;
- server-side idempotency;
- Twilio status monotonicity;
- bulk recipient job semantics;
- CRM projection reconciliation;
- security boundaries.

These are the parts most likely to be accidentally weakened when copying only UI code.

---

## 5. Phase 1: Audit the new client's existing environment

Produce a concrete inventory before implementation.

### 5.1 Zoho CRM audit

Identify:

- organization/client context;
- Contacts module configuration;
- relevant additional modules;
- exact candidate phone fields;
- whether phone values are consistently populated;
- duplicate/shared phone risks;
- layouts;
- profiles/users that need messaging;
- existing messaging modules;
- existing custom buttons;
- existing widgets/Web Tabs;
- existing related lists;
- existing workflows/functions;
- existing Zoho Flow automations;
- existing marketplace SMS/Twilio extensions;
- current opt-out fields/process;
- any existing SMS history stored in CRM.

### 5.2 Twilio audit

Identify without changing production:

- account/subaccount used by the client;
- messaging sender number(s);
- Messaging Service if any;
- current inbound webhook URL;
- current status-callback behavior;
- existing sender configuration;
- current automations/services that send through the same number;
- A2P/registration/compliance configuration as relevant;
- whether the number is shared with any non-CRM system.

### 5.3 Supabase audit

Determine:

- whether the client already has a Supabase project;
- whether messaging should live in that project or an isolated project;
- existing schemas/tables/functions;
- naming collision risk;
- RLS posture;
- existing service usage;
- migration conventions;
- backup/production expectations.

### 5.4 Vercel audit

Determine:

- existing client Vercel project(s);
- whether messaging belongs in an existing application or a separate service;
- Git integration;
- production domains;
- framework/runtime;
- existing environment-variable names;
- deployment regions;
- any existing APIs/webhooks relevant to Twilio/Zoho;
- production/preview separation.

### 5.5 GitHub audit

Determine:

- correct client repository or whether a new messaging repository is appropriate;
- current app architecture;
- existing integration code;
- existing migrations;
- current deployment linkage;
- secret-handling conventions;
- branch/release model.

### 5.6 Current operational workflow audit

Ask/inspect:

- Who currently sends SMS?
- From where?
- Which client records are messaged?
- Is SMS one-to-one, automated, bulk, or all three?
- Who needs inbound notifications?
- Does the team need a shared inbox?
- Does the team need Cliq?
- Does the team need mobile push later?
- Is message ownership/assignment needed?
- Which existing workflow must not be interrupted?

---

## 6. Phase 2: Write a client-specific architecture decision record

Before implementation, explicitly decide the following.

### 6.1 Canonical CRM entity

For MCC the identity anchor is a Zoho Contact.

For another client confirm whether messaging should anchor to:

- Contact;
- Lead;
- Deal-related Contact;
- another module plus Contact lookup;
- more than one entity type.

Do not assume Contacts merely because MCC uses Contacts.

### 6.2 Canonical outbound phone field

Choose exactly one default transport field for each supported entity.

Examples:

- `Contacts.Phone`;
- `Contacts.Mobile`;
- a client-specific SMS Phone custom field.

Document the decision.

Never silently fall back from one field to another without an explicit product rule.

### 6.3 Twilio sender model

Decide:

- one number or several;
- number per team/branch/location;
- Messaging Service or direct `from` number;
- how inbound routing resolves the correct tenant/client/branch.

### 6.4 Conversation key

Recommended base identity:

```text
CRM entity/contact ID
+ canonical customer phone
+ Twilio sender
+ channel
```

If the client needs multiple branches/numbers/channels, include the correct dimensions rather than weakening uniqueness.

### 6.5 Historical phone behavior

Recommended default: preserve historical thread phone snapshots exactly as MCC does.

If business requirements differ, document why.

### 6.6 Duplicate/shared-number behavior

Recommended invariant: never infer identity when multiple CRM records share the same canonical phone.

Choose an explicit resolution workflow if ambiguous inbound messages are common.

### 6.7 Staff surfaces

Select only what the client needs:

- record-level Message button;
- related-list conversation widget;
- full shared inbox Web Tab;
- bulk SMS mass action;
- bulk reporting Web Tab;
- Zoho Cliq;
- mobile app later.

Do not implement every MCC surface by default.

---

## 7. Phase 3: Decide deployment topology

### Option A: Separate messaging service per client

Recommended for most agency/client isolation.

```text
client-messaging repo
      |
      v
client Vercel project
      |
      +--> client Supabase
      +--> client Zoho
      +--> client Twilio
```

Benefits:

- strong client isolation;
- simple secrets;
- simple incident boundaries;
- easier client handoff;
- reduced cross-client blast radius.

### Option B: Messaging code inside an existing client app

Suitable when the client already has a mature server-side app and operational ownership clearly belongs there.

Must still preserve server-side secret separation and webhook correctness.

### Do not use a multi-client shared backend accidentally

If several clients share one Vercel/Supabase service, that is a **multi-tenant product architecture** and needs tenant isolation everywhere. Do not drift into it informally.

---

## 8. Phase 4: Build the database foundation

Adapt the MCC migrations rather than manually recreating tables through a dashboard.

Recommended conceptual components:

- `messaging_conversations`;
- `messaging_messages`;
- send-idempotency ledger;
- CRM projection reconciliation metadata;
- bulk tables only if bulk SMS is required;
- unread helper/RPC if used;
- indexes/uniqueness rules;
- RLS enabled for application tables.

### Client-specific changes may include

- naming prefix/schema;
- CRM entity identifiers;
- sender/branch dimension;
- additional channel support;
- message source values;
- retention rules.

Commit all schema changes as migrations.

---

## 9. Phase 5: Build the backend before the CRM UI

Recommended order:

1. environment validation;
2. phone normalization;
3. Zoho OAuth/API client;
4. CRM entity lookup helpers;
5. Supabase admin repository;
6. Twilio client;
7. webhook signature validation;
8. canonical conversation repository;
9. outbound send service;
10. server-side idempotency;
11. inbound webhook;
12. delivery-status webhook;
13. opt-out handling;
14. CRM projection service;
15. reconciliation worker;
16. health/readiness endpoints.

The CRM UI should use this backend. Do not make widget JavaScript the primary business-logic layer.

---

## 10. Phase 6: Configure Zoho CRM projection

If the client needs CRM-native thread summaries, create/adapt a `Messaging Conversations` module.

Recommended fields are conceptually the same as MCC:

- CRM Contact/entity lookup;
- channel;
- customer phone snapshot;
- sender phone;
- conversation status;
- external/canonical conversation ID;
- last message;
- last message timestamp;
- direction;
- message status;
- unread count;
- last incoming/outgoing timestamps;
- opt-out state/date;
- created-from/source.

Use the client's actual layouts/profiles and API names.

Do not reuse MCC IDs.

---

## 11. Phase 7: Prove one-to-one outbound first

Create the smallest controlled flow:

```text
one known CRM record
      -> backend
      -> Twilio
      -> test phone
      -> Supabase
      -> CRM projection
```

Validate:

- exact correct phone field;
- E.164 normalization;
- self-send guard;
- message arrives once;
- Twilio SID persisted;
- conversation summary correct;
- CRM projection correct;
- sender/staff identity correct.

Do not proceed to bulk sending until this is reliable.

---

## 12. Phase 8: Prove inbound

Before repointing a production number, understand the existing webhook owner.

When safe, validate:

- Twilio signature;
- configured destination number;
- exact/unique Contact match;
- unmatched inbound behavior;
- duplicate webhook retry behavior;
- Supabase message persistence;
- unread count;
- CRM projection;
- staff notification surface.

Never discard unmatched inbound just because CRM identity cannot be resolved.

---

## 13. Phase 9: Delivery status

Validate at least:

- accepted/queued;
- sent;
- delivered;
- failed/undelivered where possible;
- out-of-order callbacks;
- repeated callbacks.

Canonical status should only move according to allowed transition rules.

---

## 14. Phase 10: CRM user experience

Implement client-appropriate surfaces after the backend is proven.

### Record quick action

Reusing the MCC pattern is usually valuable:

`Message` -> contextual conversation widget.

### Related-list widget

Useful when conversation context should be visible directly on the record.

### Shared inbox

Useful when multiple staff need a centralized messaging workspace.

Apply MCC performance lessons from the beginning:

- Supabase-first polling;
- bounded history;
- pagination;
- minimal CRM API reloads;
- preserved scroll state;
- hidden-tab polling reduction.

---

## 15. Phase 11: Bulk SMS only after one-to-one is stable

If required, adapt the MCC persistent-job approach.

Do not implement bulk as:

```text
browser loop -> Twilio send for each recipient
```

Use:

```text
selection
 -> server preview
 -> persistent job/recipients
 -> controlled claims/batches
 -> shared send service
 -> delivery callbacks/reporting
```

Before allowing a campaign, validate:

- canonical phone field;
- duplicates;
- opt-out;
- self-send;
- merge rendering;
- body length;
- recipient count;
- sender identity;
- recovery behavior.

---

## 16. Phase 12: Add idempotency before broad staff rollout

Every intentional send should become non-repeatable under browser/API retries.

Prefer explicit deterministic keys where possible.

Bulk recipient sends should use stable recipient/job-derived request identity rather than a random key generated during each retry.

Treat "Twilio might already have accepted this SMS" as a no-blind-retry condition.

---

## 17. Phase 13: Add self-healing CRM projection

Supabase canonical state and CRM summary can temporarily diverge during Zoho API failure.

Use versioned dirty-state reconciliation as in MCC.

Recommended behavior:

- canonical mutation marks dirty;
- immediate projection attempt;
- failure remains dirty;
- repair worker retries;
- version check prevents an older repair from marking newer data clean.

For a high-volume/always-on client, strongly consider a timed Vercel Cron in addition to opportunistic repair.

---

## 18. Phase 14: Optional Zoho Cliq

Only implement if the team actually works in Cliq.

If used, keep the same principle:

Cliq is another UI client of the canonical messaging backend, not an independent messaging database.

Possible functions:

- inbound alert;
- reply;
- recent/unread;
- new SMS;
- view/open CRM.

---

## 19. Phase 15: Controlled migration from legacy SMS

Do not remove the existing production system first.

Use parallel proof:

```text
legacy path remains available
          +
new messaging system is tested
          |
          v
controlled acceptance
          |
          v
cutover decision
```

Before disabling a legacy path, prove:

- one-to-one outbound;
- inbound;
- delivery callbacks;
- opt-out;
- shared inbox/record UI;
- idempotency;
- CRM reconciliation;
- bulk if applicable;
- staff permissions;
- rollback plan.

Only then remove/deactivate old buttons/extensions/Flow/webhooks when the user explicitly approves it.

---

## 20. Do not copy these MCC values to a new client

Never copy client-specific values blindly, including:

- Zoho record/module IDs;
- layout IDs;
- profile IDs;
- widget IDs;
- button IDs;
- Web Tab IDs;
- Twilio account SID;
- Auth Token;
- sender number;
- Messaging Service SID;
- MCC Supabase project URL/ref;
- MCC Vercel project ID/domain;
- Zoho OAuth credentials;
- Cliq OAuth/bot IDs;
- service keys;
- widget keys;
- MCC Contact-field assumption;
- MCC picklist quirks;
- MCC compliance/operational assumptions.

---

## 21. Trident Inspection Group adaptation notes

For the Trident implementation, the working chat should treat MCC as the reference and then audit Trident's real environment directly.

The Trident chat is expected to have access to the same connected tool ecosystem, including the relevant:

- Zoho CRM;
- Supabase;
- Vercel;
- GitHub repositories.

Therefore it should **use those connectors first** instead of asking the user to enumerate existing fields/projects/configuration manually.

### Trident discovery questions the tools should answer

At minimum:

1. Which Zoho CRM module/entity should anchor conversations?
2. Which exact CRM phone field is currently used for Trident SMS?
3. Which Twilio number/account/service is already active?
4. What current Zoho Flow/functions/extensions send SMS today?
5. Are current SMS messages associated with Contacts, Deals, or both?
6. Which users need the shared inbox/Message button?
7. Does Trident need bulk SMS immediately?
8. Does Trident need Cliq, or only CRM?
9. Which Supabase project should host messaging tables?
10. Which Vercel project/repository should own the messaging backend?
11. Which current Twilio inbound/status webhooks must be preserved during parallel rollout?
12. Are there existing customer opt-out fields/processes that must be integrated?

Do not answer these by assuming MCC's answers.

---

## 22. Recommended Trident implementation strategy

Unless the audit reveals a better fit:

```text
MCC code/reference
       |
       | learn/reuse patterns
       v
Trident-specific messaging backend
       |
       +--> Trident Zoho CRM
       +--> Trident Twilio
       +--> Trident Supabase
       +--> Trident Vercel
```

Prefer a separate Trident codebase/deployment from MCC so failures, secrets, releases and ownership are client-isolated.

Reuse code deliberately through copying/refactoring only after understanding dependencies. Do not make Trident import runtime code directly from MCC production.

---

## 23. Implementation output expected from the Trident chat

After the read-only audit, the chat should produce a concise client-specific design containing:

### Current-state inventory

- current SMS architecture;
- relevant Zoho modules/fields;
- Twilio configuration;
- Supabase/Vercel/GitHub context;
- legacy dependencies.

### Target architecture

- canonical CRM identity;
- phone field;
- thread key;
- sender model;
- Supabase schema adaptation;
- CRM projection;
- UI surfaces;
- inbound/outbound/status flow;
- idempotency;
- reconciliation;
- bulk/Cliq decision.

### Reuse matrix

Explicitly classify MCC components as:

- reuse essentially unchanged;
- reuse with configuration abstraction;
- rewrite/adapt for Trident;
- not needed.

### Safe implementation sequence

Define small proof checkpoints so the existing Trident production messaging remains available until replacement is verified.

---

## 24. Copy/paste kickoff prompt for the Trident branch

Use the following prompt in the Trident implementation chat:

> We are building a Twilio conversational SMS system for **Trident Inspection Group**, using the proven Military Creator Con messaging system as the **reference architecture**, not as configuration to copy blindly.
>
> MCC reference repository: `elephant-tech-labs/mcc-messaging`
>
> FIRST read these files in that repository:
> - `docs/MESSAGING-REFERENCE-ARCHITECTURE.md`
> - `docs/ZOHO-TWILIO-MESSAGING-ADAPTATION-PLAYBOOK.md`
>
> Then inspect the current MCC implementation/migrations where needed to understand the actual code behind those decisions.
>
> You also have connected access to our relevant **Zoho CRM, Supabase, Vercel and GitHub** environments. Use those tools proactively to audit Trident's actual configuration. Do not ask me to manually provide module IDs, field API names, schemas, existing code, Vercel projects, Supabase tables or similar information when you can retrieve it through the connected tools. Never expose or repeat secret values.
>
> Start **read-only**. Do not change Trident production configuration yet.
>
> Audit Trident's current messaging environment, especially:
> - existing Zoho CRM Contacts/Deals and relevant phone fields;
> - current Twilio number/account/Messaging Service and webhooks;
> - existing Zoho Flow/functions/extensions/buttons that send SMS;
> - any existing inbound SMS handling;
> - current opt-out handling;
> - users/profiles that need messaging;
> - relevant GitHub/Vercel/Supabase architecture.
>
> Preserve any existing working SMS path until the replacement is proven. Do not disable/delete old Zoho Flow, buttons, extensions, webhooks or Twilio configuration without my explicit approval after successful testing.
>
> Use MCC's proven invariants unless the Trident audit gives a reason to change them: Supabase canonical message history, Zoho as CRM/customer source of truth, server-side E.164 normalization, immutable historical phone snapshots, no guessing between duplicate phone matches, unmatched inbound persistence, self-send guard, Twilio signature validation, monotonic delivery status, server-side idempotency before Twilio, and version-safe self-healing CRM projection.
>
> After the audit, give me the **Trident-specific architecture and implementation plan** and explicitly identify:
> 1. what from MCC can be reused essentially unchanged;
> 2. what needs configuration/generalization;
> 3. what must be Trident-specific;
> 4. what current Trident production workflows must remain untouched during rollout.
>
> Then implement sequentially with controlled test checkpoints. Do not over-plan indefinitely; once the audit and architecture are sound, proceed with implementation using the connected tools and ask me only for genuinely non-retrievable decisions/credentials/actions.

---

## 25. Completion checklist for any client adaptation

Before calling a new client implementation production-ready, verify:

- [ ] canonical CRM entity documented;
- [ ] canonical outbound phone field documented;
- [ ] E.164 normalization tested;
- [ ] sender self-send blocked;
- [ ] duplicate/shared-number inbound ambiguity tested;
- [ ] historical phone change behavior tested;
- [ ] outbound SMS tested;
- [ ] inbound SMS tested;
- [ ] duplicate inbound webhook tested;
- [ ] Twilio signature validation enabled;
- [ ] delivery statuses tested;
- [ ] stale status callback regression blocked;
- [ ] STOP/START behavior tested;
- [ ] server-side idempotency tested;
- [ ] CRM projection failure is recoverable;
- [ ] version-safe reconciliation tested;
- [ ] CRM permissions/profiles verified;
- [ ] shared inbox/record widget tested if included;
- [ ] bulk preview/send/reporting tested if included;
- [ ] legacy production path preserved until explicit cutover;
- [ ] secrets remain server-side;
- [ ] rollback path understood.

The goal is not to reproduce MCC screens. The goal is to reproduce the **reliability properties** of the MCC messaging architecture while fitting the new client's actual workflow.
