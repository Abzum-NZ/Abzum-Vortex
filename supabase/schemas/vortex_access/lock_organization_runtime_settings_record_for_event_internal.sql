create or replace function vortex_access.lock_organization_runtime_settings_record_for_event_internal(
  p_record_id uuid
)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  context_value jsonb;
  locked_organization_id uuid;
begin
  if p_record_id is null
    or p_record_id = '00000000-0000-0000-0000-000000000000'::uuid then
    return false;
  end if;

  context_value := vortex_access.validated_human_request_context();
  if context_value ->> 'callerKind' is distinct from 'human'
    or not context_value ?& array[
      'organizationId', 'applicationRootId', 'organizationAccountId', 'correlationId'
    ]
    or p_record_id is distinct from (context_value ->> 'organizationId')::uuid
    or not vortex_access.organization_runtime_settings_manage_is_current() then
    return false;
  end if;

  select settings.organization_id into locked_organization_id
  from vortex_identity.organization_runtime_settings as settings
  where settings.organization_id = p_record_id
  for update;
  return found and locked_organization_id = p_record_id;
exception
  when no_data_found or too_many_rows or insufficient_privilege
    or object_not_in_prerequisite_state or invalid_text_representation then
    return false;
end
$function$;

alter function vortex_access.lock_organization_runtime_settings_record_for_event_internal(uuid)
  owner to postgres;

revoke all on function vortex_access.lock_organization_runtime_settings_record_for_event_internal(uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_module_owner;
grant execute on function vortex_access.lock_organization_runtime_settings_record_for_event_internal(uuid)
  to vortex_event_owner;

comment on function vortex_access.lock_organization_runtime_settings_record_for_event_internal(uuid) is
  'Validates and locks the organisation runtime-settings row for the private Event append of its protected system projection.';
