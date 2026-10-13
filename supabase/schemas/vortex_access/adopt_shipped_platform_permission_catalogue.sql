CREATE OR REPLACE FUNCTION vortex_access.adopt_shipped_platform_permission_catalogue(p_organization_id uuid, p_expected_registration_revision bigint, p_target_catalogue_version text, p_target_catalogue_fingerprint text, p_changed_by uuid, p_correlation_id uuid) RETURNS TABLE(organization_id uuid, source_catalogue_version text, target_catalogue_version text, registration_revision bigint, access_version bigint)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $_$
declare
  operation_at timestamptz := pg_catalog.statement_timestamp();
  current_registration vortex_access.permission_registrations%rowtype;
  resulting_version bigint;
  transitioned_continuity_count bigint;
  inserted_continuity_count bigint;
  -- guard-allow: function-uuid fixed platform permission identity without declaration-table read access
  platform_owner_id constant uuid := 'cabe121e-0baf-4084-9471-cce915d460a8';
  catalogue_fingerprint constant text :=
    'sha256:57453282c9a853912b2b67baeefaca81e21d076761d200ac812a7573d7dc7c9c';
  catalogue_entries constant jsonb := pg_catalog.jsonb_build_array(
    pg_catalog.jsonb_build_object(
      -- guard-allow: function-uuid fixed platform permission identity without declaration-table read access
      'permissionId', '687d5649-62ee-43dd-b684-b8af3a5394c1',
      'key', 'platform.organization.permissions.read',
      'label', 'View available permissions',
      'description', 'View the selected organisation''s registered permission catalogue without receiving use or assignment authority.',
      'actionKind', 'read',
      'meaningFingerprint', 'sha256:be47b7066dd31f8797452f035cadcb18ef6ead6ff06bec6d3ec54ff769812567'
    ),
    pg_catalog.jsonb_build_object(
      -- guard-allow: function-uuid fixed platform permission identity without declaration-table read access
      'permissionId', 'ca5f56d4-5382-4bf8-9a91-fbfdc77642b2',
      'key', 'platform.organization.roles.read',
      'label', 'View roles',
      'description', 'View the selected organisation''s live roles and registered application role templates.',
      'actionKind', 'read',
      'meaningFingerprint', 'sha256:87c065a43a5dc6676c3276aea10d4ad848665c07a39393dae237e72d6582367b'
    ),
    pg_catalog.jsonb_build_object(
      -- guard-allow: function-uuid fixed platform permission identity without declaration-table read access
      'permissionId', '87c96495-c806-4692-9bc2-250ddb10613c',
      'key', 'platform.organization.roles.manage',
      'label', 'Manage roles',
      'description', 'Create, change or retire roles only within the actor''s explicit delegated scope.',
      'actionKind', 'manage',
      'meaningFingerprint', 'sha256:91eb8281f4905ef55dbe5acf537d49febeede8df37aeaf2ff69292107a59ae2b'
    ),
    pg_catalog.jsonb_build_object(
      -- guard-allow: function-uuid fixed platform permission identity without declaration-table read access
      'permissionId', '290ae49f-4cab-4159-9c20-6e664f07d50b',
      'key', 'platform.organization.groups.read',
      'label', 'View groups',
      'description', 'View the selected organisation''s Groups and membership administration data.',
      'actionKind', 'read',
      'meaningFingerprint', 'sha256:cfb428fda5934cc18c54bc71bcbb4b6e7038714550587b189df0a3c0a3e44f8a'
    ),
    pg_catalog.jsonb_build_object(
      -- guard-allow: function-uuid fixed platform permission identity without declaration-table read access
      'permissionId', '6185dc64-464b-4776-97dc-c64a6f299550',
      'key', 'platform.organization.groups.manage',
      'label', 'Manage groups',
      'description', 'Manage Groups and memberships subject to delegated scope and permanent-steward safeguards.',
      'actionKind', 'manage',
      'meaningFingerprint', 'sha256:a44b20bb994a4519ca283fbd7cc933b7dbba7f7c6c4c0e036492cb84f432b22e'
    ),
    pg_catalog.jsonb_build_object(
      -- guard-allow: function-uuid fixed platform permission identity without declaration-table read access
      'permissionId', '9901c0dc-8bac-45c7-be0b-3642cb839bb1',
      'key', 'platform.organization.assignments.read',
      'label', 'View access assignments',
      'description', 'View the selected organisation''s role and delegation assignments and their effective scope.',
      'actionKind', 'read',
      'meaningFingerprint', 'sha256:e46f5f2b4e9dcf77e6f96918828c7421044605b35216c5eecc0e29909c9a6848'
    ),
    pg_catalog.jsonb_build_object(
      -- guard-allow: function-uuid fixed platform permission identity without declaration-table read access
      'permissionId', '156d01f3-8f80-45fb-8fc8-b31c47dbb1df',
      'key', 'platform.organization.assignments.manage',
      'label', 'Manage access assignments',
      'description', 'Grant, change or revoke use and delegation assignments only within the actor''s explicit delegated scope.',
      'actionKind', 'manage',
      'meaningFingerprint', 'sha256:9c2cf2b688335a1c3edf32d397c7a9e611743736680e30c3672dfaf11c7a9f36'
    ),
    pg_catalog.jsonb_build_object(
      -- guard-allow: function-uuid fixed platform permission identity without declaration-table read access
      'permissionId', '02c772e5-2921-4300-ad90-4f5772a7fa46',
      'key', 'platform.organization.accounts.read',
      'label', 'View organisation accounts',
      'description', 'View the selected organisation''s safe account-administration information.',
      'actionKind', 'read',
      'meaningFingerprint', 'sha256:51234f517c9a62379cecc8ef047c3b5266096381dbc58e77d8a889fc3be32641'
    ),
    pg_catalog.jsonb_build_object(
      -- guard-allow: function-uuid fixed platform permission identity without declaration-table read access
      'permissionId', '630a980c-0ff5-40b1-a329-7326a2122395',
      'key', 'platform.organization.accounts.manage',
      'label', 'Manage organisation accounts',
      'description', 'Change organisation-account lifecycle through the protected operation without changing global identity or removing the final permanent steward.',
      'actionKind', 'manage',
      'meaningFingerprint', 'sha256:59439415b18b92167020f82086693b45cd238c9c4b8ac6fdd3ce071bc6d5b9e0'
    ),
    pg_catalog.jsonb_build_object(
      -- guard-allow: function-uuid fixed platform permission identity without declaration-table read access
      'permissionId', '9300e501-6d56-41b1-b203-3361dbace9bc',
      'key', 'platform.organization.invitations.read',
      'label', 'View invitations',
      'description', 'View safe invitation administration metadata without the raw invitation secret or its stored fingerprint.',
      'actionKind', 'read',
      'meaningFingerprint', 'sha256:b4462ee4471b7c93d820caef5690a31f7e7be4070e3ba8b7e83fe2e68b024cd8'
    ),
    pg_catalog.jsonb_build_object(
      -- guard-allow: function-uuid fixed platform permission identity without declaration-table read access
      'permissionId', 'c2e03f58-debe-478e-b1e0-a4a8b8f1b9cb',
      'key', 'platform.organization.invitations.manage',
      'label', 'Manage invitations',
      'description', 'Create or revoke invitations through the protected operation; role assignment additionally requires the actor''s assignment authority.',
      'actionKind', 'manage',
      'meaningFingerprint', 'sha256:65b1804f9f5148adfb06d50ac16243b9711cab368b8c9950ff935e2e89a69154'
    ),
    pg_catalog.jsonb_build_object(
      -- guard-allow: function-uuid fixed platform permission identity without declaration-table read access
      'permissionId', '6dffcb0b-ded8-4cd5-acc8-c50f7d4269a5',
      'key', 'platform.organization.runtime_settings.read',
      'label', 'View organisation display settings',
      'description', 'View the organisation''s default language, time zone, currency, date and number display settings.',
      'actionKind', 'read',
      'meaningFingerprint', 'sha256:cba574ab17eff487cc68f32e8ce013eea83570060f17f73b02e91764f665120a'
    ),
    pg_catalog.jsonb_build_object(
      -- guard-allow: function-uuid fixed platform permission identity without declaration-table read access
      'permissionId', 'c658c254-2884-414a-9012-512c0cfe4b34',
      'key', 'platform.organization.runtime_settings.manage',
      'label', 'Manage organisation display settings',
      'description', 'Change the organisation''s validated default display settings through the protected revision-checked operation.',
      'actionKind', 'manage',
      'meaningFingerprint', 'sha256:e79914b57f2c0b37bb07698bee58dc8557762020d3f082e19a4ceb8304b8e4f7'
    ),
    pg_catalog.jsonb_build_object(
      -- guard-allow: function-uuid fixed platform permission identity without declaration-table read access
      'permissionId', '7ecd3304-f16c-47d4-94db-0964980091ba',
      'key', 'platform.organization.applications.manage',
      'label', 'Manage applications',
      'description', 'Install, upgrade or detach exact application bindings in the selected organisation without receiving business-record use or role-assignment authority.',
      'actionKind', 'manage',
      'meaningFingerprint', 'sha256:f3c8f4195e1d61f27a1cc65b82f6aa46ac45629195f3a8ea125925c7f12f3f81'
    )
  );
begin
  if p_organization_id is null
    or p_organization_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_expected_registration_revision is distinct from 2
    or p_target_catalogue_version is distinct from '1.1.0'
    or p_target_catalogue_fingerprint is distinct from catalogue_fingerprint
    or p_changed_by is null
    or p_changed_by = '00000000-0000-0000-0000-000000000000'::uuid
    or p_correlation_id is null
    or p_correlation_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using errcode = '22023', message = 'Shipped platform catalogue adoption input is invalid';
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
    raise exception using errcode = '42501', message = 'Shipped platform catalogue adoption scope is unavailable';
  end if;

  select registration.* into current_registration
  from vortex_access.permission_registrations as registration
  where registration.organization_id = p_organization_id
    and registration.registration_kind = 'platform'
    and registration.registration_owner_id = platform_owner_id
  for update;

  if found and current_registration.revision = 3 then
    if not vortex_access.platform_permission_catalogue_revision_is_exact(p_organization_id, 3)
      or current_registration.source_version is distinct from p_target_catalogue_version
      or current_registration.permission_catalogue_fingerprint is distinct from p_target_catalogue_fingerprint
      or (
        select pg_catalog.count(*)
        from vortex_access.permission_continuities as continuity
        where continuity.organization_id = p_organization_id
          and continuity.application_root_id is null
          and continuity.registration_kind = 'platform'
          and continuity.registration_owner_id = platform_owner_id
      ) <> 14
      or exists (
        select 1
        from vortex_access.permission_catalogue_entries as entry
        left join vortex_access.permission_continuities as continuity
          on continuity.organization_id = entry.organization_id
          and continuity.application_root_id is null
          and continuity.owner_kind = entry.owner_kind
          and continuity.owner_id = entry.owner_id
          and continuity.permission_id = entry.permission_id
          and continuity.registration_kind = entry.registration_kind
          and continuity.registration_owner_id = entry.registration_owner_id
          and continuity.state = 'available'
          and continuity.meaning_fingerprint = entry.meaning_fingerprint
          and continuity.last_processed_registration_revision = entry.registration_revision
        where entry.organization_id = p_organization_id
          and entry.registration_kind = 'platform'
          and entry.registration_owner_id = platform_owner_id
          and entry.registration_revision = 3
          and continuity.permission_id is null
      ) then
      raise exception using errcode = '55000', message = 'Shipped platform catalogue target evidence is invalid';
    end if;
    perform vortex_access.assert_organization_has_permanent_steward(p_organization_id);
    return query select p_organization_id, '1.0.1'::text, '1.1.0'::text, 3::bigint,
      version.current_version
    from vortex_access.organization_access_versions as version
    where version.organization_id = p_organization_id;
    return;
  end if;

  if not found
    or current_registration.revision <> p_expected_registration_revision
    or not vortex_access.platform_permission_catalogue_revision_is_exact_v1_0_1(
      p_organization_id, p_expected_registration_revision
    ) then
    raise exception using errcode = '55000', message = 'Shipped platform catalogue source evidence is invalid';
  end if;

  perform 1
  from vortex_access.permission_continuities as continuity
  where continuity.organization_id = p_organization_id
    and continuity.application_root_id is null
    and continuity.registration_kind = 'platform'
    and continuity.registration_owner_id = platform_owner_id
  order by continuity.owner_kind collate "C", continuity.owner_id,
    continuity.permission_id
  for update;

  if not vortex_access.organization_has_permanent_steward(
      p_organization_id, pg_catalog.clock_timestamp()
    )
    or (
      select pg_catalog.count(*)
      from vortex_access.permission_continuities as continuity
      where continuity.organization_id = p_organization_id
        and continuity.application_root_id is null
        and continuity.registration_kind = 'platform'
        and continuity.registration_owner_id = platform_owner_id
    ) <> 13
    or exists (
      select 1
      from vortex_access.permission_continuities as continuity
      left join vortex_access.permission_catalogue_entries as entry
        on entry.organization_id = continuity.organization_id
        and entry.registration_kind = continuity.registration_kind
        and entry.registration_owner_id = continuity.registration_owner_id
        and entry.registration_revision = p_expected_registration_revision
        and entry.application_root_id is null
        and entry.owner_kind = continuity.owner_kind
        and entry.owner_id = continuity.owner_id
        and entry.permission_id = continuity.permission_id
        and entry.meaning_fingerprint = continuity.meaning_fingerprint
      where continuity.organization_id = p_organization_id
        and continuity.application_root_id is null
        and continuity.registration_kind = 'platform'
        and continuity.registration_owner_id = platform_owner_id
        and (
          continuity.state <> 'available'
          or continuity.last_processed_registration_revision <>
            p_expected_registration_revision
          or entry.permission_id is null
        )
    ) then
    raise exception using errcode = '55000',
      message = 'Shipped platform catalogue continuity evidence is invalid';
  end if;

  insert into vortex_access.permission_registration_revisions (
    organization_id, registration_kind, registration_owner_id, revision, state, operation, source_definition_key, source_version, source_revision, validation_contract_version, permission_catalogue_fingerprint, candidate_fingerprint, changed_at, changed_by, change_correlation_id
  ) values (
    p_organization_id, 'platform', platform_owner_id, 3, 'active', 'platform_metadata_revision', null, p_target_catalogue_version, null, null, catalogue_fingerprint, catalogue_fingerprint, operation_at, p_changed_by, p_correlation_id
  );

  insert into vortex_access.permission_catalogue_entries (
    organization_id, registration_kind, registration_owner_id, registration_revision,
    application_root_id, owner_kind, owner_id, permission_id, permission_key,
    label, description, record_type_id, action_kind, named_action, administrative,
    source_kind, source_definition_key, source_root_id, source_version, source_revision,
    source_validation_contract_version, source_content_fingerprint,
    source_resolution_fingerprint, source_catalogue_fingerprint, meaning_fingerprint
  )
  select p_organization_id, 'platform', platform_owner_id, 3, null, 'platform',
    platform_owner_id, (entry ->> 'permissionId')::uuid, entry ->> 'key',
    entry ->> 'label', entry ->> 'description', null, entry ->> 'actionKind', null, true,
    'platform_catalogue', null, null, p_target_catalogue_version, null, null, null, null,
    catalogue_fingerprint, entry ->> 'meaningFingerprint'
  from pg_catalog.jsonb_array_elements(catalogue_entries) as item(entry);

  update vortex_access.permission_continuities as continuity
  set last_processed_registration_revision = 3,
      changed_at = operation_at
  from vortex_access.permission_catalogue_entries as entry
  where entry.organization_id = p_organization_id
    and entry.registration_kind = 'platform'
    and entry.registration_owner_id = platform_owner_id
    and entry.registration_revision = 3
    -- guard-allow: function-uuid fixed platform permission identity without declaration-table read access
    and entry.permission_id <> '7ecd3304-f16c-47d4-94db-0964980091ba'::uuid
    and continuity.organization_id = entry.organization_id
    and continuity.application_root_id is null
    and continuity.owner_kind = entry.owner_kind
    and continuity.owner_id = entry.owner_id
    and continuity.permission_id = entry.permission_id
    and continuity.registration_kind = entry.registration_kind
    and continuity.registration_owner_id = entry.registration_owner_id
    and continuity.state = 'available'
    and continuity.meaning_fingerprint = entry.meaning_fingerprint
    and continuity.last_processed_registration_revision =
      p_expected_registration_revision;
  get diagnostics transitioned_continuity_count = row_count;
  if transitioned_continuity_count <> 13 then
    raise exception using errcode = '55000',
      message = 'Shipped platform catalogue continuity transition is incomplete';
  end if;

  insert into vortex_access.permission_continuities (
    organization_id, application_root_id, owner_kind, owner_id,
    permission_id, registration_kind, registration_owner_id, state,
    continuity_revision, meaning_fingerprint,
    last_processed_registration_revision, changed_at
  )
  select entry.organization_id, null, entry.owner_kind, entry.owner_id,
    entry.permission_id, entry.registration_kind, entry.registration_owner_id,
    'available', 1, entry.meaning_fingerprint, entry.registration_revision,
    operation_at
  from vortex_access.permission_catalogue_entries as entry
  where entry.organization_id = p_organization_id
    and entry.registration_kind = 'platform'
    and entry.registration_owner_id = platform_owner_id
    and entry.registration_revision = 3
    -- guard-allow: function-uuid fixed platform permission identity without declaration-table read access
    and entry.permission_id = '7ecd3304-f16c-47d4-94db-0964980091ba'::uuid;
  get diagnostics inserted_continuity_count = row_count;
  if inserted_continuity_count <> 1 then
    raise exception using errcode = '55000',
      message = 'Shipped platform catalogue additive continuity is incomplete';
  end if;

  update vortex_access.permission_registrations as registration
  set revision = 3,
      source_version = p_target_catalogue_version,
      permission_catalogue_fingerprint = catalogue_fingerprint,
      candidate_fingerprint = catalogue_fingerprint,
      changed_at = operation_at,
      changed_by = p_changed_by,
      change_correlation_id = p_correlation_id
  where registration.organization_id = p_organization_id
    and registration.registration_kind = 'platform'
    and registration.registration_owner_id = platform_owner_id
    and registration.revision = p_expected_registration_revision;
  if not found then
    raise exception using errcode = '40001', message = 'Platform catalogue source changed';
  end if;

  perform vortex_access.assert_organization_has_permanent_steward(p_organization_id);

  select incremented.current_version into resulting_version
  from vortex_access.increment_organization_access_version(
    p_organization_id, p_changed_by, p_correlation_id, 'application_access_changed'
  ) as incremented;

  return query select p_organization_id, '1.0.1'::text, '1.1.0'::text,
    3::bigint, resulting_version;
end
$_$;

alter function vortex_access.adopt_shipped_platform_permission_catalogue(p_organization_id uuid, p_expected_registration_revision bigint, p_target_catalogue_version text, p_target_catalogue_fingerprint text, p_changed_by uuid, p_correlation_id uuid) owner to vortex_owner;

COMMENT ON FUNCTION vortex_access.adopt_shipped_platform_permission_catalogue(p_organization_id uuid, p_expected_registration_revision bigint, p_target_catalogue_version text, p_target_catalogue_fingerprint text, p_changed_by uuid, p_correlation_id uuid) IS 'Owner-only adoption of one compiled-in shipped platform catalogue successor.';

REVOKE ALL ON FUNCTION vortex_access.adopt_shipped_platform_permission_catalogue(p_organization_id uuid, p_expected_registration_revision bigint, p_target_catalogue_version text, p_target_catalogue_fingerprint text, p_changed_by uuid, p_correlation_id uuid) FROM PUBLIC;

grant execute on function vortex_access.adopt_shipped_platform_permission_catalogue(p_organization_id uuid, p_expected_registration_revision bigint, p_target_catalogue_version text, p_target_catalogue_fingerprint text, p_changed_by uuid, p_correlation_id uuid) to postgres;
