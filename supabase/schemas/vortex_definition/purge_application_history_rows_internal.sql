-- Step 2 of removing an application: the protected history rows (roles, assignments, permission
-- entries, registrations, releases, dependencies, source identities, outbox). This unchecked
-- deletion is owned by the NOLOGIN role vortex_history_purger, the only role the history
-- protection lets delete, and only that role can execute it: purge_application_history_internal
-- reaches it after proving everything, and the migration that converts the old App Store
-- application runs it as the purger.
create or replace function vortex_definition.purge_application_history_rows_internal(
  p_organization_id uuid,
  p_application_root_id uuid
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  all_ids uuid[];
  role_ids uuid[];
begin
  select pg_catalog.array_agg(root.root_id) into all_ids
  from vortex_definition.roots as root
  where root.organization_id = p_organization_id
    and (root.root_id = p_application_root_id
      or root.owner_application_root_id = p_application_root_id);
  select coalesce(pg_catalog.array_agg(role_row.role_id), array[]::uuid[]) into role_ids
  from vortex_access.organization_roles as role_row
  where role_row.organization_id = p_organization_id
    and (role_row.application_root_id = p_application_root_id
      or role_row.derived_application_root_id = p_application_root_id);

  delete from vortex_access.organization_role_assignments as assignment
  where assignment.organization_id = p_organization_id and assignment.role_id = any(role_ids);
  delete from vortex_access.organization_role_permission_entries as entry
  where entry.organization_id = p_organization_id
    and (entry.role_id = any(role_ids) or entry.application_root_id = p_application_root_id);
  delete from vortex_access.organization_role_revisions as revision
  where revision.organization_id = p_organization_id and revision.role_id = any(role_ids);
  delete from vortex_access.organization_roles as role_row
  where role_row.organization_id = p_organization_id and role_row.role_id = any(role_ids);
  delete from vortex_access.permission_continuities as continuity
  where continuity.organization_id = p_organization_id
    and (continuity.application_root_id = p_application_root_id
      or continuity.registration_owner_id = any(all_ids));
  delete from vortex_access.application_role_template_continuities as continuity
  where continuity.organization_id = p_organization_id
    and continuity.application_root_id = p_application_root_id;
  delete from vortex_access.permission_catalogue_entries as catalogue_entry
  where catalogue_entry.organization_id = p_organization_id
    and (catalogue_entry.application_root_id = p_application_root_id
      or catalogue_entry.registration_owner_id = any(all_ids));
  delete from vortex_access.permission_registration_revisions as registration
  where registration.organization_id = p_organization_id
    and registration.registration_owner_id = any(all_ids);
  delete from vortex_access.permission_registrations as registration
  where registration.organization_id = p_organization_id
    and registration.registration_owner_id = any(all_ids);
  delete from vortex_platform.event_outbox as occurrence
  where occurrence.organization_id = p_organization_id
    and (occurrence.sequence_application_root_id = p_application_root_id
      or occurrence.storage_contract_id in (
        select catalogue.storage_contract_id from vortex_record.storage_catalogue as catalogue
        where catalogue.module_root_id = any(all_ids)));
  delete from vortex_definition.release_dependencies as dependency
  where dependency.root_id = any(all_ids);
  delete from vortex_definition.releases as release where release.root_id = any(all_ids);
  delete from vortex_definition.source_identity_aliases as alias where alias.root_id = any(all_ids);
  delete from vortex_definition.source_identities as identity_row
  where identity_row.root_id = any(all_ids);
end
$function$;

alter function vortex_definition.purge_application_history_rows_internal(uuid, uuid)
  owner to vortex_history_purger;

revoke all on function vortex_definition.purge_application_history_rows_internal(uuid, uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter, vortex_owner;
grant execute on function vortex_definition.purge_application_history_rows_internal(uuid, uuid)
  to vortex_history_purger;
