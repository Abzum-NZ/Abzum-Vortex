CREATE FUNCTION vortex_access.adopt_connection_administration_permission_catalogue(p_organization_id uuid, p_changed_by uuid, p_correlation_id uuid) RETURNS bigint
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  platform_owner_id constant uuid := 'cabe121e-0baf-4084-9471-cce915d460a8';
  connection_permission_id constant uuid := 'ec2908a1-f3cd-4c4a-8bf7-91bffbf4cb3d';
  settings_permission_id constant uuid := 'c658c254-2884-414a-9012-512c0cfe4b34';
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
    organization_id, registration_kind, registration_owner_id, revision,
    state, operation, source_definition_key, source_version,
    source_revision, validation_contract_version,
    source_content_fingerprint, source_resolution_fingerprint,
    permission_catalogue_fingerprint, candidate_fingerprint,
    changed_at, changed_by, change_correlation_id
  ) values (
    p_organization_id, 'platform', platform_owner_id, 4,
    'active', 'platform_metadata_revision', null, '1.2.0',
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
      activation_policy_fingerprint, role_key, label, description,
      source_definition_key, source_release_revision, source_release_version,
      source_validation_contract_version, source_content_fingerprint,
      source_resolution_fingerprint, source_template_fingerprint,
      source_catalogue_fingerprint, accepted_registration_revision,
      template_continuity_revision, accepted_grant_fingerprint,
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
      previous_revision.activation_policy_fingerprint,
      previous_revision.role_key, previous_revision.label,
      previous_revision.description, previous_revision.source_definition_key,
      previous_revision.source_release_revision,
      previous_revision.source_release_version,
      previous_revision.source_validation_contract_version,
      previous_revision.source_content_fingerprint,
      previous_revision.source_resolution_fingerprint,
      previous_revision.source_template_fingerprint,
      previous_revision.source_catalogue_fingerprint,
      previous_revision.accepted_registration_revision,
      previous_revision.template_continuity_revision,
      previous_revision.accepted_grant_fingerprint,
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


ALTER FUNCTION vortex_access.adopt_connection_administration_permission_catalogue(p_organization_id uuid, p_changed_by uuid, p_correlation_id uuid) OWNER TO postgres;

REVOKE ALL ON FUNCTION vortex_access.adopt_connection_administration_permission_catalogue(p_organization_id uuid, p_changed_by uuid, p_correlation_id uuid) FROM PUBLIC;
