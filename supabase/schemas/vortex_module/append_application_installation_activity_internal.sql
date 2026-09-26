create or replace function vortex_module.append_application_installation_activity_internal(
  p_activity_id uuid,
  p_application_root_id uuid,
  p_action text
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
    or p_application_root_id is null
    or p_application_root_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_action is null
    or p_action not in (
      'activate_application_installation', 'withdraw_application_installation',
      'drain_application_installation'
    ) then
    raise exception using errcode = '22023',
      message = 'Application installation Activity input is invalid';
  end if;

  context_value := vortex_access.validated_human_request_context();
  append_result := vortex_activity.append_organization_activity_entry(
    (context_value ->> 'organizationId')::uuid,
    p_activity_id,
    pg_catalog.statement_timestamp(),
    'organization_account',
    (context_value ->> 'organizationAccountId')::uuid,
    p_action,
    array[p_application_root_id]::uuid[],
    array[]::uuid[],
    vortex_context.channel(),
    (context_value ->> 'correlationId')::uuid,
    'completed'
  );
  if append_result is distinct from 'inserted' then
    raise exception using errcode = '40001',
      message = 'Application installation Activity is stale';
  end if;
end
$function$;

revoke all on function vortex_module.append_application_installation_activity_internal(
  uuid, uuid, text
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_record_adapter, vortex_module_owner;
grant execute on function vortex_module.append_application_installation_activity_internal(
  uuid, uuid, text
) to vortex_module_owner;

comment on function vortex_module.append_application_installation_activity_internal(
  uuid, uuid, text
) is
  'Private content-free Activity composer for one protected Application installation lifecycle change.';
