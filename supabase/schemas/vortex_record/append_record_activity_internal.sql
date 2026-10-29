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
