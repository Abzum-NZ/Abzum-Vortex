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
