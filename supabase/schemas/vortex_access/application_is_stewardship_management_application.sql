create or replace function vortex_access.application_is_stewardship_management_application(
  p_organization_id uuid,
  p_application_root_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select exists (
    select 1
    from vortex_access.organization_stewardship_requirements as requirement
    where requirement.organization_id = p_organization_id
      and requirement.management_application_root_id = p_application_root_id
  )
$function$;

revoke all on function vortex_access.application_is_stewardship_management_application(
  uuid, uuid
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_record_adapter, vortex_module_owner;
grant execute on function vortex_access.application_is_stewardship_management_application(
  uuid, uuid
) to vortex_module_owner;

comment on function vortex_access.application_is_stewardship_management_application(
  uuid, uuid
) is
  'Whether one Application is the organisation''s active access-management application, whose uninstall would leave the steward without a working way to manage access.';
