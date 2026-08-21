create table if not exists public.messaging_templates (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(trim(name)) between 1 and 120),
  body text not null check (char_length(trim(body)) between 1 and 1600),
  category text,
  status text not null default 'Active'
    check (status in ('Active', 'Archived')),
  created_by_zoho_user_id text,
  created_by_name text,
  updated_by_zoho_user_id text,
  updated_by_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists messaging_templates_active_name_unique
  on public.messaging_templates (lower(trim(name)))
  where status = 'Active';

create index if not exists messaging_templates_status_updated_idx
  on public.messaging_templates (status, updated_at desc);

alter table public.messaging_templates enable row level security;

revoke all on table public.messaging_templates from anon, authenticated;
grant select, insert, update, delete on table public.messaging_templates to service_role;

create table if not exists public.scheduled_sms (
  id uuid primary key default gen_random_uuid(),
  zoho_contact_id text not null,
  conversation_id uuid references public.messaging_conversations(id) on delete set null,
  template_id uuid references public.messaging_templates(id) on delete set null,
  template_name_snapshot text,
  message_body text not null check (char_length(trim(message_body)) between 1 and 1600),
  phone_at_scheduling text,
  phone_sent_to text,
  scheduled_for timestamptz not null,
  timezone text not null default 'UTC',
  status text not null default 'Scheduled'
    check (status in ('Scheduled', 'Processing', 'Sent', 'Failed', 'Canceled')),
  created_by_zoho_user_id text,
  created_by_name text,
  updated_by_zoho_user_id text,
  updated_by_name text,
  twilio_message_sid text unique,
  sent_conversation_id uuid references public.messaging_conversations(id) on delete set null,
  attempt_count integer not null default 0 check (attempt_count >= 0),
  processing_started_at timestamptz,
  sent_at timestamptz,
  canceled_at timestamptz,
  error_code text,
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists scheduled_sms_due_idx
  on public.scheduled_sms (scheduled_for, created_at)
  where status = 'Scheduled';

create index if not exists scheduled_sms_contact_idx
  on public.scheduled_sms (zoho_contact_id, scheduled_for desc);

create index if not exists scheduled_sms_status_idx
  on public.scheduled_sms (status, scheduled_for desc);

alter table public.scheduled_sms enable row level security;

revoke all on table public.scheduled_sms from anon, authenticated;
grant select, insert, update, delete on table public.scheduled_sms to service_role;

create or replace function public.claim_due_scheduled_sms(
  p_limit integer default 10
)
returns setof public.scheduled_sms
language plpgsql
security invoker
set search_path = ''
as $$
begin
  -- A timed-out invocation can leave a row in Processing. Returning it to the
  -- queue is safe because the send service uses scheduled:<uuid> as its
  -- idempotency key.
  update public.scheduled_sms
  set status = 'Scheduled',
      processing_started_at = null,
      error_code = 'STALE_PROCESSING_RECOVERED',
      error_message = 'Recovered automatically after the scheduler stopped before completion.',
      updated_at = now()
  where status = 'Processing'
    and processing_started_at < now() - interval '10 minutes';

  return query
  with due as (
    select id
    from public.scheduled_sms
    where status = 'Scheduled'
      and scheduled_for <= now()
    order by scheduled_for asc, created_at asc
    for update skip locked
    limit greatest(1, least(coalesce(p_limit, 10), 25))
  )
  update public.scheduled_sms s
  set status = 'Processing',
      processing_started_at = now(),
      attempt_count = s.attempt_count + 1,
      updated_at = now()
  from due
  where s.id = due.id
  returning s.*;
end;
$$;

revoke all on function public.claim_due_scheduled_sms(integer) from public;
revoke all on function public.claim_due_scheduled_sms(integer) from anon;
revoke all on function public.claim_due_scheduled_sms(integer) from authenticated;
grant execute on function public.claim_due_scheduled_sms(integer) to service_role;
