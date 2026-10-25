-- One current name per function: the seven access helpers lose their `_v1` suffix and the
-- "legacy" wording, and the nine functions granted to the request or runtime role lose the
-- `_internal` suffix that marks owner-only helpers. Bodies are unchanged apart from the names
-- they call; the five access coordinators that call the renamed helpers are re-created with the
-- new names. The old functions are dropped.
set role vortex_owner;

CREATE OR REPLACE FUNCTION vortex_access.apply_application_permission_registration_internal(p_operation text, p_expected_revision bigint, p_candidate jsonb, p_changed_by uuid, p_correlation_id uuid) RETURNS TABLE(operation text, organization_id uuid, application_root_id uuid, registration_state text, registration_revision bigint, access_version bigint, correlation_id uuid)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $_$
declare
  operation_at timestamptz;
  candidate_organization_id uuid;
  candidate_application_root_id uuid;
  candidate_release jsonb;
  candidate_release_revision bigint;
  candidate_release_version text;
  candidate_validation_version text;
  candidate_content_fingerprint text;
  candidate_resolution_fingerprint text;
  candidate_catalogue_fingerprint text;
  supplied_candidate_fingerprint text;
  current_registration vortex_access.permission_registrations%rowtype;
  next_revision bigint;
  resulting_version bigint;
  entry_value jsonb;
  permission_value jsonb;
  source_value jsonb;
  entry_owner_kind text;
  entry_owner_id uuid;
  entry_source_revision bigint;
  canonical_application_permissions jsonb;
begin
  if p_operation not in ('register', 'update', 'reactivate')
    or p_candidate is null
    or pg_catalog.jsonb_typeof(p_candidate) <> 'object'
    or p_changed_by is null
    or p_changed_by = '00000000-0000-0000-0000-000000000000'::uuid
    or p_correlation_id is null
    or p_correlation_id = '00000000-0000-0000-0000-000000000000'::uuid
    or (p_operation = 'register' and p_expected_revision is not null)
    or (p_operation <> 'register' and (p_expected_revision is null or p_expected_revision not between 1 and 9007199254740991))
    or p_candidate - array[
      'contractVersion', 'organizationId', 'applicationRootId', 'applicationRelease',
      'applicationCatalogueFingerprint', 'applicationPermissionIds', 'entries',
      'candidateFingerprint'
    ]::text[] <> '{}'::jsonb
    or not (p_candidate ?& array[
      'contractVersion', 'organizationId', 'applicationRootId', 'applicationRelease',
      'applicationCatalogueFingerprint', 'applicationPermissionIds', 'entries',
      'candidateFingerprint'
    ])
    or p_candidate ->> 'contractVersion' <> '1.0.0'
    or pg_catalog.jsonb_typeof(p_candidate -> 'applicationRelease') <> 'object'
    or pg_catalog.jsonb_typeof(p_candidate -> 'applicationPermissionIds') <> 'array'
    or pg_catalog.jsonb_typeof(p_candidate -> 'entries') <> 'array' then
    raise exception using errcode = '22023', message = 'Application permission registration input is invalid';
  end if;

  begin
    candidate_organization_id := (p_candidate ->> 'organizationId')::uuid;
    candidate_application_root_id := (p_candidate ->> 'applicationRootId')::uuid;
    candidate_release := p_candidate -> 'applicationRelease';
    candidate_release_revision := (candidate_release ->> 'releaseRevision')::bigint;
    candidate_release_version := candidate_release ->> 'releaseVersion';
    candidate_validation_version := candidate_release ->> 'validationContractVersion';
    candidate_content_fingerprint := candidate_release ->> 'contentFingerprint';
    candidate_resolution_fingerprint := candidate_release ->> 'resolutionFingerprint';
    candidate_catalogue_fingerprint := p_candidate ->> 'applicationCatalogueFingerprint';
    supplied_candidate_fingerprint := p_candidate ->> 'candidateFingerprint';
  exception when invalid_text_representation or numeric_value_out_of_range then
    raise exception using errcode = '22023', message = 'Application permission registration input is invalid';
  end;

  if candidate_organization_id = '00000000-0000-0000-0000-000000000000'::uuid
    or candidate_application_root_id = '00000000-0000-0000-0000-000000000000'::uuid
    or candidate_release - array[
      'kind', 'definitionKey', 'rootId', 'releaseRevision', 'releaseVersion',
      'validationContractVersion', 'contentFingerprint', 'resolutionFingerprint'
    ]::text[] <> '{}'::jsonb
    or not (candidate_release ?& array[
      'kind', 'definitionKey', 'rootId', 'releaseRevision', 'releaseVersion',
      'validationContractVersion', 'contentFingerprint', 'resolutionFingerprint'
    ])
    or candidate_release ->> 'kind' <> 'application'
    or (candidate_release ->> 'rootId')::uuid <> candidate_application_root_id
    or candidate_release_revision not between 1 and 9007199254740991
    or candidate_catalogue_fingerprint !~ '^sha256:[a-f0-9]{64}$'
    or supplied_candidate_fingerprint !~ '^sha256:[a-f0-9]{64}$' then
    raise exception using errcode = '22023', message = 'Application permission registration input is invalid';
  end if;

  perform 1
  from vortex_access.organization_access_versions as version
  join vortex_identity.organizations as organization
    on organization.organization_id = version.organization_id
  join vortex_identity.tenants as tenant on tenant.tenant_id = organization.tenant_id
  where version.organization_id = candidate_organization_id
    and organization.state = 'active'
    and tenant.state = 'active'
  for update of version;
  if not found then
    raise exception using errcode = '42501', message = 'Application permission registration scope is unavailable';
  end if;

  select release.compilation_output #> '{canonical,content,permissions}'
  into canonical_application_permissions
    from vortex_definition.roots as root
    join vortex_definition.releases as release on release.root_id = root.root_id
    where root.root_id = candidate_application_root_id
      and root.organization_id = candidate_organization_id
      and root.kind = 'application'
      and root.key = candidate_release ->> 'definitionKey'
      and release.release_revision = candidate_release_revision
      and release.release_version = candidate_release_version
      and release.validation_contract_version = candidate_validation_version
      and release.content_fingerprint = candidate_content_fingerprint
      and release.resolution_fingerprint = candidate_resolution_fingerprint;
  if not found
    or pg_catalog.jsonb_typeof(canonical_application_permissions) is distinct from 'array' then
    raise exception using errcode = '40001', message = 'Application permission release evidence is stale or unavailable';
  end if;

  for entry_value in
    select item.entry from pg_catalog.jsonb_array_elements(p_candidate -> 'entries') as item(entry)
  loop
    if pg_catalog.jsonb_typeof(entry_value) <> 'object'
      or entry_value - array[
        'applicationRootId', 'ownerKind', 'ownerId', 'permission',
        'sourceRelease', 'meaningFingerprint'
      ]::text[] <> '{}'::jsonb
      or (entry_value ->> 'applicationRootId')::uuid <> candidate_application_root_id
      or pg_catalog.jsonb_typeof(entry_value -> 'permission') <> 'object'
      or pg_catalog.jsonb_typeof(entry_value -> 'sourceRelease') <> 'object'
      or entry_value ->> 'meaningFingerprint' !~ '^sha256:[a-f0-9]{64}$' then
      raise exception using errcode = '22023', message = 'Application permission entry is invalid';
    end if;
    permission_value := entry_value -> 'permission';
    source_value := entry_value -> 'sourceRelease';
    begin
      entry_owner_kind := entry_value ->> 'ownerKind';
      entry_owner_id := (entry_value ->> 'ownerId')::uuid;
      entry_source_revision := (source_value ->> 'releaseRevision')::bigint;
    exception when invalid_text_representation or numeric_value_out_of_range then
      raise exception using errcode = '22023', message = 'Application permission entry is invalid';
    end;
    if entry_owner_kind not in ('application', 'module')
      or entry_owner_id = '00000000-0000-0000-0000-000000000000'::uuid
      or permission_value - array[
        'permissionId', 'key', 'label', 'description', 'recordTypeId',
        'recordScope', 'fieldPolicy', 'actionKind', 'namedAction', 'administrative'
      ]::text[] <> '{}'::jsonb
      or not (permission_value ?& array[
        'permissionId', 'key', 'label', 'description', 'actionKind', 'administrative'
      ])
      or (
        permission_value ? 'recordScope'
        and (
          permission_value ->> 'recordTypeId' is null
          or pg_catalog.jsonb_typeof(permission_value -> 'recordScope') is distinct from 'object'
        )
      )
      or (
        permission_value ? 'fieldPolicy'
        and (
          permission_value ->> 'recordTypeId' is null
          or not vortex_access.permission_field_policy_is_valid(
            permission_value -> 'fieldPolicy'
          )
        )
      )
      or source_value - array[
        'kind', 'definitionKey', 'rootId', 'releaseRevision', 'releaseVersion',
        'validationContractVersion', 'contentFingerprint', 'resolutionFingerprint'
      ]::text[] <> '{}'::jsonb
      or not (source_value ?& array[
        'kind', 'definitionKey', 'rootId', 'releaseRevision', 'releaseVersion',
        'validationContractVersion', 'contentFingerprint', 'resolutionFingerprint'
      ])
      or source_value ->> 'kind' <> entry_owner_kind
      or (source_value ->> 'rootId')::uuid <> entry_owner_id
      or entry_source_revision not between 1 and 9007199254740991 then
      raise exception using errcode = '22023', message = 'Application permission entry is invalid';
    end if;
    if entry_owner_kind = 'application' then
      if entry_owner_id <> candidate_application_root_id or source_value <> candidate_release then
        raise exception using errcode = '40001', message = 'Application permission ownership evidence is stale or unavailable';
      end if;
    elsif not exists (
      select 1
      from vortex_definition.reachable_module_dependency_edges(
        candidate_application_root_id, candidate_release_revision
      ) as dependency
      join vortex_definition.roots as module_root on module_root.root_id = dependency.target_root_id
      join vortex_definition.releases as module_release
        on module_release.root_id = dependency.target_root_id
        and module_release.release_revision = dependency.target_release_revision
      where dependency.target_root_id = entry_owner_id
        and dependency.target_release_revision = entry_source_revision
        and dependency.dependency_reference = source_value ->> 'definitionKey'
        and dependency.dependency_version = source_value ->> 'releaseVersion'
        and dependency.dependency_content_fingerprint = source_value ->> 'contentFingerprint'
        and module_root.organization_id = candidate_organization_id
        and module_root.kind = 'module'
        and module_root.key = source_value ->> 'definitionKey'
        and module_release.release_version = source_value ->> 'releaseVersion'
        and module_release.validation_contract_version = source_value ->> 'validationContractVersion'
        and module_release.content_fingerprint = source_value ->> 'contentFingerprint'
        and module_release.resolution_fingerprint = source_value ->> 'resolutionFingerprint'
    ) then
      raise exception using errcode = '40001', message = 'Module permission ownership evidence is stale or unavailable';
    end if;
  end loop;

  if coalesce(
    (
      select pg_catalog.jsonb_agg(stored.permission_value order by
        (stored.permission_value ->> 'key') collate "C",
        (stored.permission_value ->> 'permissionId') collate "C")
      from pg_catalog.jsonb_array_elements(canonical_application_permissions) as stored(permission_value)
    ),
    '[]'::jsonb
  ) is distinct from coalesce(
    (
      select pg_catalog.jsonb_agg(item.entry_value -> 'permission' order by
        (item.entry_value #>> '{permission,key}') collate "C",
        (item.entry_value #>> '{permission,permissionId}') collate "C")
      from pg_catalog.jsonb_array_elements(p_candidate -> 'entries') as item(entry_value)
      where item.entry_value ->> 'ownerKind' = 'application'
    ),
    '[]'::jsonb
  ) then
    raise exception using errcode = '40001', message = 'Application permission declarations are stale or unavailable';
  end if;

  if exists (
    select 1
    from vortex_definition.reachable_module_dependency_edges(
      candidate_application_root_id, candidate_release_revision
    ) as dependency
    join vortex_definition.releases as module_release
      on module_release.root_id = dependency.target_root_id
      and module_release.release_revision = dependency.target_release_revision
    where (
        pg_catalog.jsonb_typeof(
          module_release.compilation_output #> '{canonical,content,permissions}'
        ) is distinct from 'array'
        or coalesce(
          (
            select pg_catalog.jsonb_agg(stored.permission_value order by
              (stored.permission_value ->> 'key') collate "C",
              (stored.permission_value ->> 'permissionId') collate "C")
            from pg_catalog.jsonb_array_elements(
              module_release.compilation_output #> '{canonical,content,permissions}'
            ) as stored(permission_value)
          ),
          '[]'::jsonb
        ) is distinct from coalesce(
          (
            select pg_catalog.jsonb_agg(item.entry_value -> 'permission' order by
              (item.entry_value #>> '{permission,key}') collate "C",
              (item.entry_value #>> '{permission,permissionId}') collate "C")
            from pg_catalog.jsonb_array_elements(p_candidate -> 'entries') as item(entry_value)
            where item.entry_value ->> 'ownerKind' = 'module'
              and (item.entry_value ->> 'ownerId')::uuid = dependency.target_root_id
          ),
          '[]'::jsonb
        )
      )
  ) then
    raise exception using errcode = '40001', message = 'Module permission declarations are stale or unavailable';
  end if;

  if coalesce(
    (
      select pg_catalog.jsonb_agg(item.entry_value order by
        (item.entry_value ->> 'ownerKind') collate "C",
        (item.entry_value ->> 'ownerId') collate "C",
        (item.entry_value #>> '{permission,key}') collate "C",
        (item.entry_value #>> '{permission,permissionId}') collate "C")
      from pg_catalog.jsonb_array_elements(p_candidate -> 'entries') as item(entry_value)
    ),
    '[]'::jsonb
  ) <> p_candidate -> 'entries' then
    raise exception using errcode = '22023', message = 'Application permission entry order is invalid';
  end if;

  if (
    select coalesce(
      pg_catalog.jsonb_agg(permission.permission_value ->> 'permissionId' order by
        (permission.permission_value ->> 'key') collate "C",
        (permission.permission_value ->> 'permissionId') collate "C"),
      '[]'::jsonb
    )
    from pg_catalog.jsonb_array_elements(p_candidate -> 'entries') as item(entry_value)
    cross join lateral (select item.entry_value -> 'permission' as permission_value) as permission
    where item.entry_value ->> 'ownerKind' = 'application'
      and (permission.permission_value ->> 'administrative')::boolean = false
  ) <> p_candidate -> 'applicationPermissionIds' then
    raise exception using errcode = '22023', message = 'Application permission snapshot is invalid';
  end if;

  select registration.* into current_registration
  from vortex_access.permission_registrations as registration
  where registration.organization_id = candidate_organization_id
    and registration.registration_kind = 'application'
    and registration.registration_owner_id = candidate_application_root_id;

  if p_operation = 'register' then
    if found then
      raise exception using errcode = '40001', message = 'Application permission registration already exists';
    end if;
    next_revision := 1;
  else
    if not found
      or current_registration.revision <> p_expected_revision
      or current_registration.revision = 9007199254740991
      or (p_operation = 'update' and current_registration.state <> 'active')
      or (p_operation = 'reactivate' and current_registration.state <> 'withdrawn') then
      raise exception using errcode = '40001', message = 'Application permission registration revision is stale or unavailable';
    end if;
    next_revision := current_registration.revision + 1;
  end if;

  if p_operation = 'register' then
    operation_at := pg_catalog.clock_timestamp();
  else
    operation_at := greatest(
      current_registration.changed_at,
      pg_catalog.clock_timestamp()
    );
  end if;

  insert into vortex_access.permission_registration_revisions (
    organization_id, registration_kind, registration_owner_id, revision, state, operation, source_definition_key, source_version, source_revision, validation_contract_version, permission_catalogue_fingerprint, candidate_fingerprint, changed_at, changed_by, change_correlation_id
  ) values (
    candidate_organization_id, 'application', candidate_application_root_id, next_revision, 'active', p_operation, candidate_release ->> 'definitionKey', candidate_release_version, candidate_release_revision, candidate_validation_version, candidate_catalogue_fingerprint, supplied_candidate_fingerprint, operation_at, p_changed_by, p_correlation_id
  );

  insert into vortex_access.permission_catalogue_entries (
    organization_id, registration_kind, registration_owner_id, registration_revision,
    application_root_id, owner_kind, owner_id, permission_id, permission_key,
    label, description, record_type_id, action_kind, named_action, administrative,
    source_kind, source_definition_key, source_root_id, source_version, source_revision,
    source_validation_contract_version, source_catalogue_fingerprint, meaning_fingerprint,
    record_scope, field_policy
  )
  select candidate_organization_id, 'application', candidate_application_root_id,
    next_revision, candidate_application_root_id, item.entry_value ->> 'ownerKind',
    (item.entry_value ->> 'ownerId')::uuid,
    (permission.permission_value ->> 'permissionId')::uuid,
    permission.permission_value ->> 'key', permission.permission_value ->> 'label',
    permission.permission_value ->> 'description',
    (permission.permission_value ->> 'recordTypeId')::uuid,
    permission.permission_value ->> 'actionKind',
    permission.permission_value ->> 'namedAction',
    (permission.permission_value ->> 'administrative')::boolean,
    source.source_value ->> 'kind', source.source_value ->> 'definitionKey',
    (source.source_value ->> 'rootId')::uuid, source.source_value ->> 'releaseVersion',
    (source.source_value ->> 'releaseRevision')::bigint,
    source.source_value ->> 'validationContractVersion', null,
    item.entry_value ->> 'meaningFingerprint',
    permission.permission_value -> 'recordScope',
    permission.permission_value -> 'fieldPolicy'
  from pg_catalog.jsonb_array_elements(p_candidate -> 'entries') as item(entry_value)
  cross join lateral (select item.entry_value -> 'permission' as permission_value) as permission
  cross join lateral (select item.entry_value -> 'sourceRelease' as source_value) as source;

  if p_operation = 'register' then
    insert into vortex_access.permission_registrations (
    organization_id, registration_kind, registration_owner_id, state, revision, source_definition_key, source_version, source_revision, validation_contract_version, permission_catalogue_fingerprint, candidate_fingerprint, changed_at, changed_by, change_correlation_id
  ) values (
    candidate_organization_id, 'application', candidate_application_root_id, 'active', next_revision, candidate_release ->> 'definitionKey', candidate_release_version, candidate_release_revision, candidate_validation_version, candidate_catalogue_fingerprint, supplied_candidate_fingerprint, operation_at, p_changed_by, p_correlation_id
  );
  else
    update vortex_access.permission_registrations as registration
    set state = 'active', revision = next_revision,
        source_definition_key = candidate_release ->> 'definitionKey',
        source_version = candidate_release_version,
        source_revision = candidate_release_revision,
        validation_contract_version = candidate_validation_version,
        permission_catalogue_fingerprint = candidate_catalogue_fingerprint,
        candidate_fingerprint = supplied_candidate_fingerprint,
        changed_at = operation_at, changed_by = p_changed_by,
        change_correlation_id = p_correlation_id
    where registration.organization_id = candidate_organization_id
      and registration.registration_kind = 'application'
      and registration.registration_owner_id = candidate_application_root_id;
  end if;

  select incremented.current_version into resulting_version
  from vortex_access.increment_organization_access_version(
    candidate_organization_id, p_changed_by, p_correlation_id, 'application_access_changed'
  ) as incremented;

  return query select p_operation, candidate_organization_id, candidate_application_root_id,
    'active'::text, next_revision, resulting_version, p_correlation_id;
exception when invalid_text_representation or numeric_value_out_of_range then
  raise exception using errcode = '22023', message = 'Application permission registration input is invalid';
end
$_$;

ALTER FUNCTION vortex_access.apply_application_permission_registration_internal(p_operation text, p_expected_revision bigint, p_candidate jsonb, p_changed_by uuid, p_correlation_id uuid) OWNER TO vortex_owner;

COMMENT ON FUNCTION vortex_access.apply_application_permission_registration_internal(p_operation text, p_expected_revision bigint, p_candidate jsonb, p_changed_by uuid, p_correlation_id uuid) IS 'The registration writer of the coordinated application-access change; owner-only.';

REVOKE ALL ON FUNCTION vortex_access.apply_application_permission_registration_internal(p_operation text, p_expected_revision bigint, p_candidate jsonb, p_changed_by uuid, p_correlation_id uuid) FROM PUBLIC;

grant execute on function vortex_access.apply_application_permission_registration_internal(p_operation text, p_expected_revision bigint, p_candidate jsonb, p_changed_by uuid, p_correlation_id uuid) to postgres;

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
    organization_id, registration_kind, registration_owner_id, revision, state, operation, source_definition_key, source_version, source_revision, validation_contract_version, permission_catalogue_fingerprint, candidate_fingerprint, changed_at, changed_by, change_correlation_id
  ) values (
    p_organization_id, 'application', p_application_root_id, next_revision, 'withdrawn', 'withdraw', current_registration.source_definition_key, current_registration.source_version, current_registration.source_revision, current_registration.validation_contract_version, current_registration.permission_catalogue_fingerprint, current_registration.candidate_fingerprint, operation_at, p_changed_by, p_correlation_id
  );

  insert into vortex_access.permission_catalogue_entries (
    organization_id, registration_kind, registration_owner_id, registration_revision,
    application_root_id, owner_kind, owner_id, permission_id, permission_key,
    label, description, record_type_id, action_kind, named_action, administrative,
    source_kind, source_definition_key, source_root_id, source_version, source_revision,
    source_validation_contract_version, source_catalogue_fingerprint, meaning_fingerprint,
    record_scope, field_policy
  )
  select entry.organization_id, entry.registration_kind, entry.registration_owner_id,
    next_revision, entry.application_root_id, entry.owner_kind, entry.owner_id,
    entry.permission_id, entry.permission_key, entry.label, entry.description,
    entry.record_type_id, entry.action_kind, entry.named_action, entry.administrative,
    entry.source_kind, entry.source_definition_key, entry.source_root_id,
    entry.source_version, entry.source_revision, entry.source_validation_contract_version,
    entry.source_catalogue_fingerprint, entry.meaning_fingerprint, entry.record_scope,
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

CREATE OR REPLACE FUNCTION vortex_access.change_account_state_without_stewardship_internal(p_organization_account_id uuid, p_expected_revision bigint, p_state text) RETURNS TABLE(organization_account_id uuid, organization_id uuid, identity_id uuid, display_name text, state text, language text, time_zone text, invitation_id uuid, activated_at timestamp with time zone, suspended_at timestamp with time zone, closed_at timestamp with time zone, changed_at timestamp with time zone, state_changed_at timestamp with time zone, state_changed_by uuid, state_change_correlation_id uuid, revision bigint, access_version bigint)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  changed record;
  checked jsonb;
  resulting_version bigint;
begin
  checked := vortex_identity.validated_human_account_context();

  select * into changed
  from vortex_identity.change_organization_account_state(
    p_organization_account_id,
    p_expected_revision,
    p_state
  );

  select incremented.current_version into resulting_version
  from vortex_access.increment_organization_access_version(
    changed.organization_id,
    (checked ->> 'organizationAccountId')::uuid,
    (checked ->> 'correlationId')::uuid,
    case changed.state
      when 'active' then 'organization_account_reactivated'
      when 'suspended' then 'organization_account_suspended'
      when 'closed' then 'organization_account_closed'
    end
  ) as incremented;

  return query
  select changed.organization_account_id, changed.organization_id, changed.identity_id,
    changed.display_name, changed.state, changed.language, changed.time_zone,
    changed.invitation_id, changed.activated_at, changed.suspended_at,
    changed.closed_at, changed.changed_at, changed.state_changed_at,
    changed.state_changed_by, changed.state_change_correlation_id,
    changed.revision, resulting_version;
end
$$;

alter function vortex_access.change_account_state_without_stewardship_internal(p_organization_account_id uuid, p_expected_revision bigint, p_state text) owner to vortex_owner;

COMMENT ON FUNCTION vortex_access.change_account_state_without_stewardship_internal(p_organization_account_id uuid, p_expected_revision bigint, p_state text) IS 'Owner-only account lifecycle and Access-version composition reserved for permission-checked administration.';

REVOKE ALL ON FUNCTION vortex_access.change_account_state_without_stewardship_internal(p_organization_account_id uuid, p_expected_revision bigint, p_state text) FROM PUBLIC;

grant execute on function vortex_access.change_account_state_without_stewardship_internal(p_organization_account_id uuid, p_expected_revision bigint, p_state text) to postgres;

CREATE OR REPLACE FUNCTION vortex_access.coordinate_application_access_without_stewardship_internal(p_operation text, p_expected_revision bigint, p_prepared_templates jsonb, p_organization_id uuid, p_application_root_id uuid, p_changed_by uuid, p_correlation_id uuid) RETURNS TABLE(outcome text, operation text, organization_id uuid, application_root_id uuid, registration_state text, registration_revision bigint, access_version bigint, correlation_id uuid)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $_$
declare
  current_registration vortex_access.permission_registrations%rowtype;
  raw_result record;
  first_observation boolean := false;
  permission_candidate jsonb;
  template_value jsonb;
  template_role_id uuid;
  role_record record;
  target_template jsonb;
  current_permission_count bigint;
  retained_permission_count bigint;
  unchanged_permission_count bigint;
  target_permission_count bigint;
  target_lifecycle text;
  next_role_revision bigint;
  next_authority_continuity_revision bigint;
  target_template_continuity_revision bigint;
begin
  if p_operation is null
    or p_operation not in ('register', 'update', 'reactivate', 'withdraw')
    or p_organization_id is null
    or p_organization_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_application_root_id is null
    or p_application_root_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_changed_by is null
    or p_changed_by = '00000000-0000-0000-0000-000000000000'::uuid
    or p_correlation_id is null
    or p_correlation_id = '00000000-0000-0000-0000-000000000000'::uuid
    or (p_operation = 'register' and p_expected_revision is not null)
    or (
      p_operation <> 'register'
      and (
        p_expected_revision is null
        or p_expected_revision not between 1 and 9007199254740991
      )
    ) then
    raise exception using errcode = '22023',
      message = 'Coordinated application access input is invalid';
  end if;

  if p_operation = 'withdraw' then
    if p_prepared_templates is not null then
      raise exception using errcode = '22023',
        message = 'Coordinated application access input is invalid';
    end if;
  else
    if p_prepared_templates is null
      or pg_catalog.jsonb_typeof(p_prepared_templates) is distinct from 'object'
      or p_prepared_templates - array[
        'contractVersion', 'preparationBasis', 'permissionRegistration',
        'templates'
      ]::text[] <> '{}'::jsonb
      or not (p_prepared_templates ?& array[
        'contractVersion', 'preparationBasis', 'permissionRegistration',
        'templates'
      ])
      or p_prepared_templates ->> 'contractVersion' is distinct from '1.0.0'
      or p_prepared_templates -> 'preparationBasis' is distinct from
        '{"kind":"registration_candidate"}'::jsonb
      or pg_catalog.jsonb_typeof(p_prepared_templates -> 'permissionRegistration')
        is distinct from 'object'
      or p_prepared_templates #>> '{permissionRegistration,contractVersion}'
        is distinct from '1.0.0'
      or pg_catalog.jsonb_typeof(p_prepared_templates -> 'templates')
        is distinct from 'array'
      or pg_catalog.jsonb_array_length(p_prepared_templates -> 'templates') = 0
      or (p_prepared_templates #>> '{permissionRegistration,organizationId}')::uuid
        is distinct from
        p_organization_id
      or (p_prepared_templates #>> '{permissionRegistration,applicationRootId}')::uuid
        is distinct from
        p_application_root_id then
      raise exception using errcode = '22023',
        message = 'Coordinated application access preparation is invalid';
    end if;

    permission_candidate := p_prepared_templates -> 'permissionRegistration';
    if exists (
      select 1
      from pg_catalog.jsonb_array_elements(p_prepared_templates -> 'templates') as item(value)
      where pg_catalog.jsonb_typeof(item.value) is distinct from 'object'
        or item.value - array['template', 'sourcePermissions', 'livePermissions']::text[]
          <> '{}'::jsonb
        or not (item.value ?& array['template', 'sourcePermissions', 'livePermissions'])
        or pg_catalog.jsonb_typeof(item.value -> 'template') is distinct from 'object'
        or pg_catalog.jsonb_typeof(item.value -> 'sourcePermissions') is distinct from 'array'
        or pg_catalog.jsonb_typeof(item.value -> 'livePermissions') is distinct from 'array'
        or item.value #>> '{template,roleId}' is null
        or (item.value #>> '{template,roleId}')::uuid =
          '00000000-0000-0000-0000-000000000000'::uuid
    ) or exists (
      select 1
      from pg_catalog.jsonb_array_elements(p_prepared_templates -> 'templates') as item(value)
      group by item.value #>> '{template,roleId}'
      having pg_catalog.count(*) <> 1
    ) or exists (
      select 1
      from pg_catalog.jsonb_array_elements(p_prepared_templates -> 'templates') as item(value)
      cross join lateral pg_catalog.jsonb_array_elements(
        item.value -> 'livePermissions'
      ) as live(value)
      where not exists (
        select 1
        from pg_catalog.jsonb_array_elements(permission_candidate -> 'entries') as entry(value)
        where entry.value = live.value
      )
    ) then
      raise exception using errcode = '22023',
        message = 'Coordinated application access preparation is invalid';
    end if;
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
      message = 'Coordinated application access scope is unavailable';
  end if;

  select registration.* into current_registration
  from vortex_access.permission_registrations as registration
  where registration.organization_id = p_organization_id
    and registration.registration_kind = 'application'
    and registration.registration_owner_id = p_application_root_id
  for update;

  if p_operation = 'register' then
    if found then
      raise exception using errcode = '40001',
        message = 'Application permission registration already exists';
    end if;
  elsif not found
    or current_registration.revision <> p_expected_revision
    or (p_operation in ('update', 'withdraw') and current_registration.state <> 'active')
    or (p_operation = 'reactivate' and current_registration.state <> 'withdrawn') then
    raise exception using errcode = '40001',
      message = 'Application permission registration revision is stale or unavailable';
  end if;

  perform 1
  from vortex_access.permission_continuities as continuity
  where continuity.organization_id = p_organization_id
    and continuity.application_root_id = p_application_root_id
  order by continuity.application_scope_id, continuity.owner_kind collate "C",
    continuity.owner_id, continuity.permission_id
  for update;

  perform 1
  from vortex_access.application_role_template_continuities as continuity
  where continuity.organization_id = p_organization_id
    and continuity.application_root_id = p_application_root_id
  order by continuity.source_role_id
  for update;

  perform 1
  from vortex_access.organization_roles as role
  where role.organization_id = p_organization_id
    and role.role_kind = 'application'
    and role.application_root_id = p_application_root_id
  order by role.role_id
  for update;

  if p_operation <> 'register' then
    first_observation :=
      not exists (
        select 1
        from vortex_access.permission_continuities as continuity
        where continuity.organization_id = p_organization_id
          and continuity.application_root_id = p_application_root_id
      )
      and not exists (
        select 1
        from vortex_access.application_role_template_continuities as continuity
        where continuity.organization_id = p_organization_id
          and continuity.application_root_id = p_application_root_id
      )
      and not exists (
        select 1
        from vortex_access.organization_roles as role
        where role.organization_id = p_organization_id
          and role.role_kind = 'application'
          and role.application_root_id = p_application_root_id
      )
      and not exists (
        select 1
        from vortex_access.organization_role_revisions as revision
        where revision.organization_id = p_organization_id
          and revision.role_kind = 'application'
          and revision.application_root_id = p_application_root_id
      )
      and not exists (
        select 1
        from vortex_access.organization_role_permission_entries as permission
        where permission.organization_id = p_organization_id
          and permission.application_root_id = p_application_root_id
      );

    if p_operation = 'update'
      and vortex_access.application_permission_registration_matches_candidate(
        p_organization_id, p_application_root_id, current_registration.revision,
        permission_candidate
      )
      and not first_observation then
      if not vortex_access.application_access_current_state_matches_candidate(
          p_organization_id, p_application_root_id, current_registration.revision,
          p_prepared_templates
      ) then
        raise exception using errcode = '55000',
          message = 'Coordinated application access state is incomplete';
      end if;

      return query
      select 'unchanged'::text, p_operation, p_organization_id, p_application_root_id,
        current_registration.state, current_registration.revision,
        version.current_version, p_correlation_id
      from vortex_access.organization_access_versions as version
      where version.organization_id = p_organization_id;
      return;
    end if;

    if current_registration.revision = 9007199254740991 then
      raise exception using errcode = '22003',
        message = 'Application permission registration revision is exhausted';
    end if;
  end if;

  -- The organization version row is already locked. Check before invoking the
  -- registration helper, whose input-error handler also catches numeric overflow.
  -- A complete exact no-op returned above does not need a new Access version.
  if exists (
    select 1 from vortex_access.organization_access_versions as version
    where version.organization_id = p_organization_id
      and version.current_version >= 9007199254740991
  ) then
    raise exception using errcode = '22003',
      message = 'Organization Access version is exhausted';
  end if;

  if first_observation then
    insert into vortex_access.permission_continuities (
      organization_id, application_root_id, owner_kind, owner_id, permission_id,
      registration_kind, registration_owner_id, state, continuity_revision,
      meaning_fingerprint, last_processed_registration_revision, changed_at
    )
    select entry.organization_id, entry.application_root_id, entry.owner_kind,
      entry.owner_id, entry.permission_id, 'application', p_application_root_id,
      case when current_registration.state = 'active' then 'available' else 'unavailable' end,
      1, entry.meaning_fingerprint, current_registration.revision,
      pg_catalog.statement_timestamp()
    from vortex_access.permission_catalogue_entries as entry
    where entry.organization_id = p_organization_id
      and entry.registration_kind = 'application'
      and entry.registration_owner_id = p_application_root_id
      and entry.registration_revision = current_registration.revision;
  end if;

  if not first_observation
    and current_registration.state = 'active'
    and not exists (
      select 1
      from vortex_access.application_role_template_continuities as continuity
      where continuity.organization_id = p_organization_id
        and continuity.application_root_id = p_application_root_id
    ) then
    raise exception using errcode = '55000',
      message = 'Coordinated application access state is incomplete';
  end if;

  if p_operation = 'withdraw' then
    select changed.* into strict raw_result
    from vortex_access.withdraw_application_permission_registration_internal(
      p_organization_id, p_application_root_id, p_expected_revision,
      p_changed_by, p_correlation_id
    ) as changed;
  else
    select changed.* into strict raw_result
    from vortex_access.apply_application_permission_registration_internal(
      p_operation, p_expected_revision, permission_candidate,
      p_changed_by, p_correlation_id
    ) as changed;
  end if;

  if exists (
    with target as (
      select entry.application_root_id, entry.owner_kind, entry.owner_id,
        entry.permission_id, entry.meaning_fingerprint
      from vortex_access.permission_catalogue_entries as entry
      where raw_result.registration_state = 'active'
        and entry.organization_id = p_organization_id
        and entry.registration_kind = 'application'
        and entry.registration_owner_id = p_application_root_id
        and entry.registration_revision = raw_result.registration_revision
    )
    select 1
    from vortex_access.permission_continuities as continuity
    left join target
      on target.application_root_id = continuity.application_root_id
      and target.owner_kind = continuity.owner_kind
      and target.owner_id = continuity.owner_id
      and target.permission_id = continuity.permission_id
    where continuity.organization_id = p_organization_id
      and continuity.application_root_id = p_application_root_id
      and continuity.continuity_revision = 9007199254740991
      and (
        (target.permission_id is null and continuity.state <> 'unavailable')
        or (target.permission_id is not null and continuity.state <> 'available')
      )
  ) then
    raise exception using errcode = '22003',
      message = 'Application permission continuity revision is exhausted';
  end if;

  with target as (
    select entry.application_root_id, entry.owner_kind, entry.owner_id,
      entry.permission_id, entry.meaning_fingerprint
    from vortex_access.permission_catalogue_entries as entry
    where raw_result.registration_state = 'active'
      and entry.organization_id = p_organization_id
      and entry.registration_kind = 'application'
      and entry.registration_owner_id = p_application_root_id
      and entry.registration_revision = raw_result.registration_revision
  ), transition as (
    select continuity.ctid as continuity_row, target.permission_id as target_permission_id,
      target.meaning_fingerprint as target_meaning_fingerprint
    from vortex_access.permission_continuities as continuity
    left join target
      on target.application_root_id = continuity.application_root_id
      and target.owner_kind = continuity.owner_kind
      and target.owner_id = continuity.owner_id
      and target.permission_id = continuity.permission_id
    where continuity.organization_id = p_organization_id
      and continuity.application_root_id = p_application_root_id
  )
  update vortex_access.permission_continuities as continuity
  set state = case
        when transition.target_permission_id is null then 'unavailable'
        else 'available'
      end,
      -- The continuity revision is the permission's availability lineage: it advances only
      -- when the permission is withdrawn or registered again. A meaning change while it stays
      -- registered keeps the lineage; roles keep the meaning they accepted until they accept
      -- the new one.
      continuity_revision = case
        when transition.target_permission_id is not null
          and continuity.state = 'available'
          then continuity.continuity_revision
        when transition.target_permission_id is null
          and continuity.state = 'unavailable'
          then continuity.continuity_revision
        else continuity.continuity_revision + 1
      end,
      meaning_fingerprint = coalesce(
        transition.target_meaning_fingerprint, continuity.meaning_fingerprint
      ),
      last_processed_registration_revision = raw_result.registration_revision,
      changed_at = pg_catalog.statement_timestamp()
  from transition
  where continuity.ctid = transition.continuity_row;

  if raw_result.registration_state = 'active' then
    insert into vortex_access.permission_continuities (
      organization_id, application_root_id, owner_kind, owner_id, permission_id,
      registration_kind, registration_owner_id, state, continuity_revision,
      meaning_fingerprint, last_processed_registration_revision, changed_at
    )
    select entry.organization_id, entry.application_root_id, entry.owner_kind,
      entry.owner_id, entry.permission_id, 'application', p_application_root_id,
      'available', 1, entry.meaning_fingerprint, raw_result.registration_revision,
      pg_catalog.statement_timestamp()
    from vortex_access.permission_catalogue_entries as entry
    where entry.organization_id = p_organization_id
      and entry.registration_kind = 'application'
      and entry.registration_owner_id = p_application_root_id
      and entry.registration_revision = raw_result.registration_revision
      and not exists (
        select 1
        from vortex_access.permission_continuities as continuity
        where continuity.organization_id = entry.organization_id
          and continuity.application_root_id = entry.application_root_id
          and continuity.owner_kind = entry.owner_kind
          and continuity.owner_id = entry.owner_id
          and continuity.permission_id = entry.permission_id
      );
  end if;

  if exists (
    with target as (
      select (item.value #>> '{template,roleId}')::uuid as source_role_id
      from pg_catalog.jsonb_array_elements(
        case when raw_result.registration_state = 'active'
          then p_prepared_templates -> 'templates'
          else '[]'::jsonb
        end
      ) as item(value)
    )
    select 1
    from vortex_access.application_role_template_continuities as continuity
    left join target on target.source_role_id = continuity.source_role_id
    where continuity.organization_id = p_organization_id
      and continuity.application_root_id = p_application_root_id
      and continuity.continuity_revision = 9007199254740991
      and (
        (target.source_role_id is null and continuity.state <> 'unavailable')
        or (
          target.source_role_id is not null
          and continuity.state <> 'available'
        )
      )
  ) then
    raise exception using errcode = '22003',
      message = 'Application role template continuity revision is exhausted';
  end if;

  with target as (
    select (item.value #>> '{template,roleId}')::uuid as source_role_id,
      item.value #>> '{template,key}' as role_key,
      item.value #>> '{template,name}' as role_label
    from pg_catalog.jsonb_array_elements(
      case when raw_result.registration_state = 'active'
        then p_prepared_templates -> 'templates'
        else '[]'::jsonb
      end
    ) as item(value)
  ), transition as (
    select continuity.ctid as continuity_row, target.source_role_id as target_role_id,
      target.role_key, target.role_label
    from vortex_access.application_role_template_continuities as continuity
    left join target on target.source_role_id = continuity.source_role_id
    where continuity.organization_id = p_organization_id
      and continuity.application_root_id = p_application_root_id
  )
  update vortex_access.application_role_template_continuities as continuity
  set state = case when transition.target_role_id is null
        then 'unavailable' else 'available' end,
      key = coalesce(transition.role_key, continuity.key),
      label = coalesce(transition.role_label, continuity.label),
      continuity_revision = case
        when transition.target_role_id is not null and continuity.state = 'available'
          then continuity.continuity_revision
        when transition.target_role_id is null and continuity.state = 'unavailable'
          then continuity.continuity_revision
        else continuity.continuity_revision + 1
      end,
      last_processed_registration_revision = raw_result.registration_revision,
      changed_at = pg_catalog.statement_timestamp()
  from transition
  where continuity.ctid = transition.continuity_row;

  if raw_result.registration_state = 'active' then
    insert into vortex_access.application_role_template_continuities (
      organization_id, application_root_id, source_role_id, state,
      continuity_revision, last_processed_registration_revision, changed_at,
      key, label
    )
    select p_organization_id, p_application_root_id,
      (item.value #>> '{template,roleId}')::uuid, 'available', 1,
      raw_result.registration_revision, pg_catalog.statement_timestamp(),
      item.value #>> '{template,key}', item.value #>> '{template,name}'
    from pg_catalog.jsonb_array_elements(p_prepared_templates -> 'templates') as item(value)
    where not exists (
      select 1
      from vortex_access.application_role_template_continuities as continuity
      where continuity.organization_id = p_organization_id
        and continuity.application_root_id = p_application_root_id
        and continuity.source_role_id = (item.value #>> '{template,roleId}')::uuid
    );
  end if;

  for role_record in
    select role.role_id, role.source_role_id, role.live_revision,
      revision.lifecycle, revision.privilege_classification,
      revision.assignment_policy, revision.policy_continuity_revision,
      revision.authority_continuity_revision,
      revision.activation_policy_id, revision.activation_policy_revision,
      revision.role_key,
      revision.label, revision.description, revision.source_definition_key,
      revision.source_release_revision, revision.source_release_version,
      revision.source_validation_contract_version,
      revision.accepted_registration_revision,
      revision.template_continuity_revision
    from vortex_access.organization_roles as role
    join vortex_access.organization_role_revisions as revision
      on revision.organization_id = role.organization_id
      and revision.role_id = role.role_id
      and revision.revision = role.live_revision
    where role.organization_id = p_organization_id
      and role.role_kind = 'application'
      and role.application_root_id = p_application_root_id
    order by role.role_id
  loop
    if role_record.lifecycle = 'retired' then
      continue;
    end if;

    target_template := null;
    target_template_continuity_revision := null;
    if raw_result.registration_state = 'active' then
      select item.value, continuity.continuity_revision
      into target_template, target_template_continuity_revision
      from pg_catalog.jsonb_array_elements(p_prepared_templates -> 'templates')
        as item(value)
      join vortex_access.application_role_template_continuities as continuity
        on continuity.organization_id = p_organization_id
        and continuity.application_root_id = p_application_root_id
        and continuity.source_role_id =
          (item.value #>> '{template,roleId}')::uuid
        and continuity.state = 'available'
      where (item.value #>> '{template,roleId}')::uuid = role_record.source_role_id;
    end if;

    select pg_catalog.count(*) into current_permission_count
    from vortex_access.organization_role_permission_entries as permission
    where permission.organization_id = p_organization_id
      and permission.role_id = role_record.role_id
      and permission.role_revision = role_record.live_revision;

    if target_template is null then
      retained_permission_count := 0;
      target_permission_count := 0;
      target_lifecycle := 'unavailable';
    else
      -- A role keeps every permission the template still grants, with the
      -- meaning it was accepted under: a changed meaning is neither applied
      -- nor dropped until the role revision is accepted. A permission the
      -- template no longer grants, or that is no longer registered, leaves.
      select pg_catalog.count(*) into retained_permission_count
      from vortex_access.organization_role_permission_entries as permission
      join vortex_access.permission_continuities as continuity
        on continuity.organization_id = permission.organization_id
        and continuity.application_root_id = permission.application_root_id
        and continuity.owner_kind = permission.owner_kind
        and continuity.owner_id = permission.owner_id
        and continuity.permission_id = permission.permission_id
        and continuity.state = 'available'
        and continuity.continuity_revision = permission.continuity_revision
      where permission.organization_id = p_organization_id
        and permission.role_id = role_record.role_id
        and permission.role_revision = role_record.live_revision
        and exists (
          select 1
          from pg_catalog.jsonb_array_elements(
            target_template -> 'livePermissions'
          ) as candidate(value)
          where (candidate.value ->> 'applicationRootId')::uuid =
              permission.application_root_id
            and candidate.value ->> 'ownerKind' = permission.owner_kind
            and (candidate.value ->> 'ownerId')::uuid = permission.owner_id
            and (candidate.value #>> '{permission,permissionId}')::uuid =
              permission.permission_id
        );
      select pg_catalog.count(*) into unchanged_permission_count
      from vortex_access.organization_role_permission_entries as permission
      join vortex_access.permission_continuities as continuity
        on continuity.organization_id = permission.organization_id
        and continuity.application_root_id = permission.application_root_id
        and continuity.owner_kind = permission.owner_kind
        and continuity.owner_id = permission.owner_id
        and continuity.permission_id = permission.permission_id
        and continuity.state = 'available'
        and continuity.continuity_revision = permission.continuity_revision
        and continuity.meaning_fingerprint = permission.meaning_fingerprint
      where permission.organization_id = p_organization_id
        and permission.role_id = role_record.role_id
        and permission.role_revision = role_record.live_revision
        and exists (
          select 1
          from pg_catalog.jsonb_array_elements(
            target_template -> 'livePermissions'
          ) as candidate(value)
          where (candidate.value ->> 'applicationRootId')::uuid =
              permission.application_root_id
            and candidate.value ->> 'ownerKind' = permission.owner_kind
            and (candidate.value ->> 'ownerId')::uuid = permission.owner_id
            and (candidate.value #>> '{permission,permissionId}')::uuid =
              permission.permission_id
            and candidate.value ->> 'meaningFingerprint' =
              permission.meaning_fingerprint
        );
      target_permission_count := pg_catalog.jsonb_array_length(
        target_template -> 'livePermissions'
      );
      -- ACCEPTANCE INVARIANT: a role stays active only when it holds every
      -- permission of the template with exactly its registered meaning. Any
      -- meaning change, added or removed permission requires acceptance. The
      -- release version class (patch, minor or major) is never consulted.
      if role_record.lifecycle = 'active'
        and unchanged_permission_count > 0
        and unchanged_permission_count = target_permission_count
        and retained_permission_count = target_permission_count
        and role_record.template_continuity_revision =
          target_template_continuity_revision then
        target_lifecycle := 'active';
      else
        target_lifecycle := 'acceptance_required';
      end if;
    end if;

    if role_record.lifecycle = target_lifecycle
      and current_permission_count = retained_permission_count then
      continue;
    end if;

    if role_record.live_revision = 9007199254740991 then
      raise exception using errcode = '22003',
        message = 'Organization role revision is exhausted';
    end if;
    next_role_revision := role_record.live_revision + 1;
    next_authority_continuity_revision :=
      role_record.authority_continuity_revision;
    if role_record.lifecycle in ('unavailable', 'retired')
      and target_lifecycle in ('active', 'acceptance_required') then
      if role_record.authority_continuity_revision = 9007199254740991 then
        raise exception using errcode = '22003',
          message = 'Organization role authority continuity is exhausted';
      end if;
      next_authority_continuity_revision :=
        role_record.authority_continuity_revision + 1;
    end if;

    if target_template is not null then
      insert into vortex_access.organization_role_permission_entries (
        organization_id, role_id, role_revision, entry_ordinal, role_kind,
        role_application_root_id, application_root_id, owner_kind, owner_id,
        permission_id, registration_kind, registration_owner_id,
        accepted_registration_revision, catalogue_fingerprint,
        continuity_revision, meaning_fingerprint
      )
      select permission.organization_id, permission.role_id, next_role_revision,
        pg_catalog.row_number() over (
          order by permission.application_root_id, permission.owner_kind collate "C",
            permission.owner_id, permission.permission_id
        ), permission.role_kind, permission.role_application_root_id,
        permission.application_root_id, permission.owner_kind,
        permission.owner_id, permission.permission_id,
        permission.registration_kind, permission.registration_owner_id,
        permission.accepted_registration_revision,
        permission.catalogue_fingerprint, permission.continuity_revision,
        permission.meaning_fingerprint
      from vortex_access.organization_role_permission_entries as permission
      join vortex_access.permission_continuities as continuity
        on continuity.organization_id = permission.organization_id
        and continuity.application_root_id = permission.application_root_id
        and continuity.owner_kind = permission.owner_kind
        and continuity.owner_id = permission.owner_id
        and continuity.permission_id = permission.permission_id
        and continuity.state = 'available'
        and continuity.continuity_revision = permission.continuity_revision
      where permission.organization_id = p_organization_id
        and permission.role_id = role_record.role_id
        and permission.role_revision = role_record.live_revision
        and exists (
          select 1
          from pg_catalog.jsonb_array_elements(
            target_template -> 'livePermissions'
          ) as candidate(value)
          where (candidate.value ->> 'applicationRootId')::uuid =
              permission.application_root_id
            and candidate.value ->> 'ownerKind' = permission.owner_kind
            and (candidate.value ->> 'ownerId')::uuid = permission.owner_id
            and (candidate.value #>> '{permission,permissionId}')::uuid =
              permission.permission_id
        );
    end if;

    insert into vortex_access.organization_role_revisions (
      organization_id, role_id, revision, role_kind, application_root_id,
      lifecycle, privilege_classification, assignment_policy,
      policy_continuity_revision, authority_continuity_revision,
      activation_policy_id,
      activation_policy_revision, role_key,
      label, description, source_definition_key, source_release_revision,
      source_release_version, source_validation_contract_version, accepted_registration_revision,
      template_continuity_revision,
      changed_by, changed_at, change_correlation_id
    ) values (
      p_organization_id, role_record.role_id, next_role_revision, 'application',
      p_application_root_id, target_lifecycle,
      role_record.privilege_classification, role_record.assignment_policy,
      role_record.policy_continuity_revision,
      next_authority_continuity_revision, role_record.activation_policy_id,
      role_record.activation_policy_revision,
      role_record.role_key,
      role_record.label, role_record.description,
      role_record.source_definition_key, role_record.source_release_revision,
      role_record.source_release_version,
      role_record.source_validation_contract_version,
      role_record.accepted_registration_revision,
      role_record.template_continuity_revision,
      p_changed_by,
      pg_catalog.statement_timestamp(), p_correlation_id
    );

    update vortex_access.organization_roles as role
    set live_revision = next_role_revision
    where role.organization_id = p_organization_id
      and role.role_id = role_record.role_id
      and role.live_revision = role_record.live_revision;
    if not found then
      raise exception using errcode = '40001',
        message = 'Organization role revision is stale';
    end if;
  end loop;

  return query select 'changed'::text, raw_result.operation,
    raw_result.organization_id, raw_result.application_root_id,
    raw_result.registration_state, raw_result.registration_revision,
    raw_result.access_version, raw_result.correlation_id;
exception
  when invalid_text_representation then
    raise exception using errcode = '22023',
      message = 'Coordinated application access input is invalid';
end
$_$;

COMMENT ON FUNCTION vortex_access.coordinate_application_access_without_stewardship_internal(p_operation text, p_expected_revision bigint, p_prepared_templates jsonb, p_organization_id uuid, p_application_root_id uuid, p_changed_by uuid, p_correlation_id uuid) IS 'Internal application-access implementation retained only behind the stewardship safeguard.';

REVOKE ALL ON FUNCTION vortex_access.coordinate_application_access_without_stewardship_internal(p_operation text, p_expected_revision bigint, p_prepared_templates jsonb, p_organization_id uuid, p_application_root_id uuid, p_changed_by uuid, p_correlation_id uuid) FROM PUBLIC;

alter function vortex_access.coordinate_application_access_without_stewardship_internal(p_operation text, p_expected_revision bigint, p_prepared_templates jsonb, p_organization_id uuid, p_application_root_id uuid, p_changed_by uuid, p_correlation_id uuid) owner to vortex_owner;

grant execute on function vortex_access.coordinate_application_access_without_stewardship_internal(p_operation text, p_expected_revision bigint, p_prepared_templates jsonb, p_organization_id uuid, p_application_root_id uuid, p_changed_by uuid, p_correlation_id uuid) to postgres;

CREATE OR REPLACE FUNCTION vortex_access.coordinate_assignment_change_without_stewardship_internal(p_operation text, p_organization_id uuid, p_role_assignment_id uuid, p_expected_assignment_revision bigint, p_role_id uuid, p_expected_role_revision bigint, p_assignee_kind text, p_organization_account_id uuid, p_group_id uuid, p_assignment_kind text, p_starts_at timestamp with time zone, p_expires_at timestamp with time zone, p_changed_by uuid, p_correlation_id uuid) RETURNS TABLE(outcome text, operation text, organization_id uuid, role_assignment_id uuid, role_id uuid, assignee_kind text, organization_account_id uuid, group_id uuid, assignment_kind text, revision bigint, starts_at timestamp with time zone, expires_at timestamp with time zone, state text, granted_by_actor_id uuid, granted_at timestamp with time zone, grant_correlation_id uuid, changed_by_actor_id uuid, changed_at timestamp with time zone, change_correlation_id uuid, revoked_by_actor_id uuid, revoked_at timestamp with time zone, revocation_correlation_id uuid, access_version bigint, correlation_id uuid)
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
declare
  next_access_version bigint;
  operation_at timestamptz;
  role_fact record;
  assignment_fact vortex_access.organization_role_assignments%rowtype;
begin
  if p_operation is null
    or p_operation not in ('grant', 'revoke')
    or p_organization_id is null
    or p_organization_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_role_assignment_id is null
    or p_role_assignment_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_changed_by is null
    or p_changed_by = '00000000-0000-0000-0000-000000000000'::uuid
    or p_correlation_id is null
    or p_correlation_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using errcode = '22023',
      message = 'Organization role-assignment change input is invalid';
  end if;

  if p_operation = 'grant' then
    if p_expected_assignment_revision is not null
      or p_role_id is null
      or p_role_id = '00000000-0000-0000-0000-000000000000'::uuid
      or p_expected_role_revision is null
      or p_expected_role_revision not between 1 and 9007199254740991
      or p_assignee_kind is null
      or p_assignee_kind not in ('organization_account', 'group')
      or p_assignment_kind is null
      or p_assignment_kind not in ('standing', 'eligible')
      or p_starts_at is null
      or p_starts_at in ('-infinity'::timestamptz, 'infinity'::timestamptz)
      or p_expires_at in ('-infinity'::timestamptz, 'infinity'::timestamptz)
      or (p_expires_at is not null and p_expires_at <= p_starts_at)
      or (
        p_assignee_kind = 'organization_account'
        and (
          p_organization_account_id is null
          or p_organization_account_id =
            '00000000-0000-0000-0000-000000000000'::uuid
          or p_group_id is not null
        )
      )
      or (
        p_assignee_kind = 'group'
        and (
          p_group_id is null
          or p_group_id = '00000000-0000-0000-0000-000000000000'::uuid
          or p_organization_account_id is not null
        )
      ) then
      raise exception using errcode = '22023',
        message = 'Organization role-assignment grant input is invalid';
    end if;
  elsif p_expected_assignment_revision is null
    or p_expected_assignment_revision not between 1 and 9007199254740991
    or p_role_id is not null
    or p_expected_role_revision is not null
    or p_assignee_kind is not null
    or p_organization_account_id is not null
    or p_group_id is not null
    or p_assignment_kind is not null
    or p_starts_at is not null
    or p_expires_at is not null then
    raise exception using errcode = '22023',
      message = 'Organization role-assignment revocation input is invalid';
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
      message = 'Organization role-assignment change scope is unavailable';
  end if;

  if p_operation = 'grant' then
    select role.live_revision, role_revision.lifecycle,
      role_revision.assignment_policy
    into role_fact
    from vortex_access.organization_roles as role
    join vortex_access.organization_role_revisions as role_revision
      on role_revision.organization_id = role.organization_id
      and role_revision.role_id = role.role_id
      and role_revision.revision = role.live_revision
    where role.organization_id = p_organization_id
      and role.role_id = p_role_id
    for update of role;

    if not found
      or role_fact.live_revision <> p_expected_role_revision
      or role_fact.lifecycle <> 'active'
      or not (
        (p_assignment_kind = 'standing' and role_fact.assignment_policy = 'standing')
        or (
          p_assignment_kind = 'eligible'
          and role_fact.assignment_policy = 'activation_required'
        )
      ) then
      raise exception using errcode = '40001',
        message = 'Organization role-assignment grant evidence is stale or unavailable';
    end if;

    if p_assignee_kind = 'organization_account' then
      perform 1
      from vortex_identity.organization_accounts as account
      where account.organization_id = p_organization_id
        and account.organization_account_id = p_organization_account_id
        and account.state = 'active'
      for update;
    else
      perform 1
      from vortex_access.organization_groups as organization_group
      where organization_group.organization_id = p_organization_id
        and organization_group.group_id = p_group_id
        and organization_group.state = 'active'
      for update;
    end if;
    if not found then
      raise exception using errcode = '40001',
        message = 'Organization role-assignment grant evidence is stale or unavailable';
    end if;

    operation_at := pg_catalog.clock_timestamp();
    if p_expires_at is not null and p_expires_at <= operation_at then
      raise exception using errcode = '40001',
        message = 'Organization role-assignment grant window is no longer current';
    end if;

    insert into vortex_access.organization_role_assignments (
      organization_id, role_assignment_id, role_id, assignee_kind,
      organization_account_id, group_id, assignment_kind, revision, starts_at,
      expires_at, state, granted_by, granted_at, grant_correlation_id,
      changed_by, changed_at, change_correlation_id, revoked_by, revoked_at,
      revocation_correlation_id
    ) values (
      p_organization_id, p_role_assignment_id, p_role_id, p_assignee_kind,
      p_organization_account_id, p_group_id, p_assignment_kind, 1, p_starts_at,
      p_expires_at, 'live', p_changed_by, operation_at, p_correlation_id,
      p_changed_by, operation_at, p_correlation_id, null, null, null
    );
  else
    select assignment.* into assignment_fact
    from vortex_access.organization_role_assignments as assignment
    where assignment.organization_id = p_organization_id
      and assignment.role_assignment_id = p_role_assignment_id
    for update;

    if not found
      or assignment_fact.revision <> p_expected_assignment_revision
      or assignment_fact.state <> 'live' then
      raise exception using errcode = '40001',
        message = 'Organization role-assignment revocation is stale or unavailable';
    end if;
    if assignment_fact.revision = 9007199254740991 then
      raise exception using errcode = '22003',
        message = 'Organization role-assignment revision is exhausted';
    end if;

    operation_at := greatest(
      assignment_fact.changed_at,
      pg_catalog.clock_timestamp()
    );
    update vortex_access.organization_role_assignments as assignment
    set revision = assignment_fact.revision + 1,
      state = 'revoked',
      changed_by = p_changed_by,
      changed_at = operation_at,
      change_correlation_id = p_correlation_id,
      revoked_by = p_changed_by,
      revoked_at = operation_at,
      revocation_correlation_id = p_correlation_id
    where assignment.organization_id = p_organization_id
      and assignment.role_assignment_id = p_role_assignment_id
      and assignment.revision = p_expected_assignment_revision
      and assignment.state = 'live';
    if not found then
      raise exception using errcode = '40001',
        message = 'Organization role-assignment revocation is stale or unavailable';
    end if;
  end if;

  select version.current_version into next_access_version
  from vortex_access.increment_organization_access_version(
    p_organization_id,
    p_changed_by,
    p_correlation_id,
    'role_assignment_changed'
  ) as version;

  return query
  select 'changed'::text, p_operation, assignment.organization_id,
    assignment.role_assignment_id, assignment.role_id, assignment.assignee_kind,
    assignment.organization_account_id, assignment.group_id,
    assignment.assignment_kind, assignment.revision, assignment.starts_at,
    assignment.expires_at, assignment.state, assignment.granted_by,
    assignment.granted_at, assignment.grant_correlation_id,
    assignment.changed_by, assignment.changed_at,
    assignment.change_correlation_id, assignment.revoked_by,
    assignment.revoked_at, assignment.revocation_correlation_id,
    next_access_version, p_correlation_id
  from vortex_access.organization_role_assignments as assignment
  where assignment.organization_id = p_organization_id
    and assignment.role_assignment_id = p_role_assignment_id;
end
$$;

alter function vortex_access.coordinate_assignment_change_without_stewardship_internal(p_operation text, p_organization_id uuid, p_role_assignment_id uuid, p_expected_assignment_revision bigint, p_role_id uuid, p_expected_role_revision bigint, p_assignee_kind text, p_organization_account_id uuid, p_group_id uuid, p_assignment_kind text, p_starts_at timestamp with time zone, p_expires_at timestamp with time zone, p_changed_by uuid, p_correlation_id uuid) owner to vortex_owner;

COMMENT ON FUNCTION vortex_access.coordinate_assignment_change_without_stewardship_internal(p_operation text, p_organization_id uuid, p_role_assignment_id uuid, p_expected_assignment_revision bigint, p_role_id uuid, p_expected_role_revision bigint, p_assignee_kind text, p_organization_account_id uuid, p_group_id uuid, p_assignment_kind text, p_starts_at timestamp with time zone, p_expires_at timestamp with time zone, p_changed_by uuid, p_correlation_id uuid) IS 'Private atomic role-assignment fact and Access change used by the stewardship-preserving public composition.';

REVOKE ALL ON FUNCTION vortex_access.coordinate_assignment_change_without_stewardship_internal(p_operation text, p_organization_id uuid, p_role_assignment_id uuid, p_expected_assignment_revision bigint, p_role_id uuid, p_expected_role_revision bigint, p_assignee_kind text, p_organization_account_id uuid, p_group_id uuid, p_assignment_kind text, p_starts_at timestamp with time zone, p_expires_at timestamp with time zone, p_changed_by uuid, p_correlation_id uuid) FROM PUBLIC;

grant execute on function vortex_access.coordinate_assignment_change_without_stewardship_internal(p_operation text, p_organization_id uuid, p_role_assignment_id uuid, p_expected_assignment_revision bigint, p_role_id uuid, p_expected_role_revision bigint, p_assignee_kind text, p_organization_account_id uuid, p_group_id uuid, p_assignment_kind text, p_starts_at timestamp with time zone, p_expires_at timestamp with time zone, p_changed_by uuid, p_correlation_id uuid) to postgres;

CREATE OR REPLACE FUNCTION vortex_access.coordinate_delegation_change_without_stewardship_internal(p_operation text, p_organization_id uuid, p_delegation_authority_id uuid, p_expected_delegation_revision bigint, p_holder_kind text, p_organization_account_id uuid, p_group_id uuid, p_scope_kind text, p_bounded_permissions jsonb, p_starts_at timestamp with time zone, p_expires_at timestamp with time zone, p_changed_by uuid, p_correlation_id uuid) RETURNS TABLE(outcome text, operation text, delegation jsonb, access_version bigint, correlation_id uuid)
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $_$
declare
  delegation_fact vortex_access.organization_delegation_authorities%rowtype;
  checked_at timestamptz;
  operation_at timestamptz;
  next_access_version bigint;
begin
  if p_operation is null
    or p_operation not in (
      'grant_delegation', 'replace_delegation_scope', 'revoke_delegation'
    )
    or p_organization_id is null
    or p_organization_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_delegation_authority_id is null
    or p_delegation_authority_id =
      '00000000-0000-0000-0000-000000000000'::uuid
    or p_changed_by is null
    or p_changed_by = '00000000-0000-0000-0000-000000000000'::uuid
    or p_correlation_id is null
    or p_correlation_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using errcode = '22023',
      message = 'Organization delegation change input is invalid';
  end if;

  if p_operation = 'grant_delegation' then
    if p_expected_delegation_revision is not null
      or p_holder_kind is null
      or p_holder_kind not in ('organization_account', 'group')
      or (
        p_holder_kind = 'organization_account'
        and (
          p_organization_account_id is null
          or p_organization_account_id =
            '00000000-0000-0000-0000-000000000000'::uuid
          or p_group_id is not null
        )
      )
      or (
        p_holder_kind = 'group'
        and (
          p_group_id is null
          or p_group_id = '00000000-0000-0000-0000-000000000000'::uuid
          or p_organization_account_id is not null
        )
      )
      or p_starts_at is null
      or p_starts_at in ('-infinity'::timestamptz, 'infinity'::timestamptz)
      or p_expires_at in ('-infinity'::timestamptz, 'infinity'::timestamptz)
      or (p_expires_at is not null and p_expires_at <= p_starts_at) then
      raise exception using errcode = '22023',
        message = 'Organization delegation grant input is invalid';
    end if;
  elsif p_operation = 'replace_delegation_scope' then
    if p_expected_delegation_revision is null
      or p_expected_delegation_revision not between 1 and 9007199254740991
      or p_holder_kind is not null
      or p_organization_account_id is not null
      or p_group_id is not null
      or p_starts_at is not null
      or p_expires_at is not null then
      raise exception using errcode = '22023',
        message = 'Organization delegation scope replacement input is invalid';
    end if;
  elsif p_expected_delegation_revision is null
    or p_expected_delegation_revision not between 1 and 9007199254740991
    or p_holder_kind is not null
    or p_organization_account_id is not null
    or p_group_id is not null
    or p_scope_kind is not null
    or p_bounded_permissions is not null
    or p_starts_at is not null
    or p_expires_at is not null then
    raise exception using errcode = '22023',
      message = 'Organization delegation revocation input is invalid';
  end if;

  if p_operation <> 'revoke_delegation' and (
    p_scope_kind is null
    or p_scope_kind not in ('organization_catalogue', 'bounded')
    or (
      p_scope_kind = 'organization_catalogue'
      and p_bounded_permissions is not null
    )
    or (
      p_scope_kind = 'bounded'
      and p_bounded_permissions is null
    )
  ) then
    raise exception using errcode = '22023',
      message = 'Organization delegation scope input is invalid';
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
      message = 'Organization delegation change scope is unavailable';
  end if;

  if p_operation = 'grant_delegation' then
    if exists (
      select 1
      from vortex_access.organization_delegation_authorities as stored_delegation
      where stored_delegation.organization_id = p_organization_id
        and stored_delegation.delegation_authority_id =
          p_delegation_authority_id
    ) then
      raise exception using errcode = '40001',
        message = 'Organization delegation grant is stale or unavailable';
    end if;

    if p_holder_kind = 'organization_account' then
      perform 1
      from vortex_identity.organization_accounts as account
      where account.organization_id = p_organization_id
        and account.organization_account_id = p_organization_account_id
        and account.state = 'active'
      for update;
    else
      perform 1
      from vortex_access.organization_groups as organization_group
      where organization_group.organization_id = p_organization_id
        and organization_group.group_id = p_group_id
        and organization_group.state = 'active'
      for update;
    end if;
    if not found then
      raise exception using errcode = '40001',
        message = 'Organization delegation holder is stale or unavailable';
    end if;

    checked_at := pg_catalog.clock_timestamp();
    if p_expires_at is not null and p_expires_at <= checked_at then
      raise exception using errcode = '40001',
        message = 'Organization delegation window is no longer current';
    end if;

    insert into vortex_access.organization_delegation_authorities (
      organization_id, delegation_authority_id, holder_kind,
      organization_account_id, group_id, scope_kind, bounded_permissions,
      revision, starts_at, expires_at, state, granted_by,
      granted_at, grant_correlation_id, changed_by, changed_at,
      change_correlation_id, revoked_by, revoked_at,
      revocation_correlation_id
    ) values (
      p_organization_id, p_delegation_authority_id, p_holder_kind,
      p_organization_account_id, p_group_id, p_scope_kind,
      p_bounded_permissions, 1, p_starts_at,
      p_expires_at, 'live', p_changed_by, checked_at, p_correlation_id,
      p_changed_by, checked_at, p_correlation_id, null, null, null
    ) returning * into delegation_fact;
  else
    select stored_delegation.*
    into delegation_fact
    from vortex_access.organization_delegation_authorities as stored_delegation
    where stored_delegation.organization_id = p_organization_id
      and stored_delegation.delegation_authority_id =
        p_delegation_authority_id
    for update;

    if not found
      or delegation_fact.revision <> p_expected_delegation_revision
      or delegation_fact.state <> 'live' then
      raise exception using errcode = '40001',
        message = 'Organization delegation change is stale or unavailable';
    end if;
    if delegation_fact.revision = 9007199254740991 then
      raise exception using errcode = '22003',
        message = 'Organization delegation authority revision is exhausted';
    end if;

    if p_operation = 'replace_delegation_scope' then
      if delegation_fact.holder_kind = 'organization_account' then
        perform 1
        from vortex_identity.organization_accounts as account
        where account.organization_id = p_organization_id
          and account.organization_account_id =
            delegation_fact.organization_account_id
          and account.state = 'active'
        for update;
      else
        perform 1
        from vortex_access.organization_groups as organization_group
        where organization_group.organization_id = p_organization_id
          and organization_group.group_id = delegation_fact.group_id
          and organization_group.state = 'active'
        for update;
      end if;
      if not found then
        raise exception using errcode = '40001',
          message = 'Organization delegation holder is stale or unavailable';
      end if;
    end if;

    checked_at := pg_catalog.clock_timestamp();
    if p_operation = 'replace_delegation_scope' then
      if delegation_fact.expires_at is not null
        and delegation_fact.expires_at <= checked_at then
        raise exception using errcode = '40001',
          message = 'Organization delegation window is no longer current';
      end if;
      if delegation_fact.scope_kind is not distinct from p_scope_kind
        and delegation_fact.bounded_permissions is not distinct from
          p_bounded_permissions then
        raise exception using errcode = '40001',
          message = 'Organization delegation scope is unchanged';
      end if;
    end if;

    operation_at := greatest(delegation_fact.changed_at, checked_at);
    update vortex_access.organization_delegation_authorities as stored_delegation
    set scope_kind = case when p_operation = 'replace_delegation_scope'
        then p_scope_kind else delegation_fact.scope_kind end,
      bounded_permissions = case when p_operation = 'replace_delegation_scope'
        then p_bounded_permissions else delegation_fact.bounded_permissions end,
      revision = delegation_fact.revision + 1,
      state = case when p_operation = 'revoke_delegation'
        then 'revoked' else delegation_fact.state end,
      changed_by = p_changed_by,
      changed_at = operation_at,
      change_correlation_id = p_correlation_id,
      revoked_by = case when p_operation = 'revoke_delegation'
        then p_changed_by else null end,
      revoked_at = case when p_operation = 'revoke_delegation'
        then operation_at else null end,
      revocation_correlation_id = case when p_operation = 'revoke_delegation'
        then p_correlation_id else null end
    where stored_delegation.organization_id = p_organization_id
      and stored_delegation.delegation_authority_id =
        p_delegation_authority_id
      and stored_delegation.revision = p_expected_delegation_revision
      and stored_delegation.state = 'live'
    returning stored_delegation.* into delegation_fact;
    if not found then
      raise exception using errcode = '40001',
        message = 'Organization delegation change is stale or unavailable';
    end if;
  end if;

  select version.current_version
  into next_access_version
  from vortex_access.increment_organization_access_version(
    p_organization_id,
    p_changed_by,
    p_correlation_id,
    'delegation_changed'
  ) as version;

  return query
  select 'changed'::text, p_operation,
    pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
      'delegationAuthorityId', delegation_fact.delegation_authority_id,
      'organizationId', delegation_fact.organization_id,
      'holder', case delegation_fact.holder_kind
        when 'organization_account' then pg_catalog.jsonb_build_object(
          'kind', 'organization_account',
          'organizationAccountId', delegation_fact.organization_account_id
        )
        else pg_catalog.jsonb_build_object(
          'kind', 'group', 'groupId', delegation_fact.group_id
        )
      end,
      'scope', case delegation_fact.scope_kind
        when 'organization_catalogue' then pg_catalog.jsonb_build_object(
          'kind', 'organization_catalogue'
        )
        else pg_catalog.jsonb_build_object(
          'kind', 'bounded',
          'permissions', delegation_fact.bounded_permissions
        )
      end,
      'revision', delegation_fact.revision,
      'startsAt', delegation_fact.starts_at,
      'expiresAt', delegation_fact.expires_at,
      'state', delegation_fact.state,
      'grantedByActorId', delegation_fact.granted_by,
      'grantedAt', delegation_fact.granted_at,
      'grantCorrelationId', delegation_fact.grant_correlation_id,
      'changedByActorId', delegation_fact.changed_by,
      'changedAt', delegation_fact.changed_at,
      'changeCorrelationId', delegation_fact.change_correlation_id,
      'revokedByActorId', delegation_fact.revoked_by,
      'revokedAt', delegation_fact.revoked_at,
      'revocationCorrelationId', delegation_fact.revocation_correlation_id
    )),
    next_access_version, p_correlation_id;
end
$_$;

alter function vortex_access.coordinate_delegation_change_without_stewardship_internal(p_operation text, p_organization_id uuid, p_delegation_authority_id uuid, p_expected_delegation_revision bigint, p_holder_kind text, p_organization_account_id uuid, p_group_id uuid, p_scope_kind text, p_bounded_permissions jsonb, p_starts_at timestamp with time zone, p_expires_at timestamp with time zone, p_changed_by uuid, p_correlation_id uuid) owner to vortex_owner;

COMMENT ON FUNCTION vortex_access.coordinate_delegation_change_without_stewardship_internal(p_operation text, p_organization_id uuid, p_delegation_authority_id uuid, p_expected_delegation_revision bigint, p_holder_kind text, p_organization_account_id uuid, p_group_id uuid, p_scope_kind text, p_bounded_permissions jsonb, p_starts_at timestamp with time zone, p_expires_at timestamp with time zone, p_changed_by uuid, p_correlation_id uuid) IS 'Owner-only atomic delegation grant, whole-scope replacement or terminal revocation. It changes Access once but grants no caller authority.';

REVOKE ALL ON FUNCTION vortex_access.coordinate_delegation_change_without_stewardship_internal(p_operation text, p_organization_id uuid, p_delegation_authority_id uuid, p_expected_delegation_revision bigint, p_holder_kind text, p_organization_account_id uuid, p_group_id uuid, p_scope_kind text, p_bounded_permissions jsonb, p_starts_at timestamp with time zone, p_expires_at timestamp with time zone, p_changed_by uuid, p_correlation_id uuid) FROM PUBLIC;

grant execute on function vortex_access.coordinate_delegation_change_without_stewardship_internal(p_operation text, p_organization_id uuid, p_delegation_authority_id uuid, p_expected_delegation_revision bigint, p_holder_kind text, p_organization_account_id uuid, p_group_id uuid, p_scope_kind text, p_bounded_permissions jsonb, p_starts_at timestamp with time zone, p_expires_at timestamp with time zone, p_changed_by uuid, p_correlation_id uuid) to postgres;

create or replace function vortex_access.coordinate_role_change_without_stewardship_internal(
  p_evidence jsonb,
  p_changed_by uuid,
  p_correlation_id uuid
)
returns table (
  outcome text,
  operation text,
  role jsonb,
  created_activation_policy jsonb,
  access_version bigint,
  correlation_id uuid
)
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  candidate jsonb;
  operation_name text;
  target_organization_id uuid;
  target_role_id uuid;
  expected_role_revision bigint;
  target_role_kind text;
  target_lifecycle text;
  target_role_key text;
  target_label text;
  target_description text;
  target_privilege_classification text;
  target_assignment_policy text;
  target_policy_continuity_revision bigint;
  target_authority_continuity_revision bigint;
  target_activation_policy_id uuid;
  target_activation_policy_revision bigint;
  target_application_root_id uuid;
  target_source_role_id uuid;
  target_source_definition_key text;
  target_source_release_revision bigint;
  target_source_release_version text;
  target_source_validation_contract_version text;
  target_accepted_registration_revision bigint;
  target_template_continuity_revision bigint;
  target_role_revision bigint;
  candidate_permissions jsonb;
  canonical_permissions jsonb;
  current_permissions jsonb;
  permission_count bigint;
  template_source jsonb;
  live_permissions jsonb;
  selected_template_count bigint;
  policy_choice jsonb;
  policy_value jsonb;
  policy_reference jsonb;
  manifest jsonb;
  canonical_assignments jsonb;
  manifest_required boolean := false;
  authority_broadened boolean := false;
  permissions_changed boolean := false;
  configured_state_changed boolean := false;
  role_identity vortex_access.organization_roles%rowtype;
  current_revision vortex_access.organization_role_revisions%rowtype;
  maximum_policy_revision bigint;
  operation_at timestamptz;
  next_access_version bigint;
  role_result jsonb;
  policy_result jsonb;
begin
  if p_evidence is null
    or pg_catalog.jsonb_typeof(p_evidence) is distinct from 'object'
    or p_evidence - array[
      'contractVersion', 'candidate', 'affectedAssignmentManifest'
    ]::text[] <> '{}'::jsonb
    or not (p_evidence ?& array['contractVersion', 'candidate'])
    or p_evidence ->> 'contractVersion' is distinct from '1.0.0'
    or pg_catalog.jsonb_typeof(p_evidence -> 'candidate') is distinct from 'object'
    or (p_evidence ? 'affectedAssignmentManifest' and
      pg_catalog.jsonb_typeof(p_evidence -> 'affectedAssignmentManifest')
        is distinct from 'object')
    or p_changed_by is null
    or p_changed_by = '00000000-0000-0000-0000-000000000000'::uuid
    or p_correlation_id is null
    or p_correlation_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using errcode = '22023',
      message = 'Organization role-change evidence is invalid';
  end if;

  candidate := p_evidence -> 'candidate';
  operation_name := candidate ->> 'operation';
  if operation_name is null or operation_name not in (
    'create_custom', 'create_custom_from_template',
    'accept_new_application_role', 'revise_metadata_policy',
    'revise_custom_permissions', 'accept_application_role_revision',
    'retire_role'
  ) then
    raise exception using errcode = '22023',
      message = 'Organization role-change operation is invalid';
  end if;

  if pg_catalog.jsonb_typeof(candidate -> 'operation') is distinct from 'string'
    or pg_catalog.jsonb_typeof(candidate -> 'organizationId') is distinct from 'string'
    or pg_catalog.jsonb_typeof(candidate -> 'roleId') is distinct from 'string' then
    raise exception using errcode = '22023',
      message = 'Organization role-change identity is invalid';
  end if;
  target_organization_id := (candidate ->> 'organizationId')::uuid;
  target_role_id := (candidate ->> 'roleId')::uuid;
  if target_organization_id = '00000000-0000-0000-0000-000000000000'::uuid
    or target_role_id = '00000000-0000-0000-0000-000000000000'::uuid
    or candidate ->> 'organizationId' <> target_organization_id::text
    or candidate ->> 'roleId' <> target_role_id::text then
    raise exception using errcode = '22023',
      message = 'Organization role-change identity is invalid';
  end if;

  if operation_name in (
    'create_custom', 'create_custom_from_template', 'accept_new_application_role'
  ) then
    if candidate ? 'expectedRoleRevision' then
      raise exception using errcode = '22023',
        message = 'A role creation cannot carry an expected revision';
    end if;
  elsif pg_catalog.jsonb_typeof(candidate -> 'expectedRoleRevision')
      is distinct from 'number'
    or (candidate ->> 'expectedRoleRevision')::numeric < 1
    or (candidate ->> 'expectedRoleRevision')::numeric > 9007199254740991
    or (candidate ->> 'expectedRoleRevision')::numeric <>
      pg_catalog.trunc((candidate ->> 'expectedRoleRevision')::numeric) then
    raise exception using errcode = '22023',
      message = 'Expected role revision is invalid';
  else
    expected_role_revision := (candidate ->> 'expectedRoleRevision')::numeric::bigint;
  end if;

  if operation_name = 'retire_role' then
    if candidate - array[
      'operation', 'organizationId', 'roleId', 'expectedRoleRevision'
    ]::text[] <> '{}'::jsonb
      or not (candidate ?& array[
        'operation', 'organizationId', 'roleId', 'expectedRoleRevision'
      ]) then
      raise exception using errcode = '22023',
        message = 'Role retirement shape is invalid';
    end if;
  else
    if not (candidate ?& array[
      'operation', 'organizationId', 'roleId', 'key', 'label', 'description',
      'privilegeClassification', 'assignmentPolicy'
    ])
      or pg_catalog.jsonb_typeof(candidate -> 'key') is distinct from 'string'
      or pg_catalog.jsonb_typeof(candidate -> 'label') is distinct from 'string'
      or pg_catalog.jsonb_typeof(candidate -> 'description') is distinct from 'string'
      or pg_catalog.jsonb_typeof(candidate -> 'privilegeClassification')
        is distinct from 'string'
      or pg_catalog.jsonb_typeof(candidate -> 'assignmentPolicy')
        is distinct from 'object'
      or pg_catalog.char_length(candidate ->> 'key') not between 1 and 40
      or candidate ->> 'key' !~ '^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$'
      or candidate ->> 'label' <> pg_catalog.btrim(candidate ->> 'label')
      or pg_catalog.char_length(candidate ->> 'label') not between 1 and 60
      or candidate ->> 'description' <> pg_catalog.btrim(candidate ->> 'description')
      or pg_catalog.char_length(candidate ->> 'description') not between 1 and 1000
      or candidate ->> 'privilegeClassification' not in ('standard', 'privileged') then
      raise exception using errcode = '22023',
        message = 'Role configuration shape is invalid';
    end if;
    target_role_key := candidate ->> 'key';
    target_label := candidate ->> 'label';
    target_description := candidate ->> 'description';
    target_privilege_classification := candidate ->> 'privilegeClassification';
  end if;

  if operation_name in (
    'create_custom', 'revise_custom_permissions', 'create_custom_from_template',
    'accept_new_application_role', 'accept_application_role_revision'
  ) then
    if pg_catalog.jsonb_typeof(candidate -> 'permissions') is distinct from 'array'
      or pg_catalog.jsonb_array_length(candidate -> 'permissions') = 0 then
      raise exception using errcode = '22023',
        message = 'Role permission evidence is invalid';
    end if;
    candidate_permissions := candidate -> 'permissions';
  elsif candidate ? 'permissions' then
    raise exception using errcode = '22023',
      message = 'This role-change intent cannot carry permissions';
  end if;

  if operation_name in (
    'create_custom_from_template', 'accept_new_application_role',
    'accept_application_role_revision'
  ) then
    if not (candidate ?& array[
      'templateSource', 'sourceRoleId', 'templateContinuityRevision'
    ])
      or pg_catalog.jsonb_typeof(candidate -> 'templateSource') is distinct from 'object'
      or pg_catalog.jsonb_typeof(candidate -> 'sourceRoleId') is distinct from 'string'
      or pg_catalog.jsonb_typeof(candidate -> 'templateContinuityRevision')
        is distinct from 'number'
      or (candidate ->> 'templateContinuityRevision')::numeric < 1
      or (candidate ->> 'templateContinuityRevision')::numeric > 9007199254740991
      or (candidate ->> 'templateContinuityRevision')::numeric <>
        pg_catalog.trunc((candidate ->> 'templateContinuityRevision')::numeric) then
      raise exception using errcode = '22023',
        message = 'Application role-template evidence is invalid';
    end if;
    template_source := candidate -> 'templateSource';
    target_source_role_id := (candidate ->> 'sourceRoleId')::uuid;
    target_template_continuity_revision :=
      (candidate ->> 'templateContinuityRevision')::numeric::bigint;
  elsif candidate ? 'templateSource'
    or candidate ? 'sourceRoleId'
    or candidate ? 'templateContinuityRevision' then
    raise exception using errcode = '22023',
      message = 'This role-change intent cannot carry template evidence';
  end if;

  if operation_name = 'create_custom' then
    if candidate - array[
      'operation', 'organizationId', 'roleId', 'key', 'label', 'description',
      'privilegeClassification', 'assignmentPolicy', 'permissions'
    ]::text[] <> '{}'::jsonb then
      raise exception using errcode = '22023', message = 'Custom role shape is invalid';
    end if;
  elsif operation_name in ('create_custom_from_template', 'accept_new_application_role') then
    if candidate - array[
      'operation', 'organizationId', 'roleId', 'key', 'label', 'description',
      'privilegeClassification', 'assignmentPolicy', 'templateSource',
      'sourceRoleId', 'templateContinuityRevision', 'permissions'
    ]::text[] <> '{}'::jsonb then
      raise exception using errcode = '22023', message = 'New template role shape is invalid';
    end if;
  elsif operation_name = 'revise_metadata_policy' then
    if candidate - array[
      'operation', 'organizationId', 'roleId', 'expectedRoleRevision', 'key',
      'label', 'description', 'privilegeClassification', 'assignmentPolicy'
    ]::text[] <> '{}'::jsonb then
      raise exception using errcode = '22023', message = 'Role metadata shape is invalid';
    end if;
  elsif operation_name = 'revise_custom_permissions' then
    if candidate - array[
      'operation', 'organizationId', 'roleId', 'expectedRoleRevision', 'key',
      'label', 'description', 'privilegeClassification', 'assignmentPolicy',
      'permissions'
    ]::text[] <> '{}'::jsonb then
      raise exception using errcode = '22023', message = 'Custom permission shape is invalid';
    end if;
  elsif operation_name = 'accept_application_role_revision' then
    if candidate - array[
      'operation', 'organizationId', 'roleId', 'expectedRoleRevision', 'key',
      'label', 'description', 'privilegeClassification', 'assignmentPolicy',
      'templateSource', 'sourceRoleId', 'templateContinuityRevision', 'permissions'
    ]::text[] <> '{}'::jsonb then
      raise exception using errcode = '22023', message = 'Application acceptance shape is invalid';
    end if;
  end if;

  if operation_name <> 'retire_role' then
    policy_choice := candidate -> 'assignmentPolicy';
    if policy_choice ->> 'kind' = 'standing' then
      if policy_choice <> pg_catalog.jsonb_build_object('kind', 'standing') then
        raise exception using errcode = '22023', message = 'Standing policy shape is invalid';
      end if;
      target_assignment_policy := 'standing';
    elsif policy_choice ->> 'kind' = 'activation_required'
      and policy_choice - array['kind', 'activationPolicy']::text[] = '{}'::jsonb
      and policy_choice ?& array['kind', 'activationPolicy']
      and pg_catalog.jsonb_typeof(policy_choice -> 'activationPolicy') = 'object' then
      target_assignment_policy := 'activation_required';
      if policy_choice #>> '{activationPolicy,selection}' = 'existing' then
        if (policy_choice -> 'activationPolicy') - array['selection', 'reference']::text[] <>
            '{}'::jsonb
          or not ((policy_choice -> 'activationPolicy') ?& array['selection', 'reference'])
          or pg_catalog.jsonb_typeof(policy_choice #> '{activationPolicy,reference}') <>
            'object' then
          raise exception using errcode = '22023',
            message = 'Existing activation policy shape is invalid';
        end if;
        policy_reference := policy_choice #> '{activationPolicy,reference}';
        if policy_reference - array[
          'activationPolicyId', 'revision'
        ]::text[] <> '{}'::jsonb
          or not (policy_reference ?& array[
            'activationPolicyId', 'revision'
          ])
          or pg_catalog.jsonb_typeof(policy_reference -> 'activationPolicyId') <> 'string'
          or pg_catalog.jsonb_typeof(policy_reference -> 'revision') <> 'number'
          or (policy_reference ->> 'revision')::numeric < 1
          or (policy_reference ->> 'revision')::numeric > 9007199254740991
          or (policy_reference ->> 'revision')::numeric <>
            pg_catalog.trunc((policy_reference ->> 'revision')::numeric) then
          raise exception using errcode = '22023',
            message = 'Existing activation policy evidence is invalid';
        end if;
        target_activation_policy_id := (policy_reference ->> 'activationPolicyId')::uuid;
        target_activation_policy_revision :=
          (policy_reference ->> 'revision')::numeric::bigint;
      elsif policy_choice #>> '{activationPolicy,selection}' = 'new' then
        if (policy_choice -> 'activationPolicy') - array['selection', 'policy']::text[] <>
            '{}'::jsonb
          or not ((policy_choice -> 'activationPolicy') ?& array['selection', 'policy'])
          or pg_catalog.jsonb_typeof(policy_choice #> '{activationPolicy,policy}') <> 'object' then
          raise exception using errcode = '22023',
            message = 'New activation policy shape is invalid';
        end if;
        policy_value := policy_choice #> '{activationPolicy,policy}';
        if policy_value - array[
          'activationPolicyId', 'revision', 'maximumActivationDurationSeconds',
          'reasonRequired', 'recentAuthentication', 'requiredCallerExecutionBindingId'
        ]::text[] <> '{}'::jsonb
          or not (policy_value ?& array[
            'activationPolicyId', 'revision', 'maximumActivationDurationSeconds',
            'reasonRequired', 'recentAuthentication'
          ])
          or pg_catalog.jsonb_typeof(policy_value -> 'activationPolicyId') <> 'string'
          or pg_catalog.jsonb_typeof(policy_value -> 'revision') <> 'number'
          or pg_catalog.jsonb_typeof(policy_value -> 'maximumActivationDurationSeconds') <>
            'number'
          or pg_catalog.jsonb_typeof(policy_value -> 'reasonRequired') <> 'boolean'
          or pg_catalog.jsonb_typeof(policy_value -> 'recentAuthentication') <> 'object'
          or (
            policy_value ? 'requiredCallerExecutionBindingId'
            and (
              pg_catalog.jsonb_typeof(policy_value -> 'requiredCallerExecutionBindingId') <>
                'string'
              or not vortex_platform.is_non_nil_uuid(
                policy_value ->> 'requiredCallerExecutionBindingId'
              )
            )
          )
          or (policy_value ->> 'revision')::numeric < 1
          or (policy_value ->> 'revision')::numeric > 9007199254740991
          or (policy_value ->> 'revision')::numeric <>
            pg_catalog.trunc((policy_value ->> 'revision')::numeric)
          or (policy_value ->> 'maximumActivationDurationSeconds')::numeric < 1
          or (policy_value ->> 'maximumActivationDurationSeconds')::numeric >
            9007199254740991
          or (policy_value ->> 'maximumActivationDurationSeconds')::numeric <>
            pg_catalog.trunc(
              (policy_value ->> 'maximumActivationDurationSeconds')::numeric
            ) then
          raise exception using errcode = '22023',
            message = 'New activation policy evidence is invalid';
        end if;
        if policy_value #>> '{recentAuthentication,kind}' = 'none' then
          if policy_value -> 'recentAuthentication' <>
            pg_catalog.jsonb_build_object('kind', 'none') then
            raise exception using errcode = '22023',
              message = 'Recent authentication policy is invalid';
          end if;
        elsif policy_value #>> '{recentAuthentication,kind}' in ('primary', 'multi_factor') then
          if (policy_value -> 'recentAuthentication') - array[
            'kind', 'maximumAgeSeconds'
          ]::text[] <> '{}'::jsonb
            or not ((policy_value -> 'recentAuthentication') ?& array[
              'kind', 'maximumAgeSeconds'
            ])
            or pg_catalog.jsonb_typeof(
              policy_value #> '{recentAuthentication,maximumAgeSeconds}'
            ) <> 'number'
            or (policy_value #>> '{recentAuthentication,maximumAgeSeconds}')::numeric < 1
            or (policy_value #>> '{recentAuthentication,maximumAgeSeconds}')::numeric >
              9007199254740991
            or (policy_value #>> '{recentAuthentication,maximumAgeSeconds}')::numeric <>
              pg_catalog.trunc(
                (policy_value #>> '{recentAuthentication,maximumAgeSeconds}')::numeric
              ) then
            raise exception using errcode = '22023',
              message = 'Recent authentication policy is invalid';
          end if;
        else
          raise exception using errcode = '22023',
            message = 'Recent authentication policy is invalid';
        end if;
        target_activation_policy_id := (policy_value ->> 'activationPolicyId')::uuid;
        target_activation_policy_revision :=
          (policy_value ->> 'revision')::numeric::bigint;
      else
        raise exception using errcode = '22023',
          message = 'Activation-required policy selection is invalid';
      end if;
    else
      raise exception using errcode = '22023', message = 'Assignment policy is invalid';
    end if;
  end if;

  if candidate_permissions is not null then
    if exists (
      select 1
      from pg_catalog.jsonb_array_elements(candidate_permissions) as item(value)
      where pg_catalog.jsonb_typeof(item.value) is distinct from 'object'
        or item.value - array[
          'kind', 'applicationRootId', 'ownerKind', 'ownerId', 'permissionId',
          'acceptedRegistrationRevision', 'catalogueFingerprint',
          'continuityRevision', 'meaningFingerprint'
        ]::text[] <> '{}'::jsonb
        or not (item.value ?& array[
          'kind', 'ownerKind', 'ownerId', 'permissionId',
          'acceptedRegistrationRevision', 'catalogueFingerprint',
          'continuityRevision', 'meaningFingerprint'
        ])
        or item.value ->> 'kind' is distinct from 'exact'
        or pg_catalog.jsonb_typeof(item.value -> 'ownerKind') is distinct from 'string'
        or item.value ->> 'ownerKind' not in ('platform', 'application', 'module')
        or pg_catalog.jsonb_typeof(item.value -> 'ownerId') is distinct from 'string'
        or pg_catalog.jsonb_typeof(item.value -> 'permissionId') is distinct from 'string'
        or pg_catalog.jsonb_typeof(item.value -> 'acceptedRegistrationRevision')
          is distinct from 'number'
        or pg_catalog.jsonb_typeof(item.value -> 'continuityRevision')
          is distinct from 'number'
        or pg_catalog.jsonb_typeof(item.value -> 'catalogueFingerprint')
          is distinct from 'string'
        or pg_catalog.jsonb_typeof(item.value -> 'meaningFingerprint')
          is distinct from 'string'
        or item.value ->> 'catalogueFingerprint' !~ '^sha256:[a-f0-9]{64}$'
        or item.value ->> 'meaningFingerprint' !~ '^sha256:[a-f0-9]{64}$'
        or (item.value ->> 'acceptedRegistrationRevision')::numeric not between
          1 and 9007199254740991
        or (item.value ->> 'acceptedRegistrationRevision')::numeric <>
          pg_catalog.trunc(
            (item.value ->> 'acceptedRegistrationRevision')::numeric
          )
        or (item.value ->> 'continuityRevision')::numeric not between
          1 and 9007199254740991
        or (item.value ->> 'continuityRevision')::numeric <>
          pg_catalog.trunc((item.value ->> 'continuityRevision')::numeric)
        or (
          item.value ->> 'ownerKind' = 'platform'
          and item.value ? 'applicationRootId'
        )
        or (
          item.value ->> 'ownerKind' in ('application', 'module')
          and pg_catalog.jsonb_typeof(item.value -> 'applicationRootId')
            is distinct from 'string'
        )
    ) then
      raise exception using errcode = '22023', message = 'Role permission entry is invalid';
    end if;

    select pg_catalog.jsonb_agg(
      pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
        'kind', 'exact',
        'applicationRootId', case
          when item.value ? 'applicationRootId'
            then (item.value ->> 'applicationRootId')::uuid
          else null
        end,
        'ownerKind', item.value ->> 'ownerKind',
        'ownerId', (item.value ->> 'ownerId')::uuid,
        'permissionId', (item.value ->> 'permissionId')::uuid,
        'acceptedRegistrationRevision',
          (item.value ->> 'acceptedRegistrationRevision')::numeric::bigint,
        'catalogueFingerprint', item.value ->> 'catalogueFingerprint',
        'continuityRevision',
          (item.value ->> 'continuityRevision')::numeric::bigint,
        'meaningFingerprint', item.value ->> 'meaningFingerprint'
      )) order by
        case when item.value ? 'applicationRootId'
          then (item.value ->> 'applicationRootId')::uuid else null end nulls last,
        (item.value ->> 'ownerKind') collate "C",
        (item.value ->> 'ownerId')::uuid,
        (item.value ->> 'permissionId')::uuid
    ) into canonical_permissions
    from pg_catalog.jsonb_array_elements(candidate_permissions) as item(value);

    if canonical_permissions is distinct from candidate_permissions then
      raise exception using errcode = '22023',
        message = 'Role permissions must use canonical unique identity order';
    end if;
    select pg_catalog.count(*), pg_catalog.count(distinct pg_catalog.jsonb_build_array(
      case when item.value ? 'applicationRootId'
        then (item.value ->> 'applicationRootId')::uuid else null end,
      item.value ->> 'ownerKind',
      (item.value ->> 'ownerId')::uuid,
      (item.value ->> 'permissionId')::uuid
    ))
    into permission_count, selected_template_count
    from pg_catalog.jsonb_array_elements(candidate_permissions) as item(value);
    if permission_count <> selected_template_count then
      raise exception using errcode = '22023',
        message = 'Role permission identities must be unique';
    end if;
  end if;

  if template_source is not null then
    if template_source - array[
      'applicationRootId', 'registrationRevision', 'catalogueFingerprint'
    ]::text[] <> '{}'::jsonb
      or not (template_source ?& array[
        'applicationRootId', 'registrationRevision', 'catalogueFingerprint'
      ])
      or pg_catalog.jsonb_typeof(template_source -> 'applicationRootId') <> 'string'
      or vortex_platform.is_non_nil_uuid(template_source ->> 'applicationRootId') is not true
      or pg_catalog.jsonb_typeof(template_source -> 'registrationRevision') <> 'number'
      or (template_source ->> 'registrationRevision')::numeric not between 1 and 9007199254740991
      or (template_source ->> 'registrationRevision')::numeric <>
        pg_catalog.trunc((template_source ->> 'registrationRevision')::numeric)
      or pg_catalog.jsonb_typeof(template_source -> 'catalogueFingerprint') <> 'string'
      or target_source_role_id = '00000000-0000-0000-0000-000000000000'::uuid then
      raise exception using errcode = '22023',
        message = 'Application role-template evidence is invalid';
    end if;

    target_accepted_registration_revision :=
      (template_source ->> 'registrationRevision')::numeric::bigint;
    target_application_root_id := (template_source ->> 'applicationRootId')::uuid;

    -- The evidence names the registration; the source release and the role's live permissions
    -- are read from it here, exactly as the preparation read them.
    select registration.source_definition_key, registration.source_revision,
      registration.source_version, registration.validation_contract_version
    into target_source_definition_key, target_source_release_revision,
      target_source_release_version, target_source_validation_contract_version
    from vortex_access.permission_registrations as registration
    where registration.organization_id = target_organization_id
      and registration.registration_kind = 'application'
      and registration.registration_owner_id = target_application_root_id
      and registration.revision = target_accepted_registration_revision
      and registration.state = 'active'
      and registration.permission_catalogue_fingerprint =
        template_source ->> 'catalogueFingerprint';
    if not found then
      raise exception using errcode = '40001',
        message = 'Prepared application registration is stale or unavailable';
    end if;

    live_permissions := vortex_access.application_role_template_live_permissions_internal(
      target_organization_id, target_application_root_id,
      target_accepted_registration_revision, target_source_role_id
    );
    if live_permissions is null or pg_catalog.jsonb_array_length(live_permissions) = 0 then
      raise exception using errcode = '40001',
        message = 'Application role template is stale or unavailable';
    end if;
  end if;

  manifest := p_evidence -> 'affectedAssignmentManifest';

  perform 1
  from vortex_access.organization_access_versions as version
  join vortex_identity.organizations as organization
    on organization.organization_id = version.organization_id
  join vortex_identity.tenants as tenant
    on tenant.tenant_id = organization.tenant_id
  where version.organization_id = target_organization_id
    and organization.state = 'active'
    and tenant.state = 'active'
  for update of version;
  if not found then
    raise exception using errcode = '42501',
      message = 'Organization role-change scope is unavailable';
  end if;

  if candidate_permissions is not null then
    perform 1
    from vortex_access.permission_registrations as registration
    join pg_catalog.jsonb_array_elements(candidate_permissions) as item(value)
      on registration.organization_id = target_organization_id
      and registration.registration_kind = case
        when item.value ->> 'ownerKind' = 'platform' then 'platform'
        else 'application'
      end
      and registration.registration_owner_id = case
        when item.value ->> 'ownerKind' = 'platform'
          -- guard-allow: function-uuid fixed platform permission identity without declaration-table read access
          then 'cabe121e-0baf-4084-9471-cce915d460a8'::uuid
        else (item.value ->> 'applicationRootId')::uuid
      end
      and registration.revision =
        (item.value ->> 'acceptedRegistrationRevision')::numeric::bigint
      and registration.permission_catalogue_fingerprint =
        item.value ->> 'catalogueFingerprint'
      and registration.state = 'active'
    order by registration.registration_kind collate "C",
      registration.registration_owner_id
    for update of registration;

    perform 1
    from vortex_access.permission_continuities as continuity
    join pg_catalog.jsonb_array_elements(candidate_permissions) as item(value)
      on continuity.organization_id = target_organization_id
      and continuity.application_scope_id = coalesce(case when item.value ? 'applicationRootId'
          then (item.value ->> 'applicationRootId')::uuid else null end, '00000000-0000-0000-0000-000000000000'::uuid)
      and (item.value ->> 'applicationRootId') is distinct from '00000000-0000-0000-0000-000000000000'
      and continuity.owner_kind = item.value ->> 'ownerKind'
      and continuity.owner_id = (item.value ->> 'ownerId')::uuid
      and continuity.permission_id = (item.value ->> 'permissionId')::uuid
    order by continuity.application_root_id nulls last,
      continuity.owner_kind collate "C", continuity.owner_id, continuity.permission_id
    for update of continuity;

    select pg_catalog.count(*) into permission_count
    from pg_catalog.jsonb_array_elements(candidate_permissions) as item(value)
    join vortex_access.permission_continuities as continuity
      on continuity.organization_id = target_organization_id
      and continuity.application_scope_id = coalesce(case when item.value ? 'applicationRootId'
          then (item.value ->> 'applicationRootId')::uuid else null end, '00000000-0000-0000-0000-000000000000'::uuid)
      and (item.value ->> 'applicationRootId') is distinct from '00000000-0000-0000-0000-000000000000'
      and continuity.owner_kind = item.value ->> 'ownerKind'
      and continuity.owner_id = (item.value ->> 'ownerId')::uuid
      and continuity.permission_id = (item.value ->> 'permissionId')::uuid
      and continuity.state = 'available'
      and continuity.continuity_revision =
        (item.value ->> 'continuityRevision')::numeric::bigint
      and continuity.meaning_fingerprint = item.value ->> 'meaningFingerprint'
    join vortex_access.permission_registrations as registration
      on registration.organization_id = continuity.organization_id
      and registration.registration_kind = continuity.registration_kind
      and registration.registration_owner_id = continuity.registration_owner_id
      and registration.state = 'active'
      and registration.revision =
        (item.value ->> 'acceptedRegistrationRevision')::numeric::bigint
      and registration.permission_catalogue_fingerprint =
        item.value ->> 'catalogueFingerprint'
    join vortex_access.permission_catalogue_entries as catalogue
      on catalogue.organization_id = continuity.organization_id
      and catalogue.registration_kind = continuity.registration_kind
      and catalogue.registration_owner_id = continuity.registration_owner_id
      and catalogue.registration_revision = registration.revision
      and catalogue.owner_kind = continuity.owner_kind
      and catalogue.owner_id = continuity.owner_id
      and catalogue.permission_id = continuity.permission_id
      and catalogue.application_root_id is not distinct from continuity.application_root_id
      and catalogue.meaning_fingerprint = continuity.meaning_fingerprint;
    if permission_count <> pg_catalog.jsonb_array_length(candidate_permissions) then
      raise exception using errcode = '40001',
        message = 'Role permission evidence is stale or unavailable';
    end if;
  end if;

  if template_source is not null then
    perform 1
    from vortex_access.permission_registrations as registration
    where registration.organization_id = target_organization_id
      and registration.registration_kind = 'application'
      and registration.registration_owner_id = target_application_root_id
      and registration.revision = target_accepted_registration_revision
      and registration.state = 'active'
    ;
    if not found then
      raise exception using errcode = '40001',
        message = 'Application registration is stale or unavailable';
    end if;

    perform 1
    from vortex_access.application_role_template_continuities as continuity
    where continuity.organization_id = target_organization_id
      and continuity.application_root_id = target_application_root_id
      and continuity.source_role_id = target_source_role_id
      and continuity.state = 'available'
      and continuity.continuity_revision = target_template_continuity_revision
      and continuity.last_processed_registration_revision =
        target_accepted_registration_revision
    for update;
    if not found then
      raise exception using errcode = '40001',
        message = 'Application role template is stale or unavailable';
    end if;

    select pg_catalog.count(*) into permission_count
    from pg_catalog.jsonb_array_elements(candidate_permissions) as permission(value)
    where exists (
      select 1
      from pg_catalog.jsonb_array_elements(live_permissions) as live(value)
      where (live.value ->> 'applicationRootId')::uuid =
          (permission.value ->> 'applicationRootId')::uuid
        and live.value ->> 'ownerKind' = permission.value ->> 'ownerKind'
        and (live.value ->> 'ownerId')::uuid =
          (permission.value ->> 'ownerId')::uuid
        and (live.value ->> 'permissionId')::uuid =
          (permission.value ->> 'permissionId')::uuid
        and live.value ->> 'meaningFingerprint' =
          permission.value ->> 'meaningFingerprint'
    );
    if permission_count <> pg_catalog.jsonb_array_length(candidate_permissions)
      or (
        operation_name in ('accept_new_application_role', 'accept_application_role_revision')
        and permission_count <>
          pg_catalog.jsonb_array_length(live_permissions)
      ) then
      raise exception using errcode = '40001',
        message = 'Role permissions do not match the current application template';
    end if;
  end if;

  if operation_name in (
    'create_custom', 'create_custom_from_template', 'accept_new_application_role'
  ) then
    select stored.* into role_identity
    from vortex_access.organization_roles as stored
    where stored.organization_id = target_organization_id
      and stored.role_id = target_role_id
    for update;
    if found then
      raise exception using errcode = '40001',
        message = 'Organization role identity already exists';
    end if;

    target_role_revision := 1;
    target_policy_continuity_revision := 1;
    target_authority_continuity_revision := 1;
    target_role_kind := case
      when operation_name = 'accept_new_application_role' then 'application'
      else 'custom'
    end;
    target_lifecycle := 'active';
    operation_at := pg_catalog.clock_timestamp();

    insert into vortex_access.organization_roles (
      organization_id, role_id, role_kind, role_key, application_root_id,
      source_role_id, derived_application_root_id, derived_source_role_id,
      derived_source_definition_key, derived_source_release_revision,
      derived_source_release_version, derived_source_validation_contract_version,
      live_revision, created_by, created_at
    ) values (
      target_organization_id, target_role_id, target_role_kind, target_role_key,
      case when target_role_kind = 'application' then target_application_root_id else null end,
      case when target_role_kind = 'application' then target_source_role_id else null end,
      case when operation_name = 'create_custom_from_template'
        then target_application_root_id else null end,
      case when operation_name = 'create_custom_from_template'
        then target_source_role_id else null end,
      case when operation_name = 'create_custom_from_template'
        then target_source_definition_key else null end,
      case when operation_name = 'create_custom_from_template'
        then target_source_release_revision else null end,
      case when operation_name = 'create_custom_from_template'
        then target_source_release_version else null end,
      case when operation_name = 'create_custom_from_template'
        then target_source_validation_contract_version else null end,
      1, p_changed_by, operation_at
    );

    select stored.* into role_identity
    from vortex_access.organization_roles as stored
    where stored.organization_id = target_organization_id
      and stored.role_id = target_role_id
    for update;

    if operation_name = 'create_custom_from_template' then
      target_application_root_id := null;
      target_source_role_id := null;
      target_source_definition_key := null;
      target_source_release_revision := null;
      target_source_release_version := null;
      target_source_validation_contract_version := null;
      target_accepted_registration_revision := null;
      target_template_continuity_revision := null;
    end if;
  else
    select stored.* into role_identity
    from vortex_access.organization_roles as stored
    where stored.organization_id = target_organization_id
      and stored.role_id = target_role_id
    for update;
    if not found or role_identity.live_revision <> expected_role_revision then
      raise exception using errcode = '40001',
        message = 'Organization role revision is stale or unavailable';
    end if;
    if role_identity.live_revision = 9007199254740991 then
      raise exception using errcode = '22003',
        message = 'Organization role revision is exhausted';
    end if;
    select revision.* into current_revision
    from vortex_access.organization_role_revisions as revision
    where revision.organization_id = target_organization_id
      and revision.role_id = target_role_id
      and revision.revision = role_identity.live_revision;
    if not found then
      raise exception using errcode = '23514',
        message = 'Current organization role revision is unavailable';
    end if;
    if current_revision.lifecycle = 'retired' then
      raise exception using errcode = '40001',
        message = 'A retired organization role is terminal';
    end if;
    if operation_name = 'revise_custom_permissions'
      and role_identity.role_kind <> 'custom' then
      raise exception using errcode = '40001',
        message = 'Custom role permission revision requires a custom role';
    end if;
    if operation_name = 'accept_application_role_revision'
      and (
        role_identity.role_kind <> 'application'
        or role_identity.application_root_id <> target_application_root_id
        or role_identity.source_role_id <> target_source_role_id
      ) then
      raise exception using errcode = '40001',
        message = 'Application role acceptance targets the wrong role source';
    end if;
    target_role_revision := role_identity.live_revision + 1;
  end if;

  if operation_at is null then
    operation_at := pg_catalog.clock_timestamp();
  end if;
  if operation_name not in (
    'create_custom', 'create_custom_from_template', 'accept_new_application_role'
  ) then
    target_role_kind := role_identity.role_kind;
    target_application_root_id := role_identity.application_root_id;
    target_source_role_id := role_identity.source_role_id;
  end if;

  if operation_name in ('revise_metadata_policy', 'retire_role') then
    target_lifecycle := case
      when operation_name = 'retire_role' then 'retired'
      else current_revision.lifecycle
    end;
    target_privilege_classification := case
      when operation_name = 'retire_role' then current_revision.privilege_classification
      else target_privilege_classification
    end;
    target_assignment_policy := case
      when operation_name = 'retire_role' then current_revision.assignment_policy
      else target_assignment_policy
    end;
    if operation_name = 'retire_role' then
      target_role_key := current_revision.role_key;
      target_label := current_revision.label;
      target_description := current_revision.description;
      target_activation_policy_id := current_revision.activation_policy_id;
      target_activation_policy_revision := current_revision.activation_policy_revision;
    end if;
    target_source_definition_key := current_revision.source_definition_key;
    target_source_release_revision := current_revision.source_release_revision;
    target_source_release_version := current_revision.source_release_version;
    target_source_validation_contract_version :=
      current_revision.source_validation_contract_version;
    target_accepted_registration_revision := current_revision.accepted_registration_revision;
    target_template_continuity_revision := current_revision.template_continuity_revision;
  elsif operation_name = 'revise_custom_permissions' then
    target_lifecycle := 'active';
    target_source_definition_key := null;
    target_source_release_revision := null;
    target_source_release_version := null;
    target_source_validation_contract_version := null;
    target_accepted_registration_revision := null;
    target_template_continuity_revision := null;
  elsif operation_name = 'accept_application_role_revision' then
    target_lifecycle := 'active';
  end if;

  if operation_name <> 'retire_role' then
    if target_assignment_policy = 'standing' then
      target_activation_policy_id := null;
      target_activation_policy_revision := null;
    elsif policy_value is null then
      perform 1
      from vortex_access.organization_role_activation_policy_revisions as policy
      where policy.organization_id = target_organization_id
        and policy.role_id = target_role_id
        and policy.activation_policy_id = target_activation_policy_id
        and policy.revision = target_activation_policy_revision;
      if not found then
        raise exception using errcode = '40001',
          message = 'Existing role activation policy is stale or unavailable';
      end if;
    else
      select pg_catalog.max(policy.revision) into maximum_policy_revision
      from vortex_access.organization_role_activation_policy_revisions as policy
      where policy.organization_id = target_organization_id
        and policy.role_id = target_role_id
        and policy.activation_policy_id = target_activation_policy_id;
      if maximum_policy_revision = 9007199254740991 then
        raise exception using errcode = '22003',
          message = 'New role activation policy revision is exhausted';
      end if;
      if (maximum_policy_revision is null and target_activation_policy_revision <> 1)
        or (maximum_policy_revision is not null
          and target_activation_policy_revision <> maximum_policy_revision + 1) then
        raise exception using errcode = '40001',
          message = 'New role activation policy revision is stale or invalid';
      end if;
    end if;
  end if;

  if current_revision.organization_id is not null then
    if current_revision.assignment_policy = target_assignment_policy
      and current_revision.activation_policy_id is not distinct from
        target_activation_policy_id
      and current_revision.activation_policy_revision is not distinct from
        target_activation_policy_revision then
      target_policy_continuity_revision := current_revision.policy_continuity_revision;
    else
      if current_revision.policy_continuity_revision = 9007199254740991 then
        raise exception using errcode = '22003',
          message = 'Organization role policy continuity is exhausted';
      end if;
      target_policy_continuity_revision :=
        current_revision.policy_continuity_revision + 1;
    end if;
  end if;

  if current_revision.organization_id is not null then
    select coalesce(
      pg_catalog.jsonb_agg(
        pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
          'kind', 'exact',
          'applicationRootId', permission.application_root_id,
          'ownerKind', permission.owner_kind,
          'ownerId', permission.owner_id,
          'permissionId', permission.permission_id,
          'acceptedRegistrationRevision', permission.accepted_registration_revision,
          'catalogueFingerprint', permission.catalogue_fingerprint,
          'continuityRevision', permission.continuity_revision,
          'meaningFingerprint', permission.meaning_fingerprint
        )) order by permission.entry_ordinal
      ),
      '[]'::jsonb
    ) into current_permissions
    from vortex_access.organization_role_permission_entries as permission
    where permission.organization_id = target_organization_id
      and permission.role_id = target_role_id
      and permission.role_revision = current_revision.revision;
  end if;

  if operation_name in ('revise_metadata_policy', 'retire_role') then
    candidate_permissions := current_permissions;
  end if;
  permissions_changed := current_revision.organization_id is not null
    and candidate_permissions is distinct from current_permissions;

  if operation_name = 'revise_custom_permissions' and not permissions_changed then
    raise exception using errcode = '40001',
      message = 'Explicit custom permission revision must change the accepted set';
  end if;
  if operation_name = 'accept_application_role_revision'
    and current_revision.lifecycle = 'active'
    and not permissions_changed
    and current_revision.source_definition_key is not distinct from
      target_source_definition_key
    and current_revision.source_release_revision is not distinct from
      target_source_release_revision
    and current_revision.source_release_version is not distinct from
      target_source_release_version
    and current_revision.source_validation_contract_version is not distinct from
      target_source_validation_contract_version
    and current_revision.accepted_registration_revision is not distinct from
      target_accepted_registration_revision
    and current_revision.template_continuity_revision is not distinct from
      target_template_continuity_revision then
    raise exception using errcode = '40001',
      message = 'Explicit application acceptance must change accepted source evidence';
  end if;

  if current_revision.organization_id is not null then
    configured_state_changed :=
      current_revision.role_key is distinct from target_role_key
      or current_revision.label is distinct from target_label
      or current_revision.description is distinct from target_description
      or current_revision.privilege_classification is distinct from
        target_privilege_classification
      or current_revision.assignment_policy is distinct from target_assignment_policy
      or current_revision.activation_policy_id is distinct from target_activation_policy_id
      or current_revision.activation_policy_revision is distinct from
        target_activation_policy_revision
      or current_revision.lifecycle is distinct from target_lifecycle
      or permissions_changed
      or current_revision.source_definition_key is distinct from target_source_definition_key
      or current_revision.source_release_revision is distinct from
        target_source_release_revision
      or current_revision.source_release_version is distinct from target_source_release_version
      or current_revision.source_validation_contract_version is distinct from
        target_source_validation_contract_version
      or current_revision.accepted_registration_revision is distinct from
        target_accepted_registration_revision
      or current_revision.template_continuity_revision is distinct from
        target_template_continuity_revision;
    if not configured_state_changed then
      raise exception using errcode = '40001',
        message = 'Organization role candidate does not change configured state';
    end if;
  end if;

  if current_revision.organization_id is not null then
    select exists (
      select 1
      from pg_catalog.jsonb_array_elements(candidate_permissions) as proposed(value)
      where not exists (
        select 1
        from pg_catalog.jsonb_array_elements(current_permissions) as existing(value)
        where existing.value -> 'applicationRootId' is not distinct from
            proposed.value -> 'applicationRootId'
          and existing.value ->> 'ownerKind' = proposed.value ->> 'ownerKind'
          and existing.value ->> 'ownerId' = proposed.value ->> 'ownerId'
          and existing.value ->> 'permissionId' = proposed.value ->> 'permissionId'
          and existing.value ->> 'continuityRevision' =
            proposed.value ->> 'continuityRevision'
          and existing.value ->> 'meaningFingerprint' =
            proposed.value ->> 'meaningFingerprint'
      )
    ) into authority_broadened;

    manifest_required :=
      current_revision.assignment_policy <> target_assignment_policy
      or (
        current_revision.lifecycle in ('unavailable', 'retired')
        and target_lifecycle in ('active', 'acceptance_required')
      )
      or authority_broadened;

    if authority_broadened
      or (
        current_revision.lifecycle in ('unavailable', 'retired')
        and target_lifecycle in ('active', 'acceptance_required')
      ) then
      if current_revision.authority_continuity_revision = 9007199254740991 then
        raise exception using errcode = '22003',
          message = 'Organization role authority continuity is exhausted';
      end if;
      target_authority_continuity_revision :=
        current_revision.authority_continuity_revision + 1;
    else
      target_authority_continuity_revision :=
        current_revision.authority_continuity_revision;
    end if;
  end if;

  if manifest_required then
    if manifest is null
      or manifest - array[
        'organizationId', 'roleId', 'assignments'
      ]::text[] <> '{}'::jsonb
      or not (manifest ?& array['organizationId', 'roleId', 'assignments'])
      or pg_catalog.jsonb_typeof(manifest -> 'organizationId') <> 'string'
      or pg_catalog.jsonb_typeof(manifest -> 'roleId') <> 'string'
      or pg_catalog.jsonb_typeof(manifest -> 'assignments') <> 'array'
      or (manifest ->> 'organizationId')::uuid <> target_organization_id
      or (manifest ->> 'roleId')::uuid <> target_role_id then
      raise exception using errcode = '22023',
        message = 'Affected assignment manifest shape is invalid';
    end if;

    if exists (
      select 1
      from pg_catalog.jsonb_array_elements(manifest -> 'assignments') as item(value)
      where pg_catalog.jsonb_typeof(item.value) <> 'object'
        or item.value - array[
          'roleAssignmentId', 'expectedRevision', 'assignee'
        ]::text[] <> '{}'::jsonb
        or not (item.value ?& array[
          'roleAssignmentId', 'expectedRevision', 'assignee'
        ])
        or pg_catalog.jsonb_typeof(item.value -> 'roleAssignmentId') <> 'string'
        or pg_catalog.jsonb_typeof(item.value -> 'expectedRevision') <> 'number'
        or pg_catalog.jsonb_typeof(item.value -> 'assignee') <> 'object'
        or (item.value ->> 'expectedRevision')::numeric not between
          1 and 9007199254740991
        or (item.value ->> 'expectedRevision')::numeric <>
          pg_catalog.trunc((item.value ->> 'expectedRevision')::numeric)
        or not (
          (
            item.value #>> '{assignee,kind}' = 'organization_account'
            and (item.value -> 'assignee') - array[
              'kind', 'organizationAccountId'
            ]::text[] = '{}'::jsonb
            and (item.value -> 'assignee') ?& array[
              'kind', 'organizationAccountId'
            ]
            and pg_catalog.jsonb_typeof(
              item.value #> '{assignee,organizationAccountId}'
            ) = 'string'
          )
          or (
            item.value #>> '{assignee,kind}' = 'group'
            and (item.value -> 'assignee') - array['kind', 'groupId']::text[] = '{}'::jsonb
            and (item.value -> 'assignee') ?& array['kind', 'groupId']
            and pg_catalog.jsonb_typeof(item.value #> '{assignee,groupId}') = 'string'
          )
        )
    ) then
      raise exception using errcode = '22023',
        message = 'Affected assignment manifest entry is invalid';
    end if;

    perform 1
    from vortex_access.organization_role_assignments as assignment
    where assignment.organization_id = target_organization_id
      and assignment.role_id = target_role_id
      and assignment.state = 'live'
    order by assignment.role_assignment_id
    for update;

    select coalesce(
      pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'roleAssignmentId', assignment.role_assignment_id,
          'expectedRevision', assignment.revision,
          'assignee', case
            when assignment.assignee_kind = 'organization_account' then
              pg_catalog.jsonb_build_object(
                'kind', 'organization_account',
                'organizationAccountId', assignment.organization_account_id
              )
            else pg_catalog.jsonb_build_object(
              'kind', 'group', 'groupId', assignment.group_id
            )
          end
        ) order by assignment.role_assignment_id
      ),
      '[]'::jsonb
    ) into canonical_assignments
    from vortex_access.organization_role_assignments as assignment
    where assignment.organization_id = target_organization_id
      and assignment.role_id = target_role_id
      and assignment.state = 'live';

    if manifest -> 'assignments' is distinct from canonical_assignments then
      raise exception using errcode = '40001',
        message = 'Affected assignment manifest is stale or incomplete';
    end if;
  elsif manifest is not null then
    raise exception using errcode = '22023',
      message = 'This role change must not carry an affected assignment manifest';
  end if;

  if operation_name in ('revise_metadata_policy', 'retire_role') then
    insert into vortex_access.organization_role_permission_entries (
      organization_id, role_id, role_revision, entry_ordinal, role_kind,
      role_application_root_id, application_root_id, owner_kind, owner_id,
      permission_id, registration_kind, registration_owner_id,
      accepted_registration_revision, catalogue_fingerprint,
      continuity_revision, meaning_fingerprint
    )
    select permission.organization_id, permission.role_id, target_role_revision,
      permission.entry_ordinal, permission.role_kind,
      permission.role_application_root_id, permission.application_root_id,
      permission.owner_kind, permission.owner_id, permission.permission_id,
      permission.registration_kind, permission.registration_owner_id,
      permission.accepted_registration_revision, permission.catalogue_fingerprint,
      permission.continuity_revision, permission.meaning_fingerprint
    from vortex_access.organization_role_permission_entries as permission
    where permission.organization_id = target_organization_id
      and permission.role_id = target_role_id
      and permission.role_revision = current_revision.revision
    order by permission.entry_ordinal;
  else
    insert into vortex_access.organization_role_permission_entries (
      organization_id, role_id, role_revision, entry_ordinal, role_kind,
      role_application_root_id, application_root_id, owner_kind, owner_id,
      permission_id, registration_kind, registration_owner_id,
      accepted_registration_revision, catalogue_fingerprint,
      continuity_revision, meaning_fingerprint
    )
    select target_organization_id, target_role_id, target_role_revision,
      item.ordinality, target_role_kind,
      case when target_role_kind = 'application' then target_application_root_id else null end,
      continuity.application_root_id, continuity.owner_kind,
      continuity.owner_id, continuity.permission_id,
      continuity.registration_kind, continuity.registration_owner_id,
      (item.value ->> 'acceptedRegistrationRevision')::numeric::bigint,
      item.value ->> 'catalogueFingerprint',
      (item.value ->> 'continuityRevision')::numeric::bigint,
      item.value ->> 'meaningFingerprint'
    from pg_catalog.jsonb_array_elements(candidate_permissions) with ordinality
      as item(value, ordinality)
    join vortex_access.permission_continuities as continuity
      on continuity.organization_id = target_organization_id
      and continuity.application_scope_id = coalesce(case when item.value ? 'applicationRootId'
          then (item.value ->> 'applicationRootId')::uuid else null end, '00000000-0000-0000-0000-000000000000'::uuid)
      and (item.value ->> 'applicationRootId') is distinct from '00000000-0000-0000-0000-000000000000'
      and continuity.owner_kind = item.value ->> 'ownerKind'
      and continuity.owner_id = (item.value ->> 'ownerId')::uuid
      and continuity.permission_id = (item.value ->> 'permissionId')::uuid
    order by item.ordinality;
  end if;

  -- A named required caller must be a current, active execution binding of this organisation;
  -- it is read without a lock because binding writers lock the binding before the access version.
  if policy_value ? 'requiredCallerExecutionBindingId' and not exists (
    select 1
    from vortex_access.flow_execution_bindings as binding
    where binding.execution_binding_id =
        (policy_value ->> 'requiredCallerExecutionBindingId')::uuid
      and binding.organization_id = target_organization_id
      and binding.is_current
      and binding.state = 'active'
  ) then
    raise exception using errcode = '22023',
      message = 'Required caller execution binding is unavailable';
  end if;

  if policy_value is not null then
    insert into vortex_access.organization_role_activation_policy_revisions (
      organization_id, role_id, activation_policy_id, revision,
      maximum_activation_duration_seconds,
      reason_required, authentication_requirement,
      authentication_maximum_age_seconds, required_caller_execution_binding_id,
      changed_by, changed_at, change_correlation_id
    ) values (
      target_organization_id, target_role_id, target_activation_policy_id,
      target_activation_policy_revision,
      (policy_value ->> 'maximumActivationDurationSeconds')::numeric::bigint,
      (policy_value ->> 'reasonRequired')::boolean,
      policy_value #>> '{recentAuthentication,kind}',
      case when policy_value #>> '{recentAuthentication,kind}' = 'none' then null
        else (policy_value #>>
          '{recentAuthentication,maximumAgeSeconds}')::numeric::bigint end,
      (policy_value ->> 'requiredCallerExecutionBindingId')::uuid,
      p_changed_by, operation_at, p_correlation_id
    );
  end if;

  insert into vortex_access.organization_role_revisions (
    organization_id, role_id, revision, role_kind, application_root_id,
    lifecycle, privilege_classification, assignment_policy,
    policy_continuity_revision, authority_continuity_revision,
    activation_policy_id, activation_policy_revision,
    role_key, label, description,
    source_definition_key, source_release_revision, source_release_version,
    source_validation_contract_version, accepted_registration_revision,
    template_continuity_revision,
    changed_by, changed_at, change_correlation_id
  ) values (
    target_organization_id, target_role_id, target_role_revision,
    target_role_kind, target_application_root_id, target_lifecycle,
    target_privilege_classification, target_assignment_policy,
    target_policy_continuity_revision, target_authority_continuity_revision,
    target_activation_policy_id, target_activation_policy_revision,
    target_role_key, target_label,
    target_description, target_source_definition_key,
    target_source_release_revision, target_source_release_version,
    target_source_validation_contract_version, target_accepted_registration_revision,
    target_template_continuity_revision,
    p_changed_by, operation_at, p_correlation_id
  );

  if current_revision.organization_id is not null then
    update vortex_access.organization_roles as stored
    set live_revision = target_role_revision,
      role_key = target_role_key
    where stored.organization_id = target_organization_id
      and stored.role_id = target_role_id
      and stored.live_revision = expected_role_revision;
    if not found then
      raise exception using errcode = '40001',
        message = 'Organization role revision changed concurrently';
    end if;
  end if;

  select version.current_version into next_access_version
  from vortex_access.increment_organization_access_version(
    target_organization_id,
    p_changed_by,
    p_correlation_id,
    'role_catalogue_changed'
  ) as version;

  select pg_catalog.jsonb_build_object(
    'roleId', revision.role_id,
    'organizationId', revision.organization_id,
    'key', revision.role_key,
    'label', revision.label,
    'description', revision.description,
    'kind', revision.role_kind,
    'liveRevision', revision.revision,
    'privilegeClassification', revision.privilege_classification,
    'assignmentPolicy', case
      when revision.assignment_policy = 'standing' then
        pg_catalog.jsonb_build_object('kind', 'standing')
      else pg_catalog.jsonb_build_object(
        'kind', 'activation_required',
        'activationPolicy', pg_catalog.jsonb_build_object(
          'activationPolicyId', revision.activation_policy_id,
          'revision', revision.activation_policy_revision
        )
      )
    end,
    'policyContinuityRevision', revision.policy_continuity_revision,
    'authorityContinuityRevision', revision.authority_continuity_revision,
    'lifecycle', revision.lifecycle,
    'permissions', coalesce((
      select pg_catalog.jsonb_agg(
        pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
          'kind', 'exact',
          'applicationRootId', permission.application_root_id,
          'ownerKind', permission.owner_kind,
          'ownerId', permission.owner_id,
          'permissionId', permission.permission_id,
          'acceptedRegistrationRevision', permission.accepted_registration_revision,
          'catalogueFingerprint', permission.catalogue_fingerprint,
          'continuityRevision', permission.continuity_revision,
          'meaningFingerprint', permission.meaning_fingerprint
        )) order by permission.entry_ordinal
      )
      from vortex_access.organization_role_permission_entries as permission
      where permission.organization_id = revision.organization_id
        and permission.role_id = revision.role_id
        and permission.role_revision = revision.revision
    ), '[]'::jsonb),
    'createdByActorId', identity.created_by,
    'createdAt', identity.created_at,
    'changedByActorId', revision.changed_by,
    'changedAt', revision.changed_at,
    'changeCorrelationId', revision.change_correlation_id
  ) || case
    when revision.role_kind = 'application' then pg_catalog.jsonb_build_object(
      'applicationRootId', identity.application_root_id,
      'source', pg_catalog.jsonb_build_object(
        'applicationRootId', identity.application_root_id,
        'sourceRoleId', identity.source_role_id,
        'sourceRelease', pg_catalog.jsonb_build_object(
          'kind', 'application',
          'definitionKey', revision.source_definition_key,
          'rootId', identity.application_root_id,
          'releaseRevision', revision.source_release_revision,
          'releaseVersion', revision.source_release_version,
          'validationContractVersion', revision.source_validation_contract_version,
          'contentFingerprint', source_release.content_fingerprint,
          'resolutionFingerprint', source_release.resolution_fingerprint
        ),
        'sourceCatalogueFingerprint', registration.permission_catalogue_fingerprint,
        'acceptedRegistrationRevision', revision.accepted_registration_revision,
        'templateContinuityRevision', revision.template_continuity_revision
      )
    )
    when identity.derived_application_root_id is not null then
      pg_catalog.jsonb_build_object(
        'derivedFromTemplate', pg_catalog.jsonb_build_object(
          'applicationRootId', identity.derived_application_root_id,
          'sourceRoleId', identity.derived_source_role_id,
          'sourceRelease', pg_catalog.jsonb_build_object(
            'kind', 'application',
            'definitionKey', identity.derived_source_definition_key,
            'rootId', identity.derived_application_root_id,
            'releaseRevision', identity.derived_source_release_revision,
            'releaseVersion', identity.derived_source_release_version,
            'validationContractVersion',
              identity.derived_source_validation_contract_version
          )
        )
      )
    else '{}'::jsonb
  end
  into role_result
  from vortex_access.organization_roles as identity
  join vortex_access.organization_role_revisions as revision
    on revision.organization_id = identity.organization_id
    and revision.role_id = identity.role_id
    and revision.revision = identity.live_revision
  left join vortex_access.permission_registration_revisions as registration
    on registration.organization_id = revision.organization_id
    and registration.registration_kind = revision.source_registration_kind
    and registration.registration_owner_id = revision.application_root_id
    and registration.revision = revision.accepted_registration_revision
  left join vortex_definition.releases as source_release
    on source_release.root_id = revision.application_root_id
    and source_release.release_revision = revision.source_release_revision
    and source_release.release_version = revision.source_release_version
    and source_release.validation_contract_version = revision.source_validation_contract_version
  where identity.organization_id = target_organization_id
    and identity.role_id = target_role_id;

  if policy_value is not null then
    select pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
      'organizationId', policy.organization_id,
      'roleId', policy.role_id,
      'activationPolicyId', policy.activation_policy_id,
      'revision', policy.revision,
      'maximumActivationDurationSeconds', policy.maximum_activation_duration_seconds,
      'reasonRequired', policy.reason_required,
      'recentAuthentication', case
        when policy.authentication_requirement = 'none' then
          pg_catalog.jsonb_build_object('kind', 'none')
        else pg_catalog.jsonb_build_object(
          'kind', policy.authentication_requirement,
          'maximumAgeSeconds', policy.authentication_maximum_age_seconds
        )
      end,
      'requiredCallerExecutionBindingId', policy.required_caller_execution_binding_id,
      'changedByActorId', policy.changed_by,
      'changedAt', policy.changed_at,
      'changeCorrelationId', policy.change_correlation_id
    )) into policy_result
    from vortex_access.organization_role_activation_policy_revisions as policy
    where policy.organization_id = target_organization_id
      and policy.role_id = target_role_id
      and policy.activation_policy_id = target_activation_policy_id
      and policy.revision = target_activation_policy_revision;
  end if;

  return query select 'changed'::text, operation_name, role_result,
    policy_result, next_access_version, p_correlation_id;
exception
  when invalid_text_representation or invalid_parameter_value then
    raise exception using errcode = '22023',
      message = 'Organization role-change evidence is invalid';
end
$function$;

revoke execute on function
  vortex_access.coordinate_role_change_without_stewardship_internal(
    jsonb, uuid, uuid
  )
from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

comment on function vortex_access.coordinate_role_change_without_stewardship_internal(
  jsonb, uuid, uuid
) is
  'Owner-only atomic seven-intent role governance composition. It verifies exact evidence and manifests, changes Access once, and grants no caller authority.';

grant execute on function vortex_access.coordinate_role_change_without_stewardship_internal(jsonb, uuid, uuid) to postgres;

alter function vortex_access.coordinate_role_change_without_stewardship_internal(jsonb, uuid, uuid) owner to vortex_owner;

create or replace function vortex_platform.claim_abandoned_file_uploads(p_limit integer, p_storage_project text)
returns jsonb language plpgsql volatile security definer set search_path = ''
as $function$
declare
  candidate record;
  file_value vortex_platform.file_records%rowtype;
  claim_id uuid;
  claim_until timestamptz := pg_catalog.clock_timestamp() + interval '5 minutes';
  result jsonb := '[]'::jsonb;
begin
  if p_storage_project is null or (select project_ref from vortex_platform.storage_destination where singleton)
    is distinct from p_storage_project then
    raise exception using errcode = '55000', message = 'Upload cleanup Storage destination has not been provisioned';
  end if;
  if p_limit is null or p_limit < 1 or p_limit > 25 then
    raise exception using errcode = '22023', message = 'Upload cleanup batch must be between 1 and 25';
  end if;
  -- Lock in the same order as completion and record activation: file, then upload.
  -- Abandonment commits before Storage deletion and permanently excludes activation.
  for candidate in
    select f.file_id, u.upload_expires_at, u.correlation_id
    from vortex_platform.file_uploads u
    join vortex_platform.file_records f on f.file_id = u.file_id
    where u.upload_expires_at <= pg_catalog.clock_timestamp()
      and (u.cleanup_claim_until is null or u.cleanup_claim_until <= pg_catalog.clock_timestamp())
      and f.lifecycle_state in ('pending', 'uploaded', 'scanning', 'quarantined', 'abandoned')
      and f.activated_at is null and pg_catalog.cardinality(f.owning_attachment_references) = 0
      and f.preview_references = '[]'::jsonb and not f.legal_hold
    order by u.upload_expires_at, f.file_id
    limit p_limit for update of f skip locked
  loop
    perform 1 from vortex_platform.file_uploads u
    where u.file_id = candidate.file_id and u.upload_expires_at <= pg_catalog.clock_timestamp()
      and (u.cleanup_claim_until is null or u.cleanup_claim_until <= pg_catalog.clock_timestamp())
    for update;
    if not found then continue; end if;
    claim_id := pg_catalog.gen_random_uuid();
    update vortex_platform.file_uploads set cleanup_claim_id = claim_id,
      cleanup_claim_until = claim_until, grant_claimed = true, revision = revision + 1
    where file_id = candidate.file_id;
    update vortex_platform.file_records set lifecycle_state = 'abandoned'
    where file_id = candidate.file_id returning * into file_value;
    result := result || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'fileRecord', vortex_platform.upload_file_record(file_value),
      'uploadExpiresAt', vortex_platform.format_timestamp_utc(candidate.upload_expires_at),
      'correlationId', candidate.correlation_id, 'claimId', claim_id,
      'validUntil', vortex_platform.format_timestamp_utc(claim_until)));
  end loop;
  return result;
end
$function$;
alter function vortex_platform.claim_abandoned_file_uploads(integer,text) owner to vortex_owner;
revoke all on function vortex_platform.claim_abandoned_file_uploads(integer,text)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;
grant execute on function vortex_platform.claim_abandoned_file_uploads(integer,text) to vortex_runtime;
comment on function vortex_platform.claim_abandoned_file_uploads(integer,text) is
  'Claims a bounded batch of expired never-activated uploads, including clean and rejected inspections; abandoned claims retry after five minutes.';

create or replace function vortex_platform.finish_abandoned_file_upload(p_file_id uuid, p_claim_id uuid)
returns boolean language plpgsql volatile security definer set search_path = ''
as $function$
declare
  file_value vortex_platform.file_records%rowtype;
begin
  select * into file_value from vortex_platform.file_records where file_id = p_file_id for update;
  if not found or file_value.lifecycle_state <> 'abandoned' or file_value.activated_at is not null
    or pg_catalog.cardinality(file_value.owning_attachment_references) <> 0
    or file_value.preview_references <> '[]'::jsonb or file_value.legal_hold then return false; end if;
  -- The caller reaches this boundary only after the exact-object Storage API delete succeeds.
  delete from vortex_platform.file_uploads where file_id = p_file_id and cleanup_claim_id = p_claim_id;
  if not found then return false; end if;
  update vortex_platform.file_records set lifecycle_state = 'removed', removed_at = pg_catalog.clock_timestamp()
  where file_id = p_file_id;
  return true;
end
$function$;
alter function vortex_platform.finish_abandoned_file_upload(uuid,uuid) owner to vortex_owner;
revoke all on function vortex_platform.finish_abandoned_file_upload(uuid,uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;
grant execute on function vortex_platform.finish_abandoned_file_upload(uuid,uuid) to vortex_runtime;
comment on function vortex_platform.finish_abandoned_file_upload(uuid,uuid) is
  'Finalizes only the matching abandoned-upload cleanup claim after confirmed Storage deletion; leaves terminal file metadata and removes upload state.';

create or replace function vortex_definition.expire_abandoned_preview_installations(
  p_limit integer
)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  preview_row record;
  expired_count integer := 0;
begin
  if p_limit is null or p_limit not between 1 and 100 then
    raise exception using errcode = '22023', message = 'Preview expiry batch size is invalid';
  end if;

  for preview_row in
    select preview.preview_installation_id
    from vortex_definition.preview_installations as preview
    where preview.expires_at <= pg_catalog.statement_timestamp()
    order by preview.expires_at, preview.preview_installation_id
    limit p_limit
    -- Overlapping runs (a recovered schedule and the nightly one) never purge the same preview.
    for update of preview skip locked
    for update skip locked
  loop
    -- Its storage is retired with it and dropped in the background.
    delete from vortex_definition.preview_installations as preview
    where preview.preview_installation_id = preview_row.preview_installation_id;
    expired_count := expired_count + 1;
  end loop;

  return expired_count;
end
$function$;

alter function vortex_definition.expire_abandoned_preview_installations(integer)
  owner to vortex_owner;

revoke all on function vortex_definition.expire_abandoned_preview_installations(integer)
  from public, anon, authenticated, service_role, vortex_request;
grant execute on function vortex_definition.expire_abandoned_preview_installations(integer)
  to vortex_runtime;
comment on function vortex_definition.expire_abandoned_preview_installations(integer) is
  'Removes a bounded batch of expired preview installations across organisations, for scheduled runtime maintenance only; their isolated Record storage is retired with them and dropped in the background.';

create or replace function vortex_record.drop_retired_preview_storage(
  p_storage_contract_id uuid
)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  storage_row record;
begin
  if not vortex_platform.is_non_nil_uuid(p_storage_contract_id::text) then
    raise exception using errcode = '22023', message = 'Preview storage identity is invalid';
  end if;
  -- Background maintenance only: waiting for a lock would hold this transaction behind a reader
  -- of the retired table, so a held lock fails fast (55P03) and the next run retries.
  perform pg_catalog.set_config('lock_timeout', '200ms', true);

  -- Retired: its binding outlived its deleted preview, so no request reaches this storage any
  -- more, and the binding is deleted only here, with the storage it names. Another run
  -- dropping the same storage holds these rows; this one leaves it to that run.
  select binding.storage_contract_id, catalogue.physical_table_token into storage_row
  from vortex_record.preview_storage_bindings as binding
  join vortex_record.storage_catalogue as catalogue
    on catalogue.storage_contract_id = binding.storage_contract_id
  where binding.storage_contract_id = p_storage_contract_id
    and not exists (
      select 1 from vortex_definition.preview_installations as preview
      where preview.preview_installation_id = binding.preview_installation_id
    )
  for update of binding, catalogue skip locked;
  if not found then
    return false;
  end if;

  if storage_row.physical_table_token <> (
      'rt_' || pg_catalog.replace(pg_catalog.lower(storage_row.storage_contract_id::text), '-', '')
    )
    or not exists (
      select 1 from vortex_record.storage_catalogue as catalogue
      where catalogue.storage_contract_id = storage_row.storage_contract_id
        and catalogue.physical_schema_token = 'record_data'
        and catalogue.state = 'active'
    ) then
    raise exception using errcode = '55000', message = 'Preview storage lineage is incompatible';
  end if;

    delete from vortex_record.relationship_edges as edge
    where edge.from_storage_contract_id = storage_row.storage_contract_id
      or edge.to_storage_contract_id = storage_row.storage_contract_id;
    delete from vortex_record.record_reference_counters as counter
    where counter.storage_contract_id = storage_row.storage_contract_id;
    delete from vortex_record.index_catalogue as index_row
    where index_row.storage_contract_id = storage_row.storage_contract_id;

    delete from vortex_record.preview_storage_bindings as binding
    where binding.storage_contract_id = storage_row.storage_contract_id;

    execute pg_catalog.format('drop table if exists record_data.%I', storage_row.physical_table_token);
    delete from vortex_record.field_storage_mappings as mapping
    where mapping.storage_contract_id = storage_row.storage_contract_id;
    delete from vortex_record.storage_catalogue as catalogue
    where catalogue.storage_contract_id = storage_row.storage_contract_id;
  return true;
end
$function$;

alter function vortex_record.drop_retired_preview_storage(uuid) owner to vortex_owner;

revoke all on function vortex_record.drop_retired_preview_storage(uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;
grant execute on function vortex_record.drop_retired_preview_storage(uuid)
  to vortex_runtime;
comment on function vortex_record.drop_retired_preview_storage(uuid) is
  'Drops one retired preview storage identity (its preview is gone), including its preview records and record metadata, in its own short background transaction: a held lock fails fast and the next run retries. Preview storage references no platform table, so the drop locks only its own table.';

create or replace function vortex_definition.remove_abandoned_runtime_bundles(
  p_limit integer
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  abandoned_bundle_ttl constant interval := interval '7 days';
  maximum_batch_size constant integer := 100;
  candidate_key record;
  bundle_row vortex_definition.installation_runtime_bundles%rowtype;
  removed_bundle_keys jsonb := '[]'::jsonb;
  bundles_removed bigint := 0;
  bundle_parts_removed bigint := 0;
  access_plans_removed bigint := 0;
  orphaned_access_plans_removed bigint := 0;
  changed_rows bigint;
begin
  if p_limit is null or p_limit < 1 or p_limit > maximum_batch_size then
    raise exception using errcode = '22023',
      message = 'Runtime bundle cleanup batch is invalid';
  end if;

  for candidate_key in
    select bundle.organization_id, bundle.application_root_id,
      bundle.application_release_revision, bundle.bundle_format_version
    from vortex_definition.installation_runtime_bundles as bundle
    where not exists (
      select 1
      from vortex_definition.installation_bindings as binding
      where binding.organization_id = bundle.organization_id
        and binding.application_root_id = bundle.application_root_id
        and binding.application_release_revision = bundle.application_release_revision
        and binding.state = 'active'
    )
      and (
        exists (
          select 1
          from vortex_definition.installation_bindings as later_binding
          where later_binding.organization_id = bundle.organization_id
            and later_binding.application_root_id = bundle.application_root_id
            and later_binding.application_release_revision > bundle.application_release_revision
            and later_binding.state = 'active'
        )
        or (
          bundle.built_at <= pg_catalog.statement_timestamp() - abandoned_bundle_ttl
          and not exists (
            select 1
            from vortex_definition.installation_bindings as previous_binding
            where previous_binding.organization_id = bundle.organization_id
              and previous_binding.application_root_id = bundle.application_root_id
              and previous_binding.application_release_revision = bundle.application_release_revision
              and previous_binding.state = 'detached'
          )
        )
      )
    order by bundle.built_at, bundle.organization_id, bundle.application_root_id,
      bundle.application_release_revision, bundle.bundle_format_version
    limit p_limit
  loop
    perform 1
    from vortex_definition.installation_bindings as binding
    where binding.organization_id = candidate_key.organization_id
      and binding.application_root_id = candidate_key.application_root_id
    order by binding.module_root_id
    for update;

    select bundle.* into bundle_row
    from vortex_definition.installation_runtime_bundles as bundle
    where bundle.organization_id = candidate_key.organization_id
      and bundle.application_root_id = candidate_key.application_root_id
      and bundle.application_release_revision = candidate_key.application_release_revision
      and bundle.bundle_format_version = candidate_key.bundle_format_version
    for update of bundle skip locked;
    if not found then
      continue;
    end if;

    if exists (
      select 1
      from vortex_definition.installation_bindings as binding
      where binding.organization_id = bundle_row.organization_id
        and binding.application_root_id = bundle_row.application_root_id
        and binding.application_release_revision = bundle_row.application_release_revision
        and binding.state = 'active'
    ) then
      continue;
    end if;

    if not exists (
        select 1
        from vortex_definition.installation_bindings as later_binding
        where later_binding.organization_id = bundle_row.organization_id
          and later_binding.application_root_id = bundle_row.application_root_id
          and later_binding.application_release_revision > bundle_row.application_release_revision
          and later_binding.state = 'active'
      ) and (
        bundle_row.built_at > pg_catalog.statement_timestamp() - abandoned_bundle_ttl
        or exists (
          select 1
          from vortex_definition.installation_bindings as previous_binding
          where previous_binding.organization_id = bundle_row.organization_id
            and previous_binding.application_root_id = bundle_row.application_root_id
            and previous_binding.application_release_revision = bundle_row.application_release_revision
            and previous_binding.state = 'detached'
        )
      ) then
      continue;
    end if;

    delete from vortex_definition.installation_runtime_bundle_parts as part
    where part.organization_id = bundle_row.organization_id
      and part.application_root_id = bundle_row.application_root_id
      and part.application_release_revision = bundle_row.application_release_revision
      and part.bundle_format_version = bundle_row.bundle_format_version;
    get diagnostics changed_rows = row_count;
    bundle_parts_removed := bundle_parts_removed + changed_rows;

    delete from vortex_definition.installation_runtime_bundles as bundle
    where bundle.organization_id = bundle_row.organization_id
      and bundle.application_root_id = bundle_row.application_root_id
      and bundle.application_release_revision = bundle_row.application_release_revision
      and bundle.bundle_format_version = bundle_row.bundle_format_version;
    get diagnostics changed_rows = row_count;
    if changed_rows = 1 then
      bundles_removed := bundles_removed + 1;
      removed_bundle_keys := removed_bundle_keys || pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object(
          'organizationId', bundle_row.organization_id,
          'applicationRootId', bundle_row.application_root_id,
          'applicationReleaseRevision', bundle_row.application_release_revision
        )
      );
    end if;
  end loop;

  delete from vortex_record.installation_access_plans as plan
  where plan.plan_key in (
    select candidate.plan_key
    from vortex_record.installation_access_plans as candidate
    where exists (
      select 1
      from pg_catalog.jsonb_array_elements(removed_bundle_keys) as removed(bundle_key)
      where (removed.bundle_key ->> 'organizationId')::uuid = candidate.organization_id
        and (removed.bundle_key ->> 'applicationRootId')::uuid = candidate.application_root_id
        and (removed.bundle_key ->> 'applicationReleaseRevision')::bigint =
          candidate.application_release_revision
    )
      and not exists (
        select 1
        from vortex_definition.installation_runtime_bundles as remaining
        where remaining.organization_id = candidate.organization_id
          and remaining.application_root_id = candidate.application_root_id
          and remaining.application_release_revision = candidate.application_release_revision
      )
      and not exists (
        select 1
        from vortex_definition.installation_bindings as binding
        where binding.organization_id = candidate.organization_id
          and binding.application_root_id = candidate.application_root_id
          and binding.application_release_revision = candidate.application_release_revision
          and binding.state = 'active'
      )
    order by candidate.plan_key
    limit p_limit
  );
  get diagnostics changed_rows = row_count;
  access_plans_removed := access_plans_removed + changed_rows;

  delete from vortex_record.installation_access_plans as plan
  where plan.plan_key in (
    select candidate.plan_key
    from vortex_record.installation_access_plans as candidate
    where candidate.created_at <= pg_catalog.statement_timestamp() - abandoned_bundle_ttl
      and not exists (
        select 1
        from vortex_definition.installation_runtime_bundles as bundle
        where bundle.organization_id = candidate.organization_id
          and bundle.application_root_id = candidate.application_root_id
          and bundle.application_release_revision = candidate.application_release_revision
      )
      and not exists (
        select 1
        from vortex_definition.installation_bindings as binding
        where binding.organization_id = candidate.organization_id
          and binding.application_root_id = candidate.application_root_id
          and binding.application_release_revision = candidate.application_release_revision
          and binding.state = 'active'
      )
    order by candidate.plan_key
    limit p_limit
  );
  get diagnostics changed_rows = row_count;
  orphaned_access_plans_removed := changed_rows;

  return pg_catalog.jsonb_build_object(
    'bundlesRemoved', bundles_removed,
    'bundlePartsRemoved', bundle_parts_removed,
    'accessPlansRemoved', access_plans_removed,
    'orphanedAccessPlansRemoved', orphaned_access_plans_removed
  );
end
$function$;
alter function vortex_definition.remove_abandoned_runtime_bundles(integer) owner to vortex_owner;


alter function vortex_definition.remove_abandoned_runtime_bundles(integer)
  owner to vortex_owner;
revoke all on function vortex_definition.remove_abandoned_runtime_bundles(integer)
  from public, anon, authenticated, service_role, vortex_request, vortex_record_adapter;
grant execute on function vortex_definition.remove_abandoned_runtime_bundles(integer)
  to vortex_runtime;
comment on function vortex_definition.remove_abandoned_runtime_bundles(integer) is
  'Removes one bounded batch of expired never-activated or superseded runtime bundles and orphaned access plans.';

create or replace function vortex_definition.remove_installation_runtime_bundles(
  p_application_root_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  authority record;
  bundle_list jsonb;
  bundles_removed bigint;
  bundle_parts_removed bigint;
  access_plans_removed bigint;
begin
  if p_application_root_id is null
    or p_application_root_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using errcode = '22023',
      message = 'Runtime bundle uninstall command is invalid';
  end if;

  select locked.* into strict authority
  from vortex_access.lock_application_installation_authority() as locked;

  if not exists (
    select 1
    from vortex_definition.roots as root
    where root.root_id = p_application_root_id
      and root.organization_id = authority.organization_id
      and root.kind = 'application'
  ) then
    raise exception using errcode = 'P0002',
      message = 'Application installation is unavailable';
  end if;

  perform 1
  from vortex_definition.installation_bindings as binding
  where binding.organization_id = authority.organization_id
    and binding.application_root_id = p_application_root_id
  order by binding.module_root_id
  for update;

  if exists (
    select 1
    from vortex_definition.installation_bindings as binding
    where binding.organization_id = authority.organization_id
      and binding.application_root_id = p_application_root_id
      and binding.state = 'active'
  ) then
    raise exception using errcode = '40001',
      message = 'Runtime bundles cannot be removed while the installation is active';
  end if;

  delete from vortex_definition.installation_runtime_bundle_parts as part
  where part.organization_id = authority.organization_id
    and part.application_root_id = p_application_root_id;
  get diagnostics bundle_parts_removed = row_count;

  with removed_bundles as (
    delete from vortex_definition.installation_runtime_bundles as bundle
    where bundle.organization_id = authority.organization_id
      and bundle.application_root_id = p_application_root_id
    returning bundle.application_release_revision, bundle.bundle_format_version
  )
  select coalesce(
      pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'applicationReleaseRevision', removed.application_release_revision,
          'bundleFormatVersion', removed.bundle_format_version
        ) order by removed.application_release_revision, removed.bundle_format_version
      ),
      '[]'::jsonb
    ),
    pg_catalog.count(*)
  into bundle_list, bundles_removed
  from removed_bundles as removed;

  delete from vortex_record.installation_access_plans as plan
  where plan.organization_id = authority.organization_id
    and plan.application_root_id = p_application_root_id;
  get diagnostics access_plans_removed = row_count;

  return pg_catalog.jsonb_build_object(
    'bundles', bundle_list,
    'bundlePartsRemoved', bundle_parts_removed,
    'accessPlansRemoved', access_plans_removed
  );
end
$function$;
alter function vortex_definition.remove_installation_runtime_bundles(uuid) owner to vortex_owner;


alter function vortex_definition.remove_installation_runtime_bundles(uuid)
  owner to vortex_owner;
revoke all on function vortex_definition.remove_installation_runtime_bundles(uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;
grant execute on function vortex_definition.remove_installation_runtime_bundles(uuid)
  to vortex_request;
comment on function vortex_definition.remove_installation_runtime_bundles(uuid) is
  'Lists and removes all runtime bundle registrations and access plans for one authorised installation after its bindings are detached.';

create or replace function vortex_record.read_retired_preview_storage(
  p_limit integer
)
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $function$
  -- A storage binding outlives its preview: deleting a preview leaves the binding as the storage's
  -- retirement identity. Storage whose preview row is gone is reached by no request, and the
  -- background drops it.
  select binding.storage_contract_id
  from vortex_record.preview_storage_bindings as binding
  where not exists (
    select 1 from vortex_definition.preview_installations as preview
    where preview.preview_installation_id = binding.preview_installation_id
  )
  order by binding.storage_contract_id
  limit greatest(1, least(coalesce(p_limit, 1), 100));
$function$;

alter function vortex_record.read_retired_preview_storage(integer) owner to vortex_owner;

revoke all on function vortex_record.read_retired_preview_storage(integer)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;
grant execute on function vortex_record.read_retired_preview_storage(integer)
  to vortex_runtime;
comment on function vortex_record.read_retired_preview_storage(integer) is
  'Lists a bounded batch of retired preview storage identities (their preview is gone) for the background drop.';

create or replace function vortex_definition.lock_application_page_adoption_draft(
  p_root_id uuid,
  p_expected_draft_revision bigint,
  p_expected_release_revision bigint
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  checked_context jsonb;
  root_row vortex_definition.roots%rowtype;
  locked_draft_revision bigint;
  result_value jsonb;
begin
  if p_root_id is null or p_root_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_expected_draft_revision is null
    or p_expected_draft_revision not between 1 and 9007199254740991
    or p_expected_release_revision is null
    or p_expected_release_revision not between 1 and 9007199254740991 then
    raise exception using errcode = '22023', message = 'Page adoption draft selector is invalid';
  end if;
  -- This existing guard locks Access before the classified Application root.
  checked_context := vortex_definition.validated_builder_draft_write_context_internal(p_root_id);
  select root.* into strict root_row
  from vortex_definition.roots as root
  where root.root_id = p_root_id
    and root.organization_id = (checked_context ->> 'organizationId')::uuid
    and root.kind = 'application';
  if root_row.application_origin_kind is distinct from 'ordinary' then
    raise exception using errcode = '42501', message = 'Page adoption source is unavailable';
  end if;
  if root_row.current_release_revision is distinct from p_expected_release_revision then
    raise exception using errcode = '40001', message = 'Page adoption publication changed';
  end if;
  select draft.draft_revision into locked_draft_revision
  from vortex_definition.drafts as draft
  where draft.root_id = p_root_id for update;
  if not found or locked_draft_revision is distinct from p_expected_draft_revision then
    raise exception using errcode = '40001', message = 'Page adoption draft changed';
  end if;
  perform vortex_definition.validated_builder_draft_write_context_internal(p_root_id);
  result_value := vortex_definition.read_publication_state(p_root_id);
  if result_value is null then
    raise exception using errcode = '55000', message = 'Page adoption draft is unavailable';
  end if;
  return result_value;
end
$function$;

revoke all on function vortex_definition.lock_application_page_adoption_draft(uuid,bigint,bigint)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_definition.lock_application_page_adoption_draft(uuid,bigint,bigint)
  to vortex_request;
comment on function vortex_definition.lock_application_page_adoption_draft(uuid,bigint,bigint) is
  'Locks an ordinary Application draft for current HUMAN page adoption derivation in Access, root and draft order; returns only its existing protected publication state and writes no source or release.';

alter function vortex_definition.lock_application_page_adoption_draft(uuid,bigint,bigint) owner to vortex_owner;

create or replace function vortex_definition.write_installation_runtime_bundle(
  p_application_root_id uuid,
  p_application_release_revision bigint,
  p_bundle_format_version integer,
  p_pin_fingerprint text,
  p_parts jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  expected_sections constant text[] := array[
    'pages', 'navigation', 'flows', 'trigger_index', 'theme', 'component_registry',
    'access_plan', 'tool_bundle'
  ];
  permission_decision record;
  delegation_decision record;
  checked_context jsonb;
  selected_organization_id uuid;
  part_item jsonb;
  section_value text;
  ordinal_value bigint;
  byte_size_value bigint;
  content_text text;
  content_bytes bytea;
  sha256_value text;
  total_size_value bigint := 0;
  parts_manifest jsonb;
  inserted_rows bigint;
  stored_bundle vortex_definition.installation_runtime_bundles%rowtype;
  expected_module_bindings jsonb;
  prepared_source jsonb;
  source_manifest jsonb;
  section_payloads jsonb := '{}'::jsonb;
  section_text text;
  application_content jsonb;
  expected_modules jsonb;
  expected_trigger_index jsonb;
  expected_access_plan jsonb;
begin
  if p_application_root_id is null
    or p_application_root_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_application_release_revision is null
    or p_application_release_revision not between 1 and 9007199254740991
    or p_bundle_format_version is distinct from 2
    or p_pin_fingerprint is null or p_pin_fingerprint !~ '^sha256:[a-f0-9]{64}$'
    or p_parts is null or pg_catalog.jsonb_typeof(p_parts) is distinct from 'array' then
    raise exception using errcode = '22023',
      message = 'Installation runtime bundle command is invalid';
  end if;
  if pg_catalog.jsonb_array_length(p_parts) < pg_catalog.cardinality(expected_sections) then
    raise exception using errcode = '22023',
      message = 'Installation runtime bundle command is invalid';
  end if;

  select evaluated.* into strict permission_decision
  from vortex_access.evaluate_organization_permission_eligibility(
    pg_catalog.jsonb_build_object(
      'operationKey', 'platform.organization.applications.install',
      'action', pg_catalog.jsonb_build_object('actionKind', 'manage'),
      'target', pg_catalog.jsonb_build_object('kind', 'organization'),
      'requiredPermission', pg_catalog.jsonb_build_object(
        'ownerKind', 'platform',
        -- guard-allow: function-uuid fixed platform permission identity without declaration-table read access
        'ownerId', 'cabe121e-0baf-4084-9471-cce915d460a8',
        -- guard-allow: function-uuid fixed platform permission identity without declaration-table read access
        'permissionId', '7ecd3304-f16c-47d4-94db-0964980091ba'
      ),
      'recentAuthentication', pg_catalog.jsonb_build_object('kind', 'none'),
      'authority', pg_catalog.jsonb_build_object('kind', 'permission')
    )
  ) as evaluated;
  if permission_decision.outcome is distinct from 'eligible' then
    raise exception using errcode = '42501',
      message = 'Module installation authority is unavailable';
  end if;

  select evaluated.* into strict delegation_decision
  from vortex_access.evaluate_organization_permission_eligibility(
    pg_catalog.jsonb_build_object(
      'operationKey', 'platform.organization.applications.install_scope',
      'action', pg_catalog.jsonb_build_object('actionKind', 'manage'),
      'target', pg_catalog.jsonb_build_object('kind', 'organization'),
      'requiredPermission', pg_catalog.jsonb_build_object(
        'ownerKind', 'platform',
        -- guard-allow: function-uuid fixed platform permission identity without declaration-table read access
        'ownerId', 'cabe121e-0baf-4084-9471-cce915d460a8',
        -- guard-allow: function-uuid fixed platform permission identity without declaration-table read access
        'permissionId', '7ecd3304-f16c-47d4-94db-0964980091ba'
      ),
      'recentAuthentication', pg_catalog.jsonb_build_object('kind', 'none'),
      'authority', pg_catalog.jsonb_build_object(
        'kind', 'delegated_management',
        'before', pg_catalog.jsonb_build_object('kind', 'organization_catalogue'),
        'after', pg_catalog.jsonb_build_object('kind', 'organization_catalogue')
      )
    )
  ) as evaluated;
  if delegation_decision.outcome is distinct from 'eligible'
    or delegation_decision.organization_id <> permission_decision.organization_id
    or delegation_decision.organization_account_id <> permission_decision.organization_account_id
    or delegation_decision.access_version <> permission_decision.access_version
    or delegation_decision.correlation_id <> permission_decision.correlation_id then
    raise exception using errcode = '42501',
      message = 'Module installation delegation is unavailable';
  end if;

  checked_context := vortex_access.validated_human_request_context();
  if (checked_context ->> 'organizationId')::uuid <> permission_decision.organization_id
    or (checked_context ->> 'organizationAccountId')::uuid <>
      permission_decision.organization_account_id
    or (checked_context ->> 'accessVersion')::bigint <> permission_decision.access_version
    or (checked_context ->> 'correlationId')::uuid <> permission_decision.correlation_id then
    raise exception using errcode = '40001',
      message = 'Module installation context changed';
  end if;
  selected_organization_id := permission_decision.organization_id;

  if not exists (
    select 1
    from vortex_definition.roots as root
    join vortex_definition.releases as release
      on release.root_id = root.root_id
      and release.release_revision = p_application_release_revision
    where root.root_id = p_application_root_id
      and root.organization_id = selected_organization_id
      and root.kind = 'application'
      and release.validation_contract_version = any (
        vortex_definition.accepted_contract_version('application')
      )
      and release.compilation_output #>> '{kind}' = 'application'
      and release.compilation_output #>> '{canonical,envelope,rootId}' =
        p_application_root_id::text
      and release.compilation_output #>> '{validationContractVersion}' = any (
        vortex_definition.accepted_contract_version('application')
      )
  ) then
    raise exception using errcode = 'P0002',
      message = 'Installation Application release is unavailable';
  end if;

  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'moduleRootId', binding.module_root_id,
      'moduleReleaseRevision', binding.module_release_revision,
      'bindingRevision', binding.binding_revision,
      'state', binding.state
    ) order by binding.module_root_id), '[]'::jsonb)
  into expected_module_bindings
  from vortex_definition.installation_bindings as binding
  where binding.organization_id = selected_organization_id
    and binding.application_root_id = p_application_root_id
    and binding.state = 'provisioned';
  prepared_source := vortex_definition.read_prepared_installation_runtime_source(
    p_application_root_id,
    p_application_release_revision,
    expected_module_bindings
  );
  if prepared_source is null
    or (prepared_source ->> 'organizationId')::uuid is distinct from selected_organization_id
    or (prepared_source ->> 'applicationRootId')::uuid is distinct from p_application_root_id
    or (prepared_source ->> 'applicationReleaseRevision')::bigint is distinct from p_application_release_revision
    or prepared_source ->> 'pinFingerprint' is distinct from p_pin_fingerprint then
    raise exception using errcode = '40001',
      message = 'Installation runtime bundle source changed';
  end if;
  source_manifest := pg_catalog.jsonb_build_object(
    'bundleFormatVersion', 2,
    'application', pg_catalog.jsonb_build_object(
      'rootId', prepared_source #> '{application,rootId}',
      'definitionKey', prepared_source #> '{application,key}',
      'releaseRevision', prepared_source #> '{application,releaseRevision}',
      'releaseVersion', prepared_source #> '{application,releaseVersion}',
      'validationContractVersion', prepared_source #> '{application,validationContractVersion}',
      'contentFingerprint', prepared_source #> '{application,contentFingerprint}',
      'resolutionFingerprint', prepared_source #> '{application,resolutionFingerprint}'
    ),
    'modules', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          'rootId', module.value -> 'rootId',
          'definitionKey', module.value -> 'key',
          'releaseRevision', module.value -> 'releaseRevision',
          'releaseVersion', module.value -> 'releaseVersion',
          'validationContractVersion', module.value -> 'validationContractVersion',
          'contentFingerprint', module.value -> 'contentFingerprint',
          'resolutionFingerprint', module.value -> 'resolutionFingerprint'
        ) order by (module.value ->> 'rootId') collate "C")
      from pg_catalog.jsonb_array_elements(prepared_source -> 'modules') as module(value)
    ), '[]'::jsonb),
    'pinFingerprint', prepared_source -> 'pinFingerprint',
    'preparedRecordAccessPlan', pg_catalog.jsonb_build_object(
      'planKey', prepared_source #> '{preparedRecordAccessPlan,planKey}',
      'mappingFingerprint', prepared_source #> '{preparedRecordAccessPlan,mappingFingerprint}'
    )
  );
  for section_value in
    select required.section
    from pg_catalog.unnest(expected_sections) as required(section)
  loop
    select pg_catalog.string_agg(item.value ->> 'content', '' order by
      (item.value ->> 'ordinal')::integer)
    into section_text
    from pg_catalog.jsonb_array_elements(p_parts) as item(value)
    where item.value ->> 'section' = section_value;
    if section_text is null then
      raise exception using errcode = '22023',
        message = 'Installation runtime bundle section is unavailable';
    end if;
    begin
      section_payloads := section_payloads || pg_catalog.jsonb_build_object(
        section_value, section_text::jsonb
      );
    exception when others then
      raise exception using errcode = '22023',
        message = 'Installation runtime bundle section is invalid';
    end;
  end loop;
  application_content := prepared_source #> '{application,compilationOutput,canonical,content}';
  if application_content is null then
    raise exception using errcode = '55000',
      message = 'Installation runtime bundle Application content is unavailable';
  end if;
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'identity', pg_catalog.jsonb_build_object(
        'kind', module.value -> 'kind',
        'organizationId', module.value -> 'organizationId',
        'rootId', module.value -> 'rootId',
        'definitionKey', module.value -> 'key',
        'releaseRevision', module.value -> 'releaseRevision',
        'releaseVersion', module.value -> 'releaseVersion',
        'validationContractVersion', module.value -> 'validationContractVersion',
        'contentFingerprint', module.value -> 'contentFingerprint',
        'resolutionFingerprint', module.value -> 'resolutionFingerprint',
        'dependencyManifest', module.value -> 'dependencyManifest'
      ),
      'content', module.value #> '{compilationOutput,canonical,content}'
    ) order by (module.value ->> 'rootId') collate "C"), '[]'::jsonb)
  into expected_modules
  from pg_catalog.jsonb_array_elements(prepared_source -> 'modules') as module(value);
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'flowId', flow.value -> 'id', 'trigger', trigger.value
    ) order by (flow.value ->> 'id') collate "C", (trigger.value ->> 'id') collate "C"), '[]'::jsonb)
  into expected_trigger_index
  from pg_catalog.jsonb_array_elements(application_content -> 'flows') as flow(value)
  cross join lateral pg_catalog.jsonb_array_elements(flow.value -> 'triggers') as trigger(value);
  select pg_catalog.jsonb_build_object(
    'preparedRecordAccessPlan', prepared_source -> 'preparedRecordAccessPlan',
    'declaredPermissions', pg_catalog.jsonb_build_object(
      'application', application_content -> 'permissions',
      'modules', coalesce((
        select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
            'rootId', module.value -> 'rootId',
            'permissions', module.value #> '{compilationOutput,canonical,content,permissions}'
          ) order by (module.value ->> 'rootId') collate "C")
        from pg_catalog.jsonb_array_elements(prepared_source -> 'modules') as module(value)
      ), '[]'::jsonb)
    )
  ) into expected_access_plan;
  if section_payloads -> 'navigation' is distinct from application_content -> 'navigation'
    or section_payloads -> 'flows' is distinct from pg_catalog.jsonb_build_object(
      'flows', application_content -> 'flows',
      'flowBindings', application_content -> 'flowBindings'
    )
    or section_payloads -> 'trigger_index' is distinct from expected_trigger_index
    or section_payloads -> 'theme' is distinct from application_content -> 'theme'
    or section_payloads -> 'component_registry' is distinct from application_content -> 'platformBlockDependencies'
    or section_payloads -> 'tool_bundle' is distinct from prepared_source #> '{application,compilationOutput,toolBundle}'
    or section_payloads -> 'access_plan' is distinct from expected_access_plan
    or section_payloads #> '{pages,application,identity}' is distinct from (
      pg_catalog.jsonb_build_object(
        'kind', prepared_source #> '{application,kind}',
        'organizationId', prepared_source #> '{application,organizationId}',
        'rootId', prepared_source #> '{application,rootId}',
        'definitionKey', prepared_source #> '{application,key}',
        'releaseRevision', prepared_source #> '{application,releaseRevision}',
        'releaseVersion', prepared_source #> '{application,releaseVersion}',
        'validationContractVersion', prepared_source #> '{application,validationContractVersion}',
        'contentFingerprint', prepared_source #> '{application,contentFingerprint}',
        'resolutionFingerprint', prepared_source #> '{application,resolutionFingerprint}',
        'dependencyManifest', prepared_source #> '{application,dependencyManifest}',
        'platformCompatibilityVersion',
          prepared_source #> '{application,compilationOutput,platformCompatibilityVersion}'
      )
    )
    or section_payloads #> '{pages,application,content}' is distinct from
      application_content - array[
        'navigation', 'flows', 'flowBindings', 'theme',
        'platformBlockDependencies', 'shells', 'pages'
      ]::text[]
    or section_payloads #> '{pages,application,shells}' is distinct from application_content -> 'shells'
    or section_payloads #> '{pages,application,pages}' is distinct from application_content -> 'pages'
    or section_payloads #> '{pages,modules}' is distinct from expected_modules
    or pg_catalog.jsonb_typeof(section_payloads #> '{pages,resolvedCompositions}') is distinct from 'array'
    or pg_catalog.jsonb_array_length(section_payloads #> '{pages,resolvedCompositions}') <>
      pg_catalog.jsonb_array_length(application_content -> 'pages') then
    raise exception using errcode = '23514',
      message = 'Installation runtime bundle sections do not match current immutable source';
  end if;
  for part_item in
    select item.value from pg_catalog.jsonb_array_elements(p_parts) as item(value)
  loop
    if pg_catalog.jsonb_typeof(part_item) is distinct from 'object' then
      raise exception using errcode = '22023',
        message = 'Installation runtime bundle part is invalid';
    end if;
    if not (part_item ?& array['section', 'ordinal', 'byteSize', 'sha256', 'content'])
      or part_item - array['section', 'ordinal', 'byteSize', 'sha256', 'content'] <> '{}'::jsonb
      or pg_catalog.jsonb_typeof(part_item -> 'section') is distinct from 'string'
      or pg_catalog.jsonb_typeof(part_item -> 'ordinal') is distinct from 'number'
      or pg_catalog.jsonb_typeof(part_item -> 'byteSize') is distinct from 'number'
      or pg_catalog.jsonb_typeof(part_item -> 'sha256') is distinct from 'string'
      or pg_catalog.jsonb_typeof(part_item -> 'content') is distinct from 'string' then
      raise exception using errcode = '22023',
        message = 'Installation runtime bundle part is invalid';
    end if;

    section_value := part_item ->> 'section';
    if not (section_value = any (expected_sections))
      or (part_item ->> 'ordinal') !~ '^(0|[1-9][0-9]*)$'
      or pg_catalog.length(part_item ->> 'ordinal') > 10
      or (part_item ->> 'byteSize') !~ '^[1-9][0-9]*$'
      or pg_catalog.length(part_item ->> 'byteSize') > 7 then
      raise exception using errcode = '22023',
        message = 'Installation runtime bundle part is invalid';
    end if;
    ordinal_value := (part_item ->> 'ordinal')::bigint;
    byte_size_value := (part_item ->> 'byteSize')::bigint;
    content_text := part_item ->> 'content';
    if ordinal_value > 2147483647 or byte_size_value > 1048575 then
      raise exception using errcode = '22023',
        message = 'Installation runtime bundle part exceeds its limit';
    end if;

    content_bytes := pg_catalog.convert_to(content_text, 'UTF8');
    if pg_catalog.octet_length(content_bytes) <> byte_size_value then
      raise exception using errcode = '22023',
        message = 'Installation runtime bundle part size is invalid';
    end if;
    sha256_value := 'sha256:' || pg_catalog.encode(
      extensions.digest(content_bytes, 'sha256'), 'hex'
    );
    if (part_item ->> 'sha256') !~ '^sha256:[a-f0-9]{64}$'
      or sha256_value <> (part_item ->> 'sha256') then
      raise exception using errcode = '22023',
        message = 'Installation runtime bundle part fingerprint is invalid';
    end if;
    total_size_value := total_size_value + byte_size_value;
    if total_size_value > 9007199254740991 then
      raise exception using errcode = '22023',
        message = 'Installation runtime bundle is too large';
    end if;
  end loop;

  if exists (
      select 1
      from pg_catalog.jsonb_array_elements(p_parts) as item(value)
      group by item.value ->> 'section', (item.value ->> 'ordinal')::integer
      having pg_catalog.count(*) > 1
    )
    or exists (
      select 1
      from pg_catalog.jsonb_array_elements(p_parts) as item(value)
      group by item.value ->> 'section'
      having pg_catalog.min((item.value ->> 'ordinal')::integer) <> 0
        or pg_catalog.max((item.value ->> 'ordinal')::integer) <>
          pg_catalog.count(*) - 1
    )
    or exists (
      select 1
      from pg_catalog.unnest(expected_sections) as required(section)
      where not exists (
        select 1
        from pg_catalog.jsonb_array_elements(p_parts) as item(value)
        where item.value ->> 'section' = required.section
      )
    ) then
    raise exception using errcode = '22023',
      message = 'Installation runtime bundle sections are incomplete';
  end if;

  select pg_catalog.jsonb_agg(
    pg_catalog.jsonb_build_object(
      'section', item.value ->> 'section',
      'ordinal', (item.value ->> 'ordinal')::integer,
      'byteSize', (item.value ->> 'byteSize')::bigint,
      'sha256', item.value ->> 'sha256'
    ) order by pg_catalog.array_position(
      expected_sections, item.value ->> 'section'
    ), (item.value ->> 'ordinal')::integer
  )
  into parts_manifest
  from pg_catalog.jsonb_array_elements(p_parts) as item(value);

  insert into vortex_definition.installation_runtime_bundles (
    organization_id, application_root_id, application_release_revision,
    bundle_format_version, pin_fingerprint, source_manifest, parts, total_size_bytes
  ) values (
    selected_organization_id, p_application_root_id, p_application_release_revision,
    p_bundle_format_version, p_pin_fingerprint, source_manifest, parts_manifest, total_size_value
  ) on conflict (
    organization_id, application_root_id, application_release_revision, bundle_format_version
  ) do nothing;
  get diagnostics inserted_rows = row_count;

  if inserted_rows = 0 then
    select stored.* into stored_bundle
    from vortex_definition.installation_runtime_bundles as stored
    where stored.organization_id = selected_organization_id
      and stored.application_root_id = p_application_root_id
      and stored.application_release_revision = p_application_release_revision
      and stored.bundle_format_version = p_bundle_format_version;
    if not found then
      raise exception using errcode = '40001',
        message = 'Installation runtime bundle changed concurrently';
    end if;
    if stored_bundle.pin_fingerprint <> p_pin_fingerprint
      or stored_bundle.source_manifest is distinct from source_manifest
      or stored_bundle.parts is distinct from parts_manifest
      or stored_bundle.total_size_bytes is distinct from total_size_value
      or (select pg_catalog.count(*) from vortex_definition.installation_runtime_bundle_parts as part
        where part.organization_id = selected_organization_id
          and part.application_root_id = p_application_root_id
          and part.application_release_revision = p_application_release_revision
          and part.bundle_format_version = p_bundle_format_version)
        <> pg_catalog.jsonb_array_length(p_parts)
      or exists (
        select 1
        from pg_catalog.jsonb_array_elements(p_parts) as item(value)
        left join vortex_definition.installation_runtime_bundle_parts as part
          on part.organization_id = selected_organization_id
          and part.application_root_id = p_application_root_id
          and part.application_release_revision = p_application_release_revision
          and part.bundle_format_version = p_bundle_format_version
          and part.section = item.value ->> 'section'
          and part.ordinal = (item.value ->> 'ordinal')::integer
        where part.content_bytes is distinct from pg_catalog.convert_to(item.value ->> 'content', 'UTF8')
      ) then
      raise exception using errcode = '23505',
        message = 'Installation runtime bundle pin fingerprint differs';
    end if;
  else
    for part_item in
      select item.value from pg_catalog.jsonb_array_elements(p_parts) as item(value)
    loop
      insert into vortex_definition.installation_runtime_bundle_parts (
        organization_id, application_root_id, application_release_revision,
        bundle_format_version, section, ordinal, content_bytes
      ) values (
        selected_organization_id, p_application_root_id, p_application_release_revision,
        p_bundle_format_version, part_item ->> 'section',
        (part_item ->> 'ordinal')::integer,
        pg_catalog.convert_to(part_item ->> 'content', 'UTF8')
      );
    end loop;

    select stored.* into strict stored_bundle
    from vortex_definition.installation_runtime_bundles as stored
    where stored.organization_id = selected_organization_id
      and stored.application_root_id = p_application_root_id
      and stored.application_release_revision = p_application_release_revision
      and stored.bundle_format_version = p_bundle_format_version;
  end if;

  return pg_catalog.jsonb_build_object(
    'organizationId', stored_bundle.organization_id,
    'applicationRootId', stored_bundle.application_root_id,
    'applicationReleaseRevision', stored_bundle.application_release_revision,
    'bundleFormatVersion', stored_bundle.bundle_format_version,
    'pinFingerprint', stored_bundle.pin_fingerprint,
    'sourceManifest', stored_bundle.source_manifest,
    'parts', stored_bundle.parts,
    'totalSizeBytes', stored_bundle.total_size_bytes,
    'builtAt', stored_bundle.built_at
  );
exception
  when no_data_found then
    raise exception using errcode = 'P0002',
      message = 'Installation runtime bundle evidence is unavailable';
  when too_many_rows then
    raise exception using errcode = '55000',
      message = 'Installation runtime bundle evidence is ambiguous';
end
$function$;

alter function vortex_definition.write_installation_runtime_bundle(uuid,bigint,integer,text,jsonb) owner to vortex_owner;

revoke all on function vortex_definition.write_installation_runtime_bundle(
  uuid, bigint, integer, text, jsonb
) from public, anon, authenticated, service_role, vortex_runtime, vortex_record_adapter;
grant execute on function vortex_definition.write_installation_runtime_bundle(
  uuid, bigint, integer, text, jsonb
) to vortex_request;
comment on function vortex_definition.write_installation_runtime_bundle(
  uuid, bigint, integer, text, jsonb
) is
  'Atomically stores one immutable runtime bundle for an authorised exact Application release and pin fingerprint.';


CREATE OR REPLACE FUNCTION vortex_access.change_organization_account_state(p_organization_account_id uuid, p_expected_revision bigint, p_state text) RETURNS TABLE(organization_account_id uuid, organization_id uuid, identity_id uuid, display_name text, state text, language text, time_zone text, invitation_id uuid, activated_at timestamp with time zone, suspended_at timestamp with time zone, closed_at timestamp with time zone, changed_at timestamp with time zone, state_changed_at timestamp with time zone, state_changed_by uuid, state_change_correlation_id uuid, revision bigint, access_version bigint)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  changed record;
  checked jsonb;
  target_organization_id uuid;
begin
  checked := vortex_identity.validated_human_account_context();

  select account.organization_id into target_organization_id
  from vortex_identity.organization_accounts as account
  where account.organization_account_id = p_organization_account_id
    and account.organization_id = (checked ->> 'organizationId')::uuid;

  if found then
    -- Access owns the composition and governance lock. The lower-level
    -- Identity writer remains unchanged and has no dependency on Access.
    perform 1
    from vortex_access.organization_access_versions as version
    where version.organization_id = target_organization_id
    for update;
  end if;

  select result.* into strict changed
  from vortex_access.change_account_state_without_stewardship_internal(
      p_organization_account_id, p_expected_revision, p_state
    ) as result;

  perform vortex_access.assert_organization_has_permanent_steward(
    changed.organization_id
  );

  return query select changed.organization_account_id,
    changed.organization_id, changed.identity_id, changed.display_name,
    changed.state, changed.language, changed.time_zone,
    changed.invitation_id, changed.activated_at, changed.suspended_at,
    changed.closed_at, changed.changed_at, changed.state_changed_at,
    changed.state_changed_by, changed.state_change_correlation_id,
    changed.revision, changed.access_version;
end
$$;

alter function vortex_access.change_organization_account_state(p_organization_account_id uuid, p_expected_revision bigint, p_state text) owner to vortex_owner;

COMMENT ON FUNCTION vortex_access.change_organization_account_state(p_organization_account_id uuid, p_expected_revision bigint, p_state text) IS 'Owner-only account lifecycle mutation guarded by the adopted organisation stewardship invariant.';

REVOKE ALL ON FUNCTION vortex_access.change_organization_account_state(p_organization_account_id uuid, p_expected_revision bigint, p_state text) FROM PUBLIC;

grant execute on function vortex_access.change_organization_account_state(p_organization_account_id uuid, p_expected_revision bigint, p_state text) to postgres;

CREATE OR REPLACE FUNCTION vortex_access.coordinate_application_access_change(p_operation text, p_expected_revision bigint, p_prepared_templates jsonb, p_organization_id uuid, p_application_root_id uuid, p_changed_by uuid, p_correlation_id uuid) RETURNS TABLE(outcome text, operation text, organization_id uuid, application_root_id uuid, registration_state text, registration_revision bigint, access_version bigint, correlation_id uuid)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  changed record;
begin
  select result.* into strict changed
  from vortex_access.coordinate_application_access_without_stewardship_internal(
      p_operation, p_expected_revision, p_prepared_templates,
      p_organization_id, p_application_root_id, p_changed_by,
      p_correlation_id
    ) as result;

  perform vortex_access.assert_organization_has_permanent_steward(
    changed.organization_id
  );

  return query select changed.outcome, changed.operation,
    changed.organization_id, changed.application_root_id,
    changed.registration_state, changed.registration_revision,
    changed.access_version, changed.correlation_id;
end
$$;

alter function vortex_access.coordinate_application_access_change(p_operation text, p_expected_revision bigint, p_prepared_templates jsonb, p_organization_id uuid, p_application_root_id uuid, p_changed_by uuid, p_correlation_id uuid) owner to vortex_owner;

COMMENT ON FUNCTION vortex_access.coordinate_application_access_change(p_operation text, p_expected_revision bigint, p_prepared_templates jsonb, p_organization_id uuid, p_application_root_id uuid, p_changed_by uuid, p_correlation_id uuid) IS 'Owner-only atomic application-access composition guarded by the adopted organisation stewardship invariant.';

REVOKE ALL ON FUNCTION vortex_access.coordinate_application_access_change(p_operation text, p_expected_revision bigint, p_prepared_templates jsonb, p_organization_id uuid, p_application_root_id uuid, p_changed_by uuid, p_correlation_id uuid) FROM PUBLIC;

grant execute on function vortex_access.coordinate_application_access_change(p_operation text, p_expected_revision bigint, p_prepared_templates jsonb, p_organization_id uuid, p_application_root_id uuid, p_changed_by uuid, p_correlation_id uuid) to postgres;

CREATE OR REPLACE FUNCTION vortex_access.coordinate_organization_delegation_authority_change(p_operation text, p_organization_id uuid, p_delegation_authority_id uuid, p_expected_delegation_revision bigint, p_holder_kind text, p_organization_account_id uuid, p_group_id uuid, p_scope_kind text, p_bounded_permissions jsonb, p_starts_at timestamp with time zone, p_expires_at timestamp with time zone, p_changed_by uuid, p_correlation_id uuid) RETURNS TABLE(outcome text, operation text, delegation jsonb, access_version bigint, correlation_id uuid)
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
declare
  changed record;
begin
  select result.* into strict changed
  from vortex_access.coordinate_delegation_change_without_stewardship_internal(
      p_operation, p_organization_id, p_delegation_authority_id,
      p_expected_delegation_revision, p_holder_kind,
      p_organization_account_id, p_group_id, p_scope_kind,
      p_bounded_permissions, p_starts_at,
      p_expires_at, p_changed_by, p_correlation_id
    ) as result;

  perform vortex_access.assert_organization_has_permanent_steward(
    (changed.delegation ->> 'organizationId')::uuid
  );

  return query select changed.outcome, changed.operation,
    changed.delegation, changed.access_version, changed.correlation_id;
end
$$;

alter function vortex_access.coordinate_organization_delegation_authority_change(p_operation text, p_organization_id uuid, p_delegation_authority_id uuid, p_expected_delegation_revision bigint, p_holder_kind text, p_organization_account_id uuid, p_group_id uuid, p_scope_kind text, p_bounded_permissions jsonb, p_starts_at timestamp with time zone, p_expires_at timestamp with time zone, p_changed_by uuid, p_correlation_id uuid) owner to vortex_owner;

REVOKE ALL ON FUNCTION vortex_access.coordinate_organization_delegation_authority_change(p_operation text, p_organization_id uuid, p_delegation_authority_id uuid, p_expected_delegation_revision bigint, p_holder_kind text, p_organization_account_id uuid, p_group_id uuid, p_scope_kind text, p_bounded_permissions jsonb, p_starts_at timestamp with time zone, p_expires_at timestamp with time zone, p_changed_by uuid, p_correlation_id uuid) FROM PUBLIC;

grant execute on function vortex_access.coordinate_organization_delegation_authority_change(p_operation text, p_organization_id uuid, p_delegation_authority_id uuid, p_expected_delegation_revision bigint, p_holder_kind text, p_organization_account_id uuid, p_group_id uuid, p_scope_kind text, p_bounded_permissions jsonb, p_starts_at timestamp with time zone, p_expires_at timestamp with time zone, p_changed_by uuid, p_correlation_id uuid) to postgres;

CREATE OR REPLACE FUNCTION vortex_access.coordinate_organization_role_assignment_change(p_operation text, p_organization_id uuid, p_role_assignment_id uuid, p_expected_assignment_revision bigint, p_role_id uuid, p_expected_role_revision bigint, p_assignee_kind text, p_organization_account_id uuid, p_group_id uuid, p_assignment_kind text, p_starts_at timestamp with time zone, p_expires_at timestamp with time zone, p_changed_by uuid, p_correlation_id uuid) RETURNS TABLE(outcome text, operation text, organization_id uuid, role_assignment_id uuid, role_id uuid, assignee_kind text, organization_account_id uuid, group_id uuid, assignment_kind text, revision bigint, starts_at timestamp with time zone, expires_at timestamp with time zone, state text, granted_by_actor_id uuid, granted_at timestamp with time zone, grant_correlation_id uuid, changed_by_actor_id uuid, changed_at timestamp with time zone, change_correlation_id uuid, revoked_by_actor_id uuid, revoked_at timestamp with time zone, revocation_correlation_id uuid, access_version bigint, correlation_id uuid)
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
declare
  changed record;
begin
  select result.* into strict changed
  from vortex_access.coordinate_assignment_change_without_stewardship_internal(
      p_operation, p_organization_id, p_role_assignment_id,
      p_expected_assignment_revision, p_role_id, p_expected_role_revision,
      p_assignee_kind, p_organization_account_id, p_group_id,
      p_assignment_kind, p_starts_at, p_expires_at, p_changed_by,
      p_correlation_id
    ) as result;

  perform vortex_access.assert_organization_has_permanent_steward(
    changed.organization_id
  );

  return query select changed.outcome, changed.operation,
    changed.organization_id, changed.role_assignment_id, changed.role_id,
    changed.assignee_kind, changed.organization_account_id, changed.group_id,
    changed.assignment_kind, changed.revision, changed.starts_at,
    changed.expires_at, changed.state, changed.granted_by_actor_id,
    changed.granted_at, changed.grant_correlation_id,
    changed.changed_by_actor_id, changed.changed_at,
    changed.change_correlation_id, changed.revoked_by_actor_id,
    changed.revoked_at, changed.revocation_correlation_id,
    changed.access_version, changed.correlation_id;
end
$$;

alter function vortex_access.coordinate_organization_role_assignment_change(p_operation text, p_organization_id uuid, p_role_assignment_id uuid, p_expected_assignment_revision bigint, p_role_id uuid, p_expected_role_revision bigint, p_assignee_kind text, p_organization_account_id uuid, p_group_id uuid, p_assignment_kind text, p_starts_at timestamp with time zone, p_expires_at timestamp with time zone, p_changed_by uuid, p_correlation_id uuid) owner to vortex_owner;

REVOKE ALL ON FUNCTION vortex_access.coordinate_organization_role_assignment_change(p_operation text, p_organization_id uuid, p_role_assignment_id uuid, p_expected_assignment_revision bigint, p_role_id uuid, p_expected_role_revision bigint, p_assignee_kind text, p_organization_account_id uuid, p_group_id uuid, p_assignment_kind text, p_starts_at timestamp with time zone, p_expires_at timestamp with time zone, p_changed_by uuid, p_correlation_id uuid) FROM PUBLIC;

grant execute on function vortex_access.coordinate_organization_role_assignment_change(p_operation text, p_organization_id uuid, p_role_assignment_id uuid, p_expected_assignment_revision bigint, p_role_id uuid, p_expected_role_revision bigint, p_assignee_kind text, p_organization_account_id uuid, p_group_id uuid, p_assignment_kind text, p_starts_at timestamp with time zone, p_expires_at timestamp with time zone, p_changed_by uuid, p_correlation_id uuid) to postgres;

CREATE OR REPLACE FUNCTION vortex_access.coordinate_organization_role_change(p_evidence jsonb, p_changed_by uuid, p_correlation_id uuid) RETURNS TABLE(outcome text, operation text, role jsonb, created_activation_policy jsonb, access_version bigint, correlation_id uuid)
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
declare
  changed record;
begin
  select result.* into strict changed
  from vortex_access.coordinate_role_change_without_stewardship_internal(
      p_evidence, p_changed_by, p_correlation_id
    ) as result;

  perform vortex_access.assert_organization_has_permanent_steward(
    (changed.role ->> 'organizationId')::uuid
  );

  return query select changed.outcome, changed.operation, changed.role,
    changed.created_activation_policy, changed.access_version,
    changed.correlation_id;
end
$$;

alter function vortex_access.coordinate_organization_role_change(p_evidence jsonb, p_changed_by uuid, p_correlation_id uuid) owner to vortex_owner;

REVOKE ALL ON FUNCTION vortex_access.coordinate_organization_role_change(p_evidence jsonb, p_changed_by uuid, p_correlation_id uuid) FROM PUBLIC;

grant execute on function vortex_access.coordinate_organization_role_change(p_evidence jsonb, p_changed_by uuid, p_correlation_id uuid) to postgres;

drop function vortex_access.apply_application_permission_registration_v1_internal(text,bigint,jsonb,uuid,uuid);
drop function vortex_access.change_account_state_without_stewardship_v1_internal(uuid,bigint,text);
drop function vortex_access.coordinate_application_access_without_stewardship_v1_internal(text,bigint,jsonb,uuid,uuid,uuid,uuid);
drop function vortex_access.coordinate_assignment_change_without_stewardship_v1_internal(text,uuid,uuid,bigint,uuid,bigint,text,uuid,uuid,text,timestamp with time zone,timestamp with time zone,uuid,uuid);
drop function vortex_access.coordinate_delegation_change_without_stewardship_v1_internal(text,uuid,uuid,bigint,text,uuid,uuid,text,jsonb,timestamp with time zone,timestamp with time zone,uuid,uuid);
drop function vortex_access.coordinate_role_change_without_stewardship_v1_internal(jsonb,uuid,uuid);
drop function vortex_access.withdraw_application_permission_registration_v1_internal(uuid,uuid,bigint,uuid,uuid);
drop function vortex_definition.expire_abandoned_preview_installations_internal(integer);
drop function vortex_definition.lock_application_page_adoption_draft_internal(uuid,bigint,bigint);
drop function vortex_definition.remove_abandoned_runtime_bundles_internal(integer);
drop function vortex_definition.remove_installation_runtime_bundles_internal(uuid);
drop function vortex_definition.write_installation_runtime_bundle_internal(uuid,bigint,integer,text,jsonb);
drop function vortex_platform.claim_abandoned_file_uploads_internal(integer,text);
drop function vortex_platform.finish_abandoned_file_upload_internal(uuid,uuid);
drop function vortex_record.drop_retired_preview_storage_internal(uuid);
drop function vortex_record.read_retired_preview_storage_internal(integer);

reset role;
