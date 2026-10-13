-- R3.3d slice 4b, part 2 (#2238): delete the activation-policy and accepted-grant fingerprints.
--
-- `policy_fingerprint` / `activation_policy_fingerprint` were a sha256 of an activation policy revision's own content,
-- computed in TypeScript and only format-checked here. A policy revision is already identified exactly by
-- (organization, role, activation policy id, revision), which is the primary key the role revisions and activations
-- now reference. `accepted_grant_fingerprint` was a sha256 of the accepted source and permissions, computed in
-- TypeScript; the accepted source and permission entries are stored on the role revision itself and compared directly.
-- The role-change prepared payload no longer carries `newActivationPolicyFingerprint` or `acceptedGrantFingerprint`,
-- and activation-policy references no longer carry `fingerprint`.
--
-- Dropped: columns organization_role_activation_policy_revisions.policy_fingerprint,
-- organization_role_activations.activation_policy_fingerprint, organization_role_revisions.activation_policy_fingerprint,
-- organization_role_revisions.accepted_grant_fingerprint (with their checks, unique index and index/FK keys);
-- function read_organization_role_activation (no caller).

drop function vortex_access.read_organization_role_activation(uuid, uuid);

alter table vortex_access.organization_role_revisions
  drop constraint organization_role_revisions_activation_policy_fk,
  drop constraint organization_role_revisions_assignment_policy_shape,
  drop constraint organization_role_revisions_fingerprints_valid,
  drop constraint organization_role_revisions_source_shape;
alter table vortex_access.organization_role_activations
  drop constraint organization_role_activations_activation_policy_fk,
  drop constraint organization_role_activations_policy_fingerprint_valid;
drop index vortex_access.organization_role_revisions_activation_policy_idx;
drop index vortex_access.organization_role_activations_policy_idx;
alter table vortex_access.organization_role_activation_policy_revisions
  drop constraint organization_role_activation_policy_revisions_exact_unique,
  drop constraint organization_role_activation_policy_revisions_fingerprint_valid;

alter table vortex_access.organization_role_revisions
  drop column activation_policy_fingerprint,
  drop column accepted_grant_fingerprint;
alter table vortex_access.organization_role_activations
  drop column activation_policy_fingerprint;
alter table vortex_access.organization_role_activation_policy_revisions
  drop column policy_fingerprint;

alter table vortex_access.organization_role_revisions
  add constraint organization_role_revisions_assignment_policy_shape check (
    (assignment_policy = 'standing' and activation_policy_id is null
      and activation_policy_revision is null)
    or (assignment_policy = 'activation_required' and activation_policy_id is not null
      and activation_policy_revision is not null)
  ),
  add constraint organization_role_revisions_fingerprints_valid check (
    (source_content_fingerprint is null or source_content_fingerprint ~ '^sha256:[a-f0-9]{64}$')
    and (source_resolution_fingerprint is null or source_resolution_fingerprint ~ '^sha256:[a-f0-9]{64}$')
    and (source_template_fingerprint is null or source_template_fingerprint ~ '^sha256:[a-f0-9]{64}$')
    and (source_catalogue_fingerprint is null or source_catalogue_fingerprint ~ '^sha256:[a-f0-9]{64}$')
  ),
  add constraint organization_role_revisions_source_shape check (
    (role_kind = 'application' and application_root_id is not null
      and source_definition_key is not null and source_release_revision is not null
      and source_release_version is not null and source_validation_contract_version is not null
      and source_content_fingerprint is not null and source_resolution_fingerprint is not null
      and source_template_fingerprint is not null and source_catalogue_fingerprint is not null
      and accepted_registration_revision is not null and template_continuity_revision is not null)
    or (role_kind = 'custom' and application_root_id is null
      and source_definition_key is null and source_release_revision is null
      and source_release_version is null and source_validation_contract_version is null
      and source_content_fingerprint is null and source_resolution_fingerprint is null
      and source_template_fingerprint is null and source_catalogue_fingerprint is null
      and accepted_registration_revision is null and template_continuity_revision is null)
  ),
  add constraint organization_role_revisions_activation_policy_fk
    foreign key (organization_id, role_id, activation_policy_id, activation_policy_revision)
    references vortex_access.organization_role_activation_policy_revisions
      (organization_id, role_id, activation_policy_id, revision)
    deferrable initially deferred;
alter table vortex_access.organization_role_activations
  add constraint organization_role_activations_activation_policy_fk
    foreign key (organization_id, role_id, activation_policy_id, activation_policy_revision)
    references vortex_access.organization_role_activation_policy_revisions
      (organization_id, role_id, activation_policy_id, revision);
create index organization_role_revisions_activation_policy_idx
  on vortex_access.organization_role_revisions
  (organization_id, role_id, activation_policy_id, activation_policy_revision)
  where activation_policy_id is not null;
create index organization_role_activations_policy_idx
  on vortex_access.organization_role_activations
  (organization_id, role_id, activation_policy_id, activation_policy_revision);

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
      role_key, label, description,
      source_definition_key, source_release_revision, source_release_version,
      source_validation_contract_version, source_content_fingerprint,
      source_resolution_fingerprint, source_template_fingerprint,
      source_catalogue_fingerprint, accepted_registration_revision,
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
      previous_revision.source_content_fingerprint,
      previous_revision.source_resolution_fingerprint,
      previous_revision.source_template_fingerprint,
      previous_revision.source_catalogue_fingerprint,
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

ALTER FUNCTION vortex_access.adopt_connection_administration_permission_catalogue(p_organization_id uuid, p_changed_by uuid, p_correlation_id uuid) OWNER TO postgres;

REVOKE ALL ON FUNCTION vortex_access.adopt_connection_administration_permission_catalogue(p_organization_id uuid, p_changed_by uuid, p_correlation_id uuid) FROM PUBLIC;

CREATE OR REPLACE FUNCTION vortex_access.coordinate_application_access_without_stewardship_v1_internal(p_operation text, p_expected_revision bigint, p_prepared_templates jsonb, p_organization_id uuid, p_application_root_id uuid, p_changed_by uuid, p_correlation_id uuid) RETURNS TABLE(outcome text, operation text, organization_id uuid, application_root_id uuid, registration_state text, registration_revision bigint, access_version bigint, correlation_id uuid)
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
        or item.value - array[
          'template', 'sourceTemplateFingerprint', 'sourcePermissions', 'livePermissions'
        ]::text[] <> '{}'::jsonb
        or not (item.value ?& array[
          'template', 'sourceTemplateFingerprint', 'sourcePermissions', 'livePermissions'
        ])
        or pg_catalog.jsonb_typeof(item.value -> 'template') is distinct from 'object'
        or pg_catalog.jsonb_typeof(item.value -> 'sourcePermissions') is distinct from 'array'
        or pg_catalog.jsonb_typeof(item.value -> 'livePermissions') is distinct from 'array'
        or item.value ->> 'sourceTemplateFingerprint' is null
        or item.value ->> 'sourceTemplateFingerprint' !~ '^sha256:[a-f0-9]{64}$'
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
  -- legacy raw helper, whose input-error handler also catches numeric overflow.
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
    from vortex_access.withdraw_application_permission_registration_v1_internal(
      p_organization_id, p_application_root_id, p_expected_revision,
      p_changed_by, p_correlation_id
    ) as changed;
  else
    select changed.* into strict raw_result
    from vortex_access.apply_application_permission_registration_v1_internal(
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
        or (
          target.permission_id is not null
          and (
            continuity.state <> 'available'
            or continuity.meaning_fingerprint <> target.meaning_fingerprint
          )
        )
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
      continuity_revision = case
        when transition.target_permission_id is not null
          and continuity.state = 'available'
          and continuity.meaning_fingerprint = transition.target_meaning_fingerprint
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
      select (item.value #>> '{template,roleId}')::uuid as source_role_id,
        item.value ->> 'sourceTemplateFingerprint' as source_template_fingerprint
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
      item.value ->> 'sourceTemplateFingerprint' as source_template_fingerprint
    from pg_catalog.jsonb_array_elements(
      case when raw_result.registration_state = 'active'
        then p_prepared_templates -> 'templates'
        else '[]'::jsonb
      end
    ) as item(value)
  ), transition as (
    select continuity.ctid as continuity_row, target.source_role_id as target_role_id,
      target.source_template_fingerprint
    from vortex_access.application_role_template_continuities as continuity
    left join target on target.source_role_id = continuity.source_role_id
    where continuity.organization_id = p_organization_id
      and continuity.application_root_id = p_application_root_id
  )
  update vortex_access.application_role_template_continuities as continuity
  set state = case when transition.target_role_id is null
        then 'unavailable' else 'available' end,
      continuity_revision = case
        when transition.target_role_id is not null and continuity.state = 'available'
          then continuity.continuity_revision
        when transition.target_role_id is null and continuity.state = 'unavailable'
          then continuity.continuity_revision
        else continuity.continuity_revision + 1
      end,
      source_template_fingerprint = coalesce(
        transition.source_template_fingerprint, continuity.source_template_fingerprint
      ),
      last_processed_registration_revision = raw_result.registration_revision,
      changed_at = pg_catalog.statement_timestamp()
  from transition
  where continuity.ctid = transition.continuity_row;

  if raw_result.registration_state = 'active' then
    insert into vortex_access.application_role_template_continuities (
      organization_id, application_root_id, source_role_id, state,
      continuity_revision, source_template_fingerprint,
      last_processed_registration_revision, changed_at
    )
    select p_organization_id, p_application_root_id,
      (item.value #>> '{template,roleId}')::uuid, 'available', 1,
      item.value ->> 'sourceTemplateFingerprint', raw_result.registration_revision,
      pg_catalog.statement_timestamp()
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
      revision.source_content_fingerprint, revision.source_resolution_fingerprint,
      revision.source_template_fingerprint, revision.source_catalogue_fingerprint,
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
      if role_record.lifecycle = 'active'
        and retained_permission_count > 0
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
    end if;

    insert into vortex_access.organization_role_revisions (
      organization_id, role_id, revision, role_kind, application_root_id,
      lifecycle, privilege_classification, assignment_policy,
      policy_continuity_revision, authority_continuity_revision,
      activation_policy_id,
      activation_policy_revision, role_key,
      label, description, source_definition_key, source_release_revision,
      source_release_version, source_validation_contract_version,
      source_content_fingerprint, source_resolution_fingerprint,
      source_template_fingerprint, source_catalogue_fingerprint,
      accepted_registration_revision, template_continuity_revision,
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
      role_record.source_content_fingerprint,
      role_record.source_resolution_fingerprint,
      role_record.source_template_fingerprint,
      role_record.source_catalogue_fingerprint,
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

ALTER FUNCTION vortex_access.coordinate_application_access_without_stewardship_v1_internal(p_operation text, p_expected_revision bigint, p_prepared_templates jsonb, p_organization_id uuid, p_application_root_id uuid, p_changed_by uuid, p_correlation_id uuid) OWNER TO postgres;

COMMENT ON FUNCTION vortex_access.coordinate_application_access_without_stewardship_v1_internal(p_operation text, p_expected_revision bigint, p_prepared_templates jsonb, p_organization_id uuid, p_application_root_id uuid, p_changed_by uuid, p_correlation_id uuid) IS 'Internal application-access implementation retained only behind the stewardship safeguard.';

REVOKE ALL ON FUNCTION vortex_access.coordinate_application_access_without_stewardship_v1_internal(p_operation text, p_expected_revision bigint, p_prepared_templates jsonb, p_organization_id uuid, p_application_root_id uuid, p_changed_by uuid, p_correlation_id uuid) FROM PUBLIC;

create or replace function vortex_access.coordinate_organization_role_activation_change(
  p_operation text,
  p_organization_id uuid,
  p_role_activation_id uuid,
  p_expected_activation_revision bigint,
  p_organization_account_id uuid,
  p_role_id uuid,
  p_expected_role_revision bigint,
  p_requested_duration_seconds bigint,
  p_eligibility_source_kind text,
  p_role_assignment_id uuid,
  p_expected_role_assignment_revision bigint,
  p_membership_id uuid,
  p_expected_membership_revision bigint,
  p_changed_by uuid,
  p_correlation_id uuid,
  p_invoking_execution_binding_id uuid default null
)
returns table (
  outcome text,
  operation text,
  activation jsonb,
  access_version bigint,
  correlation_id uuid
)
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  role_fact record;
  assignment_fact vortex_access.organization_role_assignments%rowtype;
  membership_fact vortex_access.organization_group_memberships%rowtype;
  activation_fact vortex_access.organization_role_activations%rowtype;
  checked_at timestamptz;
  operation_at timestamptz;
  duration_cap_seconds numeric;
  source_seconds numeric;
  activation_expires_at timestamptz;
  next_access_version bigint;
begin
  if p_operation is null
    or p_operation not in ('activate_role', 'revoke_role_activation')
    or p_organization_id is null
    or p_organization_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_role_activation_id is null
    or p_role_activation_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_changed_by is null
    or p_changed_by = '00000000-0000-0000-0000-000000000000'::uuid
    or p_correlation_id is null
    or p_correlation_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using errcode = '22023',
      message = 'Organization role-activation change input is invalid';
  end if;

  if p_operation = 'activate_role' then
    if p_expected_activation_revision is not null
      or p_organization_account_id is null
      or p_organization_account_id = '00000000-0000-0000-0000-000000000000'::uuid
      or p_role_id is null
      or p_role_id = '00000000-0000-0000-0000-000000000000'::uuid
      or p_expected_role_revision is null
      or p_expected_role_revision not between 1 and 9007199254740991
      or p_requested_duration_seconds is null
      or p_requested_duration_seconds not between 1 and 9007199254740991
      or p_eligibility_source_kind is null
      or p_eligibility_source_kind not in ('direct', 'group')
      or p_role_assignment_id is null
      or p_role_assignment_id = '00000000-0000-0000-0000-000000000000'::uuid
      or p_expected_role_assignment_revision is null
      or p_expected_role_assignment_revision not between 1 and 9007199254740991
      or (
        p_eligibility_source_kind = 'direct'
        and (
          p_membership_id is not null
          or p_expected_membership_revision is not null
        )
      )
      or (
        p_eligibility_source_kind = 'group'
        and (
          p_membership_id is null
          or p_membership_id = '00000000-0000-0000-0000-000000000000'::uuid
          or p_expected_membership_revision is null
          or p_expected_membership_revision not between 1 and 9007199254740991
        )
      ) then
      raise exception using errcode = '22023',
        message = 'Organization role activation input is invalid';
    end if;
  elsif p_expected_activation_revision is null
    or p_expected_activation_revision not between 1 and 9007199254740991
    or p_organization_account_id is not null
    or p_role_id is not null
    or p_expected_role_revision is not null
    or p_requested_duration_seconds is not null
    or p_eligibility_source_kind is not null
    or p_role_assignment_id is not null
    or p_expected_role_assignment_revision is not null
    or p_membership_id is not null
    or p_expected_membership_revision is not null then
    raise exception using errcode = '22023',
      message = 'Organization role-activation revocation input is invalid';
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
      message = 'Organization role-activation change scope is unavailable';
  end if;

  if p_operation = 'activate_role' then
    if exists (
      select 1
      from vortex_access.organization_role_activations as stored_activation
      where stored_activation.organization_id = p_organization_id
        and stored_activation.role_activation_id = p_role_activation_id
    ) then
      raise exception using errcode = '40001',
        message = 'Organization role activation is stale or unavailable';
    end if;

    select role.live_revision, revision.lifecycle, revision.assignment_policy,
      revision.authority_continuity_revision,
      revision.policy_continuity_revision, revision.activation_policy_id,
      revision.activation_policy_revision,
      policy.maximum_activation_duration_seconds,
      policy.required_caller_execution_binding_id
    into role_fact
    from vortex_access.organization_roles as role
    join vortex_access.organization_role_revisions as revision
      on revision.organization_id = role.organization_id
      and revision.role_id = role.role_id
      and revision.revision = role.live_revision
    join vortex_access.organization_role_activation_policy_revisions as policy
      on policy.organization_id = revision.organization_id
      and policy.role_id = revision.role_id
      and policy.activation_policy_id = revision.activation_policy_id
      and policy.revision = revision.activation_policy_revision
    where role.organization_id = p_organization_id
      and role.role_id = p_role_id
    for update of role;

    if not found
      or role_fact.live_revision <> p_expected_role_revision
      or role_fact.lifecycle not in ('active', 'acceptance_required')
      or role_fact.assignment_policy <> 'activation_required'
      or not exists (
        select 1
        from vortex_access.organization_role_permission_entries as permission
        join vortex_access.permission_continuities as continuity
          on continuity.organization_id = permission.organization_id
          and continuity.application_root_id is not distinct from
            permission.application_root_id
          and continuity.owner_kind = permission.owner_kind
          and continuity.owner_id = permission.owner_id
          and continuity.permission_id = permission.permission_id
          and continuity.state = 'available'
          and continuity.continuity_revision = permission.continuity_revision
          and continuity.meaning_fingerprint = permission.meaning_fingerprint
        where permission.organization_id = p_organization_id
          and permission.role_id = p_role_id
          and permission.role_revision = p_expected_role_revision
      ) then
      raise exception using errcode = '40001',
        message = 'Organization role activation role evidence is stale or unavailable';
    end if;

    -- A policy that names a required caller refuses every other invocation. The named
    -- binding must be the exact current, active, unexpired grant in this organisation whose
    -- effective actor is the actor making this change; a null or different value refuses.
    if role_fact.required_caller_execution_binding_id is not null
      and (
        p_invoking_execution_binding_id is distinct from
          role_fact.required_caller_execution_binding_id
        or not exists (
          select 1
          from vortex_access.flow_execution_bindings as binding
          where binding.execution_binding_id = p_invoking_execution_binding_id
            and binding.organization_id = p_organization_id
            and binding.is_current
            and binding.state = 'active'
            and (
              binding.expires_at is null
              or binding.expires_at > pg_catalog.clock_timestamp()
            )
            and (
              binding.actor_organization_account_id = p_changed_by
              or binding.actor_system_actor_id = p_changed_by
            )
        )
      ) then
      raise exception using errcode = '42501',
        message = 'Organization role activation requires its named caller';
    end if;

    perform 1
    from vortex_identity.organization_accounts as account
    where account.organization_id = p_organization_id
      and account.organization_account_id = p_organization_account_id
      and account.state = 'active'
    for update;
    if not found then
      raise exception using errcode = '40001',
        message = 'Organization role activation account is stale or unavailable';
    end if;

    select assignment.* into assignment_fact
    from vortex_access.organization_role_assignments as assignment
    where assignment.organization_id = p_organization_id
      and assignment.role_assignment_id = p_role_assignment_id
    for update;
    if not found
      or assignment_fact.role_id <> p_role_id
      or assignment_fact.assignment_kind <> 'eligible'
      or assignment_fact.revision <> p_expected_role_assignment_revision
      or assignment_fact.state <> 'live'
      or (
        p_eligibility_source_kind = 'direct'
        and (
          assignment_fact.assignee_kind <> 'organization_account'
          or assignment_fact.organization_account_id <> p_organization_account_id
        )
      )
      or (
        p_eligibility_source_kind = 'group'
        and assignment_fact.assignee_kind <> 'group'
      ) then
      raise exception using errcode = '40001',
        message = 'Organization role activation eligibility is stale or unavailable';
    end if;

    if p_eligibility_source_kind = 'group' then
      perform 1
      from vortex_access.organization_groups as organization_group
      where organization_group.organization_id = p_organization_id
        and organization_group.group_id = assignment_fact.group_id
        and organization_group.state = 'active'
      for update;
      if not found then
        raise exception using errcode = '40001',
          message = 'Organization role activation Group is stale or unavailable';
      end if;

      select membership.* into membership_fact
      from vortex_access.organization_group_memberships as membership
      where membership.organization_id = p_organization_id
        and membership.membership_id = p_membership_id
      for update;
      if not found
        or membership_fact.group_id <> assignment_fact.group_id
        or membership_fact.organization_account_id <> p_organization_account_id
        or membership_fact.revision <> p_expected_membership_revision
        or membership_fact.state <> 'live' then
        raise exception using errcode = '40001',
          message = 'Organization role activation membership is stale or unavailable';
      end if;
    end if;

    checked_at := pg_catalog.clock_timestamp();
    if assignment_fact.starts_at > checked_at
      or (
        assignment_fact.expires_at is not null
        and assignment_fact.expires_at <= checked_at
      )
      or (
        p_eligibility_source_kind = 'group'
        and (
          membership_fact.starts_at > checked_at
          or (
            membership_fact.expires_at is not null
            and membership_fact.expires_at <= checked_at
          )
        )
      ) then
      raise exception using errcode = '40001',
        message = 'Organization role activation source window is no longer current';
    end if;

    duration_cap_seconds := least(
      p_requested_duration_seconds::numeric,
      role_fact.maximum_activation_duration_seconds::numeric
    );
    if assignment_fact.expires_at is not null then
      source_seconds := extract(
        epoch from assignment_fact.expires_at - checked_at
      );
      duration_cap_seconds := least(
        duration_cap_seconds,
        source_seconds
      );
    end if;
    if p_eligibility_source_kind = 'group'
      and membership_fact.expires_at is not null then
      source_seconds := extract(
        epoch from membership_fact.expires_at - checked_at
      );
      duration_cap_seconds := least(
        duration_cap_seconds,
        source_seconds
      );
    end if;
    if duration_cap_seconds <= 0 then
      raise exception using errcode = '40001',
        message = 'Organization role activation source window is no longer current';
    end if;

    begin
      activation_expires_at := checked_at +
        (duration_cap_seconds::double precision * interval '1 second');
    exception
      when datetime_field_overflow or numeric_value_out_of_range then
        raise exception using errcode = '22023',
          message = 'Organization role activation duration is not representable';
    end;
    if assignment_fact.expires_at is not null then
      activation_expires_at := least(
        activation_expires_at,
        assignment_fact.expires_at
      );
    end if;
    if p_eligibility_source_kind = 'group'
      and membership_fact.expires_at is not null then
      activation_expires_at := least(
        activation_expires_at,
        membership_fact.expires_at
      );
    end if;
    if activation_expires_at in (
      '-infinity'::timestamptz, 'infinity'::timestamptz
    ) or activation_expires_at <= checked_at then
      raise exception using errcode = '22023',
        message = 'Organization role activation duration is not representable';
    end if;

    insert into vortex_access.organization_role_activations (
      organization_id, role_activation_id, organization_account_id, role_id,
      revision, historical_role_revision, authority_continuity_revision,
      policy_continuity_revision, activation_policy_id,
      activation_policy_revision,
      eligibility_source_kind, role_assignment_id, role_assignment_revision,
      membership_id, membership_revision, state, activated_by, activated_at,
      expires_at, activation_correlation_id, changed_by, changed_at,
      change_correlation_id, revoked_by, revoked_at,
      revocation_correlation_id
    ) values (
      p_organization_id, p_role_activation_id, p_organization_account_id,
      p_role_id, 1, p_expected_role_revision,
      role_fact.authority_continuity_revision,
      role_fact.policy_continuity_revision, role_fact.activation_policy_id,
      role_fact.activation_policy_revision, p_eligibility_source_kind,
      p_role_assignment_id, p_expected_role_assignment_revision,
      p_membership_id, p_expected_membership_revision, 'live', p_changed_by,
      checked_at, activation_expires_at, p_correlation_id, p_changed_by,
      checked_at, p_correlation_id, null, null, null
    ) returning * into activation_fact;
  else
    select stored_activation.* into activation_fact
    from vortex_access.organization_role_activations as stored_activation
    where stored_activation.organization_id = p_organization_id
      and stored_activation.role_activation_id = p_role_activation_id
    for update;

    if not found
      or activation_fact.revision <> p_expected_activation_revision
      or activation_fact.state <> 'live' then
      raise exception using errcode = '40001',
        message = 'Organization role-activation revocation is stale or unavailable';
    end if;
    if activation_fact.revision = 9007199254740991 then
      raise exception using errcode = '22003',
        message = 'Organization role activation revision is exhausted';
    end if;

    operation_at := greatest(
      activation_fact.changed_at,
      pg_catalog.clock_timestamp()
    );
    update vortex_access.organization_role_activations as stored_activation
    set revision = activation_fact.revision + 1,
      state = 'revoked',
      changed_by = p_changed_by,
      changed_at = operation_at,
      change_correlation_id = p_correlation_id,
      revoked_by = p_changed_by,
      revoked_at = operation_at,
      revocation_correlation_id = p_correlation_id
    where stored_activation.organization_id = p_organization_id
      and stored_activation.role_activation_id = p_role_activation_id
      and stored_activation.revision = p_expected_activation_revision
      and stored_activation.state = 'live'
    returning stored_activation.* into activation_fact;
    if not found then
      raise exception using errcode = '40001',
        message = 'Organization role-activation revocation is stale or unavailable';
    end if;
  end if;

  select version.current_version into next_access_version
  from vortex_access.increment_organization_access_version(
    p_organization_id,
    p_changed_by,
    p_correlation_id,
    'role_activation_changed'
  ) as version;

  return query
  select 'changed'::text, p_operation,
    pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
      'roleActivationId', activation_fact.role_activation_id,
      'organizationId', activation_fact.organization_id,
      'organizationAccountId', activation_fact.organization_account_id,
      'roleId', activation_fact.role_id,
      'revision', activation_fact.revision,
      'historicalRoleRevision', activation_fact.historical_role_revision,
      'authorityContinuityRevision',
        activation_fact.authority_continuity_revision,
      'policyContinuityRevision', activation_fact.policy_continuity_revision,
      'activationPolicy', pg_catalog.jsonb_build_object(
        'activationPolicyId', activation_fact.activation_policy_id,
        'revision', activation_fact.activation_policy_revision
      ),
      'eligibilitySource', case activation_fact.eligibility_source_kind
        when 'direct' then pg_catalog.jsonb_build_object(
          'kind', 'direct',
          'eligibilityAssignment', pg_catalog.jsonb_build_object(
            'roleAssignmentId', activation_fact.role_assignment_id,
            'revision', activation_fact.role_assignment_revision
          )
        )
        else pg_catalog.jsonb_build_object(
          'kind', 'group',
          'eligibilityAssignment', pg_catalog.jsonb_build_object(
            'roleAssignmentId', activation_fact.role_assignment_id,
            'revision', activation_fact.role_assignment_revision
          ),
          'originatingMembership', pg_catalog.jsonb_build_object(
            'membershipId', activation_fact.membership_id,
            'revision', activation_fact.membership_revision
          )
        )
      end,
      'state', activation_fact.state,
      'activatedByActorId', activation_fact.activated_by,
      'activatedAt', activation_fact.activated_at,
      'expiresAt', activation_fact.expires_at,
      'activationCorrelationId', activation_fact.activation_correlation_id,
      'changedByActorId', activation_fact.changed_by,
      'changedAt', activation_fact.changed_at,
      'changeCorrelationId', activation_fact.change_correlation_id,
      'revokedByActorId', activation_fact.revoked_by,
      'revokedAt', activation_fact.revoked_at,
      'revocationCorrelationId', activation_fact.revocation_correlation_id
    )),
    next_access_version, p_correlation_id;
end
$function$;

revoke execute on function
  vortex_access.coordinate_organization_role_activation_change(
    text, uuid, uuid, bigint, uuid, uuid, bigint, bigint, text, uuid,
    bigint, uuid, bigint, uuid, uuid, uuid
  )
from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

comment on function vortex_access.coordinate_organization_role_activation_change(
  text, uuid, uuid, bigint, uuid, uuid, bigint, bigint, text, uuid,
  bigint, uuid, bigint, uuid, uuid, uuid
) is
  'Owner-only atomic individual role activation or terminal revocation. It changes Access once but grants no caller authority; a policy that names a required caller refuses any other invoking execution binding.';

create or replace function vortex_access.coordinate_organization_stewardship_adoption(
  p_organization_id uuid,
  p_organization_account_id uuid,
  p_role_id uuid,
  p_role_key text,
  p_role_label text,
  p_role_description text,
  p_role_assignment_id uuid,
  p_delegation_authority_id uuid,
  p_changed_by uuid,
  p_correlation_id uuid
)
returns table (
  outcome text,
  operation text,
  requirement jsonb,
  access_version bigint,
  correlation_id uuid
)
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  -- guard-allow: function-uuid fixed platform permission identity without declaration-table read access
  platform_owner_id constant uuid := 'cabe121e-0baf-4084-9471-cce915d460a8';
  stewardship vortex_access.organization_stewardship_requirements%rowtype;
  platform_registration vortex_access.permission_registrations%rowtype;
  is_replay boolean;
  expected_count bigint;
  declared_current_revision bigint;
  expected_metadata_exact boolean;
  continuity_count bigint;
  distinct_continuity_count bigint;
  granted_count bigint;
  checked_at timestamptz;
  next_access_version bigint;
begin
  if p_organization_id is null
    or p_organization_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_organization_account_id is null
    or p_organization_account_id =
      '00000000-0000-0000-0000-000000000000'::uuid
    or p_role_id is null
    or p_role_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_role_assignment_id is null
    or p_role_assignment_id =
      '00000000-0000-0000-0000-000000000000'::uuid
    or p_delegation_authority_id is null
    or p_delegation_authority_id =
      '00000000-0000-0000-0000-000000000000'::uuid
    or p_role_key is null
    or pg_catalog.char_length(p_role_key) not between 1 and 40
    or p_role_key !~ '^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$'
    or p_role_label is null
    or p_role_label is distinct from pg_catalog.btrim(p_role_label)
    or pg_catalog.char_length(p_role_label) not between 1 and 60
    or p_role_description is null
    or p_role_description is distinct from pg_catalog.btrim(p_role_description)
    or pg_catalog.char_length(p_role_description) not between 1 and 1000
    or p_changed_by is null
    or p_changed_by = '00000000-0000-0000-0000-000000000000'::uuid
    or p_correlation_id is null
    or p_correlation_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using errcode = '22023',
      message = 'Organization stewardship adoption input is invalid';
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
      message = 'Organization stewardship adoption scope is unavailable';
  end if;

  select stored.* into stewardship
  from vortex_access.organization_stewardship_requirements as stored
  where stored.organization_id = p_organization_id
  for update;

  is_replay := found;
  if is_replay then
    if stewardship.original_organization_account_id <>
        p_organization_account_id
      or stewardship.original_role_id <> p_role_id
      or stewardship.original_role_assignment_id <> p_role_assignment_id
      or stewardship.original_delegation_authority_id <>
        p_delegation_authority_id
      or stewardship.adopted_by <> p_changed_by
      or stewardship.adoption_correlation_id <> p_correlation_id then
      raise exception using errcode = '40001',
        message = 'Organization stewardship adoption conflicts with existing evidence';
    end if;
  end if;

  if not is_replay then
    perform 1
    from vortex_identity.organization_accounts as account
    join vortex_identity.identity_projections as identity
      on identity.identity_id = account.identity_id
      and identity.state = 'active'
    where account.organization_id = p_organization_id
      and account.organization_account_id = p_organization_account_id
      and account.state = 'active'
    for update of account;
    if not found then
      raise exception using errcode = '40001',
        message = 'Organization stewardship account is stale or unavailable';
    end if;

    if exists (
      select 1 from vortex_access.organization_roles as role
      where role.organization_id = p_organization_id
        and (role.role_id = p_role_id or role.role_key = p_role_key)
    ) or exists (
      select 1 from vortex_access.organization_role_assignments as assignment
      where assignment.organization_id = p_organization_id
        and assignment.role_assignment_id = p_role_assignment_id
    ) or exists (
      select 1
      from vortex_access.organization_delegation_authorities as delegation
      where delegation.organization_id = p_organization_id
        and delegation.delegation_authority_id = p_delegation_authority_id
    ) then
      raise exception using errcode = '40001',
        message = 'Organization stewardship grant identity is unavailable';
    end if;
  end if;

  select registration.* into platform_registration
  from vortex_access.permission_registrations as registration
  where registration.organization_id = p_organization_id
    and registration.registration_kind = 'platform'
    and registration.registration_owner_id = platform_owner_id
    and registration.state = 'active'
  for update;
  if not found
    or not vortex_access.platform_permission_catalogue_revision_is_exact(
      p_organization_id, platform_registration.revision
    ) then
    raise exception using errcode = '55000',
      message = 'Platform permission catalogue evidence is invalid';
  end if;

  -- The private producer supplies the whole selected catalogue and its target.
  with expected as materialized (
    select declaration.*
    from vortex_access.read_platform_permission_declaration_catalogue_internal(
      platform_registration.revision
    ) as declaration
  )
  select pg_catalog.count(*),
    pg_catalog.min(expected.declared_current_revision),
    coalesce(
      pg_catalog.count(*) > 0
      and pg_catalog.count(*) = pg_catalog.count(distinct expected.permission_id)
      and pg_catalog.count(*) = pg_catalog.count(distinct expected.permission_key)
      and pg_catalog.count(distinct expected.declared_current_revision) = 1
      and pg_catalog.count(distinct expected.registration_revision) = 1
      and pg_catalog.count(distinct expected.source_version) = 1
      and pg_catalog.count(distinct expected.catalogue_fingerprint) = 1
      and pg_catalog.bool_and(
        expected.registration_revision = platform_registration.revision
        and expected.declared_current_revision >= platform_registration.revision
        and expected.source_version = platform_registration.source_version
        and expected.catalogue_fingerprint =
          platform_registration.permission_catalogue_fingerprint
        and expected.catalogue_fingerprint =
          platform_registration.candidate_fingerprint
      ),
      false
    )
  into expected_count, declared_current_revision, expected_metadata_exact
  from expected;
  if not expected_metadata_exact then
    raise exception using errcode = '55000',
      message = 'Platform permission catalogue evidence is invalid';
  end if;

  -- Lock the complete fixed registration-owner set, including invalid roots.
  perform 1
  from vortex_access.permission_continuities as continuity
  where continuity.organization_id = p_organization_id
    and continuity.registration_kind = 'platform'
    and continuity.registration_owner_id = platform_owner_id
  order by continuity.owner_kind collate "C", continuity.owner_id,
    continuity.permission_id
  for update;

  select pg_catalog.count(*) into continuity_count
  from vortex_access.permission_continuities as continuity
  where continuity.organization_id = p_organization_id
    and continuity.registration_kind = 'platform'
    and continuity.registration_owner_id = platform_owner_id;

  if continuity_count = 0 then
    -- Only an untouched historical pre-adoption phase may seed availability.
    if is_replay or platform_registration.revision not between 1 and 3
      or exists (
        select 1 from vortex_access.organization_roles as role
        where role.organization_id = p_organization_id
      ) or exists (
        select 1 from vortex_access.organization_role_revisions as role_revision
        where role_revision.organization_id = p_organization_id
      ) or exists (
        select 1 from vortex_access.organization_role_permission_entries as grant_entry
        where grant_entry.organization_id = p_organization_id
      ) or exists (
        select 1 from vortex_access.organization_role_assignments as assignment
        where assignment.organization_id = p_organization_id
      ) or exists (
        select 1 from vortex_access.organization_delegation_authorities as delegation
        where delegation.organization_id = p_organization_id
      ) then
      raise exception using errcode = '55000',
        message = 'Platform permission continuity evidence is incomplete';
    end if;

    insert into vortex_access.permission_continuities (
      organization_id, application_root_id, owner_kind, owner_id,
      permission_id, registration_kind, registration_owner_id, state,
      continuity_revision, meaning_fingerprint,
      last_processed_registration_revision, changed_at
    )
    select entry.organization_id, null, entry.owner_kind, entry.owner_id,
      entry.permission_id, 'platform', entry.registration_owner_id,
      'available', 1, entry.meaning_fingerprint, entry.registration_revision,
      pg_catalog.clock_timestamp()
    from vortex_access.permission_catalogue_entries as entry
    where entry.organization_id = p_organization_id
      and entry.application_root_id is null
      and entry.registration_kind = 'platform'
      and entry.registration_owner_id = platform_owner_id
      and entry.registration_revision = platform_registration.revision
      and entry.owner_kind = 'platform'
      and entry.owner_id = platform_owner_id
    order by entry.owner_kind collate "C", entry.owner_id, entry.permission_id;
  end if;

  select pg_catalog.count(*), pg_catalog.count(distinct continuity.permission_id)
  into continuity_count, distinct_continuity_count
  from vortex_access.permission_continuities as continuity
  where continuity.organization_id = p_organization_id
    and continuity.registration_kind = 'platform'
    and continuity.registration_owner_id = platform_owner_id;

  if continuity_count <> expected_count
    or distinct_continuity_count <> expected_count
    or exists (
      select 1
      from vortex_access.permission_continuities as continuity
      where continuity.organization_id = p_organization_id
        and continuity.registration_kind = 'platform'
        and continuity.registration_owner_id = platform_owner_id
        and not exists (
          select 1
          from vortex_access.permission_catalogue_entries as entry
          where entry.organization_id = continuity.organization_id
            and entry.registration_kind = continuity.registration_kind
            and entry.registration_owner_id = platform_owner_id
            and entry.registration_revision = platform_registration.revision
            and entry.application_root_id is null
            and entry.owner_kind = 'platform'
            and entry.owner_id = platform_owner_id
            and entry.owner_kind = continuity.owner_kind
            and entry.owner_id = continuity.owner_id
            and entry.permission_id = continuity.permission_id
            and entry.meaning_fingerprint = continuity.meaning_fingerprint
            and continuity.application_root_id is null
            and continuity.state = 'available'
            and continuity.continuity_revision > 0
            and continuity.last_processed_registration_revision =
              platform_registration.revision
        )
    ) or exists (
      select 1
      from vortex_access.permission_catalogue_entries as entry
      where entry.organization_id = p_organization_id
        and entry.registration_kind = 'platform'
        and entry.registration_owner_id = platform_owner_id
        and entry.registration_revision = platform_registration.revision
        and not exists (
          select 1
          from vortex_access.permission_continuities as continuity
          where continuity.organization_id = entry.organization_id
            and continuity.application_root_id is null
            and continuity.registration_kind = 'platform'
            and continuity.registration_owner_id = platform_owner_id
            and continuity.owner_kind = 'platform'
            and continuity.owner_id = platform_owner_id
            and continuity.owner_kind = entry.owner_kind
            and continuity.owner_id = entry.owner_id
            and continuity.permission_id = entry.permission_id
            and continuity.state = 'available'
            and continuity.continuity_revision > 0
            and continuity.meaning_fingerprint = entry.meaning_fingerprint
            and continuity.last_processed_registration_revision =
              platform_registration.revision
        )
    ) then
    raise exception using errcode = '55000',
      message = 'Platform permission continuity evidence is incomplete';
  end if;

  if is_replay then
    perform vortex_access.assert_organization_has_permanent_steward(
      p_organization_id
    );
    if platform_registration.revision >= 7
      and declared_current_revision = platform_registration.revision then
      -- Availability is already current; use the version under our held lock.
      select version.current_version into next_access_version
      from vortex_access.organization_access_versions as version
      where version.organization_id = p_organization_id;
    else
      -- Historical progression or a newer trusted target must use its writer.
      select published.access_version into next_access_version
      from vortex_access.initialize_platform_permission_catalogue(
        p_organization_id, p_changed_by, p_correlation_id
      ) as published;
    end if;

    return query select 'unchanged'::text,
      'adopt_organization_stewardship'::text,
      pg_catalog.jsonb_build_object(
        'organizationId', stewardship.organization_id,
        'originalOrganizationAccountId',
          stewardship.original_organization_account_id,
        'originalRoleId', stewardship.original_role_id,
        'originalRoleAssignmentId', stewardship.original_role_assignment_id,
        'originalDelegationAuthorityId',
          stewardship.original_delegation_authority_id,
        'revision', stewardship.revision,
        'adoptedByActorId', stewardship.adopted_by,
        'adoptedAt', stewardship.adopted_at,
        'adoptionCorrelationId', stewardship.adoption_correlation_id,
        'changedByActorId', stewardship.changed_by,
        'changedAt', stewardship.changed_at,
        'changeCorrelationId', stewardship.change_correlation_id
      ), next_access_version, p_correlation_id;
    return;
  end if;

  checked_at := pg_catalog.clock_timestamp();

  insert into vortex_access.organization_roles (
    organization_id, role_id, role_kind, role_key, application_root_id,
    source_role_id, derived_application_root_id, derived_source_role_id,
    derived_source_definition_key, derived_source_release_revision,
    derived_source_release_version,
    derived_source_validation_contract_version,
    derived_source_content_fingerprint,
    derived_source_resolution_fingerprint,
    derived_source_template_fingerprint, live_revision, created_by, created_at
  ) values (
    p_organization_id, p_role_id, 'custom', p_role_key, null, null,
    null, null, null, null, null, null, null, null, null, 1,
    p_changed_by, checked_at
  );

  insert into vortex_access.organization_role_permission_entries (
    organization_id, role_id, role_revision, entry_ordinal, role_kind,
    role_application_root_id, application_root_id, owner_kind, owner_id,
    permission_id, registration_kind, registration_owner_id,
    accepted_registration_revision, catalogue_fingerprint,
    continuity_revision, meaning_fingerprint
  )
  select p_organization_id, p_role_id, 1,
    pg_catalog.row_number() over (
      order by entry.owner_kind collate "C", entry.owner_id,
        entry.permission_id
    ),
    'custom', null, null, entry.owner_kind, entry.owner_id,
    entry.permission_id, 'platform', entry.registration_owner_id,
    entry.registration_revision,
    platform_registration.permission_catalogue_fingerprint,
    continuity.continuity_revision, entry.meaning_fingerprint
  from vortex_access.permission_catalogue_entries as entry
  join vortex_access.permission_continuities as continuity
    on continuity.organization_id = entry.organization_id
    and continuity.application_root_id is null
    and continuity.owner_kind = entry.owner_kind
    and continuity.owner_id = entry.owner_id
    and continuity.permission_id = entry.permission_id
    and continuity.registration_kind = 'platform'
    and continuity.registration_owner_id = platform_owner_id
    and continuity.registration_owner_id = entry.registration_owner_id
    and continuity.state = 'available'
    and continuity.continuity_revision > 0
    and continuity.last_processed_registration_revision =
      platform_registration.revision
    and continuity.meaning_fingerprint = entry.meaning_fingerprint
  where entry.organization_id = p_organization_id
    and entry.application_root_id is null
    and entry.registration_kind = 'platform'
    and entry.registration_owner_id = platform_owner_id
    and entry.registration_revision = platform_registration.revision
    and entry.owner_kind = 'platform'
    and entry.owner_id = platform_owner_id
  order by entry.owner_kind collate "C", entry.owner_id, entry.permission_id;

  get diagnostics granted_count = row_count;
  if granted_count <> expected_count or (
    select pg_catalog.count(distinct grant_entry.permission_id)
    from vortex_access.organization_role_permission_entries as grant_entry
    where grant_entry.organization_id = p_organization_id
      and grant_entry.role_id = p_role_id
      and grant_entry.role_revision = 1
  ) <> expected_count then
    raise exception using errcode = '55000',
      message = 'Platform permission stewardship grant evidence is incomplete';
  end if;

  insert into vortex_access.organization_role_revisions (
    organization_id, role_id, revision, role_kind, application_root_id,
    lifecycle, privilege_classification, assignment_policy,
    policy_continuity_revision, authority_continuity_revision,
    activation_policy_id, activation_policy_revision,
    role_key, label, description,
    source_definition_key, source_release_revision, source_release_version,
    source_validation_contract_version, source_content_fingerprint,
    source_resolution_fingerprint, source_template_fingerprint,
    source_catalogue_fingerprint, accepted_registration_revision,
    template_continuity_revision,
    changed_by, changed_at, change_correlation_id
  ) values (
    p_organization_id, p_role_id, 1, 'custom', null, 'active', 'privileged',
    'standing', 1, 1, null, null, p_role_key, p_role_label,
    p_role_description, null, null, null, null, null, null, null, null,
    null, null, p_changed_by, checked_at, p_correlation_id
  );

  insert into vortex_access.organization_role_assignments (
    organization_id, role_assignment_id, role_id, assignee_kind,
    organization_account_id, group_id, assignment_kind, revision, starts_at,
    expires_at, state, granted_by, granted_at, grant_correlation_id,
    changed_by, changed_at, change_correlation_id, revoked_by, revoked_at,
    revocation_correlation_id
  ) values (
    p_organization_id, p_role_assignment_id, p_role_id,
    'organization_account', p_organization_account_id, null, 'standing', 1,
    checked_at, null, 'live', p_changed_by, checked_at, p_correlation_id,
    p_changed_by, checked_at, p_correlation_id, null, null, null
  );

  insert into vortex_access.organization_delegation_authorities (
    organization_id, delegation_authority_id, holder_kind,
    organization_account_id, group_id, scope_kind, bounded_permissions,
    revision, starts_at, expires_at, state, granted_by,
    granted_at, grant_correlation_id, changed_by, changed_at,
    change_correlation_id, revoked_by, revoked_at,
    revocation_correlation_id
  ) values (
    p_organization_id, p_delegation_authority_id, 'organization_account',
    p_organization_account_id, null, 'organization_catalogue', null, 1,
    checked_at, null, 'live', p_changed_by, checked_at, p_correlation_id,
    p_changed_by, checked_at, p_correlation_id, null, null, null
  );

  insert into vortex_access.organization_stewardship_requirements (
    organization_id, original_organization_account_id, original_role_id,
    original_role_assignment_id, original_delegation_authority_id, revision,
    adopted_by, adopted_at, adoption_correlation_id, changed_by, changed_at,
    change_correlation_id
  ) values (
    p_organization_id, p_organization_account_id, p_role_id,
    p_role_assignment_id, p_delegation_authority_id, 1, p_changed_by,
    checked_at, p_correlation_id, p_changed_by, checked_at, p_correlation_id
  ) returning * into stewardship;

  perform vortex_access.assert_organization_has_permanent_steward(
    p_organization_id
  );

  perform 1
  from vortex_access.increment_organization_access_version(
    p_organization_id, p_changed_by, p_correlation_id,
    'stewardship_changed'
  ) as version;

  if platform_registration.revision >= 7
    and declared_current_revision = platform_registration.revision then
    -- Availability is already current; use the version under our held lock.
    select version.current_version into next_access_version
    from vortex_access.organization_access_versions as version
    where version.organization_id = p_organization_id;
  else
    -- Historical progression or a newer trusted target must use its writer.
    select published.access_version into next_access_version
    from vortex_access.initialize_platform_permission_catalogue(
      p_organization_id, p_changed_by, p_correlation_id
    ) as published;
  end if;

  return query select 'changed'::text,
    'adopt_organization_stewardship'::text,
    pg_catalog.jsonb_build_object(
      'organizationId', stewardship.organization_id,
      'originalOrganizationAccountId',
        stewardship.original_organization_account_id,
      'originalRoleId', stewardship.original_role_id,
      'originalRoleAssignmentId', stewardship.original_role_assignment_id,
      'originalDelegationAuthorityId',
        stewardship.original_delegation_authority_id,
      'revision', stewardship.revision,
      'adoptedByActorId', stewardship.adopted_by,
      'adoptedAt', stewardship.adopted_at,
      'adoptionCorrelationId', stewardship.adoption_correlation_id,
      'changedByActorId', stewardship.changed_by,
      'changedAt', stewardship.changed_at,
      'changeCorrelationId', stewardship.change_correlation_id
    ), next_access_version, p_correlation_id;
end
$function$;

comment on function vortex_access.coordinate_organization_stewardship_adoption(
  uuid, uuid, uuid, text, text, text, uuid, uuid, uuid, uuid
) is
  'Owner-only atomic whole-current-catalogue first-steward adoption or exact unchanged replay. It preserves original grants, validates complete availability, and progresses only through the existing catalogue writer.';

revoke execute on function
  vortex_access.coordinate_organization_stewardship_adoption(
    uuid, uuid, uuid, text, text, text, uuid, uuid, uuid, uuid
  ) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

revoke execute on function
  vortex_access.coordinate_organization_stewardship_adoption(
    uuid, uuid, uuid, text, text, text, uuid, uuid, uuid, uuid
  ) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

revoke execute on function
  vortex_access.coordinate_organization_stewardship_adoption(
    uuid, uuid, uuid, text, text, text, uuid, uuid, uuid, uuid
  ) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

create or replace function vortex_access.coordinate_private_organization_role_authority_change(
  p_prepared_evidence jsonb,
  p_activity_id uuid
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
security definer
set search_path = ''
as $function$
declare
  context_value jsonb;
  context_organization_id uuid;
  context_account_id uuid;
  context_access_version bigint;
  context_correlation_id uuid;
  locked_access_version bigint;
  candidate jsonb;
  operation_name text;
  operation_key text;
  target_organization_id uuid;
  target_role_id uuid;
  expected_role_revision bigint;
  role_identity vortex_access.organization_roles%rowtype;
  current_revision vortex_access.organization_role_revisions%rowtype;
  authority_before jsonb;
  authority_after jsonb;
  policy_choice jsonb;
  policy_changed boolean;
  decision record;
  changed record;
  activity_result text;
begin
  if p_prepared_evidence is null
    or pg_catalog.jsonb_typeof(p_prepared_evidence) is distinct from 'object'
    or pg_catalog.jsonb_typeof(p_prepared_evidence -> 'candidate')
      is distinct from 'object'
    or vortex_platform.is_non_nil_uuid(p_activity_id::text) is not true then
    raise exception using errcode = '22023',
      message = 'Private Organization role-authority input is invalid';
  end if;

  candidate := p_prepared_evidence -> 'candidate';
  operation_name := candidate ->> 'operation';
  if operation_name is null or operation_name not in (
    'create_custom', 'create_custom_from_template',
    'accept_new_application_role', 'revise_metadata_policy',
    'revise_custom_permissions', 'accept_application_role_revision'
  )
    or pg_catalog.jsonb_typeof(candidate -> 'organizationId')
      is distinct from 'string'
    or not vortex_platform.is_non_nil_uuid(candidate ->> 'organizationId')
    or pg_catalog.jsonb_typeof(candidate -> 'roleId') is distinct from 'string'
    or not vortex_platform.is_non_nil_uuid(candidate ->> 'roleId') then
    raise exception using errcode = '22023',
      message = 'Private Organization role-authority input is invalid';
  end if;
  target_organization_id := (candidate ->> 'organizationId')::uuid;
  target_role_id := (candidate ->> 'roleId')::uuid;

  context_value := vortex_access.validated_human_request_context();
  context_organization_id := (context_value ->> 'organizationId')::uuid;
  context_account_id := (context_value ->> 'organizationAccountId')::uuid;
  context_access_version := (context_value ->> 'accessVersion')::bigint;
  context_correlation_id := (context_value ->> 'correlationId')::uuid;
  if target_organization_id is distinct from context_organization_id then
    raise exception using errcode = '42501',
      message = 'Private Organization role-authority change is unavailable';
  end if;

  select version.current_version into locked_access_version
  from vortex_access.organization_access_versions as version
  join vortex_identity.organizations as organization
    on organization.organization_id = version.organization_id
  join vortex_identity.tenants as tenant
    on tenant.tenant_id = organization.tenant_id
  where version.organization_id = context_organization_id
    and organization.state = 'active'
    and tenant.state = 'active'
  for update of version;
  if not found or locked_access_version is distinct from context_access_version then
    raise exception using errcode = '42501',
      message = 'Private Organization role-authority change is unavailable';
  end if;

  if operation_name in (
    'create_custom', 'create_custom_from_template', 'accept_new_application_role'
  ) then
    if exists (
      select 1 from vortex_access.organization_roles as stored
      where stored.organization_id = context_organization_id
        and stored.role_id = target_role_id
    ) then
      raise exception using errcode = '40001',
        message = 'Private Organization role-authority change is stale or unavailable';
    end if;
    authority_before := pg_catalog.jsonb_build_object('kind', 'none');
  else
    if pg_catalog.jsonb_typeof(candidate -> 'expectedRoleRevision')
        is distinct from 'number'
      or (candidate ->> 'expectedRoleRevision')::numeric not between
        1 and 9007199254740991
      or (candidate ->> 'expectedRoleRevision')::numeric <>
        pg_catalog.trunc((candidate ->> 'expectedRoleRevision')::numeric) then
      raise exception using errcode = '22023',
        message = 'Private Organization role-authority input is invalid';
    end if;
    expected_role_revision :=
      (candidate ->> 'expectedRoleRevision')::numeric::bigint;
    select identity.* into role_identity
    from vortex_access.organization_roles as identity
    where identity.organization_id = context_organization_id
      and identity.role_id = target_role_id
    for update of identity;
    if not found or role_identity.live_revision is distinct from expected_role_revision then
      raise exception using errcode = '40001',
        message = 'Private Organization role-authority change is stale or unavailable';
    end if;
    select revision.* into current_revision
    from vortex_access.organization_role_revisions as revision
    where revision.organization_id = context_organization_id
      and revision.role_id = target_role_id
      and revision.revision = role_identity.live_revision;
    if not found then
      raise exception using errcode = '40001',
        message = 'Private Organization role-authority change is stale or unavailable';
    end if;
    authority_before := vortex_access.private_current_role_management_scope(
      context_organization_id, target_role_id, expected_role_revision
    );
  end if;

  if operation_name = 'revise_metadata_policy' then
    policy_choice := candidate -> 'assignmentPolicy';
    if pg_catalog.jsonb_typeof(policy_choice) is distinct from 'object'
      or pg_catalog.jsonb_typeof(policy_choice -> 'kind') is distinct from 'string'
      or policy_choice ->> 'kind' not in ('standing', 'activation_required') then
      raise exception using errcode = '22023',
        message = 'Private Organization role-authority input is invalid';
    end if;
    if policy_choice ->> 'kind' = 'standing' then
      policy_changed := current_revision.assignment_policy <> 'standing';
    elsif policy_choice #>> '{activationPolicy,selection}' = 'new' then
      policy_changed := true;
    elsif policy_choice #>> '{activationPolicy,selection}' = 'existing'
      and vortex_platform.is_non_nil_uuid(
        policy_choice #>> '{activationPolicy,reference,activationPolicyId}'
      )
      and pg_catalog.jsonb_typeof(
        policy_choice #> '{activationPolicy,reference,revision}'
      ) = 'number'
      and (policy_choice #>>
        '{activationPolicy,reference,revision}')::numeric between
        1 and 9007199254740991
      and (policy_choice #>>
        '{activationPolicy,reference,revision}')::numeric =
        pg_catalog.trunc((policy_choice #>>
          '{activationPolicy,reference,revision}')::numeric) then
      policy_changed := current_revision.assignment_policy <> 'activation_required'
        or current_revision.activation_policy_id is distinct from
          (policy_choice #>>
            '{activationPolicy,reference,activationPolicyId}')::uuid
        or current_revision.activation_policy_revision is distinct from
          (policy_choice #>> '{activationPolicy,reference,revision}')::numeric::bigint;
    else
      raise exception using errcode = '22023',
        message = 'Private Organization role-authority input is invalid';
    end if;
    if policy_changed is not true then
      raise exception using errcode = '40001',
        message = 'Private Organization role-authority candidate changes no authority';
    end if;
    authority_after := authority_before;
  else
    authority_after := vortex_access.private_management_scope_from_permission_evidence(
      candidate -> 'permissions'
    );
  end if;

  if authority_before ->> 'kind' = 'none'
    and authority_after ->> 'kind' = 'none' then
    raise exception using errcode = '40001',
      message = 'Private Organization role-authority scope is unavailable';
  end if;

  operation_key := 'platform.organization.roles.' || operation_name;
  select evaluated.* into strict decision
  from vortex_access.evaluate_organization_permission_eligibility(
    pg_catalog.jsonb_build_object(
      'operationKey', operation_key,
      'action', pg_catalog.jsonb_build_object('actionKind', 'manage'),
      'target', pg_catalog.jsonb_build_object('kind', 'organization'),
      'requiredPermission', pg_catalog.jsonb_build_object(
        'ownerKind', 'platform',
        -- guard-allow: function-uuid fixed platform permission identity without declaration-table read access
        'ownerId', 'cabe121e-0baf-4084-9471-cce915d460a8',
        -- guard-allow: function-uuid fixed platform permission identity without declaration-table read access
        'permissionId', '87c96495-c806-4692-9bc2-250ddb10613c'
      ),
      'recentAuthentication', case
        when operation_name in (
          'create_custom_from_template', 'accept_new_application_role',
          'accept_application_role_revision'
        ) then pg_catalog.jsonb_build_object(
          'kind', 'primary', 'maximumAgeSeconds', 900
        )
        else pg_catalog.jsonb_build_object('kind', 'none')
      end,
      'authority', pg_catalog.jsonb_build_object(
        'kind', 'delegated_management',
        'before', authority_before,
        'after', authority_after
      )
    )
  ) as evaluated;
  if decision.outcome is distinct from 'eligible'
    or decision.operation_key is distinct from operation_key
    or decision.organization_id is distinct from context_organization_id
    or decision.organization_account_id is distinct from context_account_id
    or decision.access_version is distinct from context_access_version
    or decision.correlation_id is distinct from context_correlation_id then
    raise exception using errcode = '42501',
      message = 'Private Organization role-authority change is unavailable';
  end if;

  select result.* into strict changed
  from vortex_access.coordinate_organization_role_change(
    p_prepared_evidence, context_account_id, context_correlation_id
  ) as result;

  activity_result := vortex_record.append_organization_activity_entry(
    context_organization_id, p_activity_id,
    (changed.role ->> 'changedAt')::timestamptz,
    'organization_account', context_account_id, operation_name,
    array[target_role_id]::uuid[], array[]::uuid[], vortex_platform.channel(),
    context_correlation_id, 'completed'
  );
  if activity_result is distinct from 'inserted' then
    raise exception using errcode = '40001',
      message = 'Private Organization role-authority Activity is stale';
  end if;

  return query select changed.outcome, changed.operation, changed.role,
    changed.created_activation_policy, changed.access_version,
    changed.correlation_id;
exception
  when invalid_text_representation or invalid_parameter_value
      or numeric_value_out_of_range then
    raise exception using errcode = '22023',
      message = 'Private Organization role-authority input is invalid';
end
$function$;

revoke execute on function vortex_access.coordinate_private_organization_role_authority_change(jsonb, uuid)
from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

comment on function vortex_access.coordinate_private_organization_role_authority_change(jsonb, uuid) is
  'Owner-only authority-establishing role composition. It checks exact current/candidate permission scope, then reuses canonical role evidence, manifests, stewardship and Activity without exposing a grant endpoint.';

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
  target_source_content_fingerprint text;
  target_source_resolution_fingerprint text;
  target_source_template_fingerprint text;
  target_source_catalogue_fingerprint text;
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
      or selected_template - array[
        'template', 'sourceTemplateFingerprint', 'sourcePermissions', 'livePermissions'
      ]::text[] <> '{}'::jsonb
      or not (selected_template ?& array[
        'template', 'sourceTemplateFingerprint', 'sourcePermissions', 'livePermissions'
      ])
      or pg_catalog.jsonb_typeof(selected_template -> 'template') <> 'object'
      or pg_catalog.jsonb_typeof(selected_template -> 'livePermissions') <> 'array'
      or pg_catalog.jsonb_array_length(selected_template -> 'livePermissions') = 0
      or selected_template ->> 'sourceTemplateFingerprint' !~ '^sha256:[a-f0-9]{64}$' then
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
    target_source_content_fingerprint :=
      prepared_templates #>>
        '{permissionRegistration,applicationRelease,contentFingerprint}';
    target_source_resolution_fingerprint :=
      prepared_templates #>>
        '{permissionRegistration,applicationRelease,resolutionFingerprint}';
    target_source_template_fingerprint :=
      selected_template ->> 'sourceTemplateFingerprint';
    target_source_catalogue_fingerprint :=
      prepared_templates #>> '{permissionRegistration,applicationCatalogueFingerprint}';
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
      and continuity.source_template_fingerprint = target_source_template_fingerprint
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
      derived_source_content_fingerprint, derived_source_resolution_fingerprint,
      derived_source_template_fingerprint, live_revision, created_by, created_at
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
      case when operation_name = 'create_custom_from_template'
        then target_source_content_fingerprint else null end,
      case when operation_name = 'create_custom_from_template'
        then target_source_resolution_fingerprint else null end,
      case when operation_name = 'create_custom_from_template'
        then target_source_template_fingerprint else null end,
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
      target_source_content_fingerprint := null;
      target_source_resolution_fingerprint := null;
      target_source_template_fingerprint := null;
      target_source_catalogue_fingerprint := null;
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
    target_source_content_fingerprint := current_revision.source_content_fingerprint;
    target_source_resolution_fingerprint := current_revision.source_resolution_fingerprint;
    target_source_template_fingerprint := current_revision.source_template_fingerprint;
    target_source_catalogue_fingerprint := current_revision.source_catalogue_fingerprint;
    target_accepted_registration_revision := current_revision.accepted_registration_revision;
    target_template_continuity_revision := current_revision.template_continuity_revision;
  elsif operation_name = 'revise_custom_permissions' then
    target_lifecycle := 'active';
    target_source_definition_key := null;
    target_source_release_revision := null;
    target_source_release_version := null;
    target_source_validation_contract_version := null;
    target_source_content_fingerprint := null;
    target_source_resolution_fingerprint := null;
    target_source_template_fingerprint := null;
    target_source_catalogue_fingerprint := null;
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
    and current_revision.source_content_fingerprint is not distinct from
      target_source_content_fingerprint
    and current_revision.source_resolution_fingerprint is not distinct from
      target_source_resolution_fingerprint
    and current_revision.source_template_fingerprint is not distinct from
      target_source_template_fingerprint
    and current_revision.source_catalogue_fingerprint is not distinct from
      target_source_catalogue_fingerprint
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
      or current_revision.source_content_fingerprint is distinct from
        target_source_content_fingerprint
      or current_revision.source_resolution_fingerprint is distinct from
        target_source_resolution_fingerprint
      or current_revision.source_template_fingerprint is distinct from
        target_source_template_fingerprint
      or current_revision.source_catalogue_fingerprint is distinct from
        target_source_catalogue_fingerprint
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
    source_validation_contract_version, source_content_fingerprint,
    source_resolution_fingerprint, source_template_fingerprint,
    source_catalogue_fingerprint, accepted_registration_revision,
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
    target_source_validation_contract_version, target_source_content_fingerprint,
    target_source_resolution_fingerprint, target_source_template_fingerprint,
    target_source_catalogue_fingerprint, target_accepted_registration_revision,
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
          'contentFingerprint', revision.source_content_fingerprint,
          'resolutionFingerprint', revision.source_resolution_fingerprint
        ),
        'sourceTemplateFingerprint', revision.source_template_fingerprint,
        'sourceCatalogueFingerprint', revision.source_catalogue_fingerprint,
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
              identity.derived_source_validation_contract_version,
            'contentFingerprint', identity.derived_source_content_fingerprint,
            'resolutionFingerprint', identity.derived_source_resolution_fingerprint
          ),
          'sourceTemplateFingerprint', identity.derived_source_template_fingerprint
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
  vortex_access.coordinate_role_change_without_stewardship_v1_internal(
    jsonb, uuid, uuid
  )
from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

comment on function vortex_access.coordinate_role_change_without_stewardship_v1_internal(
  jsonb, uuid, uuid
) is
  'Owner-only atomic seven-intent role governance composition. It verifies exact evidence and manifests, changes Access once, and grants no caller authority.';

create or replace function vortex_access.evaluate_permission_role_path_internal(
  p_context jsonb,
  p_checked_at timestamptz,
  p_permission jsonb,
  p_action jsonb,
  p_record_type_id uuid
)
returns table (
  permission_entry vortex_access.permission_catalogue_entries,
  path_valid_until timestamptz
)
language plpgsql
stable
security invoker
set search_path = ''
as $function$
declare
  context_organization_value uuid := (p_context ->> 'organizationId')::uuid;
  context_account_value uuid := (p_context ->> 'organizationAccountId')::uuid;
  context_expires_value timestamptz := (p_context ->> 'expiresAt')::timestamptz;
  decision_checked_at timestamptz := p_checked_at;
  permission_application_value uuid := (p_permission ->> 'applicationRootId')::uuid;
  permission_owner_kind_value text := p_permission ->> 'ownerKind';
  permission_owner_value uuid := (p_permission ->> 'ownerId')::uuid;
  permission_value uuid := (p_permission ->> 'permissionId')::uuid;
  action_kind_value text := p_action ->> 'actionKind';
  named_action_value text := p_action ->> 'namedAction';
begin
  return query
  with current_permission as materialized (
    select catalogue.application_root_id, catalogue.owner_kind,
      catalogue.owner_id, catalogue.permission_id,
      catalogue.meaning_fingerprint, catalogue as permission_entry
    from vortex_access.permission_registrations as registration
    join vortex_access.permission_catalogue_entries as catalogue
      on catalogue.organization_id = registration.organization_id
      and catalogue.registration_kind = registration.registration_kind
      and catalogue.registration_owner_id = registration.registration_owner_id
      and catalogue.registration_revision = registration.revision
    join vortex_access.permission_continuities as continuity
      on continuity.organization_id = catalogue.organization_id
      and continuity.application_root_id is not distinct from
        catalogue.application_root_id
      and continuity.owner_kind = catalogue.owner_kind
      and continuity.owner_id = catalogue.owner_id
      and continuity.permission_id = catalogue.permission_id
      and continuity.registration_kind = catalogue.registration_kind
      and continuity.registration_owner_id = catalogue.registration_owner_id
      and continuity.last_processed_registration_revision = registration.revision
      and continuity.state = 'available'
      and continuity.meaning_fingerprint = catalogue.meaning_fingerprint
    where registration.organization_id = context_organization_value
      and registration.state = 'active'
      and catalogue.application_root_id is not distinct from
        permission_application_value
      and catalogue.owner_kind = permission_owner_kind_value
      and catalogue.owner_id = permission_owner_value
      and catalogue.permission_id = permission_value
      and catalogue.record_type_id is not distinct from p_record_type_id
      and catalogue.action_kind = action_kind_value
      and catalogue.named_action is not distinct from named_action_value
  ), current_role_permission as materialized (
    select role.role_id, role.live_revision,
      revision.assignment_policy, revision.authority_continuity_revision,
      revision.policy_continuity_revision, revision.activation_policy_id,
      revision.activation_policy_revision
    from vortex_access.organization_roles as role
    join vortex_access.organization_role_revisions as revision
      on revision.organization_id = role.organization_id
      and revision.role_id = role.role_id
      and revision.revision = role.live_revision
    join vortex_access.organization_role_permission_entries as permission
      on permission.organization_id = revision.organization_id
      and permission.role_id = revision.role_id
      and permission.role_revision = revision.revision
    join current_permission as available
      on available.application_root_id is not distinct from
        permission.application_root_id
      and available.owner_kind = permission.owner_kind
      and available.owner_id = permission.owner_id
      and available.permission_id = permission.permission_id
      and available.meaning_fingerprint = permission.meaning_fingerprint
    join vortex_access.permission_continuities as continuity
      on continuity.organization_id = permission.organization_id
      and continuity.application_root_id is not distinct from
        permission.application_root_id
      and continuity.owner_kind = permission.owner_kind
      and continuity.owner_id = permission.owner_id
      and continuity.permission_id = permission.permission_id
      and continuity.state = 'available'
      and continuity.continuity_revision = permission.continuity_revision
      and continuity.meaning_fingerprint = permission.meaning_fingerprint
    where role.organization_id = context_organization_value
      and revision.lifecycle in ('active', 'acceptance_required')
  ), route_candidates as (
    select 1 as route_rank, permission.role_id,
      assignment.role_assignment_id, null::uuid as membership_id,
      null::uuid as role_activation_id,
      least(
        context_expires_value,
        coalesce(assignment.expires_at, context_expires_value)
      ) as path_valid_until
    from current_role_permission as permission
    join vortex_access.organization_role_assignments as assignment
      on assignment.organization_id = context_organization_value
      and assignment.role_id = permission.role_id
      and assignment.assignee_kind = 'organization_account'
      and assignment.organization_account_id = context_account_value
      and assignment.assignment_kind = 'standing'
      and assignment.state = 'live'
      and assignment.starts_at <= decision_checked_at
      and (
        assignment.expires_at is null
        or assignment.expires_at > decision_checked_at
      )
    where permission.assignment_policy = 'standing'

    union all

    select 2, permission.role_id, assignment.role_assignment_id,
      membership.membership_id, null::uuid,
      least(
        context_expires_value,
        coalesce(assignment.expires_at, context_expires_value),
        coalesce(membership.expires_at, context_expires_value)
      )
    from current_role_permission as permission
    join vortex_access.organization_role_assignments as assignment
      on assignment.organization_id = context_organization_value
      and assignment.role_id = permission.role_id
      and assignment.assignee_kind = 'group'
      and assignment.assignment_kind = 'standing'
      and assignment.state = 'live'
      and assignment.starts_at <= decision_checked_at
      and (
        assignment.expires_at is null
        or assignment.expires_at > decision_checked_at
      )
    join vortex_access.organization_groups as organization_group
      on organization_group.organization_id = assignment.organization_id
      and organization_group.group_id = assignment.group_id
      and organization_group.state = 'active'
    join vortex_access.organization_group_memberships as membership
      on membership.organization_id = assignment.organization_id
      and membership.group_id = assignment.group_id
      and membership.organization_account_id = context_account_value
      and membership.state = 'live'
      and membership.starts_at <= decision_checked_at
      and (
        membership.expires_at is null
        or membership.expires_at > decision_checked_at
      )
    where permission.assignment_policy = 'standing'

    union all

    select 3, permission.role_id, assignment.role_assignment_id,
      null::uuid, activation.role_activation_id,
      least(
        context_expires_value,
        coalesce(assignment.expires_at, context_expires_value),
        activation.expires_at
      )
    from current_role_permission as permission
    join vortex_access.organization_role_assignments as assignment
      on assignment.organization_id = context_organization_value
      and assignment.role_id = permission.role_id
      and assignment.assignee_kind = 'organization_account'
      and assignment.organization_account_id = context_account_value
      and assignment.assignment_kind = 'eligible'
      and assignment.state = 'live'
      and assignment.starts_at <= decision_checked_at
      and (
        assignment.expires_at is null
        or assignment.expires_at > decision_checked_at
      )
    join vortex_access.organization_role_activations as activation
      on activation.organization_id = assignment.organization_id
      and activation.organization_account_id = context_account_value
      and activation.role_id = assignment.role_id
      and activation.eligibility_source_kind = 'direct'
      and activation.role_assignment_id = assignment.role_assignment_id
      and activation.role_assignment_revision = assignment.revision
      and activation.state = 'live'
      and activation.activated_at <= decision_checked_at
      and activation.expires_at > decision_checked_at
      and activation.authority_continuity_revision =
        permission.authority_continuity_revision
      and activation.policy_continuity_revision =
        permission.policy_continuity_revision
      and activation.activation_policy_id = permission.activation_policy_id
      and activation.activation_policy_revision =
        permission.activation_policy_revision
    where permission.assignment_policy = 'activation_required'

    union all

    select 4, permission.role_id, assignment.role_assignment_id,
      membership.membership_id, activation.role_activation_id,
      least(
        context_expires_value,
        coalesce(assignment.expires_at, context_expires_value),
        coalesce(membership.expires_at, context_expires_value),
        activation.expires_at
      )
    from current_role_permission as permission
    join vortex_access.organization_role_assignments as assignment
      on assignment.organization_id = context_organization_value
      and assignment.role_id = permission.role_id
      and assignment.assignee_kind = 'group'
      and assignment.assignment_kind = 'eligible'
      and assignment.state = 'live'
      and assignment.starts_at <= decision_checked_at
      and (
        assignment.expires_at is null
        or assignment.expires_at > decision_checked_at
      )
    join vortex_access.organization_groups as organization_group
      on organization_group.organization_id = assignment.organization_id
      and organization_group.group_id = assignment.group_id
      and organization_group.state = 'active'
    join vortex_access.organization_role_activations as activation
      on activation.organization_id = assignment.organization_id
      and activation.organization_account_id = context_account_value
      and activation.role_id = assignment.role_id
      and activation.eligibility_source_kind = 'group'
      and activation.role_assignment_id = assignment.role_assignment_id
      and activation.role_assignment_revision = assignment.revision
      and activation.state = 'live'
      and activation.activated_at <= decision_checked_at
      and activation.expires_at > decision_checked_at
      and activation.authority_continuity_revision =
        permission.authority_continuity_revision
      and activation.policy_continuity_revision =
        permission.policy_continuity_revision
      and activation.activation_policy_id = permission.activation_policy_id
      and activation.activation_policy_revision =
        permission.activation_policy_revision
    join vortex_access.organization_group_memberships as membership
      on membership.organization_id = assignment.organization_id
      and membership.group_id = assignment.group_id
      and membership.organization_account_id = context_account_value
      and membership.membership_id = activation.membership_id
      and membership.revision = activation.membership_revision
      and membership.state = 'live'
      and membership.starts_at <= decision_checked_at
      and (
        membership.expires_at is null
        or membership.expires_at > decision_checked_at
      )
    where permission.assignment_policy = 'activation_required'
  ), selected_route as materialized (
    select route.path_valid_until
    from route_candidates as route

    union all

    select context_expires_value
    from current_permission as available
    where vortex_identity.resolve_active_vortex_super_administrator_assignment_internal(
      (p_context ->> 'identityId')::uuid, decision_checked_at
    ) is not null

    order by path_valid_until
    limit 1
  )
  select available.permission_entry, selected.path_valid_until
  from current_permission as available
  left join selected_route as selected on true;
end
$function$;

revoke execute on function
  vortex_access.evaluate_permission_role_path_internal(
    jsonb, timestamptz, jsonb, jsonb, uuid
  )
from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;

grant execute on function
  vortex_access.evaluate_permission_role_path_internal(
    jsonb, timestamptz, jsonb, jsonb, uuid
  ) to vortex_owner;

comment on function
  vortex_access.evaluate_permission_role_path_internal(
    jsonb, timestamptz, jsonb, jsonb, uuid
  ) is
  'Private current-permission and role-path evidence; null record type selects only non-record permissions. No row authority.';

create or replace function vortex_access.list_organization_roles_for_administration(
  p_after_role_id uuid,
  p_page_size integer
)
returns table (
  organization_id uuid,
  roles jsonb,
  next_after_role_id uuid,
  access_version bigint
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  scope record;
  role_items jsonb;
  page_role_ids uuid[];
  candidate_count integer;
begin
  if p_page_size is null or p_page_size not between 1 and 100
    or p_after_role_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using errcode = '22023',
      message = 'Organization role page input is invalid';
  end if;

  select authorized.* into strict scope
  from vortex_access.organization_roles_administration_scope() as authorized;

  with candidates as (
    select role.role_id, role.role_kind, role.application_root_id,
      role.source_role_id, revision.role_key, revision.label,
      revision.lifecycle, revision.revision, revision.privilege_classification,
      revision.assignment_policy, policy.maximum_activation_duration_seconds,
      policy.reason_required, policy.authentication_requirement,
      policy.authentication_maximum_age_seconds,
      policy.required_caller_execution_binding_id,
      (
        select pg_catalog.count(*)
        from vortex_access.organization_role_permission_entries as permission
        where permission.organization_id = revision.organization_id
          and permission.role_id = revision.role_id
          and permission.role_revision = revision.revision
      ) as accepted_permission_count,
      pg_catalog.row_number() over (order by role.role_id) as ordinal
    from vortex_access.organization_roles as role
    join vortex_access.organization_role_revisions as revision
      on revision.organization_id = role.organization_id
      and revision.role_id = role.role_id
      and revision.revision = role.live_revision
    left join vortex_access.organization_role_activation_policy_revisions as policy
      on policy.organization_id = revision.organization_id
      and policy.role_id = revision.role_id
      and policy.activation_policy_id = revision.activation_policy_id
      and policy.revision = revision.activation_policy_revision
    where role.organization_id = scope.organization_id
      and (p_after_role_id is null or role.role_id > p_after_role_id)
    order by role.role_id
    limit p_page_size + 1
  )
  select coalesce(
      pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'roleId', candidate.role_id,
          'key', candidate.role_key,
          'label', candidate.label,
          'roleKind', candidate.role_kind,
          'lifecycle', candidate.lifecycle,
          'liveRevision', candidate.revision,
          'privilegeClassification', candidate.privilege_classification,
          'assignmentPolicy', case candidate.assignment_policy
            when 'standing' then pg_catalog.jsonb_build_object('kind', 'standing')
            else pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
              'kind', 'activation_required',
              'maximumActivationDurationSeconds',
                candidate.maximum_activation_duration_seconds,
              'reasonRequired', candidate.reason_required,
              'recentAuthentication', case candidate.authentication_requirement
                when 'none' then pg_catalog.jsonb_build_object('kind', 'none')
                else pg_catalog.jsonb_build_object(
                  'kind', candidate.authentication_requirement,
                  'maximumAgeSeconds', candidate.authentication_maximum_age_seconds
                )
              end,
              'requiredCallerExecutionBindingId',
                candidate.required_caller_execution_binding_id
            ))
          end,
          'source', case candidate.role_kind
            when 'custom' then pg_catalog.jsonb_build_object('kind', 'custom')
            else pg_catalog.jsonb_build_object(
              'kind', 'application',
              'applicationRootId', candidate.application_root_id,
              'sourceRoleId', candidate.source_role_id
            )
          end,
          'acceptedPermissionCount', candidate.accepted_permission_count
        ) order by candidate.role_id
      ) filter (where candidate.ordinal <= p_page_size),
      '[]'::jsonb
    ),
    pg_catalog.array_agg(candidate.role_id order by candidate.ordinal)
      filter (where candidate.ordinal <= p_page_size),
    pg_catalog.count(*)
  into role_items, page_role_ids, candidate_count
  from candidates as candidate;

  return query select scope.organization_id, role_items,
    case when candidate_count > p_page_size
      then page_role_ids[p_page_size] else null end,
    scope.access_version;
end
$function$;

revoke execute on function
  vortex_access.list_organization_roles_for_administration(uuid, integer)
from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

grant execute on function
  vortex_access.list_organization_roles_for_administration(uuid, integer)
to vortex_request;

comment on function
  vortex_access.list_organization_roles_for_administration(uuid, integer) is
  'Returns one bounded page of current local role configuration without effective-access evidence.';

set local role vortex_owner;

-- Private Access-owner routine; Record callers first lock the active linked account.
create or replace function vortex_access.organization_account_has_current_application_access_internal(
  p_organization_id uuid,
  p_organization_account_id uuid,
  p_application_root_id uuid
)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  context_value jsonb;
  checked_at timestamptz := pg_catalog.clock_timestamp();
begin
  if p_organization_id is null
    or p_organization_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_organization_account_id is null
    or p_organization_account_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_application_root_id is null
    or p_application_root_id = '00000000-0000-0000-0000-000000000000'::uuid then
    return false;
  end if;

  context_value := vortex_access.validated_human_request_context();
  if not context_value ? 'applicationRootId'
    or (context_value ->> 'expiresAt')::timestamptz <= checked_at
    or (context_value ->> 'organizationId')::uuid is distinct from p_organization_id
    or (context_value ->> 'applicationRootId')::uuid is distinct from p_application_root_id then
    return false;
  end if;

  -- The Record writer invokes this helper only after locking the exact active
  -- organisation-account projection and its active identity in this organisation.
  return exists (
    with current_roles as (
      select role.role_id, role.source_role_id, revision.assignment_policy,
        revision.authority_continuity_revision,
        revision.policy_continuity_revision, revision.activation_policy_id,
        revision.activation_policy_revision
      from vortex_access.organization_roles as role
      join vortex_access.organization_role_revisions as revision
        on revision.organization_id = role.organization_id
        and revision.role_id = role.role_id
        and revision.revision = role.live_revision
      where role.organization_id = p_organization_id
        and role.application_root_id = p_application_root_id
        and role.role_kind = 'application'
        and revision.lifecycle in ('active', 'acceptance_required')
    ), active_roles as (
      select role.source_role_id
      from current_roles as role
      join vortex_access.organization_role_assignments as assignment
        on assignment.organization_id = p_organization_id
        and assignment.role_id = role.role_id
        and assignment.assignee_kind = 'organization_account'
        and assignment.organization_account_id = p_organization_account_id
        and assignment.assignment_kind = 'standing'
        and assignment.state = 'live'
        and assignment.starts_at <= checked_at
        and (assignment.expires_at is null or assignment.expires_at > checked_at)
      where role.assignment_policy = 'standing'

      union

      select role.source_role_id
      from current_roles as role
      join vortex_access.organization_role_assignments as assignment
        on assignment.organization_id = p_organization_id
        and assignment.role_id = role.role_id
        and assignment.assignee_kind = 'group'
        and assignment.assignment_kind = 'standing'
        and assignment.state = 'live'
        and assignment.starts_at <= checked_at
        and (assignment.expires_at is null or assignment.expires_at > checked_at)
      join vortex_access.organization_groups as organization_group
        on organization_group.organization_id = assignment.organization_id
        and organization_group.group_id = assignment.group_id
        and organization_group.state = 'active'
      join vortex_access.organization_group_memberships as membership
        on membership.organization_id = assignment.organization_id
        and membership.group_id = assignment.group_id
        and membership.organization_account_id = p_organization_account_id
        and membership.state = 'live'
        and membership.starts_at <= checked_at
        and (membership.expires_at is null or membership.expires_at > checked_at)
      where role.assignment_policy = 'standing'

      union

      select role.source_role_id
      from current_roles as role
      join vortex_access.organization_role_assignments as assignment
        on assignment.organization_id = p_organization_id
        and assignment.role_id = role.role_id
        and assignment.assignee_kind = 'organization_account'
        and assignment.organization_account_id = p_organization_account_id
        and assignment.assignment_kind = 'eligible'
        and assignment.state = 'live'
        and assignment.starts_at <= checked_at
        and (assignment.expires_at is null or assignment.expires_at > checked_at)
      join vortex_access.organization_role_activations as activation
        on activation.organization_id = assignment.organization_id
        and activation.organization_account_id = p_organization_account_id
        and activation.role_id = assignment.role_id
        and activation.eligibility_source_kind = 'direct'
        and activation.role_assignment_id = assignment.role_assignment_id
        and activation.role_assignment_revision = assignment.revision
        and activation.state = 'live'
        and activation.activated_at <= checked_at
        and activation.expires_at > checked_at
        and activation.authority_continuity_revision = role.authority_continuity_revision
        and activation.policy_continuity_revision = role.policy_continuity_revision
        and activation.activation_policy_id = role.activation_policy_id
        and activation.activation_policy_revision = role.activation_policy_revision
      where role.assignment_policy = 'activation_required'

      union

      select role.source_role_id
      from current_roles as role
      join vortex_access.organization_role_assignments as assignment
        on assignment.organization_id = p_organization_id
        and assignment.role_id = role.role_id
        and assignment.assignee_kind = 'group'
        and assignment.assignment_kind = 'eligible'
        and assignment.state = 'live'
        and assignment.starts_at <= checked_at
        and (assignment.expires_at is null or assignment.expires_at > checked_at)
      join vortex_access.organization_groups as organization_group
        on organization_group.organization_id = assignment.organization_id
        and organization_group.group_id = assignment.group_id
        and organization_group.state = 'active'
      join vortex_access.organization_role_activations as activation
        on activation.organization_id = assignment.organization_id
        and activation.organization_account_id = p_organization_account_id
        and activation.role_id = assignment.role_id
        and activation.eligibility_source_kind = 'group'
        and activation.role_assignment_id = assignment.role_assignment_id
        and activation.role_assignment_revision = assignment.revision
        and activation.state = 'live'
        and activation.activated_at <= checked_at
        and activation.expires_at > checked_at
        and activation.authority_continuity_revision = role.authority_continuity_revision
        and activation.policy_continuity_revision = role.policy_continuity_revision
        and activation.activation_policy_id = role.activation_policy_id
        and activation.activation_policy_revision = role.activation_policy_revision
      join vortex_access.organization_group_memberships as membership
        on membership.organization_id = assignment.organization_id
        and membership.group_id = assignment.group_id
        and membership.organization_account_id = p_organization_account_id
        and membership.membership_id = activation.membership_id
        and membership.revision = activation.membership_revision
        and membership.state = 'live'
        and membership.starts_at <= checked_at
        and (membership.expires_at is null or membership.expires_at > checked_at)
      where role.assignment_policy = 'activation_required'
    )
    select 1 from active_roles
  );
end
$function$;
alter function vortex_access.organization_account_has_current_application_access_internal(uuid,uuid,uuid) owner to vortex_owner;


revoke all on function vortex_access.organization_account_has_current_application_access_internal(uuid, uuid, uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

grant execute on function vortex_access.organization_account_has_current_application_access_internal(uuid, uuid, uuid)
  to vortex_record_adapter;

comment on function vortex_access.organization_account_has_current_application_access_internal(uuid, uuid, uuid) is
  'Private Record-link authorization for a previously locked active organisation account: returns only whether that linked account has a current direct or Group application role under the validated human application context, including current assignment, membership and activation continuity.';

alter function vortex_access.organization_account_has_current_application_access_internal(uuid, uuid, uuid)
  owner to vortex_owner;

reset role;

create or replace function vortex_access.project_organization_role_change_summary(
  p_organization_id uuid,
  p_role_id uuid
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $function$
  select pg_catalog.jsonb_build_object(
    'roleId', role.role_id,
    'key', revision.role_key,
    'label', revision.label,
    'roleKind', role.role_kind,
    'lifecycle', revision.lifecycle,
    'liveRevision', revision.revision,
    'privilegeClassification', revision.privilege_classification,
    'assignmentPolicy', case revision.assignment_policy
      when 'standing' then pg_catalog.jsonb_build_object('kind', 'standing')
      else pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
        'kind', 'activation_required',
        'maximumActivationDurationSeconds',
          policy.maximum_activation_duration_seconds,
        'reasonRequired', policy.reason_required,
        'recentAuthentication', case policy.authentication_requirement
          when 'none' then pg_catalog.jsonb_build_object('kind', 'none')
          else pg_catalog.jsonb_build_object(
            'kind', policy.authentication_requirement,
            'maximumAgeSeconds', policy.authentication_maximum_age_seconds
          )
        end,
        'requiredCallerExecutionBindingId', policy.required_caller_execution_binding_id
      ))
    end,
    'source', case role.role_kind
      when 'custom' then pg_catalog.jsonb_build_object('kind', 'custom')
      else pg_catalog.jsonb_build_object(
        'kind', 'application',
        'applicationRootId', role.application_root_id,
        'sourceRoleId', role.source_role_id
      )
    end,
    'acceptedPermissionCount', (
      select pg_catalog.count(*)
      from vortex_access.organization_role_permission_entries as permission
      where permission.organization_id = revision.organization_id
        and permission.role_id = revision.role_id
        and permission.role_revision = revision.revision
    )
  )
  from vortex_access.organization_roles as role
  join vortex_access.organization_role_revisions as revision
    on revision.organization_id = role.organization_id
    and revision.role_id = role.role_id
    and revision.revision = role.live_revision
  left join vortex_access.organization_role_activation_policy_revisions as policy
    on policy.organization_id = revision.organization_id
    and policy.role_id = revision.role_id
    and policy.activation_policy_id = revision.activation_policy_id
    and policy.revision = revision.activation_policy_revision
  where role.organization_id = p_organization_id
    and role.role_id = p_role_id
$function$;

revoke execute on function
  vortex_access.project_organization_role_change_summary(uuid, uuid)
from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

comment on function
  vortex_access.project_organization_role_change_summary(uuid, uuid) is
  'Private safe current role projection for protected structural changes.';

CREATE OR REPLACE FUNCTION vortex_access.protect_organization_role_activation() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
begin
  if tg_op = 'DELETE' then
    raise exception using errcode = '23514',
      message = 'Organization role activations cannot be deleted';
  end if;

  if old.revision = 9007199254740991 then
    raise exception using errcode = '22003',
      message = 'Organization role activation revision is exhausted';
  end if;

  if old.state = 'revoked'
    or new.state <> 'revoked'
    or new.revoked_at is null
    or new.revoked_at < old.changed_at
    or new.organization_id is distinct from old.organization_id
    or new.role_activation_id is distinct from old.role_activation_id
    or new.organization_account_id is distinct from old.organization_account_id
    or new.role_id is distinct from old.role_id
    or new.historical_role_revision is distinct from old.historical_role_revision
    or new.authority_continuity_revision is distinct from
      old.authority_continuity_revision
    or new.policy_continuity_revision is distinct from
      old.policy_continuity_revision
    or new.activation_policy_id is distinct from old.activation_policy_id
    or new.activation_policy_revision is distinct from old.activation_policy_revision
    or new.eligibility_source_kind is distinct from old.eligibility_source_kind
    or new.role_assignment_id is distinct from old.role_assignment_id
    or new.role_assignment_revision is distinct from old.role_assignment_revision
    or new.membership_id is distinct from old.membership_id
    or new.membership_revision is distinct from old.membership_revision
    or new.activated_by is distinct from old.activated_by
    or new.activated_at is distinct from old.activated_at
    or new.expires_at is distinct from old.expires_at
    or new.activation_correlation_id is distinct from old.activation_correlation_id
    or new.revision <> old.revision + 1
    or new.changed_at < old.changed_at
    or (new.changed_by, new.changed_at, new.change_correlation_id)
      is not distinct from
      (old.changed_by, old.changed_at, old.change_correlation_id) then
    raise exception using errcode = '23514',
      message = 'Organization role activation transition is invalid';
  end if;

  return new;
end
$$;

ALTER FUNCTION vortex_access.protect_organization_role_activation() OWNER TO postgres;

REVOKE ALL ON FUNCTION vortex_access.protect_organization_role_activation() FROM PUBLIC;

set local role vortex_owner;

create or replace function vortex_access.read_current_application_role_ids_for_launcher()
returns table (source_role_id uuid)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  context_value jsonb;
  checked_at timestamptz := pg_catalog.clock_timestamp();
begin
  context_value := vortex_access.validated_human_request_context();
  if not context_value ? 'applicationRootId'
    or (context_value ->> 'expiresAt')::timestamptz <= checked_at then
    return;
  end if;

  return query
  with current_roles as (
    select role.role_id, role.source_role_id, revision.assignment_policy,
      revision.authority_continuity_revision,
      revision.policy_continuity_revision, revision.activation_policy_id,
      revision.activation_policy_revision
    from vortex_access.organization_roles as role
    join vortex_access.organization_role_revisions as revision
      on revision.organization_id = role.organization_id
      and revision.role_id = role.role_id
      and revision.revision = role.live_revision
    where role.organization_id = (context_value ->> 'organizationId')::uuid
      and role.application_root_id = (context_value ->> 'applicationRootId')::uuid
      and role.role_kind = 'application'
      and revision.lifecycle in ('active', 'acceptance_required')
  ), active_roles as (
    select role.source_role_id
    from current_roles as role
    join vortex_access.organization_role_assignments as assignment
      on assignment.organization_id = (context_value ->> 'organizationId')::uuid
      and assignment.role_id = role.role_id
      and assignment.assignee_kind = 'organization_account'
      and assignment.organization_account_id = (context_value ->> 'organizationAccountId')::uuid
      and assignment.assignment_kind = 'standing'
      and assignment.state = 'live'
      and assignment.starts_at <= checked_at
      and (assignment.expires_at is null or assignment.expires_at > checked_at)
    where role.assignment_policy = 'standing'

    union

    select role.source_role_id
    from current_roles as role
    join vortex_access.organization_role_assignments as assignment
      on assignment.organization_id = (context_value ->> 'organizationId')::uuid
      and assignment.role_id = role.role_id
      and assignment.assignee_kind = 'group'
      and assignment.assignment_kind = 'standing'
      and assignment.state = 'live'
      and assignment.starts_at <= checked_at
      and (assignment.expires_at is null or assignment.expires_at > checked_at)
    join vortex_access.organization_groups as organization_group
      on organization_group.organization_id = assignment.organization_id
      and organization_group.group_id = assignment.group_id
      and organization_group.state = 'active'
    join vortex_access.organization_group_memberships as membership
      on membership.organization_id = assignment.organization_id
      and membership.group_id = assignment.group_id
      and membership.organization_account_id =
        (context_value ->> 'organizationAccountId')::uuid
      and membership.state = 'live'
      and membership.starts_at <= checked_at
      and (membership.expires_at is null or membership.expires_at > checked_at)
    where role.assignment_policy = 'standing'

    union

    select role.source_role_id
    from current_roles as role
    join vortex_access.organization_role_assignments as assignment
      on assignment.organization_id = (context_value ->> 'organizationId')::uuid
      and assignment.role_id = role.role_id
      and assignment.assignee_kind = 'organization_account'
      and assignment.organization_account_id = (context_value ->> 'organizationAccountId')::uuid
      and assignment.assignment_kind = 'eligible'
      and assignment.state = 'live'
      and assignment.starts_at <= checked_at
      and (assignment.expires_at is null or assignment.expires_at > checked_at)
    join vortex_access.organization_role_activations as activation
      on activation.organization_id = assignment.organization_id
      and activation.organization_account_id =
        (context_value ->> 'organizationAccountId')::uuid
      and activation.role_id = assignment.role_id
      and activation.eligibility_source_kind = 'direct'
      and activation.role_assignment_id = assignment.role_assignment_id
      and activation.role_assignment_revision = assignment.revision
      and activation.state = 'live'
      and activation.activated_at <= checked_at
      and activation.expires_at > checked_at
      and activation.authority_continuity_revision = role.authority_continuity_revision
      and activation.policy_continuity_revision = role.policy_continuity_revision
      and activation.activation_policy_id = role.activation_policy_id
      and activation.activation_policy_revision = role.activation_policy_revision
    where role.assignment_policy = 'activation_required'

    union

    select role.source_role_id
    from current_roles as role
    join vortex_access.organization_role_assignments as assignment
      on assignment.organization_id = (context_value ->> 'organizationId')::uuid
      and assignment.role_id = role.role_id
      and assignment.assignee_kind = 'group'
      and assignment.assignment_kind = 'eligible'
      and assignment.state = 'live'
      and assignment.starts_at <= checked_at
      and (assignment.expires_at is null or assignment.expires_at > checked_at)
    join vortex_access.organization_groups as organization_group
      on organization_group.organization_id = assignment.organization_id
      and organization_group.group_id = assignment.group_id
      and organization_group.state = 'active'
    join vortex_access.organization_role_activations as activation
      on activation.organization_id = assignment.organization_id
      and activation.organization_account_id =
        (context_value ->> 'organizationAccountId')::uuid
      and activation.role_id = assignment.role_id
      and activation.eligibility_source_kind = 'group'
      and activation.role_assignment_id = assignment.role_assignment_id
      and activation.role_assignment_revision = assignment.revision
      and activation.state = 'live'
      and activation.activated_at <= checked_at
      and activation.expires_at > checked_at
      and activation.authority_continuity_revision = role.authority_continuity_revision
      and activation.policy_continuity_revision = role.policy_continuity_revision
      and activation.activation_policy_id = role.activation_policy_id
      and activation.activation_policy_revision = role.activation_policy_revision
    join vortex_access.organization_group_memberships as membership
      on membership.organization_id = assignment.organization_id
      and membership.group_id = assignment.group_id
      and membership.organization_account_id =
        (context_value ->> 'organizationAccountId')::uuid
      and membership.membership_id = activation.membership_id
      and membership.revision = activation.membership_revision
      and membership.state = 'live'
      and membership.starts_at <= checked_at
      and (membership.expires_at is null or membership.expires_at > checked_at)
    where role.assignment_policy = 'activation_required'
  )
  select active.source_role_id from active_roles as active
  order by active.source_role_id;
end
$function$;

revoke execute on function vortex_access.read_current_application_role_ids_for_launcher()
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

grant execute on function vortex_access.read_current_application_role_ids_for_launcher()
  to vortex_request;

comment on function vortex_access.read_current_application_role_ids_for_launcher() is
  'Returns only current direct or group application-role source identities for the validated human application context; page authority is checked separately.';

alter function vortex_access.read_current_application_role_ids_for_launcher() owner to vortex_owner;

reset role;

create or replace function vortex_access.read_organization_role_activation_for_administration(
  p_role_activation_id uuid
)
returns table (
  organization_id uuid,
  outcome text,
  activation_summary jsonb,
  access_version bigint
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  scope record;
  checked_at timestamptz;
  activation_value jsonb;
begin
  if p_role_activation_id is null
    or p_role_activation_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using errcode = '22023',
      message = 'Organization role activation detail input is invalid';
  end if;

  select authorized.* into strict scope
  from vortex_access.organization_assignment_ledger_administration_scope()
    as authorized;
  checked_at := pg_catalog.clock_timestamp();

  select pg_catalog.jsonb_build_object(
    'roleActivationId', activation.role_activation_id,
    'beneficiary', pg_catalog.jsonb_build_object(
      'organizationAccountId', activation.organization_account_id,
      'displayName', account.display_name
    ),
    'role', pg_catalog.jsonb_build_object(
      'roleId', activation.role_id,
      'key', role_revision.role_key,
      'label', role_revision.label,
      'lifecycle', role_revision.lifecycle
    ),
    'revision', activation.revision,
    'historicalRoleRevision', activation.historical_role_revision,
    'eligibilitySource', case activation.eligibility_source_kind
      when 'direct' then pg_catalog.jsonb_build_object(
        'kind', 'direct',
        'eligibilityAssignment', pg_catalog.jsonb_build_object(
          'roleAssignmentId', activation.role_assignment_id,
          'revision', activation.role_assignment_revision
        )
      )
      else pg_catalog.jsonb_build_object(
        'kind', 'group',
        'eligibilityAssignment', pg_catalog.jsonb_build_object(
          'roleAssignmentId', activation.role_assignment_id,
          'revision', activation.role_assignment_revision
        ),
        'originatingMembership', pg_catalog.jsonb_build_object(
          'membershipId', activation.membership_id,
          'revision', activation.membership_revision
        )
      )
    end,
    'policyAtActivation', pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
      'maximumActivationDurationSeconds',
        policy.maximum_activation_duration_seconds,
      'reasonRequired', policy.reason_required,
      'recentAuthentication', case policy.authentication_requirement
        when 'none' then pg_catalog.jsonb_build_object('kind', 'none')
        else pg_catalog.jsonb_build_object(
          'kind', policy.authentication_requirement,
          'maximumAgeSeconds', policy.authentication_maximum_age_seconds
        )
      end,
      'requiredCallerExecutionBindingId', policy.required_caller_execution_binding_id
    )),
    'activatedAt', activation.activated_at,
    'expiresAt', activation.expires_at,
    'state', activation.state,
    'temporalState', case
      when activation.state = 'revoked' then 'revoked'
      when activation.expires_at <= checked_at then 'expired'
      else 'active'
    end
  )
  into activation_value
  from vortex_access.organization_role_activations as activation
  join vortex_identity.organization_accounts as account
    on account.organization_id = activation.organization_id
    and account.organization_account_id = activation.organization_account_id
  join vortex_access.organization_roles as role
    on role.organization_id = activation.organization_id
    and role.role_id = activation.role_id
  join vortex_access.organization_role_revisions as role_revision
    on role_revision.organization_id = role.organization_id
    and role_revision.role_id = role.role_id
    and role_revision.revision = role.live_revision
  join vortex_access.organization_role_activation_policy_revisions as policy
    on policy.organization_id = activation.organization_id
    and policy.role_id = activation.role_id
    and policy.activation_policy_id = activation.activation_policy_id
    and policy.revision = activation.activation_policy_revision
  where activation.organization_id = scope.organization_id
    and activation.role_activation_id = p_role_activation_id;

  return query select scope.organization_id,
    case when activation_value is null then 'unavailable' else 'available' end,
    activation_value, scope.access_version;
end
$function$;

revoke execute on function
  vortex_access.read_organization_role_activation_for_administration(uuid)
from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

grant execute on function
  vortex_access.read_organization_role_activation_for_administration(uuid)
to vortex_request;

comment on function
  vortex_access.read_organization_role_activation_for_administration(uuid) is
  'Returns one safe exact activation with historical source and policy settings, not current authority.';

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

    application_release := pg_catalog.jsonb_build_object(
      'kind', 'application',
      'definitionKey', application_registration.source_definition_key,
      'rootId', application_registration.registration_owner_id,
      'releaseRevision', application_registration.source_revision,
      'releaseVersion', application_registration.source_version,
      'validationContractVersion', application_registration.validation_contract_version,
      'contentFingerprint', application_registration.source_content_fingerprint,
      'resolutionFingerprint', application_registration.source_resolution_fingerprint
    );

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
      and release.content_fingerprint = application_registration.source_content_fingerprint
      and release.resolution_fingerprint = application_registration.source_resolution_fingerprint
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
        'sourceTemplateFingerprint', selected_continuity.source_template_fingerprint,
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

create or replace function vortex_access.read_organization_role_for_administration(
  p_role_id uuid
)
returns table (
  organization_id uuid,
  outcome text,
  role_summary jsonb,
  access_version bigint
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  scope record;
  role_value jsonb;
begin
  if p_role_id is null
    or p_role_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using errcode = '22023',
      message = 'Organization role detail input is invalid';
  end if;

  select authorized.* into strict scope
  from vortex_access.organization_roles_administration_scope() as authorized;

  select pg_catalog.jsonb_build_object(
    'roleId', role.role_id,
    'key', revision.role_key,
    'label', revision.label,
    'description', revision.description,
    'roleKind', role.role_kind,
    'lifecycle', revision.lifecycle,
    'liveRevision', revision.revision,
    'privilegeClassification', revision.privilege_classification,
    'assignmentPolicy', case revision.assignment_policy
      when 'standing' then pg_catalog.jsonb_build_object('kind', 'standing')
      else pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
        'kind', 'activation_required',
        'maximumActivationDurationSeconds', policy.maximum_activation_duration_seconds,
        'reasonRequired', policy.reason_required,
        'recentAuthentication', case policy.authentication_requirement
          when 'none' then pg_catalog.jsonb_build_object('kind', 'none')
          else pg_catalog.jsonb_build_object(
            'kind', policy.authentication_requirement,
            'maximumAgeSeconds', policy.authentication_maximum_age_seconds
          )
        end,
        'requiredCallerExecutionBindingId', policy.required_caller_execution_binding_id
      ))
    end,
    'source', case role.role_kind
      when 'custom' then pg_catalog.jsonb_build_object('kind', 'custom')
      else pg_catalog.jsonb_build_object(
        'kind', 'application',
        'applicationRootId', role.application_root_id,
        'sourceRoleId', role.source_role_id
      )
    end,
    'acceptedPermissionCount', (
      select pg_catalog.count(*)
      from vortex_access.organization_role_permission_entries as permission
      where permission.organization_id = revision.organization_id
        and permission.role_id = revision.role_id
        and permission.role_revision = revision.revision
    ),
    'acceptedPermissions', (
      select coalesce(
        pg_catalog.jsonb_agg(
          pg_catalog.jsonb_strip_nulls(
            pg_catalog.jsonb_build_object(
              'reference', pg_catalog.jsonb_strip_nulls(
                pg_catalog.jsonb_build_object(
                  'applicationRootId', permission.application_root_id,
                  'ownerKind', permission.owner_kind,
                  'ownerId', permission.owner_id,
                  'permissionId', permission.permission_id
                )
              ),
              'key', catalogue.permission_key,
              'label', catalogue.label,
              'description', catalogue.description,
              'recordTypeId', catalogue.record_type_id,
              'action', pg_catalog.jsonb_strip_nulls(
                pg_catalog.jsonb_build_object(
                  'actionKind', catalogue.action_kind,
                  'namedAction', catalogue.named_action
                )
              ),
              'administrative', catalogue.administrative
            )
          ) order by permission.entry_ordinal
        ),
        '[]'::jsonb
      )
      from vortex_access.organization_role_permission_entries as permission
      join vortex_access.permission_catalogue_entries as catalogue
        on catalogue.organization_id = permission.organization_id
        and catalogue.registration_kind = permission.registration_kind
        and catalogue.registration_owner_id = permission.registration_owner_id
        and catalogue.registration_revision = permission.accepted_registration_revision
        and catalogue.owner_kind = permission.owner_kind
        and catalogue.owner_id = permission.owner_id
        and catalogue.permission_id = permission.permission_id
      where permission.organization_id = revision.organization_id
        and permission.role_id = revision.role_id
        and permission.role_revision = revision.revision
    )
  )
  into role_value
  from vortex_access.organization_roles as role
  join vortex_access.organization_role_revisions as revision
    on revision.organization_id = role.organization_id
    and revision.role_id = role.role_id
    and revision.revision = role.live_revision
  left join vortex_access.organization_role_activation_policy_revisions as policy
    on policy.organization_id = revision.organization_id
    and policy.role_id = revision.role_id
    and policy.activation_policy_id = revision.activation_policy_id
    and policy.revision = revision.activation_policy_revision
  where role.organization_id = scope.organization_id
    and role.role_id = p_role_id;

  return query select scope.organization_id,
    case when role_value is null then 'unavailable' else 'available' end,
    role_value, scope.access_version;
end
$function$;

revoke execute on function
  vortex_access.read_organization_role_for_administration(uuid)
from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

grant execute on function
  vortex_access.read_organization_role_for_administration(uuid)
to vortex_request;

comment on function vortex_access.read_organization_role_for_administration(uuid) is
  'Returns one current local role and its accepted configuration without assignment evidence.';

create or replace function vortex_access.record_share_grant_consent_role_path_internal(
  p_organization_id uuid,
  p_organization_account_id uuid,
  p_application_root_id uuid,
  p_authorized_role_ids uuid[],
  p_checked_at timestamptz,
  p_context_expires_at timestamptz
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $function$
declare
  evidence jsonb;
begin
  if p_organization_id is null
    or p_organization_account_id is null
    or p_application_root_id is null
    or p_authorized_role_ids is null
    or pg_catalog.cardinality(p_authorized_role_ids) not between 1 and 100
    or p_checked_at is null
    or p_context_expires_at is null
    or p_checked_at in ('-infinity'::timestamptz, 'infinity'::timestamptz)
    or p_context_expires_at <= p_checked_at
    or '00000000-0000-0000-0000-000000000000'::uuid = any (p_authorized_role_ids)
    or (select pg_catalog.count(distinct supplied.role_id)
        from pg_catalog.unnest(p_authorized_role_ids) as supplied(role_id))
      <> pg_catalog.cardinality(p_authorized_role_ids) then
    return null;
  end if;

  with current_roles as materialized (
    select role.role_id, revision.assignment_policy,
      revision.authority_continuity_revision,
      revision.policy_continuity_revision,
      revision.activation_policy_id,
      revision.activation_policy_revision
    from vortex_access.organization_roles as role
    join vortex_access.organization_role_revisions as revision
      on revision.organization_id = role.organization_id
      and revision.role_id = role.role_id
      and revision.revision = role.live_revision
    where role.organization_id = p_organization_id
      and role.role_id = any (p_authorized_role_ids)
      and (role.application_root_id is null
        or role.application_root_id = p_application_root_id)
      and (role.derived_application_root_id is null
        or role.derived_application_root_id = p_application_root_id)
      and revision.application_root_id is not distinct from role.application_root_id
      and revision.lifecycle in ('active', 'acceptance_required')
  ), route_candidates as (
    select
      1 as route_rank,
      'direct'::text as path_kind,
      role.role_id,
      assignment.role_assignment_id,
      null::uuid as membership_id,
      null::uuid as role_activation_id,
      least(
        p_context_expires_at,
        coalesce(assignment.expires_at, p_context_expires_at)
      ) as path_valid_until
    from current_roles as role
    join vortex_access.organization_role_assignments as assignment
      on assignment.organization_id = p_organization_id
      and assignment.role_id = role.role_id
      and assignment.assignee_kind = 'organization_account'
      and assignment.organization_account_id = p_organization_account_id
      and assignment.assignment_kind = 'standing'
      and assignment.state = 'live'
      and assignment.starts_at <= p_checked_at
      and (assignment.expires_at is null or assignment.expires_at > p_checked_at)
    where role.assignment_policy = 'standing'

    union all

    select
      2,
      'group',
      role.role_id,
      assignment.role_assignment_id,
      membership.membership_id,
      null::uuid,
      least(
        p_context_expires_at,
        coalesce(assignment.expires_at, p_context_expires_at),
        coalesce(membership.expires_at, p_context_expires_at)
      )
    from current_roles as role
    join vortex_access.organization_role_assignments as assignment
      on assignment.organization_id = p_organization_id
      and assignment.role_id = role.role_id
      and assignment.assignee_kind = 'group'
      and assignment.assignment_kind = 'standing'
      and assignment.state = 'live'
      and assignment.starts_at <= p_checked_at
      and (assignment.expires_at is null or assignment.expires_at > p_checked_at)
    join vortex_access.organization_groups as organization_group
      on organization_group.organization_id = assignment.organization_id
      and organization_group.group_id = assignment.group_id
      and organization_group.state = 'active'
    join vortex_access.organization_group_memberships as membership
      on membership.organization_id = assignment.organization_id
      and membership.group_id = assignment.group_id
      and membership.organization_account_id = p_organization_account_id
      and membership.state = 'live'
      and membership.starts_at <= p_checked_at
      and (membership.expires_at is null or membership.expires_at > p_checked_at)
    where role.assignment_policy = 'standing'

    union all

    select
      3,
      'activated_pim_direct',
      role.role_id,
      assignment.role_assignment_id,
      null::uuid,
      activation.role_activation_id,
      least(
        p_context_expires_at,
        coalesce(assignment.expires_at, p_context_expires_at),
        activation.expires_at
      )
    from current_roles as role
    join vortex_access.organization_role_assignments as assignment
      on assignment.organization_id = p_organization_id
      and assignment.role_id = role.role_id
      and assignment.assignee_kind = 'organization_account'
      and assignment.organization_account_id = p_organization_account_id
      and assignment.assignment_kind = 'eligible'
      and assignment.state = 'live'
      and assignment.starts_at <= p_checked_at
      and (assignment.expires_at is null or assignment.expires_at > p_checked_at)
    join vortex_access.organization_role_activations as activation
      on activation.organization_id = assignment.organization_id
      and activation.organization_account_id = p_organization_account_id
      and activation.role_id = assignment.role_id
      and activation.eligibility_source_kind = 'direct'
      and activation.role_assignment_id = assignment.role_assignment_id
      and activation.role_assignment_revision = assignment.revision
      and activation.state = 'live'
      and activation.activated_at <= p_checked_at
      and activation.expires_at > p_checked_at
      and activation.authority_continuity_revision =
        role.authority_continuity_revision
      and activation.policy_continuity_revision =
        role.policy_continuity_revision
      and activation.activation_policy_id = role.activation_policy_id
      and activation.activation_policy_revision =
        role.activation_policy_revision
    where role.assignment_policy = 'activation_required'

    union all

    select
      4,
      'activated_pim_group',
      role.role_id,
      assignment.role_assignment_id,
      membership.membership_id,
      activation.role_activation_id,
      least(
        p_context_expires_at,
        coalesce(assignment.expires_at, p_context_expires_at),
        coalesce(membership.expires_at, p_context_expires_at),
        activation.expires_at
      )
    from current_roles as role
    join vortex_access.organization_role_assignments as assignment
      on assignment.organization_id = p_organization_id
      and assignment.role_id = role.role_id
      and assignment.assignee_kind = 'group'
      and assignment.assignment_kind = 'eligible'
      and assignment.state = 'live'
      and assignment.starts_at <= p_checked_at
      and (assignment.expires_at is null or assignment.expires_at > p_checked_at)
    join vortex_access.organization_groups as organization_group
      on organization_group.organization_id = assignment.organization_id
      and organization_group.group_id = assignment.group_id
      and organization_group.state = 'active'
    join vortex_access.organization_role_activations as activation
      on activation.organization_id = assignment.organization_id
      and activation.organization_account_id = p_organization_account_id
      and activation.role_id = assignment.role_id
      and activation.eligibility_source_kind = 'group'
      and activation.role_assignment_id = assignment.role_assignment_id
      and activation.role_assignment_revision = assignment.revision
      and activation.state = 'live'
      and activation.activated_at <= p_checked_at
      and activation.expires_at > p_checked_at
      and activation.authority_continuity_revision =
        role.authority_continuity_revision
      and activation.policy_continuity_revision =
        role.policy_continuity_revision
      and activation.activation_policy_id = role.activation_policy_id
      and activation.activation_policy_revision =
        role.activation_policy_revision
    join vortex_access.organization_group_memberships as membership
      on membership.organization_id = assignment.organization_id
      and membership.group_id = assignment.group_id
      and membership.organization_account_id = p_organization_account_id
      and membership.membership_id = activation.membership_id
      and membership.revision = activation.membership_revision
      and membership.state = 'live'
      and membership.starts_at <= p_checked_at
      and (membership.expires_at is null or membership.expires_at > p_checked_at)
    where role.assignment_policy = 'activation_required'
  )
  select pg_catalog.jsonb_build_object(
    'kind', route.path_kind,
    'roleId', route.role_id,
    'roleAssignmentId', route.role_assignment_id,
    'validUntil', pg_catalog.to_char(
      route.path_valid_until at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
    )
  )
    || case when route.membership_id is null then '{}'::jsonb else
      pg_catalog.jsonb_build_object('membershipId', route.membership_id) end
    || case when route.role_activation_id is null then '{}'::jsonb else
      pg_catalog.jsonb_build_object('roleActivationId', route.role_activation_id) end
  into evidence
  from route_candidates as route
  where route.path_valid_until > p_checked_at
  order by route.route_rank, route.role_id, route.role_assignment_id,
    route.membership_id nulls first, route.role_activation_id nulls first
  limit 1;

  return evidence;
end
$function$;

revoke all on function vortex_access.record_share_grant_consent_role_path_internal(
  uuid, uuid, uuid, uuid[], timestamptz, timestamptz
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;
grant execute on function vortex_access.record_share_grant_consent_role_path_internal(
  uuid, uuid, uuid, uuid[], timestamptz, timestamptz
) to postgres;

comment on function vortex_access.record_share_grant_consent_role_path_internal(
  uuid, uuid, uuid, uuid[], timestamptz, timestamptz
) is
  'Private current direct, Group or activated-PIM path for one of the proposal''s exact consent roles; returns bounded path evidence or null.';

create or replace function vortex_access.revise_organization_role_metadata_for_administration(
  p_role_id uuid,
  p_expected_role_revision bigint,
  p_label text,
  p_description text,
  p_activity_id uuid
)
returns table (
  outcome text,
  organization_id uuid,
  role_summary jsonb,
  access_version bigint
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  context_value jsonb;
  context_organization_id uuid;
  context_account_id uuid;
  context_access_version bigint;
  context_correlation_id uuid;
  locked_access_version bigint;
  role_fact vortex_access.organization_roles%rowtype;
  revision_fact vortex_access.organization_role_revisions%rowtype;
  affected_permissions jsonb;
  authority_requirement jsonb;
  decision record;
  changed_summary jsonb;
  operation_at timestamptz;
  activity_result text;
begin
  if p_role_id is null
    or p_role_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_expected_role_revision is null
    or p_expected_role_revision not between 1 and 9007199254740991
    or p_label is null or p_label <> pg_catalog.btrim(p_label)
    or pg_catalog.char_length(p_label) not between 1 and 60
    or p_description is null or p_description <> pg_catalog.btrim(p_description)
    or pg_catalog.char_length(p_description) not between 1 and 1000
    or p_activity_id is null
    or p_activity_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using errcode = '22023',
      message = 'Organization role metadata revision input is invalid';
  end if;

  context_value := vortex_access.validated_human_request_context();
  context_organization_id := (context_value ->> 'organizationId')::uuid;
  context_account_id := (context_value ->> 'organizationAccountId')::uuid;
  context_access_version := (context_value ->> 'accessVersion')::bigint;
  context_correlation_id := (context_value ->> 'correlationId')::uuid;

  select version.current_version into locked_access_version
  from vortex_access.organization_access_versions as version
  join vortex_identity.organizations as organization
    on organization.organization_id = version.organization_id
  join vortex_identity.tenants as tenant
    on tenant.tenant_id = organization.tenant_id
  where version.organization_id = context_organization_id
    and organization.state = 'active'
    and tenant.state = 'active'
  for update of version;
  if not found or locked_access_version is distinct from context_access_version then
    raise exception using errcode = '42501',
      message = 'Organization role metadata revision is unavailable';
  end if;

  select role.* into role_fact
  from vortex_access.organization_roles as role
  where role.organization_id = context_organization_id
    and role.role_id = p_role_id
  for update;
  if not found or role_fact.live_revision <> p_expected_role_revision then
    raise exception using errcode = '40001',
      message = 'Organization role metadata revision is stale or unavailable';
  end if;
  select revision.* into strict revision_fact
  from vortex_access.organization_role_revisions as revision
  where revision.organization_id = context_organization_id
    and revision.role_id = p_role_id
    and revision.revision = role_fact.live_revision;
  if revision_fact.lifecycle = 'retired' then
    raise exception using errcode = '40001',
      message = 'Organization role metadata revision is stale or unavailable';
  end if;

  select pg_catalog.jsonb_agg(
    pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
      'applicationRootId', permission.application_root_id,
      'ownerKind', permission.owner_kind,
      'ownerId', permission.owner_id,
      'permissionId', permission.permission_id
    )) order by permission.application_root_id nulls first,
      permission.owner_kind collate "C", permission.owner_id,
      permission.permission_id
  ) into affected_permissions
  from vortex_access.organization_role_permission_entries as permission
  where permission.organization_id = context_organization_id
    and permission.role_id = p_role_id
    and permission.role_revision = role_fact.live_revision;

  if affected_permissions is null and exists (
    select 1
    from vortex_access.organization_role_assignments as assignment
    where assignment.organization_id = context_organization_id
      and assignment.role_id = p_role_id
      and assignment.state = 'live'
  ) then
    raise exception using errcode = '40001',
      message = 'Organization role retained authority is stale or unavailable';
  end if;

  authority_requirement := case when affected_permissions is null
    then pg_catalog.jsonb_build_object('kind', 'permission')
    else pg_catalog.jsonb_build_object(
      'kind', 'delegated_management',
      'before', pg_catalog.jsonb_build_object(
        'kind', 'bounded', 'permissions', affected_permissions
      ),
      'after', pg_catalog.jsonb_build_object(
        'kind', 'bounded', 'permissions', affected_permissions
      )
    )
  end;

  select evaluated.* into strict decision
  from vortex_access.evaluate_organization_permission_eligibility(
    pg_catalog.jsonb_build_object(
      'operationKey', 'platform.organization.roles.revise_metadata',
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
      'authority', authority_requirement
    )
  ) as evaluated;
  if decision.outcome = 'refused'
    and decision.operation_key = 'platform.organization.roles.revise_metadata'
    and decision.target_kind = 'organization'
    and decision.target_application_root_id is null
    and decision.organization_id = context_organization_id
    and decision.organization_account_id = context_account_id
    and decision.access_version = context_access_version
    and decision.correlation_id = context_correlation_id
    and decision.reason_code in (
      'permission_unavailable', 'permission_not_effective',
      'authentication_unsatisfied', 'delegation_insufficient'
    ) then
    activity_result := vortex_record.append_organization_activity_entry(
      context_organization_id, p_activity_id, decision.checked_at,
      'organization_account', context_account_id, 'revise_role_metadata',
      array[context_organization_id]::uuid[], array[]::uuid[], vortex_platform.channel(),
      context_correlation_id, 'refused'
    );
    if activity_result is distinct from 'inserted' then
      raise exception using errcode = '40001',
        message = 'Organization role metadata revision refusal Activity is stale';
    end if;
    return query select 'refused'::text, context_organization_id,
      null::jsonb, context_access_version;
    return;
  end if;

  if decision.outcome is distinct from 'eligible'
    or decision.operation_key is distinct from 'platform.organization.roles.revise_metadata'
    or decision.target_kind is distinct from 'organization'
    or decision.target_application_root_id is not null
    or decision.organization_id is distinct from context_organization_id
    or decision.organization_account_id is distinct from context_account_id
    or decision.access_version is distinct from context_access_version
    or decision.correlation_id is distinct from context_correlation_id then
    raise exception using errcode = '42501',
      message = 'Organization role metadata revision is unavailable';
  end if;

  if role_fact.live_revision = 9007199254740991 then
    raise exception using errcode = '22003',
      message = 'Organization role revision is exhausted';
  end if;
  if revision_fact.label is not distinct from p_label
    and revision_fact.description is not distinct from p_description then
    raise exception using errcode = '40001',
      message = 'Organization role label and description are unchanged';
  end if;

  -- A label or description edit changes no permission, assignment policy,
  -- lifecycle or source fact, so it appends one revision that carries every
  -- other fact forward and leaves the Access version untouched.
  operation_at := greatest(
    revision_fact.changed_at, pg_catalog.clock_timestamp()
  );
  insert into vortex_access.organization_role_permission_entries (
    organization_id, role_id, role_revision, entry_ordinal, role_kind,
    role_application_root_id, application_root_id, owner_kind, owner_id,
    permission_id, registration_kind, registration_owner_id,
    accepted_registration_revision, catalogue_fingerprint,
    continuity_revision, meaning_fingerprint
  )
  select permission.organization_id, permission.role_id,
    role_fact.live_revision + 1, permission.entry_ordinal, permission.role_kind,
    permission.role_application_root_id, permission.application_root_id,
    permission.owner_kind, permission.owner_id, permission.permission_id,
    permission.registration_kind, permission.registration_owner_id,
    permission.accepted_registration_revision, permission.catalogue_fingerprint,
    permission.continuity_revision, permission.meaning_fingerprint
  from vortex_access.organization_role_permission_entries as permission
  where permission.organization_id = context_organization_id
    and permission.role_id = p_role_id
    and permission.role_revision = role_fact.live_revision
  order by permission.entry_ordinal;

  insert into vortex_access.organization_role_revisions (
    organization_id, role_id, revision, role_kind, application_root_id,
    lifecycle, privilege_classification, assignment_policy,
    policy_continuity_revision, authority_continuity_revision,
    activation_policy_id, activation_policy_revision,
    role_key, label, description,
    source_definition_key, source_release_revision, source_release_version,
    source_validation_contract_version, source_content_fingerprint,
    source_resolution_fingerprint, source_template_fingerprint,
    source_catalogue_fingerprint, accepted_registration_revision,
    template_continuity_revision,
    changed_by, changed_at, change_correlation_id
  ) values (
    context_organization_id, p_role_id, role_fact.live_revision + 1,
    revision_fact.role_kind, revision_fact.application_root_id,
    revision_fact.lifecycle, revision_fact.privilege_classification,
    revision_fact.assignment_policy, revision_fact.policy_continuity_revision,
    revision_fact.authority_continuity_revision,
    revision_fact.activation_policy_id, revision_fact.activation_policy_revision,
    revision_fact.role_key,
    p_label, p_description, revision_fact.source_definition_key,
    revision_fact.source_release_revision, revision_fact.source_release_version,
    revision_fact.source_validation_contract_version,
    revision_fact.source_content_fingerprint,
    revision_fact.source_resolution_fingerprint,
    revision_fact.source_template_fingerprint,
    revision_fact.source_catalogue_fingerprint,
    revision_fact.accepted_registration_revision,
    revision_fact.template_continuity_revision,
    context_account_id, operation_at, context_correlation_id
  );

  update vortex_access.organization_roles as stored
  set live_revision = role_fact.live_revision + 1
  where stored.organization_id = context_organization_id
    and stored.role_id = p_role_id
    and stored.live_revision = p_expected_role_revision;
  if not found then
    raise exception using errcode = '40001',
      message = 'Organization role revision changed concurrently';
  end if;

  changed_summary := vortex_access.project_organization_role_change_summary(
    context_organization_id, p_role_id
  );
  if changed_summary is null then
    raise exception using errcode = '40001',
      message = 'Changed organization role projection is unavailable';
  end if;

  activity_result := vortex_record.append_organization_activity_entry(
    context_organization_id, p_activity_id,
    operation_at,
    'organization_account', context_account_id, 'revise_role_metadata',
    array[p_role_id]::uuid[], array[]::uuid[], vortex_platform.channel(),
    context_correlation_id, 'completed'
  );
  if activity_result is distinct from 'inserted' then
    raise exception using errcode = '40001',
      message = 'Organization role metadata Activity is stale';
  end if;

  return query select 'completed'::text, context_organization_id, changed_summary,
    context_access_version;
end
$function$;

revoke execute on function vortex_access.revise_organization_role_metadata_for_administration(uuid, bigint, text, text, uuid)
from public, anon, authenticated, service_role, vortex_runtime;
grant execute on function vortex_access.revise_organization_role_metadata_for_administration(uuid, bigint, text, text, uuid)
to vortex_request;

comment on function vortex_access.revise_organization_role_metadata_for_administration(uuid, bigint, text, text, uuid) is
  'Standalone request entry: performs a display-only role label and description revision after fixed protected checks without advancing the Access version, records one atomic completed Activity or returns one content-free refused Activity row; no SQL function composes this result.';

CREATE OR REPLACE FUNCTION vortex_access.validate_organization_role_activation_insert() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
declare
  statement_started_at timestamptz := pg_catalog.statement_timestamp();
  validation_time timestamptz := pg_catalog.clock_timestamp();
  role_fact record;
  current_assignment record;
  current_membership record;
begin
  if new.revision <> 1
    or new.state <> 'live'
    or new.activated_at < statement_started_at
    or new.activated_at > validation_time
    or new.expires_at <= validation_time then
    raise exception using errcode = '23514',
      message = 'A new role activation requires a current live revision-one window';
  end if;

  if not exists (
    select 1
    from vortex_identity.organization_accounts as account
    where account.organization_id = new.organization_id
      and account.organization_account_id = new.organization_account_id
      and account.state = 'active'
  ) then
    raise exception using errcode = '23514',
      message = 'A role activation requires an active same-organization account';
  end if;

  select role.live_revision, revision.lifecycle, revision.assignment_policy,
    revision.authority_continuity_revision,
    revision.policy_continuity_revision, revision.activation_policy_id,
    revision.activation_policy_revision,
    policy.maximum_activation_duration_seconds
  into role_fact
  from vortex_access.organization_roles as role
  join vortex_access.organization_role_revisions as revision
    on revision.organization_id = role.organization_id
    and revision.role_id = role.role_id
    and revision.revision = role.live_revision
  join vortex_access.organization_role_activation_policy_revisions as policy
    on policy.organization_id = revision.organization_id
    and policy.role_id = revision.role_id
    and policy.activation_policy_id = revision.activation_policy_id
    and policy.revision = revision.activation_policy_revision
  where role.organization_id = new.organization_id
    and role.role_id = new.role_id;

  if not found
    or role_fact.live_revision <> new.historical_role_revision
    or role_fact.lifecycle not in ('active', 'acceptance_required')
    or role_fact.assignment_policy <> 'activation_required'
    or role_fact.authority_continuity_revision <>
      new.authority_continuity_revision
    or role_fact.policy_continuity_revision <> new.policy_continuity_revision
    or role_fact.activation_policy_id <> new.activation_policy_id
    or role_fact.activation_policy_revision <> new.activation_policy_revision
    or extract(epoch from (new.expires_at - new.activated_at)) >
      role_fact.maximum_activation_duration_seconds then
    raise exception using errcode = '23514',
      message = 'A role activation requires exact current role and policy evidence';
  end if;

  if not exists (
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
    where permission.organization_id = new.organization_id
      and permission.role_id = new.role_id
      and permission.role_revision = new.historical_role_revision
  ) then
    raise exception using errcode = '23514',
      message = 'A role activation requires nonempty current retained authority';
  end if;

  select assignment.role_id, assignment.assignee_kind,
    assignment.organization_account_id, assignment.group_id,
    assignment.assignment_kind, assignment.revision, assignment.starts_at,
    assignment.expires_at, assignment.state
  into current_assignment
  from vortex_access.organization_role_assignments as assignment
  where assignment.organization_id = new.organization_id
    and assignment.role_assignment_id = new.role_assignment_id;

  if not found
    or current_assignment.role_id <> new.role_id
    or current_assignment.assignment_kind <> 'eligible'
    or current_assignment.revision <> new.role_assignment_revision
    or current_assignment.state <> 'live'
    or current_assignment.starts_at > validation_time
    or (
      current_assignment.expires_at is not null
      and current_assignment.expires_at <= validation_time
    )
    or (
      current_assignment.expires_at is not null
      and new.expires_at > current_assignment.expires_at
    ) then
    raise exception using errcode = '23514',
      message = 'A role activation requires exact current eligible assignment evidence';
  end if;

  if new.eligibility_source_kind = 'direct' then
    if current_assignment.assignee_kind <> 'organization_account'
      or current_assignment.organization_account_id <>
        new.organization_account_id then
      raise exception using errcode = '23514',
        message = 'A direct activation requires matching account eligibility';
    end if;
  elsif new.eligibility_source_kind = 'group' then
    if current_assignment.assignee_kind <> 'group' then
      raise exception using errcode = '23514',
        message = 'A Group activation requires Group eligibility';
    end if;

    select membership.group_id, membership.organization_account_id,
      membership.revision, membership.starts_at, membership.expires_at,
      membership.state
    into current_membership
    from vortex_access.organization_group_memberships as membership
    join vortex_access.organization_groups as organization_group
      on organization_group.organization_id = membership.organization_id
      and organization_group.group_id = membership.group_id
      and organization_group.state = 'active'
    where membership.organization_id = new.organization_id
      and membership.membership_id = new.membership_id;

    if not found
      or current_membership.group_id <> current_assignment.group_id
      or current_membership.organization_account_id <>
        new.organization_account_id
      or current_membership.revision <> new.membership_revision
      or current_membership.state <> 'live'
      or current_membership.starts_at > validation_time
      or (
        current_membership.expires_at is not null
        and current_membership.expires_at <= validation_time
      )
      or (
        current_membership.expires_at is not null
        and new.expires_at > current_membership.expires_at
      ) then
      raise exception using errcode = '23514',
        message = 'A Group activation requires exact current membership evidence';
    end if;
  end if;

  return new;
end
$$;

ALTER FUNCTION vortex_access.validate_organization_role_activation_insert() OWNER TO postgres;

REVOKE ALL ON FUNCTION vortex_access.validate_organization_role_activation_insert() FROM PUBLIC;

set local role vortex_owner;

create or replace function vortex_access.validate_organization_role_revision_evidence()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  target_organization_id uuid;
  target_role_id uuid;
  target_role_revision bigint;
  target_role_kind text;
  target_lifecycle text;
  target_privilege_classification text;
  target_assignment_policy text;
  target_policy_continuity_revision bigint;
  target_authority_continuity_revision bigint;
  target_activation_policy_id uuid;
  target_activation_policy_revision bigint;
  target_application_root_id uuid;
  target_catalogue_fingerprint text;
  target_registration_revision bigint;
  previous_lifecycle text;
  previous_assignment_policy text;
  previous_policy_continuity_revision bigint;
  previous_authority_continuity_revision bigint;
  previous_activation_policy_id uuid;
  previous_activation_policy_revision bigint;
  policy_unchanged boolean;
  authority_broadened boolean;
  permission_count bigint;
  administrative_permission_count bigint;
  inconsistent_permission_count bigint;
  inconsistent_source_count bigint;
begin
  target_organization_id := new.organization_id;
  target_role_id := new.role_id;
  target_role_revision := new.revision;

  select revision.role_kind, revision.lifecycle, revision.privilege_classification,
    revision.assignment_policy, revision.policy_continuity_revision,
    revision.authority_continuity_revision, revision.activation_policy_id,
    revision.activation_policy_revision,
    revision.application_root_id, revision.source_catalogue_fingerprint,
    revision.accepted_registration_revision
  into target_role_kind, target_lifecycle, target_privilege_classification,
    target_assignment_policy, target_policy_continuity_revision,
    target_authority_continuity_revision, target_activation_policy_id,
    target_activation_policy_revision,
    target_application_root_id, target_catalogue_fingerprint,
    target_registration_revision
  from vortex_access.organization_role_revisions as revision
  where revision.organization_id = target_organization_id
    and revision.role_id = target_role_id
    and revision.revision = target_role_revision;

  if not found then
    return null;
  end if;

  if target_role_revision = 1 then
    if target_policy_continuity_revision <> 1 then
      raise exception using errcode = '23514',
        message = 'An initial organization role policy continuity revision must be one';
    end if;
    if target_authority_continuity_revision <> 1 then
      raise exception using errcode = '23514',
        message = 'An initial organization role authority continuity revision must be one';
    end if;
  else
    select revision.lifecycle, revision.assignment_policy,
      revision.policy_continuity_revision,
      revision.authority_continuity_revision, revision.activation_policy_id,
      revision.activation_policy_revision
    into previous_lifecycle, previous_assignment_policy,
      previous_policy_continuity_revision,
      previous_authority_continuity_revision, previous_activation_policy_id,
      previous_activation_policy_revision
    from vortex_access.organization_role_revisions as revision
    where revision.organization_id = target_organization_id
      and revision.role_id = target_role_id
      and revision.revision = target_role_revision - 1;

    if not found then
      raise exception using errcode = '23514',
        message = 'An organization role revision requires its immediate predecessor';
    end if;

    policy_unchanged :=
      target_assignment_policy = previous_assignment_policy
      and target_activation_policy_id is not distinct from previous_activation_policy_id
      and target_activation_policy_revision is not distinct
        from previous_activation_policy_revision;

    if policy_unchanged and
      target_policy_continuity_revision <> previous_policy_continuity_revision then
      raise exception using errcode = '23514',
        message = 'Unchanged role policy must preserve policy continuity';
    end if;

    if not policy_unchanged and (
      previous_policy_continuity_revision = 9007199254740991
      or target_policy_continuity_revision <> previous_policy_continuity_revision + 1
    ) then
      raise exception using errcode = '23514',
        message = 'Changed role policy must advance policy continuity exactly once';
    end if;

    select exists (
      select 1
      from vortex_access.organization_role_permission_entries as current_permission
      where current_permission.organization_id = target_organization_id
        and current_permission.role_id = target_role_id
        and current_permission.role_revision = target_role_revision
        and not exists (
          select 1
          from vortex_access.organization_role_permission_entries as previous_permission
          where previous_permission.organization_id = current_permission.organization_id
            and previous_permission.role_id = current_permission.role_id
            and previous_permission.role_revision = target_role_revision - 1
            and previous_permission.application_root_id is not distinct
              from current_permission.application_root_id
            and previous_permission.owner_kind = current_permission.owner_kind
            and previous_permission.owner_id = current_permission.owner_id
            and previous_permission.permission_id = current_permission.permission_id
            and previous_permission.continuity_revision =
              current_permission.continuity_revision
            and previous_permission.meaning_fingerprint =
              current_permission.meaning_fingerprint
        )
    ) into authority_broadened;

    if authority_broadened
      or (
        previous_lifecycle in ('unavailable', 'retired')
        and target_lifecycle in ('active', 'acceptance_required')
      ) then
      if previous_authority_continuity_revision = 9007199254740991
        or target_authority_continuity_revision <>
          previous_authority_continuity_revision + 1 then
        raise exception using errcode = '23514',
          message = 'Broadened or restored role authority must advance continuity exactly once';
      end if;
    elsif target_authority_continuity_revision <>
      previous_authority_continuity_revision then
      raise exception using errcode = '23514',
        message = 'Preserved or narrowed role authority must preserve continuity';
    end if;
  end if;

  select pg_catalog.count(*) into permission_count
  from vortex_access.organization_role_permission_entries as permission
  where permission.organization_id = target_organization_id
    and permission.role_id = target_role_id
    and permission.role_revision = target_role_revision;

  if (target_role_kind = 'custom' or target_lifecycle = 'active')
    and permission_count = 0 then
    raise exception using errcode = '23514',
      message = 'This organization role lifecycle requires accepted permissions';
  end if;

  select pg_catalog.count(*) into inconsistent_source_count
  from vortex_access.organization_role_permission_entries as permission
  join vortex_access.permission_registration_revisions as registration
    on registration.organization_id = permission.organization_id
    and registration.registration_kind = permission.registration_kind
    and registration.registration_owner_id = permission.registration_owner_id
    and registration.revision = permission.accepted_registration_revision
  join vortex_access.permission_catalogue_entries as catalogue
    on catalogue.organization_id = permission.organization_id
    and catalogue.registration_kind = permission.registration_kind
    and catalogue.registration_owner_id = permission.registration_owner_id
    and catalogue.registration_revision = permission.accepted_registration_revision
    and catalogue.owner_kind = permission.owner_kind
    and catalogue.owner_id = permission.owner_id
    and catalogue.permission_id = permission.permission_id
  where permission.organization_id = target_organization_id
    and permission.role_id = target_role_id
    and permission.role_revision = target_role_revision
    and (
      permission.catalogue_fingerprint <> registration.permission_catalogue_fingerprint
      or permission.meaning_fingerprint <> catalogue.meaning_fingerprint
    );

  if inconsistent_source_count <> 0 then
    raise exception using errcode = '23514',
      message = 'Role permissions must retain exact catalogue and meaning evidence';
  end if;

  select pg_catalog.count(*) into administrative_permission_count
  from vortex_access.organization_role_permission_entries as permission
  join vortex_access.permission_catalogue_entries as catalogue
    on catalogue.organization_id = permission.organization_id
    and catalogue.registration_kind = permission.registration_kind
    and catalogue.registration_owner_id = permission.registration_owner_id
    and catalogue.registration_revision = permission.accepted_registration_revision
    and catalogue.owner_kind = permission.owner_kind
    and catalogue.owner_id = permission.owner_id
    and catalogue.permission_id = permission.permission_id
  where permission.organization_id = target_organization_id
    and permission.role_id = target_role_id
    and permission.role_revision = target_role_revision
    and catalogue.administrative;

  if target_privilege_classification = 'standard'
    and administrative_permission_count <> 0 then
    raise exception using errcode = '23514',
      message = 'Administrative permissions require privileged role classification';
  end if;

  if target_role_kind = 'application' then
    select pg_catalog.count(*) into inconsistent_source_count
    from vortex_access.organization_role_revisions as revision
    join vortex_access.permission_registration_revisions as registration
      on registration.organization_id = revision.organization_id
      and registration.registration_kind = revision.source_registration_kind
      and registration.registration_owner_id = revision.application_root_id
      and registration.revision = revision.accepted_registration_revision
    where revision.organization_id = target_organization_id
      and revision.role_id = target_role_id
      and revision.revision = target_role_revision
      and (
        revision.source_definition_key <> registration.source_definition_key
        or revision.source_release_revision <> registration.source_revision
        or revision.source_release_version <> registration.source_version
        or revision.source_validation_contract_version <>
          registration.validation_contract_version
        or revision.source_content_fingerprint <> registration.source_content_fingerprint
        or revision.source_resolution_fingerprint <>
          registration.source_resolution_fingerprint
        or revision.source_catalogue_fingerprint <>
          registration.permission_catalogue_fingerprint
      );

    if inconsistent_source_count <> 0 then
      raise exception using errcode = '23514',
        message = 'Application role source must match exact registration evidence';
    end if;

    select pg_catalog.count(*) into inconsistent_permission_count
    from vortex_access.organization_role_permission_entries as permission
    where permission.organization_id = target_organization_id
      and permission.role_id = target_role_id
      and permission.role_revision = target_role_revision
      and (
        permission.application_root_id is distinct from target_application_root_id
        or permission.accepted_registration_revision <> target_registration_revision
        or permission.catalogue_fingerprint <> target_catalogue_fingerprint
      );

    if inconsistent_permission_count <> 0 then
      raise exception using errcode = '23514',
        message = 'Application role permissions must match accepted registration evidence';
    end if;
  end if;

  return null;
end
$function$;
alter function vortex_access.validate_organization_role_revision_evidence() owner to vortex_owner;


revoke execute on function vortex_access.validate_organization_role_revision_evidence()
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

comment on function vortex_access.validate_organization_role_revision_evidence() is
  'Deferred evidence check of one organisation role revision and its accepted permission entries. Definer, because it fires at commit under the request role, which has no table access.';

alter function vortex_access.validate_organization_role_revision_evidence()
  owner to vortex_owner;

reset role;
