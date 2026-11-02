-- Counts, or with p_apply removes, everything one ordinary application and the modules it owns
-- hold in the validated organisation, in one transaction under the application installation
-- authority. The proof of what may be removed (purge_application_review_internal) and the
-- deletion of the protected history (purge_application_history_internal, owned by the only role
-- the history protection lets delete) both prove it again themselves; this function only
-- sequences them, then removes the roots and records the change.
create or replace function vortex_definition.purge_application(
  p_application_root_id uuid,
  p_apply boolean,
  p_delete_only boolean,
  p_confirmed_name text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  authority record;
  impact jsonb;
  context_value jsonb;
begin
  if p_application_root_id is null or p_apply is null or p_delete_only is null then
    raise exception using errcode = '22023',
      message = 'Application purge command is invalid';
  end if;

  select locked.* into strict authority
  from vortex_access.lock_application_installation_authority() as locked;

  -- Without a typed name this only reads; with p_apply the typed name is required and proved.
  impact := vortex_definition.purge_application_review_internal(
    authority.organization_id,
    p_application_root_id,
    p_delete_only,
    case when p_apply then coalesce(p_confirmed_name, '') else null end);
  if not p_apply then
    return impact;
  end if;

  perform vortex_definition.purge_application_history_internal(
    authority.organization_id, p_application_root_id, p_delete_only, p_confirmed_name);
  perform vortex_definition.purge_application_roots_internal(
    authority.organization_id, p_application_root_id);

  context_value := vortex_access.validated_human_request_context();
  perform vortex_access.increment_organization_access_version(
    authority.organization_id,
    authority.organization_account_id,
    authority.correlation_id,
    'application_access_changed'
  );
  perform vortex_record.append_organization_activity_entry(
    authority.organization_id,
    pg_catalog.gen_random_uuid(),
    pg_catalog.statement_timestamp(),
    'organization_account',
    authority.organization_account_id,
    case when p_delete_only then 'delete_application' else 'purge_application' end,
    array[p_application_root_id]::uuid[],
    array[]::uuid[],
    vortex_platform.channel(),
    (context_value ->> 'correlationId')::uuid,
    'completed'
  );

  return pg_catalog.jsonb_build_object(
    'roles', impact -> 'roles',
    'role_assignments', impact -> 'role_assignments',
    'permission_entries', impact -> 'permission_entries',
    'releases', impact -> 'releases',
    'records', impact -> 'records',
    'record_tables', impact -> 'record_tables'
  );
end
$function$;

revoke all on function vortex_definition.purge_application(uuid, boolean, boolean, text)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_record_adapter;
grant execute on function vortex_definition.purge_application(uuid, boolean, boolean, text)
  to vortex_request;

comment on function vortex_definition.purge_application(uuid, boolean, boolean, text) is
  'Counts, or with p_apply removes, everything one ordinary Application and the Modules it owns hold in the validated organisation, in one transaction under the application installation authority: the protected history through the one role allowed to delete it, then the roots. A system application, the default application and an application another one depends on are refused; p_delete_only also refuses an installed application; the typed name is required and proved to remove.';

alter function vortex_definition.purge_application(uuid, boolean, boolean, text) owner to vortex_owner;
