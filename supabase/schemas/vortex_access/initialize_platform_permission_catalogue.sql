create or replace function vortex_access.initialize_platform_permission_catalogue(
  p_organization_id uuid,
  p_changed_by uuid,
  p_correlation_id uuid
)
returns table (
  organization_id uuid,
  registration_revision bigint,
  access_version bigint
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  current_registration vortex_access.permission_registrations%rowtype;
begin
  if exists (
    select 1
    from vortex_access.permission_registrations as registration
    where registration.organization_id = p_organization_id
      and registration.registration_kind = 'platform'
      and registration.registration_owner_id =
        'cabe121e-0baf-4084-9471-cce915d460a8'::uuid
  ) then
    return query
    select initialized.organization_id,
      initialized.registration_revision, initialized.access_version
    from vortex_access.initialize_platform_permission_catalogue_v1_4_0(
      p_organization_id, p_changed_by, p_correlation_id
    ) as initialized;
    return;
  end if;
  if p_organization_id is null
    or p_organization_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_changed_by is null
    or p_changed_by = '00000000-0000-0000-0000-000000000000'::uuid
    or p_correlation_id is null
    or p_correlation_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using errcode = '22023', message = 'Platform permission registration input is invalid';
  end if;

  perform 1
  from vortex_access.organization_access_versions as version
  join vortex_identity.organizations as organization
    on organization.organization_id = version.organization_id
  join vortex_identity.tenants as tenant on tenant.tenant_id = organization.tenant_id
  where version.organization_id = p_organization_id
    and organization.state = 'active'
    and tenant.state = 'active'
  for update of version;
  if not found then
    raise exception using errcode = '42501', message = 'Platform permission registration scope is unavailable';
  end if;

  select registration.* into current_registration
  from vortex_access.permission_registrations as registration
  where registration.organization_id = p_organization_id
    and registration.registration_kind = 'platform'
    and registration.registration_owner_id = 'cabe121e-0baf-4084-9471-cce915d460a8'::uuid
  for update;

  if found and current_registration.revision = 2 then
    return query
    select revised.organization_id, revised.registration_revision, revised.access_version
    from vortex_access.revise_platform_permission_catalogue_metadata(
      p_organization_id, 1, '1.0.0', '1.0.1', p_changed_by, p_correlation_id
    ) as revised;
    return;
  end if;

  if found then
    if current_registration.revision <> 1
      or not vortex_access.platform_permission_catalogue_revision_is_exact(
        p_organization_id, 1
      ) then
      raise exception using errcode = '55000', message = 'Platform permission registration evidence is invalid';
    end if;
    return query
    select current_registration.organization_id, current_registration.revision,
      version.current_version
    from vortex_access.organization_access_versions as version
    where version.organization_id = p_organization_id;
    return;
  end if;

  return query
  select initialized.organization_id, initialized.registration_revision,
    initialized.access_version
  from vortex_access.initialize_platform_permission_catalogue_v1(
    p_organization_id, p_changed_by, p_correlation_id
  ) as initialized;
end
$function$;

revoke all on function
  vortex_access.initialize_platform_permission_catalogue(uuid, uuid, uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

comment on function vortex_access.initialize_platform_permission_catalogue(uuid, uuid, uuid) is
  'Owner-only platform catalogue initializer; creates 1.0.0 for a new organisation and advances an existing registration through every immutable revision to revision 6 (1.4.0).';
