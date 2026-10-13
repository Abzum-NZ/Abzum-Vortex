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

revoke all on function
  vortex_access.platform_permission_catalogue_revision_is_exact(uuid, bigint)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

comment on function vortex_access.platform_permission_catalogue_revision_is_exact(uuid, bigint) is
  'Owner-only fixed evidence assertion for the exact current platform catalogue, its immutable historical predecessors, and required available continuities.';

alter function vortex_access.platform_permission_catalogue_revision_is_exact(p_organization_id uuid, p_registration_revision bigint) owner to vortex_owner;

grant execute on function vortex_access.platform_permission_catalogue_revision_is_exact(p_organization_id uuid, p_registration_revision bigint) to postgres;
