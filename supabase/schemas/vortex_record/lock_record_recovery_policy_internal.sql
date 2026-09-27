create or replace function vortex_record.lock_record_recovery_policy_internal(
  p_organization_id uuid,
  p_storage_contract_id uuid,
  p_application_root_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  policy_row vortex_record.record_type_lifecycle_policies%rowtype;
begin
  if p_organization_id is null or p_storage_contract_id is null then
    return null;
  end if;
  select stored.* into policy_row
  from vortex_record.record_type_lifecycle_policies as stored
  where stored.organization_id = p_organization_id
    and stored.storage_contract_id = p_storage_contract_id
    and stored.application_root_id is not distinct from p_application_root_id
  for share;
  if not found then
    return null;
  end if;
  return pg_catalog.jsonb_build_object(
    'policyRevision', policy_row.policy_revision,
    'action', policy_row.action,
    'recoveryWindowDays', policy_row.policy_body -> 'recoveryWindowDays'
  );
end
$function$;

alter function vortex_record.lock_record_recovery_policy_internal(uuid, uuid, uuid) owner to vortex_record_owner;

revoke all on function vortex_record.lock_record_recovery_policy_internal(uuid, uuid, uuid) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_module_owner, vortex_record_adapter;

grant execute on function vortex_record.lock_record_recovery_policy_internal(uuid, uuid, uuid) to vortex_record_adapter;

comment on function vortex_record.lock_record_recovery_policy_internal(uuid, uuid, uuid) is 'Private locked resolver for the recovery policy that governs one record.';
