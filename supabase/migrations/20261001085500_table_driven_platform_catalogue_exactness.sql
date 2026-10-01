begin;

set local role vortex_access_owner;

create or replace function vortex_access.read_platform_permission_declaration_catalogue_internal(
  p_registration_revision bigint
)
returns table (
  declared_current_revision bigint,
  registration_revision bigint,
  source_version text,
  catalogue_fingerprint text,
  permission_id uuid,
  permission_key text,
  action_kind text,
  label text,
  description text,
  meaning_fingerprint text,
  steward_minimum boolean,
  first_revision bigint
)
language sql
stable
security definer
set search_path = ''
as $function$
with declaration_head as (
  select greatest(
    7::bigint,
    coalesce(pg_catalog.max(declaration.first_revision), 7::bigint)
  ) as declared_current_revision
  from vortex_access.platform_permission_declarations as declaration
  where declaration.owner_kind = 'platform'
    and declaration.owner_id = 'cabe121e-0baf-4084-9471-cce915d460a8'::uuid
),
target as (
  select
    declaration_head.declared_current_revision,
    coalesce(p_registration_revision, declaration_head.declared_current_revision)
      as registration_revision
  from declaration_head
),
selected as (
  select
    target.declared_current_revision,
    target.registration_revision,
    case target.registration_revision
      when 1 then '1.0.0'
      when 2 then '1.0.1'
      when 3 then '1.1.0'
      when 4 then '1.2.0'
      when 5 then '1.3.0'
      when 6 then '1.4.0'
      else case
        when target.registration_revision between 7 and 9007199254740991
          then '1.' || (target.registration_revision - 3)::text || '.0'
        else null
      end
    end as source_version,
    case target.registration_revision
      when 1 then 'sha256:a6c3e01332980bc030d1492608853b8905c34fa661682e90ae5fcb23287c4930'
      when 2 then 'sha256:94733e5bba0c59d8b81693c78711b34f87bc7ff82c68f705d343cdacda990058'
      when 3 then 'sha256:57453282c9a853912b2b67baeefaca81e21d076761d200ac812a7573d7dc7c9c'
      when 4 then 'sha256:2fe313d69f53d7ce9247aa0ae05b5cc837872f49285e577f9dc9e1f21f3c842e'
      when 5 then 'sha256:a434c97c26cd25dfce1e95b83f0dbfe5c5b6de739b35b2729d7f4306bc62285a'
      when 6 then 'sha256:1e5cceb04465d940f163ec926af7423efc9b37788551b00766d768fe9089195b'
      else null
    end as historical_fingerprint,
    target.registration_revision between 1 and 9007199254740991
      and (
        target.registration_revision <= 7
        or exists (
          select 1
          from vortex_access.platform_permission_declarations as declared_release
          where declared_release.owner_kind = 'platform'
            and declared_release.owner_id = 'cabe121e-0baf-4084-9471-cce915d460a8'::uuid
            and declared_release.first_revision = target.registration_revision
        )
      ) as supported
  from target
),
expected as materialized (
  select
    selected.declared_current_revision,
    selected.registration_revision,
    selected.source_version,
    selected.historical_fingerprint,
    declaration.permission_id,
    declaration.permission_key,
    declaration.action_kind,
    case
      when selected.registration_revision = 1
        and declaration.permission_id = '290ae49f-4cab-4159-9c20-6e664f07d50b'::uuid
        then 'View teams'
      when selected.registration_revision = 1
        and declaration.permission_id = '6185dc64-464b-4776-97dc-c64a6f299550'::uuid
        then 'Manage teams'
      else declaration.label
    end as label,
    case
      when selected.registration_revision = 1
        and declaration.permission_id = '290ae49f-4cab-4159-9c20-6e664f07d50b'::uuid
        then 'View the selected organisation''s Teams and membership administration data.'
      when selected.registration_revision = 1
        and declaration.permission_id = '6185dc64-464b-4776-97dc-c64a6f299550'::uuid
        then 'Manage Teams and memberships subject to delegated scope and permanent-steward safeguards.'
      else declaration.description
    end as description,
    declaration.meaning_fingerprint,
    declaration.steward_minimum,
    declaration.first_revision
  from selected
  join vortex_access.platform_permission_declarations as declaration
    on declaration.owner_kind = 'platform'
    and declaration.owner_id = 'cabe121e-0baf-4084-9471-cce915d460a8'::uuid
    and declaration.first_revision <= selected.registration_revision
  where selected.supported
),
expected_stats as (
  select
    pg_catalog.count(*) as entry_count,
    pg_catalog.count(distinct expected.permission_id) as distinct_permission_ids,
    pg_catalog.count(distinct expected.permission_key) as distinct_permission_keys,
    pg_catalog.count(*) filter (where expected.action_kind = 'named') as named_action_count
  from expected
),
frames as (
  select
    expected.permission_key,
    expected.permission_id,
    pg_catalog.string_agg(
      case
        when field.value is null then 'N;'
        else 'S'
          || pg_catalog.octet_length(pg_catalog.convert_to(field.value, 'UTF8'))::text
          || ':' || field.value || ';'
      end,
      '' order by field.ordinality
    ) as framed_entry
  from expected
  cross join lateral pg_catalog.unnest(array[
    null::text,
    'platform'::text,
    'cabe121e-0baf-4084-9471-cce915d460a8'::uuid::text,
    expected.permission_id::text,
    expected.permission_key,
    expected.label,
    expected.description,
    null::text,
    null::text,
    null::text,
    expected.action_kind,
    null::text,
    'true'::text,
    'platform_catalogue'::text,
    null::text,
    null::text,
    expected.source_version,
    null::text,
    null::text,
    null::text,
    null::text,
    expected.meaning_fingerprint
  ]) with ordinality as field(value, ordinality)
  group by expected.permission_key, expected.permission_id
),
fingerprint as (
  select
    'sha256:' || pg_catalog.encode(
      pg_catalog.sha256(
        pg_catalog.convert_to(
          'vortex.platform-permission-catalogue/v1' || pg_catalog.chr(10)
          || 'S8:platform;'
          || 'S36:cabe121e-0baf-4084-9471-cce915d460a8;'
          || 'S' || pg_catalog.octet_length(
            pg_catalog.convert_to(selected.source_version, 'UTF8')
          )::text || ':' || selected.source_version || ';'
          || 'S' || pg_catalog.octet_length(
            pg_catalog.convert_to(expected_stats.entry_count::text, 'UTF8')
          )::text || ':' || expected_stats.entry_count::text || ';'
          || coalesce(
            pg_catalog.string_agg(
              frames.framed_entry,
              '' order by frames.permission_key collate "C", frames.permission_id
            ),
            ''
          ),
          'UTF8'
        )
      ),
      'hex'
    ) as computed_fingerprint
  from selected
  cross join expected_stats
  left join frames on true
  group by selected.source_version, expected_stats.entry_count
),
valid as (
  select
    selected.declared_current_revision,
    selected.registration_revision,
    selected.source_version,
    coalesce(
      selected.supported
      and expected_stats.entry_count > 0
      and expected_stats.entry_count = expected_stats.distinct_permission_ids
      and expected_stats.entry_count = expected_stats.distinct_permission_keys
      and expected_stats.named_action_count = 0
      and (
        selected.registration_revision > 6
        or expected_stats.entry_count = case selected.registration_revision
          when 1 then 13
          when 2 then 13
          when 3 then 14
          when 4 then 15
          when 5 then 18
          when 6 then 22
        end
      ),
      false
    ) as expected_set_valid,
    case
      when selected.registration_revision <= 6
        then selected.historical_fingerprint
      else fingerprint.computed_fingerprint
    end as catalogue_fingerprint
  from selected
  cross join expected_stats
  cross join fingerprint
)
select
  valid.declared_current_revision,
  valid.registration_revision,
  valid.source_version,
  valid.catalogue_fingerprint,
  expected.permission_id,
  expected.permission_key,
  expected.action_kind,
  expected.label,
  expected.description,
  expected.meaning_fingerprint,
  expected.steward_minimum,
  expected.first_revision
from valid
join expected on true
where valid.expected_set_valid
$function$;

revoke all on function vortex_access.read_platform_permission_declaration_catalogue_internal(bigint)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner, vortex_module_owner, vortex_record_adapter;
grant execute on function vortex_access.read_platform_permission_declaration_catalogue_internal(bigint)
  to postgres;
comment on function vortex_access.read_platform_permission_declaration_catalogue_internal(bigint) is
  'Returns the complete trusted platform permission declaration catalogue for a supported registration revision only to the authorized postgres caller.';
alter function vortex_access.read_platform_permission_declaration_catalogue_internal(bigint)
  owner to vortex_access_owner;

reset role;

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
        and registration.source_content_fingerprint is null
        and registration.source_resolution_fingerprint is null
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
        and history.source_content_fingerprint is null
        and history.source_resolution_fingerprint is null
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
          registration.source_content_fingerprint,
          registration.source_resolution_fingerprint,
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
          history.source_content_fingerprint,
          history.source_resolution_fingerprint,
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

commit;
