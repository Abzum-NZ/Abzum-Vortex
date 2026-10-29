CREATE OR REPLACE FUNCTION vortex_access.withdraw_application_permission_registration_internal(p_organization_id uuid, p_application_root_id uuid, p_expected_revision bigint, p_changed_by uuid, p_correlation_id uuid) RETURNS TABLE(operation text, organization_id uuid, application_root_id uuid, registration_state text, registration_revision bigint, access_version bigint, correlation_id uuid)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  operation_at timestamptz;
  current_registration vortex_access.permission_registrations%rowtype;
  next_revision bigint;
  resulting_version bigint;
begin
  if p_organization_id is null
    or p_organization_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_application_root_id is null
    or p_application_root_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_expected_revision is null
    or p_expected_revision not between 1 and 9007199254740991
    or p_changed_by is null
    or p_changed_by = '00000000-0000-0000-0000-000000000000'::uuid
    or p_correlation_id is null
    or p_correlation_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using errcode = '22023', message = 'Application permission withdrawal input is invalid';
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
    raise exception using errcode = '42501', message = 'Application permission withdrawal scope is unavailable';
  end if;

  select registration.* into current_registration
  from vortex_access.permission_registrations as registration
  where registration.organization_id = p_organization_id
    and registration.registration_kind = 'application'
    and registration.registration_owner_id = p_application_root_id;
  if not found
    or current_registration.state <> 'active'
    or current_registration.revision <> p_expected_revision
    or current_registration.revision = 9007199254740991 then
    raise exception using errcode = '40001', message = 'Application permission registration revision is stale or unavailable';
  end if;
  next_revision := current_registration.revision + 1;
  operation_at := greatest(
    current_registration.changed_at,
    pg_catalog.clock_timestamp()
  );

  insert into vortex_access.permission_registration_revisions (
    organization_id, registration_kind, registration_owner_id, revision, state, operation, source_definition_key, source_version, source_revision, validation_contract_version, permission_catalogue_fingerprint, changed_at, changed_by, change_correlation_id
  ) values (
    p_organization_id, 'application', p_application_root_id, next_revision, 'withdrawn', 'withdraw', current_registration.source_definition_key, current_registration.source_version, current_registration.source_revision, current_registration.validation_contract_version, current_registration.permission_catalogue_fingerprint, operation_at, p_changed_by, p_correlation_id
  );

  insert into vortex_access.permission_catalogue_entries (
    organization_id, registration_kind, registration_owner_id, registration_revision,
    application_root_id, owner_kind, owner_id, permission_id, permission_key,
    label, description, record_type_id, action_kind, named_action, administrative,
    source_kind, source_definition_key, source_root_id, source_version, source_revision,
    source_validation_contract_version, source_catalogue_fingerprint,
    record_scope, field_policy
  )
  select entry.organization_id, entry.registration_kind, entry.registration_owner_id,
    next_revision, entry.application_root_id, entry.owner_kind, entry.owner_id,
    entry.permission_id, entry.permission_key, entry.label, entry.description,
    entry.record_type_id, entry.action_kind, entry.named_action, entry.administrative,
    entry.source_kind, entry.source_definition_key, entry.source_root_id,
    entry.source_version, entry.source_revision, entry.source_validation_contract_version,
    entry.source_catalogue_fingerprint, entry.record_scope,
    entry.field_policy
  from vortex_access.permission_catalogue_entries as entry
  where entry.organization_id = p_organization_id
    and entry.registration_kind = 'application'
    and entry.registration_owner_id = p_application_root_id
    and entry.registration_revision = current_registration.revision;

  update vortex_access.permission_registrations as registration
  set state = 'withdrawn', revision = next_revision, changed_at = operation_at,
      changed_by = p_changed_by, change_correlation_id = p_correlation_id
  where registration.organization_id = p_organization_id
    and registration.registration_kind = 'application'
    and registration.registration_owner_id = p_application_root_id;

  select incremented.current_version into resulting_version
  from vortex_access.increment_organization_access_version(
    p_organization_id, p_changed_by, p_correlation_id, 'application_access_changed'
  ) as incremented;
  return query select 'withdraw'::text, p_organization_id, p_application_root_id,
    'withdrawn'::text, next_revision, resulting_version, p_correlation_id;
end
$$;

ALTER FUNCTION vortex_access.withdraw_application_permission_registration_internal(p_organization_id uuid, p_application_root_id uuid, p_expected_revision bigint, p_changed_by uuid, p_correlation_id uuid) OWNER TO vortex_owner;

COMMENT ON FUNCTION vortex_access.withdraw_application_permission_registration_internal(p_organization_id uuid, p_application_root_id uuid, p_expected_revision bigint, p_changed_by uuid, p_correlation_id uuid) IS 'The registration withdrawal of the coordinated application-access change; owner-only.';

REVOKE ALL ON FUNCTION vortex_access.withdraw_application_permission_registration_internal(p_organization_id uuid, p_application_root_id uuid, p_expected_revision bigint, p_changed_by uuid, p_correlation_id uuid) FROM PUBLIC;

grant execute on function vortex_access.withdraw_application_permission_registration_internal(p_organization_id uuid, p_application_root_id uuid, p_expected_revision bigint, p_changed_by uuid, p_correlation_id uuid) to postgres;
