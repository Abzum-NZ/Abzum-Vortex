-- DT-4: direct record shares are gone. Nothing has written vortex_access.organization_direct_record_shares
-- since 20261014011000 removed its writers, so the 'direct_share' permission route kind can never
-- admit a record. The route kind leaves the definition contract (4.3.0) and Studio; here the
-- table, its triggers and its reader go, and every record decision, field bound and read-scan
-- plan stops testing the route. Every other route kind decides exactly as before.

set role vortex_owner;

create or replace function vortex_access.decide_record_page_scope_internal(
  p_context jsonb,
  p_checked_at timestamptz,
  p_declaration jsonb,
  p_eligibility jsonb,
  p_record_types jsonb,
  p_records jsonb,
  p_include_checked_at boolean
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  binding jsonb := p_declaration -> 'recordBinding';
  action_kind text := p_declaration -> 'action' ->> 'actionKind';
  v_account_id uuid := (p_context ->> 'organizationAccountId')::uuid;
  v_organization_id uuid := (p_context ->> 'organizationId')::uuid;
  v_application_root_id uuid := (p_declaration -> 'target' ->> 'applicationRootId')::uuid;
  target_type jsonb;
  ownership_mode text;
  evidence jsonb;
  constant_matched jsonb;
  constant_valid_until text;
  decisions jsonb;
begin
  -- One decision per record of one page, for one action declaration and the
  -- eligibility the caller computed once for it in this invocation. It is the
  -- exact-record composition (target check, all-record, owner and owner-group
  -- routes) applied to every record in one pass. It returns JSON
  -- null for a record, or SQL null for the whole page, whenever a route, a
  -- saved condition or the record's evidence has no exact set form here; the
  -- caller then decides that record through the exact single-record path.
  if pg_catalog.jsonb_typeof(p_records) is distinct from 'array'
    or pg_catalog.jsonb_array_length(p_records) > 600
    or pg_catalog.jsonb_typeof(p_record_types) is distinct from 'array'
    or pg_catalog.jsonb_typeof(binding) is distinct from 'object'
    or action_kind is null
    or (p_declaration -> 'action') ? 'namedAction'
    or p_checked_at is null
    or p_checked_at in ('-infinity'::timestamptz, 'infinity'::timestamptz)
    or v_account_id is null or v_organization_id is null or v_application_root_id is null
    or pg_catalog.jsonb_typeof(p_eligibility) is distinct from 'object' then
    raise exception using errcode = '22023', message = 'Page record scope input is invalid';
  end if;

  if p_eligibility ->> 'outcome' = 'eligible' and (
    p_eligibility -> 'recordBinding' is distinct from binding
    or p_eligibility -> 'target' is distinct from p_declaration -> 'target'
    or p_eligibility ->> 'organizationId' is distinct from p_context ->> 'organizationId'
    or p_eligibility ->> 'organizationAccountId' is distinct from p_context ->> 'organizationAccountId'
    or p_eligibility ->> 'accessVersion' is distinct from p_context ->> 'accessVersion'
    or p_eligibility ->> 'correlationId' is distinct from p_context ->> 'correlationId'
    or (p_eligibility ->> 'validUntil')::timestamptz <= p_checked_at
  ) then
    raise exception using errcode = '22023', message = 'Page record eligibility is invalid';
  end if;

  evidence := (p_eligibility - 'outcome' - 'validUntil' - 'eligiblePermissions' - 'reasonCode')
    || pg_catalog.jsonb_build_object('action', p_declaration -> 'action')
    || case when p_include_checked_at then pg_catalog.jsonb_build_object(
      'checkedAt', pg_catalog.to_char(pg_catalog.timezone('UTC', p_checked_at),
        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')) else '{}'::jsonb end;

  if p_eligibility ->> 'outcome' is distinct from 'eligible' then
    -- An ineligible caller is refused for every record before any record test.
    return (
      select coalesce(pg_catalog.jsonb_agg(
        case when vortex_platform.is_non_nil_uuid(item.value #>> '{recordScope,recordId}')
          then evidence || pg_catalog.jsonb_build_object(
            'recordId', (item.value #>> '{recordScope,recordId}')::uuid,
            'outcome', 'refused', 'reasonCode', p_eligibility ->> 'reasonCode')
          else 'null'::jsonb end
        order by item.ordinality), '[]'::jsonb)
      from pg_catalog.jsonb_array_elements(p_records) with ordinality as item(value, ordinality)
    );
  end if;

  select item.value into target_type
  from pg_catalog.jsonb_array_elements(p_record_types) as item(value)
  where pg_catalog.lower(item.value ->> 'recordTypeId') = pg_catalog.lower(binding ->> 'recordTypeId')
  limit 1;
  ownership_mode := target_type ->> 'ownershipMode';

  -- Only routes with an exact set form: all records and the record's own owner
  -- or owner group; never a relationship route, an inherited
  -- owner chase or a saved condition. The bound type must agree with the
  -- binding, as the owner test compares the record with the type.
  if target_type is null
    or pg_catalog.lower(target_type ->> 'moduleRootId') is distinct from pg_catalog.lower(binding ->> 'moduleRootId')
    or pg_catalog.lower(target_type ->> 'storageContractId') is distinct from pg_catalog.lower(binding ->> 'storageContractId')
    or target_type ->> 'storageScope' is distinct from binding ->> 'storageScope'
    or coalesce(ownership_mode, '') not in ('none', 'organization_account', 'group')
    or pg_catalog.jsonb_typeof(p_eligibility -> 'eligiblePermissions') is distinct from 'array'
    or exists (
      select 1
      from pg_catalog.jsonb_array_elements(p_eligibility -> 'eligiblePermissions') as alt(value)
      where pg_catalog.jsonb_typeof(alt.value -> 'recordScope') is distinct from 'object'
        or (alt.value -> 'recordScope') ? 'savedCondition'
        or pg_catalog.jsonb_typeof(alt.value #> '{recordScope,routes}') is distinct from 'array'
        or exists (
          select 1
          from pg_catalog.jsonb_array_elements(
            case when pg_catalog.jsonb_typeof(alt.value #> '{recordScope,routes}') = 'array'
              then alt.value #> '{recordScope,routes}' else '[]'::jsonb end
          ) as route(value)
          where coalesce(route.value ->> 'kind', '') not in ('all_records', 'ownership')
        )
    ) then
    return null;
  end if;

  -- When every eligible alternative admits all records, every target record
  -- gets the same contributions: build them once.
  if not exists (
    select 1
    from pg_catalog.jsonb_array_elements(p_eligibility -> 'eligiblePermissions') as alt(value)
    where not exists (
      select 1 from pg_catalog.jsonb_array_elements(alt.value #> '{recordScope,routes}') as route(value)
      where route.value ->> 'kind' = 'all_records')
  ) then
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'permission', alt.value -> 'permission',
        'registrationRevision', alt.value -> 'registrationRevision',
        'recordScope', alt.value -> 'recordScope',
        'source', alt.value -> 'source',
        'route', pg_catalog.jsonb_build_object('kind', 'all_records'),
        'validUntil', pg_catalog.to_char(
          pg_catalog.timezone('UTC', (alt.value ->> 'validUntil')::timestamptz),
          'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
      ) order by alt.ordinality)
    into constant_matched
    from pg_catalog.jsonb_array_elements(p_eligibility -> 'eligiblePermissions')
      with ordinality as alt(value, ordinality);
    select vortex_platform.format_timestamp_utc(
      pg_catalog.min((match.value ->> 'validUntil')::timestamptz))
    into constant_valid_until
    from pg_catalog.jsonb_array_elements(constant_matched) as match(value);
  end if;

  with alternatives as materialized (
    select alt.ordinality as alt_index, alt.value as candidate,
      (alt.value ->> 'validUntil')::timestamptz as candidate_valid_until,
      exists (select 1 from pg_catalog.jsonb_array_elements(alt.value #> '{recordScope,routes}') as route(value)
        where route.value ->> 'kind' = 'all_records') as has_all,
      exists (select 1 from pg_catalog.jsonb_array_elements(alt.value #> '{recordScope,routes}') as route(value)
        where route.value ->> 'kind' = 'ownership') as has_owner
    from pg_catalog.jsonb_array_elements(p_eligibility -> 'eligiblePermissions')
      with ordinality as alt(value, ordinality)
  ),
  records as materialized (
    select item.ordinality as row_index, item.value as record,
      item.value -> 'recordScope' as scope,
      -- A well-formed record identity; any other record goes to the exact
      -- path, which refuses it loudly. The other identity members are only
      -- ever compared with the binding's own, as text.
      case when pg_catalog.jsonb_typeof(item.value) = 'object'
        and pg_catalog.jsonb_typeof(item.value -> 'recordScope') = 'object'
        and vortex_platform.is_non_nil_uuid(item.value #>> '{recordScope,recordId}')
        then (item.value #>> '{recordScope,recordId}')::uuid end as record_id,
      case when not (item.value ? 'ownerOrganizationAccountId') then null::uuid
        when vortex_platform.is_non_nil_uuid(item.value ->> 'ownerOrganizationAccountId')
        then (item.value ->> 'ownerOrganizationAccountId')::uuid end as owner_account_id,
      case when not (item.value ? 'ownerGroupId') then null::uuid
        when vortex_platform.is_non_nil_uuid(item.value ->> 'ownerGroupId')
        then (item.value ->> 'ownerGroupId')::uuid end as owner_group_id
    from pg_catalog.jsonb_array_elements(p_records) with ordinality as item(value, ordinality)
  ),
  assessed as materialized (
    select records.*,
      -- The exact decision's target check: same organisation, module, record
      -- type, storage contract and scope, the Application for contained
      -- storage, and an active record.
      case when records.record_id is null then false else
        pg_catalog.lower(records.scope ->> 'organizationId') = v_organization_id::text
        and pg_catalog.lower(records.scope ->> 'moduleRootId') = pg_catalog.lower(binding ->> 'moduleRootId')
        and pg_catalog.lower(records.scope ->> 'recordTypeId') = pg_catalog.lower(binding ->> 'recordTypeId')
        and pg_catalog.lower(records.scope ->> 'storageContractId') = pg_catalog.lower(binding ->> 'storageContractId')
        and records.scope ->> 'storageScope' = binding ->> 'storageScope'
        and (binding ->> 'storageScope' = 'organization_shared'
          or pg_catalog.lower(records.scope ->> 'applicationRootId') = v_application_root_id::text)
        and records.record ->> 'lifecycleState' = 'active' end as target_ok,
      -- The evidence the owner and all-record test accepts without raising;
      -- anything else goes to the exact path, which refuses it loudly.
      case when records.record_id is null then false else
        (select pg_catalog.count(*) from pg_catalog.jsonb_object_keys(records.scope))
          = case records.scope ->> 'storageScope' when 'organization_shared' then 6
            when 'application_contained' then 7 end
        and ((records.scope ->> 'storageScope') = 'organization_shared') <> (records.scope ? 'applicationRootId')
        and case ownership_mode
          when 'none' then not (records.record ? 'ownerOrganizationAccountId')
            and not (records.record ? 'ownerGroupId')
          when 'organization_account' then records.owner_account_id is not null
            and not (records.record ? 'ownerGroupId')
          else records.owner_group_id is not null
            and not (records.record ? 'ownerOrganizationAccountId') end end as evidence_ok
    from records
  ),
  contributions as (
    -- All-record and owner routes: one contribution when admitted.
    select assessed.row_index, alternatives.alt_index, alternatives.candidate,
      pg_catalog.jsonb_build_object('kind',
        case when alternatives.has_all then 'all_records' else 'ownership' end) as route,
      case when alternatives.has_all then null::timestamptz
        when ownership_mode = 'organization_account' then null::timestamptz
        else membership.expires_at end as deadline,
      alternatives.candidate_valid_until
    from assessed
    cross join alternatives
    left join lateral (
      select member.expires_at, true as found
      from vortex_access.organization_group_memberships as member
      join vortex_access.organization_groups as owner_group
        on owner_group.organization_id = member.organization_id
        and owner_group.group_id = member.group_id
        and owner_group.state = 'active'
      where ownership_mode = 'group' and alternatives.has_owner and not alternatives.has_all
        and member.organization_id = v_organization_id
        and member.group_id = assessed.owner_group_id
        and member.organization_account_id = v_account_id
        and member.state = 'live'
        and member.starts_at <= p_checked_at
        and (member.expires_at is null or member.expires_at > p_checked_at)
      limit 1
    ) as membership on true
    where constant_matched is null and assessed.target_ok and assessed.evidence_ok
      and (alternatives.has_all
        or (alternatives.has_owner and ownership_mode = 'organization_account'
          and assessed.owner_account_id = v_account_id)
        or (alternatives.has_owner and ownership_mode = 'group' and membership.found))
  ),
  matched as (
    select contribution.row_index,
      pg_catalog.jsonb_agg(contribution.value order by
        contribution.alt_index,
        case contribution.value -> 'route' ->> 'kind'
          when 'all_records' then 0 when 'ownership' then 1
          when 'relationship' then 3 end,
        coalesce(contribution.value -> 'route' ->> 'sourceRecordId', '')
      ) as contributions
    from (
      select contributions.row_index, contributions.alt_index,
        pg_catalog.jsonb_build_object(
          'permission', contributions.candidate -> 'permission',
          'registrationRevision', contributions.candidate -> 'registrationRevision',
          'recordScope', contributions.candidate -> 'recordScope',
          'source', contributions.candidate -> 'source',
          'route', contributions.route,
          'validUntil', pg_catalog.to_char(
            pg_catalog.timezone('UTC',
              least(contributions.candidate_valid_until, contributions.deadline)),
            'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
        ) as value
      from contributions
    ) as contribution
    group by contribution.row_index
  )
  select pg_catalog.jsonb_agg(
    case
      when assessed.record_id is null then 'null'::jsonb
      when not assessed.target_ok then evidence || pg_catalog.jsonb_build_object(
        'recordId', assessed.record_id, 'outcome', 'refused', 'reasonCode', 'record_scope_refused')
      when not assessed.evidence_ok then 'null'::jsonb
      when constant_matched is not null then evidence || pg_catalog.jsonb_build_object(
        'recordId', assessed.record_id, 'outcome', 'allowed',
        'validUntil', constant_valid_until, 'matchedContributions', constant_matched)
      when matched.contributions is null then evidence || pg_catalog.jsonb_build_object(
        'recordId', assessed.record_id, 'outcome', 'refused', 'reasonCode', 'record_scope_refused')
      else evidence || pg_catalog.jsonb_build_object(
        'recordId', assessed.record_id,
        'outcome', 'allowed',
        'validUntil', (
          select vortex_platform.format_timestamp_utc(
            pg_catalog.min((match.value ->> 'validUntil')::timestamptz))
          from pg_catalog.jsonb_array_elements(matched.contributions) as match(value)
        ),
        'matchedContributions', matched.contributions)
    end
    order by assessed.row_index
  )
  into decisions
  from assessed
  left join matched on matched.row_index = assessed.row_index;

  return coalesce(decisions, '[]'::jsonb);
end
$function$;

alter function vortex_access.decide_record_page_scope_internal(jsonb,timestamptz,jsonb,jsonb,jsonb,jsonb,boolean)
  owner to vortex_owner;
revoke all on function vortex_access.decide_record_page_scope_internal(jsonb,timestamptz,jsonb,jsonb,jsonb,jsonb,boolean)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_access.decide_record_page_scope_internal(jsonb,timestamptz,jsonb,jsonb,jsonb,jsonb,boolean)
  to vortex_record_adapter;

comment on function vortex_access.decide_record_page_scope_internal(jsonb,timestamptz,jsonb,jsonb,jsonb,jsonb,boolean) is
  'Private set-based record decision for one page and one action declaration: applies the exact-record target check and the all-record, owner and owner-group routes of the eligibility the caller computed once in this invocation to every record in one pass, producing the same decision the exact single-record composition produces; returns null for the page when an eligible alternative has a relationship route or a saved condition or the record type inherits its owner, and null for a record whose evidence is not well formed, so the caller decides those through the exact path.';

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
                  when 'relationship' then 3
                end,
                coalesce(contribution.value -> 'route' ->> 'sourceRecordId', '')
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

alter function vortex_access.evaluate_organization_record_access_page_internal(jsonb,jsonb,jsonb)
  owner to vortex_owner;

revoke all on function vortex_access.evaluate_organization_record_access_page_internal(jsonb,jsonb,jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_access.evaluate_organization_record_access_page_internal(jsonb,jsonb,jsonb)
  to vortex_record_adapter;

comment on function vortex_access.evaluate_organization_record_access_page_internal(jsonb,jsonb,jsonb) is
  'Private page access decision over already validated read facts: shares eligibility by action declaration, decides every record whose routes have an exact set form in one set pass per declaration, and keeps the exact row-scope composition for every other record; a compact page row carries only its own record fact and shares the one page envelope''s facts, which are never copied per action job.';

create or replace function vortex_access.evaluate_record_access_with_validated_types_internal(
  p_declaration jsonb,
  p_target_record_id uuid,
  p_facts jsonb,
  p_eligibility jsonb,
  p_validated_record_types jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  declaration_binding jsonb := p_declaration -> 'recordBinding';
  facts_binding jsonb;
  condition_item jsonb;
  record_item jsonb;
  record_scope_item jsonb;
  edge_item jsonb;
  scope_key_count integer;
  seen_type_ids text[] := array[]::text[];
  record_types_invalid boolean;
  seen_relationship_ids text[] := array[]::text[];
  relationships_invalid boolean;
  seen_condition_ids text[] := array[]::text[];
  seen_record_ids text[] := array[]::text[];
  ctx jsonb;
  checked_at timestamptz;
  auth_deadline timestamptz;
  eligibility jsonb;
  decision_evidence jsonb;
  target_application_root_id uuid;
  target_record_row jsonb;
  target_ok boolean;
  matched jsonb;
  decision_valid_until text;
begin
  -- Facts shape: a closed object with exactly the declared top-level keys.
  if p_facts is null or pg_catalog.jsonb_typeof(p_facts) <> 'object'
    or not (p_facts ?& array['binding', 'recordTypes', 'relationships', 'sharingConditions', 'records', 'edges'])
    or exists (
      select 1 from pg_catalog.jsonb_object_keys(p_facts) as supplied(key)
      where supplied.key <> all (array['binding', 'recordTypes', 'relationships', 'sharingConditions', 'records', 'edges'])
    )
    or pg_catalog.jsonb_typeof(p_facts -> 'binding') <> 'object'
    or pg_catalog.jsonb_typeof(p_facts -> 'recordTypes') <> 'array'
    or pg_catalog.jsonb_typeof(p_facts -> 'relationships') <> 'array'
    or pg_catalog.jsonb_typeof(p_facts -> 'sharingConditions') <> 'array'
    or pg_catalog.jsonb_typeof(p_facts -> 'records') <> 'array'
    or pg_catalog.jsonb_typeof(p_facts -> 'edges') <> 'array' then
    raise exception using errcode = '22023', message = 'Record access facts are invalid';
  end if;

  facts_binding := p_facts -> 'binding';
  if not (facts_binding ?& array['moduleRootId', 'recordTypeId', 'storageContractId', 'storageScope'])
    or exists (
      select 1 from pg_catalog.jsonb_object_keys(facts_binding) as supplied(key)
      where supplied.key <> all (array['moduleRootId', 'recordTypeId', 'storageContractId', 'storageScope'])
    )
    or not vortex_platform.is_non_nil_uuid(facts_binding ->> 'moduleRootId')
    or not vortex_platform.is_non_nil_uuid(facts_binding ->> 'recordTypeId')
    or not vortex_platform.is_non_nil_uuid(facts_binding ->> 'storageContractId')
    or facts_binding ->> 'storageScope' not in ('organization_shared', 'application_contained') then
    raise exception using errcode = '22023', message = 'Record access facts are invalid';
  end if;

  if pg_catalog.lower(facts_binding ->> 'moduleRootId') <> pg_catalog.lower(declaration_binding ->> 'moduleRootId')
    or pg_catalog.lower(facts_binding ->> 'recordTypeId') <> pg_catalog.lower(declaration_binding ->> 'recordTypeId')
    or pg_catalog.lower(facts_binding ->> 'storageContractId') <> pg_catalog.lower(declaration_binding ->> 'storageContractId')
    or (facts_binding ->> 'storageScope') <> (declaration_binding ->> 'storageScope') then
    raise exception using errcode = '22023', message = 'Record access facts are invalid';
  end if;

  -- Only the fixed record adapter can pass a type set validated earlier in
  -- this invocation. Request writable settings never authorize this shortcut.
  if p_validated_record_types is not null
    and p_validated_record_types = p_facts -> 'recordTypes' then
    select coalesce(pg_catalog.array_agg(pg_catalog.lower(item.value ->> 'recordTypeId')), array[]::text[])
    into seen_type_ids
    from pg_catalog.jsonb_array_elements(p_facts -> 'recordTypes') as item(value);
  else
  -- Check the complete type and field set in one statement. Every row still
  -- receives the same shape, identity and duplicate checks; only the repeated
  -- PL/pgSQL-to-SQL call for each type and field is removed.
  select coalesce(pg_catalog.array_agg(
      pg_catalog.lower(record_type_item.value ->> 'recordTypeId')
      order by record_type_item.ordinality
    ), array[]::text[]),
    coalesce(pg_catalog.bool_or(
      pg_catalog.jsonb_typeof(record_type_item.value) <> 'object'
      or not (record_type_item.value ?& array[
        'moduleRootId', 'recordTypeId', 'storageContractId', 'storageScope', 'ownershipMode', 'fields'
      ])
      or exists (
        select 1
        from pg_catalog.jsonb_object_keys(case
          when pg_catalog.jsonb_typeof(record_type_item.value) = 'object'
            then record_type_item.value else '{}'::jsonb end
        ) as supplied(key)
        where supplied.key <> all (array[
          'moduleRootId', 'recordTypeId', 'storageContractId', 'storageScope',
          'ownershipMode', 'ownershipRelationshipId', 'validationContractVersion', 'fields'
        ])
      )
      or not vortex_platform.is_non_nil_uuid(record_type_item.value ->> 'moduleRootId')
      or not vortex_platform.is_non_nil_uuid(record_type_item.value ->> 'recordTypeId')
      or not vortex_platform.is_non_nil_uuid(record_type_item.value ->> 'storageContractId')
      or record_type_item.value ->> 'storageScope' not in ('organization_shared', 'application_contained')
      or record_type_item.value ->> 'ownershipMode' not in ('none', 'organization_account', 'group', 'inherited')
      or ((record_type_item.value ? 'ownershipRelationshipId') <>
        (record_type_item.value ->> 'ownershipMode' = 'inherited'))
      or (record_type_item.value ? 'ownershipRelationshipId'
        and not vortex_platform.is_non_nil_uuid(record_type_item.value ->> 'ownershipRelationshipId'))
      or (record_type_item.value ? 'validationContractVersion' and (
        pg_catalog.jsonb_typeof(record_type_item.value -> 'validationContractVersion') <> 'string'
        or record_type_item.value ->> 'validationContractVersion'
          <> all (vortex_definition.accepted_contract_version('record_type'))
      ))
      or pg_catalog.jsonb_typeof(record_type_item.value -> 'fields') <> 'array'
      or fields.invalid
      or fields.duplicate_ids
    ), false)
      or pg_catalog.count(*) <> pg_catalog.count(distinct
        pg_catalog.lower(record_type_item.value ->> 'recordTypeId'))
  into seen_type_ids, record_types_invalid
  from pg_catalog.jsonb_array_elements(p_facts -> 'recordTypes')
    with ordinality as record_type_item(value, ordinality)
  cross join lateral (
    select coalesce(pg_catalog.bool_or(
      pg_catalog.jsonb_typeof(field_item.value) <> 'object'
      or not (field_item.value ?& array['fieldId', 'type'])
      or exists (
        select 1
        from pg_catalog.jsonb_object_keys(case
          when pg_catalog.jsonb_typeof(field_item.value) = 'object'
            then field_item.value else '{}'::jsonb end
        ) as supplied(key)
        where supplied.key <> all (array['fieldId', 'type', 'settings'])
      )
      or not vortex_platform.is_non_nil_uuid(field_item.value ->> 'fieldId')
      or pg_catalog.jsonb_typeof(field_item.value -> 'type') <> 'string'
      or (field_item.value ? 'settings'
        and pg_catalog.jsonb_typeof(field_item.value -> 'settings') <> 'object')
    ), false) as invalid,
    pg_catalog.count(*) <> pg_catalog.count(distinct
      pg_catalog.lower(field_item.value ->> 'fieldId')) as duplicate_ids
    from pg_catalog.jsonb_array_elements(case
      when pg_catalog.jsonb_typeof(record_type_item.value -> 'fields') = 'array'
        then record_type_item.value -> 'fields' else '[]'::jsonb end
    ) as field_item(value)
  ) as fields;
  if record_types_invalid then
    raise exception using errcode = '22023', message = 'Record access facts are invalid';
  end if;

  end if;

  if not (pg_catalog.lower(facts_binding ->> 'recordTypeId') = any (seen_type_ids)) then
    raise exception using errcode = '22023', message = 'Record access facts are invalid';
  end if;

  -- Relationships: unique identity, well-formed endpoints. `toRecordTypes`
  -- is every declared target: one for a link, several for a link to one of
  -- several record types. The whole set is checked in one statement, like the
  -- type set: every relationship receives the same shape, identity and
  -- duplicate checks without a PL/pgSQL round trip for each one.
  select coalesce(pg_catalog.array_agg(
      pg_catalog.lower(relationship_item.value ->> 'relationshipId')
      order by relationship_item.ordinality
    ), array[]::text[]),
    coalesce(pg_catalog.bool_or(
      pg_catalog.jsonb_typeof(relationship_item.value) <> 'object'
      or not (relationship_item.value ?& array[
        'relationshipId', 'fromModuleRootId', 'fromRecordTypeId', 'toRecordTypes'
      ])
      or exists (
        select 1
        from pg_catalog.jsonb_object_keys(case
          when pg_catalog.jsonb_typeof(relationship_item.value) = 'object'
            then relationship_item.value else '{}'::jsonb end
        ) as supplied(key)
        where supplied.key <> all (array[
          'relationshipId', 'fromModuleRootId', 'fromRecordTypeId', 'toRecordTypes'
        ])
      )
      or not vortex_platform.is_non_nil_uuid(relationship_item.value ->> 'relationshipId')
      or not vortex_platform.is_non_nil_uuid(relationship_item.value ->> 'fromModuleRootId')
      or not vortex_platform.is_non_nil_uuid(relationship_item.value ->> 'fromRecordTypeId')
      or pg_catalog.jsonb_typeof(relationship_item.value -> 'toRecordTypes') is distinct from 'array'
      or pg_catalog.jsonb_array_length(case
        when pg_catalog.jsonb_typeof(relationship_item.value -> 'toRecordTypes') = 'array'
          then relationship_item.value -> 'toRecordTypes' else '[]'::jsonb end
      ) = 0
      or exists (
        select 1
        from pg_catalog.jsonb_array_elements(case
          when pg_catalog.jsonb_typeof(relationship_item.value -> 'toRecordTypes') = 'array'
            then relationship_item.value -> 'toRecordTypes' else '[]'::jsonb end
        ) as target(value)
        where pg_catalog.jsonb_typeof(target.value) <> 'object'
          or not (target.value ?& array['moduleRootId', 'recordTypeId'])
          or exists (
            select 1
            from pg_catalog.jsonb_object_keys(case
              when pg_catalog.jsonb_typeof(target.value) = 'object'
                then target.value else '{}'::jsonb end
            ) as supplied(key)
            where supplied.key <> all (array['moduleRootId', 'recordTypeId'])
          )
          or not vortex_platform.is_non_nil_uuid(target.value ->> 'moduleRootId')
          or not vortex_platform.is_non_nil_uuid(target.value ->> 'recordTypeId')
      )
    ), false)
      or pg_catalog.count(*) <> pg_catalog.count(distinct
        pg_catalog.lower(relationship_item.value ->> 'relationshipId'))
  into seen_relationship_ids, relationships_invalid
  from pg_catalog.jsonb_array_elements(p_facts -> 'relationships')
    with ordinality as relationship_item(value, ordinality);
  if relationships_invalid then
    raise exception using errcode = '22023', message = 'Record access facts are invalid';
  end if;

  -- Sharing conditions: unique identity, the fields the row-scope composition
  -- and the saved-condition predicate actually consume. Extra compiled-release
  -- fields (key, publicationTests, ...) are passed through untouched.
  for condition_item in
    select value from pg_catalog.jsonb_array_elements(p_facts -> 'sharingConditions') as item(value)
  loop
    if pg_catalog.jsonb_typeof(condition_item) <> 'object'
      or not (condition_item ?& array[
        'conditionId', 'sourceRecordTypeId', 'publishedRevision', 'contractFingerprint',
        'parameters', 'condition', 'declaredFieldIds'
      ])
      or not vortex_platform.is_non_nil_uuid(condition_item ->> 'conditionId')
      or not vortex_platform.is_non_nil_uuid(condition_item ->> 'sourceRecordTypeId')
      or pg_catalog.jsonb_typeof(condition_item -> 'publishedRevision') <> 'number'
      or pg_catalog.jsonb_typeof(condition_item -> 'contractFingerprint') <> 'string'
      or pg_catalog.jsonb_typeof(condition_item -> 'parameters') <> 'array'
      or pg_catalog.jsonb_typeof(condition_item -> 'condition') <> 'object'
      or pg_catalog.jsonb_typeof(condition_item -> 'declaredFieldIds') <> 'array' then
      raise exception using errcode = '22023', message = 'Record access facts are invalid';
    end if;

    if pg_catalog.lower(condition_item ->> 'conditionId') = any (seen_condition_ids) then
      raise exception using errcode = '22023', message = 'Record access facts are invalid';
    end if;
    seen_condition_ids := pg_catalog.array_append(
      seen_condition_ids, pg_catalog.lower(condition_item ->> 'conditionId')
    );
  end loop;

  -- Records: unique identity, well-formed record-identity scope, known type.
  for record_item in
    select value from pg_catalog.jsonb_array_elements(p_facts -> 'records') as item(value)
  loop
    if pg_catalog.jsonb_typeof(record_item) <> 'object'
      or not (record_item ?& array['recordScope', 'lifecycleState', 'fieldValues'])
      or exists (
        select 1 from pg_catalog.jsonb_object_keys(record_item) as supplied(key)
        where supplied.key <> all (array[
          'recordScope', 'ownerOrganizationAccountId', 'ownerGroupId', 'lifecycleState', 'fieldValues'
        ])
      )
      or pg_catalog.jsonb_typeof(record_item -> 'recordScope') <> 'object'
      or record_item ->> 'lifecycleState' not in ('active', 'soft_deleted', 'removal_pending')
      or pg_catalog.jsonb_typeof(record_item -> 'fieldValues') <> 'object'
      or (record_item ? 'ownerOrganizationAccountId'
        and not vortex_platform.is_non_nil_uuid(record_item ->> 'ownerOrganizationAccountId'))
      or (record_item ? 'ownerGroupId'
        and not vortex_platform.is_non_nil_uuid(record_item ->> 'ownerGroupId'))
      or (record_item ? 'ownerOrganizationAccountId' and record_item ? 'ownerGroupId') then
      raise exception using errcode = '22023', message = 'Record access facts are invalid';
    end if;

    record_scope_item := record_item -> 'recordScope';
    select pg_catalog.count(*) into scope_key_count
    from pg_catalog.jsonb_object_keys(record_scope_item) as supplied(key);

    if not (record_scope_item ?& array[
        'storageScope', 'organizationId', 'moduleRootId', 'recordTypeId', 'storageContractId', 'recordId'
      ])
      or not vortex_platform.is_non_nil_uuid(record_scope_item ->> 'organizationId')
      or not vortex_platform.is_non_nil_uuid(record_scope_item ->> 'moduleRootId')
      or not vortex_platform.is_non_nil_uuid(record_scope_item ->> 'recordTypeId')
      or not vortex_platform.is_non_nil_uuid(record_scope_item ->> 'storageContractId')
      or not vortex_platform.is_non_nil_uuid(record_scope_item ->> 'recordId')
      or (record_scope_item ->> 'storageScope') not in ('organization_shared', 'application_contained')
      or (
        (record_scope_item ->> 'storageScope') = 'organization_shared'
        and (scope_key_count <> 6 or record_scope_item ? 'applicationRootId')
      )
      or (
        (record_scope_item ->> 'storageScope') = 'application_contained'
        and (scope_key_count <> 7 or not vortex_platform.is_non_nil_uuid(record_scope_item ->> 'applicationRootId'))
      ) then
      raise exception using errcode = '22023', message = 'Record access facts are invalid';
    end if;

    if not (pg_catalog.lower(record_scope_item ->> 'recordTypeId') = any (seen_type_ids)) then
      raise exception using errcode = '22023', message = 'Record access facts are invalid';
    end if;

    if pg_catalog.lower(record_scope_item ->> 'recordId') = any (seen_record_ids) then
      raise exception using errcode = '22023', message = 'Record access facts are invalid';
    end if;
    seen_record_ids := pg_catalog.array_append(seen_record_ids, pg_catalog.lower(record_scope_item ->> 'recordId'));
  end loop;

  -- Edges: well-formed, no dangling relationship or missing endpoint record.
  -- Duplicate/ambiguous edges are a functional refusal inside the row-scope
  -- composition, not a facts-shape violation, so they are not rejected here.
  for edge_item in
    select value from pg_catalog.jsonb_array_elements(p_facts -> 'edges') as item(value)
  loop
    if pg_catalog.jsonb_typeof(edge_item) <> 'object'
      or not (edge_item ?& array['relationshipId', 'fromRecordId', 'toRecordId'])
      or exists (
        select 1 from pg_catalog.jsonb_object_keys(edge_item) as supplied(key)
        where supplied.key <> all (array['relationshipId', 'fromRecordId', 'toRecordId'])
      )
      or not vortex_platform.is_non_nil_uuid(edge_item ->> 'relationshipId')
      or not vortex_platform.is_non_nil_uuid(edge_item ->> 'fromRecordId')
      or not vortex_platform.is_non_nil_uuid(edge_item ->> 'toRecordId') then
      raise exception using errcode = '22023', message = 'Record access facts are invalid';
    end if;

    if not (pg_catalog.lower(edge_item ->> 'relationshipId') = any (seen_relationship_ids)) then
      raise exception using errcode = '22023', message = 'Record access facts are invalid';
    end if;
    if not (pg_catalog.lower(edge_item ->> 'fromRecordId') = any (seen_record_ids))
      or not (pg_catalog.lower(edge_item ->> 'toRecordId') = any (seen_record_ids)) then
      raise exception using errcode = '22023', message = 'Record access facts are invalid';
    end if;
  end loop;

  -- One Access-version observation, one time sample, shared by the eligibility
  -- call and every row-scope composition below.
  ctx := vortex_access.validated_human_request_context();
  checked_at := pg_catalog.clock_timestamp();

  if p_eligibility is null then
    eligibility := vortex_access.evaluate_organization_record_permission_eligibility_internal(
      p_declaration, ctx, checked_at
    );
  else
    -- Only the fixed record adapter supplies eligibility it decided once for a
    -- page or a set of targets; a refusal is supplied as decided. The request
    -- role cannot execute this variant or supply a forged decision.
    eligibility := p_eligibility;
    if coalesce(eligibility ->> 'outcome', '') not in ('eligible', 'refused')
      or eligibility -> 'recordBinding' is distinct from p_declaration -> 'recordBinding'
      or eligibility -> 'target' is distinct from p_declaration -> 'target'
      or eligibility ->> 'organizationId' is distinct from ctx ->> 'organizationId'
      or eligibility ->> 'organizationAccountId' is distinct from ctx ->> 'organizationAccountId'
      or eligibility ->> 'accessVersion' is distinct from ctx ->> 'accessVersion'
      or eligibility ->> 'correlationId' is distinct from ctx ->> 'correlationId'
      or (eligibility ->> 'outcome' = 'eligible'
        and (eligibility ->> 'validUntil')::timestamptz <= checked_at) then
      raise exception using errcode = '22023', message = 'Supplied record eligibility is invalid';
    end if;
  end if;

  decision_evidence := (eligibility - 'outcome' - 'validUntil' - 'eligiblePermissions' - 'reasonCode')
    || pg_catalog.jsonb_build_object(
      'recordId', p_target_record_id, 'action', p_declaration -> 'action',
      'checkedAt', pg_catalog.to_char(pg_catalog.timezone('UTC', checked_at),
        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
    );

  if eligibility ->> 'outcome' = 'refused' then
    return decision_evidence || pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', eligibility ->> 'reasonCode'
    );
  end if;

  target_application_root_id := (p_declaration -> 'target' ->> 'applicationRootId')::uuid;

  -- Target row check: fail closed, never raise. This is the cross-organisation
  -- and cross-application isolation path.
  select value into target_record_row
  from pg_catalog.jsonb_array_elements(p_facts -> 'records') as item(value)
  where (value -> 'recordScope' ->> 'recordId')::uuid = p_target_record_id
  limit 1;

  target_ok := target_record_row is not null
    and (target_record_row -> 'recordScope' ->> 'organizationId')::uuid = (ctx ->> 'organizationId')::uuid
    and pg_catalog.lower(target_record_row -> 'recordScope' ->> 'moduleRootId') = pg_catalog.lower(facts_binding ->> 'moduleRootId')
    and pg_catalog.lower(target_record_row -> 'recordScope' ->> 'recordTypeId') = pg_catalog.lower(facts_binding ->> 'recordTypeId')
    and pg_catalog.lower(target_record_row -> 'recordScope' ->> 'storageContractId') = pg_catalog.lower(facts_binding ->> 'storageContractId')
    and (target_record_row -> 'recordScope' ->> 'storageScope') = (facts_binding ->> 'storageScope')
    and (
      (facts_binding ->> 'storageScope') = 'organization_shared'
      or (target_record_row -> 'recordScope' ->> 'applicationRootId')::uuid = target_application_root_id
    )
    and target_record_row ->> 'lifecycleState' = 'active';

  if not target_ok then
    return decision_evidence || pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'record_scope_refused'
    );
  end if;

  auth_deadline := vortex_access.recent_authentication_deadline_internal(
    ctx, checked_at, p_declaration -> 'recentAuthentication'
  );

  select coalesce(
    pg_catalog.jsonb_agg(
      contribution.value
      order by
        alt.ordinality,
        case contribution.value -> 'route' ->> 'kind'
          when 'all_records' then 0
          when 'ownership' then 1
          when 'relationship' then 3
        end,
        coalesce(contribution.value -> 'route' ->> 'sourceRecordId', '')
    ),
    '[]'::jsonb
  )
  into matched
  from pg_catalog.jsonb_array_elements(eligibility -> 'eligiblePermissions')
    with ordinality as alt(value, ordinality)
  cross join lateral pg_catalog.jsonb_array_elements(
    vortex_access.evaluate_record_permission_row_scope_internal(
      ctx,
      checked_at,
      auth_deadline,
      target_application_root_id,
      p_declaration -> 'action',
      alt.value,
      p_target_record_id,
      p_facts,
      array[(alt.value -> 'permission' ->> 'permissionId')::uuid]
    )
  ) as contribution(value);

  if pg_catalog.jsonb_array_length(matched) = 0 then
    return decision_evidence || pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'record_scope_refused'
    );
  end if;

  select vortex_platform.format_timestamp_utc(
    pg_catalog.min((elem.value ->> 'validUntil')::timestamptz)
  )
  into decision_valid_until
  from pg_catalog.jsonb_array_elements(matched) as elem(value);

  return decision_evidence || pg_catalog.jsonb_build_object(
    'outcome', 'allowed',
    'validUntil', decision_valid_until,
    'matchedContributions', matched
  );
end
$function$;

alter function vortex_access.evaluate_record_access_with_validated_types_internal(jsonb,uuid,jsonb,jsonb,jsonb) owner to vortex_owner;
revoke all on function vortex_access.evaluate_record_access_with_validated_types_internal(jsonb,uuid,jsonb,jsonb,jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_access.evaluate_record_access_with_validated_types_internal(jsonb,uuid,jsonb,jsonb,jsonb)
  to vortex_record_adapter, postgres;
comment on function vortex_access.evaluate_record_access_with_validated_types_internal(jsonb,uuid,jsonb,jsonb,jsonb) is
  'Exact record access evaluation of one target, with eligibility computed here or supplied by the fixed record adapter (decided once per declaration for a set of targets or a page); validates each record fact set and composes each record scope independently.';

create or replace function vortex_access.evaluate_record_permission_row_scope_internal(
  p_context jsonb,
  p_checked_at timestamptz,
  p_auth_deadline timestamptz,
  p_application_root_id uuid,
  p_action jsonb,
  p_candidate jsonb,
  p_record_id uuid,
  p_facts jsonb,
  p_path uuid[]
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  context_organization_id uuid := (p_context ->> 'organizationId')::uuid;
  context_account_id uuid := (p_context ->> 'organizationAccountId')::uuid;
  action_kind text := p_action ->> 'actionKind';
  candidate_permission jsonb := p_candidate -> 'permission';
  candidate_record_scope jsonb := p_candidate -> 'recordScope';
  candidate_valid_until timestamptz := (p_candidate ->> 'validUntil')::timestamptz;
  target_record jsonb;
  target_record_scope jsonb;
  target_type jsonb;
  has_all_records boolean;
  has_ownership boolean;
  route_list jsonb[] := array[]::jsonb[];
  deadline_list timestamptz[] := array[]::timestamptz[];
  ownership_admitted boolean;
  ownership_deadline timestamptz;
  chase_record jsonb;
  chase_scope jsonb;
  chase_type jsonb;
  chase_relationship jsonb;
  chase_edge jsonb;
  chase_edge_count integer;
  chase_target jsonb;
  parent_record jsonb;
  parent_scope jsonb;
  parent_type jsonb;
  visited_ids uuid[];
  chase_admitted boolean;
  chase_deadline timestamptz;
  route jsonb;
  relationship_decl jsonb;
  source_owner_kind text;
  source_owner_id uuid;
  source_eval record;
  source_permission_entry vortex_access.permission_catalogue_entries;
  source_path_valid_until timestamptz;
  source_valid_until timestamptz;
  source_candidate jsonb;
  source_record jsonb;
  source_record_scope jsonb;
  edge_item jsonb;
  sub_result jsonb;
  sub_min_valid_until timestamptz;
  contribution_deadline timestamptz;
  condition_id uuid;
  saved_condition jsonb;
  projected_values jsonb;
  declared_field jsonb;
  reduced_type jsonb;
  condition_ok boolean;
  result jsonb;
begin
  select value into target_record
  from pg_catalog.jsonb_array_elements(p_facts -> 'records') as item(value)
  where (value -> 'recordScope' ->> 'recordId')::uuid = p_record_id
  limit 1;

  if target_record is null or target_record ->> 'lifecycleState' <> 'active' then
    return '[]'::jsonb;
  end if;

  target_record_scope := target_record -> 'recordScope';

  select value into target_type
  from pg_catalog.jsonb_array_elements(p_facts -> 'recordTypes') as item(value)
  where (value ->> 'recordTypeId')::uuid = (target_record_scope ->> 'recordTypeId')::uuid
  limit 1;

  if target_type is null then
    return '[]'::jsonb;
  end if;

  has_all_records := exists (
    select 1 from pg_catalog.jsonb_array_elements(candidate_record_scope -> 'routes') as item(value)
    where item.value ->> 'kind' = 'all_records'
  );
  has_ownership := exists (
    select 1 from pg_catalog.jsonb_array_elements(candidate_record_scope -> 'routes') as item(value)
    where item.value ->> 'kind' = 'ownership'
  );

  -- Step 2: base ownership/all-record routes, then inherited-ownership chase.
  if has_all_records or has_ownership then
    select outcome.admitted, outcome.valid_until into ownership_admitted, ownership_deadline
    from vortex_access.evaluate_current_record_ownership_visibility(
      candidate_record_scope,
      target_type ->> 'ownershipMode',
      context_organization_id,
      p_application_root_id,
      (target_type ->> 'moduleRootId')::uuid,
      (target_type ->> 'recordTypeId')::uuid,
      (target_type ->> 'storageContractId')::uuid,
      target_type ->> 'storageScope',
      target_record_scope,
      (target_record ->> 'ownerOrganizationAccountId')::uuid,
      (target_record ->> 'ownerGroupId')::uuid,
      context_organization_id,
      p_application_root_id,
      context_account_id,
      p_checked_at
    ) as outcome;

    if ownership_admitted then
      route_list := pg_catalog.array_append(route_list, pg_catalog.jsonb_build_object(
        'kind', case when has_all_records then 'all_records' else 'ownership' end
      ));
      deadline_list := pg_catalog.array_append(deadline_list, ownership_deadline);
    elsif has_ownership and target_type ->> 'ownershipMode' = 'inherited' then
      chase_record := target_record;
      chase_scope := target_record_scope;
      chase_type := target_type;
      visited_ids := array[(target_record_scope ->> 'recordId')::uuid];

      while chase_type ->> 'ownershipMode' = 'inherited' loop
        select value into chase_relationship
        from pg_catalog.jsonb_array_elements(p_facts -> 'relationships') as item(value)
        where (value ->> 'relationshipId')::uuid = (chase_type ->> 'ownershipRelationshipId')::uuid
        limit 1;

        exit when chase_relationship is null;

        select pg_catalog.count(*) into chase_edge_count
        from pg_catalog.jsonb_array_elements(p_facts -> 'edges') as item(value)
        where (value ->> 'relationshipId')::uuid = (chase_relationship ->> 'relationshipId')::uuid
          and (value ->> 'fromRecordId')::uuid = (chase_scope ->> 'recordId')::uuid;

        exit when chase_edge_count <> 1;

        select value into chase_edge
        from pg_catalog.jsonb_array_elements(p_facts -> 'edges') as item(value)
        where (value ->> 'relationshipId')::uuid = (chase_relationship ->> 'relationshipId')::uuid
          and (value ->> 'fromRecordId')::uuid = (chase_scope ->> 'recordId')::uuid
        limit 1;

        select value into parent_record
        from pg_catalog.jsonb_array_elements(p_facts -> 'records') as item(value)
        where (value -> 'recordScope' ->> 'recordId')::uuid = (chase_edge ->> 'toRecordId')::uuid
        limit 1;

        exit when parent_record is null or parent_record ->> 'lifecycleState' <> 'active';

        parent_scope := parent_record -> 'recordScope';

        select value into parent_type
        from pg_catalog.jsonb_array_elements(p_facts -> 'recordTypes') as item(value)
        where (value ->> 'recordTypeId')::uuid = (parent_scope ->> 'recordTypeId')::uuid
        limit 1;

        exit when parent_type is null;

        select item.value into chase_target
        from pg_catalog.jsonb_array_elements(chase_relationship -> 'toRecordTypes') as item(value)
        where pg_catalog.lower(item.value ->> 'moduleRootId') =
            pg_catalog.lower(parent_scope ->> 'moduleRootId')
          and pg_catalog.lower(item.value ->> 'recordTypeId') =
            pg_catalog.lower(parent_scope ->> 'recordTypeId')
        limit 1;

        exit when chase_target is null;

        exit when not vortex_access.record_relationship_witness_matches(
          (chase_relationship ->> 'relationshipId')::uuid,
          (chase_relationship ->> 'fromModuleRootId')::uuid,
          (chase_relationship ->> 'fromRecordTypeId')::uuid,
          (chase_target ->> 'moduleRootId')::uuid,
          (chase_target ->> 'recordTypeId')::uuid,
          (chase_edge ->> 'relationshipId')::uuid,
          (chase_edge ->> 'fromRecordId')::uuid,
          (chase_edge ->> 'toRecordId')::uuid,
          chase_scope,
          parent_scope,
          context_organization_id,
          p_application_root_id
        );

        exit when (parent_scope ->> 'recordId')::uuid = any(visited_ids);

        visited_ids := pg_catalog.array_append(visited_ids, (parent_scope ->> 'recordId')::uuid);
        chase_record := parent_record;
        chase_scope := parent_scope;
        chase_type := parent_type;
      end loop;

      if chase_type ->> 'ownershipMode' in ('organization_account', 'group') then
        select outcome.admitted, outcome.valid_until into chase_admitted, chase_deadline
        from vortex_access.evaluate_current_record_ownership_visibility(
          '{"routes":[{"kind":"ownership"}]}'::jsonb,
          chase_type ->> 'ownershipMode',
          context_organization_id,
          p_application_root_id,
          (chase_type ->> 'moduleRootId')::uuid,
          (chase_type ->> 'recordTypeId')::uuid,
          (chase_type ->> 'storageContractId')::uuid,
          chase_type ->> 'storageScope',
          chase_scope,
          (chase_record ->> 'ownerOrganizationAccountId')::uuid,
          (chase_record ->> 'ownerGroupId')::uuid,
          context_organization_id,
          p_application_root_id,
          context_account_id,
          p_checked_at
        ) as outcome;

        if chase_admitted then
          route_list := pg_catalog.array_append(route_list, pg_catalog.jsonb_build_object('kind', 'ownership'));
          deadline_list := pg_catalog.array_append(deadline_list, chase_deadline);
        end if;
      end if;
    end if;
  end if;

  -- Step 3: relationship routes. The target record is always the relationship's
  -- `to` endpoint and the source record its `from` endpoint (see
  -- runtime/definition/src/validation.ts). Every recursive step re-evaluates
  -- the source permission's own eligibility and own complete scope; authority
  -- never crosses alternatives.
  for route in
    select value from pg_catalog.jsonb_array_elements(candidate_record_scope -> 'routes') as item(value)
    where value ->> 'kind' = 'relationship'
  loop
    select value into relationship_decl
    from pg_catalog.jsonb_array_elements(p_facts -> 'relationships') as item(value)
    where (value ->> 'relationshipId')::uuid = (route ->> 'relationshipId')::uuid
    limit 1;

    if relationship_decl is null
      or not exists (
        select 1
        from pg_catalog.jsonb_array_elements(relationship_decl -> 'toRecordTypes') as declared(value)
        where pg_catalog.lower(declared.value ->> 'moduleRootId') = pg_catalog.lower(target_type ->> 'moduleRootId')
          and pg_catalog.lower(declared.value ->> 'recordTypeId') = pg_catalog.lower(target_type ->> 'recordTypeId')
      ) then
      raise exception using errcode = '22023', message = 'Record access facts are invalid';
    end if;

    if (route ->> 'sourcePermissionId')::uuid = any(p_path) then
      continue;
    end if;

    begin
      select entry.owner_kind, entry.owner_id
      into strict source_owner_kind, source_owner_id
      from vortex_access.permission_catalogue_entries as entry
      join vortex_access.permission_registrations as registration
        on registration.organization_id = entry.organization_id
        and registration.registration_kind = entry.registration_kind
        and registration.registration_owner_id = entry.registration_owner_id
        and registration.revision = entry.registration_revision
        and registration.state = 'active'
      where entry.organization_id = context_organization_id
        and entry.application_root_id = p_application_root_id
        and entry.permission_id = (route ->> 'sourcePermissionId')::uuid
        and entry.record_type_id = (relationship_decl ->> 'fromRecordTypeId')::uuid
        and entry.action_kind = 'read'
        and entry.named_action is null;
    exception
      when no_data_found or too_many_rows then
        continue;
    end;

    source_eval := null;
    select evaluated.permission_entry, evaluated.path_valid_until
    into source_eval
    from vortex_access.evaluate_permission_role_path_internal(
      p_context,
      p_checked_at,
      pg_catalog.jsonb_build_object(
        'applicationRootId', p_application_root_id,
        'ownerKind', source_owner_kind,
        'ownerId', source_owner_id,
        'permissionId', (route ->> 'sourcePermissionId')::uuid
      ),
      pg_catalog.jsonb_build_object('actionKind', 'read'),
      (relationship_decl ->> 'fromRecordTypeId')::uuid
    ) as evaluated
    limit 1;

    if source_eval is null or (source_eval.permission_entry).record_scope is null
      or source_eval.path_valid_until is null or p_auth_deadline is null then
      continue;
    end if;
    source_permission_entry := source_eval.permission_entry;
    source_path_valid_until := source_eval.path_valid_until;
    source_valid_until := least(source_path_valid_until, p_auth_deadline);

    source_candidate := pg_catalog.jsonb_build_object(
      'permission', pg_catalog.jsonb_build_object(
        'applicationRootId', p_application_root_id,
        'ownerKind', source_owner_kind,
        'ownerId', source_owner_id,
        'permissionId', (route ->> 'sourcePermissionId')::uuid
      ),
      'registrationRevision', (source_permission_entry).registration_revision,
      'recordScope', (source_permission_entry).record_scope,
      'source', pg_catalog.jsonb_build_object(
        'kind', (source_permission_entry).source_kind,
        'definitionKey', (source_permission_entry).source_definition_key,
        'rootId', (source_permission_entry).source_root_id,
        'releaseRevision', (source_permission_entry).source_revision,
        'releaseVersion', (source_permission_entry).source_version,
        'validationContractVersion', (source_permission_entry).source_validation_contract_version
      ),
      'validUntil', pg_catalog.to_char(
        pg_catalog.timezone('UTC', source_valid_until), 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
      )
    );

    for edge_item in
      select value from pg_catalog.jsonb_array_elements(p_facts -> 'edges') as item(value)
      where (value ->> 'relationshipId')::uuid = (relationship_decl ->> 'relationshipId')::uuid
        and (value ->> 'toRecordId')::uuid = p_record_id
    loop
      select value into source_record
      from pg_catalog.jsonb_array_elements(p_facts -> 'records') as item(value)
      where (value -> 'recordScope' ->> 'recordId')::uuid = (edge_item ->> 'fromRecordId')::uuid
      limit 1;

      if source_record is null or source_record ->> 'lifecycleState' <> 'active' then
        continue;
      end if;
      source_record_scope := source_record -> 'recordScope';

      if pg_catalog.lower(source_record_scope ->> 'recordTypeId')
        <> pg_catalog.lower(relationship_decl ->> 'fromRecordTypeId') then
        continue;
      end if;

      if not vortex_access.record_relationship_witness_matches(
        (relationship_decl ->> 'relationshipId')::uuid,
        (relationship_decl ->> 'fromModuleRootId')::uuid,
        (relationship_decl ->> 'fromRecordTypeId')::uuid,
        (target_type ->> 'moduleRootId')::uuid,
        (target_type ->> 'recordTypeId')::uuid,
        (edge_item ->> 'relationshipId')::uuid,
        (edge_item ->> 'fromRecordId')::uuid,
        (edge_item ->> 'toRecordId')::uuid,
        source_record_scope,
        target_record_scope,
        context_organization_id,
        p_application_root_id
      ) then
        continue;
      end if;

      sub_result := vortex_access.evaluate_record_permission_row_scope_internal(
        p_context,
        p_checked_at,
        p_auth_deadline,
        p_application_root_id,
        pg_catalog.jsonb_build_object('actionKind', 'read'),
        source_candidate,
        (edge_item ->> 'fromRecordId')::uuid,
        p_facts,
        pg_catalog.array_append(p_path, (route ->> 'sourcePermissionId')::uuid)
      );

      if pg_catalog.jsonb_array_length(sub_result) > 0 then
        select pg_catalog.min((elem.value ->> 'validUntil')::timestamptz) into sub_min_valid_until
        from pg_catalog.jsonb_array_elements(sub_result) as elem(value);

        contribution_deadline := least(source_valid_until, sub_min_valid_until);

        route_list := pg_catalog.array_append(route_list, pg_catalog.jsonb_build_object(
          'kind', 'relationship',
          'relationshipId', (route ->> 'relationshipId')::uuid,
          'sourcePermissionId', (route ->> 'sourcePermissionId')::uuid,
          'sourceRecordId', (edge_item ->> 'fromRecordId')::uuid
        ));
        deadline_list := pg_catalog.array_append(deadline_list, contribution_deadline);
      end if;
    end loop;
  end loop;

  -- Step 4: a saved condition narrows every route, including all_records.
  if coalesce(pg_catalog.array_length(route_list, 1), 0) > 0
    and candidate_record_scope ? 'savedCondition' then
    condition_id := (candidate_record_scope -> 'savedCondition' ->> 'conditionId')::uuid;

    select value into saved_condition
    from pg_catalog.jsonb_array_elements(p_facts -> 'sharingConditions') as item(value)
    where (value ->> 'conditionId')::uuid = condition_id
    limit 1;

    if saved_condition is null then
      raise exception using errcode = '22023', message = 'Record access facts are invalid';
    end if;

    projected_values := '{}'::jsonb;
    for declared_field in
      select value from pg_catalog.jsonb_array_elements(saved_condition -> 'declaredFieldIds') as item(value)
    loop
      if not ((target_record -> 'fieldValues') ? (declared_field #>> '{}')) then
        raise exception using errcode = '22023', message = 'Record access facts are invalid';
      end if;
      projected_values := projected_values || pg_catalog.jsonb_build_object(
        declared_field #>> '{}', (target_record -> 'fieldValues') -> (declared_field #>> '{}')
      );
    end loop;

    reduced_type := pg_catalog.jsonb_build_object(
      'recordTypeId', target_type -> 'recordTypeId',
      'fields', target_type -> 'fields'
    ) || case
      when target_type ? 'validationContractVersion' then
        pg_catalog.jsonb_build_object(
          'validationContractVersion', target_type -> 'validationContractVersion'
        )
      else '{}'::jsonb
    end;

    condition_ok := vortex_access.evaluate_permission_saved_condition(
      candidate_record_scope, saved_condition, reduced_type, projected_values, context_account_id,
      p_facts -> 'recordTypes'
    );

    if condition_ok is not true then
      route_list := array[]::jsonb[];
      deadline_list := array[]::timestamptz[];
    end if;
  end if;

  -- Step 5: map to full matched contributions for this candidate.
  result := '[]'::jsonb;
  for route_index in 1 .. coalesce(pg_catalog.array_length(route_list, 1), 0) loop
    result := result || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'permission', candidate_permission,
      'registrationRevision', p_candidate -> 'registrationRevision',
      'recordScope', candidate_record_scope,
      'source', p_candidate -> 'source',
      'route', route_list[route_index],
      'validUntil', pg_catalog.to_char(
        pg_catalog.timezone('UTC', least(candidate_valid_until, deadline_list[route_index])),
        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
      )
    ));
  end loop;

  return result;
end
$function$;

revoke execute on function vortex_access.evaluate_record_permission_row_scope_internal(
  jsonb, timestamptz, timestamptz, uuid, jsonb, jsonb, uuid, jsonb, uuid[]
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;

comment on function vortex_access.evaluate_record_permission_row_scope_internal(
  jsonb, timestamptz, timestamptz, uuid, jsonb, jsonb, uuid, jsonb, uuid[]
) is
  'Private row-scope composition for one already-eligible permission against one exact record; returns matched contributions only, never a final allow/refuse result.';

alter function vortex_access.evaluate_record_permission_row_scope_internal(p_context jsonb, p_checked_at timestamp with time zone, p_auth_deadline timestamp with time zone, p_application_root_id uuid, p_action jsonb, p_candidate jsonb, p_record_id uuid, p_facts jsonb, p_path uuid[]) owner to vortex_owner;

grant execute on function vortex_access.evaluate_record_permission_row_scope_internal(p_context jsonb, p_checked_at timestamp with time zone, p_auth_deadline timestamp with time zone, p_application_root_id uuid, p_action jsonb, p_candidate jsonb, p_record_id uuid, p_facts jsonb, p_path uuid[]) to postgres;

CREATE OR REPLACE FUNCTION vortex_access.increment_organization_access_version(p_organization_id uuid, p_changed_by uuid, p_correlation_id uuid, p_change_reason text) RETURNS TABLE(organization_id uuid, current_version bigint, changed_at timestamp with time zone, changed_by uuid, change_correlation_id uuid, change_reason text)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
begin
  if p_organization_id is null
    or p_organization_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_changed_by is null
    or p_changed_by = '00000000-0000-0000-0000-000000000000'::uuid
    or p_correlation_id is null
    or p_correlation_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_change_reason not in (
      'organization_account_activated',
      'organization_account_reactivated',
      'organization_account_suspended',
      'organization_account_closed',
      'role_assignment_changed',
      'role_activation_changed',
      'delegation_changed',
      'stewardship_changed',
      'invitation_access_accepted',
      'role_catalogue_changed',
      'group_membership_changed',
      'application_access_changed',
      'record_ownership_changed',
      'access_grant_changed',
      'public_policy_changed',
      'federation_mirror_changed',
      'mcp_authorization_changed'
    ) then
    raise exception using errcode = '22023', message = 'Access-version increment input is invalid';
  end if;

  -- This marker detects a wrong request runner before UPDATE attempts a lock upgrade.
  -- It is not authority: callers still validate the current context and permission.
  if pg_catalog.current_setting('vortex_access.exclusive_organization_id', true)
    is distinct from p_organization_id::text then
    raise exception using errcode = '55000',
      message = 'Access-version increment requires an exclusive access-change scope';
  end if;

  return query
  update vortex_access.organization_access_versions as version
  set current_version = version.current_version + 1,
      changed_at = greatest(version.changed_at, pg_catalog.clock_timestamp()),
      changed_by = p_changed_by,
      change_correlation_id = p_correlation_id,
      change_reason = p_change_reason
  where version.organization_id = p_organization_id
    and version.current_version < 9007199254740991
  returning version.organization_id, version.current_version, version.changed_at,
    version.changed_by, version.change_correlation_id, version.change_reason;

  if not found then
    if exists (
      select 1 from vortex_access.organization_access_versions as version
      where version.organization_id = p_organization_id
        and version.current_version = 9007199254740991
    ) then
      raise exception using errcode = '22003', message = 'Access version is exhausted';
    end if;
    raise exception using errcode = '40001', message = 'Access version is unavailable';
  end if;

  -- The request that made this change continues at the version it produced, so its later
  -- statements (Activity, flow effects, receipts) validate against current access. Only this
  -- transaction's own context for this organisation moves, one step from the version it was
  -- admitted at, while the exclusive version lock is held until commit; identity, session,
  -- authentication, correlation and scope stay pinned, and rollback restores the context too.
  update vortex_platform.request_contexts as established
  set context = pg_catalog.jsonb_set(
    established.context, '{accessVersion}', pg_catalog.to_jsonb(version.current_version)
  )
  from vortex_access.organization_access_versions as version
  where version.organization_id = p_organization_id
    and established.backend_pid = pg_catalog.pg_backend_pid()
    and established.transaction_id = pg_catalog.pg_current_xact_id()
    and established.context ->> 'organizationId' = p_organization_id::text
    and established.context ->> 'accessVersion' = (version.current_version - 1)::text;

  -- A preview's copied live rows and fields were admitted under the previous access.
  -- Invalidate every builder's snapshot atomically with the version advance, while the
  -- access-change scope excludes preview requests. The next open seeds a new preview
  -- using current live access; retired physical storage is dropped in the background.
  perform vortex_access.invalidate_preview_installations_internal(p_organization_id);
end
$$;

alter function vortex_access.increment_organization_access_version(p_organization_id uuid, p_changed_by uuid, p_correlation_id uuid, p_change_reason text) owner to vortex_owner;

REVOKE ALL ON FUNCTION vortex_access.increment_organization_access_version(p_organization_id uuid, p_changed_by uuid, p_correlation_id uuid, p_change_reason text) FROM PUBLIC;

grant execute on function vortex_access.increment_organization_access_version(p_organization_id uuid, p_changed_by uuid, p_correlation_id uuid, p_change_reason text) to postgres;

CREATE OR REPLACE FUNCTION vortex_access.permission_record_scope_is_valid(p_record_scope jsonb) RETURNS boolean
    LANGUAGE plpgsql IMMUTABLE
    SET search_path TO ''
    AS $_$
declare
  route_value jsonb;
  route_kind text;
  route_identity text;
  previous_route_identity text;
  has_all_records boolean := false;
  route_count integer := 0;
  saved_condition jsonb;
  binding_value jsonb;
  binding_key text;
  binding_key_count integer;
  previous_binding_key text;
begin
  if p_record_scope is null
    or pg_catalog.jsonb_typeof(p_record_scope) <> 'object'
    or p_record_scope - array['routes', 'savedCondition']::text[] <> '{}'::jsonb
    or not (p_record_scope ? 'routes')
    or pg_catalog.jsonb_typeof(p_record_scope -> 'routes') <> 'array'
    or pg_catalog.jsonb_array_length(p_record_scope -> 'routes') < 1 then
    return false;
  end if;

  previous_route_identity := null;
  for route_value in
    select item.value
    from pg_catalog.jsonb_array_elements(p_record_scope -> 'routes') as item(value)
  loop
    if pg_catalog.jsonb_typeof(route_value) <> 'object'
      or not (route_value ? 'kind')
      or pg_catalog.jsonb_typeof(route_value -> 'kind') <> 'string' then
      return false;
    end if;
    route_kind := route_value ->> 'kind';
    route_count := route_count + 1;

    if route_kind = 'all_records' then
      if route_value - array['kind']::text[] <> '{}'::jsonb then
        return false;
      end if;
      has_all_records := true;
      route_identity := '0:';
    elsif route_kind = 'ownership' then
      if route_value - array['kind']::text[] <> '{}'::jsonb then
        return false;
      end if;
      route_identity := '1:';
    elsif route_kind = 'relationship' then
      if route_value - array['kind', 'relationshipId', 'sourcePermissionId']::text[]
          <> '{}'::jsonb
        or not (route_value ?& array['relationshipId', 'sourcePermissionId'])
        or pg_catalog.jsonb_typeof(route_value -> 'relationshipId') <> 'string'
        or pg_catalog.jsonb_typeof(route_value -> 'sourcePermissionId') <> 'string'
        or not vortex_platform.is_non_nil_uuid(route_value ->> 'relationshipId')
        or not vortex_platform.is_non_nil_uuid(route_value ->> 'sourcePermissionId') then
        return false;
      end if;
      route_identity := '3:' || pg_catalog.lower(route_value ->> 'relationshipId')
        || ':' || pg_catalog.lower(route_value ->> 'sourcePermissionId');
    else
      return false;
    end if;

    -- One strictly-ascending adjacent-pair check encodes both Zod rules at
    -- once: a route array that is unique by identity AND in canonical order
    -- is exactly a route array whose identities strictly increase pairwise,
    -- and vice versa (strict monotonicity implies injectivity). This is the
    -- same combined check the ownership-visibility function used to run
    -- itself (20260906144015_evaluate_current_record_ownership_visibility.sql).
    if previous_route_identity is not null
      and (route_identity collate "C") <= (previous_route_identity collate "C") then
      return false;
    end if;
    previous_route_identity := route_identity;
  end loop;

  if has_all_records and route_count <> 1 then
    return false;
  end if;

  if p_record_scope ? 'savedCondition' then
    saved_condition := p_record_scope -> 'savedCondition';
    if pg_catalog.jsonb_typeof(saved_condition) <> 'object'
      or saved_condition - array[
        'conditionId', 'publishedRevision', 'contractFingerprint', 'parameterBindings'
      ]::text[] <> '{}'::jsonb
      or not (saved_condition ?& array[
        'conditionId', 'publishedRevision', 'contractFingerprint', 'parameterBindings'
      ])
      or pg_catalog.jsonb_typeof(saved_condition -> 'conditionId') <> 'string'
      or not vortex_platform.is_non_nil_uuid(saved_condition ->> 'conditionId')
      or pg_catalog.jsonb_typeof(saved_condition -> 'publishedRevision') <> 'number'
      or (saved_condition ->> 'publishedRevision') !~ '^[1-9][0-9]*$'
      or (saved_condition ->> 'publishedRevision')::numeric > 9007199254740991
      or pg_catalog.jsonb_typeof(saved_condition -> 'contractFingerprint') <> 'string'
      or (saved_condition ->> 'contractFingerprint') !~ '^sha256:[a-f0-9]{64}$'
      or pg_catalog.jsonb_typeof(saved_condition -> 'parameterBindings') <> 'array' then
      return false;
    end if;

    previous_binding_key := null;
    for binding_value in
      select item.value
      from pg_catalog.jsonb_array_elements(
        saved_condition -> 'parameterBindings'
      ) as item(value)
    loop
      if pg_catalog.jsonb_typeof(binding_value) <> 'object'
        or not (binding_value ? 'key')
        or pg_catalog.jsonb_typeof(binding_value -> 'key') <> 'string' then
        return false;
      end if;
      binding_key := binding_value ->> 'key';
      if binding_key !~ '^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$'
        or pg_catalog.length(binding_key) > 40 then
        return false;
      end if;
      select pg_catalog.count(*) into binding_key_count
      from pg_catalog.jsonb_object_keys(binding_value) as key;

      if not (binding_value ? 'source')
        or pg_catalog.jsonb_typeof(binding_value -> 'source') <> 'string' then
        return false;
      end if;

      if binding_value ->> 'source' = 'current_organization_account_id' then
        if binding_key_count <> 2 then
          return false;
        end if;
      elsif binding_value ->> 'source' = 'literal' then
        if binding_key_count <> 3 or not (binding_value ? 'value') then
          return false;
        end if;
      else
        return false;
      end if;

      if previous_binding_key is not null
        and (binding_key collate "C") <= (previous_binding_key collate "C") then
        return false;
      end if;
      previous_binding_key := binding_key;
    end loop;
  end if;

  return true;
end
$_$;

alter function vortex_access.permission_record_scope_is_valid(p_record_scope jsonb) owner to vortex_owner;

COMMENT ON FUNCTION vortex_access.permission_record_scope_is_valid(p_record_scope jsonb) IS 'Private strict validator for canonical unique record-scope routes, the sole all-record route rule and the saved-condition envelope shape.';

SET default_tablespace = '';

SET default_table_access_method = heap;

REVOKE ALL ON FUNCTION vortex_access.permission_record_scope_is_valid(p_record_scope jsonb) FROM PUBLIC;

grant execute on function vortex_access.permission_record_scope_is_valid(p_record_scope jsonb) to postgres;

create or replace function vortex_access.resolve_record_field_bounds_internal(
  p_decision jsonb
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  decision_organization_id uuid := (p_decision ->> 'organizationId')::uuid;
  contribution jsonb;
  contribution_permission jsonb;
  contribution_source jsonb;
  catalogue_entry vortex_access.permission_catalogue_entries%rowtype;
  policy_readable text[];
  policy_changeable text[];
  readable_ids text[] := array[]::text[];
  changeable_ids text[] := array[]::text[];
  contributed_bounds jsonb;
begin
  if p_decision ->> 'outcome' is distinct from 'allowed' then
    raise exception using errcode = '22023',
      message = 'Record field bounds require an allowed decision';
  end if;

  for contribution in
    select value
    from pg_catalog.jsonb_array_elements(p_decision -> 'matchedContributions') as item(value)
  loop
    contribution_permission := contribution -> 'permission';
    contribution_source := contribution -> 'source';

    -- The catalogue entry of the registration revision this contribution's
    -- decision names: the meaning the caller's role accepted, which may be
    -- older than the registered one. Its registration must still be active.
    select entry.*
    into catalogue_entry
    from vortex_access.permission_catalogue_entries as entry
    join vortex_access.permission_registrations as registration
      on registration.organization_id = entry.organization_id
      and registration.registration_kind = entry.registration_kind
      and registration.registration_owner_id = entry.registration_owner_id
      and entry.registration_revision <= registration.revision
      and registration.state = 'active'
    where entry.organization_id = decision_organization_id
      and entry.registration_revision = (contribution ->> 'registrationRevision')::bigint
      and entry.application_root_id = (contribution_permission ->> 'applicationRootId')::uuid
      and entry.owner_kind = contribution_permission ->> 'ownerKind'
      and entry.owner_id = (contribution_permission ->> 'ownerId')::uuid
      and entry.permission_id = (contribution_permission ->> 'permissionId')::uuid;

    -- The decision just used this exact permission; a missing catalogue
    -- entry now is an internal inconsistency, not an ordinary refusal.
    if not found then
      raise exception using errcode = '22023',
        message = 'Record field bounds found no catalogue entry';
    end if;

    -- The source release identity must still match the contribution before
    -- its field policy can be used.
    if catalogue_entry.registration_revision is distinct from
        (contribution ->> 'registrationRevision')::bigint
      or catalogue_entry.source_kind is distinct from (contribution_source ->> 'kind')
      or catalogue_entry.source_definition_key is distinct from (contribution_source ->> 'definitionKey')
      or catalogue_entry.source_root_id is distinct from (contribution_source ->> 'rootId')::uuid
      or catalogue_entry.source_version is distinct from (contribution_source ->> 'releaseVersion')
      or catalogue_entry.source_revision is distinct from (contribution_source ->> 'releaseRevision')::bigint
      or catalogue_entry.source_validation_contract_version
        is distinct from (contribution_source ->> 'validationContractVersion') then
      raise exception using errcode = '22023',
        message = 'Record field bounds found a superseded permission source';
    end if;

    -- No declared field policy means this contribution contributes no
    -- fields; it must not veto a different contribution that has one.
    if catalogue_entry.field_policy is null then
      continue;
    end if;

    -- Every route contributes the permission's field policy as declared.
    select pg_catalog.array_agg(pg_catalog.lower(field.value))
    into policy_readable
    from pg_catalog.jsonb_array_elements_text(
      catalogue_entry.field_policy -> 'readableFieldIds'
    ) as field(value);

    select pg_catalog.array_agg(pg_catalog.lower(field.value))
    into policy_changeable
    from pg_catalog.jsonb_array_elements_text(
      catalogue_entry.field_policy -> 'changeableFieldIds'
    ) as field(value);

    readable_ids := readable_ids || coalesce(policy_readable, array[]::text[]);
    changeable_ids := changeable_ids || coalesce(policy_changeable, array[]::text[]);
  end loop;

  -- The fields other installed Modules contributed to this record's type, where the person
  -- also holds the contributor's own permission for them. They only extend what the owner's
  -- permissions already allowed for this record.
  contributed_bounds := vortex_access.contributed_field_bounds_internal(p_decision);
  readable_ids := readable_ids || array(
    select item.value from pg_catalog.jsonb_array_elements_text(
      contributed_bounds -> 'readableFieldIds'
    ) as item(value)
  );
  changeable_ids := changeable_ids || array(
    select item.value from pg_catalog.jsonb_array_elements_text(
      contributed_bounds -> 'changeableFieldIds'
    ) as item(value)
  );

  readable_ids := array(
    select distinct field.value
    from pg_catalog.unnest(readable_ids) as field(value)
    order by field.value
  );
  -- Changeable never exceeds readable, because every contribution's own
  -- changeable set already sits inside its own readable set: the policy
  -- validator enforces that for a permission. Unioning subsets preserves it,
  -- so this only canonicalises.
  changeable_ids := array(
    select distinct field.value
    from pg_catalog.unnest(changeable_ids) as field(value)
    order by field.value
  );

  return pg_catalog.jsonb_build_object(
    'readableFieldIds', pg_catalog.to_jsonb(readable_ids),
    'changeableFieldIds', pg_catalog.to_jsonb(changeable_ids)
  );
end
$function$;

revoke execute on function vortex_access.resolve_record_field_bounds_internal(jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

grant execute on function vortex_access.resolve_record_field_bounds_internal(jsonb)
  to vortex_record_adapter, postgres;

comment on function vortex_access.resolve_record_field_bounds_internal(jsonb) is
  'Private field-bounds resolution over one allowed exact-record access decision; looks each contribution''s field policy up from the permission catalogue itself at the registration revision the decision accepted, never from a caller-supplied declaration.';

alter function vortex_access.resolve_record_field_bounds_internal(jsonb)
  owner to vortex_owner;

create or replace function vortex_access.resolve_record_read_field_bounds_internal(
  p_declaration jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  -- Nothing guaranteed and no exactness claim: the fail-closed answer.
  nothing constant jsonb := '{"readableFieldIds":[],"coversAllRecords":false,"conditionFree":false}'::jsonb;
  ctx jsonb;
  checked_at timestamptz;
  decision_organization_id uuid;
  account_id uuid;
  binding jsonb;
  eligibility jsonb;
  candidate jsonb;
  permission_value jsonb;
  source_value jsonb;
  routes jsonb;
  route jsonb;
  catalogue_entry vortex_access.permission_catalogue_entries%rowtype;
  policy_readable text[];
  route_readable text[];
  guaranteed text[] := array[]::text[];
  every_record_readable text[] := array[]::text[];
  contributed_readable text[];
  first_route boolean := true;
  covers_all_records boolean := false;
  condition_free boolean := true;
begin
  -- The planner only knows how to reason about a record read; anything else is
  -- a caller error, never a wider grant.
  if p_declaration is null
    or pg_catalog.jsonb_typeof(p_declaration) <> 'object'
    or p_declaration -> 'action' ->> 'actionKind' is distinct from 'read'
    or (p_declaration -> 'action') ? 'namedAction' then
    raise exception using errcode = '22023',
      message = 'Record read field-bounds declaration is invalid';
  end if;

  ctx := vortex_access.validated_human_request_context();
  checked_at := pg_catalog.clock_timestamp();
  decision_organization_id := (ctx ->> 'organizationId')::uuid;
  account_id := (ctx ->> 'organizationAccountId')::uuid;
  binding := p_declaration -> 'recordBinding';

  eligibility := vortex_access.evaluate_organization_record_permission_eligibility_internal(
    p_declaration, ctx, checked_at
  );

  -- An ineligible caller is admitted to no record, so it is guaranteed no
  -- field and nothing may be pushed.
  if eligibility ->> 'outcome' <> 'eligible' then
    return nothing;
  end if;

  -- Each record is admitted by at least one (alternative, route) pair, and the
  -- exact decision exposes the union of the fields of the pairs that admit it.
  -- A field is therefore guaranteed on every admitted record only when every
  -- pair that can admit a record exposes it: the intersection over every pair,
  -- never a union within one alternative. An ownership, all-records or
  -- relationship pair exposes its permission's policy. Any unknown route fails
  -- closed. An
  -- all-records alternative without a saved condition admits every record, so
  -- its policy's fields are visible on every record whatever else admits it:
  -- they are guaranteed even when another alternative exposes fewer, so an
  -- added read of one sensitive field never hides the ordinary fields.
  for candidate in
    select listed.value
    from pg_catalog.jsonb_array_elements(
      coalesce(eligibility -> 'eligiblePermissions', '[]'::jsonb)
    ) as listed(value)
  loop
    permission_value := candidate -> 'permission';
    source_value := candidate -> 'source';

    -- The meaning the caller's role accepted, at the registration revision the
    -- eligibility names; its registration must still be active.
    select entry.*
    into catalogue_entry
    from vortex_access.permission_catalogue_entries as entry
    join vortex_access.permission_registrations as registration
      on registration.organization_id = entry.organization_id
      and registration.registration_kind = entry.registration_kind
      and registration.registration_owner_id = entry.registration_owner_id
      and entry.registration_revision <= registration.revision
      and registration.state = 'active'
    where entry.organization_id = decision_organization_id
      and entry.registration_revision = (candidate ->> 'registrationRevision')::bigint
      and entry.application_root_id = (permission_value ->> 'applicationRootId')::uuid
      and entry.owner_kind = permission_value ->> 'ownerKind'
      and entry.owner_id = (permission_value ->> 'ownerId')::uuid
      and entry.permission_id = (permission_value ->> 'permissionId')::uuid;

    -- The eligibility decision just used this exact permission; a missing or
    -- superseded catalogue entry is an internal inconsistency, not a refusal
    -- that silently widens what may be pushed.
    if not found then
      raise exception using errcode = '22023',
        message = 'Record read field bounds found no catalogue entry';
    end if;

    if catalogue_entry.registration_revision is distinct from
        (candidate ->> 'registrationRevision')::bigint
      or catalogue_entry.source_kind is distinct from (source_value ->> 'kind')
      or catalogue_entry.source_definition_key is distinct from (source_value ->> 'definitionKey')
      or catalogue_entry.source_root_id is distinct from (source_value ->> 'rootId')::uuid
      or catalogue_entry.source_version is distinct from (source_value ->> 'releaseVersion')
      or catalogue_entry.source_revision is distinct from (source_value ->> 'releaseRevision')::bigint
      or catalogue_entry.source_validation_contract_version
        is distinct from (source_value ->> 'validationContractVersion') then
      raise exception using errcode = '22023',
        message = 'Record read field bounds found a superseded permission source';
    end if;

    -- A permission with no declared field policy contributes no field at all,
    -- so nothing is guaranteed for the whole record type.
    if catalogue_entry.field_policy is null then
      return nothing;
    end if;

    select coalesce(pg_catalog.array_agg(pg_catalog.lower(field.value)), array[]::text[])
    into policy_readable
    from pg_catalog.jsonb_array_elements_text(
      catalogue_entry.field_policy -> 'readableFieldIds'
    ) as field(value);

    routes := candidate -> 'recordScope' -> 'routes';
    if pg_catalog.jsonb_typeof(routes) is distinct from 'array' then
      return nothing;
    end if;

    -- A saved condition narrows every route of its alternative, including an
    -- all-records route, per record; the scan's table narrowing cannot apply it.
    if (candidate -> 'recordScope') ? 'savedCondition' then
      condition_free := false;
    elsif exists (
      select 1 from pg_catalog.jsonb_array_elements(routes) as listed_route(value)
      where listed_route.value ->> 'kind' = 'all_records'
    ) then
      covers_all_records := true;
      every_record_readable := every_record_readable || policy_readable;
    end if;

    for route in
      select listed_route.value
      from pg_catalog.jsonb_array_elements(routes) as listed_route(value)
    loop
      case route ->> 'kind'
        when 'all_records', 'ownership', 'relationship' then
          route_readable := policy_readable;
        else
          return nothing;
      end case;

      if first_route then
        guaranteed := array(
          select distinct field.value
          from pg_catalog.unnest(route_readable) as field(value)
        );
        first_route := false;
      else
        guaranteed := array(
          select field.value
          from pg_catalog.unnest(guaranteed) as field(value)
          where field.value = any (route_readable)
        );
      end if;
    end loop;
  end loop;

  -- A field another installed Module contributed to this record type is visible on every record
  -- the owner's decision admits when the person holds the contributor's own unconditional read
  -- grant for it, so it is guaranteed whichever owner route admitted the record. The one
  -- contributor evaluator also serves the exact-record bounds; it never changes which records
  -- are admitted.
  select coalesce(pg_catalog.array_agg(pg_catalog.lower(field.value)), array[]::text[])
  into contributed_readable
  from pg_catalog.jsonb_array_elements_text(
    vortex_access.contributor_field_grants_internal(
      decision_organization_id,
      (binding ->> 'moduleRootId')::uuid,
      (binding ->> 'storageContractId')::uuid,
      'read'
    ) -> 'readableFieldIds'
  ) as field(value);

  guaranteed := array(
    select distinct field.value
    from pg_catalog.unnest(guaranteed || every_record_readable || contributed_readable) as field(value)
    order by field.value
  );

  return pg_catalog.jsonb_build_object(
    'readableFieldIds', pg_catalog.to_jsonb(guaranteed),
    'coversAllRecords', covers_all_records,
    'conditionFree', condition_free
  );
end
$function$;

revoke all on function vortex_access.resolve_record_read_field_bounds_internal(jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_access.resolve_record_read_field_bounds_internal(jsonb)
  to vortex_record_adapter;

comment on function vortex_access.resolve_record_read_field_bounds_internal(jsonb) is
  'Private whole-record-type field bounds for the fixed record query: from the caller''s own current eligible read alternatives it returns the fields every alternative route is guaranteed to expose on every record it can admit (the intersection over every alternative and route), plus every field of an all-records alternative without a saved condition, since it admits every record, plus each field another installed Module contributed that the person holds an unconditional read grant for, whether an unconditioned all-records alternative admits every active record, and whether no alternative carries a saved condition; any unknown route or missing policy yields no fields. It only decides which fields a scan may order or filter by and never decides access.';

alter function vortex_access.resolve_record_read_field_bounds_internal(jsonb)
  owner to vortex_owner;

create or replace function vortex_access.resolve_record_read_scan_routes_internal(
  p_declaration jsonb,
  p_ownership_mode text
)
returns table (
  restricted boolean,
  owner_account_id uuid,
  owner_group_ids uuid[],
  shared_record_ids uuid[],
  alternatives jsonb
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  ctx jsonb;
  checked_at timestamptz;
  routes jsonb;
  eligibility jsonb;
  candidate jsonb;
  route jsonb;
  route_kind text;
  account_id uuid;
  member_group_ids uuid[];
  wants_owner boolean := false;
  -- Every route of every eligible alternative has an exact stored predicate, so
  -- a condition-free scan examines only rows the exact decision admits. When
  -- any route does not, that route's term is left true in the scan plan and no
  -- field is taken as readable for every scanned row.
  pushable boolean := true;
  alternatives jsonb := '[]'::jsonb;
begin
  if p_declaration is null
    or pg_catalog.jsonb_typeof(p_declaration) <> 'object'
    or p_declaration -> 'action' ->> 'actionKind' is distinct from 'read'
    or (p_declaration -> 'action') ? 'namedAction'
    or p_ownership_mode is null
    or p_ownership_mode not in ('none', 'organization_account', 'group', 'inherited') then
    raise exception using errcode = '22023',
      message = 'Record read scan declaration is invalid';
  end if;

  -- The same one context and time sample the exact-record decision uses, and
  -- the same eligibility core: the eligible alternatives here are exactly the
  -- ones that decision would union for any single record.
  ctx := vortex_access.validated_human_request_context();
  checked_at := pg_catalog.clock_timestamp();
  account_id := (ctx ->> 'organizationAccountId')::uuid;

  eligibility := vortex_access.evaluate_organization_record_permission_eligibility_internal(
    p_declaration, ctx, checked_at
  );

  -- An ineligible caller is refused for every record by that decision. The
  -- empty alternative list narrows the scan to nothing; the exact decision
  -- would refuse every row anyway.
  if eligibility ->> 'outcome' <> 'eligible' then
    return query select true, null::uuid, array[]::uuid[], array[]::uuid[], '[]'::jsonb;
    return;
  end if;

  -- One alternative per eligible permission, reduced to the two facts the scan
  -- plan consumes: its exact route list and its saved-condition envelope. A
  -- route list that is not an array is never reasoned about; returning a null
  -- alternative list leaves the scan unrestricted.
  for candidate in
    select item.value
    from pg_catalog.jsonb_array_elements(eligibility -> 'eligiblePermissions') as item(value)
  loop
    routes := candidate -> 'recordScope' -> 'routes';
    if pg_catalog.jsonb_typeof(routes) is distinct from 'array' then
      return query select false, null::uuid, array[]::uuid[], array[]::uuid[], null::jsonb;
      return;
    end if;
    alternatives := alternatives || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'routes', routes,
      'savedCondition', case
        when candidate -> 'recordScope' ? 'savedCondition'
          then candidate -> 'recordScope' -> 'savedCondition'
        else null::jsonb
      end
    ));
    for route in
      select item.value from pg_catalog.jsonb_array_elements(routes) as item(value)
    loop
      route_kind := route ->> 'kind';
      if route_kind = 'ownership' then
        wants_owner := true;
        if p_ownership_mode not in ('organization_account', 'group') then
          -- An inherited owner is reached only by a current-edge chase, and an
          -- ownership route over a record type that stores no owner admits no
          -- record: neither is a fixed stored predicate.
          pushable := false;
        end if;
      else
        -- all_records admits every record; a relationship route is a
        -- relationship chase. Neither is a fixed stored predicate, so the scan
        -- is left unrestricted and the exact decision alone narrows it.
        pushable := false;
      end if;
    end loop;
  end loop;

  -- The groups the caller belongs to now: an active group and a live,
  -- started, unexpired membership, as the ownership test requires.
  select coalesce(pg_catalog.array_agg(distinct membership.group_id), array[]::uuid[])
  into member_group_ids
  from vortex_access.organization_group_memberships as membership
  join vortex_access.organization_groups as organization_group
    on organization_group.organization_id = membership.organization_id
    and organization_group.group_id = membership.group_id
    and organization_group.state = 'active'
  where membership.organization_id = (ctx ->> 'organizationId')::uuid
    and membership.organization_account_id = account_id
    and membership.state = 'live'
    and membership.starts_at <= checked_at
    and (membership.expires_at is null or membership.expires_at > checked_at);

  return query select
    pushable,
    case when wants_owner and p_ownership_mode = 'organization_account'
      then account_id else null::uuid end,
    case when wants_owner and p_ownership_mode = 'group'
      then member_group_ids else array[]::uuid[] end,
    -- No route narrows by record identity, so the shared-record slot is null.
    null::uuid[],
    alternatives;
end
$function$;

revoke all on function vortex_access.resolve_record_read_scan_routes_internal(jsonb, text)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_access.resolve_record_read_scan_routes_internal(jsonb, text)
  to vortex_record_adapter;

comment on function vortex_access.resolve_record_read_scan_routes_internal(jsonb, text) is
  'Private read-scan narrowing for the fixed record adapter: from the caller''s own current eligible read alternatives it returns the owner account and owner groups (the shared-record slot is always null), the eligible alternatives reduced to their route lists and saved-condition envelopes, and whether every route has an exact stored predicate; it only narrows candidates and never replaces the exact-record decision.';

alter function vortex_access.resolve_record_read_scan_routes_internal(jsonb, text)
  owner to vortex_owner;

create or replace function vortex_platform.grid_view_document_for_viewer_internal(
  p_query_id uuid, p_document jsonb, p_installation jsonb, p_plan jsonb, p_visible_fields jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  context_value jsonb;
  record_type_id uuid;
  declaration jsonb;
  eligibility jsonb;
  readable text[] := '{}'::text[];
  filters jsonb;
  sorts jsonb;
  formatting jsonb;
  omitted integer := 0;
  omitted_sorts integer := 0;
  omitted_formatting integer := 0;
  document jsonb := p_document;
begin
  if pg_catalog.jsonb_array_length(p_document -> 'filters') = 0
    and pg_catalog.jsonb_array_length(p_document -> 'sort') = 0
    and pg_catalog.jsonb_array_length(p_document -> 'formatting') = 0 then
    return pg_catalog.jsonb_build_object(
      'document', document, 'hiddenFilters', 0, 'hiddenSorts', 0, 'hiddenFormatting', 0);
  end if;
  context_value := vortex_access.validated_human_request_context();
  -- Resolve only releases pinned by this validated installation, including record-type listings.
  select target.record_type_id into record_type_id
  from (
    select distinct (query.value #>> '{recordType,recordTypeId}')::uuid as record_type_id
    from pg_catalog.jsonb_array_elements(p_installation -> 'moduleBindings') as binding(value)
    join vortex_definition.releases as release
      on release.root_id = (binding.value ->> 'moduleRootId')::uuid
      and release.release_revision = (binding.value ->> 'moduleReleaseRevision')::bigint
    cross join lateral pg_catalog.jsonb_array_elements(
      release.compilation_output #> '{canonical,content,queries}'
    ) as query(value)
    where (query.value ->> 'queryId')::uuid = p_query_id
    union
    select p_query_id
    where p_plan -> 'recordTypes' ? pg_catalog.lower(p_query_id::text)
  ) as target;
  if record_type_id is not null then
    declaration := vortex_record.record_type_read_declaration_internal(
      p_plan, record_type_id, (context_value ->> 'applicationRootId')::uuid
    );
    if declaration is not null then
      -- A saved operand stays only on a field every record the reader reaches exposes (the query
      -- engine's field bounds) and the reader's column
      -- decision (the visible fields) offers.
      eligibility := vortex_access.resolve_record_read_field_bounds_internal(declaration);
      select coalesce(pg_catalog.array_agg(pg_catalog.lower(field.value)), '{}'::text[])
      into readable
      from pg_catalog.jsonb_array_elements_text(eligibility -> 'readableFieldIds') as field(value)
      where coalesce(p_visible_fields -> pg_catalog.lower(record_type_id::text), '[]'::jsonb)
        ? pg_catalog.lower(field.value);
    end if;
  end if;
  if p_document ? 'filters' then
    select coalesce(pg_catalog.jsonb_agg(filter.value order by filter.ordinal), '[]'::jsonb)
    into filters
    from pg_catalog.jsonb_array_elements(p_document -> 'filters')
      with ordinality as filter(value, ordinal)
    where pg_catalog.lower(filter.value ->> 'fieldId') = any(readable);
    omitted := pg_catalog.jsonb_array_length(p_document -> 'filters') - pg_catalog.jsonb_array_length(filters);
    document := document || pg_catalog.jsonb_build_object('filters', filters);
  end if;
  if p_document ? 'sort' then
    select coalesce(pg_catalog.jsonb_agg(sort.value order by sort.ordinal), '[]'::jsonb)
    into sorts
    from pg_catalog.jsonb_array_elements(p_document -> 'sort')
      with ordinality as sort(value, ordinal)
    where pg_catalog.lower(sort.value ->> 'fieldId') = any(readable);
    omitted_sorts := pg_catalog.jsonb_array_length(p_document -> 'sort') - pg_catalog.jsonb_array_length(sorts);
    document := document || pg_catalog.jsonb_build_object('sort', sorts);
  end if;
  if p_document ? 'formatting' then
    -- A rule leaves with everything it stores (its comparison values and targets) unless every
    -- field it reads, in its condition or its cells, is one this viewer can read now.
    select coalesce(pg_catalog.jsonb_agg(rule.value order by rule.ordinal), '[]'::jsonb)
    into formatting
    from pg_catalog.jsonb_array_elements(p_document -> 'formatting')
      with ordinality as rule(value, ordinal)
    where vortex_platform.grid_view_condition_field_ids_internal(rule.value -> 'condition', 1) is not null
      and not exists (
        select 1
        from pg_catalog.unnest(
          vortex_platform.grid_view_condition_field_ids_internal(rule.value -> 'condition', 1)
          || array(select pg_catalog.lower(cell.value)
            from pg_catalog.jsonb_array_elements_text(rule.value -> 'target' -> 'fields') as cell(value))
        ) as used(field_id)
        where used.field_id <> all (readable)
      );
    omitted_formatting := pg_catalog.jsonb_array_length(p_document -> 'formatting')
      - pg_catalog.jsonb_array_length(formatting);
    document := document || pg_catalog.jsonb_build_object('formatting', formatting);
  end if;
  if omitted > 0 or omitted_sorts > 0 or omitted_formatting > 0 then
    raise log 'Grid view state omitted code=GRID_VIEW_FIELDS_WITHHELD filters=% sorts=% formatting=%',
      omitted, omitted_sorts, omitted_formatting;
  end if;
  return pg_catalog.jsonb_build_object(
    'document', document, 'hiddenFilters', omitted, 'hiddenSorts', omitted_sorts,
    'hiddenFormatting', omitted_formatting);
end
$function$;

revoke all on function vortex_platform.grid_view_document_for_viewer_internal(uuid, jsonb, jsonb, jsonb, jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;
alter function vortex_platform.grid_view_document_for_viewer_internal(uuid, jsonb, jsonb, jsonb, jsonb)
  owner to vortex_owner;
comment on function vortex_platform.grid_view_document_for_viewer_internal(uuid, jsonb, jsonb, jsonb, jsonb) is
  'Removes saved filter values, sorts and formatting rules outside the reader''s current column decision and field bounds before a selected document leaves the database; owner-only, with counts for the omission notice.';

create or replace function vortex_record.resolve_record_type_visible_field_ids_internal(
  p_record_type_id uuid, p_plan jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  ctx jsonb := vortex_access.validated_human_request_context();
  checked_at timestamptz := pg_catalog.clock_timestamp();
  declaration jsonb;
  eligibility jsonb;
  candidate jsonb;
  source_value jsonb;
  route jsonb;
  catalogue_entry vortex_access.permission_catalogue_entries%rowtype;
  policy_readable text[];
  routes jsonb;
  visible text[] := array[]::text[];
begin
  -- Owner-only: the decision below is local to this call. No GUC, temporary
  -- table or argument can supply or retain an access decision.
  declaration := vortex_record.record_type_read_declaration_internal(
    p_plan, p_record_type_id, (ctx ->> 'applicationRootId')::uuid
  );
  if declaration is null then
    return '[]'::jsonb;
  end if;
  eligibility := vortex_access.evaluate_organization_record_permission_eligibility_internal(
    declaration, ctx, checked_at
  );
  if eligibility ->> 'outcome' is distinct from 'eligible' then
    return '[]'::jsonb;
  end if;

  -- A column is decided by access route, never record by record: it is visible
  -- when at least one (permission, route) pair the reader holds exposes it. An
  -- all-records, ownership or relationship route exposes its permission's
  -- declared readable fields. An unknown route kind contributes nothing.
  for candidate in
    select listed.value
    from pg_catalog.jsonb_array_elements(
      coalesce(eligibility -> 'eligiblePermissions', '[]'::jsonb)
    ) as listed(value)
  loop
    source_value := candidate -> 'source';
    -- The meaning the caller's role accepted, at the registration revision the
    -- eligibility names; its registration must still be active.
    select entry.* into catalogue_entry
    from vortex_access.permission_catalogue_entries as entry
    join vortex_access.permission_registrations as registration
      on registration.organization_id = entry.organization_id
      and registration.registration_kind = entry.registration_kind
      and registration.registration_owner_id = entry.registration_owner_id
      and entry.registration_revision <= registration.revision
      and registration.state = 'active'
    where entry.organization_id = (ctx ->> 'organizationId')::uuid
      and entry.registration_revision = (candidate ->> 'registrationRevision')::bigint
      and entry.application_root_id = (candidate #>> '{permission,applicationRootId}')::uuid
      and entry.owner_kind = candidate #>> '{permission,ownerKind}'
      and entry.owner_id = (candidate #>> '{permission,ownerId}')::uuid
      and entry.permission_id = (candidate #>> '{permission,permissionId}')::uuid;
    if not found then
      raise exception using errcode = '22023',
        message = 'Record field visibility found no catalogue entry';
    end if;
    if catalogue_entry.source_kind is distinct from (source_value ->> 'kind')
      or catalogue_entry.source_definition_key is distinct from (source_value ->> 'definitionKey')
      or catalogue_entry.source_root_id is distinct from (source_value ->> 'rootId')::uuid
      or catalogue_entry.source_version is distinct from (source_value ->> 'releaseVersion')
      or catalogue_entry.source_revision is distinct from (source_value ->> 'releaseRevision')::bigint
      or catalogue_entry.source_validation_contract_version
        is distinct from (source_value ->> 'validationContractVersion') then
      raise exception using errcode = '22023',
        message = 'Record field visibility found a superseded permission source';
    end if;
    -- No declared field policy contributes no field, as the record decision does.
    select coalesce(pg_catalog.array_agg(pg_catalog.lower(field.value)), array[]::text[])
    into policy_readable
    from pg_catalog.jsonb_array_elements_text(
      coalesce(catalogue_entry.field_policy -> 'readableFieldIds', '[]'::jsonb)
    ) as field(value);
    if pg_catalog.cardinality(policy_readable) = 0 then
      continue;
    end if;
    routes := candidate -> 'recordScope' -> 'routes';
    if pg_catalog.jsonb_typeof(routes) is distinct from 'array' then
      continue;
    end if;
    for route in select item.value from pg_catalog.jsonb_array_elements(routes) as item(value)
    loop
      if route ->> 'kind' in ('all_records', 'ownership', 'relationship') then
        visible := visible || policy_readable;
      end if;
    end loop;
  end loop;

  -- The upper bound, then the one rule for produced fields: a calculation or
  -- total the reader cannot fully read stays withheld.
  return vortex_record.decide_visible_produced_field_ids_internal(
    p_plan, p_record_type_id,
    coalesce((
      select pg_catalog.jsonb_agg(ids.value order by ids.value)
      from (select distinct listed.value from pg_catalog.unnest(visible) as listed(value)) as ids
    ), '[]'::jsonb)
  );
end
$function$;

alter function vortex_record.resolve_record_type_visible_field_ids_internal(uuid, jsonb)
  owner to vortex_owner;
revoke all on function vortex_record.resolve_record_type_visible_field_ids_internal(uuid, jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;

comment on function vortex_record.resolve_record_type_visible_field_ids_internal(uuid, jsonb) is
  'Owner-only column visibility of one record type for the validated human context, decided by access route: the declared readable fields of each eligible permission route, then the produced-field rule. It reads no record, so its cost is bounded by routes.';

drop table vortex_access.organization_direct_record_shares;
drop function vortex_access.protect_organization_direct_record_share();
drop function vortex_access.validate_organization_direct_record_share_insert();
drop function vortex_access.read_current_direct_record_share_contributions(uuid, uuid, uuid, uuid, uuid, text, uuid, uuid, uuid, uuid, timestamptz);

-- No writer records a direct-share access change any more.
alter table vortex_access.organization_access_versions
  drop constraint organization_access_versions_reason_valid,
  add constraint organization_access_versions_reason_valid check (change_reason = any (array[
    'organization_initialized', 'organization_account_activated',
    'organization_account_reactivated', 'organization_account_suspended',
    'organization_account_closed', 'role_assignment_changed', 'role_activation_changed',
    'delegation_changed', 'stewardship_changed', 'invitation_access_accepted',
    'role_catalogue_changed', 'group_membership_changed', 'application_access_changed',
    'record_ownership_changed', 'access_grant_changed', 'public_policy_changed',
    'federation_mirror_changed', 'mcp_authorization_changed'
  ]::text[]));

set role vortex_record_adapter;

create or replace function vortex_record.decide_choice_option_permission(
  p_record_type_id uuid,
  p_permission_id uuid,
  p_record_id uuid
)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  context_value jsonb;
  meta jsonb;
  entry_count integer;
  entry record;
  declaration jsonb;
  eligibility jsonb;
  loaded jsonb;
  decision jsonb;
begin
  if p_record_type_id is null
    or p_record_type_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_permission_id is null
    or p_permission_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_record_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using errcode = '22023', message = 'Choice option permission selector is invalid';
  end if;

  context_value := vortex_access.validated_human_request_context();
  if not context_value ? 'applicationRootId' then
    raise exception using errcode = '42501',
      message = 'A choice option permission requires an Application context';
  end if;

  -- The record-owning Module and the record's exact storage identity come from the installed
  -- release, never from the caller.
  meta := vortex_record.resolve_record_action_context_internal(p_record_type_id, 'update');
  if pg_catalog.jsonb_typeof(meta -> 'recordType') is distinct from 'object' then
    return false;
  end if;

  -- The option permission is a record-type permission the record-owning Module declares in its
  -- installed release; its action is whatever the release declares, so one decision serves a named
  -- action and a standard one.
  select pg_catalog.count(*) into entry_count
  from vortex_definition.runtime_releases as release
  cross join lateral pg_catalog.jsonb_array_elements(
    coalesce(release.record_content -> 'permissions', '[]'::jsonb)
  ) as item(value)
  where release.root_id = (meta ->> 'moduleRootId')::uuid
    and release.release_revision = (meta ->> 'moduleReleaseRevision')::bigint
    and (item.value ->> 'permissionId')::uuid = p_permission_id
    and (item.value ->> 'recordTypeId')::uuid = p_record_type_id;
  if entry_count <> 1 then
    raise log 'Choice option permission refused: % declarations of permission % for record type %',
      entry_count, p_permission_id, p_record_type_id;
    return false;
  end if;
  select item.value ->> 'actionKind' as action_kind, item.value ->> 'namedAction' as named_action
  into strict entry
  from vortex_definition.runtime_releases as release
  cross join lateral pg_catalog.jsonb_array_elements(release.record_content -> 'permissions') as item(value)
  where release.root_id = (meta ->> 'moduleRootId')::uuid
    and release.release_revision = (meta ->> 'moduleReleaseRevision')::bigint
    and (item.value ->> 'permissionId')::uuid = p_permission_id
    and (item.value ->> 'recordTypeId')::uuid = p_record_type_id;

  declaration := pg_catalog.jsonb_build_object(
    'operationKey', 'record.choice_option',
    'action', case when entry.named_action is null
      then pg_catalog.jsonb_build_object('actionKind', entry.action_kind)
      else pg_catalog.jsonb_build_object(
        'actionKind', entry.action_kind, 'namedAction', entry.named_action
      ) end,
    'target', pg_catalog.jsonb_build_object(
      'kind', 'application',
      'applicationRootId', (context_value ->> 'applicationRootId')::uuid
    ),
    'requiredPermissions', pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'applicationRootId', (context_value ->> 'applicationRootId')::uuid,
        'ownerKind', 'module',
        'ownerId', (meta ->> 'moduleRootId')::uuid,
        'permissionId', p_permission_id
      )
    ),
    'recordBinding', pg_catalog.jsonb_build_object(
      'moduleRootId', (meta ->> 'moduleRootId')::uuid,
      'recordTypeId', p_record_type_id,
      'storageContractId', (meta ->> 'storageContractId')::uuid,
      'storageScope', meta ->> 'storageScope'
    ),
    'recentAuthentication', pg_catalog.jsonb_build_object('kind', 'none'),
    'authority', pg_catalog.jsonb_build_object('kind', 'permission')
  );

  eligibility := vortex_access.evaluate_organization_record_permission_eligibility_internal(
    declaration, context_value, pg_catalog.clock_timestamp()
  );
  if eligibility ->> 'outcome' is distinct from 'eligible' then
    raise log 'Choice option permission refused for permission % on record type %: %',
      p_permission_id, p_record_type_id, eligibility ->> 'reasonCode';
    return false;
  end if;

  -- A role that grants the permission on every record, with no saved condition, decides it for any
  -- record, a new one included.
  if exists (
    select 1
    from pg_catalog.jsonb_array_elements(eligibility -> 'eligiblePermissions') as alternative(value)
    where pg_catalog.jsonb_typeof(alternative.value -> 'recordScope') = 'object'
      and not (alternative.value -> 'recordScope' ? 'savedCondition')
      and coalesce(
        alternative.value -> 'recordScope' -> 'routes' @> '[{"kind":"all_records"}]'::jsonb,
        false
      )
  ) then
    return true;
  end if;

  -- A narrower record scope is decided only against the stored record it applies to, through the
  -- same record access evaluation every record action uses. A new record has none yet, and a scope
  -- that needs facts beyond the record itself (a relationship or a saved condition) is not offered.
  if p_record_id is null then
    raise log 'Choice option permission refused for permission % on record type %: record scope needs a stored record',
      p_permission_id, p_record_type_id;
    return false;
  end if;
  if exists (
    select 1
    from pg_catalog.jsonb_array_elements(eligibility -> 'eligiblePermissions') as alternative(value)
    where pg_catalog.jsonb_typeof(alternative.value -> 'recordScope' -> 'routes') is distinct from 'array'
      or alternative.value -> 'recordScope' ? 'savedCondition'
      or exists (
        select 1
        from pg_catalog.jsonb_array_elements(
          case when pg_catalog.jsonb_typeof(alternative.value -> 'recordScope' -> 'routes') = 'array'
            then alternative.value -> 'recordScope' -> 'routes' else '[]'::jsonb end
        ) as route(value)
        where coalesce(route.value ->> 'kind', '') not in ('all_records', 'ownership')
      )
  ) then
    raise log 'Choice option permission refused for permission % on record type %: record scope is not decided by the record alone',
      p_permission_id, p_record_type_id;
    return false;
  end if;

  loaded := (vortex_record.load_record_access_facts_internal(
    'update', pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'recordTypeId', p_record_type_id,
      'recordId', p_record_id
    ))
  ) -> 0);
  if loaded ->> 'outcome' is distinct from 'loaded' then
    raise log 'Choice option permission refused for permission % on record %: record facts %',
      p_permission_id, p_record_id, coalesce(loaded ->> 'outcome', 'unavailable');
    return false;
  end if;
  decision := vortex_access.evaluate_record_access_with_validated_types_internal(
    declaration, p_record_id, loaded -> 'facts', null, null
  );
  if decision ->> 'outcome' is distinct from 'allowed' then
    raise log 'Choice option permission refused for permission % on record %: %',
      p_permission_id, p_record_id, decision ->> 'reasonCode';
    return false;
  end if;
  return true;
end
$function$;

alter function vortex_record.decide_choice_option_permission(uuid, uuid, uuid) owner to vortex_record_adapter;

revoke all on function vortex_record.decide_choice_option_permission(uuid, uuid, uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_record.decide_choice_option_permission(uuid, uuid, uuid)
  to vortex_runtime, vortex_request;
comment on function vortex_record.decide_choice_option_permission(uuid, uuid, uuid) is
  'The one decision whether the signed-in person may use a choice option gated by a record-type permission, for one stored record or (with no record) a new one; the offered list and the form save both ask it.';

create or replace function vortex_record.plan_record_read_scan_internal(
  p_record_type_id uuid
)
returns table (
  restricted boolean,
  owner_account_id uuid,
  owner_group_ids uuid[],
  shared_record_ids uuid[],
  readable_field_ids text[],
  access_predicate text,
  access_parameters jsonb,
  bound_field_ids text[]
)
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  nil_uuid constant uuid := '00000000-0000-0000-0000-000000000000'::uuid;
  context_value jsonb;
  context_organization_id uuid;
  context_application_root_id uuid;
  context_account_id uuid;
  plan jsonb;
  target_meta jsonb;
  declaration jsonb;
  field_bounds jsonb;
  ownership_mode text;
  access_routes record;
  alternative jsonb;
  route jsonb;
  route_terms text[];
  route_sql text;
  alternative_terms text[] := array[]::text[];
  condition_sql text;
  condition_entry jsonb;
  condition_params jsonb;
  condition_field_types jsonb;
  condition_field_columns jsonb;
  condition_field_database_types jsonb;
  condition_field_definitions jsonb;
  condition_parameter_types jsonb;
  condition_parameter_values jsonb;
  condition_referenced_ids text[];
  declared_condition_ids text[];
  field_item jsonb;
  declaration_item jsonb;
  binding_item jsonb;
  field_id text;
  field_kind text;
  semantic_type text;
  column_entry jsonb;
  database_value_type text;
  parameter_offset integer;
  supported boolean;
  compiled jsonb;
  readable_field_ids_value text[];
  access_parameters_accum jsonb := '[]'::jsonb;
  access_predicate_value text := 'true';
  access_parameters_value jsonb := '[]'::jsonb;
  failure_sqlstate text;
  failure_message text;
begin
  -- Narrowing only. A refusal or unsupported condition named below leaves the
  -- scan less selective, so the exact per-row decision is still what decides
  -- what a caller reads. Any other failure propagates with its cause: it is
  -- never turned into an unrestricted scan.
  if p_record_type_id is null or p_record_type_id = nil_uuid then
    raise exception using errcode = '22023',
      message = 'Record adapter selector is invalid';
  end if;

  context_value := vortex_access.validated_human_request_context();
  if not (context_value ? 'applicationRootId') then
    raise exception using errcode = '42501',
      message = 'Record adapter requires an application context';
  end if;
  context_organization_id := (context_value ->> 'organizationId')::uuid;
  context_application_root_id := (context_value ->> 'applicationRootId')::uuid;
  context_account_id := (context_value ->> 'organizationAccountId')::uuid;

  plan := vortex_record.resolve_installation_access_plan_internal(
    vortex_definition.read_current_active_installation()
  );
  if (plan ->> 'organizationId')::uuid is distinct from context_organization_id
    or (plan ->> 'applicationRootId')::uuid is distinct from context_application_root_id then
    raise exception using errcode = '42501',
      message = 'Record adapter requires an application context';
  end if;

  target_meta := plan -> 'recordTypes' -> pg_catalog.lower(p_record_type_id::text);
  if target_meta is null then
    raise exception using errcode = '55000',
      message = 'Record type is not part of the active installation';
  end if;
  ownership_mode := target_meta ->> 'ownershipMode';

  -- The declaration the record loader builds for a read.
  declaration := vortex_record.record_type_read_declaration_internal(
    plan, p_record_type_id, context_application_root_id
  );
  if declaration is null then
    return query select false, null::uuid, array[]::uuid[], array[]::uuid[],
      array[]::text[], 'false'::text, '[]'::jsonb, array[]::text[];
    return;
  end if;

  -- The owner and owner-group routes the scan can narrow, and the
  -- eligible alternatives reduced to their route lists and saved-condition
  -- envelopes. A null alternative list means no narrowing is possible.
  select routes.* into access_routes
  from vortex_access.resolve_record_read_scan_routes_internal(
    declaration, ownership_mode
  ) as routes;

  -- The fields this reader is guaranteed to see on every record the read
  -- decision admits, after the field-read decision for produced fields. A
  -- refused access context yields no fields, so the scan pushes neither an
  -- order nor a filter on a value it cannot prove is visible; any other
  -- failure propagates.
  field_bounds := vortex_record.decide_record_type_read_bounds_internal(
    plan, p_record_type_id, '[]'::jsonb
  );

  -- Those fields may drive the scan only when every row the scan examines is a
  -- row the exact decision admits: an unconditioned all-records alternative
  -- admits every active record, and a restricted plan examines only owned
  -- records, which its routes admit unless a saved condition narrows them. Otherwise the scan also examines rows the reader cannot read,
  -- whose every value is hidden, so no field is readable for the scan.
  readable_field_ids_value := case
    when (field_bounds -> 'coversAllRecords') = 'true'::jsonb
      or (access_routes.restricted and (field_bounds -> 'conditionFree') = 'true'::jsonb)
    then coalesce(
      (
        select pg_catalog.array_agg(field.value order by field.value)
        from pg_catalog.jsonb_array_elements_text(
          field_bounds -> 'readableFieldIds'
        ) as field(value)
      ),
      array[]::text[]
    )
    else array[]::text[]
  end;

  -- Access routes with an exact table form narrow the candidate rows here so a
  -- reader limited to some records still gets full pages from a large table.
  -- Every eligible alternative contributes one term: its route's exact stored
  -- predicate (or true when the route has no exact form) AND its saved
  -- condition compiled into the same scan. The terms are OR-ed deliberately:
  -- the exact decision admits a record through any one alternative, so the
  -- scan must keep every row any of them admits. The result only removes rows
  -- the exact per-row decision below would refuse; every row the scan returns
  -- still goes through read_record, so it cannot widen a result.
  if access_routes.alternatives is null
    or pg_catalog.jsonb_typeof(access_routes.alternatives) is distinct from 'array' then
    access_predicate_value := 'true';
  elsif pg_catalog.jsonb_array_length(access_routes.alternatives) = 0 then
    -- No eligible alternative admits any record.
    access_predicate_value := 'false';
  else
    for alternative in
      select item.value
      from pg_catalog.jsonb_array_elements(access_routes.alternatives) as item(value)
    loop
      route_terms := array[]::text[];
      for route in
        select item.value
        from pg_catalog.jsonb_array_elements(alternative -> 'routes') as item(value)
      loop
        case route ->> 'kind'
          when 'ownership' then
            if ownership_mode = 'organization_account' then
              route_terms := pg_catalog.array_append(
                route_terms, 'stored.owner_organisation_account_id = $6');
            elsif ownership_mode = 'group' then
              route_terms := pg_catalog.array_append(
                route_terms, 'stored.owner_group_id = any ($7)');
            else
              -- Inherited ownership is reached only by a current-edge chase.
              route_terms := pg_catalog.array_append(route_terms, 'true');
            end if;
          else
            -- all_records admits every record; a relationship route is a
            -- current-edge chase. Neither has an exact stored predicate.
            route_terms := pg_catalog.array_append(route_terms, 'true');
        end case;
      end loop;

      if pg_catalog.cardinality(route_terms) = 0 then
        route_sql := 'false';
      elsif 'true' = any (route_terms) then
        route_sql := 'true';
      else
        route_sql := '(' || pg_catalog.array_to_string(route_terms, ' or ') || ')';
      end if;

      -- A saved condition narrows every route of its alternative, including an
      -- all-records route. It is compiled with the exact-semantics type map and
      -- the alternative's own bound parameters; anything the compiler cannot
      -- express exactly is left as true, so the per-row decision still decides.
      condition_sql := null;
      condition_params := '[]'::jsonb;
      if alternative ? 'savedCondition'
        and pg_catalog.jsonb_typeof(alternative -> 'savedCondition') = 'object' then
        condition_entry := null;
        select entry.value into condition_entry
        from pg_catalog.jsonb_array_elements(plan -> 'sharingConditions') as entry(value)
        where (entry.value ->> 'conditionId')
            = (alternative -> 'savedCondition' ->> 'conditionId')
          and (entry.value ->> 'publishedRevision')::numeric
            = (alternative -> 'savedCondition' ->> 'publishedRevision')::numeric
          and (entry.value ->> 'contractFingerprint')
            = (alternative -> 'savedCondition' ->> 'contractFingerprint')
          and pg_catalog.lower(entry.value ->> 'sourceRecordTypeId')
            = pg_catalog.lower(p_record_type_id::text)
        limit 1;

        if condition_entry is not null then
          condition_field_types := '{}'::jsonb;
          condition_field_columns := '{}'::jsonb;
          condition_field_database_types := '{}'::jsonb;
          condition_field_definitions := '{}'::jsonb;
          for field_item in
            select item.value
            from pg_catalog.jsonb_array_elements(target_meta -> 'fields') as item(value)
          loop
            field_id := pg_catalog.lower(field_item ->> 'fieldId');
            column_entry := target_meta -> 'columns' -> field_id;
            if column_entry is not null then
              field_kind := field_item ->> 'type';
              -- Calculation and total fields have no fixed stored value here and stay
              -- out of the map, as do kinds the mapping does not know.
              semantic_type := case when field_kind in ('calculation', 'total') then null
                else vortex_access.condition_field_type_internal(field_item) end;
              if semantic_type is not null then
                condition_field_types := condition_field_types
                  || pg_catalog.jsonb_build_object(field_id, semantic_type);
                condition_field_columns := condition_field_columns
                  || pg_catalog.jsonb_build_object(field_id, column_entry ->> 'token');
                condition_field_database_types := condition_field_database_types
                  || pg_catalog.jsonb_build_object(field_id, column_entry ->> 'databaseValueType');
                condition_field_definitions := condition_field_definitions
                  || pg_catalog.jsonb_build_object(
                    field_id, pg_catalog.jsonb_build_object('filterable', true, 'type', field_kind));
              end if;
            end if;
          end loop;

          select coalesce(
            pg_catalog.array_agg(distinct referenced.value #>> '{}'), array[]::text[])
          into condition_referenced_ids
          from pg_catalog.jsonb_path_query(
            condition_entry -> 'condition', 'lax $.**?(@.source == "field").fieldId'
          ) as referenced(value);
          select coalesce(
            pg_catalog.array_agg(pg_catalog.lower(declared.value #>> '{}')), array[]::text[])
          into declared_condition_ids
          from pg_catalog.jsonb_array_elements(
            condition_entry -> 'declaredFieldIds'
          ) as declared(value);

          supported := true;
          foreach field_id in array condition_referenced_ids loop
            field_id := pg_catalog.lower(field_id);
            if not (condition_field_types ? field_id)
              or not (condition_field_columns ? field_id)
              or not (condition_field_database_types ? field_id)
              or not (field_id = any (declared_condition_ids)) then
              supported := false;
              exit;
            end if;
            semantic_type := condition_field_types ->> field_id;
            database_value_type := condition_field_database_types ->> field_id;
            if not (
              (semantic_type = 'yes_no' and database_value_type = 'boolean')
              or (semantic_type = 'text' and database_value_type in ('text', 'json'))
              or (semantic_type = 'text_collection' and database_value_type = 'json')
              or (semantic_type = 'opaque_json' and database_value_type = 'json')
              or (semantic_type = 'money' and database_value_type = 'json')
              or (semantic_type = 'decimal_number' and database_value_type = 'decimal')
              or (semantic_type = 'whole_number' and database_value_type = 'integer')
              or (semantic_type = 'date' and database_value_type = 'date')
              or (semantic_type = 'date_time' and database_value_type = 'timestamp_with_time_zone')
            ) then
              supported := false;
              exit;
            end if;
          end loop;

          if supported then
            condition_parameter_types := '{}'::jsonb;
            condition_parameter_values := '{}'::jsonb;
            for declaration_item in
              select item.value
              from pg_catalog.jsonb_array_elements(condition_entry -> 'parameters') as item(value)
            loop
              condition_parameter_types := condition_parameter_types
                || pg_catalog.jsonb_build_object(
                  declaration_item ->> 'key', declaration_item ->> 'type');
            end loop;
            for binding_item in
              select item.value
              from pg_catalog.jsonb_array_elements(
                alternative -> 'savedCondition' -> 'parameterBindings'
              ) as item(value)
            loop
              if binding_item ->> 'source' = 'current_organization_account_id' then
                condition_parameter_values := condition_parameter_values
                  || pg_catalog.jsonb_build_object(
                    binding_item ->> 'key', context_account_id::text);
              elsif binding_item ->> 'source' = 'literal' then
                condition_parameter_values := condition_parameter_values
                  || pg_catalog.jsonb_build_object(
                    binding_item ->> 'key', binding_item -> 'value');
              else
                supported := false;
                exit;
              end if;
            end loop;
          end if;

          if supported then
            parameter_offset := pg_catalog.jsonb_array_length(access_parameters_accum);
            begin
              compiled := vortex_record.compile_query_filter_internal(
                condition_entry -> 'condition',
                condition_field_types,
                condition_field_columns,
                condition_field_database_types,
                condition_field_definitions,
                '{}'::jsonb,
                condition_parameter_types,
                condition_parameter_values,
                10,
                parameter_offset
              );
              condition_sql := compiled ->> 'predicate';
              condition_params := coalesce(compiled -> 'parameters', '[]'::jsonb);
            exception
              -- 22023 is the compiler's refusal of a condition it cannot express
              -- exactly; the condition is then left as true. Any other failure
              -- propagates.
              when sqlstate '22023' then
                get stacked diagnostics failure_sqlstate = returned_sqlstate,
                  failure_message = message_text;
                raise warning 'Record read scan condition was not pushed: SQLSTATE %, %',
                  failure_sqlstate, failure_message;
                condition_sql := null;
                condition_params := '[]'::jsonb;
            end;
          end if;

          -- Keep every compiled parameter even when nothing was pushed, so the
          -- next alternative's offsets stay aligned with the JSON array passed
          -- to the scan.
          access_parameters_accum := access_parameters_accum || condition_params;
        end if;
      end if;

      if condition_sql is null then
        alternative_terms := pg_catalog.array_append(alternative_terms, route_sql);
      elsif route_sql = 'true' then
        alternative_terms := pg_catalog.array_append(alternative_terms, condition_sql);
      else
        alternative_terms := pg_catalog.array_append(
          alternative_terms, '(' || route_sql || ' and ' || condition_sql || ')');
      end if;
    end loop;

    if 'true' = any (alternative_terms) then
      access_predicate_value := 'true';
      access_parameters_value := '[]'::jsonb;
    else
      access_predicate_value := '('
        || pg_catalog.array_to_string(alternative_terms, ' or ') || ')';
      access_parameters_value := access_parameters_accum;
    end if;
  end if;

  return query select
    access_routes.restricted,
    access_routes.owner_account_id,
    access_routes.owner_group_ids,
    access_routes.shared_record_ids,
    readable_field_ids_value,
    access_predicate_value,
    access_parameters_value,
    coalesce(
      (
        select pg_catalog.array_agg(field.value order by field.value)
        from pg_catalog.jsonb_array_elements_text(
          field_bounds -> 'readableFieldIds'
        ) as field(value)
      ),
      array[]::text[]
    );
  return;
end
$function$;

alter function vortex_record.plan_record_read_scan_internal(uuid) owner to vortex_record_adapter;

revoke all on function vortex_record.plan_record_read_scan_internal(uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_record.plan_record_read_scan_internal(uuid) to vortex_owner;

comment on function vortex_record.plan_record_read_scan_internal(uuid) is
  'Private read-scan narrowing for the record query: builds the read declaration for one record type of the exact active installation and returns the owner account and owner groups a caller can be admitted through (the shared-record slot is always null), the fields every eligible read alternative is guaranteed to expose, kept only when every row the scan examines is one the exact decision admits, the same guaranteed fields unconditionally as the reader''s current field bound (what a list may offer to filter, search or sort by), and one scan predicate that OR-s every eligible alternative''s exact route test with its saved condition compiled into the same scan; any route without an exact stored predicate or any condition the compiler cannot express as a superset is left unrestricted or true, so the per-row decision remains the only thing that decides access.';

create or replace function vortex_record.read_record_capabilities_internal(
  p_record_type_id uuid,
  p_record_id uuid,
  p_read_facts jsonb,
  p_read_bounds jsonb,
  p_action_meta jsonb
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  readable_field_ids jsonb := p_read_bounds -> 'readableFieldIds';
  meta jsonb;
  changeable_field_ids jsonb := '[]'::jsonb;
  actions text[] := array[]::text[];
  action_kind text;
  action_loaded jsonb;
  action_decision jsonb;
  update_bounds jsonb;
  read_declaration jsonb;
  permission_by_id jsonb;
  target_meta jsonb;
  required_permissions jsonb;
  simple_action boolean;
begin
  -- The row is already known readable: the caller passes the read facts and
  -- field bounds its read decision used. Simple action routes can use these
  -- facts; actions with a wider closure still load their writer's own facts.
  if p_read_facts ? 'previewInstallationId' then
    select coalesce(
      pg_catalog.jsonb_agg(projected.value order by projected.value), '[]'::jsonb
    )
    into changeable_field_ids
    from pg_catalog.jsonb_array_elements_text(readable_field_ids) as projected(value)
    where exists (
      select 1
      from pg_catalog.jsonb_array_elements_text(
        p_read_bounds -> 'changeableFieldIds'
      ) as changeable(value)
      where pg_catalog.lower(changeable.value) = pg_catalog.lower(projected.value)
    );
    if pg_catalog.jsonb_array_length(changeable_field_ids) > 0 then
      actions := array['update'];
    end if;
    return pg_catalog.jsonb_build_object(
      'changeableFieldIds', changeable_field_ids,
      'actions', pg_catalog.to_jsonb(actions)
    );
  end if;

  if pg_catalog.jsonb_typeof(p_read_facts -> 'isSystemProjection') is distinct from 'boolean' then
    raise exception using errcode = '55000',
      message = 'Record capability metadata is unavailable';
  end if;
  -- Ordinary stored rows already passed the read loader's catalogue checks.
  -- Only a protected projection needs the extra action-context lookup.
  -- A page passes the context it resolved once for this record type.
  if (p_read_facts ->> 'isSystemProjection')::boolean then
    meta := coalesce(p_action_meta,
      vortex_record.resolve_record_action_context_internal(p_record_type_id, 'read'));
  end if;
  if meta #>> '{recordType,systemProjection,protectedView}' =
      'organization_runtime_settings'
    and coalesce((meta #> '{recordType,standardActions}') ? 'update', false)
    and vortex_definition.is_platform_system_module_internal(
      (meta ->> 'moduleRootId')::uuid,
      (meta -> 'context' ->> 'organizationId')::uuid
    ) then
    if vortex_access.organization_runtime_settings_manage_is_current() then
      select coalesce(
        pg_catalog.jsonb_agg(projected.value order by projected.value), '[]'::jsonb
      )
      into changeable_field_ids
      from pg_catalog.jsonb_array_elements_text(readable_field_ids) as projected(value)
      join pg_catalog.jsonb_array_elements(meta #> '{recordType,fields}') as field(value)
        on pg_catalog.lower(field.value ->> 'fieldId') = pg_catalog.lower(projected.value)
      where field.value ->> 'key' not in ('organization_id', 'revision')
        and field.value ->> 'type' not in (
          'reference_number', 'table', 'link', 'link_to_one_of_several', 'total',
          'attachment', 'calculation'
        );
      if pg_catalog.jsonb_array_length(changeable_field_ids) > 0 then
        actions := array['update'];
      end if;
    end if;
    return pg_catalog.jsonb_build_object(
      'changeableFieldIds', changeable_field_ids,
      'actions', pg_catalog.to_jsonb(actions)
    );
  end if;

  -- The read loader has already checked this installation's access plan and
  -- pinned record type; use those exact permissions for the action declarations.
  -- An action whose routes use only this target row can reuse the read facts.
  -- Relationship routes and inherited ownership still use the action's own
  -- fact closure, so no source row or edge needed by the writer is omitted.
  read_declaration := p_read_facts -> 'declaration';
  permission_by_id := p_read_facts -> 'accessPermissions';
  target_meta := p_read_facts -> 'recordTypeMeta';
  if pg_catalog.jsonb_typeof(read_declaration) is distinct from 'object'
    or pg_catalog.jsonb_typeof(permission_by_id) is distinct from 'object'
    or pg_catalog.jsonb_typeof(target_meta) is distinct from 'object'
    or (target_meta ->> 'recordTypeId')::uuid is distinct from p_record_type_id
    or coalesce(target_meta ->> 'ownershipMode', '') not in
      ('none', 'organization_account', 'group')
    or read_declaration -> 'recordBinding' is distinct from
      pg_catalog.jsonb_build_object(
        'moduleRootId', target_meta -> 'moduleRootId',
        'recordTypeId', target_meta -> 'recordTypeId',
        'storageContractId', target_meta -> 'storageContractId',
        'storageScope', target_meta -> 'storageScope'
      ) then
    permission_by_id := null;
  end if;

  -- Every action still receives its own declaration and exact-record decision.
  -- A missing declaration contributes no action.
  foreach action_kind in array array['update', 'delete', 'restore'] loop
    action_loaded := null;
    if permission_by_id is not null then
      select pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'applicationRootId', (p_read_facts -> 'context' ->> 'applicationRootId')::uuid,
          'ownerKind', declared.value ->> 'ownerKind',
          'ownerId', (declared.value ->> 'ownerId')::uuid,
          'permissionId', declared.key::uuid
        )
        order by declared.value ->> 'ownerKind' collate "C", declared.key collate "C"
      )
      into required_permissions
      from pg_catalog.jsonb_each(permission_by_id) as declared(key, value)
      where pg_catalog.lower(declared.value ->> 'recordTypeId') = pg_catalog.lower(p_record_type_id::text)
        and declared.value ->> 'actionKind' = action_kind
        and (declared.value ->> 'namedAction') is null
        and (
          declared.value ->> 'ownerKind' = 'application'
          or (declared.value ->> 'ownerId')::uuid = (target_meta ->> 'moduleRootId')::uuid
        );
      select not exists (
        select 1
        from pg_catalog.jsonb_array_elements(required_permissions) as required(value)
        join pg_catalog.jsonb_each(permission_by_id) as declared(key, value)
          on declared.key = pg_catalog.lower(required.value ->> 'permissionId')
        where pg_catalog.jsonb_typeof(declared.value #> '{recordScope,routes}')
            is distinct from 'array'
          or exists (
            select 1
            from pg_catalog.jsonb_array_elements(
              case when pg_catalog.jsonb_typeof(declared.value #> '{recordScope,routes}') = 'array'
                then declared.value #> '{recordScope,routes}'
                else '[]'::jsonb end
            ) as route(value)
            where coalesce(route.value ->> 'kind', '') not in
              ('all_records', 'ownership')
          )
      ) into simple_action;
      if simple_action then
        action_loaded := pg_catalog.jsonb_build_object(
          'outcome', 'loaded',
          'declaration', read_declaration || pg_catalog.jsonb_build_object(
            'operationKey', 'record.' || action_kind,
            'action', pg_catalog.jsonb_build_object('actionKind', action_kind),
            'requiredPermissions', coalesce(required_permissions, '[]'::jsonb)
          ),
          'facts', p_read_facts -> 'facts'
        );
        if required_permissions is null then
          action_loaded := pg_catalog.jsonb_set(action_loaded, '{declaration}', 'null'::jsonb);
        end if;
      end if;
    end if;
    if action_loaded is null then
      action_loaded := (vortex_record.load_record_access_facts_internal(
        action_kind, pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
          'recordTypeId', p_record_type_id,
          'recordId', p_record_id
        ))
      ) -> 0);
    end if;
    if action_loaded ->> 'outcome' = 'loaded'
      and pg_catalog.jsonb_typeof(action_loaded -> 'declaration') = 'object' then
      -- An action decided over the read facts reuses their record types, which
      -- the read decision validated in this invocation; an action that loaded
      -- its writer's own facts validates them in full.
      action_decision := vortex_access.evaluate_record_access_with_validated_types_internal(
        action_loaded -> 'declaration', p_record_id, action_loaded -> 'facts', null,
        case when action_loaded -> 'facts' is not distinct from p_read_facts -> 'facts'
          then p_read_facts -> 'facts' -> 'recordTypes' end
      );
      if action_decision ->> 'outcome' = 'allowed' then
        actions := pg_catalog.array_append(actions, action_kind);
        -- The changeable fields are the update decision's own field bounds, the
        -- set the record save enforces, narrowed to the fields read_record
        -- projects for this row, so no hidden field is ever reported.
        if action_kind = 'update' then
          update_bounds := vortex_access.resolve_record_field_bounds_internal(action_decision);
          changeable_field_ids := coalesce((
            select pg_catalog.jsonb_agg(projected.value order by projected.value)
            from pg_catalog.jsonb_array_elements_text(readable_field_ids) as projected(value)
            where exists (
              select 1
              from pg_catalog.jsonb_array_elements_text(
                update_bounds -> 'changeableFieldIds'
              ) as changeable(value)
              where pg_catalog.lower(changeable.value) = pg_catalog.lower(projected.value)
            )
          ), '[]'::jsonb);
        end if;
      end if;
    end if;
  end loop;

  -- Changing a row needs at least one field it may change, so update is never
  -- reported without one.
  if pg_catalog.jsonb_array_length(changeable_field_ids) = 0 then
    actions := pg_catalog.array_remove(actions, 'update');
  end if;

  return pg_catalog.jsonb_build_object(
    'changeableFieldIds', changeable_field_ids,
    'actions', pg_catalog.to_jsonb(actions)
  );
end
$function$;

alter function vortex_record.read_record_capabilities_internal(uuid,uuid,jsonb,jsonb,jsonb) owner to vortex_record_adapter;

revoke all on function vortex_record.read_record_capabilities_internal(uuid, uuid, jsonb, jsonb, jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

comment on function vortex_record.read_record_capabilities_internal(uuid, uuid, jsonb, jsonb, jsonb) is
  'Private record capabilities: returns the permitted update, delete and restore actions and changeable fields of one readable record, reusing the read facts and field bounds of its read decision, and the protected projection action context its caller resolved once in this invocation for the same record type when there is one.';

create or replace function vortex_record.read_record_capabilities_page_internal(
  p_record_type_id uuid,
  p_rows jsonb,
  p_envelope jsonb
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  row_item jsonb;
  row_index integer := 0;
  record_id uuid;
  compact boolean;
  read_facts jsonb;
  read_bounds jsonb;
  readable_field_ids jsonb;
  read_declaration jsonb;
  permission_by_id jsonb;
  target_meta jsonb;
  required_permissions jsonb;
  action_kind text;
  simple_action boolean;
  use_exact_row boolean;
  row_jobs jsonb[];
  job_list jsonb[] := array[]::jsonb[];
  jobs jsonb := '[]'::jsonb;
  decisions jsonb := '[]'::jsonb;
  bounds_by_route jsonb := '{}'::jsonb;
  bounds_key text;
  update_bounds jsonb;
  results jsonb[] := array[]::jsonb[];
  row_result jsonb;
  decision_item jsonb;
  action_decision jsonb;
  changeable_field_ids jsonb;
  changeable_by_key jsonb := '{}'::jsonb;
  changeable_key text;
  actions text[];
  envelope_jobs jsonb[];
  envelope_exact boolean;
  projection_meta jsonb;
  decisions_by_row jsonb := '{}'::jsonb;
begin
  if p_record_type_id is null or pg_catalog.jsonb_typeof(p_rows) is distinct from 'array'
    or pg_catalog.jsonb_array_length(p_rows) > 200
    or (p_envelope is not null and pg_catalog.jsonb_typeof(p_envelope) is distinct from 'object') then
    raise exception using errcode = '22023', message = 'Page capability input is invalid';
  end if;

  for row_item in
    select item.value from pg_catalog.jsonb_array_elements(p_rows) as item(value)
  loop
    row_index := row_index + 1;
    -- A row carries its complete read facts, or (from the page read pass) its
    -- compact record scope, whose page-wide part is the one page envelope.
    compact := pg_catalog.jsonb_typeof(row_item) = 'object' and row_item ? 'record'
      and not (row_item ? 'readFacts');
    if pg_catalog.jsonb_typeof(row_item) is distinct from 'object'
      or not (row_item ?& array['recordId', 'readBounds'])
      or not vortex_platform.is_non_nil_uuid(row_item ->> 'recordId')
      or (compact and (p_envelope is null
        or pg_catalog.jsonb_typeof(row_item -> 'record') is distinct from 'object'
        or row_item #>> '{record,record,recordScope,recordId}'
          is distinct from pg_catalog.lower(row_item ->> 'recordId')))
      or (not compact and pg_catalog.jsonb_typeof(row_item -> 'readFacts') is distinct from 'object')
      or pg_catalog.jsonb_typeof(row_item -> 'readBounds') is distinct from 'object' then
      raise exception using errcode = '22023', message = 'Page capability input is invalid';
    end if;
    record_id := (row_item ->> 'recordId')::uuid;
    read_facts := case when compact then p_envelope else row_item -> 'readFacts' end;
    read_bounds := row_item -> 'readBounds';
    readable_field_ids := read_bounds -> 'readableFieldIds';
    if pg_catalog.jsonb_typeof(readable_field_ids) is distinct from 'array' then
      raise exception using errcode = '22023', message = 'Page capability bounds are invalid';
    end if;

    -- The read projection already made the exact record decision over these
    -- facts. Reuse that validated closure only for simple action routes. Every
    -- compact row shares the page envelope, so its jobs are worked out once.
    row_jobs := null;
    if compact and envelope_exact is not null then
      use_exact_row := envelope_exact;
      row_jobs := envelope_jobs;
    else
      read_declaration := read_facts -> 'declaration';
      permission_by_id := read_facts -> 'accessPermissions';
      target_meta := read_facts -> 'recordTypeMeta';
      use_exact_row := read_facts ? 'previewInstallationId'
        or (read_facts ->> 'isSystemProjection')::boolean is distinct from false
        or pg_catalog.jsonb_typeof(read_declaration) is distinct from 'object'
        or pg_catalog.jsonb_typeof(permission_by_id) is distinct from 'object'
        or pg_catalog.jsonb_typeof(target_meta) is distinct from 'object'
        or (target_meta ->> 'recordTypeId')::uuid is distinct from p_record_type_id
        or coalesce(target_meta ->> 'ownershipMode', '') not in
          ('none', 'organization_account', 'group')
        or read_declaration -> 'recordBinding' is distinct from
          pg_catalog.jsonb_build_object(
            'moduleRootId', target_meta -> 'moduleRootId',
            'recordTypeId', target_meta -> 'recordTypeId',
            'storageContractId', target_meta -> 'storageContractId',
            'storageScope', target_meta -> 'storageScope'
          );
      row_jobs := array[]::jsonb[];
      if not use_exact_row then
        foreach action_kind in array array['update', 'delete', 'restore'] loop
          select pg_catalog.jsonb_agg(
            pg_catalog.jsonb_build_object(
              'applicationRootId', (read_facts -> 'context' ->> 'applicationRootId')::uuid,
              'ownerKind', declared.value ->> 'ownerKind',
              'ownerId', (declared.value ->> 'ownerId')::uuid,
              'permissionId', declared.key::uuid
            )
            order by declared.value ->> 'ownerKind' collate "C", declared.key collate "C"
          )
          into required_permissions
          from pg_catalog.jsonb_each(permission_by_id) as declared(key, value)
          where pg_catalog.lower(declared.value ->> 'recordTypeId') = pg_catalog.lower(p_record_type_id::text)
            and declared.value ->> 'actionKind' = action_kind
            and (declared.value ->> 'namedAction') is null
            and (
              declared.value ->> 'ownerKind' = 'application'
              or (declared.value ->> 'ownerId')::uuid = (target_meta ->> 'moduleRootId')::uuid
            );
          select not exists (
            select 1
            from pg_catalog.jsonb_array_elements(required_permissions) as required(value)
            join pg_catalog.jsonb_each(permission_by_id) as declared(key, value)
              on declared.key = pg_catalog.lower(required.value ->> 'permissionId')
            where pg_catalog.jsonb_typeof(declared.value #> '{recordScope,routes}')
                is distinct from 'array'
              or exists (
                select 1
                from pg_catalog.jsonb_array_elements(
                  case when pg_catalog.jsonb_typeof(declared.value #> '{recordScope,routes}') = 'array'
                    then declared.value #> '{recordScope,routes}'
                    else '[]'::jsonb end
                ) as route(value)
                where coalesce(route.value ->> 'kind', '') not in
                  ('all_records', 'ownership')
              )
          ) into simple_action;
          if not simple_action then
            use_exact_row := true;
            exit;
          end if;
          if required_permissions is not null then
            row_jobs := pg_catalog.array_append(row_jobs, pg_catalog.jsonb_build_object(
              'actionKind', action_kind,
              'requiredPermissions', required_permissions
            ));
          end if;
        end loop;
      end if;
      if compact then
        envelope_exact := use_exact_row;
        envelope_jobs := row_jobs;
      end if;
    end if;
    if use_exact_row then
      -- A protected projection's action context depends only on the record
      -- type and the installation: resolved once for the page.
      if (read_facts ->> 'isSystemProjection')::boolean and projection_meta is null then
        projection_meta := vortex_record.resolve_record_action_context_internal(p_record_type_id, 'read');
      end if;
      row_result := vortex_record.read_record_capabilities_internal(
        p_record_type_id, record_id,
        case when compact
          then vortex_record.read_record_page_row_facts_internal(p_envelope, row_item -> 'record')
          else read_facts end,
        read_bounds,
        case when (read_facts ->> 'isSystemProjection')::boolean then projection_meta end
      );
      if row_result is null then
        raise exception using errcode = '55000', message = 'Record capabilities are unavailable';
      end if;
      results := pg_catalog.array_append(results, row_result);
    else
      select pg_catalog.array_cat(job_list, coalesce(pg_catalog.array_agg(
          job.value || pg_catalog.jsonb_build_object('rowIndex', row_index) order by job.ordinality),
          array[]::jsonb[]))
      into job_list
      from pg_catalog.unnest(row_jobs) with ordinality as job(value, ordinality);
      results := pg_catalog.array_append(results, 'null'::jsonb);
    end if;
  end loop;

  jobs := pg_catalog.to_jsonb(job_list);
  if jobs <> '[]'::jsonb then
    decisions := vortex_access.evaluate_organization_record_access_page_internal(p_rows, jobs, p_envelope);
    -- The same permission contributions have the same field policy. Resolve
    -- each distinct update contribution set once, then reuse its bounds for
    -- every row admitted through that set.
    select coalesce(pg_catalog.jsonb_object_agg(
      distinct_decision.bounds_key,
      vortex_access.resolve_record_field_bounds_internal(distinct_decision.decision)
    ), '{}'::jsonb)
    into bounds_by_route
    from (
      select distinct on (
        pg_catalog.jsonb_build_array(
          item.value -> 'decision' -> 'organizationId',
          item.value -> 'decision' -> 'matchedContributions'
        )::text
      )
        pg_catalog.jsonb_build_array(
          item.value -> 'decision' -> 'organizationId',
          item.value -> 'decision' -> 'matchedContributions'
        )::text as bounds_key,
        item.value -> 'decision' as decision
      from pg_catalog.jsonb_array_elements(decisions) as item(value)
      where item.value ->> 'actionKind' = 'update'
        and item.value -> 'decision' ->> 'outcome' = 'allowed'
    ) as distinct_decision;
  end if;

  -- Each row's decisions, in decision order, looked up once per row.
  select coalesce(pg_catalog.jsonb_object_agg(grouped.row_key, grouped.items), '{}'::jsonb)
  into decisions_by_row
  from (
    select item.value ->> 'rowIndex' as row_key,
      pg_catalog.jsonb_agg(item.value order by item.ordinality) as items
    from pg_catalog.jsonb_array_elements(decisions) with ordinality as item(value, ordinality)
    group by item.value ->> 'rowIndex'
  ) as grouped;

  for row_index in 1..pg_catalog.jsonb_array_length(p_rows) loop
    if results[row_index] <> 'null'::jsonb then
      continue;
    end if;
    row_item := p_rows -> (row_index - 1);
    readable_field_ids := row_item -> 'readBounds' -> 'readableFieldIds';
    actions := array[]::text[];
    changeable_field_ids := '[]'::jsonb;
    for decision_item in
      select item.value
      from pg_catalog.jsonb_array_elements(coalesce(decisions_by_row -> row_index::text, '[]'::jsonb))
        with ordinality as item(value, ordinality)
      order by item.ordinality
    loop
      action_kind := decision_item ->> 'actionKind';
      action_decision := decision_item -> 'decision';
      if action_decision ->> 'outcome' = 'allowed' then
        actions := pg_catalog.array_append(actions, action_kind);
        if action_kind = 'update' then
          bounds_key := pg_catalog.jsonb_build_array(
            action_decision -> 'organizationId',
            action_decision -> 'matchedContributions'
          )::text;
          update_bounds := bounds_by_route -> bounds_key;
          if update_bounds is null then
            raise exception using errcode = '55000',
              message = 'Page update field bounds are unavailable';
          end if;
          -- The same update bounds and readable fields give the same
          -- changeable fields: worked out once per distinct pair.
          changeable_key := pg_catalog.md5(bounds_key || readable_field_ids::text);
          changeable_field_ids := changeable_by_key -> changeable_key;
          if changeable_field_ids is null then
            changeable_field_ids := coalesce((
              select pg_catalog.jsonb_agg(projected.value order by projected.value)
              from pg_catalog.jsonb_array_elements_text(readable_field_ids) as projected(value)
              where exists (
                select 1
                from pg_catalog.jsonb_array_elements_text(
                  update_bounds -> 'changeableFieldIds'
                ) as changeable(value)
                where pg_catalog.lower(changeable.value) = pg_catalog.lower(projected.value)
              )
            ), '[]'::jsonb);
            changeable_by_key := changeable_by_key
              || pg_catalog.jsonb_build_object(changeable_key, changeable_field_ids);
          end if;
        end if;
      end if;
    end loop;
    if pg_catalog.jsonb_array_length(changeable_field_ids) = 0 then
      actions := pg_catalog.array_remove(actions, 'update');
    end if;
    results[row_index] := pg_catalog.jsonb_build_object(
      'changeableFieldIds', changeable_field_ids,
      'actions', pg_catalog.to_jsonb(actions)
    );
  end loop;
  return pg_catalog.to_jsonb(results);
end
$function$;

alter function vortex_record.read_record_capabilities_page_internal(uuid,jsonb,jsonb)
  owner to vortex_record_adapter;

revoke all on function vortex_record.read_record_capabilities_page_internal(uuid,jsonb,jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

comment on function vortex_record.read_record_capabilities_page_internal(uuid,jsonb,jsonb) is
  'Private list capability pass: evaluates simple action declarations across readable page rows together, while complex routes use their exact single-record path; a row from the page read pass carries only its compact record scope and shares the one page envelope, so the action jobs and the page-wide facts are worked out once for the page.';

create or replace function vortex_record.read_record_page_envelope_internal(
  p_record_type_id uuid,
  p_first_loaded jsonb
)
returns table (envelope jsonb, narrowed boolean, read_time jsonb)
language plpgsql
stable
security invoker
set search_path = ''
as $function$
declare
  read_time_fields jsonb;
begin
  -- The record type's read-time fields and, when it has any, the statement's
  -- read-time clock: the same for every record of the page.
  select coalesce(pg_catalog.jsonb_object_agg(pg_catalog.lower(field.value ->> 'fieldId'), field.value), '{}'::jsonb)
  into read_time_fields
  from pg_catalog.jsonb_array_elements(p_first_loaded -> 'facts' -> 'recordTypes') as record_type(value)
  cross join lateral pg_catalog.jsonb_array_elements(record_type.value -> 'fields') as field(value)
  where pg_catalog.lower(record_type.value ->> 'recordTypeId') = pg_catalog.lower(p_record_type_id::text)
    and field.value ->> 'type' = 'calculation'
    and (field.value #>> '{settings,evaluation}' = 'read_time'
      or field.value #>> '{settings,expression,op}' = 'deadline_passed');
  read_time := pg_catalog.jsonb_build_object('readTimeFields', read_time_fields)
    || case when read_time_fields <> '{}'::jsonb
      then pg_catalog.jsonb_build_object('readTimeClock', vortex_record.read_time_clock_internal())
      else '{}'::jsonb end;
  -- The page-wide part of every record's read facts, built once for a page:
  -- the first record's facts, loaded by the exact loader in this invocation.
  -- Each record of the page differs only in its own stored record fact, its
  -- concurrency number and its definition revision.
  envelope := p_first_loaded;
  narrowed := false;
  -- When nothing about this record type can reach another record or another
  -- record type (no total field or saved condition, and every route of every
  -- permission on it is an all-record or owner route), each record's facts carry
  -- only its own type and its own permissions, and no relationship: every
  -- reader of these facts (projection, derived fields, capabilities) looks at
  -- nothing else.
  if not exists (
      select 1
      from pg_catalog.jsonb_array_elements(p_first_loaded #> '{facts,recordTypes}') as record_type(value)
      cross join lateral pg_catalog.jsonb_array_elements(record_type.value -> 'fields') as field(value)
      where pg_catalog.lower(record_type.value ->> 'recordTypeId') = pg_catalog.lower(p_record_type_id::text)
        and field.value ->> 'type' = 'total'
    )
    and not exists (
      select 1
      from pg_catalog.jsonb_each(p_first_loaded -> 'accessPermissions') as declared(key, value)
      where pg_catalog.lower(declared.value ->> 'recordTypeId') = pg_catalog.lower(p_record_type_id::text)
        -- A saved condition can bind the current person as a typed reference,
        -- which needs the directory type from these exact installation facts.
        and (declared.value #> '{recordScope,savedCondition}' is not null
          or pg_catalog.jsonb_typeof(declared.value #> '{recordScope,routes}') is distinct from 'array'
          or exists (
            select 1
            from pg_catalog.jsonb_array_elements(
              case when pg_catalog.jsonb_typeof(declared.value #> '{recordScope,routes}') = 'array'
                then declared.value #> '{recordScope,routes}' else '[]'::jsonb end
            ) as route(value)
            where coalesce(route.value ->> 'kind', '') not in ('all_records', 'ownership')
          ))
    ) then
    envelope := pg_catalog.jsonb_set(pg_catalog.jsonb_set(pg_catalog.jsonb_set(
      p_first_loaded, '{facts,relationships}', '[]'::jsonb), '{facts,recordTypes}', (
        select coalesce(pg_catalog.jsonb_agg(record_type.value order by record_type.ordinality), '[]'::jsonb)
        from pg_catalog.jsonb_array_elements(p_first_loaded #> '{facts,recordTypes}')
          with ordinality as record_type(value, ordinality)
        where pg_catalog.lower(record_type.value ->> 'recordTypeId') = pg_catalog.lower(p_record_type_id::text)
      )), '{accessPermissions}', (
        select coalesce(pg_catalog.jsonb_object_agg(declared.key, declared.value), '{}'::jsonb)
        from pg_catalog.jsonb_each(p_first_loaded -> 'accessPermissions') as declared(key, value)
        where pg_catalog.lower(declared.value ->> 'recordTypeId') = pg_catalog.lower(p_record_type_id::text)
      ));
    narrowed := true;
  end if;
  return next;
end
$function$;

alter function vortex_record.read_record_page_envelope_internal(uuid,jsonb) owner to vortex_record_adapter;
revoke all on function vortex_record.read_record_page_envelope_internal(uuid,jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

comment on function vortex_record.read_record_page_envelope_internal(uuid,jsonb) is
  'Private page read helper for the fixed record adapter: the page-wide part of every record''s read facts, built once from the first record''s exact facts, narrowed to the record type and its permissions when nothing about that type reaches another record or type.';

reset role;
