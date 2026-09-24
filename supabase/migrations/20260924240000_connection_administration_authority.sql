-- #842: require a connection-administration permission for connection writers,
-- close the cross-organisation existence disclosure, refuse a null expected
-- revision, record every writer in Activity, and replace direct table SELECT
-- with the scoped readers.
--
-- `vortex_connection.validated_administration_context` accepted any validated
-- member of the organisation: no connection permission was evaluated, so any
-- member's request could register, grant, mark healthy, revoke or reauthorise a
-- connection. It now evaluates the dedicated, versioned
-- `platform.organization.connections.manage` authority through
-- `vortex_access.evaluate_organization_permission_eligibility` for a human
-- caller and returns the same validated context. Governance for a trusted
-- system caller is unchanged.
--
-- The grant, grant-revocation, health-check, instance-revocation and
-- reauthorisation helpers locked the connection row by identifier and only then
-- checked the organisation, and the grant helpers raised different errors for a
-- missing row and a foreign-organisation row. Every writer now validates the
-- administration context before locking, then binds its row lock to the
-- resolved context organisation, so a foreign or missing identifier is
-- indistinguishable.
--
-- `p_expected_revision` was not refused when null: `revision <> null` is null,
-- so the update matched no row and the function silently returned null. Every
-- revision-checked writer now refuses a null or non-JSON-safe expected revision
-- explicitly.
--
-- Only the two grant helpers appended an Activity entry. Registration, health
-- recording, instance revocation and reauthorisation now append one entry each
-- through `append_connection_instance_activity_internal`, retaining the acting
-- organisation account or governed system actor.
--
-- The tables no longer grant direct SELECT to `vortex_request`; the scoped,
-- SECURITY DEFINER `resolve_connection_instance_readiness` and
-- `read_active_connection_evidence` readers are the only read surface. Both now
-- treat a non-finite (`infinity`) token expiry as expired, and the readiness
-- resolver returns the exact stored expiry so the TypeScript caller can refuse
-- an unreadable value.
--
-- Main rewrites several of these functions in place, so every live body is
-- patched from its current `pg_get_functiondef` with an exactly-once guard:
-- ownership, grants, comments and dependencies are untouched, and drift fails
-- the migration instead of silently editing an unexpected body. Each body is
-- re-created under its function's own current owner, as the earlier in-place
-- patches do.

begin;

set local role postgres;

-- The original platform catalogue has 14 permissions at revision 3. Keep its
-- immutable history and publish one additive successor. These fingerprints are
-- SHA-256 of the documented connection permission meaning and of the prior
-- catalogue fingerprint plus the new permission identity and meaning.
create function vortex_access.platform_permission_catalogue_revision_is_exact_v1_2_0(
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
  connection_permission_id constant uuid := 'ec2908a1-f3cd-4c4a-8bf7-91bffbf4cb3d';
  catalogue_fingerprint constant text :=
    'sha256:2fe313d69f53d7ce9247aa0ae05b5cc837872f49285e577f9dc9e1f21f3c842e';
  meaning_fingerprint constant text :=
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
         registration.source_content_fingerprint,
         registration.source_resolution_fingerprint,
         registration.permission_catalogue_fingerprint,
         registration.candidate_fingerprint, registration.changed_at,
         registration.changed_by, registration.change_correlation_id
       ) is not distinct from row(
         history.state, history.source_definition_key,
         history.source_version, history.source_revision,
         history.validation_contract_version,
         history.source_content_fingerprint,
         history.source_resolution_fingerprint,
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
           and entry.meaning_fingerprint = meaning_fingerprint)
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

-- Keep the current checker OID and its callers. The older revisions retain
-- their live bodies; revision 4 delegates to the additive exact checker.
do $patch_catalogue_checker$
declare
  definition text := pg_catalog.replace(
    pg_catalog.pg_get_functiondef(
      'vortex_access.platform_permission_catalogue_revision_is_exact(uuid,bigint)'::pg_catalog.regprocedure
    ), E'\r\n', E'\n'
  );
  old_text constant text := $old$begin
  if p_registration_revision in (1, 2) then$old$;
  new_text constant text := $new$begin
  if p_registration_revision = 4 then
    return vortex_access.platform_permission_catalogue_revision_is_exact_v1_2_0(
      p_organization_id, p_registration_revision
    );
  end if;
  if p_registration_revision in (1, 2) then$new$;
begin
  if definition is null
    or (pg_catalog.length(definition)
      - pg_catalog.length(pg_catalog.replace(definition, old_text, '')))
      / pg_catalog.length(old_text) <> 1 then
    raise exception using errcode = '55000',
      message = 'Platform catalogue checker patch does not match exactly once';
  end if;
  execute pg_catalog.replace(definition, old_text, new_text);
end
$patch_catalogue_checker$;

-- Publish revision 4 without changing the meaning or continuity of the
-- original 14 permissions. Existing privileged custom administrator roles
-- receive a new immutable revision only when they currently hold BOTH
-- runtime-settings and access-assignment administration authority.
create function vortex_access.adopt_connection_administration_permission_catalogue(
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
$function$;

-- Provisioning calls this entry point for every new organisation. Advance
-- through the actual immutable catalogue history before publishing revision 4,
-- so future stewards adopt the dedicated permission with the platform set.
create function vortex_access.initialize_platform_permission_catalogue_v1_2_0(
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
  current_revision bigint;
begin
  if p_organization_id is null
    or p_organization_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_changed_by is null
    or p_changed_by = '00000000-0000-0000-0000-000000000000'::uuid
    or p_correlation_id is null
    or p_correlation_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using errcode = '22023',
      message = 'Platform permission registration input is invalid';
  end if;

  select registration.revision into current_revision
  from vortex_access.permission_registrations as registration
  where registration.organization_id = p_organization_id
    and registration.registration_kind = 'platform'
    and registration.registration_owner_id =
      'cabe121e-0baf-4084-9471-cce915d460a8'::uuid;

  if not found then
    raise exception using errcode = '55000',
      message = 'Platform permission registration evidence is invalid';
  end if;

  if current_revision = 1 then
    perform 1
    from vortex_access.revise_platform_permission_catalogue_metadata(
      p_organization_id, 1, '1.0.0', '1.0.1',
      p_changed_by, p_correlation_id
    );
    current_revision := 2;
  end if;

  if current_revision = 2 then
    perform 1
    from vortex_access.adopt_shipped_platform_permission_catalogue(
      p_organization_id, 2, '1.1.0',
      'sha256:57453282c9a853912b2b67baeefaca81e21d076761d200ac812a7573d7dc7c9c',
      p_changed_by, p_correlation_id
    );
    current_revision := 3;
  end if;

  if current_revision = 3 then
    perform vortex_access.adopt_connection_administration_permission_catalogue(
      p_organization_id, p_changed_by, p_correlation_id
    );
    current_revision := 4;
  end if;

  if current_revision is distinct from 4
    or not vortex_access.platform_permission_catalogue_revision_is_exact(
      p_organization_id, 4
    ) then
    raise exception using errcode = '55000',
      message = 'Platform permission registration evidence is invalid';
  end if;

  return query
  select p_organization_id, 4::bigint, version.current_version
  from vortex_access.organization_access_versions as version
  where version.organization_id = p_organization_id;
end
$function$;

-- Keep the provisioning function's identity and existing caller dependencies.
-- Its original first-publication path still creates revision 1 before the
-- steward exists. Once a registration exists, advance it to revision 4.
do $patch_platform_initializer$
declare
  definition text := pg_catalog.replace(
    pg_catalog.pg_get_functiondef(
      'vortex_access.initialize_platform_permission_catalogue(uuid,uuid,uuid)'::pg_catalog.regprocedure
    ), E'\r\n', E'\n'
  );
  old_text constant text := $old$begin
  if p_organization_id is null$old$;
  new_text constant text := $new$begin
  if exists (
    select 1
    from vortex_access.permission_registrations as registration
    where registration.organization_id = p_organization_id
      and registration.registration_kind = 'platform'
      and registration.registration_owner_id =
        'cabe121e-0baf-4084-9471-cce915d460a8'::uuid
  ) then
    return query
    select initialized.organization_id,
      initialized.registration_revision, initialized.access_version
    from vortex_access.initialize_platform_permission_catalogue_v1_2_0(
      p_organization_id, p_changed_by, p_correlation_id
    ) as initialized;
    return;
  end if;
  if p_organization_id is null$new$;
begin
  if definition is null
    or (pg_catalog.length(definition)
      - pg_catalog.length(pg_catalog.replace(definition, old_text, '')))
      / pg_catalog.length(old_text) <> 1 then
    raise exception using errcode = '55000',
      message = 'Platform catalogue initializer patch does not match exactly once';
  end if;
  execute pg_catalog.replace(definition, old_text, new_text);
end
$patch_platform_initializer$;

revoke all on function
  vortex_access.platform_permission_catalogue_revision_is_exact(uuid, bigint),
  vortex_access.platform_permission_catalogue_revision_is_exact_v1_2_0(uuid, bigint),
  vortex_access.adopt_connection_administration_permission_catalogue(uuid, uuid, uuid),
  vortex_access.initialize_platform_permission_catalogue(uuid, uuid, uuid),
  vortex_access.initialize_platform_permission_catalogue_v1_2_0(uuid, uuid, uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

-- A migration is the publisher of this additive platform catalogue revision.
-- Keep one correlation across its per-organisation upgrades. Inactive
-- organisations advance through the same initializer when reactivated.
do $backfill$
declare
  target record;
begin
  for target in
    select registration.organization_id
    from vortex_access.permission_registrations as registration
    join vortex_identity.organizations as organization
      on organization.organization_id = registration.organization_id
      and organization.state = 'active'
    join vortex_identity.tenants as tenant
      on tenant.tenant_id = organization.tenant_id
      and tenant.state = 'active'
    where registration.registration_kind = 'platform'
      and registration.registration_owner_id =
        'cabe121e-0baf-4084-9471-cce915d460a8'::uuid
    order by registration.organization_id
  loop
    perform 1
    from vortex_access.initialize_platform_permission_catalogue(
      target.organization_id,
      'cabe121e-0baf-4084-9471-cce915d460a8'::uuid,
      '84200000-0000-4000-8000-000000000842'::uuid
    );
  end loop;
end
$backfill$;

create or replace function vortex_connection.assert_connection_administration_authority(
  p_context jsonb
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  decision record;
  operation_value constant text := 'platform.organization.connections.manage';
begin
  select evaluated.* into strict decision
  from vortex_access.evaluate_organization_permission_eligibility(
    pg_catalog.jsonb_build_object(
      'operationKey', operation_value,
      'action', pg_catalog.jsonb_build_object('actionKind', 'manage'),
      'target', pg_catalog.jsonb_build_object('kind', 'organization'),
      'requiredPermission', pg_catalog.jsonb_build_object(
        'ownerKind', 'platform',
        'ownerId', 'cabe121e-0baf-4084-9471-cce915d460a8',
        'permissionId', 'ec2908a1-f3cd-4c4a-8bf7-91bffbf4cb3d'
      ),
      'recentAuthentication', pg_catalog.jsonb_build_object('kind', 'none'),
      'authority', pg_catalog.jsonb_build_object('kind', 'permission')
    )
  ) as evaluated;

  if decision.outcome is distinct from 'eligible'
    or decision.operation_key is distinct from operation_value
    or decision.organization_id is distinct from (p_context ->> 'organizationId')::uuid
    or decision.organization_account_id is distinct from
      (p_context ->> 'organizationAccountId')::uuid
    or decision.access_version is distinct from (p_context ->> 'accessVersion')::bigint
    or decision.correlation_id is distinct from (p_context ->> 'correlationId')::uuid then
    raise exception using
      errcode = '42501',
      message = 'Connection administration is unavailable';
  end if;
exception
  when others then
    raise exception using
      errcode = '42501',
      message = 'Connection administration is unavailable';
end
$function$;

create or replace function vortex_connection.append_connection_instance_activity_internal(
  p_context jsonb,
  p_activity_id uuid,
  p_connection_instance_id uuid,
  p_action text,
  p_occurred_at timestamptz
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  actor_kind text;
  actor_id uuid;
begin
  if p_context ->> 'callerKind' = 'human' then
    actor_kind := 'organization_account';
    actor_id := (p_context ->> 'organizationAccountId')::uuid;
  elsif p_context ->> 'callerKind' = 'system' then
    actor_kind := 'system';
    actor_id := (p_context ->> 'systemActorId')::uuid;
  else
    raise exception using
      errcode = '42501',
      message = 'Connection Activity requires validated human or system context';
  end if;

  perform vortex_activity.append_organization_activity_entry(
    (p_context ->> 'organizationId')::uuid,
    p_activity_id,
    p_occurred_at,
    actor_kind,
    actor_id,
    p_action,
    array[p_connection_instance_id],
    array[]::uuid[],
    'connection',
    (p_context ->> 'correlationId')::uuid,
    'completed'
  );
end
$function$;

revoke all on function
  vortex_connection.assert_connection_administration_authority(jsonb),
  vortex_connection.append_connection_instance_activity_internal(jsonb, uuid, uuid, text, timestamptz)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

reset role;

do $migration$
declare
  targets constant jsonb := pg_catalog.jsonb_build_array(
    -- Administration context: evaluate the connection-administration
    -- permission for a human caller before returning the validated context.
    pg_catalog.jsonb_build_array(
      'vortex_connection.validated_administration_context(uuid)',
      $p$  if ctx_caller_kind = 'human' then
    ctx := vortex_access.validated_human_request_context();
  elsif ctx_caller_kind = 'system' then$p$,
      $p$  if ctx_caller_kind = 'human' then
    ctx := vortex_access.validated_human_request_context();
    perform vortex_connection.assert_connection_administration_authority(ctx);
  elsif ctx_caller_kind = 'system' then$p$
    ),

    -- Registration: capture the validated context and append its Activity.
    pg_catalog.jsonb_build_array(
      'vortex_connection.register_connection_instance_internal(uuid,uuid,uuid,text,text,text,uuid,timestamptz)',
      $p$  nil_uuid constant uuid := '00000000-0000-0000-0000-000000000000'::uuid;
begin
  -- Validate administration context for target organization
  perform vortex_connection.validated_administration_context(p_organization_id);$p$,
      $p$  nil_uuid constant uuid := '00000000-0000-0000-0000-000000000000'::uuid;
  administration_context jsonb;
begin
  -- Validate administration context for target organization
  administration_context := vortex_connection.validated_administration_context(p_organization_id);$p$,
      $p$    p_administrator_activity_id,
    p_token_expires_at,
    operation_at,
    operation_at
  );$p$,
      $p$    p_administrator_activity_id,
    p_token_expires_at,
    operation_at,
    operation_at
  );

  perform vortex_connection.append_connection_instance_activity_internal(
    administration_context,
    p_administrator_activity_id,
    p_connection_instance_id,
    'connection_registered',
    operation_at
  );$p$
    ),

    -- Application grant: validate the context before locking and bind the lock
    -- to the context organisation.
    pg_catalog.jsonb_build_array(
      'vortex_connection.grant_connection_application_internal(uuid,uuid,uuid)',
      $p$  -- Lock connection instance row for share
  select conn.* into conn_row
  from vortex_connection.connection_instances as conn
  where conn.connection_instance_id = p_connection_instance_id
  for share;

  if not found then
    raise exception using
      errcode = 'P0002',
      message = 'Connection instance not found';
  end if;

  -- Validate administration context for connection's organization
  administration_context := vortex_connection.validated_administration_context(conn_row.organization_id);$p$,
      $p$  -- Validate administration context before locking, then bind the lock to the
  -- context organisation so a foreign or missing identifier is indistinguishable.
  administration_context := vortex_connection.validated_administration_context(vortex_context.organization_id());

  select conn.* into conn_row
  from vortex_connection.connection_instances as conn
  where conn.connection_instance_id = p_connection_instance_id
    and conn.organization_id = (administration_context ->> 'organizationId')::uuid
  for share;

  if not found then
    raise exception using
      errcode = 'P0002',
      message = 'Connection instance not found';
  end if;$p$,
      $p$  select root.organization_id, root.kind into app_org_id, app_kind
  from vortex_definition.roots as root
  where root.root_id = p_application_root_id
  for share;

  if not found then
    raise exception using
      errcode = '23503',
      message = 'Referenced application root does not exist';
  end if;$p$,
      $p$  select root.organization_id, root.kind into app_org_id, app_kind
  from vortex_definition.roots as root
  where root.root_id = p_application_root_id
    and root.organization_id = (administration_context ->> 'organizationId')::uuid
  for share;

  if not found then
    raise exception using
      errcode = '23503',
      message = 'Referenced application root is unavailable';
  end if;$p$
    ),

    -- Application grant revocation: same lock ordering.
    pg_catalog.jsonb_build_array(
      'vortex_connection.revoke_connection_application_internal(uuid,uuid,uuid)',
      $p$  select conn.* into conn_row
  from vortex_connection.connection_instances as conn
  where conn.connection_instance_id = p_connection_instance_id
  for share;

  if not found then
    raise exception using
      errcode = 'P0002',
      message = 'Connection instance not found';
  end if;

  administration_context := vortex_connection.validated_administration_context(conn_row.organization_id);$p$,
      $p$  -- Validate administration context before locking, then bind the lock to the
  -- context organisation so a foreign or missing identifier is indistinguishable.
  administration_context := vortex_connection.validated_administration_context(vortex_context.organization_id());

  select conn.* into conn_row
  from vortex_connection.connection_instances as conn
  where conn.connection_instance_id = p_connection_instance_id
    and conn.organization_id = (administration_context ->> 'organizationId')::uuid
  for share;

  if not found then
    raise exception using
      errcode = 'P0002',
      message = 'Connection instance not found';
  end if;$p$
    ),

    -- Health check: refuse a null revision and a missing administrator, validate
    -- the context before locking, bind the lock to the organisation, and append
    -- Activity.
    pg_catalog.jsonb_build_array(
      'vortex_connection.record_connection_health_check_internal(uuid,bigint,text,uuid)',
      $p$  next_state text;
  new_revision bigint;
begin
  if p_new_health_outcome not in ('healthy', 'unhealthy') then$p$,
      $p$  next_state text;
  new_revision bigint;
  administration_context jsonb;
begin
  if p_new_health_outcome not in ('healthy', 'unhealthy') then$p$,
      $p$      message = 'Invalid health outcome: must be healthy or unhealthy';
  end if;

  -- Lock row for update
  select conn.* into conn_row
  from vortex_connection.connection_instances as conn
  where conn.connection_instance_id = p_connection_instance_id
  for update;

  if not found or conn_row.revision <> p_expected_revision then
    raise exception using
      errcode = 'P0002',
      message = 'Connection instance health update failed: revision mismatch or not found';
  end if;

  -- Validate context
  perform vortex_connection.validated_administration_context(conn_row.organization_id);$p$,
      $p$      message = 'Invalid health outcome: must be healthy or unhealthy';
  end if;

  if p_expected_revision is null
    or p_expected_revision not between 1 and 9007199254740991 then
    raise exception using
      errcode = '22023',
      message = 'Connection health update requires a valid expected revision';
  end if;

  if p_administrator_activity_id is null
    or p_administrator_activity_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using
      errcode = '22023',
      message = 'Connection health update requires non-nil administrator activity ID';
  end if;

  -- Validate administration context before locking, then bind the lock to the
  -- context organisation so a foreign or missing identifier is indistinguishable.
  administration_context := vortex_connection.validated_administration_context(vortex_context.organization_id());

  -- Lock row for update
  select conn.* into conn_row
  from vortex_connection.connection_instances as conn
  where conn.connection_instance_id = p_connection_instance_id
    and conn.organization_id = (administration_context ->> 'organizationId')::uuid
  for update;

  if not found or conn_row.revision <> p_expected_revision then
    raise exception using
      errcode = 'P0002',
      message = 'Connection instance health update failed: revision mismatch or not found';
  end if;$p$,
      $p$  update vortex_connection.connection_instances
  set last_health_outcome = p_new_health_outcome,
      state = next_state,
      revision = revision + 1,
      administrator_activity_id = coalesce(p_administrator_activity_id, administrator_activity_id),
      updated_at = operation_at
  where connection_instance_id = p_connection_instance_id
    and revision = p_expected_revision
  returning revision into new_revision;

  return new_revision;$p$,
      $p$  update vortex_connection.connection_instances
  set last_health_outcome = p_new_health_outcome,
      state = next_state,
      revision = revision + 1,
      administrator_activity_id = p_administrator_activity_id,
      updated_at = operation_at
  where connection_instance_id = p_connection_instance_id
    and revision = p_expected_revision
  returning revision into new_revision;

  perform vortex_connection.append_connection_instance_activity_internal(
    administration_context,
    p_administrator_activity_id,
    p_connection_instance_id,
    'connection_health_recorded',
    operation_at
  );

  return new_revision;$p$
    ),

    -- Instance revocation: refuse a null revision, validate before locking, bind
    -- the lock to the organisation, and append Activity.
    pg_catalog.jsonb_build_array(
      'vortex_connection.revoke_connection_instance_internal(uuid,bigint,uuid)',
      $p$  conn_row vortex_connection.connection_instances%rowtype;
  new_revision bigint;
begin
  if p_administrator_activity_id is null or p_administrator_activity_id = nil_uuid then
    raise exception using
      errcode = '22023',
      message = 'Connection revocation requires non-nil administrator activity ID';
  end if;

  select conn.* into conn_row
  from vortex_connection.connection_instances as conn
  where conn.connection_instance_id = p_connection_instance_id
  for update;

  if not found or conn_row.revision <> p_expected_revision then
    raise exception using
      errcode = 'P0002',
      message = 'Connection revocation failed: revision mismatch or not found';
  end if;

  perform vortex_connection.validated_administration_context(conn_row.organization_id);$p$,
      $p$  conn_row vortex_connection.connection_instances%rowtype;
  new_revision bigint;
  administration_context jsonb;
begin
  if p_administrator_activity_id is null or p_administrator_activity_id = nil_uuid then
    raise exception using
      errcode = '22023',
      message = 'Connection revocation requires non-nil administrator activity ID';
  end if;

  if p_expected_revision is null
    or p_expected_revision not between 1 and 9007199254740991 then
    raise exception using
      errcode = '22023',
      message = 'Connection revocation requires a valid expected revision';
  end if;

  -- Validate administration context before locking, then bind the lock to the
  -- context organisation so a foreign or missing identifier is indistinguishable.
  administration_context := vortex_connection.validated_administration_context(vortex_context.organization_id());

  select conn.* into conn_row
  from vortex_connection.connection_instances as conn
  where conn.connection_instance_id = p_connection_instance_id
    and conn.organization_id = (administration_context ->> 'organizationId')::uuid
  for update;

  if not found or conn_row.revision <> p_expected_revision then
    raise exception using
      errcode = 'P0002',
      message = 'Connection revocation failed: revision mismatch or not found';
  end if;$p$,
      $p$  update vortex_connection.connection_instances
  set state = 'revoked',
      administrator_activity_id = p_administrator_activity_id,
      revision = revision + 1,
      updated_at = operation_at
  where connection_instance_id = p_connection_instance_id
    and revision = p_expected_revision
  returning revision into new_revision;

  return new_revision;$p$,
      $p$  update vortex_connection.connection_instances
  set state = 'revoked',
      administrator_activity_id = p_administrator_activity_id,
      revision = revision + 1,
      updated_at = operation_at
  where connection_instance_id = p_connection_instance_id
    and revision = p_expected_revision
  returning revision into new_revision;

  perform vortex_connection.append_connection_instance_activity_internal(
    administration_context,
    p_administrator_activity_id,
    p_connection_instance_id,
    'connection_revoked',
    operation_at
  );

  return new_revision;$p$
    ),

    -- Reauthorisation: refuse a null revision, validate before locking, bind the
    -- lock to the organisation, and append Activity.
    pg_catalog.jsonb_build_array(
      'vortex_connection.reauthorize_connection_instance_internal(uuid,bigint,uuid,text,timestamptz)',
      $p$  conn_row vortex_connection.connection_instances%rowtype;
  new_revision bigint;
begin
  if p_administrator_activity_id is null or p_administrator_activity_id = nil_uuid then
    raise exception using
      errcode = '22023',
      message = 'Connection reauthorization requires non-nil administrator activity ID';
  end if;

  if p_destination_fingerprint is not null and p_destination_fingerprint !~ '^[a-f0-9]{64}$' then
    raise exception using
      errcode = '22023',
      message = 'Invalid destination fingerprint: must be 64 lowercase hex characters';
  end if;

  select conn.* into conn_row
  from vortex_connection.connection_instances as conn
  where conn.connection_instance_id = p_connection_instance_id
  for update;

  if not found or conn_row.revision <> p_expected_revision then
    raise exception using
      errcode = 'P0002',
      message = 'Connection reauthorization failed: revision mismatch or not found';
  end if;

  perform vortex_connection.validated_administration_context(conn_row.organization_id);$p$,
      $p$  conn_row vortex_connection.connection_instances%rowtype;
  new_revision bigint;
  administration_context jsonb;
begin
  if p_administrator_activity_id is null or p_administrator_activity_id = nil_uuid then
    raise exception using
      errcode = '22023',
      message = 'Connection reauthorization requires non-nil administrator activity ID';
  end if;

  if p_expected_revision is null
    or p_expected_revision not between 1 and 9007199254740991 then
    raise exception using
      errcode = '22023',
      message = 'Connection reauthorization requires a valid expected revision';
  end if;

  if p_destination_fingerprint is not null and p_destination_fingerprint !~ '^[a-f0-9]{64}$' then
    raise exception using
      errcode = '22023',
      message = 'Invalid destination fingerprint: must be 64 lowercase hex characters';
  end if;

  -- Validate administration context before locking, then bind the lock to the
  -- context organisation so a foreign or missing identifier is indistinguishable.
  administration_context := vortex_connection.validated_administration_context(vortex_context.organization_id());

  select conn.* into conn_row
  from vortex_connection.connection_instances as conn
  where conn.connection_instance_id = p_connection_instance_id
    and conn.organization_id = (administration_context ->> 'organizationId')::uuid
  for update;

  if not found or conn_row.revision <> p_expected_revision then
    raise exception using
      errcode = 'P0002',
      message = 'Connection reauthorization failed: revision mismatch or not found';
  end if;$p$,
      $p$  update vortex_connection.connection_instances
  set state = 'pending',
      last_health_outcome = 'unknown',
      destination_fingerprint = coalesce(p_destination_fingerprint, destination_fingerprint),
      token_expires_at = p_token_expires_at,
      administrator_activity_id = p_administrator_activity_id,
      revision = revision + 1,
      updated_at = operation_at
  where connection_instance_id = p_connection_instance_id
    and revision = p_expected_revision
  returning revision into new_revision;

  return new_revision;$p$,
      $p$  update vortex_connection.connection_instances
  set state = 'pending',
      last_health_outcome = 'unknown',
      destination_fingerprint = coalesce(p_destination_fingerprint, destination_fingerprint),
      token_expires_at = p_token_expires_at,
      administrator_activity_id = p_administrator_activity_id,
      revision = revision + 1,
      updated_at = operation_at
  where connection_instance_id = p_connection_instance_id
    and revision = p_expected_revision
  returning revision into new_revision;

  perform vortex_connection.append_connection_instance_activity_internal(
    administration_context,
    p_administrator_activity_id,
    p_connection_instance_id,
    'connection_reauthorized',
    operation_at
  );

  return new_revision;$p$
    ),

    -- Provisioning calls the catalogue initializer before the initial steward
    -- exists. Complete the additive catalogue and grant only after that
    -- steward has been adopted, and return its final access version.
    pg_catalog.jsonb_build_array(
      'vortex_access.coordinate_organization_stewardship_adoption(uuid,uuid,uuid,text,text,text,uuid,uuid,uuid,uuid)',
      $p$    select version.current_version into next_access_version
    from vortex_access.organization_access_versions as version
    where version.organization_id = p_organization_id;$p$,
      $p$    select published.access_version into next_access_version
    from vortex_access.initialize_platform_permission_catalogue(
      p_organization_id, p_changed_by, p_correlation_id
    ) as published;$p$,
      $p$  select version.current_version into next_access_version
  from vortex_access.increment_organization_access_version(
    p_organization_id, p_changed_by, p_correlation_id,
    'stewardship_changed'
  ) as version;$p$,
      $p$  perform 1
  from vortex_access.increment_organization_access_version(
    p_organization_id, p_changed_by, p_correlation_id,
    'stewardship_changed'
  ) as version;

  select published.access_version into next_access_version
  from vortex_access.initialize_platform_permission_catalogue(
    p_organization_id, p_changed_by, p_correlation_id
  ) as published;$p$
    ),

    -- Readiness resolver: a non-finite token expiry is expired, and the exact
    -- stored expiry is returned for the TypeScript caller to validate.
    pg_catalog.jsonb_build_array(
      'vortex_connection.resolve_connection_instance_readiness(uuid,uuid,uuid,text,bigint,text)',
      $p$  if conn_row.token_expires_at is not null and conn_row.token_expires_at <= now_ts then$p$,
      $p$  if conn_row.token_expires_at is not null
    and (not pg_catalog.isfinite(conn_row.token_expires_at)
      or conn_row.token_expires_at <= now_ts) then$p$,
      $p$    'healthOutcome', conn_row.last_health_outcome,
    'state', conn_row.state,
    'verifiedAt', pg_catalog.to_jsonb(now_ts)
  );$p$,
      $p$    'healthOutcome', conn_row.last_health_outcome,
    'state', conn_row.state,
    'tokenExpiresAt', pg_catalog.to_jsonb(conn_row.token_expires_at),
    'verifiedAt', pg_catalog.to_jsonb(now_ts)
  );$p$
    ),

    -- Active-evidence reader: a non-finite token expiry is expired.
    pg_catalog.jsonb_build_array(
      'vortex_connection.read_active_connection_evidence(uuid)',
      $p$    and (conn.token_expires_at is null or conn.token_expires_at > pg_catalog.statement_timestamp())$p$,
      $p$    and (conn.token_expires_at is null
      or (pg_catalog.isfinite(conn.token_expires_at)
        and conn.token_expires_at > pg_catalog.statement_timestamp()))$p$
    )
  );

  target jsonb;
  procedure_id pg_catalog.regprocedure;
  patch_index integer;
  old_text text;
  new_text text;
  occurrences integer;
  definition text;
  owner_name name;
begin
  for target in
    select item.value
    from pg_catalog.jsonb_array_elements(targets) as item(value)
  loop
    procedure_id := (target ->> 0)::pg_catalog.regprocedure;
    definition := pg_catalog.pg_get_functiondef(procedure_id);
    if definition is null then
      raise exception using errcode = '55000',
        message = 'Connection administration patch target is unavailable',
        detail = procedure_id::text;
    end if;
    definition := pg_catalog.replace(definition, E'\r\n', E'\n');
    patch_index := 1;
    while patch_index < pg_catalog.jsonb_array_length(target) loop
      old_text := target ->> patch_index;
      new_text := target ->> (patch_index + 1);
      occurrences := (
        pg_catalog.length(definition)
        - pg_catalog.length(pg_catalog.replace(definition, old_text, ''))
      ) / pg_catalog.length(old_text);
      if occurrences <> 1 then
        raise exception using errcode = '55000',
          message = 'Connection administration patch does not match exactly once',
          detail = procedure_id::text;
      end if;
      definition := pg_catalog.replace(definition, old_text, new_text);
      patch_index := patch_index + 2;
    end loop;

    -- Re-created under the function's own current owner so its grants,
    -- comment and OID stay put.
    select pg_catalog.pg_get_userbyid(procedure.proowner) into strict owner_name
    from pg_catalog.pg_proc as procedure
    where procedure.oid = procedure_id;
    execute pg_catalog.format('set local role %I', owner_name);
    execute definition;
    reset role;
  end loop;
end
$migration$;

set local role postgres;
alter function vortex_connection.validated_administration_context(uuid) volatile;
reset role;

-- Direct table SELECT is replaced by the scoped, SECURITY DEFINER readers.
-- Applied as the table owner so the privilege change never depends on the
-- migration role.
set local role postgres;

revoke select on table vortex_connection.connection_instances
  from vortex_request;
revoke select on table vortex_connection.connection_application_grants
  from vortex_request;

drop policy if exists connection_instances_request_read
  on vortex_connection.connection_instances;
drop policy if exists connection_application_grants_request_read
  on vortex_connection.connection_application_grants;

reset role;

commit;
