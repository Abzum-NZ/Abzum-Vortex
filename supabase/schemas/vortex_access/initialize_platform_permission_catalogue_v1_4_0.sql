create or replace function vortex_access.initialize_platform_permission_catalogue_v1_4_0(
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
  current_revision bigint;
begin
  if p_organization_id is null
    or p_organization_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_changed_by is null
    or p_changed_by = '00000000-0000-0000-0000-000000000000'::uuid
    or p_correlation_id is null
    or p_correlation_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using errcode = '22023',
      message = 'Platform permission registration input is invalid';
  end if;

  select registration.revision into current_revision
  from vortex_access.permission_registrations as registration
  where registration.organization_id = p_organization_id
    and registration.registration_kind = 'platform'
    and registration.registration_owner_id =
      'cabe121e-0baf-4084-9471-cce915d460a8'::uuid;

  if not found then
    raise exception using errcode = '55000',
      message = 'Platform permission registration evidence is invalid';
  end if;

  if current_revision = 1 then
    perform 1
    from vortex_access.revise_platform_permission_catalogue_metadata(
      p_organization_id, 1, '1.0.0', '1.0.1',
      p_changed_by, p_correlation_id
    );
    current_revision := 2;
  end if;

  if current_revision = 2 then
    perform 1
    from vortex_access.adopt_shipped_platform_permission_catalogue(
      p_organization_id, 2, '1.1.0',
      'sha256:57453282c9a853912b2b67baeefaca81e21d076761d200ac812a7573d7dc7c9c',
      p_changed_by, p_correlation_id
    );
    current_revision := 3;
  end if;

  if current_revision = 3 then
    perform vortex_access.adopt_connection_administration_permission_catalogue(
      p_organization_id, p_changed_by, p_correlation_id
    );
    current_revision := 4;
  end if;

  if current_revision = 4 then
    perform vortex_access.adopt_security_and_support_operator_permission_catalogue(
      p_organization_id, p_changed_by, p_correlation_id
    );
    current_revision := 5;
  end if;

  if current_revision = 5 then
    perform vortex_access.adopt_builder_permission_catalogue(
      p_organization_id, p_changed_by, p_correlation_id
    );
    current_revision := 6;
  end if;

  if current_revision is distinct from 6
    or not vortex_access.platform_permission_catalogue_revision_is_exact(
      p_organization_id, 6
    ) then
    raise exception using errcode = '55000',
      message = 'Platform permission registration evidence is invalid';
  end if;

  return query
  select p_organization_id, 6::bigint, version.current_version
  from vortex_access.organization_access_versions as version
  where version.organization_id = p_organization_id;
end
$function$;

revoke all on function
  vortex_access.initialize_platform_permission_catalogue_v1_4_0(uuid, uuid, uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

comment on function vortex_access.initialize_platform_permission_catalogue_v1_4_0(uuid, uuid, uuid) is
  'Owner-only platform catalogue initializer step: advances an existing platform registration through every immutable revision to revision 6 (1.4.0).';
