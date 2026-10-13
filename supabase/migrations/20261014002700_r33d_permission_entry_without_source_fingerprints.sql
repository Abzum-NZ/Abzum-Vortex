set local role vortex_owner;

-- The baseline catalogue table and these functions are owned by postgres.
reset role;
-- guard-allow: migration-owner-role Transfer the legacy catalogue table before changing its columns.
alter table vortex_access.permission_catalogue_entries owner to vortex_owner;
-- guard-allow: migration-owner-role Transfer a legacy function before replacing its definition.
alter function vortex_access.adopt_builder_permission_catalogue(uuid,uuid,uuid) owner to vortex_owner;
-- guard-allow: migration-owner-role Transfer a legacy function before replacing its definition.
alter function vortex_access.adopt_connection_administration_permission_catalogue(uuid,uuid,uuid) owner to vortex_owner;
-- guard-allow: migration-owner-role Transfer a legacy function before replacing its definition.
alter function vortex_access.evaluate_record_permission_row_scope_internal(jsonb,timestamp with time zone,timestamp with time zone,uuid,jsonb,jsonb,uuid,jsonb,uuid[]) owner to vortex_owner;
-- guard-allow: migration-owner-role Transfer a legacy function before replacing its definition.
alter function vortex_access.platform_permission_catalogue_revision_is_exact(uuid,bigint) owner to vortex_owner;
-- guard-allow: migration-owner-role Transfer a legacy function before replacing its definition.
alter function vortex_access.platform_permission_catalogue_revision_is_exact_v1_2_0(uuid,bigint) owner to vortex_owner;
-- guard-allow: migration-owner-role Transfer a legacy function before replacing its definition.
alter function vortex_access.platform_permission_catalogue_revision_is_exact_v1_4_0(uuid,bigint) owner to vortex_owner;
-- guard-allow: migration-owner-role Transfer a legacy function before replacing its definition.
alter function vortex_access.read_organization_role_change_evidence_for_administration(jsonb) owner to vortex_owner;
-- guard-allow: migration-owner-role Transfer a legacy function before replacing its definition.
alter function vortex_access.revise_platform_permission_catalogue_metadata(uuid,bigint,text,text,uuid,uuid) owner to vortex_owner;
-- guard-allow: migration-owner-role Transfer a legacy function before replacing its definition.
alter function vortex_access.adopt_security_and_support_operator_permission_catalogue(p_organization_id uuid, p_changed_by uuid, p_correlation_id uuid) owner to vortex_owner;
-- guard-allow: migration-owner-role Transfer a legacy function before replacing its definition.
alter function vortex_access.adopt_shipped_platform_permission_catalogue(p_organization_id uuid, p_expected_registration_revision bigint, p_target_catalogue_version text, p_target_catalogue_fingerprint text, p_changed_by uuid, p_correlation_id uuid) owner to vortex_owner;
-- guard-allow: migration-owner-role Transfer a legacy function before replacing its definition.
alter function vortex_access.application_permission_registration_matches_candidate(p_organization_id uuid, p_application_root_id uuid, p_registration_revision bigint, p_candidate jsonb) owner to vortex_owner;
-- guard-allow: migration-owner-role Transfer a legacy function before replacing its definition.
alter function vortex_access.apply_application_permission_registration_v1_internal(p_operation text, p_expected_revision bigint, p_candidate jsonb, p_changed_by uuid, p_correlation_id uuid) owner to vortex_owner;
-- guard-allow: migration-owner-role Transfer a legacy function before replacing its definition.
alter function vortex_access.evaluate_organization_record_permission_eligibility_internal(p_declaration jsonb, p_context jsonb, p_checked_at timestamp with time zone) owner to vortex_owner;
-- guard-allow: migration-owner-role Transfer a legacy function before replacing its definition.
alter function vortex_access.initialize_platform_permission_catalogue_v1(p_organization_id uuid, p_changed_by uuid, p_correlation_id uuid) owner to vortex_owner;
-- guard-allow: migration-owner-role Transfer a legacy function before replacing its definition.
alter function vortex_access.platform_permission_catalogue_revision_is_exact_v1_0_1(p_organization_id uuid, p_registration_revision bigint) owner to vortex_owner;
-- guard-allow: migration-owner-role Transfer a legacy function before replacing its definition.
alter function vortex_access.platform_permission_catalogue_revision_is_exact_v1_3_0(p_organization_id uuid, p_registration_revision bigint) owner to vortex_owner;
-- guard-allow: migration-owner-role Transfer a legacy function before replacing its definition.
alter function vortex_access.withdraw_application_permission_registration_v1_internal(p_organization_id uuid, p_application_root_id uuid, p_expected_revision bigint, p_changed_by uuid, p_correlation_id uuid) owner to vortex_owner;
set local role vortex_owner;

-- Other baseline functions still access the transferred catalogue table.
grant all on table vortex_access.permission_catalogue_entries to postgres;

alter table vortex_access.permission_catalogue_entries
  drop constraint permission_catalogue_entries_fingerprints_valid,
  drop constraint permission_catalogue_entries_scope_shape;
alter table vortex_access.permission_catalogue_entries
  drop column source_content_fingerprint,
  drop column source_resolution_fingerprint;
alter table vortex_access.permission_catalogue_entries
  add constraint permission_catalogue_entries_fingerprints_valid check (
    (source_catalogue_fingerprint is null
      or source_catalogue_fingerprint ~ '^sha256:[a-f0-9]{64}$')
    and meaning_fingerprint ~ '^sha256:[a-f0-9]{64}$'
  ),
  add constraint permission_catalogue_entries_scope_shape check (
    (registration_kind = 'platform'
      and registration_owner_id = 'cabe121e-0baf-4084-9471-cce915d460a8'::uuid
      and application_root_id is null and owner_kind = 'platform'
      and owner_id = registration_owner_id
      and source_kind = 'platform_catalogue'
      and source_definition_key is null and source_root_id is null
      and source_revision is null
      and source_validation_contract_version is null
      and source_catalogue_fingerprint is not null)
    or (registration_kind = 'application'
      and application_root_id = registration_owner_id
      and owner_kind in ('application', 'module')
      and source_kind = owner_kind and source_definition_key is not null
      and source_root_id = owner_id and source_revision is not null
      and source_validation_contract_version is not null
      and source_catalogue_fingerprint is null
      and (owner_kind <> 'application' or owner_id = application_root_id))
  );

-- The output columns changed, so PostgreSQL requires a new function identity.
drop function vortex_access.read_available_permission(uuid, uuid, text, uuid, uuid);

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
    source_validation_contract_version, source_catalogue_fingerprint,
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
    source_validation_contract_version, source_catalogue_fingerprint,
    meaning_fingerprint
  ) values
    (
      p_organization_id, 'platform', platform_owner_id, 6, null,
      'platform', platform_owner_id, drafts_permission_id,
      'platform.organization.definition_drafts.manage', 'Manage definition drafts',
      'Create and change module and application drafts, including flows, placements and role templates, without publication or installation authority.',
      null, 'manage', null, true, 'platform_catalogue', null, null,
      '1.4.0', null, null, catalogue_fingerprint,
      drafts_meaning_fingerprint
    ),
    (
      p_organization_id, 'platform', platform_owner_id, 6, null,
      'platform', platform_owner_id, releases_permission_id,
      'platform.organization.definition_releases.manage', 'Manage definition releases',
      'Publish module and application drafts as immutable releases without receiving installation or business-record authority.',
      null, 'manage', null, true, 'platform_catalogue', null, null,
      '1.4.0', null, null, catalogue_fingerprint,
      releases_meaning_fingerprint
    ),
    (
      p_organization_id, 'platform', platform_owner_id, 6, null,
      'platform', platform_owner_id, custom_code_permission_id,
      'platform.organization.custom_code.manage', 'Manage custom code',
      'Required in addition to the application-management permission to install, upgrade or uninstall packages that bundle custom components or scripts.',
      null, 'manage', null, true, 'platform_catalogue', null, null,
      '1.4.0', null, null, catalogue_fingerprint,
      custom_code_meaning_fingerprint
    ),
    (
      p_organization_id, 'platform', platform_owner_id, 6, null,
      'platform', platform_owner_id, system_applications_permission_id,
      'platform.organization.system_applications.manage', 'Manage system applications',
      'Change system application definitions, including extension fields, theme, navigation and dependent applications, without uninstallation authority.',
      null, 'manage', null, true, 'platform_catalogue', null, null,
      '1.4.0', null, null, catalogue_fingerprint,
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

revoke all on function
  vortex_access.adopt_builder_permission_catalogue(uuid, uuid, uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

comment on function vortex_access.adopt_builder_permission_catalogue(uuid, uuid, uuid) is
  'Owner-only additive adoption of platform catalogue revision 6 (1.4.0): registers the four builder permissions without changing any earlier permission or granting any role authority.';

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
    source_validation_contract_version, source_catalogue_fingerprint,
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
    source_validation_contract_version, source_catalogue_fingerprint,
    meaning_fingerprint
  ) values (
    p_organization_id, 'platform', platform_owner_id, 4, null,
    'platform', platform_owner_id, connection_permission_id,
    'platform.organization.connections.manage', 'Manage connections',
    'Register, grant, check, revoke and reauthorise connection instances in the selected organisation without application-installation or access-assignment authority.',
    null, 'manage', null, true, 'platform_catalogue', null, null,
    '1.2.0', null, null, catalogue_fingerprint,
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

REVOKE ALL ON FUNCTION vortex_access.adopt_connection_administration_permission_catalogue(p_organization_id uuid, p_changed_by uuid, p_correlation_id uuid) FROM PUBLIC;

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
    source_validation_contract_version, source_catalogue_fingerprint, meaning_fingerprint
  )
  select p_organization_id, 'platform', platform_owner_id, 3, null, 'platform',
    platform_owner_id, (entry ->> 'permissionId')::uuid, entry ->> 'key',
    entry ->> 'label', entry ->> 'description', null, entry ->> 'actionKind', null, true,
    'platform_catalogue', null, null, p_target_catalogue_version, null, null,
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

ALTER FUNCTION vortex_access.adopt_shipped_platform_permission_catalogue(p_organization_id uuid, p_expected_registration_revision bigint, p_target_catalogue_version text, p_target_catalogue_fingerprint text, p_changed_by uuid, p_correlation_id uuid) OWNER TO vortex_owner;

COMMENT ON FUNCTION vortex_access.adopt_shipped_platform_permission_catalogue(p_organization_id uuid, p_expected_registration_revision bigint, p_target_catalogue_version text, p_target_catalogue_fingerprint text, p_changed_by uuid, p_correlation_id uuid) IS 'Owner-only adoption of one compiled-in shipped platform catalogue successor.';

REVOKE ALL ON FUNCTION vortex_access.adopt_shipped_platform_permission_catalogue(p_organization_id uuid, p_expected_registration_revision bigint, p_target_catalogue_version text, p_target_catalogue_fingerprint text, p_changed_by uuid, p_correlation_id uuid) FROM PUBLIC;

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
          'contentFingerprint', source_release.content_fingerprint,
          'resolutionFingerprint', source_release.resolution_fingerprint
        ),
        'meaningFingerprint', entry.meaning_fingerprint
      ) order by
        entry.owner_kind collate "C", entry.owner_id,
        entry.permission_key collate "C", entry.permission_id
    ),
    '[]'::jsonb
  ) into actual_entries
  from vortex_access.permission_catalogue_entries as entry
  left join vortex_definition.releases as source_release
    on source_release.root_id = entry.source_root_id
    and source_release.release_revision = entry.source_revision
    and source_release.release_version = entry.source_version
    and source_release.validation_contract_version =
      entry.source_validation_contract_version
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

ALTER FUNCTION vortex_access.application_permission_registration_matches_candidate(p_organization_id uuid, p_application_root_id uuid, p_registration_revision bigint, p_candidate jsonb) OWNER TO vortex_owner;

REVOKE ALL ON FUNCTION vortex_access.application_permission_registration_matches_candidate(p_organization_id uuid, p_application_root_id uuid, p_registration_revision bigint, p_candidate jsonb) FROM PUBLIC;

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

ALTER FUNCTION vortex_access.apply_application_permission_registration_v1_internal(p_operation text, p_expected_revision bigint, p_candidate jsonb, p_changed_by uuid, p_correlation_id uuid) OWNER TO vortex_owner;

COMMENT ON FUNCTION vortex_access.apply_application_permission_registration_v1_internal(p_operation text, p_expected_revision bigint, p_candidate jsonb, p_changed_by uuid, p_correlation_id uuid) IS 'Legacy raw registration writer retained privately for the coordinated application-access composition only.';

REVOKE ALL ON FUNCTION vortex_access.apply_application_permission_registration_v1_internal(p_operation text, p_expected_revision bigint, p_candidate jsonb, p_changed_by uuid, p_correlation_id uuid) FROM PUBLIC;

CREATE OR REPLACE FUNCTION vortex_access.evaluate_organization_record_permission_eligibility_internal(p_declaration jsonb, p_context jsonb, p_checked_at timestamp with time zone) RETURNS jsonb
    LANGUAGE plpgsql STABLE
    SET search_path TO ''
    AS $_$
declare
  declaration_action jsonb;
  declaration_target jsonb;
  declaration_permissions jsonb;
  declaration_binding jsonb;
  declaration_authentication jsonb;
  declaration_authority jsonb;
  permission_candidate jsonb;
  previous_identity text;
  candidate_identity text;
  operation_value text;
  action_kind_value text;
  target_application_value uuid;
  binding_record_type_value uuid;
  context_value jsonb;
  context_organization_value uuid;
  context_account_value uuid;
  context_access_version_value bigint;
  context_application_value uuid;
  context_expires_value timestamptz;
  context_correlation_value uuid;
  authentication_deadline timestamptz;
  authentication_satisfied boolean := true;
  context_current boolean := true;
  target_context_satisfied boolean := true;
  unsupported_context boolean := false;
  decision_checked_at timestamptz;
  catalogue_available boolean := false;
  scoped_available boolean := false;
  path_effective boolean := false;
  eligible_permissions jsonb;
  eligible_valid_until timestamptz;
  refusal_reason text;
  evidence jsonb;
begin
  if p_declaration is null
    or pg_catalog.jsonb_typeof(p_declaration) <> 'object'
    or not p_declaration ?& array[
      'operationKey', 'action', 'target', 'requiredPermissions',
      'recordBinding', 'recentAuthentication', 'authority'
    ]
    or exists (
      select 1
      from pg_catalog.jsonb_object_keys(p_declaration) as supplied(key)
      where supplied.key <> all (array[
        'operationKey', 'action', 'target', 'requiredPermissions',
        'recordBinding', 'recentAuthentication', 'authority'
      ])
    )
    or pg_catalog.jsonb_typeof(p_declaration -> 'operationKey') <> 'string'
    or pg_catalog.char_length(p_declaration ->> 'operationKey') not between 3 and 120
    or (p_declaration ->> 'operationKey') !~
      '^[a-z][a-z0-9]*(?:_[a-z0-9]+)*(?:\.[a-z][a-z0-9]*(?:_[a-z0-9]+)*)+$'
    or (p_declaration ->> 'operationKey') ~ '(^|\.)[^.]{41,}(\.|$)' then
    raise exception using errcode = '22023',
      message = 'Organization record permission declaration is invalid';
  end if;

  declaration_action := p_declaration -> 'action';
  declaration_target := p_declaration -> 'target';
  declaration_permissions := p_declaration -> 'requiredPermissions';
  declaration_binding := p_declaration -> 'recordBinding';
  declaration_authentication := p_declaration -> 'recentAuthentication';
  declaration_authority := p_declaration -> 'authority';

  if pg_catalog.jsonb_typeof(declaration_action) <> 'object'
    or not declaration_action ? 'actionKind'
    or exists (
      select 1
      from pg_catalog.jsonb_object_keys(declaration_action) as supplied(key)
      where supplied.key <> all (array['actionKind', 'namedAction'])
    )
    or pg_catalog.jsonb_typeof(declaration_action -> 'actionKind') <> 'string'
    or declaration_action ->> 'actionKind' not in (
      'create', 'read', 'update', 'delete', 'restore', 'export', 'share', 'manage', 'transfer', 'named'
    )
    or (
      (declaration_action ->> 'actionKind') = 'named'
      and (
        not declaration_action ? 'namedAction'
        or pg_catalog.jsonb_typeof(declaration_action -> 'namedAction') <> 'string'
        or pg_catalog.char_length(declaration_action ->> 'namedAction') not between 1 and 40
        or (declaration_action ->> 'namedAction') !~
          '^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$'
      )
    )
    or (
      (declaration_action ->> 'actionKind') <> 'named'
      and declaration_action ? 'namedAction'
    ) then
    raise exception using errcode = '22023',
      message = 'Organization record permission declaration is invalid';
  end if;

  if pg_catalog.jsonb_typeof(declaration_target) <> 'object'
    or not declaration_target ?& array['kind', 'applicationRootId']
    or exists (
      select 1
      from pg_catalog.jsonb_object_keys(declaration_target) as supplied(key)
      where supplied.key <> all (array['kind', 'applicationRootId'])
    )
    or pg_catalog.jsonb_typeof(declaration_target -> 'kind') <> 'string'
    or declaration_target ->> 'kind' <> 'application'
    or not vortex_platform.is_non_nil_uuid(
      declaration_target ->> 'applicationRootId'
    ) then
    raise exception using errcode = '22023',
      message = 'Organization record permission declaration is invalid';
  end if;

  if pg_catalog.jsonb_typeof(declaration_binding) <> 'object'
    or not declaration_binding ?& array[
      'moduleRootId', 'recordTypeId', 'storageContractId', 'storageScope'
    ]
    or exists (
      select 1
      from pg_catalog.jsonb_object_keys(declaration_binding) as supplied(key)
      where supplied.key <> all (array[
        'moduleRootId', 'recordTypeId', 'storageContractId', 'storageScope'
      ])
    )
    or not vortex_platform.is_non_nil_uuid(declaration_binding ->> 'moduleRootId')
    or not vortex_platform.is_non_nil_uuid(declaration_binding ->> 'recordTypeId')
    or not vortex_platform.is_non_nil_uuid(
      declaration_binding ->> 'storageContractId'
    )
    or pg_catalog.jsonb_typeof(declaration_binding -> 'storageScope') <> 'string'
    or declaration_binding ->> 'storageScope' not in (
      'organization_shared', 'application_contained'
    ) then
    raise exception using errcode = '22023',
      message = 'Organization record permission declaration is invalid';
  end if;

  if pg_catalog.jsonb_typeof(declaration_authentication) <> 'object'
    or not declaration_authentication ? 'kind'
    or pg_catalog.jsonb_typeof(declaration_authentication -> 'kind') <> 'string'
    or declaration_authentication ->> 'kind' not in ('none', 'primary', 'multi_factor')
    or (
      declaration_authentication ->> 'kind' = 'none'
      and exists (
        select 1
        from pg_catalog.jsonb_object_keys(declaration_authentication) as supplied(key)
        where supplied.key <> 'kind'
      )
    )
    or (
      declaration_authentication ->> 'kind' in ('primary', 'multi_factor')
      and (
        not declaration_authentication ? 'maximumAgeSeconds'
        or pg_catalog.jsonb_typeof(
          declaration_authentication -> 'maximumAgeSeconds'
        ) <> 'number'
        or exists (
          select 1
          from pg_catalog.jsonb_object_keys(declaration_authentication) as supplied(key)
          where supplied.key <> all (array['kind', 'maximumAgeSeconds'])
        )
      )
    ) then
    raise exception using errcode = '22023',
      message = 'Organization record permission declaration is invalid';
  end if;

  if declaration_authentication ->> 'kind' in ('primary', 'multi_factor')
    and (
      (declaration_authentication ->> 'maximumAgeSeconds')::numeric < 1
      or (declaration_authentication ->> 'maximumAgeSeconds')::numeric >
        9007199254740991
      or (declaration_authentication ->> 'maximumAgeSeconds')::numeric <>
        pg_catalog.trunc(
          (declaration_authentication ->> 'maximumAgeSeconds')::numeric
        )
    ) then
    raise exception using errcode = '22023',
      message = 'Organization record permission declaration is invalid';
  end if;

  -- A record operation carries ordinary permission authority only; delegated
  -- management scopes stay on the existing non-record path.
  if pg_catalog.jsonb_typeof(declaration_authority) <> 'object'
    or not declaration_authority ? 'kind'
    or pg_catalog.jsonb_typeof(declaration_authority -> 'kind') <> 'string'
    or declaration_authority ->> 'kind' <> 'permission'
    or exists (
      select 1
      from pg_catalog.jsonb_object_keys(declaration_authority) as supplied(key)
      where supplied.key <> 'kind'
    ) then
    raise exception using errcode = '22023',
      message = 'Organization record permission declaration is invalid';
  end if;

  if pg_catalog.jsonb_typeof(declaration_permissions) <> 'array'
    or pg_catalog.jsonb_array_length(declaration_permissions) = 0 then
    raise exception using errcode = '22023',
      message = 'Organization record permission declaration is invalid';
  end if;

  previous_identity := null;
  for permission_candidate in
    select item.value
    from pg_catalog.jsonb_array_elements(declaration_permissions) as item(value)
  loop
    if pg_catalog.jsonb_typeof(permission_candidate) <> 'object'
      or not permission_candidate ?& array[
        'applicationRootId', 'ownerKind', 'ownerId', 'permissionId'
      ]
      or exists (
        select 1
        from pg_catalog.jsonb_object_keys(permission_candidate) as supplied(key)
        where supplied.key <> all (array[
          'applicationRootId', 'ownerKind', 'ownerId', 'permissionId'
        ])
      )
      or pg_catalog.jsonb_typeof(permission_candidate -> 'ownerKind') <> 'string'
      or permission_candidate ->> 'ownerKind' not in ('application', 'module')
      or not vortex_platform.is_non_nil_uuid(
        permission_candidate ->> 'applicationRootId'
      )
      or not vortex_platform.is_non_nil_uuid(permission_candidate ->> 'ownerId')
      or not vortex_platform.is_non_nil_uuid(permission_candidate ->> 'permissionId')
      or pg_catalog.lower(permission_candidate ->> 'applicationRootId') <>
        pg_catalog.lower(declaration_target ->> 'applicationRootId')
      or (
        permission_candidate ->> 'ownerKind' = 'application'
        and pg_catalog.lower(permission_candidate ->> 'ownerId') <>
          pg_catalog.lower(permission_candidate ->> 'applicationRootId')
      )
      or (
        permission_candidate ->> 'ownerKind' = 'module'
        and pg_catalog.lower(permission_candidate ->> 'ownerId') <>
          pg_catalog.lower(declaration_binding ->> 'moduleRootId')
      ) then
      raise exception using errcode = '22023',
        message = 'Organization record permission declaration is invalid';
    end if;

    candidate_identity := pg_catalog.concat_ws(
      ':',
      pg_catalog.lower(permission_candidate ->> 'applicationRootId'),
      permission_candidate ->> 'ownerKind',
      pg_catalog.lower(permission_candidate ->> 'ownerId'),
      pg_catalog.lower(permission_candidate ->> 'permissionId')
    );
    if previous_identity is not null
      and previous_identity collate "C" >= candidate_identity then
      raise exception using errcode = '22023',
        message = 'Organization record permission declaration is invalid';
    end if;
    previous_identity := candidate_identity;
  end loop;

  operation_value := p_declaration ->> 'operationKey';
  action_kind_value := declaration_action ->> 'actionKind';
  target_application_value := (declaration_target ->> 'applicationRootId')::uuid;
  binding_record_type_value := (declaration_binding ->> 'recordTypeId')::uuid;

  if action_kind_value = 'named'
    and exists (
      select 1
      from pg_catalog.jsonb_array_elements(declaration_permissions) as item(value)
      where item.value ->> 'ownerKind' <>
          declaration_permissions -> 0 ->> 'ownerKind'
        or pg_catalog.lower(item.value ->> 'ownerId') <>
          pg_catalog.lower(declaration_permissions -> 0 ->> 'ownerId')
    ) then
    raise exception using errcode = '22023',
      message = 'Organization record permission declaration is invalid';
  end if;

  context_value := p_context;
  context_organization_value := (context_value ->> 'organizationId')::uuid;
  context_account_value := (context_value ->> 'organizationAccountId')::uuid;
  context_access_version_value := (context_value ->> 'accessVersion')::bigint;
  context_application_value := case
    when context_value ? 'applicationRootId'
      then (context_value ->> 'applicationRootId')::uuid
    else null
  end;
  context_expires_value := (context_value ->> 'expiresAt')::timestamptz;
  context_correlation_value := (context_value ->> 'correlationId')::uuid;
  decision_checked_at := p_checked_at;
  context_current := context_expires_value > decision_checked_at;

  unsupported_context := context_value ? 'delegatedContext'
    or context_value ? 'supportContext';
  target_context_satisfied := coalesce(
    context_application_value = target_application_value, false
  );

  authentication_deadline := vortex_access.recent_authentication_deadline_internal(
    context_value, decision_checked_at, declaration_authentication
  );
  authentication_satisfied := authentication_deadline is not null;

  -- Every declared alternative is evaluated against its exact record type by the
  -- shared role-path helper under this one context and checked time. A candidate
  -- keeps its own catalogue record scope, immutable source release and path
  -- deadline; an alternative never lends authority to another. Keeping
  -- path_valid_until separate from authentication_deadline here (instead of
  -- combining them per row) is what lets the three existence flags below tell
  -- "no catalogue entry", "entry without record scope" and "scoped entry
  -- without a live path" apart as distinct refusal reasons.
  with candidate as (
    select declared.ordinality as alternative_ordinal,
      declared.value as permission_value,
      (evaluated.permission_entry).registration_revision as registration_revision,
      (evaluated.permission_entry).record_scope as record_scope,
      pg_catalog.jsonb_build_object(
        'kind', (evaluated.permission_entry).source_kind,
        'definitionKey', (evaluated.permission_entry).source_definition_key,
        'rootId', (evaluated.permission_entry).source_root_id,
        'releaseRevision', (evaluated.permission_entry).source_revision,
        'releaseVersion', (evaluated.permission_entry).source_version,
        'validationContractVersion',
          (evaluated.permission_entry).source_validation_contract_version
      ) as source_release,
      evaluated.path_valid_until as path_valid_until
    from pg_catalog.jsonb_array_elements(declaration_permissions)
      with ordinality as declared(value, ordinality)
    cross join lateral vortex_access.evaluate_permission_role_path_internal(
      context_value, decision_checked_at, declared.value, declaration_action,
      binding_record_type_value
    ) as evaluated
  )
  select pg_catalog.count(*) > 0,
    pg_catalog.count(*) filter (where candidate.record_scope is not null) > 0,
    pg_catalog.count(*) filter (
      where candidate.record_scope is not null
        and candidate.path_valid_until is not null
    ) > 0,
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'permission', candidate.permission_value,
        'registrationRevision', candidate.registration_revision,
        'recordScope', candidate.record_scope,
        'source', candidate.source_release,
        'validUntil', pg_catalog.to_char(
          pg_catalog.timezone(
            'UTC', least(candidate.path_valid_until, authentication_deadline)
          ),
          'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
        )
      ) order by candidate.alternative_ordinal
    ) filter (
      where candidate.record_scope is not null
        and candidate.path_valid_until is not null
        and authentication_deadline is not null
    ),
    pg_catalog.min(least(candidate.path_valid_until, authentication_deadline))
      filter (
        where candidate.record_scope is not null
          and candidate.path_valid_until is not null
          and authentication_deadline is not null
      )
  into catalogue_available, scoped_available, path_effective, eligible_permissions,
    eligible_valid_until
  from candidate;

  evidence := pg_catalog.jsonb_build_object(
    'operationKey', operation_value,
    'target', declaration_target,
    'organizationId', context_organization_value,
    'organizationAccountId', context_account_value,
    'accessVersion', context_access_version_value,
    'checkedAt', pg_catalog.to_char(
      pg_catalog.timezone('UTC', decision_checked_at),
      'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
    ),
    'correlationId', context_correlation_value,
    'recordBinding', declaration_binding
  );

  -- Refusal precedence keeps each cause distinguishable: an unsupported
  -- context always wins; then "no candidate has any catalogue entry"; then
  -- "entries exist but none carries record_scope"; then "scoped entries exist
  -- but none has a live role path"; only then does recent-authentication
  -- refuse an otherwise-complete set of alternatives.
  refusal_reason := case
    when not context_current
      or unsupported_context or not target_context_satisfied
      then 'target_policy_unavailable'
    when not catalogue_available then 'permission_unavailable'
    when not scoped_available then 'target_policy_unavailable'
    when not path_effective then 'permission_not_effective'
    when not authentication_satisfied then 'authentication_unsatisfied'
    else null
  end;

  if refusal_reason is not null then
    return evidence || pg_catalog.jsonb_build_object(
      'outcome', 'refused',
      'reasonCode', refusal_reason
    );
  end if;

  return evidence || pg_catalog.jsonb_build_object(
    'outcome', 'eligible',
    'validUntil', pg_catalog.to_char(
      pg_catalog.timezone('UTC', eligible_valid_until),
      'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
    ),
    'eligiblePermissions', eligible_permissions
  );
end
$_$;

ALTER FUNCTION vortex_access.evaluate_organization_record_permission_eligibility_internal(p_declaration jsonb, p_context jsonb, p_checked_at timestamp with time zone) OWNER TO vortex_owner;

COMMENT ON FUNCTION vortex_access.evaluate_organization_record_permission_eligibility_internal(p_declaration jsonb, p_context jsonb, p_checked_at timestamp with time zone) IS 'Private record-permission eligibility evidence per declared alternative; carries the declared record binding as context and is never a record allow result. The caller supplies one Access-bound context and checked time.';

REVOKE ALL ON FUNCTION vortex_access.evaluate_organization_record_permission_eligibility_internal(p_declaration jsonb, p_context jsonb, p_checked_at timestamp with time zone) FROM PUBLIC;
GRANT ALL ON FUNCTION vortex_access.evaluate_organization_record_permission_eligibility_internal(p_declaration jsonb, p_context jsonb, p_checked_at timestamp with time zone) TO vortex_owner;

create or replace function vortex_access.evaluate_record_permission_row_scope_internal(
  p_context jsonb,
  p_checked_at timestamptz,
  p_auth_deadline timestamptz,
  p_application_root_id uuid,
  p_action jsonb,
  p_candidate jsonb,
  p_record_id uuid,
  p_facts jsonb,
  p_path uuid[]
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  context_organization_id uuid := (p_context ->> 'organizationId')::uuid;
  context_account_id uuid := (p_context ->> 'organizationAccountId')::uuid;
  action_kind text := p_action ->> 'actionKind';
  candidate_permission jsonb := p_candidate -> 'permission';
  candidate_record_scope jsonb := p_candidate -> 'recordScope';
  candidate_valid_until timestamptz := (p_candidate ->> 'validUntil')::timestamptz;
  target_record jsonb;
  target_record_scope jsonb;
  target_type jsonb;
  has_all_records boolean;
  has_ownership boolean;
  has_direct_share boolean;
  route_list jsonb[] := array[]::jsonb[];
  deadline_list timestamptz[] := array[]::timestamptz[];
  ownership_admitted boolean;
  ownership_deadline timestamptz;
  chase_record jsonb;
  chase_scope jsonb;
  chase_type jsonb;
  chase_relationship jsonb;
  chase_edge jsonb;
  chase_edge_count integer;
  chase_target jsonb;
  parent_record jsonb;
  parent_scope jsonb;
  parent_type jsonb;
  visited_ids uuid[];
  chase_admitted boolean;
  chase_deadline timestamptz;
  share_row record;
  route jsonb;
  relationship_decl jsonb;
  source_owner_kind text;
  source_owner_id uuid;
  source_eval record;
  source_permission_entry vortex_access.permission_catalogue_entries;
  source_path_valid_until timestamptz;
  source_valid_until timestamptz;
  source_candidate jsonb;
  source_record jsonb;
  source_record_scope jsonb;
  edge_item jsonb;
  sub_result jsonb;
  sub_min_valid_until timestamptz;
  contribution_deadline timestamptz;
  condition_id uuid;
  saved_condition jsonb;
  projected_values jsonb;
  declared_field jsonb;
  reduced_type jsonb;
  condition_ok boolean;
  result jsonb;
begin
  select value into target_record
  from pg_catalog.jsonb_array_elements(p_facts -> 'records') as item(value)
  where (value -> 'recordScope' ->> 'recordId')::uuid = p_record_id
  limit 1;

  if target_record is null or target_record ->> 'lifecycleState' <> 'active' then
    return '[]'::jsonb;
  end if;

  target_record_scope := target_record -> 'recordScope';

  select value into target_type
  from pg_catalog.jsonb_array_elements(p_facts -> 'recordTypes') as item(value)
  where (value ->> 'recordTypeId')::uuid = (target_record_scope ->> 'recordTypeId')::uuid
  limit 1;

  if target_type is null then
    return '[]'::jsonb;
  end if;

  has_all_records := exists (
    select 1 from pg_catalog.jsonb_array_elements(candidate_record_scope -> 'routes') as item(value)
    where item.value ->> 'kind' = 'all_records'
  );
  has_ownership := exists (
    select 1 from pg_catalog.jsonb_array_elements(candidate_record_scope -> 'routes') as item(value)
    where item.value ->> 'kind' = 'ownership'
  );
  has_direct_share := exists (
    select 1 from pg_catalog.jsonb_array_elements(candidate_record_scope -> 'routes') as item(value)
    where item.value ->> 'kind' = 'direct_share'
  );

  -- Step 2: base ownership/all-record routes, then inherited-ownership chase.
  if has_all_records or has_ownership then
    select outcome.admitted, outcome.valid_until into ownership_admitted, ownership_deadline
    from vortex_access.evaluate_current_record_ownership_visibility(
      candidate_record_scope,
      target_type ->> 'ownershipMode',
      context_organization_id,
      p_application_root_id,
      (target_type ->> 'moduleRootId')::uuid,
      (target_type ->> 'recordTypeId')::uuid,
      (target_type ->> 'storageContractId')::uuid,
      target_type ->> 'storageScope',
      target_record_scope,
      (target_record ->> 'ownerOrganizationAccountId')::uuid,
      (target_record ->> 'ownerGroupId')::uuid,
      context_organization_id,
      p_application_root_id,
      context_account_id,
      p_checked_at
    ) as outcome;

    if ownership_admitted then
      route_list := pg_catalog.array_append(route_list, pg_catalog.jsonb_build_object(
        'kind', case when has_all_records then 'all_records' else 'ownership' end
      ));
      deadline_list := pg_catalog.array_append(deadline_list, ownership_deadline);
    elsif has_ownership and target_type ->> 'ownershipMode' = 'inherited' then
      chase_record := target_record;
      chase_scope := target_record_scope;
      chase_type := target_type;
      visited_ids := array[(target_record_scope ->> 'recordId')::uuid];

      while chase_type ->> 'ownershipMode' = 'inherited' loop
        select value into chase_relationship
        from pg_catalog.jsonb_array_elements(p_facts -> 'relationships') as item(value)
        where (value ->> 'relationshipId')::uuid = (chase_type ->> 'ownershipRelationshipId')::uuid
        limit 1;

        exit when chase_relationship is null;

        select pg_catalog.count(*) into chase_edge_count
        from pg_catalog.jsonb_array_elements(p_facts -> 'edges') as item(value)
        where (value ->> 'relationshipId')::uuid = (chase_relationship ->> 'relationshipId')::uuid
          and (value ->> 'fromRecordId')::uuid = (chase_scope ->> 'recordId')::uuid;

        exit when chase_edge_count <> 1;

        select value into chase_edge
        from pg_catalog.jsonb_array_elements(p_facts -> 'edges') as item(value)
        where (value ->> 'relationshipId')::uuid = (chase_relationship ->> 'relationshipId')::uuid
          and (value ->> 'fromRecordId')::uuid = (chase_scope ->> 'recordId')::uuid
        limit 1;

        select value into parent_record
        from pg_catalog.jsonb_array_elements(p_facts -> 'records') as item(value)
        where (value -> 'recordScope' ->> 'recordId')::uuid = (chase_edge ->> 'toRecordId')::uuid
        limit 1;

        exit when parent_record is null or parent_record ->> 'lifecycleState' <> 'active';

        parent_scope := parent_record -> 'recordScope';

        select value into parent_type
        from pg_catalog.jsonb_array_elements(p_facts -> 'recordTypes') as item(value)
        where (value ->> 'recordTypeId')::uuid = (parent_scope ->> 'recordTypeId')::uuid
        limit 1;

        exit when parent_type is null;

        select item.value into chase_target
        from pg_catalog.jsonb_array_elements(chase_relationship -> 'toRecordTypes') as item(value)
        where pg_catalog.lower(item.value ->> 'moduleRootId') =
            pg_catalog.lower(parent_scope ->> 'moduleRootId')
          and pg_catalog.lower(item.value ->> 'recordTypeId') =
            pg_catalog.lower(parent_scope ->> 'recordTypeId')
        limit 1;

        exit when chase_target is null;

        exit when not vortex_access.record_relationship_witness_matches(
          (chase_relationship ->> 'relationshipId')::uuid,
          (chase_relationship ->> 'fromModuleRootId')::uuid,
          (chase_relationship ->> 'fromRecordTypeId')::uuid,
          (chase_target ->> 'moduleRootId')::uuid,
          (chase_target ->> 'recordTypeId')::uuid,
          (chase_edge ->> 'relationshipId')::uuid,
          (chase_edge ->> 'fromRecordId')::uuid,
          (chase_edge ->> 'toRecordId')::uuid,
          chase_scope,
          parent_scope,
          context_organization_id,
          p_application_root_id
        );

        exit when (parent_scope ->> 'recordId')::uuid = any(visited_ids);

        visited_ids := pg_catalog.array_append(visited_ids, (parent_scope ->> 'recordId')::uuid);
        chase_record := parent_record;
        chase_scope := parent_scope;
        chase_type := parent_type;
      end loop;

      if chase_type ->> 'ownershipMode' in ('organization_account', 'group') then
        select outcome.admitted, outcome.valid_until into chase_admitted, chase_deadline
        from vortex_access.evaluate_current_record_ownership_visibility(
          '{"routes":[{"kind":"ownership"}]}'::jsonb,
          chase_type ->> 'ownershipMode',
          context_organization_id,
          p_application_root_id,
          (chase_type ->> 'moduleRootId')::uuid,
          (chase_type ->> 'recordTypeId')::uuid,
          (chase_type ->> 'storageContractId')::uuid,
          chase_type ->> 'storageScope',
          chase_scope,
          (chase_record ->> 'ownerOrganizationAccountId')::uuid,
          (chase_record ->> 'ownerGroupId')::uuid,
          context_organization_id,
          p_application_root_id,
          context_account_id,
          p_checked_at
        ) as outcome;

        if chase_admitted then
          route_list := pg_catalog.array_append(route_list, pg_catalog.jsonb_build_object('kind', 'ownership'));
          deadline_list := pg_catalog.array_append(deadline_list, chase_deadline);
        end if;
      end if;
    end if;
  end if;

  -- Step 3: direct share, read/update only, each recipient contributing
  -- independently with its own field bounds.
  if has_direct_share and action_kind in ('read', 'update') then
    for share_row in
      select *
      from vortex_access.read_current_direct_record_share_contributions(
        context_organization_id,
        p_application_root_id,
        (target_type ->> 'moduleRootId')::uuid,
        (target_type ->> 'recordTypeId')::uuid,
        (target_type ->> 'storageContractId')::uuid,
        target_type ->> 'storageScope',
        p_record_id,
        context_organization_id,
        p_application_root_id,
        context_account_id,
        p_checked_at
      )
    loop
      if action_kind = 'update' and pg_catalog.cardinality(share_row.changeable_field_ids) = 0 then
        continue;
      end if;
      route_list := pg_catalog.array_append(route_list, pg_catalog.jsonb_build_object(
        'kind', 'direct_share',
        'directShareId', share_row.direct_share_id,
        'directShareRevision', share_row.direct_share_revision,
        'readableFieldIds', pg_catalog.to_jsonb(share_row.readable_field_ids),
        'changeableFieldIds', pg_catalog.to_jsonb(share_row.changeable_field_ids)
      ));
      deadline_list := pg_catalog.array_append(deadline_list, share_row.valid_until);
    end loop;
  end if;

  -- Step 4: relationship routes. The target record is always the relationship's
  -- `to` endpoint and the source record its `from` endpoint (see
  -- runtime/definition/src/validation.ts). Every recursive step re-evaluates
  -- the source permission's own eligibility and own complete scope; authority
  -- never crosses alternatives.
  for route in
    select value from pg_catalog.jsonb_array_elements(candidate_record_scope -> 'routes') as item(value)
    where value ->> 'kind' = 'relationship'
  loop
    select value into relationship_decl
    from pg_catalog.jsonb_array_elements(p_facts -> 'relationships') as item(value)
    where (value ->> 'relationshipId')::uuid = (route ->> 'relationshipId')::uuid
    limit 1;

    if relationship_decl is null
      or not exists (
        select 1
        from pg_catalog.jsonb_array_elements(relationship_decl -> 'toRecordTypes') as declared(value)
        where pg_catalog.lower(declared.value ->> 'moduleRootId') = pg_catalog.lower(target_type ->> 'moduleRootId')
          and pg_catalog.lower(declared.value ->> 'recordTypeId') = pg_catalog.lower(target_type ->> 'recordTypeId')
      ) then
      raise exception using errcode = '22023', message = 'Record access facts are invalid';
    end if;

    if (route ->> 'sourcePermissionId')::uuid = any(p_path) then
      continue;
    end if;

    begin
      select entry.owner_kind, entry.owner_id
      into strict source_owner_kind, source_owner_id
      from vortex_access.permission_catalogue_entries as entry
      join vortex_access.permission_registrations as registration
        on registration.organization_id = entry.organization_id
        and registration.registration_kind = entry.registration_kind
        and registration.registration_owner_id = entry.registration_owner_id
        and registration.revision = entry.registration_revision
        and registration.state = 'active'
      where entry.organization_id = context_organization_id
        and entry.application_root_id = p_application_root_id
        and entry.permission_id = (route ->> 'sourcePermissionId')::uuid
        and entry.record_type_id = (relationship_decl ->> 'fromRecordTypeId')::uuid
        and entry.action_kind = 'read'
        and entry.named_action is null;
    exception
      when no_data_found or too_many_rows then
        continue;
    end;

    source_eval := null;
    select evaluated.permission_entry, evaluated.path_valid_until
    into source_eval
    from vortex_access.evaluate_permission_role_path_internal(
      p_context,
      p_checked_at,
      pg_catalog.jsonb_build_object(
        'applicationRootId', p_application_root_id,
        'ownerKind', source_owner_kind,
        'ownerId', source_owner_id,
        'permissionId', (route ->> 'sourcePermissionId')::uuid
      ),
      pg_catalog.jsonb_build_object('actionKind', 'read'),
      (relationship_decl ->> 'fromRecordTypeId')::uuid
    ) as evaluated
    limit 1;

    if source_eval is null or (source_eval.permission_entry).record_scope is null
      or source_eval.path_valid_until is null or p_auth_deadline is null then
      continue;
    end if;
    source_permission_entry := source_eval.permission_entry;
    source_path_valid_until := source_eval.path_valid_until;
    source_valid_until := least(source_path_valid_until, p_auth_deadline);

    source_candidate := pg_catalog.jsonb_build_object(
      'permission', pg_catalog.jsonb_build_object(
        'applicationRootId', p_application_root_id,
        'ownerKind', source_owner_kind,
        'ownerId', source_owner_id,
        'permissionId', (route ->> 'sourcePermissionId')::uuid
      ),
      'registrationRevision', (source_permission_entry).registration_revision,
      'recordScope', (source_permission_entry).record_scope,
      'source', pg_catalog.jsonb_build_object(
        'kind', (source_permission_entry).source_kind,
        'definitionKey', (source_permission_entry).source_definition_key,
        'rootId', (source_permission_entry).source_root_id,
        'releaseRevision', (source_permission_entry).source_revision,
        'releaseVersion', (source_permission_entry).source_version,
        'validationContractVersion', (source_permission_entry).source_validation_contract_version
      ),
      'validUntil', pg_catalog.to_char(
        pg_catalog.timezone('UTC', source_valid_until), 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
      )
    );

    for edge_item in
      select value from pg_catalog.jsonb_array_elements(p_facts -> 'edges') as item(value)
      where (value ->> 'relationshipId')::uuid = (relationship_decl ->> 'relationshipId')::uuid
        and (value ->> 'toRecordId')::uuid = p_record_id
    loop
      select value into source_record
      from pg_catalog.jsonb_array_elements(p_facts -> 'records') as item(value)
      where (value -> 'recordScope' ->> 'recordId')::uuid = (edge_item ->> 'fromRecordId')::uuid
      limit 1;

      if source_record is null or source_record ->> 'lifecycleState' <> 'active' then
        continue;
      end if;
      source_record_scope := source_record -> 'recordScope';

      if pg_catalog.lower(source_record_scope ->> 'recordTypeId')
        <> pg_catalog.lower(relationship_decl ->> 'fromRecordTypeId') then
        continue;
      end if;

      if not vortex_access.record_relationship_witness_matches(
        (relationship_decl ->> 'relationshipId')::uuid,
        (relationship_decl ->> 'fromModuleRootId')::uuid,
        (relationship_decl ->> 'fromRecordTypeId')::uuid,
        (target_type ->> 'moduleRootId')::uuid,
        (target_type ->> 'recordTypeId')::uuid,
        (edge_item ->> 'relationshipId')::uuid,
        (edge_item ->> 'fromRecordId')::uuid,
        (edge_item ->> 'toRecordId')::uuid,
        source_record_scope,
        target_record_scope,
        context_organization_id,
        p_application_root_id
      ) then
        continue;
      end if;

      sub_result := vortex_access.evaluate_record_permission_row_scope_internal(
        p_context,
        p_checked_at,
        p_auth_deadline,
        p_application_root_id,
        pg_catalog.jsonb_build_object('actionKind', 'read'),
        source_candidate,
        (edge_item ->> 'fromRecordId')::uuid,
        p_facts,
        pg_catalog.array_append(p_path, (route ->> 'sourcePermissionId')::uuid)
      );

      if pg_catalog.jsonb_array_length(sub_result) > 0 then
        select pg_catalog.min((elem.value ->> 'validUntil')::timestamptz) into sub_min_valid_until
        from pg_catalog.jsonb_array_elements(sub_result) as elem(value);

        contribution_deadline := least(source_valid_until, sub_min_valid_until);

        route_list := pg_catalog.array_append(route_list, pg_catalog.jsonb_build_object(
          'kind', 'relationship',
          'relationshipId', (route ->> 'relationshipId')::uuid,
          'sourcePermissionId', (route ->> 'sourcePermissionId')::uuid,
          'sourceRecordId', (edge_item ->> 'fromRecordId')::uuid
        ));
        deadline_list := pg_catalog.array_append(deadline_list, contribution_deadline);
      end if;
    end loop;
  end loop;

  -- Step 5: a saved condition narrows every route, including all_records.
  if coalesce(pg_catalog.array_length(route_list, 1), 0) > 0
    and candidate_record_scope ? 'savedCondition' then
    condition_id := (candidate_record_scope -> 'savedCondition' ->> 'conditionId')::uuid;

    select value into saved_condition
    from pg_catalog.jsonb_array_elements(p_facts -> 'sharingConditions') as item(value)
    where (value ->> 'conditionId')::uuid = condition_id
    limit 1;

    if saved_condition is null then
      raise exception using errcode = '22023', message = 'Record access facts are invalid';
    end if;

    projected_values := '{}'::jsonb;
    for declared_field in
      select value from pg_catalog.jsonb_array_elements(saved_condition -> 'declaredFieldIds') as item(value)
    loop
      if not ((target_record -> 'fieldValues') ? (declared_field #>> '{}')) then
        raise exception using errcode = '22023', message = 'Record access facts are invalid';
      end if;
      projected_values := projected_values || pg_catalog.jsonb_build_object(
        declared_field #>> '{}', (target_record -> 'fieldValues') -> (declared_field #>> '{}')
      );
    end loop;

    reduced_type := pg_catalog.jsonb_build_object(
      'recordTypeId', target_type -> 'recordTypeId',
      'fields', target_type -> 'fields'
    ) || case
      when target_type ? 'validationContractVersion' then
        pg_catalog.jsonb_build_object(
          'validationContractVersion', target_type -> 'validationContractVersion'
        )
      else '{}'::jsonb
    end;

    condition_ok := vortex_access.evaluate_permission_saved_condition(
      candidate_record_scope, saved_condition, reduced_type, projected_values, context_account_id
    );

    if condition_ok is not true then
      route_list := array[]::jsonb[];
      deadline_list := array[]::timestamptz[];
    end if;
  end if;

  -- Step 6: map to full matched contributions for this candidate.
  result := '[]'::jsonb;
  for route_index in 1 .. coalesce(pg_catalog.array_length(route_list, 1), 0) loop
    result := result || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'permission', candidate_permission,
      'registrationRevision', p_candidate -> 'registrationRevision',
      'recordScope', candidate_record_scope,
      'source', p_candidate -> 'source',
      'route', route_list[route_index],
      'validUntil', pg_catalog.to_char(
        pg_catalog.timezone('UTC', least(candidate_valid_until, deadline_list[route_index])),
        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
      )
    ));
  end loop;

  return result;
end
$function$;

revoke execute on function vortex_access.evaluate_record_permission_row_scope_internal(
  jsonb, timestamptz, timestamptz, uuid, jsonb, jsonb, uuid, jsonb, uuid[]
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;

comment on function vortex_access.evaluate_record_permission_row_scope_internal(
  jsonb, timestamptz, timestamptz, uuid, jsonb, jsonb, uuid, jsonb, uuid[]
) is
  'Private row-scope composition for one already-eligible permission against one exact record; returns matched contributions only, never a final allow/refuse result.';

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
    source_validation_contract_version, source_catalogue_fingerprint, meaning_fingerprint
  )
  -- guard-allow: function-uuid fixed platform permission identity without declaration-table read access
  select p_organization_id, 'platform', 'cabe121e-0baf-4084-9471-cce915d460a8', 1,
    -- guard-allow: function-uuid fixed platform permission identity without declaration-table read access
    null, 'platform', 'cabe121e-0baf-4084-9471-cce915d460a8',
    (entry ->> 'permissionId')::uuid, entry ->> 'key', entry ->> 'label',
    entry ->> 'description', null, entry ->> 'actionKind', null, true,
    'platform_catalogue', null, null, '1.0.0', null, null,
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

ALTER FUNCTION vortex_access.initialize_platform_permission_catalogue_v1(p_organization_id uuid, p_changed_by uuid, p_correlation_id uuid) OWNER TO vortex_owner;

COMMENT ON FUNCTION vortex_access.initialize_platform_permission_catalogue_v1(p_organization_id uuid, p_changed_by uuid, p_correlation_id uuid) IS 'Owner-only exact historical 1.0.0 platform catalogue initializer retained for compatibility.';

REVOKE ALL ON FUNCTION vortex_access.initialize_platform_permission_catalogue_v1(p_organization_id uuid, p_changed_by uuid, p_correlation_id uuid) FROM PUBLIC;

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

revoke all on function
  vortex_access.platform_permission_catalogue_revision_is_exact(uuid, bigint)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

comment on function vortex_access.platform_permission_catalogue_revision_is_exact(uuid, bigint) is
  'Owner-only fixed evidence assertion for the exact current platform catalogue, its immutable historical predecessors, and required available continuities.';

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
          and entry.source_catalogue_fingerprint = expected_catalogue_fingerprint
          and entry.meaning_fingerprint = expected.value ->> 'meaningFingerprint'
      )
    );
end
$_$;

ALTER FUNCTION vortex_access.platform_permission_catalogue_revision_is_exact_v1_0_1(p_organization_id uuid, p_registration_revision bigint) OWNER TO vortex_owner;

COMMENT ON FUNCTION vortex_access.platform_permission_catalogue_revision_is_exact_v1_0_1(p_organization_id uuid, p_registration_revision bigint) IS 'Owner-only fixed evidence assertion for exact platform catalogue revisions 1 and 2.';

REVOKE ALL ON FUNCTION vortex_access.platform_permission_catalogue_revision_is_exact_v1_0_1(p_organization_id uuid, p_registration_revision bigint) FROM PUBLIC;

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

revoke all on function
  vortex_access.platform_permission_catalogue_revision_is_exact_v1_2_0(uuid, bigint)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

comment on function vortex_access.platform_permission_catalogue_revision_is_exact_v1_2_0(uuid, bigint) is
  'Owner-only fixed evidence assertion for exact platform catalogue revision 4 (1.2.0), which adds the connection administration permission to revision 3.';

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

ALTER FUNCTION vortex_access.platform_permission_catalogue_revision_is_exact_v1_3_0(p_organization_id uuid, p_registration_revision bigint) OWNER TO vortex_owner;

REVOKE ALL ON FUNCTION vortex_access.platform_permission_catalogue_revision_is_exact_v1_3_0(p_organization_id uuid, p_registration_revision bigint) FROM PUBLIC;

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

revoke all on function
  vortex_access.platform_permission_catalogue_revision_is_exact_v1_4_0(uuid, bigint)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

comment on function vortex_access.platform_permission_catalogue_revision_is_exact_v1_4_0(uuid, bigint) is
  'Owner-only fixed evidence assertion for exact platform catalogue revision 6 (1.4.0), which adds the four builder permissions to revision 5.';

create or replace function vortex_access.read_available_permission(
  p_organization_id uuid,
  p_application_root_id uuid,
  p_owner_kind text,
  p_owner_id uuid,
  p_permission_id uuid
)
returns table (
  organization_id uuid,
  application_root_id uuid,
  registration_revision bigint,
  owner_kind text,
  owner_id uuid,
  permission_id uuid,
  permission_key text,
  label text,
  description text,
  record_type_id uuid,
  record_scope jsonb,
  field_policy jsonb,
  action_kind text,
  named_action text,
  administrative boolean,
  source_kind text,
  source_definition_key text,
  source_root_id uuid,
  source_version text,
  source_revision bigint,
  source_validation_contract_version text,
  source_catalogue_fingerprint text,
  meaning_fingerprint text
)
language sql
stable
security definer
set search_path = ''
as $function$
  select entry.organization_id, entry.application_root_id, entry.registration_revision,
    entry.owner_kind, entry.owner_id, entry.permission_id, entry.permission_key,
    entry.label, entry.description, entry.record_type_id, entry.record_scope,
    entry.field_policy,
    entry.action_kind, entry.named_action, entry.administrative, entry.source_kind,
    entry.source_definition_key, entry.source_root_id, entry.source_version,
    entry.source_revision, entry.source_validation_contract_version,
    entry.source_catalogue_fingerprint, entry.meaning_fingerprint
  from vortex_access.permission_registrations as registration
  join vortex_access.permission_catalogue_entries as entry
    on entry.organization_id = registration.organization_id
    and entry.registration_kind = registration.registration_kind
    and entry.registration_owner_id = registration.registration_owner_id
    and entry.registration_revision = registration.revision
  where registration.organization_id = p_organization_id
    and registration.state = 'active'
    and entry.owner_kind = p_owner_kind
    and entry.owner_id = p_owner_id
    and entry.permission_id = p_permission_id
    and (
      (p_owner_kind = 'platform' and p_application_root_id is null and entry.application_root_id is null)
      or (
        p_owner_kind in ('application', 'module')
        and p_application_root_id is not null
        and registration.registration_kind = 'application'
        and registration.registration_owner_id = p_application_root_id
        and entry.application_root_id = p_application_root_id
      )
    )
$function$;
alter function vortex_access.read_available_permission(uuid,uuid,text,uuid,uuid) owner to vortex_owner;

revoke execute on function vortex_access.read_available_permission(uuid, uuid, text, uuid, uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
comment on function vortex_access.read_available_permission(uuid, uuid, text, uuid, uuid) is
  'Owner-only exact current permission lookup retaining application context, record scope and field policy.';
alter function vortex_access.read_available_permission(uuid, uuid, text, uuid, uuid)
  owner to vortex_owner;

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
            'contentFingerprint', source_release.content_fingerprint,
            'resolutionFingerprint', source_release.resolution_fingerprint
          ),
          'meaningFingerprint', entry.meaning_fingerprint
        ) as entry_json,
        entry.owner_kind, entry.owner_id, entry.permission_key, entry.permission_id
      from vortex_access.permission_catalogue_entries as entry
      left join vortex_definition.releases as source_release
        on source_release.root_id = entry.source_root_id
        and source_release.release_revision = entry.source_revision
        and source_release.release_version = entry.source_version
        and source_release.validation_contract_version =
          entry.source_validation_contract_version
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

revoke execute on function vortex_access.read_organization_role_change_evidence_for_administration(jsonb)
from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

grant execute on function vortex_access.read_organization_role_change_evidence_for_administration(jsonb)
to vortex_request;

comment on function vortex_access.read_organization_role_change_evidence_for_administration(jsonb) is
  'Server-side preparation read: given bounded role configuration or an existing Application role identity and expected revision, it returns complete, fingerprinted permission and template evidence for the verified caller organisation only, deriving stored role configuration, actor and organisation from protected context and including an exact live-assignment snapshot only when the writer requires it.';

create or replace function vortex_access.resolve_record_field_bounds_internal(
  p_decision jsonb
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  decision_organization_id uuid := (p_decision ->> 'organizationId')::uuid;
  contribution jsonb;
  contribution_permission jsonb;
  contribution_source jsonb;
  contribution_route jsonb;
  catalogue_entry vortex_access.permission_catalogue_entries%rowtype;
  policy_readable text[];
  policy_changeable text[];
  readable_ids text[] := array[]::text[];
  changeable_ids text[] := array[]::text[];
begin
  if p_decision ->> 'outcome' is distinct from 'allowed' then
    raise exception using errcode = '22023',
      message = 'Record field bounds require an allowed decision';
  end if;

  for contribution in
    select value
    from pg_catalog.jsonb_array_elements(p_decision -> 'matchedContributions') as item(value)
  loop
    contribution_permission := contribution -> 'permission';
    contribution_source := contribution -> 'source';
    contribution_route := contribution -> 'route';

    -- The current catalogue entry for this contribution's exact permission.
    -- Mirrors vortex_access.read_available_permission's own current-entry
    -- join: entry joined to its owning registration, filtered to 'active'.
    select entry.*
    into catalogue_entry
    from vortex_access.permission_catalogue_entries as entry
    join vortex_access.permission_registrations as registration
      on registration.organization_id = entry.organization_id
      and registration.registration_kind = entry.registration_kind
      and registration.registration_owner_id = entry.registration_owner_id
      and registration.revision = entry.registration_revision
      and registration.state = 'active'
    where entry.organization_id = decision_organization_id
      and entry.application_root_id = (contribution_permission ->> 'applicationRootId')::uuid
      and entry.owner_kind = contribution_permission ->> 'ownerKind'
      and entry.owner_id = (contribution_permission ->> 'ownerId')::uuid
      and entry.permission_id = (contribution_permission ->> 'permissionId')::uuid;

    -- The decision just used this exact permission; a missing catalogue
    -- entry now is an internal inconsistency, not an ordinary refusal.
    if not found then
      raise exception using errcode = '22023',
        message = 'Record field bounds found no catalogue entry';
    end if;

    -- The active registration revision and the source release identity must
    -- still match the contribution before its field policy can be used.
    if catalogue_entry.registration_revision is distinct from
        (contribution ->> 'registrationRevision')::bigint
      or catalogue_entry.source_kind is distinct from (contribution_source ->> 'kind')
      or catalogue_entry.source_definition_key is distinct from (contribution_source ->> 'definitionKey')
      or catalogue_entry.source_root_id is distinct from (contribution_source ->> 'rootId')::uuid
      or catalogue_entry.source_version is distinct from (contribution_source ->> 'releaseVersion')
      or catalogue_entry.source_revision is distinct from (contribution_source ->> 'releaseRevision')::bigint
      or catalogue_entry.source_validation_contract_version
        is distinct from (contribution_source ->> 'validationContractVersion') then
      raise exception using errcode = '22023',
        message = 'Record field bounds found a superseded permission source';
    end if;

    -- No declared field policy means this contribution contributes no
    -- fields; it must not veto a different contribution that has one.
    if catalogue_entry.field_policy is null then
      continue;
    end if;

    -- A direct_share route can only narrow the permission's own policy, so
    -- readable/changeable fields are kept only when the route also names
    -- them; every other route kind contributes the policy as declared.
    select pg_catalog.array_agg(pg_catalog.lower(field.value))
    into policy_readable
    from pg_catalog.jsonb_array_elements_text(
      catalogue_entry.field_policy -> 'readableFieldIds'
    ) as field(value)
    where contribution_route ->> 'kind' is distinct from 'direct_share'
      or exists (
        select 1
        from pg_catalog.jsonb_array_elements_text(
          contribution_route -> 'readableFieldIds'
        ) as shared(value)
        where pg_catalog.lower(shared.value) = pg_catalog.lower(field.value)
      );

    select pg_catalog.array_agg(pg_catalog.lower(field.value))
    into policy_changeable
    from pg_catalog.jsonb_array_elements_text(
      catalogue_entry.field_policy -> 'changeableFieldIds'
    ) as field(value)
    where contribution_route ->> 'kind' is distinct from 'direct_share'
      or exists (
        select 1
        from pg_catalog.jsonb_array_elements_text(
          contribution_route -> 'changeableFieldIds'
        ) as shared(value)
        where pg_catalog.lower(shared.value) = pg_catalog.lower(field.value)
      );

    readable_ids := readable_ids || coalesce(policy_readable, array[]::text[]);
    changeable_ids := changeable_ids || coalesce(policy_changeable, array[]::text[]);
  end loop;

  readable_ids := array(
    select distinct field.value
    from pg_catalog.unnest(readable_ids) as field(value)
    order by field.value
  );
  -- Changeable never exceeds readable, because every contribution's own
  -- changeable set already sits inside its own readable set: the policy
  -- validator enforces that for a permission, and the direct-share table
  -- enforces it for a share. Unioning subsets preserves it, so this only
  -- canonicalises.
  changeable_ids := array(
    select distinct field.value
    from pg_catalog.unnest(changeable_ids) as field(value)
    order by field.value
  );

  return pg_catalog.jsonb_build_object(
    'readableFieldIds', pg_catalog.to_jsonb(readable_ids),
    'changeableFieldIds', pg_catalog.to_jsonb(changeable_ids)
  );
end
$function$;
alter function vortex_access.resolve_record_field_bounds_internal(jsonb) owner to vortex_owner;


revoke execute on function vortex_access.resolve_record_field_bounds_internal(jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

grant execute on function vortex_access.resolve_record_field_bounds_internal(jsonb)
  to vortex_record_adapter, postgres;

comment on function vortex_access.resolve_record_field_bounds_internal(jsonb) is
  'Private field-bounds resolution over one allowed exact-record access decision; looks each contribution''s field policy up from the live permission catalogue itself, never from a caller-supplied declaration.';

alter function vortex_access.resolve_record_field_bounds_internal(jsonb)
  owner to vortex_owner;

create or replace function vortex_access.resolve_record_read_field_bounds_internal(
  p_declaration jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  -- Nothing guaranteed and no exactness claim: the fail-closed answer.
  nothing constant jsonb := '{"readableFieldIds":[],"coversAllRecords":false,"conditionFree":false}'::jsonb;
  ctx jsonb;
  checked_at timestamptz;
  decision_organization_id uuid;
  account_id uuid;
  binding jsonb;
  eligibility jsonb;
  candidate jsonb;
  permission_value jsonb;
  source_value jsonb;
  routes jsonb;
  route jsonb;
  catalogue_entry vortex_access.permission_catalogue_entries%rowtype;
  policy_readable text[];
  route_readable text[];
  guaranteed text[] := array[]::text[];
  first_route boolean := true;
  covers_all_records boolean := false;
  condition_free boolean := true;
  wants_share boolean := false;
  member_group_ids uuid[];
  share_row record;
  share_intersection text[];
  share_seen boolean := false;
begin
  -- The planner only knows how to reason about a record read; anything else is
  -- a caller error, never a wider grant.
  if p_declaration is null
    or pg_catalog.jsonb_typeof(p_declaration) <> 'object'
    or p_declaration -> 'action' ->> 'actionKind' is distinct from 'read'
    or (p_declaration -> 'action') ? 'namedAction' then
    raise exception using errcode = '22023',
      message = 'Record read field-bounds declaration is invalid';
  end if;

  ctx := vortex_access.validated_human_request_context();
  checked_at := pg_catalog.clock_timestamp();
  decision_organization_id := (ctx ->> 'organizationId')::uuid;
  account_id := (ctx ->> 'organizationAccountId')::uuid;
  binding := p_declaration -> 'recordBinding';

  eligibility := vortex_access.evaluate_organization_record_permission_eligibility_internal(
    p_declaration, ctx, checked_at
  );

  -- An ineligible caller is admitted to no record, so it is guaranteed no
  -- field and nothing may be pushed.
  if eligibility ->> 'outcome' <> 'eligible' then
    return nothing;
  end if;

  -- A direct-share route narrows its permission to the individual share's own
  -- readable fields, which are current rows rather than a static declaration.
  -- When any eligible alternative can match through such a route, take the
  -- intersection of every current share's own bounds once, so a field that a
  -- share withholds is never treated as visible.
  select exists (
    select 1
    from pg_catalog.jsonb_array_elements(
      coalesce(eligibility -> 'eligiblePermissions', '[]'::jsonb)
    ) as listed(value)
    cross join lateral pg_catalog.jsonb_array_elements(
      coalesce(listed.value -> 'recordScope' -> 'routes', '[]'::jsonb)
    ) as listed_route(value)
    where listed_route.value ->> 'kind' = 'direct_share'
  ) into wants_share;

  if wants_share then
    -- The groups the caller belongs to now: an active group and a live,
    -- started, unexpired membership, exactly as the share tests require.
    select coalesce(pg_catalog.array_agg(distinct membership.group_id), array[]::uuid[])
    into member_group_ids
    from vortex_access.organization_group_memberships as membership
    join vortex_access.organization_groups as organization_group
      on organization_group.organization_id = membership.organization_id
      and organization_group.group_id = membership.group_id
      and organization_group.state = 'active'
    where membership.organization_id = decision_organization_id
      and membership.organization_account_id = account_id
      and membership.state = 'live'
      and membership.starts_at <= checked_at
      and (membership.expires_at is null or membership.expires_at > checked_at);

    for share_row in
      select share.readable_field_ids
      from vortex_access.organization_direct_record_shares as share
      where share.organization_id = decision_organization_id
        and share.storage_scope = binding ->> 'storageScope'
        and share.application_root_id is not distinct from case
          when binding ->> 'storageScope' = 'application_contained'
            then (p_declaration -> 'target' ->> 'applicationRootId')::uuid
          else null::uuid
        end
        and share.module_root_id = (binding ->> 'moduleRootId')::uuid
        and share.record_type_id = (binding ->> 'recordTypeId')::uuid
        and share.storage_contract_id = (binding ->> 'storageContractId')::uuid
        and share.state = 'active'
        and share.starts_at <= checked_at
        and (share.expires_at is null or share.expires_at > checked_at)
        and (
          (share.recipient_kind = 'organization_account'
            and share.organization_account_id = account_id)
          or (share.recipient_kind = 'group'
            and share.group_id = any (member_group_ids))
        )
    loop
      if not share_seen then
        share_intersection := array(
          select pg_catalog.lower(field.value)
          from pg_catalog.unnest(share_row.readable_field_ids::text[]) as field(value)
        );
        share_seen := true;
      else
        share_intersection := array(
          select field.value
          from pg_catalog.unnest(share_intersection) as field(value)
          where field.value = any (
            select pg_catalog.lower(shared.value)
            from pg_catalog.unnest(share_row.readable_field_ids::text[]) as shared(value)
          )
        );
      end if;
    end loop;
  end if;

  -- Each record is admitted by at least one (alternative, route) pair, and the
  -- exact decision exposes the union of the fields of the pairs that admit it.
  -- A field is therefore guaranteed on every admitted record only when every
  -- pair that can admit a record exposes it: the intersection over every pair,
  -- never a union within one alternative. An ownership, all-records or
  -- relationship pair exposes its permission's policy; a direct-share pair
  -- exposes that policy narrowed by the share, bounded here by the common
  -- bounds of every current share, and with no current share it admits no
  -- record and constrains nothing. Any unknown route fails closed.
  for candidate in
    select listed.value
    from pg_catalog.jsonb_array_elements(
      coalesce(eligibility -> 'eligiblePermissions', '[]'::jsonb)
    ) as listed(value)
  loop
    permission_value := candidate -> 'permission';
    source_value := candidate -> 'source';

    select entry.*
    into catalogue_entry
    from vortex_access.permission_catalogue_entries as entry
    join vortex_access.permission_registrations as registration
      on registration.organization_id = entry.organization_id
      and registration.registration_kind = entry.registration_kind
      and registration.registration_owner_id = entry.registration_owner_id
      and registration.revision = entry.registration_revision
      and registration.state = 'active'
    where entry.organization_id = decision_organization_id
      and entry.application_root_id = (permission_value ->> 'applicationRootId')::uuid
      and entry.owner_kind = permission_value ->> 'ownerKind'
      and entry.owner_id = (permission_value ->> 'ownerId')::uuid
      and entry.permission_id = (permission_value ->> 'permissionId')::uuid;

    -- The eligibility decision just used this exact permission; a missing or
    -- superseded catalogue entry is an internal inconsistency, not a refusal
    -- that silently widens what may be pushed.
    if not found then
      raise exception using errcode = '22023',
        message = 'Record read field bounds found no catalogue entry';
    end if;

    if catalogue_entry.registration_revision is distinct from
        (candidate ->> 'registrationRevision')::bigint
      or catalogue_entry.source_kind is distinct from (source_value ->> 'kind')
      or catalogue_entry.source_definition_key is distinct from (source_value ->> 'definitionKey')
      or catalogue_entry.source_root_id is distinct from (source_value ->> 'rootId')::uuid
      or catalogue_entry.source_version is distinct from (source_value ->> 'releaseVersion')
      or catalogue_entry.source_revision is distinct from (source_value ->> 'releaseRevision')::bigint
      or catalogue_entry.source_validation_contract_version
        is distinct from (source_value ->> 'validationContractVersion') then
      raise exception using errcode = '22023',
        message = 'Record read field bounds found a superseded permission source';
    end if;

    -- A permission with no declared field policy contributes no field at all,
    -- so nothing is guaranteed for the whole record type.
    if catalogue_entry.field_policy is null then
      return nothing;
    end if;

    select coalesce(pg_catalog.array_agg(pg_catalog.lower(field.value)), array[]::text[])
    into policy_readable
    from pg_catalog.jsonb_array_elements_text(
      catalogue_entry.field_policy -> 'readableFieldIds'
    ) as field(value);

    routes := candidate -> 'recordScope' -> 'routes';
    if pg_catalog.jsonb_typeof(routes) is distinct from 'array' then
      return nothing;
    end if;

    -- A saved condition narrows every route of its alternative, including an
    -- all-records route, per record; the scan's table narrowing cannot apply it.
    if (candidate -> 'recordScope') ? 'savedCondition' then
      condition_free := false;
    elsif exists (
      select 1 from pg_catalog.jsonb_array_elements(routes) as listed_route(value)
      where listed_route.value ->> 'kind' = 'all_records'
    ) then
      covers_all_records := true;
    end if;

    for route in
      select listed_route.value
      from pg_catalog.jsonb_array_elements(routes) as listed_route(value)
    loop
      case route ->> 'kind'
        when 'all_records', 'ownership', 'relationship' then
          route_readable := policy_readable;
        when 'direct_share' then
          if not share_seen then
            continue;
          end if;
          route_readable := array(
            select shared.value
            from pg_catalog.unnest(policy_readable) as shared(value)
            where shared.value = any (share_intersection)
          );
        else
          return nothing;
      end case;

      if first_route then
        guaranteed := array(
          select distinct field.value
          from pg_catalog.unnest(route_readable) as field(value)
        );
        first_route := false;
      else
        guaranteed := array(
          select field.value
          from pg_catalog.unnest(guaranteed) as field(value)
          where field.value = any (route_readable)
        );
      end if;
      if pg_catalog.cardinality(guaranteed) = 0 then
        return nothing;
      end if;
    end loop;
  end loop;

  guaranteed := array(
    select field.value from pg_catalog.unnest(guaranteed) as field(value)
    order by field.value
  );

  return pg_catalog.jsonb_build_object(
    'readableFieldIds', pg_catalog.to_jsonb(guaranteed),
    'coversAllRecords', covers_all_records,
    'conditionFree', condition_free
  );
end
$function$;
alter function vortex_access.resolve_record_read_field_bounds_internal(jsonb) owner to vortex_owner;


revoke all on function vortex_access.resolve_record_read_field_bounds_internal(jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_access.resolve_record_read_field_bounds_internal(jsonb)
  to vortex_record_adapter;

comment on function vortex_access.resolve_record_read_field_bounds_internal(jsonb) is
  'Private whole-record-type field bounds for the fixed record query: from the caller''s own current eligible read alternatives it returns the fields every alternative route is guaranteed to expose on every record it can admit (the intersection over every alternative and route, each direct-share route narrowed by every current share''s own bounds), whether an unconditioned all-records alternative admits every active record, and whether no alternative carries a saved condition; any unknown route or missing policy yields no fields. It only decides which fields a scan may order or filter by and never decides access.';

alter function vortex_access.resolve_record_read_field_bounds_internal(jsonb)
  owner to vortex_owner;

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
    source_validation_contract_version, source_catalogue_fingerprint, meaning_fingerprint
  )
  -- guard-allow: function-uuid fixed platform permission identity without declaration-table read access
  select p_organization_id, 'platform', 'cabe121e-0baf-4084-9471-cce915d460a8', 2,
    -- guard-allow: function-uuid fixed platform permission identity without declaration-table read access
    null, 'platform', 'cabe121e-0baf-4084-9471-cce915d460a8',
    (entry ->> 'permissionId')::uuid, entry ->> 'key', entry ->> 'label',
    entry ->> 'description', null, entry ->> 'actionKind', null, true,
    'platform_catalogue', null, null, p_target_catalogue_version, null, null,
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

revoke execute on function
  vortex_access.revise_platform_permission_catalogue_metadata(
    uuid, bigint, text, text, uuid, uuid
  )
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

comment on function vortex_access.revise_platform_permission_catalogue_metadata(
  uuid, bigint, text, text, uuid, uuid
) is
  'Owner-only exact 1.0.0 to 1.0.1 platform catalogue display-metadata revision.';

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

ALTER FUNCTION vortex_access.withdraw_application_permission_registration_v1_internal(p_organization_id uuid, p_application_root_id uuid, p_expected_revision bigint, p_changed_by uuid, p_correlation_id uuid) OWNER TO vortex_owner;

COMMENT ON FUNCTION vortex_access.withdraw_application_permission_registration_v1_internal(p_organization_id uuid, p_application_root_id uuid, p_expected_revision bigint, p_changed_by uuid, p_correlation_id uuid) IS 'Legacy raw withdrawal writer retained privately for the coordinated application-access composition only.';

REVOKE ALL ON FUNCTION vortex_access.withdraw_application_permission_registration_v1_internal(p_organization_id uuid, p_application_root_id uuid, p_expected_revision bigint, p_changed_by uuid, p_correlation_id uuid) FROM PUBLIC;

reset role;
