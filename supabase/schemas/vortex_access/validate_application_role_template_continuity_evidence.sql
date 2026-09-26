create or replace function vortex_access.validate_application_role_template_continuity_evidence()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if new.state = 'available' and not exists (
    select 1
    from vortex_access.permission_registration_revisions as registration
    where registration.organization_id = new.organization_id
      and registration.registration_kind = 'application'
      and registration.registration_owner_id = new.application_root_id
      and registration.revision = new.last_processed_registration_revision
      and registration.state = 'active'
  ) then
    raise exception using errcode = '23514',
      message = 'Available role template continuity requires an active registration revision';
  end if;

  return null;
end;
$function$;

revoke execute on function vortex_access.validate_application_role_template_continuity_evidence()
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

comment on function vortex_access.validate_application_role_template_continuity_evidence() is
  'Deferred evidence check that an application role-template continuity names an exact registered template. Definer, because it fires at commit under the request role, which has no table access.';
