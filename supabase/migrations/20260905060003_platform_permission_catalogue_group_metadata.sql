-- Group-facing platform catalogue metadata is an explicit append-only revision.
-- The historical 1.0.0 initializer and catalogue evidence remain intact.

alter table vortex_access.permission_registration_revisions
  drop constraint permission_registration_revisions_operation_valid,
  drop constraint permission_registration_revisions_transition_shape;

alter table vortex_access.permission_registration_revisions
  add constraint permission_registration_revisions_operation_valid check (
    operation in (
      'platform_initialize', 'platform_metadata_revision',
      'register', 'update', 'reactivate', 'withdraw'
    )
  ),
  add constraint permission_registration_revisions_transition_shape check (
    (
      registration_kind = 'platform'
      and operation in ('platform_initialize', 'platform_metadata_revision')
      and state = 'active'
    )
    or (
      registration_kind = 'application'
      and (
        (operation in ('register', 'update', 'reactivate') and state = 'active')
        or (operation = 'withdraw' and state = 'withdrawn')
      )
    )
  );

alter function vortex_access.initialize_platform_permission_catalogue(uuid, uuid, uuid)
  rename to initialize_platform_permission_catalogue_v1;

create function vortex_access.initialize_platform_permission_catalogue(
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
  current_catalogue_fingerprint constant text :=
    'sha256:4aaa3e84bef44af7a1bfc401fda553a1a07e5d21d1a1301fc694fb417d2cd96a';
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
    and tenant.state = 'active';
  if not found then
    raise exception using errcode = '42501', message = 'Platform permission registration scope is unavailable';
  end if;

  select registration.* into current_registration
  from vortex_access.permission_registrations as registration
  where registration.organization_id = p_organization_id
    and registration.registration_kind = 'platform'
    and registration.registration_owner_id = 'cabe121e-0baf-4084-9471-cce915d460a8'::uuid;

  if found
    and current_registration.state = 'active'
    and current_registration.revision = 2
    and current_registration.source_version = '1.0.1'
    and current_registration.permission_catalogue_fingerprint = current_catalogue_fingerprint
    and current_registration.candidate_fingerprint = current_catalogue_fingerprint
    and (
      select pg_catalog.count(*)
      from vortex_access.permission_catalogue_entries as entry
      where entry.organization_id = p_organization_id
        and entry.registration_kind = 'platform'
        and entry.registration_owner_id = 'cabe121e-0baf-4084-9471-cce915d460a8'::uuid
        and entry.registration_revision = 2
        and entry.source_version = '1.0.1'
        and entry.source_catalogue_fingerprint = current_catalogue_fingerprint
    ) = 13 then
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

create function vortex_access.revise_platform_permission_catalogue_metadata(
  p_organization_id uuid,
  p_expected_registration_revision bigint,
  p_source_catalogue_version text,
  p_target_catalogue_version text,
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
  historical_catalogue_fingerprint constant text :=
    'sha256:f618491ff7091595ba5dde875e030bfdf7c4bdfe49572a3428914e91a6fe25bd';
  current_catalogue_fingerprint constant text :=
    'sha256:4aaa3e84bef44af7a1bfc401fda553a1a07e5d21d1a1301fc694fb417d2cd96a';
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
    {"permissionId":"c658c254-2884-414a-9012-512c0cfe4b34","key":"platform.organization.runtime_settings.manage","label":"Manage organisation display settings","description":"Change the organisation's validated default display settings through the protected revision-checked operation.","actionKind":"manage","meaningFingerprint":"sha256:e79914b57f2c0b37bb07698bee58dc8557762020d3f082e19a4ceb8304b8e4f7"}
  ]$catalogue$::jsonb;
begin
  if p_organization_id is null
    or p_organization_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_expected_registration_revision is distinct from 1
    or p_source_catalogue_version is distinct from '1.0.0'
    or p_target_catalogue_version is distinct from '1.0.1'
    or p_changed_by is null
    or p_changed_by = '00000000-0000-0000-0000-000000000000'::uuid
    or p_correlation_id is null
    or p_correlation_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using errcode = '22023', message = 'Platform catalogue metadata revision input is invalid';
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
    raise exception using errcode = '42501', message = 'Platform catalogue metadata revision scope is unavailable';
  end if;

  select registration.* into current_registration
  from vortex_access.permission_registrations as registration
  where registration.organization_id = p_organization_id
    and registration.registration_kind = 'platform'
    and registration.registration_owner_id = 'cabe121e-0baf-4084-9471-cce915d460a8'::uuid
  for update;

  if found
    and current_registration.state = 'active'
    and current_registration.revision = 2
    and current_registration.source_version = p_target_catalogue_version
    and current_registration.permission_catalogue_fingerprint = current_catalogue_fingerprint
    and current_registration.candidate_fingerprint = current_catalogue_fingerprint
    and (
      select pg_catalog.count(*)
      from vortex_access.permission_catalogue_entries as entry
      where entry.organization_id = p_organization_id
        and entry.registration_kind = 'platform'
        and entry.registration_owner_id = 'cabe121e-0baf-4084-9471-cce915d460a8'::uuid
        and entry.registration_revision = 2
        and entry.source_version = p_target_catalogue_version
        and entry.source_catalogue_fingerprint = current_catalogue_fingerprint
        and exists (
          select 1
          from pg_catalog.jsonb_array_elements(catalogue_entries) as expected(value)
          where entry.permission_id = (expected.value ->> 'permissionId')::uuid
            and entry.permission_key = expected.value ->> 'key'
            and entry.label = expected.value ->> 'label'
            and entry.description = expected.value ->> 'description'
            and entry.action_kind = expected.value ->> 'actionKind'
            and entry.meaning_fingerprint = expected.value ->> 'meaningFingerprint'
        )
    ) = pg_catalog.jsonb_array_length(catalogue_entries) then
    return query
    select p_organization_id, p_source_catalogue_version, p_target_catalogue_version,
      current_registration.revision, version.current_version
    from vortex_access.organization_access_versions as version
    where version.organization_id = p_organization_id;
    return;
  end if;

  if not found
    or current_registration.state <> 'active'
    or current_registration.revision <> p_expected_registration_revision
    or current_registration.source_version <> p_source_catalogue_version
    or current_registration.permission_catalogue_fingerprint <> historical_catalogue_fingerprint
    or current_registration.candidate_fingerprint <> historical_catalogue_fingerprint then
    raise exception using errcode = '55000', message = 'Platform catalogue metadata source evidence is invalid';
  end if;

  insert into vortex_access.permission_registration_revisions (
    organization_id, registration_kind, registration_owner_id, revision, state, operation,
    source_definition_key, source_version, source_revision, validation_contract_version,
    source_content_fingerprint, source_resolution_fingerprint,
    permission_catalogue_fingerprint, candidate_fingerprint,
    changed_at, changed_by, change_correlation_id
  ) values (
    p_organization_id, 'platform', 'cabe121e-0baf-4084-9471-cce915d460a8', 2,
    'active', 'platform_metadata_revision', null, p_target_catalogue_version,
    null, null, null, null, current_catalogue_fingerprint, current_catalogue_fingerprint,
    operation_at, p_changed_by, p_correlation_id
  );

  insert into vortex_access.permission_catalogue_entries (
    organization_id, registration_kind, registration_owner_id, registration_revision,
    application_root_id, owner_kind, owner_id, permission_id, permission_key,
    label, description, record_type_id, action_kind, named_action, administrative,
    source_kind, source_definition_key, source_root_id, source_version, source_revision,
    source_validation_contract_version, source_content_fingerprint,
    source_resolution_fingerprint, source_catalogue_fingerprint, meaning_fingerprint
  )
  select p_organization_id, 'platform', 'cabe121e-0baf-4084-9471-cce915d460a8', 2,
    null, 'platform', 'cabe121e-0baf-4084-9471-cce915d460a8',
    (entry ->> 'permissionId')::uuid, entry ->> 'key', entry ->> 'label',
    entry ->> 'description', null, entry ->> 'actionKind', null, true,
    'platform_catalogue', null, null, p_target_catalogue_version, null, null, null, null,
    current_catalogue_fingerprint, entry ->> 'meaningFingerprint'
  from pg_catalog.jsonb_array_elements(catalogue_entries) as item(entry);

  update vortex_access.permission_registrations as registration
  set revision = 2,
      source_version = p_target_catalogue_version,
      permission_catalogue_fingerprint = current_catalogue_fingerprint,
      candidate_fingerprint = current_catalogue_fingerprint,
      changed_at = operation_at,
      changed_by = p_changed_by,
      change_correlation_id = p_correlation_id
  where registration.organization_id = p_organization_id
    and registration.registration_kind = 'platform'
    and registration.registration_owner_id = 'cabe121e-0baf-4084-9471-cce915d460a8'::uuid
    and registration.revision = p_expected_registration_revision;
  if not found then
    raise exception using errcode = '40001', message = 'Platform catalogue metadata source changed';
  end if;

  select incremented.current_version into resulting_version
  from vortex_access.increment_organization_access_version(
    p_organization_id, p_changed_by, p_correlation_id, 'application_access_changed'
  ) as incremented;

  return query
  select p_organization_id, p_source_catalogue_version, p_target_catalogue_version,
    2::bigint, resulting_version;
end
$function$;

revoke execute on function
  vortex_access.initialize_platform_permission_catalogue_v1(uuid, uuid, uuid),
  vortex_access.initialize_platform_permission_catalogue(uuid, uuid, uuid),
  vortex_access.revise_platform_permission_catalogue_metadata(
    uuid, bigint, text, text, uuid, uuid
  )
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

comment on function vortex_access.initialize_platform_permission_catalogue_v1(uuid, uuid, uuid) is
  'Owner-only exact historical 1.0.0 platform catalogue initializer retained for compatibility.';
comment on function vortex_access.initialize_platform_permission_catalogue(uuid, uuid, uuid) is
  'Owner-only platform catalogue initializer; creates 1.0.0 and recognizes exact 1.0.1 replay without upgrading.';
comment on function vortex_access.revise_platform_permission_catalogue_metadata(
  uuid, bigint, text, text, uuid, uuid
) is
  'Owner-only exact 1.0.0 to 1.0.1 platform catalogue display-metadata revision.';
