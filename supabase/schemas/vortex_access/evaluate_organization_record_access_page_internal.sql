create or replace function vortex_access.evaluate_organization_record_access_page_internal(
  p_rows jsonb,
  p_jobs jsonb,
  p_envelope jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  jobs jsonb := p_jobs;
  context_value jsonb;
  checked_at timestamptz;
  decisions jsonb;
  -- The page-wide facts every compact row shares (the page envelope's facts).
  envelope_facts jsonb := p_envelope -> 'facts';
begin
  if pg_catalog.jsonb_typeof(p_rows) is distinct from 'array'
    or pg_catalog.jsonb_array_length(p_rows) > 200
    or pg_catalog.jsonb_typeof(jobs) is distinct from 'array'
    or pg_catalog.jsonb_array_length(jobs) > 600
    or (p_envelope is not null and (pg_catalog.jsonb_typeof(p_envelope -> 'declaration') is distinct from 'object'
      or pg_catalog.jsonb_typeof(envelope_facts) is distinct from 'object')) then
    raise exception using errcode = '22023', message = 'Page access jobs are invalid';
  end if;
  if exists (
    select 1
    from pg_catalog.jsonb_array_elements(jobs) as job(value)
    where pg_catalog.jsonb_typeof(job.value) is distinct from 'object'
      or not (job.value ?& array['rowIndex', 'actionKind', 'requiredPermissions'])
      or pg_catalog.jsonb_typeof(job.value -> 'rowIndex') is distinct from 'number'
      or (job.value ->> 'rowIndex') !~ '^[1-9][0-9]*$'
      or (job.value ->> 'rowIndex')::integer > pg_catalog.jsonb_array_length(p_rows)
      or job.value ->> 'actionKind' not in ('update', 'delete', 'restore')
      or pg_catalog.jsonb_typeof(job.value -> 'requiredPermissions') is distinct from 'array'
  ) or (p_envelope is null and exists (
    select 1 from pg_catalog.jsonb_array_elements(p_rows) as row_item(value)
    where pg_catalog.jsonb_typeof(row_item.value) = 'object'
      and row_item.value ? 'record' and not (row_item.value ? 'readFacts')
  )) then
    raise exception using errcode = '22023', message = 'Page access jobs are invalid';
  end if;
  if jobs = '[]'::jsonb then
    return jobs;
  end if;
  context_value := vortex_access.validated_human_request_context();
  checked_at := pg_catalog.clock_timestamp();
    -- Each declaration is eligible once for the page. Every record still
    -- receives the exact row-scope, ownership, group and share decision. A
    -- compact row (from the page read pass) carries only its own record fact;
    -- its page-wide facts are the one page envelope's, never copied per job.
    with page_rows as materialized (
      select row_item.ordinality::integer as row_index,
        (row_item.value ->> 'recordId')::uuid as record_id,
        row_item.value ? 'record' and not (row_item.value ? 'readFacts') as is_compact,
        row_item.value -> 'readFacts' -> 'declaration' as own_declaration,
        row_item.value -> 'readFacts' -> 'facts' as own_facts,
        row_item.value -> 'record' -> 'record' as own_record
      from pg_catalog.jsonb_array_elements(p_rows) with ordinality as row_item(value, ordinality)
    ),
    page_jobs as materialized (
      select (job.value ->> 'rowIndex')::integer as row_index,
        job.value ->> 'actionKind' as action_kind,
        job.value -> 'requiredPermissions' as required_permissions
      from pg_catalog.jsonb_array_elements(jobs) as job(value)
    ),
    entries as materialized (
      select job.row_index, job.action_kind, page_row.record_id, page_row.is_compact,
        (case when page_row.is_compact then p_envelope -> 'declaration'
          else page_row.own_declaration end)
          || pg_catalog.jsonb_build_object(
            'operationKey', 'record.' || job.action_kind,
            'action', pg_catalog.jsonb_build_object('actionKind', job.action_kind),
            'requiredPermissions', job.required_permissions
          ) as declaration,
        case when not page_row.is_compact then page_row.own_facts end as facts,
        case when page_row.is_compact then page_row.own_record end as own_record
      from page_jobs as job
      join page_rows as page_row on page_row.row_index = job.row_index
    ),
    declarations as materialized (
      select distinct entry.declaration from entries as entry
    ),
    eligible as materialized (
      select declaration,
        vortex_access.evaluate_organization_record_permission_eligibility_internal(
          declaration, context_value, checked_at
        ) as value
      from declarations
    ),
    assessed as (
      select entry.row_index, entry.action_kind, entry.record_id, entry.is_compact,
        entry.declaration, entry.facts, entry.own_record, eligible.value as eligibility,
        target.value as target_record,
        target.value is not null
          and (target.value -> 'recordScope' ->> 'organizationId')::uuid
            = (context_value ->> 'organizationId')::uuid
          and pg_catalog.lower(target.value -> 'recordScope' ->> 'moduleRootId')
            = pg_catalog.lower(coalesce(entry.facts, envelope_facts) -> 'binding' ->> 'moduleRootId')
          and pg_catalog.lower(target.value -> 'recordScope' ->> 'recordTypeId')
            = pg_catalog.lower(coalesce(entry.facts, envelope_facts) -> 'binding' ->> 'recordTypeId')
          and pg_catalog.lower(target.value -> 'recordScope' ->> 'storageContractId')
            = pg_catalog.lower(coalesce(entry.facts, envelope_facts) -> 'binding' ->> 'storageContractId')
          and target.value -> 'recordScope' ->> 'storageScope'
            = coalesce(entry.facts, envelope_facts) -> 'binding' ->> 'storageScope'
          and (
            coalesce(entry.facts, envelope_facts) -> 'binding' ->> 'storageScope' = 'organization_shared'
            or (target.value -> 'recordScope' ->> 'applicationRootId')::uuid
              = (entry.declaration -> 'target' ->> 'applicationRootId')::uuid
          )
          and target.value ->> 'lifecycleState' = 'active' as target_ok
      from entries as entry
      join eligible on eligible.declaration = entry.declaration
      left join lateral (
        select item.value
        from pg_catalog.jsonb_array_elements(
          case when entry.is_compact then pg_catalog.jsonb_build_array(entry.own_record)
            else entry.facts -> 'records' end
        ) as item(value)
        where (item.value -> 'recordScope' ->> 'recordId')::uuid = entry.record_id
        limit 1
      ) as target on true
    ),
    -- Records whose routes all have an exact set form are decided together,
    -- per declaration, in one pass; the rest keep the composition below.
    -- Eligibility is a function of the declaration; the record types are
    -- grouped by their text so equal sets are compared once, not sorted.
    grouped as materialized (
      select assessed.declaration,
        (pg_catalog.array_agg(assessed.eligibility))[1] as eligibility,
        (pg_catalog.array_agg(coalesce(assessed.facts, envelope_facts) -> 'recordTypes'))[1] as record_types,
        pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(assessed.row_index, assessed.action_kind)
          order by assessed.row_index, assessed.action_kind) as keys,
        pg_catalog.jsonb_agg(coalesce(assessed.target_record, 'null'::jsonb)
          order by assessed.row_index, assessed.action_kind) as records
      from assessed
      -- Compact rows share the envelope's record types: one group per declaration.
      group by assessed.declaration, assessed.is_compact,
        (case when not assessed.is_compact then (assessed.facts -> 'recordTypes')::text end)
    ),
    decided as materialized (
      select (grouped.keys -> (set_decision.ordinality::integer - 1) ->> 0)::integer as row_index,
        grouped.keys -> (set_decision.ordinality::integer - 1) ->> 1 as action_kind,
        set_decision.value as decision
      from grouped
      cross join lateral pg_catalog.jsonb_array_elements(
        vortex_access.decide_record_page_scope_internal(
          context_value, checked_at, grouped.declaration, grouped.eligibility,
          grouped.record_types, grouped.records, false
        )
      ) with ordinality as set_decision(value, ordinality)
      where set_decision.value <> 'null'::jsonb
    ),
    scoped as (
      select assessed.*, decided.decision as set_decision,
        case when decided.decision is null
          and assessed.eligibility ->> 'outcome' = 'eligible'
          and assessed.target_ok then (
            select coalesce(pg_catalog.jsonb_agg(
              contribution.value order by
                alt.ordinality,
                case contribution.value -> 'route' ->> 'kind'
                  when 'all_records' then 0
                  when 'ownership' then 1
                  when 'direct_share' then 2
                  when 'relationship' then 3
                end,
                coalesce(
                  contribution.value -> 'route' ->> 'directShareId',
                  contribution.value -> 'route' ->> 'sourceRecordId', ''
                )
            ), '[]'::jsonb)
            from pg_catalog.jsonb_array_elements(
              assessed.eligibility -> 'eligiblePermissions'
            ) with ordinality as alt(value, ordinality)
            cross join lateral pg_catalog.jsonb_array_elements(
              vortex_access.evaluate_record_permission_row_scope_internal(
                context_value, checked_at,
                vortex_access.recent_authentication_deadline_internal(
                  context_value, checked_at, assessed.declaration -> 'recentAuthentication'
                ),
                (assessed.declaration -> 'target' ->> 'applicationRootId')::uuid,
                assessed.declaration -> 'action', alt.value, assessed.record_id,
                case when assessed.is_compact
                  then pg_catalog.jsonb_set(envelope_facts, '{records}',
                    pg_catalog.jsonb_build_array(assessed.own_record))
                  else assessed.facts end,
                array[(alt.value -> 'permission' ->> 'permissionId')::uuid]
              )
            ) as contribution(value)
          )
          else '[]'::jsonb end as matched
      from assessed
      left join decided
        on decided.row_index = assessed.row_index and decided.action_kind = assessed.action_kind
    )
    select coalesce(pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'rowIndex', scoped.row_index,
        'actionKind', scoped.action_kind,
        'decision', coalesce(scoped.set_decision, (
          (scoped.eligibility - 'outcome' - 'validUntil'
            - 'eligiblePermissions' - 'reasonCode')
          || pg_catalog.jsonb_build_object(
            'recordId', scoped.record_id, 'action', scoped.declaration -> 'action'
          )
          || case
            when scoped.eligibility ->> 'outcome' = 'refused' then
              pg_catalog.jsonb_build_object(
                'outcome', 'refused', 'reasonCode', scoped.eligibility ->> 'reasonCode'
              )
            when not scoped.target_ok or pg_catalog.jsonb_array_length(scoped.matched) = 0 then
              pg_catalog.jsonb_build_object(
                'outcome', 'refused', 'reasonCode', 'record_scope_refused'
              )
            else pg_catalog.jsonb_build_object(
              'outcome', 'allowed',
              'validUntil', (
                select vortex_platform.format_timestamp_utc(
                  pg_catalog.min((match.value ->> 'validUntil')::timestamptz)
                )
                from pg_catalog.jsonb_array_elements(scoped.matched) as match(value)
              ),
              'matchedContributions', scoped.matched
            )
          end
        ))
      ) order by scoped.row_index,
        case scoped.action_kind when 'update' then 1
          when 'delete' then 2 else 3 end
    ), '[]'::jsonb)
    into decisions
    from scoped;
  return decisions;
end
$function$;

create or replace function vortex_access.evaluate_organization_record_access_page_internal(
  p_rows jsonb,
  p_jobs jsonb
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $function$
  select vortex_access.evaluate_organization_record_access_page_internal(p_rows, p_jobs, null::jsonb)
$function$;

alter function vortex_access.evaluate_organization_record_access_page_internal(jsonb,jsonb,jsonb)
  owner to vortex_owner;
alter function vortex_access.evaluate_organization_record_access_page_internal(jsonb,jsonb)
  owner to vortex_owner;

revoke all on function vortex_access.evaluate_organization_record_access_page_internal(jsonb,jsonb,jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_access.evaluate_organization_record_access_page_internal(jsonb,jsonb,jsonb)
  to vortex_record_adapter;
revoke all on function vortex_access.evaluate_organization_record_access_page_internal(jsonb,jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_access.evaluate_organization_record_access_page_internal(jsonb,jsonb)
  to vortex_record_adapter;

comment on function vortex_access.evaluate_organization_record_access_page_internal(jsonb,jsonb,jsonb) is
  'Private page access decision over already validated read facts: shares eligibility by action declaration, decides every record whose routes have an exact set form in one set pass per declaration, and keeps the exact row-scope composition for every other record; a compact page row carries only its own record fact and shares the one page envelope''s facts, which are never copied per action job.';
comment on function vortex_access.evaluate_organization_record_access_page_internal(jsonb,jsonb) is
  'Private page access decision over rows that each carry their complete read facts; delegates to the envelope variant.';
