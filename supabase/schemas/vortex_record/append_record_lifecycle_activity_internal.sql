create or replace function vortex_record.append_record_lifecycle_activity_internal(
  p_activity_id uuid,
  p_operation text,
  p_subject_ids uuid[]
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
    or p_operation is null
    or p_operation not in ('delete', 'restore')
    or p_subject_ids is null
    or pg_catalog.cardinality(p_subject_ids) = 0
    or pg_catalog.array_position(p_subject_ids, null::uuid) is not null
    or '00000000-0000-0000-0000-000000000000'::uuid = any (p_subject_ids)
    or p_subject_ids is distinct from (
      select pg_catalog.array_agg(value order by value)
      from (select distinct value
        from pg_catalog.unnest(p_subject_ids) as item(value)) as canonical
    ) then
    raise exception using errcode = '22023',
      message = 'Record lifecycle Activity input is invalid';
  end if;
  context_value := vortex_access.validated_human_request_context();
  if not context_value ? 'applicationRootId' then
    raise exception using errcode = '42501',
      message = 'Record lifecycle Activity requires an Application context';
  end if;
  append_result := vortex_activity.append_organization_activity_entry(
    (context_value ->> 'organizationId')::uuid,
    p_activity_id, occurred_at_value, 'organization_account',
    (context_value ->> 'organizationAccountId')::uuid,
    case p_operation when 'delete' then 'delete_record' else 'restore_record' end,
    p_subject_ids, array[]::uuid[], vortex_context.channel(),
    (context_value ->> 'correlationId')::uuid, 'completed'
  );
  if append_result is distinct from 'inserted' then
    raise exception using errcode = '40001',
      message = 'Record lifecycle Activity is stale';
  end if;
  return occurred_at_value;
end
$function$;

revoke all on function vortex_record.append_record_lifecycle_activity_internal(
  uuid, text, uuid[]
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_module_owner, vortex_record_adapter;
grant execute on function vortex_record.append_record_lifecycle_activity_internal(
  uuid, text, uuid[]
) to vortex_record_adapter;

comment on function vortex_record.append_record_lifecycle_activity_internal(
  uuid, text, uuid[]
) is
  'Private Record delete and restore Activity composer: derives the organisation, account and correlation from the validated request context and records the channel from that context.';
