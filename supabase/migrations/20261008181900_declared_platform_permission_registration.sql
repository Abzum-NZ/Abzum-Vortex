begin;

-- Existing postgres owns vortex_access; the Access owner has CREATE for its helper.
set local role vortex_access_owner;

create or replace function vortex_access.lock_platform_permission_declaration_catalogue_internal()
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $function$
begin
  lock table vortex_access.platform_permission_declarations in share mode;
end
$function$;
revoke all on function vortex_access.lock_platform_permission_declaration_catalogue_internal()
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner, vortex_module_owner, vortex_record_adapter;
grant execute on function vortex_access.lock_platform_permission_declaration_catalogue_internal()
  to postgres;
comment on function vortex_access.lock_platform_permission_declaration_catalogue_internal() is
  'Private fixed-scope declaration lock for the owner-only atomic platform permission registration transaction; exposes no rows or caller-selected scope.';
alter function vortex_access.lock_platform_permission_declaration_catalogue_internal()
  owner to vortex_access_owner;

set local role postgres;

create or replace function vortex_access.protect_permission_registration()
returns trigger
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  platform_owner_id constant uuid := 'cabe121e-0baf-4084-9471-cce915d460a8';
  target record;
  target_history vortex_access.permission_registration_revisions%rowtype;
begin
  if tg_op = 'DELETE' then
    raise exception using errcode = '23514', message = 'Permission registrations cannot be deleted';
  end if;
  if tg_op <> 'UPDATE'
    or new.organization_id is distinct from old.organization_id
    or new.registration_kind is distinct from old.registration_kind
    or new.registration_owner_id is distinct from old.registration_owner_id
    or new.changed_at < old.changed_at then
    raise exception using errcode = '23514', message = 'Permission registration updates require one permanent-scope revision';
  end if;

  if new.registration_kind = 'platform' and new.revision >= 7 then
    if new.registration_owner_id is distinct from platform_owner_id
      or old.state is distinct from 'active' or new.state is distinct from 'active'
      or new.revision not between 7 and 9007199254740991
      or new.revision <= old.revision
      or new.source_definition_key is not null
      or new.source_revision is not null
      or new.validation_contract_version is not null
      or new.source_content_fingerprint is not null
      or new.source_resolution_fingerprint is not null then
      raise exception using errcode = '23514', message = 'Permission registration declared target is invalid';
    end if;

    -- R already holds Access then registration locks. This fixed owner capability
    -- also keeps any other protected platform update on a stable declaration set.
    perform vortex_access.lock_platform_permission_declaration_catalogue_internal();
    select pg_catalog.count(*) as entry_count,
      pg_catalog.count(distinct declaration.permission_id) as distinct_permission_ids,
      pg_catalog.count(distinct declaration.permission_key) as distinct_permission_keys,
      pg_catalog.count(distinct declaration.declared_current_revision) as distinct_declared_targets,
      pg_catalog.count(distinct declaration.registration_revision) as distinct_revisions,
      pg_catalog.count(distinct declaration.source_version) as distinct_versions,
      pg_catalog.count(distinct declaration.catalogue_fingerprint) as distinct_fingerprints,
      pg_catalog.min(declaration.declared_current_revision) as declared_current_revision,
      pg_catalog.min(declaration.registration_revision) as registration_revision,
      pg_catalog.min(declaration.source_version) as source_version,
      pg_catalog.min(declaration.catalogue_fingerprint) as catalogue_fingerprint
    into target
    from vortex_access.read_platform_permission_declaration_catalogue_internal(null::bigint) as declaration;
    if target.entry_count = 0
      or target.entry_count <> target.distinct_permission_ids
      or target.entry_count <> target.distinct_permission_keys
      or target.distinct_declared_targets <> 1 or target.distinct_revisions <> 1
      or target.distinct_versions <> 1 or target.distinct_fingerprints <> 1
      or target.declared_current_revision is distinct from new.revision
      or target.registration_revision is distinct from new.revision
      or target.source_version is distinct from new.source_version
      or target.catalogue_fingerprint is distinct from new.permission_catalogue_fingerprint
      or target.catalogue_fingerprint is distinct from new.candidate_fingerprint then
      raise exception using errcode = '23514', message = 'Permission registration declared target is invalid';
    end if;

    select history.* into target_history
    from vortex_access.permission_registration_revisions as history
    where history.organization_id = new.organization_id
      and history.registration_kind = 'platform'
      and history.registration_owner_id = platform_owner_id
      and history.revision = new.revision;
    if not found
      or target_history.operation is distinct from 'platform_metadata_revision'
      or row(target_history.state, target_history.source_definition_key,
        target_history.source_version, target_history.source_revision,
        target_history.validation_contract_version,
        target_history.source_content_fingerprint, target_history.source_resolution_fingerprint,
        target_history.permission_catalogue_fingerprint, target_history.candidate_fingerprint,
        target_history.changed_at, target_history.changed_by, target_history.change_correlation_id)
      is distinct from row(new.state, new.source_definition_key,
        new.source_version, new.source_revision, new.validation_contract_version,
        new.source_content_fingerprint, new.source_resolution_fingerprint,
        new.permission_catalogue_fingerprint, new.candidate_fingerprint,
        new.changed_at, new.changed_by, new.change_correlation_id) then
      raise exception using errcode = '23514', message = 'Permission registration declared target history is invalid';
    end if;
    -- Do not invoke current-only exactness here: the BEFORE UPDATE pointer is OLD.
    -- R validates the complete target entries and continuities after publication.
  elsif new.revision <> old.revision + 1 then
    raise exception using errcode = '23514', message = 'Permission registration updates require one permanent-scope revision';
  end if;
  return new;
end
$function$;

revoke execute on function vortex_access.protect_permission_registration()
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner, vortex_module_owner, vortex_record_adapter;
comment on function vortex_access.protect_permission_registration() is
  'Preserves permanent registration scope and monotonic attribution; Application and historical platform transitions remain consecutive, while fixed-platform declared targets require exact protected target and immutable history evidence.';
alter function vortex_access.protect_permission_registration() owner to postgres;

create or replace function vortex_access.initialize_platform_permission_catalogue(
  p_organization_id uuid,
  p_changed_by uuid,
  p_correlation_id uuid
)
returns table (organization_id uuid, registration_revision bigint, access_version bigint)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  platform_owner_id constant uuid := 'cabe121e-0baf-4084-9471-cce915d460a8';
  current_registration vortex_access.permission_registrations%rowtype;
  registration_exists boolean;
  expected_entries jsonb;
  target record;
  continuity_count bigint;
  predecessor_count bigint;
  transition_count bigint;
  held_access_version bigint;
  resulting_version bigint;
  operation_at timestamptz;
begin
  if p_organization_id is null
    or not vortex_context.is_non_nil_uuid(p_organization_id::text)
    or p_changed_by is null
    or not vortex_context.is_non_nil_uuid(p_changed_by::text)
    or p_correlation_id is null
    or not vortex_context.is_non_nil_uuid(p_correlation_id::text) then
    raise exception using errcode = '22023',
      message = 'Platform permission registration input is invalid';
  end if;

  -- Protected callers supply attribution; request claims do not grant authority.
  select version.current_version into held_access_version
  from vortex_access.organization_access_versions as version
  join vortex_identity.organizations as organization
    on organization.organization_id = version.organization_id
  join vortex_identity.tenants as tenant on tenant.tenant_id = organization.tenant_id
  where version.organization_id = p_organization_id
    and organization.state = 'active' and tenant.state = 'active'
  for update of version;
  if not found then
    raise exception using errcode = '42501',
      message = 'Platform permission registration scope is unavailable';
  end if;

  select registration.* into current_registration
  from vortex_access.permission_registrations as registration
  where registration.organization_id = p_organization_id
    and registration.registration_kind = 'platform'
    and registration.registration_owner_id = platform_owner_id
  for update;
  registration_exists := found;

  -- Access, registration, declarations, then sorted continuities. The fixed
  -- owner capability keeps the declaration set stable to the outer commit.
  perform vortex_access.lock_platform_permission_declaration_catalogue_internal();
  with expected as materialized (
    select declaration.*
    from vortex_access.read_platform_permission_declaration_catalogue_internal(
      null::bigint
    ) as declaration
  )
  select pg_catalog.count(*) as entry_count,
    pg_catalog.count(distinct expected.permission_id) as distinct_permission_ids,
    pg_catalog.count(distinct expected.permission_key) as distinct_permission_keys,
    pg_catalog.count(distinct expected.declared_current_revision) as distinct_targets,
    pg_catalog.count(distinct expected.registration_revision) as distinct_revisions,
    pg_catalog.count(distinct expected.source_version) as distinct_versions,
    pg_catalog.count(distinct expected.catalogue_fingerprint) as distinct_fingerprints,
    pg_catalog.min(expected.declared_current_revision) as declared_current_revision,
    pg_catalog.min(expected.registration_revision) as registration_revision,
    pg_catalog.min(expected.source_version) as source_version,
    pg_catalog.min(expected.catalogue_fingerprint) as catalogue_fingerprint,
    pg_catalog.jsonb_agg(pg_catalog.to_jsonb(expected) order by expected.permission_id)
      as entries
  into target
  from expected;
  if target.entry_count = 0
    or target.entry_count <> target.distinct_permission_ids
    or target.entry_count <> target.distinct_permission_keys
    or target.distinct_targets <> 1 or target.distinct_revisions <> 1
    or target.distinct_versions <> 1 or target.distinct_fingerprints <> 1
    or target.registration_revision not between 7 and 9007199254740991
    or target.declared_current_revision is distinct from target.registration_revision then
    raise exception using errcode = '55000',
      message = 'Platform permission declaration evidence is invalid';
  end if;
  expected_entries := target.entries;

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

  if registration_exists then
    if current_registration.revision > target.registration_revision
      or not vortex_access.platform_permission_catalogue_revision_is_exact(
        p_organization_id, current_registration.revision
      ) then
      raise exception using errcode = '55000',
        message = 'Platform permission registration evidence is invalid';
    end if;
    -- Presentation may evolve; retained identity, action and meaning may not.
    if exists (
      select 1 from vortex_access.permission_catalogue_entries as predecessor
      where predecessor.organization_id = p_organization_id
        and predecessor.registration_kind = 'platform'
        and predecessor.registration_owner_id = platform_owner_id
        and predecessor.registration_revision = current_registration.revision
        and not exists (
          select 1
          from pg_catalog.jsonb_to_recordset(expected_entries) as expected(
            permission_id uuid, permission_key text, action_kind text,
            meaning_fingerprint text
          )
          where expected.permission_id = predecessor.permission_id
            and expected.permission_key = predecessor.permission_key
            and expected.action_kind = predecessor.action_kind
            and expected.meaning_fingerprint = predecessor.meaning_fingerprint
        )
    ) then
      raise exception using errcode = '55000',
        message = 'Platform permission declaration is incompatible';
    end if;
    select pg_catalog.count(*) into predecessor_count
    from vortex_access.permission_catalogue_entries as predecessor
    where predecessor.organization_id = p_organization_id
      and predecessor.registration_kind = 'platform'
      and predecessor.registration_owner_id = platform_owner_id
      and predecessor.registration_revision = current_registration.revision;

    if continuity_count = 0 then
      -- Only the wholly untouched historical pre-adoption phase may lack rows.
      if current_registration.revision not between 1 and 3
        or exists (
          select 1 from vortex_access.organization_stewardship_requirements as requirement
          where requirement.organization_id = p_organization_id
        ) or exists (
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
    elsif continuity_count <> predecessor_count or exists (
      select 1 from vortex_access.permission_continuities as continuity
      where continuity.organization_id = p_organization_id
        and continuity.registration_kind = 'platform'
        and continuity.registration_owner_id = platform_owner_id
        and (
          continuity.application_root_id is not null
          or continuity.owner_kind is distinct from 'platform'
          or continuity.owner_id is distinct from platform_owner_id
          or continuity.state is distinct from 'available'
          or continuity.continuity_revision not between 1 and 9007199254740991
          or continuity.last_processed_registration_revision
            is distinct from current_registration.revision
          or not exists (
            select 1 from vortex_access.permission_catalogue_entries as predecessor
            where predecessor.organization_id = p_organization_id
              and predecessor.registration_kind = 'platform'
              and predecessor.registration_owner_id = platform_owner_id
              and predecessor.registration_revision = current_registration.revision
              and predecessor.permission_id = continuity.permission_id
              and predecessor.meaning_fingerprint = continuity.meaning_fingerprint
          )
        )
    ) then
      raise exception using errcode = '55000',
        message = 'Platform permission continuity evidence is incomplete';
    end if;
    if current_registration.revision = target.registration_revision then
      -- Complete exactness was checked. Replay changes neither data nor attribution.
      if exists (
        select 1 from vortex_access.organization_stewardship_requirements as requirement
        where requirement.organization_id = p_organization_id
      ) then
        perform vortex_access.assert_organization_has_permanent_steward(p_organization_id);
      end if;
      return query select p_organization_id, target.registration_revision, held_access_version;
      return;
    end if;
  elsif continuity_count <> 0 or exists (
    select 1 from vortex_access.permission_registration_revisions as history
    where history.organization_id = p_organization_id
      and history.registration_kind = 'platform'
      and history.registration_owner_id = platform_owner_id
  ) or exists (
    select 1 from vortex_access.permission_catalogue_entries as entry
    where entry.organization_id = p_organization_id
      and entry.registration_kind = 'platform'
      and entry.registration_owner_id = platform_owner_id
  ) then
    raise exception using errcode = '55000',
      message = 'Platform permission registration evidence is invalid';
  end if;

  operation_at := greatest(pg_catalog.clock_timestamp(), current_registration.changed_at);
  insert into vortex_access.permission_registration_revisions (
    organization_id, registration_kind, registration_owner_id, revision,
    state, operation, source_definition_key, source_version,
    source_revision, validation_contract_version, source_content_fingerprint,
    source_resolution_fingerprint, permission_catalogue_fingerprint,
    candidate_fingerprint, changed_at, changed_by, change_correlation_id
  ) values (
    p_organization_id, 'platform', platform_owner_id, target.registration_revision,
    'active', case when registration_exists then 'platform_metadata_revision'
      else 'platform_initialize' end, null, target.source_version,
    null, null, null, null, target.catalogue_fingerprint,
    target.catalogue_fingerprint, operation_at, p_changed_by, p_correlation_id
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
  select p_organization_id, 'platform', platform_owner_id,
    target.registration_revision, null, 'platform', platform_owner_id,
    expected.permission_id, expected.permission_key, expected.label,
    expected.description, null, expected.action_kind, null, true,
    'platform_catalogue', null, null, target.source_version, null,
    null, null, null, target.catalogue_fingerprint,
    expected.meaning_fingerprint, null, null
  from pg_catalog.jsonb_to_recordset(expected_entries) as expected(
    permission_id uuid, permission_key text, label text, description text,
    action_kind text, meaning_fingerprint text
  )
  order by expected.permission_id;
  get diagnostics transition_count = row_count;
  if transition_count <> target.entry_count then
    raise exception using errcode = '55000',
      message = 'Platform permission catalogue publication is incomplete';
  end if;

  if registration_exists then
    -- The BEFORE UPDATE guard checks this already inserted target history.
    update vortex_access.permission_registrations as registration
    set revision = target.registration_revision, source_version = target.source_version,
      permission_catalogue_fingerprint = target.catalogue_fingerprint,
      candidate_fingerprint = target.catalogue_fingerprint,
      changed_at = operation_at, changed_by = p_changed_by,
      change_correlation_id = p_correlation_id
    where registration.organization_id = p_organization_id
      and registration.registration_kind = 'platform'
      and registration.registration_owner_id = platform_owner_id
      and registration.revision = current_registration.revision;
    get diagnostics transition_count = row_count;
    if transition_count <> 1 then
      raise exception using errcode = '40001',
        message = 'Platform permission registration changed concurrently';
    end if;
  else
    insert into vortex_access.permission_registrations (
      organization_id, registration_kind, registration_owner_id, revision, state,
      source_definition_key, source_version, source_revision,
      validation_contract_version, source_content_fingerprint,
      source_resolution_fingerprint, permission_catalogue_fingerprint,
      candidate_fingerprint, changed_at, changed_by, change_correlation_id
    ) values (
      p_organization_id, 'platform', platform_owner_id, target.registration_revision,
      'active', null, target.source_version, null, null, null, null,
      target.catalogue_fingerprint, target.catalogue_fingerprint,
      operation_at, p_changed_by, p_correlation_id
    );
  end if;

  update vortex_access.permission_continuities as continuity
  set last_processed_registration_revision = target.registration_revision,
    changed_at = greatest(continuity.changed_at, operation_at)
  where continuity.organization_id = p_organization_id
    and continuity.registration_kind = 'platform'
    and continuity.registration_owner_id = platform_owner_id;
  get diagnostics transition_count = row_count;
  if transition_count <> continuity_count then
    raise exception using errcode = '40001',
      message = 'Platform permission continuity changed concurrently';
  end if;
  insert into vortex_access.permission_continuities (
    organization_id, application_root_id, owner_kind, owner_id,
    permission_id, registration_kind, registration_owner_id, state,
    continuity_revision, meaning_fingerprint,
    last_processed_registration_revision, changed_at
  )
  select p_organization_id, null, 'platform', platform_owner_id,
    expected.permission_id, 'platform', platform_owner_id, 'available',
    1, expected.meaning_fingerprint, target.registration_revision, operation_at
  from pg_catalog.jsonb_to_recordset(expected_entries) as expected(
    permission_id uuid, meaning_fingerprint text
  )
  where not exists (
    select 1 from vortex_access.permission_continuities as continuity
    where continuity.organization_id = p_organization_id
      and continuity.registration_kind = 'platform'
      and continuity.registration_owner_id = platform_owner_id
      and continuity.permission_id = expected.permission_id
  )
  order by expected.permission_id;
  get diagnostics transition_count = row_count;
  if transition_count <> target.entry_count - continuity_count
    or not vortex_access.platform_permission_catalogue_revision_is_exact(
      p_organization_id, target.registration_revision
    ) then
    raise exception using errcode = '55000',
      message = 'Platform permission publication evidence is incomplete';
  end if;
  if exists (
    select 1 from vortex_access.organization_stewardship_requirements as requirement
    where requirement.organization_id = p_organization_id
  ) then
    perform vortex_access.assert_organization_has_permanent_steward(p_organization_id);
  end if;
  select incremented.current_version into strict resulting_version
  from vortex_access.increment_organization_access_version(
    p_organization_id, p_changed_by, p_correlation_id, 'application_access_changed'
  ) as incremented;
  if resulting_version is distinct from held_access_version + 1 then
    raise exception using errcode = '40001',
      message = 'Platform permission registration Access version is stale';
  end if;
  return query select p_organization_id, target.registration_revision, resulting_version;
end
$function$;

revoke all on function vortex_access.initialize_platform_permission_catalogue(uuid, uuid, uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
comment on function vortex_access.initialize_platform_permission_catalogue(uuid, uuid, uuid) is
  'Owner-only atomic publication of the complete current declared platform permission catalogue; preserves compatible continuity and immutable history, never grants roles, and leaves exact replay unchanged.';
alter function vortex_access.initialize_platform_permission_catalogue(uuid, uuid, uuid)
  owner to postgres;

reset role;
commit;
