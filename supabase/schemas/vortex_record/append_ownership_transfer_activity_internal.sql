create or replace function vortex_record.append_ownership_transfer_activity_internal(
  p_activity_id uuid,
  p_subject_id uuid,
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
    or p_outcome not in ('completed', 'refused') then
    raise exception using errcode = '22023', message = 'Record ownership transfer Activity input is invalid';
  end if;
  context_value := vortex_access.validated_human_request_context();
  if not context_value ? 'applicationRootId' then
    raise exception using errcode = '42501', message = 'Record ownership transfer requires an Application context';
  end if;
  append_result := vortex_activity.append_organization_activity_entry(
    (context_value ->> 'organizationId')::uuid,
    p_activity_id, occurred_at_value, 'organization_account',
    (context_value ->> 'organizationAccountId')::uuid,
    'transfer_record_ownership', array[p_subject_id]::uuid[], array[]::uuid[],
    vortex_context.channel(), (context_value ->> 'correlationId')::uuid, p_outcome
  );
  if append_result is distinct from 'inserted' then
    raise exception using errcode = '40001', message = 'Record ownership transfer Activity is stale';
  end if;
  return occurred_at_value;
end
$function$;

revoke all on function vortex_record.append_ownership_transfer_activity_internal(uuid, uuid, text)
  from public, anon, authenticated, service_role, vortex_request, vortex_record_owner, vortex_module_owner;
grant execute on function vortex_record.append_ownership_transfer_activity_internal(uuid, uuid, text)
  to vortex_record_adapter;

comment on function vortex_record.append_ownership_transfer_activity_internal(uuid, uuid, text) is
  'Private Record ownership-transfer Activity composer: derives the organisation, account and correlation from the validated request context and records the channel from that context.';
