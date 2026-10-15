set local role vortex_owner;

alter table vortex_access.application_role_template_continuities
  add column key text,
  add column label text;

-- The existing transition trigger protects registration revisions. Disable it only
-- for the one-time metadata backfill, then restore it in this transaction.
alter table vortex_access.application_role_template_continuities
  disable trigger application_role_template_continuities_protect_change;

update vortex_access.application_role_template_continuities as continuity
set key = template.value ->> 'key',
    label = template.value ->> 'name'
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
where continuity.organization_id = registration.organization_id
  and continuity.application_root_id = registration.registration_owner_id
  and continuity.last_processed_registration_revision = registration.revision
  and continuity.source_role_id = (template.value ->> 'roleId')::uuid
  and registration.registration_kind = 'application'
  and registration.state = 'active'
  and continuity.state = 'available';

alter table vortex_access.application_role_template_continuities
  enable trigger application_role_template_continuities_protect_change;

alter table vortex_access.application_role_template_continuities
  add constraint role_template_available_metadata_present
  check (state <> 'available' or (key is not null and label is not null));

create index role_template_continuity_record_sort_idx
  on vortex_access.application_role_template_continuities
  (organization_id, source_role_id, application_root_id) where state = 'available';

create index role_template_continuity_label_sort_idx
  on vortex_access.application_role_template_continuities
  (organization_id, label collate "C" asc nulls first, source_role_id)
  where state = 'available';

create index role_template_continuity_key_sort_idx
  on vortex_access.application_role_template_continuities
  (organization_id, key collate "C" asc nulls first, source_role_id)
  where state = 'available';
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
        or item.value - array['template', 'sourcePermissions', 'livePermissions']::text[]
          <> '{}'::jsonb
        or not (item.value ?& array['template', 'sourcePermissions', 'livePermissions'])
        or pg_catalog.jsonb_typeof(item.value -> 'template') is distinct from 'object'
        or pg_catalog.jsonb_typeof(item.value -> 'sourcePermissions') is distinct from 'array'
        or pg_catalog.jsonb_typeof(item.value -> 'livePermissions') is distinct from 'array'
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
      select (item.value #>> '{template,roleId}')::uuid as source_role_id
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
      item.value #>> '{template,key}' as role_key,
      item.value #>> '{template,name}' as role_label
    from pg_catalog.jsonb_array_elements(
      case when raw_result.registration_state = 'active'
        then p_prepared_templates -> 'templates'
        else '[]'::jsonb
      end
    ) as item(value)
  ), transition as (
    select continuity.ctid as continuity_row, target.source_role_id as target_role_id,
      target.role_key, target.role_label
    from vortex_access.application_role_template_continuities as continuity
    left join target on target.source_role_id = continuity.source_role_id
    where continuity.organization_id = p_organization_id
      and continuity.application_root_id = p_application_root_id
  )
  update vortex_access.application_role_template_continuities as continuity
  set state = case when transition.target_role_id is null
        then 'unavailable' else 'available' end,
      key = coalesce(transition.role_key, continuity.key),
      label = coalesce(transition.role_label, continuity.label),
      continuity_revision = case
        when transition.target_role_id is not null and continuity.state = 'available'
          then continuity.continuity_revision
        when transition.target_role_id is null and continuity.state = 'unavailable'
          then continuity.continuity_revision
        else continuity.continuity_revision + 1
      end,
      last_processed_registration_revision = raw_result.registration_revision,
      changed_at = pg_catalog.statement_timestamp()
  from transition
  where continuity.ctid = transition.continuity_row;

  if raw_result.registration_state = 'active' then
    insert into vortex_access.application_role_template_continuities (
      organization_id, application_root_id, source_role_id, state,
      continuity_revision, last_processed_registration_revision, changed_at,
      key, label
    )
    select p_organization_id, p_application_root_id,
      (item.value #>> '{template,roleId}')::uuid, 'available', 1,
      raw_result.registration_revision, pg_catalog.statement_timestamp(),
      item.value #>> '{template,key}', item.value #>> '{template,name}'
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
      source_release_version, source_validation_contract_version, accepted_registration_revision,
      template_continuity_revision,
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

COMMENT ON FUNCTION vortex_access.coordinate_application_access_without_stewardship_v1_internal(p_operation text, p_expected_revision bigint, p_prepared_templates jsonb, p_organization_id uuid, p_application_root_id uuid, p_changed_by uuid, p_correlation_id uuid) IS 'Internal application-access implementation retained only behind the stewardship safeguard.';

REVOKE ALL ON FUNCTION vortex_access.coordinate_application_access_without_stewardship_v1_internal(p_operation text, p_expected_revision bigint, p_prepared_templates jsonb, p_organization_id uuid, p_application_root_id uuid, p_changed_by uuid, p_correlation_id uuid) FROM PUBLIC;

alter function vortex_access.coordinate_application_access_without_stewardship_v1_internal(p_operation text, p_expected_revision bigint, p_prepared_templates jsonb, p_organization_id uuid, p_application_root_id uuid, p_changed_by uuid, p_correlation_id uuid) owner to vortex_owner;

grant execute on function vortex_access.coordinate_application_access_without_stewardship_v1_internal(p_operation text, p_expected_revision bigint, p_prepared_templates jsonb, p_organization_id uuid, p_application_root_id uuid, p_changed_by uuid, p_correlation_id uuid) to postgres;

create or replace function vortex_access.list_application_role_templates_projection(
  p_record_ids uuid[], p_sort_key text, p_direction text,
  p_after jsonb, p_limit integer
)
returns table (
  organization_id uuid, record_id uuid, revision bigint, attribute_values jsonb
)
language plpgsql volatile security definer
set search_path = ''
set enable_sort = off
set max_parallel_workers_per_gather = 0
as $function$
declare
  scope_row record;
  candidate record;
  template_value jsonb;
  selected_template jsonb;
  source_role_id_value uuid;
  seen_role_ids uuid[];
  valid_roles boolean;
  after_record_id uuid;
  after_text text;
  emitted integer := 0;
  scan_sql text;
  comparison text;
  sort_column text;
begin
  if p_sort_key not in ('record_id', 'source_role_id', 'application_root_id', 'key', 'label')
    or p_direction not in ('ascending', 'descending')
    or p_sort_key is null or p_direction is null
    or (p_limit is not null and p_limit < 1) then
    raise exception using errcode = '22023',
      message = 'Application role template projection bounds are invalid';
  end if;
  if p_after is not null then
    if pg_catalog.jsonb_typeof(p_after) is distinct from 'object'
      or pg_catalog.jsonb_typeof(p_after -> 'recordId') is distinct from 'string'
      or (p_sort_key in ('source_role_id', 'key', 'label') and (
        pg_catalog.jsonb_typeof(p_after -> 'sortKey') is distinct from 'array'
        or pg_catalog.jsonb_array_length(p_after -> 'sortKey') is distinct from 1
        or pg_catalog.jsonb_typeof(p_after -> 'sortKey' -> 0)
          not in ('string', 'null')
      )) then
      raise exception using errcode = '22023',
        message = 'Application role template projection cursor is invalid';
    end if;
    begin
      after_record_id := (p_after ->> 'recordId')::uuid;
    exception when invalid_text_representation then
      raise exception using errcode = '22023',
        message = 'Application role template projection cursor is invalid';
    end;
    after_text := p_after -> 'sortKey' ->> 0;
    if p_sort_key = 'source_role_id'
      and after_text is distinct from after_record_id::text then
      raise exception using errcode = '22023',
        message = 'Application role template projection cursor is invalid';
    end if;
  end if;

  begin
    select authorized.* into strict scope_row
    from vortex_access.organization_roles_administration_scope() as authorized;
  exception when insufficient_privilege then
    return;
  end;

  comparison := case when p_direction = 'ascending' then '>' else '<' end;
  sort_column := case p_sort_key
    when 'key' then 'continuity.key collate "C"'
    when 'label' then 'continuity.label collate "C"'
    else null end;
  scan_sql := $scan$
    select continuity.application_root_id, continuity.source_role_id,
      continuity.key, continuity.label, continuity.continuity_revision,
      registration.revision as registration_revision,
      release.compilation_output #> '{canonical,content,roles}' as roles
    from vortex_access.application_role_template_continuities as continuity
    join vortex_access.permission_registrations as registration
      on registration.organization_id = continuity.organization_id
      and registration.registration_owner_id = continuity.application_root_id
      and registration.registration_kind = 'application'
      and registration.state = 'active'
      and registration.revision = continuity.last_processed_registration_revision
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
    where continuity.organization_id = $1
      and continuity.state = 'available'
      and ($2 is null or continuity.source_role_id = any($2))
      and release.application_address ->> 'kind' = 'application'
      and release.compilation_output ->> 'kind' = 'application'
      and exists (
        select 1 from vortex_definition.installation_bindings as binding
        where binding.organization_id = $1
          and binding.application_root_id = root.root_id
          and binding.application_release_revision = registration.source_revision
          and binding.state = 'active'
      )
  $scan$;
  if p_after is not null and p_sort_key in ('record_id', 'source_role_id') then
    scan_sql := scan_sql || pg_catalog.format(
      ' and continuity.source_role_id %s $3', comparison
    );
  elsif p_after is not null and sort_column is not null then
    if after_text is null then
      scan_sql := scan_sql || pg_catalog.format(
        ' and ((%1$s is null and continuity.source_role_id %2$s $3)%3$s)',
        sort_column, comparison,
        case when p_direction = 'ascending'
          then pg_catalog.format(' or %s is not null', sort_column)
          else '' end
      );
    else
      scan_sql := scan_sql || pg_catalog.format(
        ' and ((%1$s, continuity.source_role_id) %2$s ($4 collate "C", $3)%3$s)',
        sort_column, comparison,
        case when p_direction = 'descending'
          then pg_catalog.format(' or %s is null', sort_column)
          else '' end
      );
    end if;
  elsif p_after is not null then
    -- Only the delegating old signature uses this order without a cursor.
    raise exception using errcode = '22023',
      message = 'Application role template projection cursor is invalid';
  end if;
  scan_sql := scan_sql || case when p_sort_key in ('record_id', 'source_role_id')
    then pg_catalog.format(' order by continuity.source_role_id %s',
      case when p_direction = 'ascending' then 'asc' else 'desc' end)
    when sort_column is not null then pg_catalog.format(
      ' order by %s %s nulls %s, continuity.source_role_id %s',
      sort_column,
      case when p_direction = 'ascending' then 'asc' else 'desc' end,
      case when p_direction = 'ascending' then 'first' else 'last' end,
      case when p_direction = 'ascending' then 'asc' else 'desc' end)
    else pg_catalog.format(
      ' order by continuity.application_root_id %s, continuity.source_role_id %s',
      case when p_direction = 'ascending' then 'asc' else 'desc' end,
      case when p_direction = 'ascending' then 'asc' else 'desc' end)
    end;
  -- No limit in the scan: a candidate whose release roles fail validation is skipped, as the
  -- legacy reader skipped it, so the loop reads on until the page is full (the scan is an
  -- ordered index walk, so only the rows consumed are read).

  for candidate in execute scan_sql using scope_row.organization_id, p_record_ids,
    after_record_id, after_text, p_limit
  loop
    if pg_catalog.jsonb_typeof(candidate.roles) is distinct from 'array' then
      continue;
    end if;
    if pg_catalog.jsonb_array_length(candidate.roles) not between 1 and 100 then
      continue;
    end if;
    seen_role_ids := array[]::uuid[];
    valid_roles := true;
    selected_template := null;
    -- The entire registered array must be valid even when only one role is read.
    for template_value in
      select template.value
      from pg_catalog.jsonb_array_elements(candidate.roles) as template(value)
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
          candidate.application_root_id, source_role_id_value
        ) then
        valid_roles := false;
        exit;
      end if;
      seen_role_ids := pg_catalog.array_append(seen_role_ids, source_role_id_value);
      if source_role_id_value = candidate.source_role_id then
        selected_template := template_value;
      end if;
    end loop;
    if not valid_roles or selected_template is null then
      continue;
    end if;
    return query select scope_row.organization_id,
      candidate.source_role_id, candidate.registration_revision,
      pg_catalog.jsonb_build_object(
        'application_root_id', candidate.application_root_id,
        'source_role_id', candidate.source_role_id,
        'key', selected_template ->> 'key',
        'label', selected_template ->> 'name',
        'continuity_revision', candidate.continuity_revision
      );
    emitted := emitted + 1;
    exit when p_limit is not null and emitted >= p_limit;
  end loop;
end
$function$;

create or replace function vortex_access.list_application_role_templates_projection(
  p_record_id uuid, p_page_size integer
)
returns table (
  organization_id uuid, record_id uuid, revision bigint, attribute_values jsonb
)
language sql volatile security definer set search_path = ''
as $function$
  select projected.*
  from vortex_access.list_application_role_templates_projection(
    case when p_record_id is null then null else array[p_record_id] end,
    'application_root_id', 'ascending', null, null
  ) as projected
$function$;

revoke all on function vortex_access.list_application_role_templates_projection(uuid, integer)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_access.list_application_role_templates_projection(uuid, integer)
  to vortex_owner, vortex_record_adapter, postgres;
alter function vortex_access.list_application_role_templates_projection(uuid, integer)
  owner to vortex_owner;

revoke all on function vortex_access.list_application_role_templates_projection(
  uuid[], text, text, jsonb, integer
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_access.list_application_role_templates_projection(
  uuid[], text, text, jsonb, integer
) to vortex_owner, vortex_record_adapter, postgres;
alter function vortex_access.list_application_role_templates_projection(
  uuid[], text, text, jsonb, integer
) owner to vortex_owner;

reset role;
