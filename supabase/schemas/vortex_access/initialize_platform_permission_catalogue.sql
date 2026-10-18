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
  operation_at timestamptz := pg_catalog.statement_timestamp();
  current_registration vortex_access.permission_registrations%rowtype;
  resulting_version bigint;
  expected_count bigint;
  -- guard-allow: function-uuid fixed platform permission identity without declaration-table read access
  platform_owner_id constant uuid := 'cabe121e-0baf-4084-9471-cce915d460a8';
  catalogue_fingerprint constant text :=
    'sha256:1e5cceb04465d940f163ec926af7423efc9b37788551b00766d768fe9089195b';
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
    raise exception using errcode = '42501',
      message = 'Platform permission registration scope is unavailable';
  end if;

  perform pg_catalog.set_config(
    'vortex_access.exclusive_organization_id', p_organization_id::text, true
  );

  select registration.* into current_registration
  from vortex_access.permission_registrations as registration
  where registration.organization_id = p_organization_id
    and registration.registration_kind = 'platform'
    and registration.registration_owner_id = platform_owner_id
  for update;
  if found then
    if not vortex_access.platform_permission_catalogue_revision_is_exact(
      p_organization_id, 6
    ) then
      raise exception using errcode = '55000',
        message = 'Platform permission registration evidence is invalid';
    end if;
    return query select p_organization_id, 6::bigint, version.current_version
    from vortex_access.organization_access_versions as version
    where version.organization_id = p_organization_id;
    return;
  end if;

  select pg_catalog.count(*) into expected_count
  from vortex_access.read_platform_permission_declaration_catalogue_internal(6);
  if expected_count <> 22 then
    raise exception using errcode = '55000',
      message = 'Platform permission declarations are invalid';
  end if;

  insert into vortex_access.permission_registration_revisions (
    organization_id, registration_kind, registration_owner_id, revision,
    state, operation, source_definition_key, source_version, source_revision,
    validation_contract_version, permission_catalogue_fingerprint,
    candidate_fingerprint, changed_at, changed_by, change_correlation_id
  ) values (
    p_organization_id, 'platform', platform_owner_id, 6,
    'active', 'platform_initialize', null, '1.4.0', null, null,
    catalogue_fingerprint, catalogue_fingerprint, operation_at, p_changed_by,
    p_correlation_id
  );

  insert into vortex_access.permission_catalogue_entries (
    organization_id, registration_kind, registration_owner_id,
    registration_revision, application_root_id, owner_kind, owner_id,
    permission_id, permission_key, label, description, record_type_id,
    record_scope, field_policy, action_kind, named_action, administrative,
    source_kind, source_definition_key, source_root_id, source_version,
    source_revision, source_validation_contract_version,
    source_catalogue_fingerprint, meaning_fingerprint
  )
  select p_organization_id, 'platform', platform_owner_id, 6,
    null, 'platform', platform_owner_id, declaration.permission_id,
    declaration.permission_key, declaration.label, declaration.description,
    null, null, null, declaration.action_kind, null, true,
    'platform_catalogue', null, null, declaration.source_version,
    null, null, declaration.catalogue_fingerprint,
    declaration.meaning_fingerprint
  from vortex_access.read_platform_permission_declaration_catalogue_internal(6)
    as declaration;

  insert into vortex_access.permission_registrations (
    organization_id, registration_kind, registration_owner_id, state, revision,
    source_definition_key, source_version, source_revision,
    validation_contract_version, permission_catalogue_fingerprint,
    candidate_fingerprint, changed_at, changed_by, change_correlation_id
  ) values (
    p_organization_id, 'platform', platform_owner_id, 'active', 6,
    null, '1.4.0', null, null, catalogue_fingerprint,
    catalogue_fingerprint, operation_at, p_changed_by, p_correlation_id
  );

  insert into vortex_access.permission_continuities (
    organization_id, application_root_id, owner_kind, owner_id,
    permission_id, registration_kind, registration_owner_id, state,
    continuity_revision, meaning_fingerprint,
    last_processed_registration_revision, changed_at
  )
  select p_organization_id, null, 'platform', platform_owner_id,
    declaration.permission_id, 'platform', platform_owner_id, 'available',
    1, declaration.meaning_fingerprint, 6, operation_at
  from vortex_access.read_platform_permission_declaration_catalogue_internal(6)
    as declaration;

  if not vortex_access.platform_permission_catalogue_revision_is_exact(
    p_organization_id, 6
  ) then
    raise exception using errcode = '55000',
      message = 'Platform permission registration evidence is invalid';
  end if;

  select incremented.current_version into strict resulting_version
  from vortex_access.increment_organization_access_version(
    p_organization_id, p_changed_by, p_correlation_id,
    'application_access_changed'
  ) as incremented;
  return query select p_organization_id, 6::bigint, resulting_version;
end
$function$;

revoke all on function vortex_access.initialize_platform_permission_catalogue(uuid, uuid, uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

comment on function vortex_access.initialize_platform_permission_catalogue(uuid, uuid, uuid) is
  'Owner-only initializer for the current platform permission catalogue.';

alter function vortex_access.initialize_platform_permission_catalogue(uuid, uuid, uuid)
  owner to vortex_owner;

grant execute on function vortex_access.initialize_platform_permission_catalogue(uuid, uuid, uuid)
  to postgres;
