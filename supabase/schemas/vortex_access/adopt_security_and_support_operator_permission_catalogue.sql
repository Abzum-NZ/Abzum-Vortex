CREATE OR REPLACE FUNCTION vortex_access.adopt_security_and_support_operator_permission_catalogue(p_organization_id uuid, p_changed_by uuid, p_correlation_id uuid) RETURNS bigint
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  -- guard-allow: function-uuid fixed platform permission identity without declaration-table read access
  platform_owner_id constant uuid := 'cabe121e-0baf-4084-9471-cce915d460a8';
  -- guard-allow: function-uuid fixed platform permission identity without declaration-table read access
  security_permission_id constant uuid := 'e85c2232-2ed7-4ce8-b1e5-7e2ad8e2b847';
  -- guard-allow: function-uuid fixed platform permission identity without declaration-table read access
  support_request_permission_id constant uuid := '014d2898-1969-4434-805c-eeb0f0e6f797';
  -- guard-allow: function-uuid fixed platform permission identity without declaration-table read access
  support_approve_permission_id constant uuid := '07e4653c-d358-489f-8067-46e085d99478';
  catalogue_fingerprint constant text :=
    'sha256:a434c97c26cd25dfce1e95b83f0dbfe5c5b6de739b35b2729d7f4306bc62285a';
  security_meaning_fingerprint constant text :=
    'sha256:d3b44fd282d1155370c5325aecc38590891afebf6172a29d1b3afcc8501ce745';
  support_request_meaning_fingerprint constant text :=
    'sha256:1cd6a404fef31df331259055de726ca6f176b58994e79946ceb069bac113ce4c';
  support_approve_meaning_fingerprint constant text :=
    'sha256:84b1f9b314ca426256aceec5c156dcc3e771a9d5612505ab77dbcfd89df9c659';
  operation_at timestamptz := pg_catalog.statement_timestamp();
  current_registration vortex_access.permission_registrations%rowtype;
  transition_count bigint;
  resulting_version bigint;
begin
  if p_organization_id is null
    or p_organization_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_changed_by is null
    or p_changed_by = '00000000-0000-0000-0000-000000000000'::uuid
    or p_correlation_id is null
    or p_correlation_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using errcode = '22023',
      message = 'Operator permission catalogue adoption input is invalid';
  end if;

  perform 1
  from vortex_access.organization_access_versions as version
  join vortex_identity.organizations as organization
    on organization.organization_id = version.organization_id
  join vortex_identity.tenants as tenant
    on tenant.tenant_id = organization.tenant_id
  where version.organization_id = p_organization_id
    and organization.state = 'active'
    and tenant.state = 'active'
  for update of version;
  if not found then
    raise exception using errcode = '42501',
      message = 'Operator permission catalogue scope is unavailable';
  end if;

  select registration.* into current_registration
  from vortex_access.permission_registrations as registration
  where registration.organization_id = p_organization_id
    and registration.registration_kind = 'platform'
    and registration.registration_owner_id = platform_owner_id
  for update;
  if not found then
    raise exception using errcode = '55000',
      message = 'Platform permission catalogue is unavailable';
  end if;

  if current_registration.revision = 5 then
    if not vortex_access.platform_permission_catalogue_revision_is_exact(
      p_organization_id, 5
    ) then
      raise exception using errcode = '55000',
        message = 'Operator permission catalogue evidence is invalid';
    end if;
    select version.current_version into strict resulting_version
    from vortex_access.organization_access_versions as version
    where version.organization_id = p_organization_id;
    return resulting_version;
  end if;

  if current_registration.revision <> 4
    or not vortex_access.platform_permission_catalogue_revision_is_exact(
      p_organization_id, 4
    ) then
    raise exception using errcode = '55000',
      message = 'Platform permission catalogue source evidence is invalid';
  end if;

  perform 1
  from vortex_access.permission_continuities as continuity
  where continuity.organization_id = p_organization_id
    and continuity.registration_kind = 'platform'
    and continuity.registration_owner_id = platform_owner_id
  order by continuity.owner_kind collate "C", continuity.owner_id,
    continuity.permission_id
  for update;

  insert into vortex_access.permission_registration_revisions (
    organization_id, registration_kind, registration_owner_id, revision, state, operation, source_definition_key, source_version, source_revision, validation_contract_version, permission_catalogue_fingerprint, candidate_fingerprint, changed_at, changed_by, change_correlation_id
  ) values (
    p_organization_id, 'platform', platform_owner_id, 5, 'active', 'platform_metadata_revision', null, '1.3.0', null, null, catalogue_fingerprint, catalogue_fingerprint, operation_at, p_changed_by, p_correlation_id
  );

  insert into vortex_access.permission_catalogue_entries (
    organization_id, registration_kind, registration_owner_id,
    registration_revision, application_root_id, owner_kind, owner_id,
    permission_id, permission_key, label, description, record_type_id,
    action_kind, named_action, administrative, source_kind,
    source_definition_key, source_root_id, source_version, source_revision,
    source_validation_contract_version, source_catalogue_fingerprint,
    meaning_fingerprint, record_scope, field_policy
  )
  select entry.organization_id, entry.registration_kind,
    entry.registration_owner_id, 5, entry.application_root_id,
    entry.owner_kind, entry.owner_id, entry.permission_id,
    entry.permission_key, entry.label, entry.description,
    entry.record_type_id, entry.action_kind, entry.named_action,
    entry.administrative, entry.source_kind, entry.source_definition_key,
    entry.source_root_id, '1.3.0', entry.source_revision,
    entry.source_validation_contract_version,
    catalogue_fingerprint, entry.meaning_fingerprint,
    entry.record_scope, entry.field_policy
  from vortex_access.permission_catalogue_entries as entry
  where entry.organization_id = p_organization_id
    and entry.registration_kind = 'platform'
    and entry.registration_owner_id = platform_owner_id
    and entry.registration_revision = 4;
  get diagnostics transition_count = row_count;
  if transition_count <> 15 then
    raise exception using errcode = '55000',
      message = 'Platform permission catalogue copy is incomplete';
  end if;

  insert into vortex_access.permission_catalogue_entries (
    organization_id, registration_kind, registration_owner_id,
    registration_revision, application_root_id, owner_kind, owner_id,
    permission_id, permission_key, label, description, record_type_id,
    action_kind, named_action, administrative, source_kind,
    source_definition_key, source_root_id, source_version, source_revision,
    source_validation_contract_version, source_catalogue_fingerprint,
    meaning_fingerprint
  ) values
    (
      p_organization_id, 'platform', platform_owner_id, 5, null,
      'platform', platform_owner_id, security_permission_id,
      'platform.security.identities.disable', 'Disable identities',
      'Disable an identity and revoke its active sessions through the identity owner''s protected operation without receiving general identity-administration or business-record authority.',
      null, 'manage', null, true, 'platform_catalogue', null, null,
      '1.3.0', null, null, catalogue_fingerprint,
      security_meaning_fingerprint
    ),
    (
      p_organization_id, 'platform', platform_owner_id, 5, null,
      'platform', platform_owner_id, support_request_permission_id,
      'platform.support.access.request', 'Request support access',
      'Request time-bounded support access to another organisation for a named operator and exact scope without receiving standing access to that organisation.',
      null, 'manage', null, true, 'platform_catalogue', null, null,
      '1.3.0', null, null, catalogue_fingerprint,
      support_request_meaning_fingerprint
    ),
    (
      p_organization_id, 'platform', platform_owner_id, 5, null,
      'platform', platform_owner_id, support_approve_permission_id,
      'platform.organization.support.approve', 'Approve support access',
      'Approve or refuse a time-bounded support-access request for one''s own organisation without granting the requester standing authority.',
      null, 'manage', null, true, 'platform_catalogue', null, null,
      '1.3.0', null, null, catalogue_fingerprint,
      support_approve_meaning_fingerprint
    );

  update vortex_access.permission_continuities as continuity
  set last_processed_registration_revision = 5,
      changed_at = operation_at
  where continuity.organization_id = p_organization_id
    and continuity.application_root_id is null
    and continuity.registration_kind = 'platform'
    and continuity.registration_owner_id = platform_owner_id
    and continuity.state = 'available'
    and continuity.last_processed_registration_revision = 4;
  get diagnostics transition_count = row_count;
  if transition_count <> 15 then
    raise exception using errcode = '55000',
      message = 'Platform permission continuity transition is incomplete';
  end if;

  insert into vortex_access.permission_continuities (
    organization_id, application_root_id, owner_kind, owner_id,
    permission_id, registration_kind, registration_owner_id, state,
    continuity_revision, meaning_fingerprint,
    last_processed_registration_revision, changed_at
  ) values
    (
      p_organization_id, null, 'platform', platform_owner_id,
      security_permission_id, 'platform', platform_owner_id,
      'available', 1, security_meaning_fingerprint, 5, operation_at
    ),
    (
      p_organization_id, null, 'platform', platform_owner_id,
      support_request_permission_id, 'platform', platform_owner_id,
      'available', 1, support_request_meaning_fingerprint, 5, operation_at
    ),
    (
      p_organization_id, null, 'platform', platform_owner_id,
      support_approve_permission_id, 'platform', platform_owner_id,
      'available', 1, support_approve_meaning_fingerprint, 5, operation_at
    );

  update vortex_access.permission_registrations as registration
  set revision = 5,
      source_version = '1.3.0',
      permission_catalogue_fingerprint = catalogue_fingerprint,
      candidate_fingerprint = catalogue_fingerprint,
      changed_at = operation_at,
      changed_by = p_changed_by,
      change_correlation_id = p_correlation_id
  where registration.organization_id = p_organization_id
    and registration.registration_kind = 'platform'
    and registration.registration_owner_id = platform_owner_id
    and registration.revision = 4;
  if not found then
    raise exception using errcode = '40001',
      message = 'Platform permission catalogue changed concurrently';
  end if;

  if not vortex_access.platform_permission_catalogue_revision_is_exact(
    p_organization_id, 5
  ) then
    raise exception using errcode = '55000',
      message = 'Operator permission catalogue evidence is incomplete';
  end if;

  if exists (
    select 1 from vortex_access.organization_roles as role
    where role.organization_id = p_organization_id
  ) then
    perform vortex_access.assert_organization_has_permanent_steward(
      p_organization_id
    );
  end if;

  select incremented.current_version into strict resulting_version
  from vortex_access.increment_organization_access_version(
    p_organization_id, p_changed_by, p_correlation_id,
    'application_access_changed'
  ) as incremented;
  return resulting_version;
end
$$;

ALTER FUNCTION vortex_access.adopt_security_and_support_operator_permission_catalogue(p_organization_id uuid, p_changed_by uuid, p_correlation_id uuid) OWNER TO vortex_owner;

REVOKE ALL ON FUNCTION vortex_access.adopt_security_and_support_operator_permission_catalogue(p_organization_id uuid, p_changed_by uuid, p_correlation_id uuid) FROM PUBLIC;

grant execute on function vortex_access.adopt_security_and_support_operator_permission_catalogue(p_organization_id uuid, p_changed_by uuid, p_correlation_id uuid) to postgres;
