create table if not exists public.messaging_send_requests (
  idempotency_key text primary key,
  request_hash text not null,
  source text not null,
  status text not null default 'processing'
    check (status in ('processing','completed','failed')),
  zoho_contact_id text,
  conversation_id uuid references public.messaging_conversations(id) on delete set null,
  twilio_message_sid text unique,
  result_status text,
  result_conversation_id uuid references public.messaging_conversations(id) on delete set null,
  zoho_conversation_id text,
  crm_synced boolean,
  crm_sync_error text,
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz
);

create index if not exists messaging_send_requests_created_at_idx
  on public.messaging_send_requests(created_at desc);

alter table public.messaging_send_requests enable row level security;
