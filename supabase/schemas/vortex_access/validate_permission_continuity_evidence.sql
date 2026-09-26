create or replace function vortex_access.validate_permission_continuity_evidence()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if new.state = 'available' and not exists (
    select 1
    from vortex_access.permission_registration_revisions as registration
    join vortex_access.permission_catalogue_entries as catalogue
      on catalogue.organization_id = registration.organization_id
      and catalogue.registration_kind = registration.registration_kind
      and catalogue.registration_owner_id = registration.registration_owner_id
      and catalogue.registration_revision = registration.revision
    where registration.organization_id = new.organization_id
      and registration.registration_kind = new.registration_kind
      and registration.registration_owner_id = new.registration_owner_id
      and registration.revision = new.last_processed_registration_revision
      and registration.state = 'active'
      and catalogue.owner_kind = new.owner_kind
      and catalogue.owner_id = new.owner_id
      and catalogue.permission_id = new.permission_id
      and catalogue.application_root_id is not distinct from new.application_root_id
      and catalogue.meaning_fingerprint = new.meaning_fingerprint
  ) then
    raise exception using errcode = '23514',
      message = 'Available permission continuity requires exact active catalogue evidence';
  end if;

  return null;
end;
$function$;

revoke execute on function vortex_access.validate_permission_continuity_evidence()
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

comment on function vortex_access.validate_permission_continuity_evidence() is
  'Deferred evidence check that a permission continuity names an exact registered catalogue entry. Definer, because it fires at commit under the request role, which has no table access.';
