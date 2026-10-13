set local role vortex_owner;

-- The baseline left these registration tables owned by postgres.
-- Transfer them before removing the copied release fields.
reset role;
-- guard-allow: migration-owner-role Transfer the two legacy postgres-owned registration tables before changing them.
alter table vortex_access.permission_registrations owner to vortex_owner;
-- guard-allow: migration-owner-role Transfer the two legacy postgres-owned registration tables before changing them.
alter table vortex_access.permission_registration_revisions owner to vortex_owner;
set local role vortex_owner;

-- Other baseline functions still owned by postgres read or write the two transferred tables.
grant all on table vortex_access.permission_registrations,
  vortex_access.permission_registration_revisions to postgres;

alter table vortex_access.permission_registration_revisions
  drop constraint permission_registration_revisions_fingerprints_valid,
  drop constraint permission_registration_revisions_source_shape;
alter table vortex_access.permission_registrations
  drop constraint permission_registrations_source_content_fingerprint_format,
  drop constraint permission_registrations_source_resolution_fingerprint_format,
  drop constraint permission_registrations_source_shape;

alter table vortex_access.permission_registration_revisions
  drop column source_content_fingerprint,
  drop column source_resolution_fingerprint;
alter table vortex_access.permission_registrations
  drop column source_content_fingerprint,
  drop column source_resolution_fingerprint;

alter table vortex_access.permission_registration_revisions
  add constraint permission_registration_revisions_fingerprints_valid check (
    permission_catalogue_fingerprint ~ '^sha256:[a-f0-9]{64}$'
    and candidate_fingerprint ~ '^sha256:[a-f0-9]{64}$'
  ),
  add constraint permission_registration_revisions_source_shape check (
    (registration_kind = 'platform' and registration_owner_id = 'cabe121e-0baf-4084-9471-cce915d460a8'::uuid
      and source_definition_key is null and source_revision is null
      and validation_contract_version is null)
    or (registration_kind = 'application' and source_definition_key is not null
      and source_revision is not null and validation_contract_version is not null)
  );
alter table vortex_access.permission_registrations
  add constraint permission_registrations_source_shape check (
    (registration_kind = 'platform' and state = 'active'
      and registration_owner_id = 'cabe121e-0baf-4084-9471-cce915d460a8'::uuid
      and source_definition_key is null and source_revision is null
      and validation_contract_version is null)
    or (registration_kind = 'application' and source_definition_key is not null
      and source_revision is not null and validation_contract_version is not null)
  );

set local role postgres;
-- guard-allow: migration-owner-role Existing function retains postgres ownership until baseline table policies migrate.
create or replace function vortex_access.adopt_builder_permission_catalogue(
  p_organization_id uuid,
  p_changed_by uuid,
  p_correlation_id uuid
)
returns bigint
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  -- guard-allow: function-uuid fixed platform permission identity without declaration-table read access
  platform_owner_id constant uuid := 'cabe121e-0baf-4084-9471-cce915d460a8';
  -- guard-allow: function-uuid fixed platform permission identity without declaration-table read access
  drafts_permission_id constant uuid := '0548c061-b1a9-48e5-a04a-eb1d0dae0644';
  -- guard-allow: function-uuid fixed platform permission identity without declaration-table read access
  releases_permission_id constant uuid := 'dfdd5aba-2b85-4169-b570-92be284e7b5c';
  -- guard-allow: function-uuid fixed platform permission identity without declaration-table read access
  custom_code_permission_id constant uuid := 'd1be247f-094d-47c1-a38d-762290868c91';
  -- guard-allow: function-uuid fixed platform permission identity without declaration-table read access
  system_applications_permission_id constant uuid := 'eaade6fd-7390-44d2-a7ef-343324c7384a';
  catalogue_fingerprint constant text :=
    'sha256:1e5cceb04465d940f163ec926af7423efc9b37788551b00766d768fe9089195b';
  drafts_meaning_fingerprint constant text :=
    'sha256:29c4f706d6b65b54f4c3378de3f64816c01a22dc308ee7f6f0898d71eda216a0';
  releases_meaning_fingerprint constant text :=
    'sha256:b291e3a7d8a7f5cc0f346762914d1b1122be875d21fa70e5fdad819d28b1a80a';
  custom_code_meaning_fingerprint constant text :=
    'sha256:d8faa202f04c0c453cb87ed37f3b8f226b4171d133fc1277616a2b418db43c21';
  system_applications_meaning_fingerprint constant text :=
    'sha256:0c68ccc8a752c8009a5b84e5a22a584f3f22f666213121db1be7fb010cdbc50b';
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
      message = 'Builder permission catalogue adoption input is invalid';
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
      message = 'Builder permission catalogue scope is unavailable';
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

  if current_registration.revision = 6 then
    if not vortex_access.platform_permission_catalogue_revision_is_exact(
      p_organization_id, 6
    ) then
      raise exception using errcode = '55000',
        message = 'Builder permission catalogue evidence is invalid';
    end if;
    select version.current_version into strict resulting_version
    from vortex_access.organization_access_versions as version
    where version.organization_id = p_organization_id;
    return resulting_version;
  end if;

  if current_registration.revision <> 5
    or not vortex_access.platform_permission_catalogue_revision_is_exact(
      p_organization_id, 5
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
    p_organization_id, 'platform', platform_owner_id, 6, 'active', 'platform_metadata_revision', null, '1.4.0', null, null, catalogue_fingerprint, catalogue_fingerprint, operation_at, p_changed_by, p_correlation_id
  );

  insert into vortex_access.permission_catalogue_entries (
    organization_id, registration_kind, registration_owner_id,
    registration_revision, application_root_id, owner_kind, owner_id,
    permission_id, permission_key, label, description, record_type_id,
    action_kind, named_action, administrative, source_kind,
    source_definition_key, source_root_id, source_version, source_revision,
    source_validation_contract_version, source_content_fingerprint,
    source_resolution_fingerprint, source_catalogue_fingerprint,
    meaning_fingerprint, record_scope, field_policy
  )
  select entry.organization_id, entry.registration_kind,
    entry.registration_owner_id, 6, entry.application_root_id,
    entry.owner_kind, entry.owner_id, entry.permission_id,
    entry.permission_key, entry.label, entry.description,
    entry.record_type_id, entry.action_kind, entry.named_action,
    entry.administrative, entry.source_kind, entry.source_definition_key,
    entry.source_root_id, '1.4.0', entry.source_revision,
    entry.source_validation_contract_version,
    entry.source_content_fingerprint, entry.source_resolution_fingerprint,
    catalogue_fingerprint, entry.meaning_fingerprint,
    entry.record_scope, entry.field_policy
  from vortex_access.permission_catalogue_entries as entry
  where entry.organization_id = p_organization_id
    and entry.registration_kind = 'platform'
    and entry.registration_owner_id = platform_owner_id
    and entry.registration_revision = 5;
  get diagnostics transition_count = row_count;
  if transition_count <> 18 then
    raise exception using errcode = '55000',
      message = 'Platform permission catalogue copy is incomplete';
  end if;

  insert into vortex_access.permission_catalogue_entries (
    organization_id, registration_kind, registration_owner_id,
    registration_revision, application_root_id, owner_kind, owner_id,
    permission_id, permission_key, label, description, record_type_id,
    action_kind, named_action, administrative, source_kind,
    source_definition_key, source_root_id, source_version, source_revision,
    source_validation_contract_version, source_content_fingerprint,
    source_resolution_fingerprint, source_catalogue_fingerprint,
    meaning_fingerprint
  ) values
    (
      p_organization_id, 'platform', platform_owner_id, 6, null,
      'platform', platform_owner_id, drafts_permission_id,
      'platform.organization.definition_drafts.manage', 'Manage definition drafts',
      'Create and change module and application drafts, including flows, placements and role templates, without publication or installation authority.',
      null, 'manage', null, true, 'platform_catalogue', null, null,
      '1.4.0', null, null, null, null, catalogue_fingerprint,
      drafts_meaning_fingerprint
    ),
    (
      p_organization_id, 'platform', platform_owner_id, 6, null,
      'platform', platform_owner_id, releases_permission_id,
      'platform.organization.definition_releases.manage', 'Manage definition releases',
      'Publish module and application drafts as immutable releases without receiving installation or business-record authority.',
      null, 'manage', null, true, 'platform_catalogue', null, null,
      '1.4.0', null, null, null, null, catalogue_fingerprint,
      releases_meaning_fingerprint
    ),
    (
      p_organization_id, 'platform', platform_owner_id, 6, null,
      'platform', platform_owner_id, custom_code_permission_id,
      'platform.organization.custom_code.manage', 'Manage custom code',
      'Required in addition to the application-management permission to install, upgrade or uninstall packages that bundle custom components or scripts.',
      null, 'manage', null, true, 'platform_catalogue', null, null,
      '1.4.0', null, null, null, null, catalogue_fingerprint,
      custom_code_meaning_fingerprint
    ),
    (
      p_organization_id, 'platform', platform_owner_id, 6, null,
      'platform', platform_owner_id, system_applications_permission_id,
      'platform.organization.system_applications.manage', 'Manage system applications',
      'Change system application definitions, including extension fields, theme, navigation and dependent applications, without uninstallation authority.',
      null, 'manage', null, true, 'platform_catalogue', null, null,
      '1.4.0', null, null, null, null, catalogue_fingerprint,
      system_applications_meaning_fingerprint
    );

  update vortex_access.permission_continuities as continuity
  set last_processed_registration_revision = 6,
      changed_at = operation_at
  where continuity.organization_id = p_organization_id
    and continuity.application_root_id is null
    and continuity.registration_kind = 'platform'
    and continuity.registration_owner_id = platform_owner_id
    and continuity.state = 'available'
    and continuity.last_processed_registration_revision = 5;
  get diagnostics transition_count = row_count;
  if transition_count <> 18 then
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
      drafts_permission_id, 'platform', platform_owner_id,
      'available', 1, drafts_meaning_fingerprint, 6, operation_at
    ),
    (
      p_organization_id, null, 'platform', platform_owner_id,
      releases_permission_id, 'platform', platform_owner_id,
      'available', 1, releases_meaning_fingerprint, 6, operation_at
    ),
    (
      p_organization_id, null, 'platform', platform_owner_id,
      custom_code_permission_id, 'platform', platform_owner_id,
      'available', 1, custom_code_meaning_fingerprint, 6, operation_at
    ),
    (
      p_organization_id, null, 'platform', platform_owner_id,
      system_applications_permission_id, 'platform', platform_owner_id,
      'available', 1, system_applications_meaning_fingerprint, 6, operation_at
    );

  update vortex_access.permission_registrations as registration
  set revision = 6,
      source_version = '1.4.0',
      permission_catalogue_fingerprint = catalogue_fingerprint,
      candidate_fingerprint = catalogue_fingerprint,
      changed_at = operation_at,
      changed_by = p_changed_by,
      change_correlation_id = p_correlation_id
  where registration.organization_id = p_organization_id
    and registration.registration_kind = 'platform'
    and registration.registration_owner_id = platform_owner_id
    and registration.revision = 5;
  if not found then
    raise exception using errcode = '40001',
      message = 'Platform permission catalogue changed concurrently';
  end if;

  if not vortex_access.platform_permission_catalogue_revision_is_exact(
    p_organization_id, 6
  ) then
    raise exception using errcode = '55000',
      message = 'Builder permission catalogue evidence is incomplete';
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
$function$;

set local role vortex_owner;

set local role postgres;
-- guard-allow: migration-owner-role Existing function retains postgres ownership until baseline table policies migrate.
CREATE OR REPLACE FUNCTION vortex_access.adopt_connection_administration_permission_catalogue(p_organization_id uuid, p_changed_by uuid, p_correlation_id uuid) RETURNS bigint
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  -- guard-allow: function-uuid fixed platform permission identity without declaration-table read access
  platform_owner_id constant uuid := 'cabe121e-0baf-4084-9471-cce915d460a8';
  -- guard-allow: function-uuid fixed platform permission identity without declaration-table read access
  connection_permission_id constant uuid := 'ec2908a1-f3cd-4c4a-8bf7-91bffbf4cb3d';
  -- guard-allow: function-uuid fixed platform permission identity without declaration-table read access
  settings_permission_id constant uuid := 'c658c254-2884-414a-9012-512c0cfe4b34';
  -- guard-allow: function-uuid fixed platform permission identity without declaration-table read access
  assignments_permission_id constant uuid := '156d01f3-8f80-45fb-8fc8-b31c47dbb1df';
  catalogue_fingerprint constant text :=
    'sha256:2fe313d69f53d7ce9247aa0ae05b5cc837872f49285e577f9dc9e1f21f3c842e';
  meaning_fingerprint constant text :=
    'sha256:809b4b3ad29ff61ab5ea73c06504909540b8111a2b3c2e1310559a7e9dc2e31e';
  operation_at timestamptz := pg_catalog.statement_timestamp();
  current_registration vortex_access.permission_registrations%rowtype;
  administrator_role record;
  previous_revision vortex_access.organization_role_revisions%rowtype;
  next_ordinal bigint;
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
      message = 'Connection permission catalogue adoption input is invalid';
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
      message = 'Connection permission catalogue scope is unavailable';
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

  if current_registration.revision = 4 then
    if not vortex_access.platform_permission_catalogue_revision_is_exact(
      p_organization_id, 4
    ) then
      raise exception using errcode = '55000',
        message = 'Connection permission catalogue evidence is invalid';
    end if;
    select version.current_version into strict resulting_version
    from vortex_access.organization_access_versions as version
    where version.organization_id = p_organization_id;
    return resulting_version;
  end if;

  if current_registration.revision <> 3
    or not vortex_access.platform_permission_catalogue_revision_is_exact(
      p_organization_id, 3
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
    p_organization_id, 'platform', platform_owner_id, 4, 'active', 'platform_metadata_revision', null, '1.2.0', null, null, catalogue_fingerprint, catalogue_fingerprint, operation_at, p_changed_by, p_correlation_id
  );

  insert into vortex_access.permission_catalogue_entries (
    organization_id, registration_kind, registration_owner_id,
    registration_revision, application_root_id, owner_kind, owner_id,
    permission_id, permission_key, label, description, record_type_id,
    action_kind, named_action, administrative, source_kind,
    source_definition_key, source_root_id, source_version, source_revision,
    source_validation_contract_version, source_content_fingerprint,
    source_resolution_fingerprint, source_catalogue_fingerprint,
    meaning_fingerprint, record_scope, field_policy
  )
  select entry.organization_id, entry.registration_kind,
    entry.registration_owner_id, 4, entry.application_root_id,
    entry.owner_kind, entry.owner_id, entry.permission_id,
    entry.permission_key, entry.label, entry.description,
    entry.record_type_id, entry.action_kind, entry.named_action,
    entry.administrative, entry.source_kind, entry.source_definition_key,
    entry.source_root_id, '1.2.0', entry.source_revision,
    entry.source_validation_contract_version,
    entry.source_content_fingerprint, entry.source_resolution_fingerprint,
    catalogue_fingerprint, entry.meaning_fingerprint,
    entry.record_scope, entry.field_policy
  from vortex_access.permission_catalogue_entries as entry
  where entry.organization_id = p_organization_id
    and entry.registration_kind = 'platform'
    and entry.registration_owner_id = platform_owner_id
    and entry.registration_revision = 3;
  get diagnostics transition_count = row_count;
  if transition_count <> 14 then
    raise exception using errcode = '55000',
      message = 'Platform permission catalogue copy is incomplete';
  end if;

  insert into vortex_access.permission_catalogue_entries (
    organization_id, registration_kind, registration_owner_id,
    registration_revision, application_root_id, owner_kind, owner_id,
    permission_id, permission_key, label, description, record_type_id,
    action_kind, named_action, administrative, source_kind,
    source_definition_key, source_root_id, source_version, source_revision,
    source_validation_contract_version, source_content_fingerprint,
    source_resolution_fingerprint, source_catalogue_fingerprint,
    meaning_fingerprint
  ) values (
    p_organization_id, 'platform', platform_owner_id, 4, null,
    'platform', platform_owner_id, connection_permission_id,
    'platform.organization.connections.manage', 'Manage connections',
    'Register, grant, check, revoke and reauthorise connection instances in the selected organisation without application-installation or access-assignment authority.',
    null, 'manage', null, true, 'platform_catalogue', null, null,
    '1.2.0', null, null, null, null, catalogue_fingerprint,
    meaning_fingerprint
  );

  update vortex_access.permission_continuities as continuity
  set last_processed_registration_revision = 4,
      changed_at = operation_at
  where continuity.organization_id = p_organization_id
    and continuity.application_root_id is null
    and continuity.registration_kind = 'platform'
    and continuity.registration_owner_id = platform_owner_id
    and continuity.state = 'available'
    and continuity.last_processed_registration_revision = 3;
  get diagnostics transition_count = row_count;
  if transition_count <> 14 then
    raise exception using errcode = '55000',
      message = 'Platform permission continuity transition is incomplete';
  end if;

  insert into vortex_access.permission_continuities (
    organization_id, application_root_id, owner_kind, owner_id,
    permission_id, registration_kind, registration_owner_id, state,
    continuity_revision, meaning_fingerprint,
    last_processed_registration_revision, changed_at
  ) values (
    p_organization_id, null, 'platform', platform_owner_id,
    connection_permission_id, 'platform', platform_owner_id,
    'available', 1, meaning_fingerprint, 4, operation_at
  );

  update vortex_access.permission_registrations as registration
  set revision = 4,
      source_version = '1.2.0',
      permission_catalogue_fingerprint = catalogue_fingerprint,
      candidate_fingerprint = catalogue_fingerprint,
      changed_at = operation_at,
      changed_by = p_changed_by,
      change_correlation_id = p_correlation_id
  where registration.organization_id = p_organization_id
    and registration.registration_kind = 'platform'
    and registration.registration_owner_id = platform_owner_id
    and registration.revision = 3;
  if not found then
    raise exception using errcode = '40001',
      message = 'Platform permission catalogue changed concurrently';
  end if;

  if not vortex_access.platform_permission_catalogue_revision_is_exact(
    p_organization_id, 4
  ) then
    raise exception using errcode = '55000',
      message = 'Connection permission catalogue evidence is incomplete';
  end if;

  for administrator_role in
    select role.organization_id, role.role_id, role.live_revision
    from vortex_access.organization_roles as role
    join vortex_access.organization_role_revisions as revision
      on revision.organization_id = role.organization_id
      and revision.role_id = role.role_id
      and revision.revision = role.live_revision
    where role.organization_id = p_organization_id
      and role.role_kind = 'custom'
      and revision.lifecycle = 'active'
      and revision.privilege_classification = 'privileged'
      and exists (
        select 1
        from vortex_access.organization_role_permission_entries as permission
        join vortex_access.permission_continuities as continuity
          on continuity.organization_id = permission.organization_id
          and continuity.application_root_id is null
          and continuity.owner_kind = permission.owner_kind
          and continuity.owner_id = permission.owner_id
          and continuity.permission_id = permission.permission_id
          and continuity.state = 'available'
          and continuity.continuity_revision = permission.continuity_revision
          and continuity.meaning_fingerprint = permission.meaning_fingerprint
        where permission.organization_id = role.organization_id
          and permission.role_id = role.role_id
          and permission.role_revision = role.live_revision
          and permission.owner_kind = 'platform'
          and permission.owner_id = platform_owner_id
          and permission.permission_id = settings_permission_id
      )
      and exists (
        select 1
        from vortex_access.organization_role_permission_entries as permission
        join vortex_access.permission_continuities as continuity
          on continuity.organization_id = permission.organization_id
          and continuity.application_root_id is null
          and continuity.owner_kind = permission.owner_kind
          and continuity.owner_id = permission.owner_id
          and continuity.permission_id = permission.permission_id
          and continuity.state = 'available'
          and continuity.continuity_revision = permission.continuity_revision
          and continuity.meaning_fingerprint = permission.meaning_fingerprint
        where permission.organization_id = role.organization_id
          and permission.role_id = role.role_id
          and permission.role_revision = role.live_revision
          and permission.owner_kind = 'platform'
          and permission.owner_id = platform_owner_id
          and permission.permission_id = assignments_permission_id
      )
    order by role.role_id
    for update of role
  loop
    if administrator_role.live_revision = 9007199254740991 then
      raise exception using errcode = '22003',
        message = 'Organization administrator role revision is exhausted';
    end if;

    select revision.* into strict previous_revision
    from vortex_access.organization_role_revisions as revision
    where revision.organization_id = p_organization_id
      and revision.role_id = administrator_role.role_id
      and revision.revision = administrator_role.live_revision;
    if previous_revision.authority_continuity_revision = 9007199254740991 then
      raise exception using errcode = '22003',
        message = 'Organization administrator authority continuity is exhausted';
    end if;

    select pg_catalog.max(permission.entry_ordinal) into next_ordinal
    from vortex_access.organization_role_permission_entries as permission
    where permission.organization_id = p_organization_id
      and permission.role_id = administrator_role.role_id
      and permission.role_revision = administrator_role.live_revision;
    if next_ordinal is null or next_ordinal = 9007199254740991 then
      raise exception using errcode = '22003',
        message = 'Organization administrator permission ordinal is exhausted';
    end if;

    insert into vortex_access.organization_role_permission_entries (
      organization_id, role_id, role_revision, entry_ordinal, role_kind,
      role_application_root_id, application_root_id, owner_kind, owner_id,
      permission_id, registration_kind, registration_owner_id,
      accepted_registration_revision, catalogue_fingerprint,
      continuity_revision, meaning_fingerprint
    )
    select permission.organization_id, permission.role_id,
      administrator_role.live_revision + 1, permission.entry_ordinal,
      permission.role_kind, permission.role_application_root_id,
      permission.application_root_id, permission.owner_kind,
      permission.owner_id, permission.permission_id,
      permission.registration_kind, permission.registration_owner_id,
      permission.accepted_registration_revision,
      permission.catalogue_fingerprint, permission.continuity_revision,
      permission.meaning_fingerprint
    from vortex_access.organization_role_permission_entries as permission
    where permission.organization_id = p_organization_id
      and permission.role_id = administrator_role.role_id
      and permission.role_revision = administrator_role.live_revision;

    insert into vortex_access.organization_role_permission_entries (
      organization_id, role_id, role_revision, entry_ordinal, role_kind,
      role_application_root_id, application_root_id, owner_kind, owner_id,
      permission_id, registration_kind, registration_owner_id,
      accepted_registration_revision, catalogue_fingerprint,
      continuity_revision, meaning_fingerprint
    ) values (
      p_organization_id, administrator_role.role_id,
      administrator_role.live_revision + 1, next_ordinal + 1,
      'custom', null, null, 'platform', platform_owner_id,
      connection_permission_id, 'platform', platform_owner_id,
      4, catalogue_fingerprint, 1, meaning_fingerprint
    );

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
      p_organization_id, administrator_role.role_id,
      administrator_role.live_revision + 1,
      previous_revision.role_kind, previous_revision.application_root_id,
      previous_revision.lifecycle, previous_revision.privilege_classification,
      previous_revision.assignment_policy,
      previous_revision.policy_continuity_revision,
      previous_revision.authority_continuity_revision + 1,
      previous_revision.activation_policy_id,
      previous_revision.activation_policy_revision,
      previous_revision.role_key, previous_revision.label,
      previous_revision.description, previous_revision.source_definition_key,
      previous_revision.source_release_revision,
      previous_revision.source_release_version,
      previous_revision.source_validation_contract_version,
      previous_revision.accepted_registration_revision,
      previous_revision.template_continuity_revision,
      p_changed_by, operation_at, p_correlation_id
    );

    update vortex_access.organization_roles as role
    set live_revision = administrator_role.live_revision + 1
    where role.organization_id = p_organization_id
      and role.role_id = administrator_role.role_id
      and role.live_revision = administrator_role.live_revision;
    if not found then
      raise exception using errcode = '40001',
        message = 'Organization administrator role changed concurrently';
    end if;
  end loop;

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
    'role_catalogue_changed'
  ) as incremented;
  return resulting_version;
end
$$;

set local role vortex_owner;

set local role postgres;
-- guard-allow: migration-owner-role Existing function retains postgres ownership until baseline table policies migrate.
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
    source_validation_contract_version, source_content_fingerprint,
    source_resolution_fingerprint, source_catalogue_fingerprint,
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
    entry.source_content_fingerprint, entry.source_resolution_fingerprint,
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
    source_validation_contract_version, source_content_fingerprint,
    source_resolution_fingerprint, source_catalogue_fingerprint,
    meaning_fingerprint
  ) values
    (
      p_organization_id, 'platform', platform_owner_id, 5, null,
      'platform', platform_owner_id, security_permission_id,
      'platform.security.identities.disable', 'Disable identities',
      'Disable an identity and revoke its active sessions through the identity owner''s protected operation without receiving general identity-administration or business-record authority.',
      null, 'manage', null, true, 'platform_catalogue', null, null,
      '1.3.0', null, null, null, null, catalogue_fingerprint,
      security_meaning_fingerprint
    ),
    (
      p_organization_id, 'platform', platform_owner_id, 5, null,
      'platform', platform_owner_id, support_request_permission_id,
      'platform.support.access.request', 'Request support access',
      'Request time-bounded support access to another organisation for a named operator and exact scope without receiving standing access to that organisation.',
      null, 'manage', null, true, 'platform_catalogue', null, null,
      '1.3.0', null, null, null, null, catalogue_fingerprint,
      support_request_meaning_fingerprint
    ),
    (
      p_organization_id, 'platform', platform_owner_id, 5, null,
      'platform', platform_owner_id, support_approve_permission_id,
      'platform.organization.support.approve', 'Approve support access',
      'Approve or refuse a time-bounded support-access request for one''s own organisation without granting the requester standing authority.',
      null, 'manage', null, true, 'platform_catalogue', null, null,
      '1.3.0', null, null, null, null, catalogue_fingerprint,
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

set local role vortex_owner;

set local role postgres;
-- guard-allow: migration-owner-role Existing function retains postgres ownership until baseline table policies migrate.
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

set local role vortex_owner;

set local role postgres;
-- guard-allow: migration-owner-role Existing function retains postgres ownership until baseline table policies migrate.
CREATE OR REPLACE FUNCTION vortex_access.application_permission_registration_matches_candidate(p_organization_id uuid, p_application_root_id uuid, p_registration_revision bigint, p_candidate jsonb) RETURNS boolean
    LANGUAGE plpgsql STABLE
    SET search_path TO ''
    AS $$
declare
  release_value jsonb;
  actual_entries jsonb;
  actual_application_permission_ids jsonb;
  registration_exact boolean;
begin
  if p_organization_id is null
    or p_organization_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_application_root_id is null
    or p_application_root_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_registration_revision is null
    or p_registration_revision not between 1 and 9007199254740991
    or p_candidate is null
    or pg_catalog.jsonb_typeof(p_candidate) is distinct from 'object'
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
    or p_candidate ->> 'contractVersion' is distinct from '1.0.0'
    or (p_candidate ->> 'organizationId')::uuid is distinct from p_organization_id
    or (p_candidate ->> 'applicationRootId')::uuid is distinct from p_application_root_id
    or pg_catalog.jsonb_typeof(p_candidate -> 'applicationRelease') is distinct from 'object'
    or pg_catalog.jsonb_typeof(p_candidate -> 'applicationPermissionIds') is distinct from 'array'
    or pg_catalog.jsonb_typeof(p_candidate -> 'entries') is distinct from 'array' then
    return false;
  end if;

  release_value := p_candidate -> 'applicationRelease';

  select pg_catalog.count(*) = 1 into registration_exact
  from vortex_access.permission_registrations as registration
  join vortex_access.permission_registration_revisions as history
    on history.organization_id = registration.organization_id
    and history.registration_kind = registration.registration_kind
    and history.registration_owner_id = registration.registration_owner_id
    and history.revision = registration.revision
  join vortex_definition.releases as release
    on release.root_id = registration.registration_owner_id
    and release.release_revision = registration.source_revision
    and release.release_version = registration.source_version
    and release.validation_contract_version = registration.validation_contract_version
  where registration.organization_id = p_organization_id
    and registration.registration_kind = 'application'
    and registration.registration_owner_id = p_application_root_id
    and registration.state = 'active'
    and registration.revision = p_registration_revision
    and registration.source_definition_key = release_value ->> 'definitionKey'
    and registration.source_version = release_value ->> 'releaseVersion'
    and registration.source_revision = (release_value ->> 'releaseRevision')::bigint
    and registration.validation_contract_version =
      release_value ->> 'validationContractVersion'
    and release.content_fingerprint = release_value ->> 'contentFingerprint'
    and release.resolution_fingerprint = release_value ->> 'resolutionFingerprint'
    and registration.permission_catalogue_fingerprint =
      p_candidate ->> 'applicationCatalogueFingerprint'
    and registration.candidate_fingerprint = p_candidate ->> 'candidateFingerprint'
    and history.operation in ('register', 'update', 'reactivate')
    and row(
      registration.state, registration.source_definition_key, registration.source_version,
      registration.source_revision, registration.validation_contract_version,
      registration.permission_catalogue_fingerprint, registration.candidate_fingerprint,
      registration.changed_at, registration.changed_by, registration.change_correlation_id
    ) is not distinct from row(
      history.state, history.source_definition_key, history.source_version,
      history.source_revision, history.validation_contract_version,
      history.permission_catalogue_fingerprint, history.candidate_fingerprint,
      history.changed_at, history.changed_by, history.change_correlation_id
    );

  if not registration_exact then
    return false;
  end if;

  select coalesce(
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'applicationRootId', entry.application_root_id,
        'ownerKind', entry.owner_kind,
        'ownerId', entry.owner_id,
        'permission', pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
          'permissionId', entry.permission_id,
          'key', entry.permission_key,
          'label', entry.label,
          'description', entry.description,
          'recordTypeId', entry.record_type_id,
          'recordScope', entry.record_scope,
          'fieldPolicy', entry.field_policy,
          'actionKind', entry.action_kind,
          'namedAction', entry.named_action,
          'administrative', entry.administrative
        )),
        'sourceRelease', pg_catalog.jsonb_build_object(
          'kind', entry.source_kind,
          'definitionKey', entry.source_definition_key,
          'rootId', entry.source_root_id,
          'releaseRevision', entry.source_revision,
          'releaseVersion', entry.source_version,
          'validationContractVersion', entry.source_validation_contract_version,
          'contentFingerprint', entry.source_content_fingerprint,
          'resolutionFingerprint', entry.source_resolution_fingerprint
        ),
        'meaningFingerprint', entry.meaning_fingerprint
      ) order by
        entry.owner_kind collate "C", entry.owner_id,
        entry.permission_key collate "C", entry.permission_id
    ),
    '[]'::jsonb
  ) into actual_entries
  from vortex_access.permission_catalogue_entries as entry
  where entry.organization_id = p_organization_id
    and entry.registration_kind = 'application'
    and entry.registration_owner_id = p_application_root_id
    and entry.registration_revision = p_registration_revision;

  select coalesce(
    pg_catalog.jsonb_agg(entry.permission_id order by
      entry.permission_key collate "C", entry.permission_id),
    '[]'::jsonb
  ) into actual_application_permission_ids
  from vortex_access.permission_catalogue_entries as entry
  where entry.organization_id = p_organization_id
    and entry.registration_kind = 'application'
    and entry.registration_owner_id = p_application_root_id
    and entry.registration_revision = p_registration_revision
    and entry.owner_kind = 'application'
    and not entry.administrative;

  return actual_entries = p_candidate -> 'entries'
    and actual_application_permission_ids = p_candidate -> 'applicationPermissionIds';
exception
  when invalid_text_representation or numeric_value_out_of_range then
    return false;
end
$$;

set local role vortex_owner;

set local role postgres;
-- guard-allow: migration-owner-role Existing function retains postgres ownership until baseline table policies migrate.
CREATE OR REPLACE FUNCTION vortex_access.apply_application_permission_registration_v1_internal(p_operation text, p_expected_revision bigint, p_candidate jsonb, p_changed_by uuid, p_correlation_id uuid) RETURNS TABLE(operation text, organization_id uuid, application_root_id uuid, registration_state text, registration_revision bigint, access_version bigint, correlation_id uuid)
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
        and dependency.evidence_fingerprint = source_value ->> 'resolutionFingerprint'
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
    source_validation_contract_version, source_content_fingerprint,
    source_resolution_fingerprint, source_catalogue_fingerprint, meaning_fingerprint,
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
    source.source_value ->> 'validationContractVersion',
    source.source_value ->> 'contentFingerprint',
    source.source_value ->> 'resolutionFingerprint', null,
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

set local role vortex_owner;

create or replace function vortex_access.coordinate_role_change_without_stewardship_v1_internal(
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
  prepared_templates jsonb;
  selected_template jsonb;
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
      'preparedTemplates', 'sourceRoleId', 'templateContinuityRevision'
    ])
      or pg_catalog.jsonb_typeof(candidate -> 'preparedTemplates') is distinct from 'object'
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
    prepared_templates := candidate -> 'preparedTemplates';
    target_source_role_id := (candidate ->> 'sourceRoleId')::uuid;
    target_template_continuity_revision :=
      (candidate ->> 'templateContinuityRevision')::numeric::bigint;
  elsif candidate ? 'preparedTemplates'
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
      'privilegeClassification', 'assignmentPolicy', 'preparedTemplates',
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
      'preparedTemplates', 'sourceRoleId', 'templateContinuityRevision', 'permissions'
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

  if prepared_templates is not null then
    if prepared_templates - array[
      'contractVersion', 'preparationBasis', 'permissionRegistration',
      'templates'
    ]::text[] <> '{}'::jsonb
      or not (prepared_templates ?& array[
        'contractVersion', 'preparationBasis', 'permissionRegistration',
        'templates'
      ])
      or prepared_templates ->> 'contractVersion' is distinct from '1.0.0'
      or pg_catalog.jsonb_typeof(prepared_templates -> 'preparationBasis') <> 'object'
      or (prepared_templates -> 'preparationBasis') - array[
        'kind', 'registrationRevision'
      ]::text[] <> '{}'::jsonb
      or not ((prepared_templates -> 'preparationBasis') ?& array[
        'kind', 'registrationRevision'
      ])
      or prepared_templates #>> '{preparationBasis,kind}' <>
        'current_active_registration'
      or pg_catalog.jsonb_typeof(
        prepared_templates #> '{preparationBasis,registrationRevision}'
      ) <> 'number'
      or (prepared_templates #>> '{preparationBasis,registrationRevision}')::numeric
        not between 1 and 9007199254740991
      or (prepared_templates #>> '{preparationBasis,registrationRevision}')::numeric <>
        pg_catalog.trunc(
          (prepared_templates #>> '{preparationBasis,registrationRevision}')::numeric
        )
      or pg_catalog.jsonb_typeof(prepared_templates -> 'permissionRegistration') <> 'object'
      or pg_catalog.jsonb_typeof(
        prepared_templates #> '{permissionRegistration,applicationRelease,releaseRevision}'
      ) <> 'number'
      or (prepared_templates #>>
        '{permissionRegistration,applicationRelease,releaseRevision}')::numeric
          not between 1 and 9007199254740991
      or (prepared_templates #>>
        '{permissionRegistration,applicationRelease,releaseRevision}')::numeric <>
          pg_catalog.trunc((prepared_templates #>>
            '{permissionRegistration,applicationRelease,releaseRevision}')::numeric)
      or pg_catalog.jsonb_typeof(prepared_templates -> 'templates') <> 'array'
      or pg_catalog.jsonb_array_length(prepared_templates -> 'templates') = 0 then
      raise exception using errcode = '22023',
        message = 'Prepared application role-template evidence is invalid';
    end if;

    target_accepted_registration_revision :=
      (prepared_templates #>> '{preparationBasis,registrationRevision}')::numeric::bigint;
    target_application_root_id :=
      (prepared_templates #>> '{permissionRegistration,applicationRootId}')::uuid;
    if (prepared_templates #>> '{permissionRegistration,organizationId}')::uuid <>
        target_organization_id
      or target_source_role_id = '00000000-0000-0000-0000-000000000000'::uuid
      or not vortex_access.application_permission_registration_matches_candidate(
        target_organization_id,
        target_application_root_id,
        target_accepted_registration_revision,
        prepared_templates -> 'permissionRegistration'
      ) then
      raise exception using errcode = '40001',
        message = 'Prepared application registration is stale or unavailable';
    end if;

    select pg_catalog.count(*), pg_catalog.jsonb_agg(item.value) -> 0
    into selected_template_count, selected_template
    from pg_catalog.jsonb_array_elements(prepared_templates -> 'templates') as item(value)
    where (item.value #>> '{template,roleId}')::uuid = target_source_role_id;
    if selected_template_count <> 1
      or pg_catalog.jsonb_typeof(selected_template) <> 'object'
      or selected_template - array['template', 'sourcePermissions', 'livePermissions']::text[]
        <> '{}'::jsonb
      or not (selected_template ?& array['template', 'sourcePermissions', 'livePermissions'])
      or pg_catalog.jsonb_typeof(selected_template -> 'template') <> 'object'
      or pg_catalog.jsonb_typeof(selected_template -> 'livePermissions') <> 'array'
      or pg_catalog.jsonb_array_length(selected_template -> 'livePermissions') = 0 then
      raise exception using errcode = '22023',
        message = 'Selected application role-template evidence is invalid';
    end if;

    target_source_definition_key :=
      prepared_templates #>> '{permissionRegistration,applicationRelease,definitionKey}';
    target_source_release_revision :=
      (prepared_templates #>>
        '{permissionRegistration,applicationRelease,releaseRevision}')::numeric::bigint;
    target_source_release_version :=
      prepared_templates #>> '{permissionRegistration,applicationRelease,releaseVersion}';
    target_source_validation_contract_version :=
      prepared_templates #>>
        '{permissionRegistration,applicationRelease,validationContractVersion}';
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
      and continuity.application_root_id is not distinct from
        case when item.value ? 'applicationRootId'
          then (item.value ->> 'applicationRootId')::uuid else null end
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
      and continuity.application_root_id is not distinct from
        case when item.value ? 'applicationRootId'
          then (item.value ->> 'applicationRootId')::uuid else null end
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

  if prepared_templates is not null then
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
      from pg_catalog.jsonb_array_elements(
        selected_template -> 'livePermissions'
      ) as live(value)
      where (live.value ->> 'applicationRootId')::uuid =
          (permission.value ->> 'applicationRootId')::uuid
        and live.value ->> 'ownerKind' = permission.value ->> 'ownerKind'
        and (live.value ->> 'ownerId')::uuid =
          (permission.value ->> 'ownerId')::uuid
        and (live.value #>> '{permission,permissionId}')::uuid =
          (permission.value ->> 'permissionId')::uuid
        and live.value ->> 'meaningFingerprint' =
          permission.value ->> 'meaningFingerprint'
    );
    if permission_count <> pg_catalog.jsonb_array_length(candidate_permissions)
      or (
        operation_name in ('accept_new_application_role', 'accept_application_role_revision')
        and permission_count <>
          pg_catalog.jsonb_array_length(selected_template -> 'livePermissions')
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
      and continuity.application_root_id is not distinct from
        case when item.value ? 'applicationRootId'
          then (item.value ->> 'applicationRootId')::uuid else null end
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

set local role postgres;
-- guard-allow: migration-owner-role Existing function retains postgres ownership until baseline table policies migrate.
CREATE OR REPLACE FUNCTION vortex_access.initialize_platform_permission_catalogue_v1(p_organization_id uuid, p_changed_by uuid, p_correlation_id uuid) RETURNS TABLE(organization_id uuid, registration_revision bigint, access_version bigint)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $_$
declare
  operation_at timestamptz := pg_catalog.statement_timestamp();
  current_registration vortex_access.permission_registrations%rowtype;
  resulting_version bigint;
  catalogue_fingerprint constant text := 'sha256:a6c3e01332980bc030d1492608853b8905c34fa661682e90ae5fcb23287c4930';
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
      'label', 'View teams',
      'description', 'View the selected organisation''s Teams and membership administration data.',
      'actionKind', 'read',
      'meaningFingerprint', 'sha256:cfb428fda5934cc18c54bc71bcbb4b6e7038714550587b189df0a3c0a3e44f8a'
    ),
    pg_catalog.jsonb_build_object(
      -- guard-allow: function-uuid fixed platform permission identity without declaration-table read access
      'permissionId', '6185dc64-464b-4776-97dc-c64a6f299550',
      'key', 'platform.organization.groups.manage',
      'label', 'Manage teams',
      'description', 'Manage Teams and memberships subject to delegated scope and permanent-steward safeguards.',
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
    )
  );
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
    -- guard-allow: function-uuid fixed platform permission identity without declaration-table read access
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
    organization_id, registration_kind, registration_owner_id, revision, state, operation, source_definition_key, source_version, source_revision, validation_contract_version, permission_catalogue_fingerprint, candidate_fingerprint, changed_at, changed_by, change_correlation_id
  ) values (
    -- guard-allow: function-uuid fixed platform permission identity without declaration-table read access
    p_organization_id, 'platform', 'cabe121e-0baf-4084-9471-cce915d460a8', 1, 'active', 'platform_initialize', null, '1.0.0', null, null, catalogue_fingerprint, catalogue_fingerprint, operation_at, p_changed_by, p_correlation_id
  );

  insert into vortex_access.permission_catalogue_entries (
    organization_id, registration_kind, registration_owner_id, registration_revision,
    application_root_id, owner_kind, owner_id, permission_id, permission_key,
    label, description, record_type_id, action_kind, named_action, administrative,
    source_kind, source_definition_key, source_root_id, source_version, source_revision,
    source_validation_contract_version, source_content_fingerprint,
    source_resolution_fingerprint, source_catalogue_fingerprint, meaning_fingerprint
  )
  -- guard-allow: function-uuid fixed platform permission identity without declaration-table read access
  select p_organization_id, 'platform', 'cabe121e-0baf-4084-9471-cce915d460a8', 1,
    -- guard-allow: function-uuid fixed platform permission identity without declaration-table read access
    null, 'platform', 'cabe121e-0baf-4084-9471-cce915d460a8',
    (entry ->> 'permissionId')::uuid, entry ->> 'key', entry ->> 'label',
    entry ->> 'description', null, entry ->> 'actionKind', null, true,
    'platform_catalogue', null, null, '1.0.0', null, null, null, null,
    catalogue_fingerprint, entry ->> 'meaningFingerprint'
  from pg_catalog.jsonb_array_elements(catalogue_entries) as item(entry);

  insert into vortex_access.permission_registrations (
    organization_id, registration_kind, registration_owner_id, state, revision, source_definition_key, source_version, source_revision, validation_contract_version, permission_catalogue_fingerprint, candidate_fingerprint, changed_at, changed_by, change_correlation_id
  ) values (
    -- guard-allow: function-uuid fixed platform permission identity without declaration-table read access
    p_organization_id, 'platform', 'cabe121e-0baf-4084-9471-cce915d460a8', 'active', 1, null, '1.0.0', null, null, catalogue_fingerprint, catalogue_fingerprint, operation_at, p_changed_by, p_correlation_id
  );

  select incremented.current_version into resulting_version
  from vortex_access.increment_organization_access_version(
    p_organization_id, p_changed_by, p_correlation_id, 'application_access_changed'
  ) as incremented;
  return query select p_organization_id, 1::bigint, resulting_version;
end
$_$;

set local role vortex_owner;

set local role postgres;
-- guard-allow: migration-owner-role Existing function retains postgres ownership until baseline table policies migrate.
CREATE OR REPLACE FUNCTION vortex_access.list_application_role_templates_for_administration(p_after_application_root_id uuid, p_after_source_role_id uuid, p_page_size integer) RETURNS TABLE(organization_id uuid, templates jsonb, next_after_application_root_id uuid, next_after_source_role_id uuid, access_version bigint)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  scope record;
  template_items jsonb;
  page_application_root_ids uuid[];
  page_source_role_ids uuid[];
  candidate_count integer;
  cursor_absent boolean;
begin
  cursor_absent := p_after_application_root_id is null
    and p_after_source_role_id is null;
  if p_page_size is null or p_page_size not between 1 and 100
    or (
      cursor_absent
      or (
        p_after_application_root_id is not null
        and p_after_source_role_id is not null
      )
    ) is not true
    or p_after_application_root_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_after_source_role_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using errcode = '22023',
      message = 'Application role template page input is invalid';
  end if;

  select authorized.* into strict scope
  from vortex_access.organization_roles_administration_scope() as authorized;

  with candidates as (
    select registration.registration_owner_id as application_root_id,
      (template.value ->> 'roleId')::uuid as source_role_id,
      template.value ->> 'key' as role_key,
      template.value ->> 'name' as role_label,
      template.value #>> '{permissionSelection,kind}' as permission_selection_kind,
      template.value -> 'permissionKeys' as permission_keys,
      pg_catalog.row_number() over (
        order by registration.registration_owner_id,
          (template.value ->> 'roleId')::uuid
      ) as ordinal
    from vortex_access.permission_registrations as registration
    join vortex_definition.roots as root
      on root.root_id = registration.registration_owner_id
      and root.organization_id = registration.organization_id
      and root.kind = 'application'
      and root.key = registration.source_definition_key
    join vortex_definition.releases as release
      on release.root_id = root.root_id
      and release.release_revision = registration.source_revision
      and release.release_version = registration.source_version
      and release.validation_contract_version = registration.validation_contract_version
    cross join lateral pg_catalog.jsonb_array_elements(
      release.compilation_output #> '{canonical,content,roles}'
    ) as template(value)
    join vortex_access.application_role_template_continuities as continuity
      on continuity.organization_id = registration.organization_id
      and continuity.application_root_id = registration.registration_owner_id
      and continuity.source_role_id = (template.value ->> 'roleId')::uuid
      and continuity.state = 'available'
      and continuity.last_processed_registration_revision = registration.revision
    where registration.organization_id = scope.organization_id
      and registration.registration_kind = 'application'
      and registration.state = 'active'
      and (
        cursor_absent
        or (
          registration.registration_owner_id,
          (template.value ->> 'roleId')::uuid
        ) > (p_after_application_root_id, p_after_source_role_id)
      )
    order by registration.registration_owner_id,
      (template.value ->> 'roleId')::uuid
    limit p_page_size + 1
  )
  select coalesce(
      pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'reference', pg_catalog.jsonb_build_object(
            'applicationRootId', candidate.application_root_id,
            'sourceRoleId', candidate.source_role_id
          ),
          'key', candidate.role_key,
          'label', candidate.role_label,
          'permissionSelectionKind', candidate.permission_selection_kind,
          'publishedPermissionKeys', candidate.permission_keys
        ) order by candidate.application_root_id, candidate.source_role_id
      ) filter (where candidate.ordinal <= p_page_size),
      '[]'::jsonb
    ),
    pg_catalog.array_agg(candidate.application_root_id order by candidate.ordinal)
      filter (where candidate.ordinal <= p_page_size),
    pg_catalog.array_agg(candidate.source_role_id order by candidate.ordinal)
      filter (where candidate.ordinal <= p_page_size),
    pg_catalog.count(*)
  into template_items, page_application_root_ids, page_source_role_ids,
    candidate_count
  from candidates as candidate;

  return query select scope.organization_id, template_items,
    case when candidate_count > p_page_size
      then page_application_root_ids[p_page_size] else null end,
    case when candidate_count > p_page_size
      then page_source_role_ids[p_page_size] else null end,
    scope.access_version;
end
$$;

set local role vortex_owner;

set local role postgres;
-- guard-allow: migration-owner-role Existing function retains postgres ownership until baseline table policies migrate.
create or replace function vortex_access.list_application_role_templates_projection(
  p_record_id uuid,
  p_page_size integer
)
returns table (
  organization_id uuid,
  record_id uuid,
  revision bigint,
  attribute_values jsonb
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  scope_row record;
  application_row record;
  template_value jsonb;
  source_role_id_value uuid;
  seen_role_ids uuid[];
  valid_roles boolean;
begin
  begin
    select authorized.* into strict scope_row
    from vortex_access.organization_roles_administration_scope() as authorized;
  exception
    when insufficient_privilege then
      return;
  end;

  -- Catalogue authority and current installed-application reachability are both
  -- required. Neither the organization nor the application is a caller input.
  for application_row in
    select root.root_id, registration.revision as registration_revision,
      release.compilation_output #> '{canonical,content,roles}' as roles
    from vortex_access.list_installed_applications_projection(
      null::uuid, null::integer
    ) as installed
    join vortex_access.permission_registrations as registration
      on registration.organization_id = installed.organization_id
      and registration.registration_owner_id = installed.record_id
      and registration.revision = installed.revision
      and registration.registration_kind = 'application'
      and registration.state = 'active'
    join vortex_definition.roots as root
      on root.root_id = registration.registration_owner_id
      and root.organization_id = registration.organization_id
      and root.kind = 'application'
      and root.key = registration.source_definition_key
    join vortex_definition.releases as release
      on release.root_id = root.root_id
      and release.release_revision = registration.source_revision
      and release.release_version = registration.source_version
      and release.validation_contract_version = registration.validation_contract_version
    where registration.organization_id = scope_row.organization_id
      and release.compilation_output ->> 'kind' = 'application'
    order by root.root_id
  loop
    if pg_catalog.jsonb_typeof(application_row.roles) is distinct from 'array' then
      continue;
    end if;
    if pg_catalog.jsonb_array_length(application_row.roles) not between 1 and 100 then
      continue;
    end if;
    seen_role_ids := array[]::uuid[];
    valid_roles := true;
    -- Validate the complete array before returning any row. Duplicate UUIDs,
    -- including alternate casing, cannot become duplicate ordinary record IDs.
    for template_value in
      select template.value
      from pg_catalog.jsonb_array_elements(application_row.roles) as template(value)
    loop
      if pg_catalog.jsonb_typeof(template_value) is distinct from 'object'
        or pg_catalog.jsonb_typeof(template_value -> 'roleId') is distinct from 'string'
        or not vortex_platform.is_non_nil_uuid(template_value ->> 'roleId')
        or pg_catalog.jsonb_typeof(template_value -> 'key') is distinct from 'string'
        or pg_catalog.char_length(template_value ->> 'key') not between 1 and 40
        or (template_value ->> 'key') !~ '^[a-z][a-z0-9]*(_[a-z0-9]+)*$'
        or pg_catalog.jsonb_typeof(template_value -> 'name') is distinct from 'string'
        or pg_catalog.char_length(template_value ->> 'name') not between 1 and 60 then
        valid_roles := false;
        exit;
      end if;
      source_role_id_value := (template_value ->> 'roleId')::uuid;
      if source_role_id_value = any(seen_role_ids)
        or not vortex_definition.application_role_identity_is_exact_for_human_request_internal(
          application_row.root_id, source_role_id_value
        ) then
        valid_roles := false;
        exit;
      end if;
      seen_role_ids := pg_catalog.array_append(seen_role_ids, source_role_id_value);
    end loop;
    if not valid_roles then
      continue;
    end if;

    -- Generic Query applies its own filter and pagination after this relation;
    -- p_page_size must not truncate it before those predicates are evaluated.
    -- Registration revision is the row concurrency number. Continuity revision
    -- changes only on availability transitions and remains a separate attribute.
    return query
    select scope_row.organization_id,
      (template.value ->> 'roleId')::uuid,
      application_row.registration_revision,
      pg_catalog.jsonb_build_object(
        'application_root_id', application_row.root_id,
        'source_role_id', (template.value ->> 'roleId')::uuid,
        'key', template.value ->> 'key',
        'label', template.value ->> 'name',
        'continuity_revision', continuity.continuity_revision
      )
    from pg_catalog.jsonb_array_elements(application_row.roles) as template(value)
    join vortex_access.application_role_template_continuities as continuity
      on continuity.organization_id = scope_row.organization_id
      and continuity.application_root_id = application_row.root_id
      and continuity.source_role_id = (template.value ->> 'roleId')::uuid
      and continuity.state = 'available'
      and continuity.last_processed_registration_revision = application_row.registration_revision
    where p_record_id is null or p_record_id = (template.value ->> 'roleId')::uuid
    order by (template.value ->> 'roleId')::uuid;
  end loop;
end
$function$;

set local role vortex_owner;

set local role postgres;
-- guard-allow: migration-owner-role Existing function retains postgres ownership until baseline table policies migrate.
create or replace function vortex_access.list_installed_applications_projection(
  p_record_id uuid,
  p_page_size integer
)
returns table (
  organization_id uuid,
  record_id uuid,
  revision bigint,
  attribute_values jsonb
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  context_value jsonb;
  visible_organization_id uuid;
  actor_identity_id uuid;
  default_application_root_id uuid;
begin
  -- The projection keeps today's row visibility inside itself and neither the
  -- organisation nor the application is ever an input. An installed application is
  -- exactly the row the permitted-applications feed derives: an active application
  -- registration of the organisation whose published release still matches every
  -- fingerprint and whose installation binding is itself active, so a provisioned
  -- or draining installation is not an installed application. Each derived row is
  -- then authorised individually through the same application scope resolution the
  -- feed uses, so a viewer the scope refuses sees no row for that application,
  -- exactly as a missing or foreign record, and the record adapters return their
  -- identical refusal and a list page is empty rather than failing. The record
  -- identity is the application root and the revision is the registration's own
  -- revision, which every installation change advances. Compilation output,
  -- fingerprints, release evidence, binding evidence and the whole module set are
  -- never projected.
  begin
    context_value := vortex_access.validated_human_request_context();
  exception
    when insufficient_privilege then
      return;
  end;
  visible_organization_id := (context_value ->> 'organizationId')::uuid;
  actor_identity_id := (context_value ->> 'identityId')::uuid;
  if not vortex_platform.is_non_nil_uuid(visible_organization_id::text)
    or not vortex_platform.is_non_nil_uuid(actor_identity_id::text) then
    return;
  end if;
  begin
    perform 1
    from vortex_access.resolve_human_organization_scope(
      actor_identity_id, visible_organization_id
    ) as scope;
  exception
    when sqlstate '42501' or sqlstate 'P0002' then
      return;
  end;
  select settings.default_application_root_id into default_application_root_id
  from vortex_identity.organization_runtime_settings as settings
  where settings.organization_id = visible_organization_id;
  return query
    select
      visible_organization_id,
      root.root_id,
      registration.revision,
      pg_catalog.jsonb_build_object(
        'key', root.key,
        'release_revision', registration.source_revision,
        'is_default', root.root_id is not distinct from default_application_root_id
      )
    from vortex_access.permission_registrations as registration
    join vortex_definition.roots as root
      on root.root_id = registration.registration_owner_id
      and root.organization_id = registration.organization_id
      and root.kind = 'application'
      and root.key = registration.source_definition_key
    join vortex_definition.releases as release
      on release.root_id = root.root_id
      and release.release_revision = registration.source_revision
      and release.release_version = registration.source_version
      and release.validation_contract_version = registration.validation_contract_version
    where registration.organization_id = visible_organization_id
      and registration.registration_kind = 'application'
      and registration.state = 'active'
      and (p_record_id is null or p_record_id = root.root_id)
      and release.compilation_output ->> 'kind' = 'application'
      and exists (
        select 1
        from vortex_definition.installation_bindings as binding
        where binding.organization_id = visible_organization_id
          and binding.application_root_id = root.root_id
          and binding.application_release_revision = registration.source_revision
          and binding.state = 'active'
      )
    order by root.key collate "C", root.root_id;
end
$function$;

set local role vortex_owner;

set local role postgres;
-- guard-allow: migration-owner-role Existing function retains postgres ownership until baseline table policies migrate.
create or replace function vortex_access.list_landing_zone_applications_projection(
  p_record_id uuid,
  p_page_size integer
)
returns table (
  organization_id uuid,
  record_id uuid,
  revision bigint,
  attribute_values jsonb
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  context_value jsonb;
  visible_organization_id uuid;
  actor_identity_id uuid;
begin
  -- Row visibility matches the installed-application projection: the viewer's
  -- validated human request context selects the organisation and identity; only
  -- active application registrations whose published release still matches both
  -- fingerprints and whose installation binding is active are considered; and
  -- each application must pass the same human application-scope resolution. A
  -- refused, uninstalled or withdrawn application therefore has no row, exactly
  -- like a missing record. The record identity is the application root and its
  -- revision is the registration revision. Only the application key, name and
  -- icon are projected; compilation output, pages, roles, fingerprints, release
  -- evidence and installation evidence are never returned. Page access is not
  -- evaluated here.
  begin
    context_value := vortex_access.validated_human_request_context();
  exception
    when insufficient_privilege then
      return;
  end;
  visible_organization_id := (context_value ->> 'organizationId')::uuid;
  actor_identity_id := (context_value ->> 'identityId')::uuid;
  if not vortex_platform.is_non_nil_uuid(visible_organization_id::text)
    or not vortex_platform.is_non_nil_uuid(actor_identity_id::text) then
    return;
  end if;
  begin
    perform 1
    from vortex_access.resolve_human_organization_scope(
      actor_identity_id, visible_organization_id
    ) as scope;
  exception
    when sqlstate '42501' or sqlstate 'P0002' then
      return;
  end;
  return query
    select
      visible_organization_id,
      root.root_id,
      registration.revision,
      pg_catalog.jsonb_build_object(
        'key', root.key,
        'name', release.compilation_output #>> '{canonical,content,name}',
        'icon', release.compilation_output #>> '{canonical,content,icon}'
      )
    from vortex_access.permission_registrations as registration
    join vortex_definition.roots as root
      on root.root_id = registration.registration_owner_id
      and root.organization_id = registration.organization_id
      and root.kind = 'application'
      and root.key = registration.source_definition_key
    join vortex_definition.releases as release
      on release.root_id = root.root_id
      and release.release_revision = registration.source_revision
      and release.release_version = registration.source_version
      and release.validation_contract_version = registration.validation_contract_version
    where registration.organization_id = visible_organization_id
      and registration.registration_kind = 'application'
      and registration.state = 'active'
      and (p_record_id is null or p_record_id = root.root_id)
      and release.compilation_output ->> 'kind' = 'application'
      and exists (
        select 1
        from vortex_definition.installation_bindings as binding
        where binding.organization_id = visible_organization_id
          and binding.application_root_id = root.root_id
          and binding.application_release_revision = registration.source_revision
          and binding.state = 'active'
      )
    order by root.key collate "C", root.root_id;
end
$function$;

set local role vortex_owner;

set local role postgres;
-- guard-allow: migration-owner-role Existing function retains postgres ownership until baseline table policies migrate.
create or replace function vortex_access.platform_permission_catalogue_revision_is_exact(
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
  -- guard-allow: function-uuid fixed platform permission identity without declaration-table read access
  platform_owner_id constant uuid := 'cabe121e-0baf-4084-9471-cce915d460a8';
  nil_uuid constant uuid := '00000000-0000-0000-0000-000000000000';
  registration_exact boolean;
begin
  if p_organization_id is null
    or p_organization_id = nil_uuid
    or p_registration_revision is null
    or p_registration_revision not between 1 and 9007199254740991 then
    return false;
  end if;

  with expected as materialized (
    select
      declaration.declared_current_revision,
      declaration.registration_revision,
      declaration.source_version,
      declaration.catalogue_fingerprint,
      declaration.permission_id,
      declaration.permission_key,
      declaration.action_kind,
      declaration.label,
      declaration.description,
      declaration.meaning_fingerprint,
      declaration.steward_minimum,
      declaration.first_revision
    from vortex_access.read_platform_permission_declaration_catalogue_internal(
      p_registration_revision
    ) as declaration
  ),
  expected_stats as (
    select
      pg_catalog.count(*) as entry_count,
      pg_catalog.count(distinct expected.permission_id) as distinct_permission_ids,
      pg_catalog.count(distinct expected.permission_key) as distinct_permission_keys,
      pg_catalog.count(distinct expected.declared_current_revision)
        as distinct_declared_current_revisions,
      pg_catalog.count(distinct expected.registration_revision)
        as distinct_registration_revisions,
      pg_catalog.count(distinct expected.source_version) as distinct_source_versions,
      pg_catalog.count(distinct expected.catalogue_fingerprint)
        as distinct_catalogue_fingerprints,
      pg_catalog.min(expected.declared_current_revision) as declared_current_revision,
      pg_catalog.min(expected.registration_revision) as registration_revision,
      pg_catalog.min(expected.source_version) as source_version,
      pg_catalog.min(expected.catalogue_fingerprint) as catalogue_fingerprint
    from expected
  ),
  current_entries as materialized (
    select entry.*
    from vortex_access.permission_catalogue_entries as entry
    where entry.organization_id = p_organization_id
      and entry.registration_kind = 'platform'
      and entry.registration_owner_id = platform_owner_id
      and entry.registration_revision = p_registration_revision
  ),
  current_stats as (
    select
      pg_catalog.count(*) as entry_count,
      pg_catalog.count(distinct current_entry.permission_id) as distinct_permission_ids,
      pg_catalog.count(distinct current_entry.permission_key) as distinct_permission_keys
    from current_entries as current_entry
  ),
  predecessor_expected as (
    select expected.*
    from expected
    where p_registration_revision in (4, 5, 6)
      and expected.first_revision <= case p_registration_revision
        when 4 then 3
        when 5 then 4
        when 6 then 5
      end
  ),
  predecessor_expected_stats as (
    select
      pg_catalog.count(*) as entry_count,
      pg_catalog.count(distinct expected.permission_id) as distinct_permission_ids,
      pg_catalog.count(distinct expected.permission_key) as distinct_permission_keys
    from predecessor_expected as expected
  ),
  predecessor_entries as materialized (
    select entry.*
    from vortex_access.permission_catalogue_entries as entry
    where p_registration_revision in (4, 5, 6)
      and entry.organization_id = p_organization_id
      and entry.registration_kind = 'platform'
      and entry.registration_owner_id = platform_owner_id
      and entry.registration_revision = case p_registration_revision
        when 4 then 3
        when 5 then 4
        when 6 then 5
      end
  ),
  predecessor_stats as (
    select
      pg_catalog.count(*) as entry_count,
      pg_catalog.count(distinct previous.permission_id) as distinct_permission_ids,
      pg_catalog.count(distinct previous.permission_key) as distinct_permission_keys
    from predecessor_entries as previous
  ),
  continuity_entries as materialized (
    select continuity.*
    from vortex_access.permission_continuities as continuity
    where p_registration_revision >= 4
      and continuity.organization_id = p_organization_id
      and continuity.application_root_id is null
      and continuity.registration_kind = 'platform'
      and continuity.registration_owner_id = platform_owner_id
  ),
  continuity_stats as (
    select
      pg_catalog.count(*) as entry_count,
      pg_catalog.count(distinct continuity.permission_id) as distinct_permission_ids,
      pg_catalog.count(*) filter (where continuity.state = 'available')
        as available_entry_count
    from continuity_entries as continuity
  )
  select coalesce(
    expected_stats.entry_count > 0
    and expected_stats.entry_count = expected_stats.distinct_permission_ids
    and expected_stats.entry_count = expected_stats.distinct_permission_keys
    and expected_stats.distinct_declared_current_revisions = 1
    and expected_stats.distinct_registration_revisions = 1
    and expected_stats.distinct_source_versions = 1
    and expected_stats.distinct_catalogue_fingerprints = 1
    and expected_stats.registration_revision = p_registration_revision
    and expected_stats.declared_current_revision >= expected_stats.registration_revision
    and expected_stats.entry_count = current_stats.entry_count
    and current_stats.entry_count = current_stats.distinct_permission_ids
    and current_stats.entry_count = current_stats.distinct_permission_keys
    and (
      select pg_catalog.count(*) = 1
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
        and registration.revision = p_registration_revision
        and registration.source_definition_key is null
        and registration.source_version = expected_stats.source_version
        and registration.source_revision is null
        and registration.validation_contract_version is null
        and registration.permission_catalogue_fingerprint =
          expected_stats.catalogue_fingerprint
        and registration.candidate_fingerprint = expected_stats.catalogue_fingerprint
        and registration.changed_at <> '-infinity'::timestamptz
        and registration.changed_at <> 'infinity'::timestamptz
        and registration.changed_by is not null
        and registration.changed_by <> nil_uuid
        and registration.change_correlation_id is not null
        and registration.change_correlation_id <> nil_uuid
        and history.operation = case
          when p_registration_revision = 1 then 'platform_initialize'
          when p_registration_revision >= 7
            and not exists (
              select 1
              from vortex_access.permission_registration_revisions as prior_history
              where prior_history.organization_id = p_organization_id
                and prior_history.registration_kind = 'platform'
                and prior_history.registration_owner_id = platform_owner_id
                and prior_history.revision < p_registration_revision
            )
            then 'platform_initialize'
          else 'platform_metadata_revision'
        end
        and history.state = 'active'
        and history.source_definition_key is null
        and history.source_version = expected_stats.source_version
        and history.source_revision is null
        and history.validation_contract_version is null
        and history.permission_catalogue_fingerprint =
          expected_stats.catalogue_fingerprint
        and history.candidate_fingerprint = expected_stats.catalogue_fingerprint
        and history.changed_at <> '-infinity'::timestamptz
        and history.changed_at <> 'infinity'::timestamptz
        and history.changed_by is not null
        and history.changed_by <> nil_uuid
        and history.change_correlation_id is not null
        and history.change_correlation_id <> nil_uuid
        and row(
          registration.state,
          registration.source_definition_key,
          registration.source_version,
          registration.source_revision,
          registration.validation_contract_version,
          registration.permission_catalogue_fingerprint,
          registration.candidate_fingerprint,
          registration.changed_at,
          registration.changed_by,
          registration.change_correlation_id
        ) is not distinct from row(
          history.state,
          history.source_definition_key,
          history.source_version,
          history.source_revision,
          history.validation_contract_version,
          history.permission_catalogue_fingerprint,
          history.candidate_fingerprint,
          history.changed_at,
          history.changed_by,
          history.change_correlation_id
        )
        and not exists (
          select 1
          from vortex_access.permission_registration_revisions as later_history
          where later_history.organization_id = p_organization_id
            and later_history.registration_kind = 'platform'
            and later_history.registration_owner_id = platform_owner_id
            and later_history.revision > p_registration_revision
        )
    )
    and not exists (
      select 1
      from expected
      where not exists (
        select 1
        from current_entries as current_entry
        where row(
          current_entry.application_root_id,
          current_entry.owner_kind,
          current_entry.owner_id,
          current_entry.permission_id,
          current_entry.permission_key,
          current_entry.label,
          current_entry.description,
          current_entry.record_type_id,
          current_entry.record_scope,
          current_entry.field_policy,
          current_entry.action_kind,
          current_entry.named_action,
          current_entry.administrative,
          current_entry.source_kind,
          current_entry.source_definition_key,
          current_entry.source_root_id,
          current_entry.source_version,
          current_entry.source_revision,
          current_entry.source_validation_contract_version,
          current_entry.source_content_fingerprint,
          current_entry.source_resolution_fingerprint,
          current_entry.source_catalogue_fingerprint,
          current_entry.meaning_fingerprint
        ) is not distinct from row(
          null::uuid,
          'platform'::text,
          platform_owner_id,
          expected.permission_id,
          expected.permission_key,
          expected.label,
          expected.description,
          null::uuid,
          null::jsonb,
          null::jsonb,
          expected.action_kind,
          null::text,
          true,
          'platform_catalogue'::text,
          null::text,
          null::uuid,
          expected.source_version,
          null::bigint,
          null::text,
          null::text,
          null::text,
          expected.catalogue_fingerprint,
          expected.meaning_fingerprint
        )
      )
    )
    and not exists (
      select 1
      from current_entries as current_entry
      where not exists (
        select 1
        from expected
        where row(
          current_entry.application_root_id,
          current_entry.owner_kind,
          current_entry.owner_id,
          current_entry.permission_id,
          current_entry.permission_key,
          current_entry.label,
          current_entry.description,
          current_entry.record_type_id,
          current_entry.record_scope,
          current_entry.field_policy,
          current_entry.action_kind,
          current_entry.named_action,
          current_entry.administrative,
          current_entry.source_kind,
          current_entry.source_definition_key,
          current_entry.source_root_id,
          current_entry.source_version,
          current_entry.source_revision,
          current_entry.source_validation_contract_version,
          current_entry.source_content_fingerprint,
          current_entry.source_resolution_fingerprint,
          current_entry.source_catalogue_fingerprint,
          current_entry.meaning_fingerprint
        ) is not distinct from row(
          null::uuid,
          'platform'::text,
          platform_owner_id,
          expected.permission_id,
          expected.permission_key,
          expected.label,
          expected.description,
          null::uuid,
          null::jsonb,
          null::jsonb,
          expected.action_kind,
          null::text,
          true,
          'platform_catalogue'::text,
          null::text,
          null::uuid,
          expected.source_version,
          null::bigint,
          null::text,
          null::text,
          null::text,
          expected.catalogue_fingerprint,
          expected.meaning_fingerprint
        )
      )
    )
    and (
      p_registration_revision not in (4, 5, 6)
      or (
        predecessor_expected_stats.entry_count = case p_registration_revision
          when 4 then 14
          when 5 then 15
          when 6 then 18
        end
        and predecessor_expected_stats.entry_count =
          predecessor_expected_stats.distinct_permission_ids
        and predecessor_expected_stats.entry_count =
          predecessor_expected_stats.distinct_permission_keys
        and predecessor_stats.entry_count = predecessor_expected_stats.entry_count
        and predecessor_stats.entry_count = predecessor_stats.distinct_permission_ids
        and predecessor_stats.entry_count = predecessor_stats.distinct_permission_keys
        and not exists (
          select 1
          from predecessor_expected as expected_previous
          where not exists (
            select 1
            from predecessor_entries as previous
            where previous.owner_kind = 'platform'
              and previous.owner_id = platform_owner_id
              and previous.permission_id = expected_previous.permission_id
          )
        )
        and not exists (
          select 1
          from predecessor_entries as previous
          where previous.owner_kind is distinct from 'platform'
            or previous.owner_id is distinct from platform_owner_id
            or not exists (
              select 1
              from predecessor_expected as expected_previous
              where expected_previous.permission_id = previous.permission_id
            )
        )
        and not exists (
          select 1
          from predecessor_entries as previous
          left join current_entries as current_entry
            on current_entry.organization_id = previous.organization_id
            and current_entry.registration_kind = previous.registration_kind
            and current_entry.registration_owner_id = previous.registration_owner_id
            and current_entry.owner_kind = previous.owner_kind
            and current_entry.owner_id = previous.owner_id
            and current_entry.permission_id = previous.permission_id
          where current_entry.permission_id is null
            or row(
              current_entry.organization_id,
              current_entry.registration_kind,
              current_entry.registration_owner_id,
              current_entry.application_root_id,
              current_entry.owner_kind,
              current_entry.owner_id,
              current_entry.permission_id,
              current_entry.permission_key,
              current_entry.label,
              current_entry.description,
              current_entry.record_type_id,
              current_entry.record_scope,
              current_entry.field_policy,
              current_entry.action_kind,
              current_entry.named_action,
              current_entry.administrative,
              current_entry.source_kind,
              current_entry.source_definition_key,
              current_entry.source_root_id,
              current_entry.source_revision,
              current_entry.source_validation_contract_version,
              current_entry.source_content_fingerprint,
              current_entry.source_resolution_fingerprint,
              current_entry.meaning_fingerprint
            ) is distinct from row(
              previous.organization_id,
              previous.registration_kind,
              previous.registration_owner_id,
              previous.application_root_id,
              previous.owner_kind,
              previous.owner_id,
              previous.permission_id,
              previous.permission_key,
              previous.label,
              previous.description,
              previous.record_type_id,
              previous.record_scope,
              previous.field_policy,
              previous.action_kind,
              previous.named_action,
              previous.administrative,
              previous.source_kind,
              previous.source_definition_key,
              previous.source_root_id,
              previous.source_revision,
              previous.source_validation_contract_version,
              previous.source_content_fingerprint,
              previous.source_resolution_fingerprint,
              previous.meaning_fingerprint
            )
        )
      )
    )
    and (
      p_registration_revision < 4
      or (
        continuity_stats.entry_count = expected_stats.entry_count
        and continuity_stats.entry_count = continuity_stats.distinct_permission_ids
        and continuity_stats.available_entry_count = expected_stats.entry_count
        and not exists (
          select 1
          from expected
          where not exists (
            select 1
            from continuity_entries as continuity
            where continuity.owner_kind = 'platform'
              and continuity.owner_id = platform_owner_id
              and continuity.permission_id = expected.permission_id
              and continuity.state = 'available'
              and continuity.continuity_revision > 0
              and continuity.meaning_fingerprint = expected.meaning_fingerprint
              and continuity.last_processed_registration_revision =
                p_registration_revision
          )
        )
      )
    ),
    false
  )
  into registration_exact
  from expected_stats
  cross join current_stats
  cross join predecessor_expected_stats
  cross join predecessor_stats
  cross join continuity_stats;

  return coalesce(registration_exact, false);
end
$function$;

set local role vortex_owner;

set local role postgres;
-- guard-allow: migration-owner-role Existing function retains postgres ownership until baseline table policies migrate.
CREATE OR REPLACE FUNCTION vortex_access.platform_permission_catalogue_revision_is_exact_v1_0_1(p_organization_id uuid, p_registration_revision bigint) RETURNS boolean
    LANGUAGE plpgsql STABLE
    SET search_path TO ''
    AS $_$
declare
  -- guard-allow: function-uuid fixed platform permission identity without declaration-table read access
  platform_owner_id constant uuid := 'cabe121e-0baf-4084-9471-cce915d460a8';
  historical_catalogue_fingerprint constant text :=
    'sha256:a6c3e01332980bc030d1492608853b8905c34fa661682e90ae5fcb23287c4930';
  current_catalogue_fingerprint constant text :=
    'sha256:94733e5bba0c59d8b81693c78711b34f87bc7ff82c68f705d343cdacda990058';
  current_catalogue constant jsonb := pg_catalog.jsonb_build_array(
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
    )
  );
  expected_catalogue jsonb;
  expected_source_version text;
  expected_catalogue_fingerprint text;
  expected_operation text;
  registration_exact boolean;
  entry_count_exact boolean;
begin
  if p_organization_id is null
    or p_organization_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_registration_revision not in (1, 2) then
    return false;
  end if;

  if p_registration_revision = 1 then
    expected_source_version := '1.0.0';
    expected_catalogue_fingerprint := historical_catalogue_fingerprint;
    expected_operation := 'platform_initialize';
    select pg_catalog.jsonb_agg(
      case item.value ->> 'key'
        when 'platform.organization.groups.read' then item.value || pg_catalog.jsonb_build_object(
          'label', 'View teams',
          'description', 'View the selected organisation''s Teams and membership administration data.'
        )
        when 'platform.organization.groups.manage' then item.value || pg_catalog.jsonb_build_object(
          'label', 'Manage teams',
          'description', 'Manage Teams and memberships subject to delegated scope and permanent-steward safeguards.'
        )
        else item.value
      end
      order by item.ordinality
    ) into expected_catalogue
    from pg_catalog.jsonb_array_elements(current_catalogue) with ordinality as item(value, ordinality);
  else
    expected_source_version := '1.0.1';
    expected_catalogue_fingerprint := current_catalogue_fingerprint;
    expected_operation := 'platform_metadata_revision';
    expected_catalogue := current_catalogue;
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
    and registration.revision = p_registration_revision
    and registration.source_definition_key is null
    and registration.source_version = expected_source_version
    and registration.source_revision is null
    and registration.validation_contract_version is null
    and registration.permission_catalogue_fingerprint = expected_catalogue_fingerprint
    and registration.candidate_fingerprint = expected_catalogue_fingerprint
    and history.operation = expected_operation
    and row(
      registration.state, registration.source_definition_key, registration.source_version,
      registration.source_revision, registration.validation_contract_version,
      registration.permission_catalogue_fingerprint, registration.candidate_fingerprint,
      registration.changed_at, registration.changed_by, registration.change_correlation_id
    ) is not distinct from row(
      history.state, history.source_definition_key, history.source_version,
      history.source_revision, history.validation_contract_version,
      history.permission_catalogue_fingerprint, history.candidate_fingerprint,
      history.changed_at, history.changed_by, history.change_correlation_id
    );

  select pg_catalog.count(*) = pg_catalog.jsonb_array_length(expected_catalogue)
    into entry_count_exact
  from vortex_access.permission_catalogue_entries as entry
  where entry.organization_id = p_organization_id
    and entry.registration_kind = 'platform'
    and entry.registration_owner_id = platform_owner_id
    and entry.registration_revision = p_registration_revision;

  return registration_exact
    and entry_count_exact
    and not exists (
      select 1
      from pg_catalog.jsonb_array_elements(expected_catalogue) as expected(value)
      where not exists (
        select 1
        from vortex_access.permission_catalogue_entries as entry
        where entry.organization_id = p_organization_id
          and entry.registration_kind = 'platform'
          and entry.registration_owner_id = platform_owner_id
          and entry.registration_revision = p_registration_revision
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
          and entry.source_version = expected_source_version
          and entry.source_revision is null
          and entry.source_validation_contract_version is null
          and entry.source_content_fingerprint is null
          and entry.source_resolution_fingerprint is null
          and entry.source_catalogue_fingerprint = expected_catalogue_fingerprint
          and entry.meaning_fingerprint = expected.value ->> 'meaningFingerprint'
      )
    );
end
$_$;

set local role vortex_owner;

set local role postgres;
-- guard-allow: migration-owner-role Existing function retains postgres ownership until baseline table policies migrate.
create or replace function vortex_access.platform_permission_catalogue_revision_is_exact_v1_2_0(
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
  -- guard-allow: function-uuid fixed platform permission identity without declaration-table read access
  platform_owner_id constant uuid := 'cabe121e-0baf-4084-9471-cce915d460a8';
  -- guard-allow: function-uuid fixed platform permission identity without declaration-table read access
  connection_permission_id constant uuid := 'ec2908a1-f3cd-4c4a-8bf7-91bffbf4cb3d';
  catalogue_fingerprint constant text :=
    'sha256:2fe313d69f53d7ce9247aa0ae05b5cc837872f49285e577f9dc9e1f21f3c842e';
  connection_meaning_fingerprint constant text :=
    'sha256:809b4b3ad29ff61ab5ea73c06504909540b8111a2b3c2e1310559a7e9dc2e31e';
  description_value constant text :=
    'Register, grant, check, revoke and reauthorise connection instances in the selected organisation without application-installation or access-assignment authority.';
begin
  if p_registration_revision is distinct from 4 then
    return false;
  end if;

  return
    (select pg_catalog.count(*) = 1
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
       and registration.revision = 4
       and registration.source_version = '1.2.0'
       and registration.permission_catalogue_fingerprint = catalogue_fingerprint
       and registration.candidate_fingerprint = catalogue_fingerprint
       and history.operation = 'platform_metadata_revision'
       and row(
         registration.state, registration.source_definition_key,
         registration.source_version, registration.source_revision,
         registration.validation_contract_version,
         registration.permission_catalogue_fingerprint,
         registration.candidate_fingerprint, registration.changed_at,
         registration.changed_by, registration.change_correlation_id
       ) is not distinct from row(
         history.state, history.source_definition_key,
         history.source_version, history.source_revision,
         history.validation_contract_version,
         history.permission_catalogue_fingerprint,
         history.candidate_fingerprint, history.changed_at,
         history.changed_by, history.change_correlation_id
       ))
    and (select pg_catalog.count(*) = 15
         from vortex_access.permission_catalogue_entries as entry
         where entry.organization_id = p_organization_id
           and entry.registration_kind = 'platform'
           and entry.registration_owner_id = platform_owner_id
           and entry.registration_revision = 4)
    and (select pg_catalog.count(*) = 14
         from vortex_access.permission_catalogue_entries as entry
         where entry.organization_id = p_organization_id
           and entry.registration_kind = 'platform'
           and entry.registration_owner_id = platform_owner_id
           and entry.registration_revision = 3)
    and not exists (
      select 1
      from vortex_access.permission_catalogue_entries as previous
      left join vortex_access.permission_catalogue_entries as current_entry
        on current_entry.organization_id = previous.organization_id
        and current_entry.registration_kind = previous.registration_kind
        and current_entry.registration_owner_id = previous.registration_owner_id
        and current_entry.registration_revision = 4
        and current_entry.owner_kind = previous.owner_kind
        and current_entry.owner_id = previous.owner_id
        and current_entry.permission_id = previous.permission_id
      where previous.organization_id = p_organization_id
        and previous.registration_kind = 'platform'
        and previous.registration_owner_id = platform_owner_id
        and previous.registration_revision = 3
        and (
          current_entry.permission_id is null
          or current_entry.source_version is distinct from '1.2.0'
          or current_entry.source_catalogue_fingerprint is distinct from
            catalogue_fingerprint
          or (pg_catalog.to_jsonb(current_entry)
                - 'registration_revision' - 'source_version'
                - 'source_catalogue_fingerprint')
             is distinct from
             (pg_catalog.to_jsonb(previous)
                - 'registration_revision' - 'source_version'
                - 'source_catalogue_fingerprint')
        )
    )
    and (select pg_catalog.count(*) = 1
         from vortex_access.permission_catalogue_entries as entry
         where entry.organization_id = p_organization_id
           and entry.registration_kind = 'platform'
           and entry.registration_owner_id = platform_owner_id
           and entry.registration_revision = 4
           and entry.application_root_id is null
           and entry.owner_kind = 'platform'
           and entry.owner_id = platform_owner_id
           and entry.permission_id = connection_permission_id
           and entry.permission_key = 'platform.organization.connections.manage'
           and entry.label = 'Manage connections'
           and entry.description = description_value
           and entry.record_type_id is null
           and entry.record_scope is null
           and entry.field_policy is null
           and entry.action_kind = 'manage'
           and entry.named_action is null
           and entry.administrative
           and entry.source_kind = 'platform_catalogue'
           and entry.source_definition_key is null
           and entry.source_root_id is null
           and entry.source_version = '1.2.0'
           and entry.source_revision is null
           and entry.source_validation_contract_version is null
           and entry.source_content_fingerprint is null
           and entry.source_resolution_fingerprint is null
           and entry.source_catalogue_fingerprint = catalogue_fingerprint
           and entry.meaning_fingerprint = connection_meaning_fingerprint)
    and (select pg_catalog.count(*) = 15
         from vortex_access.permission_continuities as continuity
         where continuity.organization_id = p_organization_id
           and continuity.application_root_id is null
           and continuity.registration_kind = 'platform'
           and continuity.registration_owner_id = platform_owner_id
           and continuity.state = 'available'
           and continuity.last_processed_registration_revision = 4)
    and not exists (
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
        and continuity.last_processed_registration_revision = 4
      where entry.organization_id = p_organization_id
        and entry.registration_kind = 'platform'
        and entry.registration_owner_id = platform_owner_id
        and entry.registration_revision = 4
        and continuity.permission_id is null
    );
end
$function$;

set local role vortex_owner;

set local role postgres;
-- guard-allow: migration-owner-role Existing function retains postgres ownership until baseline table policies migrate.
CREATE OR REPLACE FUNCTION vortex_access.platform_permission_catalogue_revision_is_exact_v1_3_0(p_organization_id uuid, p_registration_revision bigint) RETURNS boolean
    LANGUAGE plpgsql STABLE
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
  security_description constant text :=
    'Disable an identity and revoke its active sessions through the identity owner''s protected operation without receiving general identity-administration or business-record authority.';
  support_request_description constant text :=
    'Request time-bounded support access to another organisation for a named operator and exact scope without receiving standing access to that organisation.';
  support_approve_description constant text :=
    'Approve or refuse a time-bounded support-access request for one''s own organisation without granting the requester standing authority.';
begin
  if p_registration_revision is distinct from 5 then
    return false;
  end if;

  return
    (select pg_catalog.count(*) = 1
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
       and registration.revision = 5
       and registration.source_version = '1.3.0'
       and registration.permission_catalogue_fingerprint = catalogue_fingerprint
       and registration.candidate_fingerprint = catalogue_fingerprint
       and history.operation = 'platform_metadata_revision'
       and row(
         registration.state, registration.source_definition_key,
         registration.source_version, registration.source_revision,
         registration.validation_contract_version,
         registration.permission_catalogue_fingerprint,
         registration.candidate_fingerprint, registration.changed_at,
         registration.changed_by, registration.change_correlation_id
       ) is not distinct from row(
         history.state, history.source_definition_key,
         history.source_version, history.source_revision,
         history.validation_contract_version,
         history.permission_catalogue_fingerprint,
         history.candidate_fingerprint, history.changed_at,
         history.changed_by, history.change_correlation_id
       ))
    and (select pg_catalog.count(*) = 18
         from vortex_access.permission_catalogue_entries as entry
         where entry.organization_id = p_organization_id
           and entry.registration_kind = 'platform'
           and entry.registration_owner_id = platform_owner_id
           and entry.registration_revision = 5)
    and (select pg_catalog.count(*) = 15
         from vortex_access.permission_catalogue_entries as entry
         where entry.organization_id = p_organization_id
           and entry.registration_kind = 'platform'
           and entry.registration_owner_id = platform_owner_id
           and entry.registration_revision = 4)
    and not exists (
      select 1
      from vortex_access.permission_catalogue_entries as previous
      left join vortex_access.permission_catalogue_entries as current_entry
        on current_entry.organization_id = previous.organization_id
        and current_entry.registration_kind = previous.registration_kind
        and current_entry.registration_owner_id = previous.registration_owner_id
        and current_entry.registration_revision = 5
        and current_entry.owner_kind = previous.owner_kind
        and current_entry.owner_id = previous.owner_id
        and current_entry.permission_id = previous.permission_id
      where previous.organization_id = p_organization_id
        and previous.registration_kind = 'platform'
        and previous.registration_owner_id = platform_owner_id
        and previous.registration_revision = 4
        and (
          current_entry.permission_id is null
          or current_entry.source_version is distinct from '1.3.0'
          or current_entry.source_catalogue_fingerprint is distinct from
            catalogue_fingerprint
          or (pg_catalog.to_jsonb(current_entry)
                - 'registration_revision' - 'source_version'
                - 'source_catalogue_fingerprint')
             is distinct from
             (pg_catalog.to_jsonb(previous)
                - 'registration_revision' - 'source_version'
                - 'source_catalogue_fingerprint')
        )
    )
    and (select pg_catalog.count(*) = 1
         from vortex_access.permission_catalogue_entries as entry
         where entry.organization_id = p_organization_id
           and entry.registration_kind = 'platform'
           and entry.registration_owner_id = platform_owner_id
           and entry.registration_revision = 5
           and entry.application_root_id is null
           and entry.owner_kind = 'platform'
           and entry.owner_id = platform_owner_id
           and entry.permission_id = security_permission_id
           and entry.permission_key = 'platform.security.identities.disable'
           and entry.label = 'Disable identities'
           and entry.description = security_description
           and entry.record_type_id is null
           and entry.record_scope is null
           and entry.field_policy is null
           and entry.action_kind = 'manage'
           and entry.named_action is null
           and entry.administrative
           and entry.source_kind = 'platform_catalogue'
           and entry.source_definition_key is null
           and entry.source_root_id is null
           and entry.source_version = '1.3.0'
           and entry.source_revision is null
           and entry.source_validation_contract_version is null
           and entry.source_content_fingerprint is null
           and entry.source_resolution_fingerprint is null
           and entry.source_catalogue_fingerprint = catalogue_fingerprint
           and entry.meaning_fingerprint = security_meaning_fingerprint)
    and (select pg_catalog.count(*) = 1
         from vortex_access.permission_catalogue_entries as entry
         where entry.organization_id = p_organization_id
           and entry.registration_kind = 'platform'
           and entry.registration_owner_id = platform_owner_id
           and entry.registration_revision = 5
           and entry.application_root_id is null
           and entry.owner_kind = 'platform'
           and entry.owner_id = platform_owner_id
           and entry.permission_id = support_request_permission_id
           and entry.permission_key = 'platform.support.access.request'
           and entry.label = 'Request support access'
           and entry.description = support_request_description
           and entry.record_type_id is null
           and entry.record_scope is null
           and entry.field_policy is null
           and entry.action_kind = 'manage'
           and entry.named_action is null
           and entry.administrative
           and entry.source_kind = 'platform_catalogue'
           and entry.source_definition_key is null
           and entry.source_root_id is null
           and entry.source_version = '1.3.0'
           and entry.source_revision is null
           and entry.source_validation_contract_version is null
           and entry.source_content_fingerprint is null
           and entry.source_resolution_fingerprint is null
           and entry.source_catalogue_fingerprint = catalogue_fingerprint
           and entry.meaning_fingerprint = support_request_meaning_fingerprint)
    and (select pg_catalog.count(*) = 1
         from vortex_access.permission_catalogue_entries as entry
         where entry.organization_id = p_organization_id
           and entry.registration_kind = 'platform'
           and entry.registration_owner_id = platform_owner_id
           and entry.registration_revision = 5
           and entry.application_root_id is null
           and entry.owner_kind = 'platform'
           and entry.owner_id = platform_owner_id
           and entry.permission_id = support_approve_permission_id
           and entry.permission_key = 'platform.organization.support.approve'
           and entry.label = 'Approve support access'
           and entry.description = support_approve_description
           and entry.record_type_id is null
           and entry.record_scope is null
           and entry.field_policy is null
           and entry.action_kind = 'manage'
           and entry.named_action is null
           and entry.administrative
           and entry.source_kind = 'platform_catalogue'
           and entry.source_definition_key is null
           and entry.source_root_id is null
           and entry.source_version = '1.3.0'
           and entry.source_revision is null
           and entry.source_validation_contract_version is null
           and entry.source_content_fingerprint is null
           and entry.source_resolution_fingerprint is null
           and entry.source_catalogue_fingerprint = catalogue_fingerprint
           and entry.meaning_fingerprint = support_approve_meaning_fingerprint)
    and (select pg_catalog.count(*) = 18
         from vortex_access.permission_continuities as continuity
         where continuity.organization_id = p_organization_id
           and continuity.application_root_id is null
           and continuity.registration_kind = 'platform'
           and continuity.registration_owner_id = platform_owner_id
           and continuity.state = 'available'
           and continuity.last_processed_registration_revision = 5)
    and not exists (
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
        and continuity.last_processed_registration_revision = 5
      where entry.organization_id = p_organization_id
        and entry.registration_kind = 'platform'
        and entry.registration_owner_id = platform_owner_id
        and entry.registration_revision = 5
        and continuity.permission_id is null
    );
end
$$;

set local role vortex_owner;

set local role postgres;
-- guard-allow: migration-owner-role Existing function retains postgres ownership until baseline table policies migrate.
create or replace function vortex_access.platform_permission_catalogue_revision_is_exact_v1_4_0(
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
  -- guard-allow: function-uuid fixed platform permission identity without declaration-table read access
  platform_owner_id constant uuid := 'cabe121e-0baf-4084-9471-cce915d460a8';
  -- guard-allow: function-uuid fixed platform permission identity without declaration-table read access
  drafts_permission_id constant uuid := '0548c061-b1a9-48e5-a04a-eb1d0dae0644';
  -- guard-allow: function-uuid fixed platform permission identity without declaration-table read access
  releases_permission_id constant uuid := 'dfdd5aba-2b85-4169-b570-92be284e7b5c';
  -- guard-allow: function-uuid fixed platform permission identity without declaration-table read access
  custom_code_permission_id constant uuid := 'd1be247f-094d-47c1-a38d-762290868c91';
  -- guard-allow: function-uuid fixed platform permission identity without declaration-table read access
  system_applications_permission_id constant uuid := 'eaade6fd-7390-44d2-a7ef-343324c7384a';
  catalogue_fingerprint constant text :=
    'sha256:1e5cceb04465d940f163ec926af7423efc9b37788551b00766d768fe9089195b';
  drafts_meaning_fingerprint constant text :=
    'sha256:29c4f706d6b65b54f4c3378de3f64816c01a22dc308ee7f6f0898d71eda216a0';
  releases_meaning_fingerprint constant text :=
    'sha256:b291e3a7d8a7f5cc0f346762914d1b1122be875d21fa70e5fdad819d28b1a80a';
  custom_code_meaning_fingerprint constant text :=
    'sha256:d8faa202f04c0c453cb87ed37f3b8f226b4171d133fc1277616a2b418db43c21';
  system_applications_meaning_fingerprint constant text :=
    'sha256:0c68ccc8a752c8009a5b84e5a22a584f3f22f666213121db1be7fb010cdbc50b';
  drafts_description constant text :=
    'Create and change module and application drafts, including flows, placements and role templates, without publication or installation authority.';
  releases_description constant text :=
    'Publish module and application drafts as immutable releases without receiving installation or business-record authority.';
  custom_code_description constant text :=
    'Required in addition to the application-management permission to install, upgrade or uninstall packages that bundle custom components or scripts.';
  system_applications_description constant text :=
    'Change system application definitions, including extension fields, theme, navigation and dependent applications, without uninstallation authority.';
begin
  if p_registration_revision is distinct from 6 then
    return false;
  end if;

  return
    (select pg_catalog.count(*) = 1
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
       and registration.revision = 6
       and registration.source_version = '1.4.0'
       and registration.permission_catalogue_fingerprint = catalogue_fingerprint
       and registration.candidate_fingerprint = catalogue_fingerprint
       and history.operation = 'platform_metadata_revision'
       and row(
         registration.state, registration.source_definition_key,
         registration.source_version, registration.source_revision,
         registration.validation_contract_version,
         registration.permission_catalogue_fingerprint,
         registration.candidate_fingerprint, registration.changed_at,
         registration.changed_by, registration.change_correlation_id
       ) is not distinct from row(
         history.state, history.source_definition_key,
         history.source_version, history.source_revision,
         history.validation_contract_version,
         history.permission_catalogue_fingerprint,
         history.candidate_fingerprint, history.changed_at,
         history.changed_by, history.change_correlation_id
       ))
    and (select pg_catalog.count(*) = 22
         from vortex_access.permission_catalogue_entries as entry
         where entry.organization_id = p_organization_id
           and entry.registration_kind = 'platform'
           and entry.registration_owner_id = platform_owner_id
           and entry.registration_revision = 6)
    and (select pg_catalog.count(*) = 18
         from vortex_access.permission_catalogue_entries as entry
         where entry.organization_id = p_organization_id
           and entry.registration_kind = 'platform'
           and entry.registration_owner_id = platform_owner_id
           and entry.registration_revision = 5)
    and not exists (
      select 1
      from vortex_access.permission_catalogue_entries as previous
      left join vortex_access.permission_catalogue_entries as current_entry
        on current_entry.organization_id = previous.organization_id
        and current_entry.registration_kind = previous.registration_kind
        and current_entry.registration_owner_id = previous.registration_owner_id
        and current_entry.registration_revision = 6
        and current_entry.owner_kind = previous.owner_kind
        and current_entry.owner_id = previous.owner_id
        and current_entry.permission_id = previous.permission_id
      where previous.organization_id = p_organization_id
        and previous.registration_kind = 'platform'
        and previous.registration_owner_id = platform_owner_id
        and previous.registration_revision = 5
        and (
          current_entry.permission_id is null
          or current_entry.source_version is distinct from '1.4.0'
          or current_entry.source_catalogue_fingerprint is distinct from
            catalogue_fingerprint
          or (pg_catalog.to_jsonb(current_entry)
                - 'registration_revision' - 'source_version'
                - 'source_catalogue_fingerprint')
             is distinct from
             (pg_catalog.to_jsonb(previous)
                - 'registration_revision' - 'source_version'
                - 'source_catalogue_fingerprint')
        )
    )
    and (select pg_catalog.count(*) = 1
         from vortex_access.permission_catalogue_entries as entry
         where entry.organization_id = p_organization_id
           and entry.registration_kind = 'platform'
           and entry.registration_owner_id = platform_owner_id
           and entry.registration_revision = 6
           and entry.application_root_id is null
           and entry.owner_kind = 'platform'
           and entry.owner_id = platform_owner_id
           and entry.permission_id = drafts_permission_id
           and entry.permission_key = 'platform.organization.definition_drafts.manage'
           and entry.label = 'Manage definition drafts'
           and entry.description = drafts_description
           and entry.record_type_id is null
           and entry.record_scope is null
           and entry.field_policy is null
           and entry.action_kind = 'manage'
           and entry.named_action is null
           and entry.administrative
           and entry.source_kind = 'platform_catalogue'
           and entry.source_definition_key is null
           and entry.source_root_id is null
           and entry.source_version = '1.4.0'
           and entry.source_revision is null
           and entry.source_validation_contract_version is null
           and entry.source_content_fingerprint is null
           and entry.source_resolution_fingerprint is null
           and entry.source_catalogue_fingerprint = catalogue_fingerprint
           and entry.meaning_fingerprint = drafts_meaning_fingerprint)
    and (select pg_catalog.count(*) = 1
         from vortex_access.permission_catalogue_entries as entry
         where entry.organization_id = p_organization_id
           and entry.registration_kind = 'platform'
           and entry.registration_owner_id = platform_owner_id
           and entry.registration_revision = 6
           and entry.application_root_id is null
           and entry.owner_kind = 'platform'
           and entry.owner_id = platform_owner_id
           and entry.permission_id = releases_permission_id
           and entry.permission_key = 'platform.organization.definition_releases.manage'
           and entry.label = 'Manage definition releases'
           and entry.description = releases_description
           and entry.record_type_id is null
           and entry.record_scope is null
           and entry.field_policy is null
           and entry.action_kind = 'manage'
           and entry.named_action is null
           and entry.administrative
           and entry.source_kind = 'platform_catalogue'
           and entry.source_definition_key is null
           and entry.source_root_id is null
           and entry.source_version = '1.4.0'
           and entry.source_revision is null
           and entry.source_validation_contract_version is null
           and entry.source_content_fingerprint is null
           and entry.source_resolution_fingerprint is null
           and entry.source_catalogue_fingerprint = catalogue_fingerprint
           and entry.meaning_fingerprint = releases_meaning_fingerprint)
    and (select pg_catalog.count(*) = 1
         from vortex_access.permission_catalogue_entries as entry
         where entry.organization_id = p_organization_id
           and entry.registration_kind = 'platform'
           and entry.registration_owner_id = platform_owner_id
           and entry.registration_revision = 6
           and entry.application_root_id is null
           and entry.owner_kind = 'platform'
           and entry.owner_id = platform_owner_id
           and entry.permission_id = custom_code_permission_id
           and entry.permission_key = 'platform.organization.custom_code.manage'
           and entry.label = 'Manage custom code'
           and entry.description = custom_code_description
           and entry.record_type_id is null
           and entry.record_scope is null
           and entry.field_policy is null
           and entry.action_kind = 'manage'
           and entry.named_action is null
           and entry.administrative
           and entry.source_kind = 'platform_catalogue'
           and entry.source_definition_key is null
           and entry.source_root_id is null
           and entry.source_version = '1.4.0'
           and entry.source_revision is null
           and entry.source_validation_contract_version is null
           and entry.source_content_fingerprint is null
           and entry.source_resolution_fingerprint is null
           and entry.source_catalogue_fingerprint = catalogue_fingerprint
           and entry.meaning_fingerprint = custom_code_meaning_fingerprint)
    and (select pg_catalog.count(*) = 1
         from vortex_access.permission_catalogue_entries as entry
         where entry.organization_id = p_organization_id
           and entry.registration_kind = 'platform'
           and entry.registration_owner_id = platform_owner_id
           and entry.registration_revision = 6
           and entry.application_root_id is null
           and entry.owner_kind = 'platform'
           and entry.owner_id = platform_owner_id
           and entry.permission_id = system_applications_permission_id
           and entry.permission_key = 'platform.organization.system_applications.manage'
           and entry.label = 'Manage system applications'
           and entry.description = system_applications_description
           and entry.record_type_id is null
           and entry.record_scope is null
           and entry.field_policy is null
           and entry.action_kind = 'manage'
           and entry.named_action is null
           and entry.administrative
           and entry.source_kind = 'platform_catalogue'
           and entry.source_definition_key is null
           and entry.source_root_id is null
           and entry.source_version = '1.4.0'
           and entry.source_revision is null
           and entry.source_validation_contract_version is null
           and entry.source_content_fingerprint is null
           and entry.source_resolution_fingerprint is null
           and entry.source_catalogue_fingerprint = catalogue_fingerprint
           and entry.meaning_fingerprint = system_applications_meaning_fingerprint)
    and (select pg_catalog.count(*) = 22
         from vortex_access.permission_continuities as continuity
         where continuity.organization_id = p_organization_id
           and continuity.application_root_id is null
           and continuity.registration_kind = 'platform'
           and continuity.registration_owner_id = platform_owner_id
           and continuity.state = 'available'
           and continuity.last_processed_registration_revision = 6)
    and not exists (
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
        and continuity.last_processed_registration_revision = 6
      where entry.organization_id = p_organization_id
        and entry.registration_kind = 'platform'
        and entry.registration_owner_id = platform_owner_id
        and entry.registration_revision = 6
        and continuity.permission_id is null
    );
end
$function$;

set local role vortex_owner;

set local role postgres;
-- guard-allow: migration-owner-role Existing function retains postgres ownership until baseline table policies migrate.
create or replace function vortex_access.read_application_address_candidates(
  p_identity_id uuid,
  p_tenant_short_name text,
  p_organization_short_name text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  addressed_organization record;
  application_row record;
  application_values jsonb := '[]'::jsonb;
  page_values jsonb;
  experience_values jsonb;
  role_values jsonb;
  permission_values jsonb;
  permissions_by_application jsonb;
  home_page_key text;
begin
  if p_identity_id is null
    or p_identity_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_tenant_short_name is null
    or pg_catalog.char_length(p_tenant_short_name) not between 1 and 40
    or p_tenant_short_name !~ '^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$'
    or p_organization_short_name is null
    or pg_catalog.char_length(p_organization_short_name) not between 1 and 40
    or p_organization_short_name !~ '^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$' then
    return pg_catalog.jsonb_build_object('kind', 'unavailable');
  end if;

  select tenant.tenant_id, tenant.short_name as tenant_short_name,
    organization.organization_id, organization.short_name as organization_short_name
  into addressed_organization
  from vortex_identity.tenants as tenant
  join vortex_identity.organizations as organization
    on organization.tenant_id = tenant.tenant_id
  where tenant.short_name = p_tenant_short_name
    and organization.short_name = p_organization_short_name
    and tenant.state = 'active'
    and organization.state = 'active';

  if not found then
    return pg_catalog.jsonb_build_object('kind', 'unavailable');
  end if;

  begin
    perform 1
    from vortex_access.resolve_human_organization_scope(
      p_identity_id, addressed_organization.organization_id
    ) as scope;
  exception
    when sqlstate 'V3140' then
      return pg_catalog.jsonb_build_object(
        'kind', 'suspended_super_administrator_account'
      );
    when sqlstate '42501' or sqlstate 'P0002' then
      return pg_catalog.jsonb_build_object('kind', 'unavailable');
  end;

  -- The organisation scope above is the viewer's only scope check: every
  -- candidate below is already an active registration of this organisation.
  -- Permission entries of every candidate application are aggregated once.
  select coalesce(pg_catalog.jsonb_object_agg(grouped.application_root_id, grouped.entries), '{}'::jsonb)
  into permissions_by_application
  from (
    select entry.registration_owner_id as application_root_id,
      pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'key', entry.permission_key,
          'applicationRootId', entry.application_root_id,
          'ownerKind', entry.owner_kind,
          'ownerId', entry.owner_id,
          'permissionId', entry.permission_id,
          'actionKind', entry.action_kind,
          'namedAction', entry.named_action
        ) order by entry.permission_key collate "C", entry.permission_id
      ) as entries
    from vortex_access.permission_catalogue_entries as entry
    join vortex_access.permission_registrations as registration
      on registration.organization_id = entry.organization_id
      and registration.registration_kind = entry.registration_kind
      and registration.registration_owner_id = entry.registration_owner_id
      and registration.revision = entry.registration_revision
      and registration.state = 'active'
    where entry.organization_id = addressed_organization.organization_id
      and entry.registration_kind = 'application'
      and entry.application_root_id = entry.registration_owner_id
    group by entry.registration_owner_id
  ) as grouped;

  for application_row in
    select root.root_id, root.key as application_key, release.compilation_output,
      registration.source_revision as release_revision
    from vortex_access.permission_registrations as registration
    join vortex_definition.roots as root
      on root.root_id = registration.registration_owner_id
      and root.organization_id = addressed_organization.organization_id
      and root.kind = 'application'
      and root.key = registration.source_definition_key
    join vortex_definition.releases as release
      on release.root_id = root.root_id
      and release.release_revision = registration.source_revision
      and release.release_version = registration.source_version
      and release.validation_contract_version = registration.validation_contract_version
    where registration.organization_id = addressed_organization.organization_id
      and registration.registration_kind = 'application'
      and registration.state = 'active'
      and exists (
        select 1
        from vortex_definition.installation_bindings as binding
        where binding.organization_id = addressed_organization.organization_id
          and binding.application_root_id = root.root_id
          and binding.application_release_revision = registration.source_revision
          and binding.state = 'active'
      )
      and release.compilation_output ->> 'kind' = 'application'
    order by root.key collate "C", root.root_id
  loop
    -- Published release data is platform-produced: a malformed field is a
    -- defect of that application's release, so it fails loudly with the
    -- application named instead of dropping the application from the list.
    page_values := application_row.compilation_output #> '{canonical,content,pages}';
    if pg_catalog.jsonb_typeof(page_values) is distinct from 'array' then
      raise exception using errcode = 'XX001',
        message = pg_catalog.format(
          'Published application %s has malformed pages', application_row.application_key);
    end if;

    select page.value ->> 'key'
    into home_page_key
    from pg_catalog.jsonb_array_elements(page_values) as page(value)
    where page.value ->> 'pageId' =
      application_row.compilation_output #>> '{canonical,content,homePageId}';

    if home_page_key is null then
      raise exception using errcode = 'XX001',
        message = pg_catalog.format(
          'Published application %s has no home page among its pages',
          application_row.application_key);
    end if;

    -- Declared experience pages are resolved to their exact compiled page definitions here, so
    -- App can render an application's own not-found, unavailable and error surfaces. A refused
    -- page and a missing page both resolve to the same not_found experience. Experiences are an
    -- optional release field: an absent one declares none, a present one must be an array.
    experience_values := application_row.compilation_output #> '{canonical,content,experiences}';
    if experience_values is null then
      experience_values := '[]'::jsonb;
    elsif pg_catalog.jsonb_typeof(experience_values) is distinct from 'array' then
      raise exception using errcode = 'XX001',
        message = pg_catalog.format(
          'Published application %s has malformed experiences', application_row.application_key);
    end if;

    role_values := application_row.compilation_output #> '{canonical,content,roles}';
    if pg_catalog.jsonb_typeof(role_values) is distinct from 'array' then
      raise exception using errcode = 'XX001',
        message = pg_catalog.format(
          'Published application %s has malformed roles', application_row.application_key);
    end if;

    permission_values := permissions_by_application -> (application_row.root_id::text);

    application_values := application_values || pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'applicationRootId', application_row.root_id,
        'releaseRevision', application_row.release_revision,
        'key', application_row.application_key,
        'name', application_row.compilation_output #>> '{canonical,content,name}',
        'icon', application_row.compilation_output #>> '{canonical,content,icon}',
        'homePageKey', home_page_key,
        'pages', (
          select pg_catalog.jsonb_agg(
            pg_catalog.jsonb_build_object(
              'pageId', page.value ->> 'pageId',
              'key', page.value ->> 'key',
              'accessPermissionKey', page.value ->> 'accessPermissionKey'
            ) order by page.value ->> 'key' collate "C"
          )
          from pg_catalog.jsonb_array_elements(page_values) as page(value)
        ),
        'experiences', coalesce((
          select pg_catalog.jsonb_agg(
            pg_catalog.jsonb_build_object('state', experience.value ->> 'state', 'page', page.value)
            order by experience.value ->> 'state' collate "C"
          )
          from pg_catalog.jsonb_array_elements(experience_values) as experience(value)
          join pg_catalog.jsonb_array_elements(page_values) as page(value)
            on page.value ->> 'pageId' = experience.value ->> 'pageId'
        ), '[]'::jsonb),
        'shells', case
          when pg_catalog.jsonb_array_length(experience_values) > 0
            then coalesce(
              application_row.compilation_output #> '{canonical,content,shells}',
              '[]'::jsonb
            )
          else '[]'::jsonb
        end,
        'roles', (
          select pg_catalog.jsonb_agg(
            pg_catalog.jsonb_build_object(
              'roleId', role.value ->> 'roleId',
              'key', role.value ->> 'key',
              'homePageId', role.value ->> 'homePageId'
            ) order by role.value ->> 'key' collate "C"
          )
          from pg_catalog.jsonb_array_elements(role_values) as role(value)
        ),
        'permissions', coalesce(permission_values, '[]'::jsonb)
      ) || case
        when pg_catalog.jsonb_array_length(experience_values) > 0
          then pg_catalog.jsonb_build_object(
            'theme', application_row.compilation_output #> '{canonical,content,theme}'
          )
        else '{}'::jsonb
      end
    );
  end loop;

  return pg_catalog.jsonb_build_object(
    'kind', 'available',
    'organizationId', addressed_organization.organization_id,
    'tenantShortName', addressed_organization.tenant_short_name,
    'organizationShortName', addressed_organization.organization_short_name,
    'applications', application_values
  );
end
$function$;

set local role vortex_owner;

create or replace function vortex_access.read_application_permission_snapshot(
  p_organization_id uuid,
  p_application_root_id uuid
)
returns table (
  organization_id uuid,
  application_root_id uuid,
  registration_revision bigint,
  release_revision bigint,
  definition_key text,
  release_version text,
  validation_contract_version text,
  content_fingerprint text,
  resolution_fingerprint text,
  catalogue_fingerprint text,
  permission_ids uuid[]
)
language sql
stable
security definer
set search_path = ''
as $function$
  select registration.organization_id, registration.registration_owner_id,
    registration.revision, registration.source_revision, registration.source_definition_key,
    registration.source_version,
    registration.validation_contract_version, release.content_fingerprint,
    release.resolution_fingerprint, registration.permission_catalogue_fingerprint,
    coalesce(
      pg_catalog.array_agg(entry.permission_id order by
        entry.permission_key collate "C", entry.permission_id)
        filter (where entry.permission_id is not null),
      array[]::uuid[]
    )
  from vortex_access.permission_registrations as registration
  join vortex_definition.releases as release
    on release.root_id = registration.registration_owner_id
    and release.release_revision = registration.source_revision
    and release.release_version = registration.source_version
    and release.validation_contract_version = registration.validation_contract_version
  left join vortex_access.permission_catalogue_entries as entry
    on entry.organization_id = registration.organization_id
    and entry.registration_kind = registration.registration_kind
    and entry.registration_owner_id = registration.registration_owner_id
    and entry.registration_revision = registration.revision
    and entry.owner_kind = 'application'
    and entry.administrative = false
  where registration.organization_id = p_organization_id
    and registration.registration_kind = 'application'
    and registration.registration_owner_id = p_application_root_id
    and registration.state = 'active'
  group by registration.organization_id, registration.registration_owner_id,
    registration.revision, registration.source_revision, registration.source_definition_key,
    registration.source_version,
    registration.validation_contract_version, release.content_fingerprint,
    release.resolution_fingerprint, registration.permission_catalogue_fingerprint
$function$;

set local role postgres;
-- guard-allow: migration-owner-role Existing function retains postgres ownership until baseline table policies migrate.
CREATE OR REPLACE FUNCTION vortex_access.read_application_role_template_for_administration(p_application_root_id uuid, p_source_role_id uuid) RETURNS TABLE(organization_id uuid, outcome text, template_summary jsonb, access_version bigint)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  scope record;
  template_value jsonb;
begin
  if p_application_root_id is null or p_source_role_id is null
    or p_application_root_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_source_role_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using errcode = '22023',
      message = 'Application role template detail input is invalid';
  end if;

  select authorized.* into strict scope
  from vortex_access.organization_roles_administration_scope() as authorized;

  select pg_catalog.jsonb_build_object(
    'reference', pg_catalog.jsonb_build_object(
      'applicationRootId', registration.registration_owner_id,
      'sourceRoleId', (template.value ->> 'roleId')::uuid
    ),
    'key', template.value ->> 'key',
    'label', template.value ->> 'name',
    'permissionSelectionKind', template.value #>> '{permissionSelection,kind}',
    'publishedPermissionKeys', template.value -> 'permissionKeys'
  )
  into template_value
  from vortex_access.permission_registrations as registration
  join vortex_definition.roots as root
    on root.root_id = registration.registration_owner_id
    and root.organization_id = registration.organization_id
    and root.kind = 'application'
    and root.key = registration.source_definition_key
  join vortex_definition.releases as release
    on release.root_id = root.root_id
    and release.release_revision = registration.source_revision
    and release.release_version = registration.source_version
    and release.validation_contract_version = registration.validation_contract_version
  cross join lateral pg_catalog.jsonb_array_elements(
    release.compilation_output #> '{canonical,content,roles}'
  ) as template(value)
  join vortex_access.application_role_template_continuities as continuity
    on continuity.organization_id = registration.organization_id
    and continuity.application_root_id = registration.registration_owner_id
    and continuity.source_role_id = (template.value ->> 'roleId')::uuid
    and continuity.state = 'available'
    and continuity.last_processed_registration_revision = registration.revision
  where registration.organization_id = scope.organization_id
    and registration.registration_kind = 'application'
    and registration.registration_owner_id = p_application_root_id
    and registration.state = 'active'
    and (template.value ->> 'roleId')::uuid = p_source_role_id;

  return query select scope.organization_id,
    case when template_value is null then 'unavailable' else 'available' end,
    template_value, scope.access_version;
end
$$;

set local role vortex_owner;

set local role postgres;
-- guard-allow: migration-owner-role Existing function retains postgres ownership until baseline table policies migrate.
create or replace function vortex_access.read_organization_role_change_evidence_for_administration(
  p_preparation jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  decision record;
  context_organization_id uuid;
  operation_name text;
  accepted_truth text;
  requested jsonb;
  refs jsonb;
  permissions_value jsonb;
  target_application_root_id uuid;
  target_source_role_id uuid;
  application_registration vortex_access.permission_registrations%rowtype;
  application_release jsonb;
  registration_entries jsonb;
  application_permission_ids jsonb;
  permission_registration jsonb;
  selected_template jsonb;
  selected_continuity vortex_access.application_role_template_continuities%rowtype;
  source_permissions jsonb;
  live_permissions jsonb;
  prepared_templates_core jsonb;
  role_identity vortex_access.organization_roles%rowtype;
  current_revision vortex_access.organization_role_revisions%rowtype;
  role_configuration jsonb;
  target_role_id uuid;
  expected_role_revision bigint;
  target_lifecycle text := 'active';
  authority_broadened boolean := false;
  manifest_required boolean := false;
  affected_assignments jsonb;
begin
  -- New-role callers supply bounded configuration only. Existing-Application-revision callers
  -- supply only the selected role identity and expected revision; this function derives that
  -- role's configuration and application source from the verified organisation's stored rows.
  -- Neither path accepts a fingerprint or organisation from its caller.
  if p_preparation is null
    or pg_catalog.jsonb_typeof(p_preparation) is distinct from 'object'
    or pg_catalog.jsonb_typeof(p_preparation -> 'operation') is distinct from 'string'
    or p_preparation ->> 'operation' not in (
      'create_custom', 'accept_new_application_role', 'accept_application_role_revision'
    ) then
    raise exception using errcode = '22023',
      message = 'Organization role-change preparation input is invalid';
  end if;
  operation_name := p_preparation ->> 'operation';

  if operation_name = 'accept_application_role_revision' then
    if p_preparation - array[
      'operation', 'roleId', 'expectedRoleRevision', 'acceptBroadenedAuthority'
    ]::text[] <> '{}'::jsonb
      or not (p_preparation ?& array[
        'operation', 'roleId', 'expectedRoleRevision', 'acceptBroadenedAuthority'
      ])
      or pg_catalog.jsonb_typeof(p_preparation -> 'roleId') is distinct from 'string'
      or vortex_platform.is_non_nil_uuid(p_preparation ->> 'roleId') is not true
      or (p_preparation ->> 'roleId') <> (p_preparation ->> 'roleId')::uuid::text
      or pg_catalog.jsonb_typeof(p_preparation -> 'expectedRoleRevision')
        is distinct from 'number'
      or (p_preparation ->> 'expectedRoleRevision')::numeric not between
        1 and 9007199254740991
      or (p_preparation ->> 'expectedRoleRevision')::numeric <>
        pg_catalog.trunc((p_preparation ->> 'expectedRoleRevision')::numeric)
      or pg_catalog.jsonb_typeof(p_preparation -> 'acceptBroadenedAuthority')
        is distinct from 'string'
      or p_preparation ->> 'acceptBroadenedAuthority' not in ('accept', 'decline') then
      raise exception using errcode = '22023',
        message = 'Organization role-change preparation input is invalid';
    end if;
  elsif pg_catalog.jsonb_typeof(p_preparation -> 'roleKey') is distinct from 'string'
    or pg_catalog.jsonb_typeof(p_preparation -> 'label') is distinct from 'string'
    or pg_catalog.jsonb_typeof(p_preparation -> 'description') is distinct from 'string'
    or pg_catalog.jsonb_typeof(p_preparation -> 'privilegeClassification') is distinct from 'string'
    or p_preparation ->> 'privilegeClassification' not in ('standard', 'privileged')
    or pg_catalog.jsonb_typeof(p_preparation -> 'acceptBroadenedAuthority') is distinct from 'string'
    or p_preparation ->> 'acceptBroadenedAuthority' not in ('accept', 'decline') then
    raise exception using errcode = '22023',
      message = 'Organization role-change preparation input is invalid';
  end if;
  accepted_truth := p_preparation ->> 'acceptBroadenedAuthority';

  -- Explicit acceptance of broadened authority is a visible choice, never inferred from a
  -- submitted form. Declining is an ordinary unavailability, not an error.
  if accepted_truth is distinct from 'accept' then
    return pg_catalog.jsonb_build_object('outcome', 'unavailable');
  end if;

  -- The verified request context and the caller's own current role-management authority decide the
  -- organisation; the caller never names it.
  select evaluated.* into strict decision
  from vortex_access.evaluate_organization_permission_eligibility(
    pg_catalog.jsonb_build_object(
      'operationKey', 'platform.organization.roles.manage',
      'action', pg_catalog.jsonb_build_object('actionKind', 'manage'),
      'target', pg_catalog.jsonb_build_object('kind', 'organization'),
      'requiredPermission', pg_catalog.jsonb_build_object(
        'ownerKind', 'platform',
        -- guard-allow: function-uuid fixed platform permission identity without declaration-table read access
        'ownerId', 'cabe121e-0baf-4084-9471-cce915d460a8',
        -- guard-allow: function-uuid fixed platform permission identity without declaration-table read access
        'permissionId', '87c96495-c806-4692-9bc2-250ddb10613c'
      ),
      'recentAuthentication', pg_catalog.jsonb_build_object('kind', 'none'),
      'authority', pg_catalog.jsonb_build_object('kind', 'permission')
    )
  ) as evaluated;
  if decision.outcome is distinct from 'eligible' then
    raise exception using errcode = '42501',
      message = 'Organization role-change preparation is unavailable';
  end if;
  context_organization_id := decision.organization_id;

  if operation_name = 'accept_application_role_revision' then
    target_role_id := (p_preparation ->> 'roleId')::uuid;
    expected_role_revision :=
      (p_preparation ->> 'expectedRoleRevision')::numeric::bigint;
    select stored.* into role_identity
    from vortex_access.organization_roles as stored
    where stored.organization_id = context_organization_id
      and stored.role_id = target_role_id;
    if not found
      or role_identity.role_kind <> 'application'
      or role_identity.application_root_id is null
      or role_identity.application_root_id = '00000000-0000-0000-0000-000000000000'::uuid
      or role_identity.source_role_id is null
      or role_identity.source_role_id = '00000000-0000-0000-0000-000000000000'::uuid
      or role_identity.live_revision <> expected_role_revision then
      return pg_catalog.jsonb_build_object('outcome', 'unavailable');
    end if;
    if role_identity.live_revision = 9007199254740991 then
      return pg_catalog.jsonb_build_object('outcome', 'unavailable');
    end if;

    select revision.* into current_revision
    from vortex_access.organization_role_revisions as revision
    where revision.organization_id = context_organization_id
      and revision.role_id = target_role_id
      and revision.revision = expected_role_revision;
    if not found
      or current_revision.lifecycle is null
      or current_revision.lifecycle not in ('active', 'acceptance_required') then
      return pg_catalog.jsonb_build_object('outcome', 'unavailable');
    end if;

    target_application_root_id := role_identity.application_root_id;
    target_source_role_id := role_identity.source_role_id;
    role_configuration := pg_catalog.jsonb_build_object(
      'roleId', role_identity.role_id,
      'expectedRoleRevision', current_revision.revision,
      'key', current_revision.role_key,
      'label', current_revision.label,
      'description', current_revision.description,
      'privilegeClassification', current_revision.privilege_classification,
      'assignmentPolicy', case current_revision.assignment_policy
        when 'standing' then pg_catalog.jsonb_build_object('kind', 'standing')
        else pg_catalog.jsonb_build_object(
          'kind', 'activation_required',
          'activationPolicy', pg_catalog.jsonb_build_object(
            'selection', 'existing',
            'reference', pg_catalog.jsonb_build_object(
              'activationPolicyId', current_revision.activation_policy_id,
              'revision', current_revision.activation_policy_revision
            )
          )
        )
      end,
      'sourceRoleId', role_identity.source_role_id
    );
  end if;

  if operation_name = 'create_custom' then
    requested := p_preparation -> 'permissions';
    if pg_catalog.jsonb_typeof(requested) is distinct from 'array'
      or pg_catalog.jsonb_array_length(requested) = 0 then
      raise exception using errcode = '22023',
        message = 'Organization role-change preparation input is invalid';
    end if;
    if exists (
      select 1
      from pg_catalog.jsonb_array_elements(requested) as item(value)
      where pg_catalog.jsonb_typeof(item.value) is distinct from 'object'
        or not (item.value ?& array['ownerKind', 'ownerId', 'permissionId'])
        or pg_catalog.jsonb_typeof(item.value -> 'ownerKind') is distinct from 'string'
        or item.value ->> 'ownerKind' not in ('platform', 'application', 'module')
        or pg_catalog.jsonb_typeof(item.value -> 'ownerId') is distinct from 'string'
        or vortex_platform.is_non_nil_uuid(item.value ->> 'ownerId') is not true
        or pg_catalog.jsonb_typeof(item.value -> 'permissionId') is distinct from 'string'
        or vortex_platform.is_non_nil_uuid(item.value ->> 'permissionId') is not true
        or ((item.value ->> 'ownerKind' = 'platform') = (item.value ? 'applicationRootId'))
        or (
          item.value ->> 'ownerKind' <> 'platform'
          and (
            pg_catalog.jsonb_typeof(item.value -> 'applicationRootId') is distinct from 'string'
            or vortex_platform.is_non_nil_uuid(item.value ->> 'applicationRootId') is not true
            or (item.value ->> 'ownerKind' = 'application'
              and (item.value ->> 'ownerId')::uuid
                <> (item.value ->> 'applicationRootId')::uuid)
          )
        )
    ) then
      raise exception using errcode = '22023',
        message = 'Organization role-change preparation input is invalid';
    end if;
    select pg_catalog.jsonb_agg(distinct pg_catalog.jsonb_strip_nulls(
      pg_catalog.jsonb_build_object(
        'applicationRootId', case when item.value ->> 'ownerKind' = 'platform'
          then null else (item.value ->> 'applicationRootId')::uuid end,
        'ownerKind', item.value ->> 'ownerKind',
        'ownerId', (item.value ->> 'ownerId')::uuid,
        'permissionId', (item.value ->> 'permissionId')::uuid
      )
    ))
    into refs
    from pg_catalog.jsonb_array_elements(requested) as item(value);
    if refs is null
      or pg_catalog.jsonb_array_length(refs) <> pg_catalog.jsonb_array_length(requested) then
      raise exception using errcode = '22023',
        message = 'Organization role-change preparation input is invalid';
    end if;
  else
    if operation_name <> 'accept_application_role_revision' then
      if pg_catalog.jsonb_typeof(p_preparation -> 'applicationRootId') is distinct from 'string'
        or vortex_platform.is_non_nil_uuid(p_preparation ->> 'applicationRootId') is not true
        or pg_catalog.jsonb_typeof(p_preparation -> 'sourceRoleId') is distinct from 'string'
        or vortex_platform.is_non_nil_uuid(p_preparation ->> 'sourceRoleId') is not true then
        raise exception using errcode = '22023',
          message = 'Organization role-change preparation input is invalid';
      end if;
      target_application_root_id := (p_preparation ->> 'applicationRootId')::uuid;
      target_source_role_id := (p_preparation ->> 'sourceRoleId')::uuid;
    end if;

    select registration.* into application_registration
    from vortex_access.permission_registrations as registration
    where registration.organization_id = context_organization_id
      and registration.registration_kind = 'application'
      and registration.registration_owner_id = target_application_root_id
      and registration.state = 'active';
    if not found then
      return pg_catalog.jsonb_build_object('outcome', 'unavailable');
    end if;

    select pg_catalog.jsonb_build_object(
      'kind', 'application',
      'definitionKey', application_registration.source_definition_key,
      'rootId', application_registration.registration_owner_id,
      'releaseRevision', application_registration.source_revision,
      'releaseVersion', application_registration.source_version,
      'validationContractVersion', application_registration.validation_contract_version,
      'contentFingerprint', release.content_fingerprint,
      'resolutionFingerprint', release.resolution_fingerprint
    ) into application_release
    from vortex_definition.releases as release
    where release.root_id = application_registration.registration_owner_id
      and release.release_revision = application_registration.source_revision
      and release.release_version = application_registration.source_version
      and release.validation_contract_version = application_registration.validation_contract_version;
    if not found then
      return pg_catalog.jsonb_build_object('outcome', 'unavailable');
    end if;

    -- The same entry projection and order that
    -- vortex_access.application_permission_registration_matches_candidate compares, so the stored
    -- registration candidate fingerprint describes exactly these entries.
    select coalesce(pg_catalog.jsonb_agg(ordered_entries.entry_json order by
        ordered_entries.owner_kind collate "C", ordered_entries.owner_id,
        ordered_entries.permission_key collate "C", ordered_entries.permission_id),
      '[]'::jsonb)
    into registration_entries
    from (
      select pg_catalog.jsonb_build_object(
          'applicationRootId', entry.application_root_id,
          'ownerKind', entry.owner_kind,
          'ownerId', entry.owner_id,
          'permission', pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
            'permissionId', entry.permission_id,
            'key', entry.permission_key,
            'label', entry.label,
            'description', entry.description,
            'recordTypeId', entry.record_type_id,
            'recordScope', entry.record_scope,
            'fieldPolicy', entry.field_policy,
            'actionKind', entry.action_kind,
            'namedAction', entry.named_action,
            'administrative', entry.administrative
          )),
          'sourceRelease', pg_catalog.jsonb_build_object(
            'kind', entry.source_kind,
            'definitionKey', entry.source_definition_key,
            'rootId', entry.source_root_id,
            'releaseRevision', entry.source_revision,
            'releaseVersion', entry.source_version,
            'validationContractVersion', entry.source_validation_contract_version,
            'contentFingerprint', entry.source_content_fingerprint,
            'resolutionFingerprint', entry.source_resolution_fingerprint
          ),
          'meaningFingerprint', entry.meaning_fingerprint
        ) as entry_json,
        entry.owner_kind, entry.owner_id, entry.permission_key, entry.permission_id
      from vortex_access.permission_catalogue_entries as entry
      where entry.organization_id = context_organization_id
        and entry.registration_kind = 'application'
        and entry.registration_owner_id = target_application_root_id
        and entry.registration_revision = application_registration.revision
    ) as ordered_entries;

    select coalesce(pg_catalog.jsonb_agg(
      entry.permission_id order by entry.permission_key collate "C", entry.permission_id
    ), '[]'::jsonb)
    into application_permission_ids
    from vortex_access.permission_catalogue_entries as entry
    where entry.organization_id = context_organization_id
      and entry.registration_kind = 'application'
      and entry.registration_owner_id = target_application_root_id
      and entry.registration_revision = application_registration.revision
      and entry.owner_kind = 'application'
      and not entry.administrative;

    permission_registration := pg_catalog.jsonb_build_object(
      'contractVersion', '1.0.0',
      'organizationId', context_organization_id,
      'applicationRootId', target_application_root_id,
      'applicationRelease', application_release,
      'applicationCatalogueFingerprint', application_registration.permission_catalogue_fingerprint,
      'applicationPermissionIds', application_permission_ids,
      'entries', registration_entries,
      'candidateFingerprint', application_registration.candidate_fingerprint
    );

    select template.value into selected_template
    from vortex_definition.roots as root
    join vortex_definition.releases as release
      on release.root_id = root.root_id
      and release.release_revision = application_registration.source_revision
      and release.release_version = application_registration.source_version
      and release.validation_contract_version = application_registration.validation_contract_version
    cross join lateral pg_catalog.jsonb_array_elements(
      release.compilation_output #> '{canonical,content,roles}'
    ) as template(value)
    where root.root_id = target_application_root_id
      and root.organization_id = context_organization_id
      and root.kind = 'application'
      and root.key = application_registration.source_definition_key
      and (template.value ->> 'roleId')::uuid = target_source_role_id;
    if selected_template is null then
      return pg_catalog.jsonb_build_object('outcome', 'unavailable');
    end if;

    select continuity.* into selected_continuity
    from vortex_access.application_role_template_continuities as continuity
    where continuity.organization_id = context_organization_id
      and continuity.application_root_id = target_application_root_id
      and continuity.source_role_id = target_source_role_id
      and continuity.state = 'available'
      and continuity.last_processed_registration_revision = application_registration.revision;
    if not found then
      return pg_catalog.jsonb_build_object('outcome', 'unavailable');
    end if;

    -- Each template key resolves to exactly one registered entry, in the template's own key order,
    -- as the canonical template preparation does: an exact template among every registered entry,
    -- a wildcard template only among the application's own catalogue permissions.
    select pg_catalog.jsonb_agg(entry.value order by key.ordinal)
    into source_permissions
    from pg_catalog.jsonb_array_elements_text(selected_template -> 'permissionKeys')
      with ordinality as key(permission_key, ordinal)
    join pg_catalog.jsonb_array_elements(registration_entries) as entry(value)
      on entry.value #>> '{permission,key}' = key.permission_key
      and (
        selected_template #>> '{permissionSelection,kind}' is distinct from 'application_wildcard'
        or (
          entry.value ->> 'ownerKind' = 'application'
          and (entry.value ->> 'applicationRootId')::uuid = target_application_root_id
          and (entry.value ->> 'ownerId')::uuid = target_application_root_id
          and application_permission_ids
            @> pg_catalog.jsonb_build_array(entry.value #> '{permission,permissionId}')
        )
      );
    if source_permissions is null
      or pg_catalog.jsonb_array_length(source_permissions)
        <> pg_catalog.jsonb_array_length(selected_template -> 'permissionKeys') then
      return pg_catalog.jsonb_build_object('outcome', 'unavailable');
    end if;

    if selected_template #>> '{permissionSelection,kind}' = 'application_wildcard' then
      select coalesce(pg_catalog.jsonb_agg(item.value), '[]'::jsonb)
      into live_permissions
      from pg_catalog.jsonb_array_elements(source_permissions) as item(value)
      where item.value ->> 'ownerKind' = 'application'
        and (item.value ->> 'ownerId')::uuid = target_application_root_id
        and (item.value #>> '{permission,administrative}')::boolean = false
        and item.value #>> '{permission,actionKind}' <> 'export';
    else
      live_permissions := source_permissions;
    end if;

    prepared_templates_core := pg_catalog.jsonb_build_object(
      'contractVersion', '1.0.0',
      'preparationBasis', pg_catalog.jsonb_build_object(
        'kind', 'current_active_registration',
        'registrationRevision', application_registration.revision
      ),
      'permissionRegistration', permission_registration,
      'templates', pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'template', selected_template,
        'sourcePermissions', source_permissions,
        'livePermissions', live_permissions
      ))
    );

    select pg_catalog.jsonb_agg(pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
        'applicationRootId', item.value -> 'applicationRootId',
        'ownerKind', item.value ->> 'ownerKind',
        'ownerId', item.value ->> 'ownerId',
        'permissionId', item.value #>> '{permission,permissionId}'
      )))
    into refs
    from pg_catalog.jsonb_array_elements(live_permissions) as item(value);
  end if;

  -- Every requested identity must still resolve to exactly one current, available accepted
  -- permission. The returned scope is exactly the references the role entry names, never wider.
  select pg_catalog.jsonb_agg(pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
      'kind', 'exact',
      'applicationRootId', continuity.application_root_id,
      'ownerKind', continuity.owner_kind,
      'ownerId', continuity.owner_id,
      'permissionId', continuity.permission_id,
      'acceptedRegistrationRevision', registration.revision,
      'catalogueFingerprint', registration.permission_catalogue_fingerprint,
      'continuityRevision', continuity.continuity_revision,
      'meaningFingerprint', continuity.meaning_fingerprint
    )) order by continuity.application_root_id nulls last,
      continuity.owner_kind collate "C", continuity.owner_id, continuity.permission_id)
  into permissions_value
  from pg_catalog.jsonb_array_elements(refs) as requested_permission(value)
  join vortex_access.permission_continuities as continuity
    on continuity.organization_id = context_organization_id
    and continuity.state = 'available'
    and continuity.application_root_id is not distinct from
      case when requested_permission.value ? 'applicationRootId'
        then (requested_permission.value ->> 'applicationRootId')::uuid else null end
    and continuity.owner_kind = requested_permission.value ->> 'ownerKind'
    and continuity.owner_id = (requested_permission.value ->> 'ownerId')::uuid
    and continuity.permission_id = (requested_permission.value ->> 'permissionId')::uuid
  join vortex_access.permission_registrations as registration
    on registration.organization_id = continuity.organization_id
    and registration.registration_kind = continuity.registration_kind
    and registration.registration_owner_id = continuity.registration_owner_id
    and registration.state = 'active'
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
  if permissions_value is null
    or pg_catalog.jsonb_array_length(permissions_value)
      <> pg_catalog.jsonb_array_length(refs) then
    raise exception using errcode = '40001',
      message = 'Organization role permission evidence is stale or unavailable';
  end if;

  if operation_name = 'accept_application_role_revision' then
    select exists (
      select 1
      from pg_catalog.jsonb_array_elements(permissions_value) as proposed(value)
      where not exists (
        select 1
        from vortex_access.organization_role_permission_entries as existing
        where existing.organization_id = context_organization_id
          and existing.role_id = target_role_id
          and existing.role_revision = current_revision.revision
          and existing.application_root_id is not distinct from
            case when proposed.value ? 'applicationRootId'
              then (proposed.value ->> 'applicationRootId')::uuid else null end
          and existing.owner_kind = proposed.value ->> 'ownerKind'
          and existing.owner_id = (proposed.value ->> 'ownerId')::uuid
          and existing.permission_id = (proposed.value ->> 'permissionId')::uuid
          and existing.continuity_revision =
            (proposed.value ->> 'continuityRevision')::numeric::bigint
          and existing.meaning_fingerprint = proposed.value ->> 'meaningFingerprint'
      )
    ) into authority_broadened;

    -- The candidate preserves the current assignment policy and either moves from
    -- acceptance_required to active or keeps an active revision active. This is the writer's
    -- manifest predicate, so the only additional true term for this operation is a broadened
    -- permission projection.
    manifest_required :=
      current_revision.assignment_policy is distinct from
        (role_configuration #>> '{assignmentPolicy,kind}')
      or (
        current_revision.lifecycle in ('unavailable', 'retired')
        and target_lifecycle in ('active', 'acceptance_required')
      )
      or authority_broadened;

    if manifest_required then
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
                'kind', 'group',
                'groupId', assignment.group_id
              )
            end
          ) order by assignment.role_assignment_id
        ),
        '[]'::jsonb
      ) into affected_assignments
      from vortex_access.organization_role_assignments as assignment
      where assignment.organization_id = context_organization_id
        and assignment.role_id = target_role_id
        and assignment.state = 'live';
    end if;

    return pg_catalog.jsonb_build_object(
      'outcome', 'available',
      'organizationId', context_organization_id,
      'roleConfiguration', role_configuration,
      'permissions', permissions_value,
      'templateContinuityRevision', selected_continuity.continuity_revision,
      'preparedTemplatesCore', prepared_templates_core,
      'manifestRequired', manifest_required,
      'affectedAssignments', affected_assignments
    );
  end if;

  if operation_name = 'create_custom' then
    return pg_catalog.jsonb_build_object(
      'outcome', 'available',
      'organizationId', context_organization_id,
      'permissions', permissions_value,
      'templateContinuityRevision', null,
      'preparedTemplatesCore', null
    );
  end if;

  return pg_catalog.jsonb_build_object(
    'outcome', 'available',
    'organizationId', context_organization_id,
    'permissions', permissions_value,
    'templateContinuityRevision', selected_continuity.continuity_revision,
    'preparedTemplatesCore', prepared_templates_core
  );
exception
  when invalid_text_representation or invalid_parameter_value
      or numeric_value_out_of_range then
    raise exception using errcode = '22023',
      message = 'Organization role-change preparation input is invalid';
end
$function$;

set local role vortex_owner;

set local role postgres;
-- guard-allow: migration-owner-role Existing function retains postgres ownership until baseline table policies migrate.
create or replace function vortex_access.revise_platform_permission_catalogue_metadata(
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
  current_catalogue_fingerprint constant text :=
    'sha256:94733e5bba0c59d8b81693c78711b34f87bc7ff82c68f705d343cdacda990058';
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
    )
  );
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
    -- guard-allow: function-uuid fixed platform permission identity without declaration-table read access
    and registration.registration_owner_id = 'cabe121e-0baf-4084-9471-cce915d460a8'::uuid
  for update;

  if found and current_registration.revision = 2 then
    if not vortex_access.platform_permission_catalogue_revision_is_exact(
      p_organization_id, 2
    ) then
      raise exception using errcode = '55000', message = 'Platform catalogue metadata source evidence is invalid';
    end if;
    return query
    select p_organization_id, p_source_catalogue_version, p_target_catalogue_version,
      current_registration.revision, version.current_version
    from vortex_access.organization_access_versions as version
    where version.organization_id = p_organization_id;
    return;
  end if;

  if not found
    or current_registration.revision <> p_expected_registration_revision
    or not vortex_access.platform_permission_catalogue_revision_is_exact(
      p_organization_id, 1
    ) then
    raise exception using errcode = '55000', message = 'Platform catalogue metadata source evidence is invalid';
  end if;

  insert into vortex_access.permission_registration_revisions (
    organization_id, registration_kind, registration_owner_id, revision, state, operation, source_definition_key, source_version, source_revision, validation_contract_version, permission_catalogue_fingerprint, candidate_fingerprint, changed_at, changed_by, change_correlation_id
  ) values (
    -- guard-allow: function-uuid fixed platform permission identity without declaration-table read access
    p_organization_id, 'platform', 'cabe121e-0baf-4084-9471-cce915d460a8', 2, 'active', 'platform_metadata_revision', null, p_target_catalogue_version, null, null, current_catalogue_fingerprint, current_catalogue_fingerprint, operation_at, p_changed_by, p_correlation_id
  );

  insert into vortex_access.permission_catalogue_entries (
    organization_id, registration_kind, registration_owner_id, registration_revision,
    application_root_id, owner_kind, owner_id, permission_id, permission_key,
    label, description, record_type_id, action_kind, named_action, administrative,
    source_kind, source_definition_key, source_root_id, source_version, source_revision,
    source_validation_contract_version, source_content_fingerprint,
    source_resolution_fingerprint, source_catalogue_fingerprint, meaning_fingerprint
  )
  -- guard-allow: function-uuid fixed platform permission identity without declaration-table read access
  select p_organization_id, 'platform', 'cabe121e-0baf-4084-9471-cce915d460a8', 2,
    -- guard-allow: function-uuid fixed platform permission identity without declaration-table read access
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
    -- guard-allow: function-uuid fixed platform permission identity without declaration-table read access
    and registration.registration_owner_id = 'cabe121e-0baf-4084-9471-cce915d460a8'::uuid
    and registration.revision = p_expected_registration_revision;
  if not found then
    raise exception using errcode = '40001', message = 'Platform catalogue metadata source changed';
  end if;

  -- A metadata-only revision leaves every permission meaning unchanged, so each platform
  -- continuity is processed against the new registration revision. The chained organisation
  -- initializer adopts the next catalogue at this revision and requires that evidence.
  update vortex_access.permission_continuities as continuity
  set last_processed_registration_revision = 2,
      changed_at = operation_at
  where continuity.organization_id = p_organization_id
    and continuity.registration_kind = 'platform'
    -- guard-allow: function-uuid fixed platform permission identity without declaration-table read access
    and continuity.registration_owner_id = 'cabe121e-0baf-4084-9471-cce915d460a8'::uuid;

  select incremented.current_version into resulting_version
  from vortex_access.increment_organization_access_version(
    p_organization_id, p_changed_by, p_correlation_id, 'application_access_changed'
  ) as incremented;

  return query
  select p_organization_id, p_source_catalogue_version, p_target_catalogue_version,
    2::bigint, resulting_version;
end
$function$;

set local role vortex_owner;

set local role postgres;
-- guard-allow: migration-owner-role Existing function retains postgres ownership until baseline table policies migrate.
create or replace function vortex_access.save_organization_settings_record_for_administration(
  p_record_id uuid,
  p_expected_revision bigint,
  p_core_values jsonb,
  p_extension_values jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  context_value jsonb;
  context_organization_id uuid;
  context_correlation_id uuid;
  saved record;
  default_application_root_id_value uuid;
  failure_sqlstate text;
  failure_message text;
begin
  if p_record_id is null
    or p_record_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_expected_revision is null
    or p_expected_revision not between 1 and 9007199254740990
    or pg_catalog.jsonb_typeof(p_core_values) is distinct from 'object'
    or pg_catalog.jsonb_typeof(p_extension_values) is distinct from 'object' then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'invalid_request');
  end if;

  context_value := vortex_access.validated_human_request_context();
  if not context_value ? 'applicationRootId' then
    raise exception using errcode = '42501',
      message = 'Organization settings record save requires an Application context';
  end if;
  context_organization_id := (context_value ->> 'organizationId')::uuid;
  if p_record_id is distinct from context_organization_id then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'organization_mismatch');
  end if;

  perform 1
  from vortex_access.organization_access_versions as access_version
  where access_version.organization_id = context_organization_id
  for update;
  if not found then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'organization_access_missing');
  end if;

  context_value := vortex_access.validated_human_request_context();
  context_correlation_id := (context_value ->> 'correlationId')::uuid;

  if not vortex_access.organization_runtime_settings_manage_is_current() then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'settings_permission_unavailable');
  end if;

  if p_core_values ? 'default_application_root_id'
    and pg_catalog.jsonb_typeof(p_core_values -> 'default_application_root_id') <> 'null' then
    if pg_catalog.jsonb_typeof(p_core_values -> 'default_application_root_id') <> 'string'
      or not pg_catalog.pg_input_is_valid(
        p_core_values ->> 'default_application_root_id', 'uuid'
      ) then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'default_application_unavailable');
    end if;
    default_application_root_id_value :=
      (p_core_values ->> 'default_application_root_id')::uuid;
    if default_application_root_id_value = '00000000-0000-0000-0000-000000000000'::uuid
      or not exists (
        select 1
        from vortex_access.permission_registrations as registration
        join vortex_definition.roots as root
          on root.root_id = registration.registration_owner_id
          and root.organization_id = registration.organization_id
          and root.kind = 'application'
          and root.key = registration.source_definition_key
        where registration.organization_id = context_organization_id
          and registration.registration_kind = 'application'
          and registration.registration_owner_id = default_application_root_id_value
          and registration.state = 'active'
          and exists (
            select 1
            from vortex_definition.releases as release
            where release.root_id = root.root_id
              and release.release_revision = registration.source_revision
              and release.release_version = registration.source_version
              and release.validation_contract_version = registration.validation_contract_version
              and release.compilation_output ->> 'kind' = 'application'
          )
          and exists (
            select 1
            from vortex_definition.installation_bindings as binding
            where binding.organization_id = context_organization_id
              and binding.application_root_id = default_application_root_id_value
              and binding.application_release_revision = registration.source_revision
              and binding.state = 'active'
          )
      ) then
      return pg_catalog.jsonb_build_object('outcome', 'refused');
    end if;
  end if;

  select updated.* into strict saved
  from vortex_identity.save_organization_runtime_settings_record_internal(
    context_organization_id, p_expected_revision, p_core_values, p_extension_values
  ) as updated;
  return pg_catalog.jsonb_build_object(
    'outcome', 'saved',
    'recordId', saved.organization_id,
    'concurrencyNumber', saved.revision,
    'correlationId', context_correlation_id
  );
exception
  when serialization_failure or deadlock_detected then
    get stacked diagnostics
      failure_sqlstate = returned_sqlstate,
      failure_message = message_text;
    raise log 'Organization settings persistence conflicted: % (%)', failure_message, failure_sqlstate;
    return pg_catalog.jsonb_build_object(
      'outcome', 'conflict', 'reasonCode', 'persistence_conflict_' || failure_sqlstate
    );
  when no_data_found or too_many_rows or insufficient_privilege or check_violation
    or object_not_in_prerequisite_state or invalid_text_representation then
    get stacked diagnostics
      failure_sqlstate = returned_sqlstate,
      failure_message = message_text;
    raise log 'Organization settings persistence refused: % (%)', failure_message, failure_sqlstate;
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'persistence_refused_' || failure_sqlstate
    );
end
$function$;

set local role vortex_owner;

set local role postgres;
-- guard-allow: migration-owner-role Existing function retains postgres ownership until baseline table policies migrate.
CREATE OR REPLACE FUNCTION vortex_access.withdraw_application_permission_registration_v1_internal(p_organization_id uuid, p_application_root_id uuid, p_expected_revision bigint, p_changed_by uuid, p_correlation_id uuid) RETURNS TABLE(operation text, organization_id uuid, application_root_id uuid, registration_state text, registration_revision bigint, access_version bigint, correlation_id uuid)
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
    source_validation_contract_version, source_content_fingerprint,
    source_resolution_fingerprint, source_catalogue_fingerprint, meaning_fingerprint,
    record_scope, field_policy
  )
  select entry.organization_id, entry.registration_kind, entry.registration_owner_id,
    next_revision, entry.application_root_id, entry.owner_kind, entry.owner_id,
    entry.permission_id, entry.permission_key, entry.label, entry.description,
    entry.record_type_id, entry.action_kind, entry.named_action, entry.administrative,
    entry.source_kind, entry.source_definition_key, entry.source_root_id,
    entry.source_version, entry.source_revision, entry.source_validation_contract_version,
    entry.source_content_fingerprint, entry.source_resolution_fingerprint,
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

set local role vortex_owner;

reset role;
