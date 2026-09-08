-- Adopt known platform permission catalogue successors without accepting caller-authored entries.

alter function vortex_access.platform_permission_catalogue_revision_is_exact(uuid, bigint)
  rename to platform_permission_catalogue_revision_is_exact_v1_0_1;

create function vortex_access.platform_permission_catalogue_revision_is_exact(
  p_organization_id uuid,
  p_registration_revision bigint
)
returns boolean
language plpgsql
stable
security invoker
set search_path = ''
as $function$
declare
  platform_owner_id constant uuid := 'cabe121e-0baf-4084-9471-cce915d460a8';
  catalogue_fingerprint constant text :=
    'sha256:cb42d4b24ebead7fe9e4ba6358115ceb3ae752d3a0b4cbedc458dcb218013778';
  catalogue_entries constant jsonb := $catalogue$[
    {"permissionId":"687d5649-62ee-43dd-b684-b8af3a5394c1","key":"platform.organization.permissions.read","label":"View available permissions","description":"View the selected organisation's registered permission catalogue without receiving use or assignment authority.","actionKind":"read","meaningFingerprint":"sha256:be47b7066dd31f8797452f035cadcb18ef6ead6ff06bec6d3ec54ff769812567"},
    {"permissionId":"ca5f56d4-5382-4bf8-9a91-fbfdc77642b2","key":"platform.organization.roles.read","label":"View roles","description":"View the selected organisation's live roles and registered application role templates.","actionKind":"read","meaningFingerprint":"sha256:87c065a43a5dc6676c3276aea10d4ad848665c07a39393dae237e72d6582367b"},
    {"permissionId":"87c96495-c806-4692-9bc2-250ddb10613c","key":"platform.organization.roles.manage","label":"Manage roles","description":"Create, change or retire roles only within the actor's explicit delegated scope.","actionKind":"manage","meaningFingerprint":"sha256:91eb8281f4905ef55dbe5acf537d49febeede8df37aeaf2ff69292107a59ae2b"},
    {"permissionId":"290ae49f-4cab-4159-9c20-6e664f07d50b","key":"platform.organization.teams.read","label":"View groups","description":"View the selected organisation's Groups and membership administration data.","actionKind":"read","meaningFingerprint":"sha256:b91f3b608e3a1f7426040b0e947727726f1eab888eb2bb5a87f613bd266ebb2f"},
    {"permissionId":"6185dc64-464b-4776-97dc-c64a6f299550","key":"platform.organization.teams.manage","label":"Manage groups","description":"Manage Groups and memberships subject to delegated scope and permanent-steward safeguards.","actionKind":"manage","meaningFingerprint":"sha256:094f5e4fe28756a9497a33b357f6bd9fa7283fe0e53ada77b5b6894bcebff4a5"},
    {"permissionId":"9901c0dc-8bac-45c7-be0b-3642cb839bb1","key":"platform.organization.assignments.read","label":"View access assignments","description":"View the selected organisation's role and delegation assignments and their effective scope.","actionKind":"read","meaningFingerprint":"sha256:e46f5f2b4e9dcf77e6f96918828c7421044605b35216c5eecc0e29909c9a6848"},
    {"permissionId":"156d01f3-8f80-45fb-8fc8-b31c47dbb1df","key":"platform.organization.assignments.manage","label":"Manage access assignments","description":"Grant, change or revoke use and delegation assignments only within the actor's explicit delegated scope.","actionKind":"manage","meaningFingerprint":"sha256:9c2cf2b688335a1c3edf32d397c7a9e611743736680e30c3672dfaf11c7a9f36"},
    {"permissionId":"02c772e5-2921-4300-ad90-4f5772a7fa46","key":"platform.organization.accounts.read","label":"View organisation accounts","description":"View the selected organisation's safe account-administration information.","actionKind":"read","meaningFingerprint":"sha256:51234f517c9a62379cecc8ef047c3b5266096381dbc58e77d8a889fc3be32641"},
    {"permissionId":"630a980c-0ff5-40b1-a329-7326a2122395","key":"platform.organization.accounts.manage","label":"Manage organisation accounts","description":"Change organisation-account lifecycle through the protected operation without changing global identity or removing the final permanent steward.","actionKind":"manage","meaningFingerprint":"sha256:59439415b18b92167020f82086693b45cd238c9c4b8ac6fdd3ce071bc6d5b9e0"},
    {"permissionId":"9300e501-6d56-41b1-b203-3361dbace9bc","key":"platform.organization.invitations.read","label":"View invitations","description":"View safe invitation administration metadata without the raw invitation secret or its stored fingerprint.","actionKind":"read","meaningFingerprint":"sha256:b4462ee4471b7c93d820caef5690a31f7e7be4070e3ba8b7e83fe2e68b024cd8"},
    {"permissionId":"c2e03f58-debe-478e-b1e0-a4a8b8f1b9cb","key":"platform.organization.invitations.manage","label":"Manage invitations","description":"Create or revoke invitations through the protected operation; role assignment additionally requires the actor's assignment authority.","actionKind":"manage","meaningFingerprint":"sha256:65b1804f9f5148adfb06d50ac16243b9711cab368b8c9950ff935e2e89a69154"},
    {"permissionId":"6dffcb0b-ded8-4cd5-acc8-c50f7d4269a5","key":"platform.organization.runtime_settings.read","label":"View organisation display settings","description":"View the organisation's default language, time zone, currency, date and number display settings.","actionKind":"read","meaningFingerprint":"sha256:cba574ab17eff487cc68f32e8ce013eea83570060f17f73b02e91764f665120a"},
    {"permissionId":"c658c254-2884-414a-9012-512c0cfe4b34","key":"platform.organization.runtime_settings.manage","label":"Manage organisation display settings","description":"Change the organisation's validated default display settings through the protected revision-checked operation.","actionKind":"manage","meaningFingerprint":"sha256:e79914b57f2c0b37bb07698bee58dc8557762020d3f082e19a4ceb8304b8e4f7"},
    {"permissionId":"7ecd3304-f16c-47d4-94db-0964980091ba","key":"platform.organization.applications.manage","label":"Manage applications","description":"Install, upgrade or detach exact application bindings in the selected organisation without receiving business-record use or role-assignment authority.","actionKind":"manage","meaningFingerprint":"sha256:f3c8f4195e1d61f27a1cc65b82f6aa46ac45629195f3a8ea125925c7f12f3f81"}
  ]$catalogue$::jsonb;
  registration_exact boolean;
begin
  if p_registration_revision in (1, 2) then
    return vortex_access.platform_permission_catalogue_revision_is_exact_v1_0_1(
      p_organization_id, p_registration_revision
    );
  end if;
  if p_organization_id is null
    or p_organization_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_registration_revision is distinct from 3 then
    return false;
  end if;

  select pg_catalog.count(*) = 1 into registration_exact
  from vortex_access.permission_registrations as registration
  join vortex_access.permission_registration_revisions as history
    on history.organization_id = registration.organization_id
    and history.registration_kind = registration.registration_kind
    and history.registration_owner_id = registration.registration_owner_id
    and history.revision = registration.revision
  where registration.organization_id = p_organization_id
    and registration.registration_kind = 'platform'
    and registration.registration_owner_id = platform_owner_id
    and registration.state = 'active'
    and registration.revision = 3
    and registration.source_definition_key is null
    and registration.source_version = '1.1.0'
    and registration.source_revision is null
    and registration.validation_contract_version is null
    and registration.source_content_fingerprint is null
    and registration.source_resolution_fingerprint is null
    and registration.permission_catalogue_fingerprint = catalogue_fingerprint
    and registration.candidate_fingerprint = catalogue_fingerprint
    and history.operation = 'platform_metadata_revision'
    and row(
      registration.state, registration.source_definition_key, registration.source_version,
      registration.source_revision, registration.validation_contract_version,
      registration.source_content_fingerprint, registration.source_resolution_fingerprint,
      registration.permission_catalogue_fingerprint, registration.candidate_fingerprint,
      registration.changed_at, registration.changed_by, registration.change_correlation_id
    ) is not distinct from row(
      history.state, history.source_definition_key, history.source_version,
      history.source_revision, history.validation_contract_version,
      history.source_content_fingerprint, history.source_resolution_fingerprint,
      history.permission_catalogue_fingerprint, history.candidate_fingerprint,
      history.changed_at, history.changed_by, history.change_correlation_id
    );

  return registration_exact
    and (select pg_catalog.count(*) from vortex_access.permission_catalogue_entries as entry
      where entry.organization_id = p_organization_id
        and entry.registration_kind = 'platform'
        and entry.registration_owner_id = platform_owner_id
        and entry.registration_revision = 3) = pg_catalog.jsonb_array_length(catalogue_entries)
    and not exists (
      select 1
      from pg_catalog.jsonb_array_elements(catalogue_entries) as expected(value)
      where not exists (
        select 1
        from vortex_access.permission_catalogue_entries as entry
        where entry.organization_id = p_organization_id
          and entry.registration_kind = 'platform'
          and entry.registration_owner_id = platform_owner_id
          and entry.registration_revision = 3
          and entry.application_root_id is null
          and entry.owner_kind = 'platform'
          and entry.owner_id = platform_owner_id
          and entry.permission_id = (expected.value ->> 'permissionId')::uuid
          and entry.permission_key = expected.value ->> 'key'
          and entry.label = expected.value ->> 'label'
          and entry.description = expected.value ->> 'description'
          and entry.record_type_id is null
          and entry.action_kind = expected.value ->> 'actionKind'
          and entry.named_action is null
          and entry.administrative
          and entry.source_kind = 'platform_catalogue'
          and entry.source_definition_key is null
          and entry.source_root_id is null
          and entry.source_version = '1.1.0'
          and entry.source_revision is null
          and entry.source_validation_contract_version is null
          and entry.source_content_fingerprint is null
          and entry.source_resolution_fingerprint is null
          and entry.source_catalogue_fingerprint = catalogue_fingerprint
          and entry.meaning_fingerprint = expected.value ->> 'meaningFingerprint'
      )
    );
end
$function$;

create function vortex_access.adopt_shipped_platform_permission_catalogue(
  p_organization_id uuid,
  p_expected_registration_revision bigint,
  p_target_catalogue_version text,
  p_target_catalogue_fingerprint text,
  p_changed_by uuid,
  p_correlation_id uuid
)
returns table (
  organization_id uuid,
  source_catalogue_version text,
  target_catalogue_version text,
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
  transitioned_continuity_count bigint;
  inserted_continuity_count bigint;
  platform_owner_id constant uuid := 'cabe121e-0baf-4084-9471-cce915d460a8';
  catalogue_fingerprint constant text :=
    'sha256:cb42d4b24ebead7fe9e4ba6358115ceb3ae752d3a0b4cbedc458dcb218013778';
  catalogue_entries constant jsonb := $catalogue$[
    {"permissionId":"687d5649-62ee-43dd-b684-b8af3a5394c1","key":"platform.organization.permissions.read","label":"View available permissions","description":"View the selected organisation's registered permission catalogue without receiving use or assignment authority.","actionKind":"read","meaningFingerprint":"sha256:be47b7066dd31f8797452f035cadcb18ef6ead6ff06bec6d3ec54ff769812567"},
    {"permissionId":"ca5f56d4-5382-4bf8-9a91-fbfdc77642b2","key":"platform.organization.roles.read","label":"View roles","description":"View the selected organisation's live roles and registered application role templates.","actionKind":"read","meaningFingerprint":"sha256:87c065a43a5dc6676c3276aea10d4ad848665c07a39393dae237e72d6582367b"},
    {"permissionId":"87c96495-c806-4692-9bc2-250ddb10613c","key":"platform.organization.roles.manage","label":"Manage roles","description":"Create, change or retire roles only within the actor's explicit delegated scope.","actionKind":"manage","meaningFingerprint":"sha256:91eb8281f4905ef55dbe5acf537d49febeede8df37aeaf2ff69292107a59ae2b"},
    {"permissionId":"290ae49f-4cab-4159-9c20-6e664f07d50b","key":"platform.organization.teams.read","label":"View groups","description":"View the selected organisation's Groups and membership administration data.","actionKind":"read","meaningFingerprint":"sha256:b91f3b608e3a1f7426040b0e947727726f1eab888eb2bb5a87f613bd266ebb2f"},
    {"permissionId":"6185dc64-464b-4776-97dc-c64a6f299550","key":"platform.organization.teams.manage","label":"Manage groups","description":"Manage Groups and memberships subject to delegated scope and permanent-steward safeguards.","actionKind":"manage","meaningFingerprint":"sha256:094f5e4fe28756a9497a33b357f6bd9fa7283fe0e53ada77b5b6894bcebff4a5"},
    {"permissionId":"9901c0dc-8bac-45c7-be0b-3642cb839bb1","key":"platform.organization.assignments.read","label":"View access assignments","description":"View the selected organisation's role and delegation assignments and their effective scope.","actionKind":"read","meaningFingerprint":"sha256:e46f5f2b4e9dcf77e6f96918828c7421044605b35216c5eecc0e29909c9a6848"},
    {"permissionId":"156d01f3-8f80-45fb-8fc8-b31c47dbb1df","key":"platform.organization.assignments.manage","label":"Manage access assignments","description":"Grant, change or revoke use and delegation assignments only within the actor's explicit delegated scope.","actionKind":"manage","meaningFingerprint":"sha256:9c2cf2b688335a1c3edf32d397c7a9e611743736680e30c3672dfaf11c7a9f36"},
    {"permissionId":"02c772e5-2921-4300-ad90-4f5772a7fa46","key":"platform.organization.accounts.read","label":"View organisation accounts","description":"View the selected organisation's safe account-administration information.","actionKind":"read","meaningFingerprint":"sha256:51234f517c9a62379cecc8ef047c3b5266096381dbc58e77d8a889fc3be32641"},
    {"permissionId":"630a980c-0ff5-40b1-a329-7326a2122395","key":"platform.organization.accounts.manage","label":"Manage organisation accounts","description":"Change organisation-account lifecycle through the protected operation without changing global identity or removing the final permanent steward.","actionKind":"manage","meaningFingerprint":"sha256:59439415b18b92167020f82086693b45cd238c9c4b8ac6fdd3ce071bc6d5b9e0"},
    {"permissionId":"9300e501-6d56-41b1-b203-3361dbace9bc","key":"platform.organization.invitations.read","label":"View invitations","description":"View safe invitation administration metadata without the raw invitation secret or its stored fingerprint.","actionKind":"read","meaningFingerprint":"sha256:b4462ee4471b7c93d820caef5690a31f7e7be4070e3ba8b7e83fe2e68b024cd8"},
    {"permissionId":"c2e03f58-debe-478e-b1e0-a4a8b8f1b9cb","key":"platform.organization.invitations.manage","label":"Manage invitations","description":"Create or revoke invitations through the protected operation; role assignment additionally requires the actor's assignment authority.","actionKind":"manage","meaningFingerprint":"sha256:65b1804f9f5148adfb06d50ac16243b9711cab368b8c9950ff935e2e89a69154"},
    {"permissionId":"6dffcb0b-ded8-4cd5-acc8-c50f7d4269a5","key":"platform.organization.runtime_settings.read","label":"View organisation display settings","description":"View the organisation's default language, time zone, currency, date and number display settings.","actionKind":"read","meaningFingerprint":"sha256:cba574ab17eff487cc68f32e8ce013eea83570060f17f73b02e91764f665120a"},
    {"permissionId":"c658c254-2884-414a-9012-512c0cfe4b34","key":"platform.organization.runtime_settings.manage","label":"Manage organisation display settings","description":"Change the organisation's validated default display settings through the protected revision-checked operation.","actionKind":"manage","meaningFingerprint":"sha256:e79914b57f2c0b37bb07698bee58dc8557762020d3f082e19a4ceb8304b8e4f7"},
    {"permissionId":"7ecd3304-f16c-47d4-94db-0964980091ba","key":"platform.organization.applications.manage","label":"Manage applications","description":"Install, upgrade or detach exact application bindings in the selected organisation without receiving business-record use or role-assignment authority.","actionKind":"manage","meaningFingerprint":"sha256:f3c8f4195e1d61f27a1cc65b82f6aa46ac45629195f3a8ea125925c7f12f3f81"}
  ]$catalogue$::jsonb;
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
    organization_id, registration_kind, registration_owner_id, revision, state, operation,
    source_definition_key, source_version, source_revision, validation_contract_version,
    source_content_fingerprint, source_resolution_fingerprint,
    permission_catalogue_fingerprint, candidate_fingerprint,
    changed_at, changed_by, change_correlation_id
  ) values (
    p_organization_id, 'platform', platform_owner_id, 3, 'active',
    'platform_metadata_revision', null, p_target_catalogue_version, null, null, null, null,
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
$function$;

revoke all on function
  vortex_access.platform_permission_catalogue_revision_is_exact_v1_0_1(uuid, bigint),
  vortex_access.platform_permission_catalogue_revision_is_exact(uuid, bigint),
  vortex_access.adopt_shipped_platform_permission_catalogue(
    uuid, bigint, text, text, uuid, uuid
  )
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

comment on function vortex_access.adopt_shipped_platform_permission_catalogue(
  uuid, bigint, text, text, uuid, uuid
) is 'Owner-only adoption of one compiled-in shipped platform catalogue successor.';

-- Permanent stewardship remains bound to the original thirteen platform
-- authorities. New administrative permissions remain grantable without silently
-- expanding the recovery role.
create or replace function vortex_access.organization_has_permanent_steward(
  p_organization_id uuid,
  p_checked_at timestamptz
)
returns boolean
language sql
stable
security invoker
set search_path = ''
as $function$
  with stewardship_requirement as (
    select requirement.management_application_root_id,
      requirement.management_role_id,
      requirement.management_required_role_revision
    from vortex_access.organization_stewardship_requirements as requirement
    where requirement.organization_id = p_organization_id
  ), current_platform_registration as (
    select registration.revision
    from vortex_access.permission_registrations as registration
    where registration.organization_id = p_organization_id
      and registration.registration_kind = 'platform'
      and registration.state = 'active'
      and vortex_access.platform_permission_catalogue_revision_is_exact(
        p_organization_id, registration.revision
      )
  ), original_permission(permission_id, meaning_fingerprint) as (
    values
      ('687d5649-62ee-43dd-b684-b8af3a5394c1'::uuid, 'sha256:be47b7066dd31f8797452f035cadcb18ef6ead6ff06bec6d3ec54ff769812567'::text),
      ('ca5f56d4-5382-4bf8-9a91-fbfdc77642b2'::uuid, 'sha256:87c065a43a5dc6676c3276aea10d4ad848665c07a39393dae237e72d6582367b'::text),
      ('87c96495-c806-4692-9bc2-250ddb10613c'::uuid, 'sha256:91eb8281f4905ef55dbe5acf537d49febeede8df37aeaf2ff69292107a59ae2b'::text),
      ('290ae49f-4cab-4159-9c20-6e664f07d50b'::uuid, 'sha256:b91f3b608e3a1f7426040b0e947727726f1eab888eb2bb5a87f613bd266ebb2f'::text),
      ('6185dc64-464b-4776-97dc-c64a6f299550'::uuid, 'sha256:094f5e4fe28756a9497a33b357f6bd9fa7283fe0e53ada77b5b6894bcebff4a5'::text),
      ('9901c0dc-8bac-45c7-be0b-3642cb839bb1'::uuid, 'sha256:e46f5f2b4e9dcf77e6f96918828c7421044605b35216c5eecc0e29909c9a6848'::text),
      ('156d01f3-8f80-45fb-8fc8-b31c47dbb1df'::uuid, 'sha256:9c2cf2b688335a1c3edf32d397c7a9e611743736680e30c3672dfaf11c7a9f36'::text),
      ('02c772e5-2921-4300-ad90-4f5772a7fa46'::uuid, 'sha256:51234f517c9a62379cecc8ef047c3b5266096381dbc58e77d8a889fc3be32641'::text),
      ('630a980c-0ff5-40b1-a329-7326a2122395'::uuid, 'sha256:59439415b18b92167020f82086693b45cd238c9c4b8ac6fdd3ce071bc6d5b9e0'::text),
      ('9300e501-6d56-41b1-b203-3361dbace9bc'::uuid, 'sha256:b4462ee4471b7c93d820caef5690a31f7e7be4070e3ba8b7e83fe2e68b024cd8'::text),
      ('c2e03f58-debe-478e-b1e0-a4a8b8f1b9cb'::uuid, 'sha256:65b1804f9f5148adfb06d50ac16243b9711cab368b8c9950ff935e2e89a69154'::text),
      ('6dffcb0b-ded8-4cd5-acc8-c50f7d4269a5'::uuid, 'sha256:cba574ab17eff487cc68f32e8ce013eea83570060f17f73b02e91764f665120a'::text),
      ('c658c254-2884-414a-9012-512c0cfe4b34'::uuid, 'sha256:e79914b57f2c0b37bb07698bee58dc8557762020d3f082e19a4ceb8304b8e4f7'::text)
  ), required_platform_permission as (
    select entry.application_root_id, entry.owner_kind, entry.owner_id,
      entry.permission_id, entry.meaning_fingerprint,
      registration.revision as registration_revision
    from current_platform_registration as registration
    join vortex_access.permission_catalogue_entries as entry
      on entry.organization_id = p_organization_id
      and entry.registration_kind = 'platform'
      and entry.registration_revision = registration.revision
    join original_permission as original
      on original.permission_id = entry.permission_id
      and original.meaning_fingerprint = entry.meaning_fingerprint
    where entry.application_root_id is null
      and entry.owner_kind = 'platform'
      and entry.owner_id = 'cabe121e-0baf-4084-9471-cce915d460a8'::uuid
  ), candidate_steward as (
    select account.organization_account_id
    from vortex_identity.organization_accounts as account
    join vortex_identity.identity_projections as identity
      on identity.identity_id = account.identity_id
      and identity.state = 'active'
    join vortex_access.organization_role_assignments as assignment
      on assignment.organization_id = account.organization_id
      and assignment.assignee_kind = 'organization_account'
      and assignment.organization_account_id = account.organization_account_id
      and assignment.group_id is null
      and assignment.assignment_kind = 'standing'
      and assignment.state = 'live'
      and assignment.starts_at <= p_checked_at
      and assignment.expires_at is null
    join vortex_access.organization_roles as role
      on role.organization_id = assignment.organization_id
      and role.role_id = assignment.role_id
    join vortex_access.organization_role_revisions as revision
      on revision.organization_id = role.organization_id
      and revision.role_id = role.role_id
      and revision.revision = role.live_revision
      and revision.lifecycle = 'active'
      and revision.assignment_policy = 'standing'
    join vortex_access.organization_delegation_authorities as delegation
      on delegation.organization_id = account.organization_id
      and delegation.holder_kind = 'organization_account'
      and delegation.organization_account_id = account.organization_account_id
      and delegation.group_id is null
      and delegation.scope_kind = 'organization_catalogue'
      and delegation.state = 'live'
      and delegation.starts_at <= p_checked_at
      and delegation.expires_at is null
    where account.organization_id = p_organization_id
      and account.state = 'active'
      and not exists (
        select 1
        from required_platform_permission as required
        where not exists (
          select 1
          from vortex_access.organization_role_permission_entries as permission
          join vortex_access.permission_continuities as continuity
            on continuity.organization_id = permission.organization_id
            and continuity.application_root_id is not distinct from permission.application_root_id
            and continuity.owner_kind = permission.owner_kind
            and continuity.owner_id = permission.owner_id
            and continuity.permission_id = permission.permission_id
            and continuity.state = 'available'
            and continuity.continuity_revision = permission.continuity_revision
            and continuity.meaning_fingerprint = permission.meaning_fingerprint
            and continuity.last_processed_registration_revision =
              required.registration_revision
          where permission.organization_id = role.organization_id
            and permission.role_id = role.role_id
            and permission.role_revision = role.live_revision
            and permission.application_root_id is not distinct from required.application_root_id
            and permission.owner_kind = required.owner_kind
            and permission.owner_id = required.owner_id
            and permission.permission_id = required.permission_id
            and permission.meaning_fingerprint = required.meaning_fingerprint
        )
      )
  )
  select (select pg_catalog.count(*) from required_platform_permission) = 13
    and exists (
      select 1
      from candidate_steward as steward
      cross join stewardship_requirement as requirement
      where requirement.management_application_root_id is null
        or exists (
          select 1
          from vortex_access.organization_role_assignments as assignment
          join vortex_access.organization_roles as role
            on role.organization_id = assignment.organization_id
            and role.role_id = assignment.role_id
            and role.role_kind = 'application'
            and role.application_root_id = requirement.management_application_root_id
          join vortex_access.organization_role_revisions as current_revision
            on current_revision.organization_id = role.organization_id
            and current_revision.role_id = role.role_id
            and current_revision.revision = role.live_revision
            and current_revision.role_kind = 'application'
            and current_revision.application_root_id = requirement.management_application_root_id
            and current_revision.lifecycle in ('active', 'acceptance_required')
            and current_revision.assignment_policy = 'standing'
          join vortex_access.organization_role_revisions as required_revision
            on required_revision.organization_id = role.organization_id
            and required_revision.role_id = role.role_id
            and required_revision.revision = requirement.management_required_role_revision
            and required_revision.role_kind = 'application'
            and required_revision.application_root_id = requirement.management_application_root_id
            and required_revision.lifecycle = 'active'
            and required_revision.assignment_policy = 'standing'
          where assignment.organization_id = p_organization_id
            and assignment.role_id = requirement.management_role_id
            and assignment.assignee_kind = 'organization_account'
            and assignment.organization_account_id = steward.organization_account_id
            and assignment.group_id is null
            and assignment.assignment_kind = 'standing'
            and assignment.state = 'live'
            and assignment.starts_at <= p_checked_at
            and assignment.expires_at is null
            and exists (
              select 1
              from vortex_access.organization_role_permission_entries as required_permission
              where required_permission.organization_id = role.organization_id
                and required_permission.role_id = role.role_id
                and required_permission.role_revision = requirement.management_required_role_revision
            )
            and not exists (
              select 1
              from vortex_access.organization_role_permission_entries as required_permission
              where required_permission.organization_id = role.organization_id
                and required_permission.role_id = role.role_id
                and required_permission.role_revision = requirement.management_required_role_revision
                and not exists (
                  select 1
                  from vortex_access.organization_role_permission_entries as current_permission
                  join vortex_access.permission_continuities as continuity
                    on continuity.organization_id = current_permission.organization_id
                    and continuity.application_root_id is not distinct from current_permission.application_root_id
                    and continuity.owner_kind = current_permission.owner_kind
                    and continuity.owner_id = current_permission.owner_id
                    and continuity.permission_id = current_permission.permission_id
                    and continuity.state = 'available'
                    and continuity.continuity_revision = current_permission.continuity_revision
                    and continuity.meaning_fingerprint = current_permission.meaning_fingerprint
                  where current_permission.organization_id = required_permission.organization_id
                    and current_permission.role_id = required_permission.role_id
                    and current_permission.role_revision = role.live_revision
                    and current_permission.application_root_id is not distinct from required_permission.application_root_id
                    and current_permission.owner_kind = required_permission.owner_kind
                    and current_permission.owner_id = required_permission.owner_id
                    and current_permission.permission_id = required_permission.permission_id
                    and current_permission.continuity_revision = required_permission.continuity_revision
                    and current_permission.meaning_fingerprint = required_permission.meaning_fingerprint
                )
            )
        )
    )
$function$;
