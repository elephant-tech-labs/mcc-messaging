alter table public.messaging_messages
  drop constraint if exists messaging_messages_source_check;

alter table public.messaging_messages
  add constraint messaging_messages_source_check
  check (source in ('Incoming SMS','CRM Widget','Cliq','Bulk SMS','Automation','Import'));

create table if not exists public.bulk_sms_jobs (
  id uuid primary key default gen_random_uuid(),
  name text,
  message_template text not null,
  status text not null default 'draft'
    check (status in ('draft','queued','processing','completed','partial','failed','canceled')),
  total_selected integer not null default 0 check (total_selected >= 0),
  eligible_count integer not null default 0 check (eligible_count >= 0),
  skipped_count integer not null default 0 check (skipped_count >= 0),
  created_by_zoho_user_id text,
  created_by_name text,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.bulk_sms_recipients (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.bulk_sms_jobs(id) on delete cascade,
  zoho_contact_id text not null,
  contact_name text,
  first_name text,
  last_name text,
  phone_raw text,
  customer_phone text,
  rendered_body text,
  status text not null
    check (status in ('queued','processing','accepted','sent','delivered','failed','undelivered','skipped')),
  skip_reason text,
  twilio_message_sid text,
  conversation_id uuid references public.messaging_conversations(id) on delete set null,
  error_code text,
  error_message text,
  attempt_count integer not null default 0 check (attempt_count >= 0),
  processing_started_at timestamptz,
  sent_at timestamptz,
  delivered_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(job_id, zoho_contact_id)
);

create index if not exists bulk_sms_recipients_job_status_idx
  on public.bulk_sms_recipients(job_id, status);
create index if not exists bulk_sms_jobs_created_at_idx
  on public.bulk_sms_jobs(created_at desc);
create unique index if not exists bulk_sms_recipients_twilio_sid_uidx
  on public.bulk_sms_recipients(twilio_message_sid)
  where twilio_message_sid is not null;

alter table public.bulk_sms_jobs enable row level security;
alter table public.bulk_sms_recipients enable row level security;

create or replace function public.claim_bulk_sms_recipients(
  p_job_id uuid,
  p_limit integer default 8
)
returns setof public.bulk_sms_recipients
language plpgsql
security invoker
set search_path = public
as $$
begin
  -- Do not automatically recycle stale processing rows. Twilio may already have
  -- accepted an SMS even if the worker died before persisting its SID, and
  -- automatic recycling could therefore duplicate a real customer message.
  return query
  with claimed as (
    select id
    from public.bulk_sms_recipients
    where job_id = p_job_id
      and status = 'queued'
    order by created_at, id
    for update skip locked
    limit greatest(1, least(coalesce(p_limit, 8), 25))
  )
  update public.bulk_sms_recipients r
  set status = 'processing',
      attempt_count = r.attempt_count + 1,
      processing_started_at = now(),
      updated_at = now()
  from claimed
  where r.id = claimed.id
  returning r.*;
end;
$$;
