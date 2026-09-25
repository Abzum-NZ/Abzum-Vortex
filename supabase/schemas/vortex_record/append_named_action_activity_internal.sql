create or replace function vortex_record.append_named_action_activity_internal(
  p_activity_id uuid,
  p_subject_id uuid,
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
    or p_subject_id is null
    or p_subject_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_changed_field_ids is null
    or pg_catalog.array_position(p_changed_field_ids, null::uuid) is not null
    or p_changed_field_ids is distinct from (
      select coalesce(pg_catalog.array_agg(value order by value), array[]::uuid[])
      from (select distinct value
        from pg_catalog.unnest(p_changed_field_ids) as item(value)) canonical
    )
    or p_outcome not in ('completed', 'refused') then
    raise exception using errcode = '22023', message = 'Named action Activity input is invalid';
  end if;
  context_value := vortex_access.validated_human_request_context();
  append_result := vortex_activity.append_organization_activity_entry(
    (context_value ->> 'organizationId')::uuid, p_activity_id,
    occurred_at_value, 'organization_account',
    (context_value ->> 'organizationAccountId')::uuid,
    'execute_named_action', array[p_subject_id]::uuid[], p_changed_field_ids,
    vortex_context.channel(), (context_value ->> 'correlationId')::uuid, p_outcome
  );
  if append_result is distinct from 'inserted' then
    raise exception using errcode = '40001', message = 'Named action Activity is stale';
  end if;
  return occurred_at_value;
end
$function$;

revoke all on function vortex_record.append_named_action_activity_internal(uuid,uuid,uuid[],text)
from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_module_owner, vortex_record_adapter;
grant execute on function vortex_record.append_named_action_activity_internal(uuid,uuid,uuid[],text)
to vortex_record_adapter;

comment on function vortex_record.append_named_action_activity_internal(uuid,uuid,uuid[],text) is
  'Private named-action Activity composer: derives the organisation, account and correlation from the validated request context and records the channel from that context.';
