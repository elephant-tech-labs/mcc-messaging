alter table public.messaging_conversations
  add column if not exists crm_sync_needed boolean not null default false,
  add column if not exists crm_projection_version bigint not null default 0,
  add column if not exists crm_synced_version bigint not null default 0,
  add column if not exists crm_last_synced_at timestamptz,
  add column if not exists crm_last_sync_attempt_at timestamptz,
  add column if not exists crm_sync_error text;

create or replace function public.mark_messaging_crm_projection_dirty()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    if new.zoho_contact_id is not null then
      new.crm_projection_version := coalesce(new.crm_projection_version, 0) + 1;
      new.crm_sync_needed := true;
    end if;
    return new;
  end if;

  if new.zoho_contact_id is distinct from old.zoho_contact_id
     or new.customer_phone is distinct from old.customer_phone
     or new.twilio_phone is distinct from old.twilio_phone
     or new.channel is distinct from old.channel
     or new.status is distinct from old.status
     or new.last_message is distinct from old.last_message
     or new.last_message_at is distinct from old.last_message_at
     or new.last_message_direction is distinct from old.last_message_direction
     or new.last_message_status is distinct from old.last_message_status
     or new.unread_count is distinct from old.unread_count
     or new.last_incoming_at is distinct from old.last_incoming_at
     or new.last_outgoing_at is distinct from old.last_outgoing_at
     or new.opt_out_status is distinct from old.opt_out_status
     or new.opt_out_at is distinct from old.opt_out_at
     or new.created_from is distinct from old.created_from then
    new.crm_projection_version := coalesce(old.crm_projection_version, 0) + 1;
    new.crm_sync_needed := new.zoho_contact_id is not null;
    new.crm_sync_error := null;
  end if;

  return new;
end;
$$;

drop trigger if exists messaging_crm_projection_dirty on public.messaging_conversations;
create trigger messaging_crm_projection_dirty
before insert or update on public.messaging_conversations
for each row execute function public.mark_messaging_crm_projection_dirty();

create index if not exists messaging_conversations_crm_sync_needed_idx
  on public.messaging_conversations(crm_sync_needed, updated_at)
  where crm_sync_needed = true and zoho_contact_id is not null;

update public.messaging_conversations
set crm_projection_version = crm_projection_version + 1,
    crm_sync_needed = true,
    crm_sync_error = null
where zoho_contact_id is not null;
