-- Allow Zoho Cliq to be recorded as a first-class SMS message source.
-- Existing application sources are preserved.

alter table public.messaging_messages
  drop constraint if exists messaging_messages_source_check;

alter table public.messaging_messages
  add constraint messaging_messages_source_check
  check (
    source in (
      'Incoming SMS',
      'CRM Widget',
      'Cliq',
      'Automation',
      'Import'
    )
  );
