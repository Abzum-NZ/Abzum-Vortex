-- Content-free Activity evidence is private structural storage. Owning protected
-- operations may append to it in their transaction; no runtime or Data API role
-- receives a general append or read surface.
create schema if not exists vortex_activity authorization postgres;

revoke all on schema vortex_activity
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

alter default privileges for role postgres in schema vortex_activity
  revoke all on tables
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
alter default privileges for role postgres in schema vortex_activity
  revoke all on sequences
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
alter default privileges for role postgres in schema vortex_activity
  revoke execute on functions
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

create function vortex_activity.uuid_array_is_canonical(p_values uuid[])
returns boolean
language plpgsql
immutable
strict
parallel safe
security invoker
set search_path = ''
as $function$
declare
  current_value uuid;
  previous_value uuid;
begin
  if pg_catalog.array_ndims(p_values) <> 1
    or pg_catalog.array_lower(p_values, 1) <> 1 then
    return false;
  end if;

  foreach current_value in array p_values loop
    if current_value is null
      or not vortex_context.is_non_nil_uuid(current_value::text)
      or (previous_value is not null and previous_value >= current_value) then
      return false;
    end if;
    previous_value := current_value;
  end loop;

  return true;
end
$function$;

create table vortex_activity.organization_activity_entries (
  organization_id uuid not null,
  activity_id uuid not null,
  occurred_at timestamptz not null,
  actor_kind text not null,
  actor_id uuid not null,
  action text not null,
  subject_ids uuid[] not null,
  changed_field_ids uuid[] not null,
  source text not null,
  correlation_id uuid not null,
  outcome text not null,
  constraint organization_activity_entries_pk
    primary key (organization_id, activity_id),
  constraint organization_activity_entries_organization_non_nil check (
    vortex_context.is_non_nil_uuid(organization_id::text)
  ),
  constraint organization_activity_entries_activity_non_nil check (
    vortex_context.is_non_nil_uuid(activity_id::text)
  ),
  constraint organization_activity_entries_occurred_at_finite check (
    occurred_at not in ('-infinity'::timestamptz, 'infinity'::timestamptz)
  ),
  constraint organization_activity_entries_actor_kind_valid check (
    actor_kind in ('identity', 'organization_account', 'system', 'public_session')
  ),
  constraint organization_activity_entries_actor_non_nil check (
    vortex_context.is_non_nil_uuid(actor_id::text)
  ),
  constraint organization_activity_entries_action_format check (
    pg_catalog.char_length(action) between 1 and 40
    and action ~ '^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$'
  ),
  constraint organization_activity_entries_subjects_canonical check (
    pg_catalog.cardinality(subject_ids) >= 1
    and vortex_activity.uuid_array_is_canonical(subject_ids)
  ),
  constraint organization_activity_entries_fields_canonical check (
    vortex_activity.uuid_array_is_canonical(changed_field_ids)
  ),
  constraint organization_activity_entries_source_valid check (
    source in ('web', 'workflow', 'interface', 'connection', 'federation', 'system')
  ),
  constraint organization_activity_entries_correlation_non_nil check (
    vortex_context.is_non_nil_uuid(correlation_id::text)
  ),
  constraint organization_activity_entries_outcome_valid check (
    outcome in ('completed', 'refused', 'failed')
  ),
  constraint organization_activity_entries_organization_fk
    foreign key (organization_id)
    references vortex_identity.organizations (organization_id)
);

alter table vortex_activity.organization_activity_entries enable row level security;
alter table vortex_activity.organization_activity_entries force row level security;

create function vortex_activity.refuse_activity_entry_change()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $function$
begin
  raise exception using
    errcode = '23514',
    message = 'Activity entries are immutable';
end
$function$;

create trigger organization_activity_entries_immutable
before update or delete on vortex_activity.organization_activity_entries
for each row execute function vortex_activity.refuse_activity_entry_change();

create function vortex_activity.append_organization_activity_entry(
  p_organization_id uuid,
  p_activity_id uuid,
  p_occurred_at timestamptz,
  p_actor_kind text,
  p_actor_id uuid,
  p_action text,
  p_subject_ids uuid[],
  p_changed_field_ids uuid[],
  p_source text,
  p_correlation_id uuid,
  p_outcome text
)
returns text
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  inserted_activity_id uuid;
  existing_entry vortex_activity.organization_activity_entries%rowtype;
begin
  insert into vortex_activity.organization_activity_entries (
    organization_id, activity_id, occurred_at, actor_kind, actor_id, action,
    subject_ids, changed_field_ids, source, correlation_id, outcome
  ) values (
    p_organization_id, p_activity_id, p_occurred_at, p_actor_kind, p_actor_id,
    p_action, p_subject_ids, p_changed_field_ids, p_source, p_correlation_id,
    p_outcome
  )
  on conflict (organization_id, activity_id) do nothing
  returning activity_id into inserted_activity_id;

  if inserted_activity_id is not null then
    return 'inserted';
  end if;

  select entry.*
  into strict existing_entry
  from vortex_activity.organization_activity_entries as entry
  where entry.organization_id = p_organization_id
    and entry.activity_id = p_activity_id;

  if existing_entry.occurred_at is distinct from p_occurred_at
    or existing_entry.actor_kind is distinct from p_actor_kind
    or existing_entry.actor_id is distinct from p_actor_id
    or existing_entry.action is distinct from p_action
    or existing_entry.subject_ids is distinct from p_subject_ids
    or existing_entry.changed_field_ids is distinct from p_changed_field_ids
    or existing_entry.source is distinct from p_source
    or existing_entry.correlation_id is distinct from p_correlation_id
    or existing_entry.outcome is distinct from p_outcome then
    raise exception using
      errcode = '22023',
      message = 'Activity identity already records different evidence';
  end if;

  return 'already_recorded';
end
$function$;

revoke all on table vortex_activity.organization_activity_entries
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
revoke all on function vortex_activity.uuid_array_is_canonical(uuid[])
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
revoke all on function vortex_activity.refuse_activity_entry_change()
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
revoke all on function vortex_activity.append_organization_activity_entry(
  uuid, uuid, timestamptz, text, uuid, text, uuid[], uuid[], text, uuid, text
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
