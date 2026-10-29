set role vortex_owner;

-- Record writes retain the person's authority and identify agent-mediated work.
alter table vortex_record.organization_activity_entries
  add column agent_channel text,
  add constraint organization_activity_entries_agent_channel_valid
    check (agent_channel in ('webmcp', 'mcp'));

comment on column vortex_record.organization_activity_entries.agent_channel is
  'Trusted agent channel acting for the unchanged actor; null for work not initiated through WebMCP or MCP.';
create or replace function vortex_record.append_organization_activity_entry(
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
  existing_entry vortex_record.organization_activity_entries%rowtype;
  channel_value text := vortex_platform.channel();
  agent_channel_value text;
begin
  agent_channel_value := case when channel_value in ('webmcp', 'mcp')
    then channel_value else null end;
  if p_source is null
    or p_source <> all (array[
      'web', 'webmcp', 'mcp', 'programmatic_interface', 'connection', 'federation',
      'system'
    ]) then
    raise exception using errcode = '22023', message = 'Activity source channel is invalid';
  end if;

  insert into vortex_record.organization_activity_entries (
    organization_id, activity_id, occurred_at, actor_kind, actor_id, action,
    subject_ids, changed_field_ids, source, correlation_id, outcome, agent_channel
  ) values (
    p_organization_id, p_activity_id, p_occurred_at, p_actor_kind, p_actor_id,
    p_action, p_subject_ids, p_changed_field_ids, p_source, p_correlation_id,
    p_outcome, agent_channel_value
  )
  on conflict (organization_id, activity_id) do nothing
  returning activity_id into inserted_activity_id;

  if inserted_activity_id is not null then
    return 'inserted';
  end if;

  select entry.*
  into strict existing_entry
  from vortex_record.organization_activity_entries as entry
  where entry.organization_id = p_organization_id
    and entry.activity_id = p_activity_id;

  if existing_entry.occurred_at is distinct from p_occurred_at
    or existing_entry.actor_kind is distinct from p_actor_kind
    or existing_entry.actor_id is distinct from p_actor_id
    or existing_entry.agent_channel is distinct from agent_channel_value
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

revoke all on function vortex_record.append_organization_activity_entry(
  uuid, uuid, timestamptz, text, uuid, text, uuid[], uuid[], text, uuid, text
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;

comment on function vortex_record.append_organization_activity_entry(
  uuid, uuid, timestamptz, text, uuid, text, uuid[], uuid[], text, uuid, text
) is
  'Private content-free Activity append over the one channel vocabulary; an exact retry replays and different evidence under one identity is refused.';

alter function vortex_record.append_organization_activity_entry(p_organization_id uuid, p_activity_id uuid, p_occurred_at timestamp with time zone, p_actor_kind text, p_actor_id uuid, p_action text, p_subject_ids uuid[], p_changed_field_ids uuid[], p_source text, p_correlation_id uuid, p_outcome text) owner to vortex_owner;

grant execute on function vortex_record.append_organization_activity_entry(p_organization_id uuid, p_activity_id uuid, p_occurred_at timestamp with time zone, p_actor_kind text, p_actor_id uuid, p_action text, p_subject_ids uuid[], p_changed_field_ids uuid[], p_source text, p_correlation_id uuid, p_outcome text) to postgres;

create or replace function vortex_record.append_record_activity_internal(
  p_activity_id uuid,
  p_action text,
  p_subject_ids uuid[],
  p_changed_field_ids uuid[],
  p_outcome text
)
returns timestamptz
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  context_value jsonb;
  occurred_at_value timestamptz := pg_catalog.statement_timestamp();
  append_result text;
begin
  if p_activity_id is null
    or p_activity_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_action is null
    or p_action not in (
      'create_record', 'update_record', 'execute_named_action', 'delete_record',
      'restore_record', 'transfer_record_ownership', 'manage_record_lifecycle_policy'
    )
    or p_subject_ids is null
    or pg_catalog.cardinality(p_subject_ids) = 0
    or pg_catalog.array_position(p_subject_ids, null::uuid) is not null
    or '00000000-0000-0000-0000-000000000000'::uuid = any (p_subject_ids)
    or p_subject_ids is distinct from (
      select pg_catalog.array_agg(value order by value)
      from (select distinct value
        from pg_catalog.unnest(p_subject_ids) as item(value)) as canonical
    )
    or p_changed_field_ids is null
    or pg_catalog.array_position(p_changed_field_ids, null::uuid) is not null
    or p_changed_field_ids is distinct from (
      select coalesce(pg_catalog.array_agg(value order by value), array[]::uuid[])
      from (select distinct value
        from pg_catalog.unnest(p_changed_field_ids) as item(value)) as canonical
    )
    or p_outcome is null
    or p_outcome not in ('completed', 'refused') then
    raise exception using errcode = '22023', message = 'Record Activity input is invalid';
  end if;
  context_value := vortex_access.validated_human_request_context();
  if p_action in (
      'create_record', 'update_record', 'delete_record', 'restore_record',
      'transfer_record_ownership'
    )
    and not context_value ? 'applicationRootId' then
    raise exception using errcode = '42501',
      message = 'Record Activity requires an Application context';
  end if;
  append_result := vortex_record.append_organization_activity_entry(
    (context_value ->> 'organizationId')::uuid,
    p_activity_id, occurred_at_value, 'organization_account',
    (context_value ->> 'organizationAccountId')::uuid,
    p_action, p_subject_ids, p_changed_field_ids, vortex_platform.channel(),
    (context_value ->> 'correlationId')::uuid, p_outcome
  );
  if append_result is distinct from 'inserted' then
    raise exception using errcode = '40001', message = 'Record Activity is stale';
  end if;
  return occurred_at_value;
end
$function$;

alter function vortex_record.append_record_activity_internal(uuid, text, uuid[], uuid[], text)
  owner to vortex_owner;
revoke all on function vortex_record.append_record_activity_internal(uuid, text, uuid[], uuid[], text)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_record.append_record_activity_internal(uuid, text, uuid[], uuid[], text)
  to vortex_owner, vortex_record_adapter;
comment on function vortex_record.append_record_activity_internal(uuid, text, uuid[], uuid[], text) is
  'The one Record Activity composer: derives the organisation, account, correlation and channel from the validated request context and appends one entry for a record save, named action, delete, restore, ownership transfer or lifecycle policy change. The append records webmcp or mcp as the agent channel while the actor remains the person.';

reset role;
