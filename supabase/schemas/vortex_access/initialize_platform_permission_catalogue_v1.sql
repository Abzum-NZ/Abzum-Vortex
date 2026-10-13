CREATE FUNCTION vortex_access.initialize_platform_permission_catalogue_v1(p_organization_id uuid, p_changed_by uuid, p_correlation_id uuid) RETURNS TABLE(organization_id uuid, registration_revision bigint, access_version bigint)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $_$
declare
  operation_at timestamptz := pg_catalog.statement_timestamp();
  current_registration vortex_access.permission_registrations%rowtype;
  resulting_version bigint;
  catalogue_fingerprint constant text := 'sha256:a6c3e01332980bc030d1492608853b8905c34fa661682e90ae5fcb23287c4930';
  catalogue_entries constant jsonb := $catalogue$[
    {"permissionId":"687d5649-62ee-43dd-b684-b8af3a5394c1","key":"platform.organization.permissions.read","label":"View available permissions","description":"View the selected organisation's registered permission catalogue without receiving use or assignment authority.","actionKind":"read","meaningFingerprint":"sha256:be47b7066dd31f8797452f035cadcb18ef6ead6ff06bec6d3ec54ff769812567"},
    {"permissionId":"ca5f56d4-5382-4bf8-9a91-fbfdc77642b2","key":"platform.organization.roles.read","label":"View roles","description":"View the selected organisation's live roles and registered application role templates.","actionKind":"read","meaningFingerprint":"sha256:87c065a43a5dc6676c3276aea10d4ad848665c07a39393dae237e72d6582367b"},
    {"permissionId":"87c96495-c806-4692-9bc2-250ddb10613c","key":"platform.organization.roles.manage","label":"Manage roles","description":"Create, change or retire roles only within the actor's explicit delegated scope.","actionKind":"manage","meaningFingerprint":"sha256:91eb8281f4905ef55dbe5acf537d49febeede8df37aeaf2ff69292107a59ae2b"},
    {"permissionId":"290ae49f-4cab-4159-9c20-6e664f07d50b","key":"platform.organization.groups.read","label":"View teams","description":"View the selected organisation's Teams and membership administration data.","actionKind":"read","meaningFingerprint":"sha256:cfb428fda5934cc18c54bc71bcbb4b6e7038714550587b189df0a3c0a3e44f8a"},
    {"permissionId":"6185dc64-464b-4776-97dc-c64a6f299550","key":"platform.organization.groups.manage","label":"Manage teams","description":"Manage Teams and memberships subject to delegated scope and permanent-steward safeguards.","actionKind":"manage","meaningFingerprint":"sha256:a44b20bb994a4519ca283fbd7cc933b7dbba7f7c6c4c0e036492cb84f432b22e"},
    {"permissionId":"9901c0dc-8bac-45c7-be0b-3642cb839bb1","key":"platform.organization.assignments.read","label":"View access assignments","description":"View the selected organisation's role and delegation assignments and their effective scope.","actionKind":"read","meaningFingerprint":"sha256:e46f5f2b4e9dcf77e6f96918828c7421044605b35216c5eecc0e29909c9a6848"},
    {"permissionId":"156d01f3-8f80-45fb-8fc8-b31c47dbb1df","key":"platform.organization.assignments.manage","label":"Manage access assignments","description":"Grant, change or revoke use and delegation assignments only within the actor's explicit delegated scope.","actionKind":"manage","meaningFingerprint":"sha256:9c2cf2b688335a1c3edf32d397c7a9e611743736680e30c3672dfaf11c7a9f36"},
    {"permissionId":"02c772e5-2921-4300-ad90-4f5772a7fa46","key":"platform.organization.accounts.read","label":"View organisation accounts","description":"View the selected organisation's safe account-administration information.","actionKind":"read","meaningFingerprint":"sha256:51234f517c9a62379cecc8ef047c3b5266096381dbc58e77d8a889fc3be32641"},
    {"permissionId":"630a980c-0ff5-40b1-a329-7326a2122395","key":"platform.organization.accounts.manage","label":"Manage organisation accounts","description":"Change organisation-account lifecycle through the protected operation without changing global identity or removing the final permanent steward.","actionKind":"manage","meaningFingerprint":"sha256:59439415b18b92167020f82086693b45cd238c9c4b8ac6fdd3ce071bc6d5b9e0"},
    {"permissionId":"9300e501-6d56-41b1-b203-3361dbace9bc","key":"platform.organization.invitations.read","label":"View invitations","description":"View safe invitation administration metadata without the raw invitation secret or its stored fingerprint.","actionKind":"read","meaningFingerprint":"sha256:b4462ee4471b7c93d820caef5690a31f7e7be4070e3ba8b7e83fe2e68b024cd8"},
    {"permissionId":"c2e03f58-debe-478e-b1e0-a4a8b8f1b9cb","key":"platform.organization.invitations.manage","label":"Manage invitations","description":"Create or revoke invitations through the protected operation; role assignment additionally requires the actor's assignment authority.","actionKind":"manage","meaningFingerprint":"sha256:65b1804f9f5148adfb06d50ac16243b9711cab368b8c9950ff935e2e89a69154"},
    {"permissionId":"6dffcb0b-ded8-4cd5-acc8-c50f7d4269a5","key":"platform.organization.runtime_settings.read","label":"View organisation display settings","description":"View the organisation's default language, time zone, currency, date and number display settings.","actionKind":"read","meaningFingerprint":"sha256:cba574ab17eff487cc68f32e8ce013eea83570060f17f73b02e91764f665120a"},
    {"permissionId":"c658c254-2884-414a-9012-512c0cfe4b34","key":"platform.organization.runtime_settings.manage","label":"Manage organisation display settings","description":"Change the organisation's validated default display settings through the protected revision-checked operation.","actionKind":"manage","meaningFingerprint":"sha256:e79914b57f2c0b37bb07698bee58dc8557762020d3f082e19a4ceb8304b8e4f7"}
  ]$catalogue$::jsonb;
begin
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
    and registration.registration_owner_id = 'cabe121e-0baf-4084-9471-cce915d460a8'::uuid;

  if found then
    if current_registration.state <> 'active'
      or current_registration.revision <> 1
      or current_registration.source_version <> '1.0.0'
      or current_registration.permission_catalogue_fingerprint <> catalogue_fingerprint
      or current_registration.candidate_fingerprint <> catalogue_fingerprint then
      raise exception using errcode = '55000', message = 'Platform permission registration evidence is invalid';
    end if;
    return query
    select current_registration.organization_id, current_registration.revision,
      version.current_version
    from vortex_access.organization_access_versions as version
    where version.organization_id = p_organization_id;
    return;
  end if;

  insert into vortex_access.permission_registration_revisions (
    organization_id, registration_kind, registration_owner_id, revision, state, operation,
    source_definition_key, source_version, source_revision, validation_contract_version,
    source_content_fingerprint, source_resolution_fingerprint,
    permission_catalogue_fingerprint, candidate_fingerprint,
    changed_at, changed_by, change_correlation_id
  ) values (
    p_organization_id, 'platform', 'cabe121e-0baf-4084-9471-cce915d460a8', 1,
    'active', 'platform_initialize', null, '1.0.0', null, null, null, null,
    catalogue_fingerprint, catalogue_fingerprint, operation_at, p_changed_by, p_correlation_id
  );

  insert into vortex_access.permission_catalogue_entries (
    organization_id, registration_kind, registration_owner_id, registration_revision,
    application_root_id, owner_kind, owner_id, permission_id, permission_key,
    label, description, record_type_id, action_kind, named_action, administrative,
    source_kind, source_definition_key, source_root_id, source_version, source_revision,
    source_validation_contract_version, source_content_fingerprint,
    source_resolution_fingerprint, source_catalogue_fingerprint, meaning_fingerprint
  )
  select p_organization_id, 'platform', 'cabe121e-0baf-4084-9471-cce915d460a8', 1,
    null, 'platform', 'cabe121e-0baf-4084-9471-cce915d460a8',
    (entry ->> 'permissionId')::uuid, entry ->> 'key', entry ->> 'label',
    entry ->> 'description', null, entry ->> 'actionKind', null, true,
    'platform_catalogue', null, null, '1.0.0', null, null, null, null,
    catalogue_fingerprint, entry ->> 'meaningFingerprint'
  from pg_catalog.jsonb_array_elements(catalogue_entries) as item(entry);

  insert into vortex_access.permission_registrations (
    organization_id, registration_kind, registration_owner_id, state, revision,
    source_definition_key, source_version, source_revision, validation_contract_version,
    source_content_fingerprint, source_resolution_fingerprint,
    permission_catalogue_fingerprint, candidate_fingerprint,
    changed_at, changed_by, change_correlation_id
  ) values (
    p_organization_id, 'platform', 'cabe121e-0baf-4084-9471-cce915d460a8', 'active', 1,
    null, '1.0.0', null, null, null, null, catalogue_fingerprint, catalogue_fingerprint,
    operation_at, p_changed_by, p_correlation_id
  );

  select incremented.current_version into resulting_version
  from vortex_access.increment_organization_access_version(
    p_organization_id, p_changed_by, p_correlation_id, 'application_access_changed'
  ) as incremented;
  return query select p_organization_id, 1::bigint, resulting_version;
end
$_$;

ALTER FUNCTION vortex_access.initialize_platform_permission_catalogue_v1(p_organization_id uuid, p_changed_by uuid, p_correlation_id uuid) OWNER TO postgres;

COMMENT ON FUNCTION vortex_access.initialize_platform_permission_catalogue_v1(p_organization_id uuid, p_changed_by uuid, p_correlation_id uuid) IS 'Owner-only exact historical 1.0.0 platform catalogue initializer retained for compatibility.';

REVOKE ALL ON FUNCTION vortex_access.initialize_platform_permission_catalogue_v1(p_organization_id uuid, p_changed_by uuid, p_correlation_id uuid) FROM PUBLIC;
