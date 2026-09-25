create or replace function vortex_record.append_lifecycle_policy_activity_internal(
  p_activity_id uuid,
  p_policy_id uuid
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  context_value jsonb;
  append_result text;
begin
  if p_activity_id is null
    or p_activity_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_policy_id is null
    or p_policy_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using errcode = '22023',
      message = 'Record lifecycle policy Activity input is invalid';
  end if;

  context_value := vortex_access.validated_human_request_context();
  append_result := vortex_activity.append_organization_activity_entry(
    (context_value ->> 'organizationId')::uuid,
    p_activity_id,
    pg_catalog.statement_timestamp(),
    'organization_account',
    (context_value ->> 'organizationAccountId')::uuid,
    'manage_record_lifecycle_policy',
    array[p_policy_id]::uuid[],
    array[]::uuid[],
    vortex_context.channel(),
    (context_value ->> 'correlationId')::uuid,
    'completed'
  );
  if append_result is distinct from 'inserted' then
    raise exception using errcode = '40001',
      message = 'Record lifecycle policy Activity is stale';
  end if;
end
$function$;

revoke all on function vortex_record.append_lifecycle_policy_activity_internal(uuid, uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner, vortex_record_adapter, vortex_module_owner;
grant execute on function vortex_record.append_lifecycle_policy_activity_internal(uuid, uuid)
  to vortex_record_owner;

comment on function vortex_record.append_lifecycle_policy_activity_internal(uuid, uuid) is
  'Private Record lifecycle-policy Activity composer: derives the organisation, account and correlation from the validated request context and records the channel from that context.';
