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
  platform_owner_id constant uuid := 'cabe121e-0baf-4084-9471-cce915d460a8';
  drafts_permission_id constant uuid := '0548c061-b1a9-48e5-a04a-eb1d0dae0644';
  releases_permission_id constant uuid := 'dfdd5aba-2b85-4169-b570-92be284e7b5c';
  custom_code_permission_id constant uuid := 'd1be247f-094d-47c1-a38d-762290868c91';
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
    organization_id, registration_kind, registration_owner_id, revision,
    state, operation, source_definition_key, source_version,
    source_revision, validation_contract_version,
    source_content_fingerprint, source_resolution_fingerprint,
    permission_catalogue_fingerprint, candidate_fingerprint,
    changed_at, changed_by, change_correlation_id
  ) values (
    p_organization_id, 'platform', platform_owner_id, 6,
    'active', 'platform_metadata_revision', null, '1.4.0',
    null, null, null, null, catalogue_fingerprint, catalogue_fingerprint,
    operation_at, p_changed_by, p_correlation_id
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

revoke all on function
  vortex_access.adopt_builder_permission_catalogue(uuid, uuid, uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

comment on function vortex_access.adopt_builder_permission_catalogue(uuid, uuid, uuid) is
  'Owner-only additive adoption of platform catalogue revision 6 (1.4.0): registers the four builder permissions without changing any earlier permission or granting any role authority.';
