set local role vortex_owner;

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
  wants_share boolean;
  share_candidates uuid[] := array[]::uuid[];
  constant_matched jsonb;
  constant_valid_until text;
  decisions jsonb;
begin
  -- One decision per record of one page, for one action declaration and the
  -- eligibility the caller computed once for it in this invocation. It is the
  -- exact-record composition (target check, all-record, owner, owner-group and
  -- direct-share routes) applied to every record in one pass. It returns JSON
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

  -- Only routes with an exact set form: all records, the record's own owner or
  -- owner group, and a direct share; never a relationship route, an inherited
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
          where coalesce(route.value ->> 'kind', '') not in ('all_records', 'ownership', 'direct_share')
        )
    ) then
    return null;
  end if;

  wants_share := action_kind in ('read', 'update') and exists (
    select 1
    from pg_catalog.jsonb_array_elements(p_eligibility -> 'eligiblePermissions') as alt(value)
    cross join lateral pg_catalog.jsonb_array_elements(alt.value #> '{recordScope,routes}') as route(value)
    where route.value ->> 'kind' = 'direct_share'
  );
  if wants_share then
    -- A superset of the records any current share can reach; the exact share
    -- reader still decides each of them.
    select coalesce(pg_catalog.array_agg(distinct share.record_id), array[]::uuid[])
    into share_candidates
    from vortex_access.organization_direct_record_shares as share
    where share.organization_id = v_organization_id
      and share.state = 'active'
      and share.record_id in (
        select (item.value #>> '{recordScope,recordId}')::uuid
        from pg_catalog.jsonb_array_elements(p_records) as item(value)
        where vortex_platform.is_non_nil_uuid(item.value #>> '{recordScope,recordId}')
      );
  end if;

  -- When every eligible alternative admits all records and no share applies,
  -- every target record gets the same contributions: build them once.
  if not wants_share and not exists (
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
        where route.value ->> 'kind' = 'ownership') as has_owner,
      exists (select 1 from pg_catalog.jsonb_array_elements(alt.value #> '{recordScope,routes}') as route(value)
        where route.value ->> 'kind' = 'direct_share') as has_share
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
    union all
    -- Direct shares: every current share is its own contribution with its own
    -- field bounds, decided by the exact share reader.
    select assessed.row_index, alternatives.alt_index, alternatives.candidate,
      pg_catalog.jsonb_build_object(
        'kind', 'direct_share',
        'directShareId', share.direct_share_id,
        'directShareRevision', share.direct_share_revision,
        'readableFieldIds', pg_catalog.to_jsonb(share.readable_field_ids),
        'changeableFieldIds', pg_catalog.to_jsonb(share.changeable_field_ids)
      ),
      share.valid_until,
      alternatives.candidate_valid_until
    from assessed
    cross join alternatives
    cross join lateral vortex_access.read_current_direct_record_share_contributions(
      v_organization_id, v_application_root_id,
      (target_type ->> 'moduleRootId')::uuid, (target_type ->> 'recordTypeId')::uuid,
      (target_type ->> 'storageContractId')::uuid, target_type ->> 'storageScope',
      assessed.record_id, v_organization_id, v_application_root_id, v_account_id, p_checked_at
    ) as share
    where wants_share and alternatives.has_share
      and assessed.target_ok and assessed.evidence_ok
      and assessed.record_id = any (share_candidates)
      and (action_kind = 'read' or pg_catalog.cardinality(share.changeable_field_ids) > 0)
  ),
  matched as (
    select contribution.row_index,
      pg_catalog.jsonb_agg(contribution.value order by
        contribution.alt_index,
        case contribution.value -> 'route' ->> 'kind'
          when 'all_records' then 0 when 'ownership' then 1
          when 'direct_share' then 2 when 'relationship' then 3 end,
        coalesce(contribution.value -> 'route' ->> 'directShareId',
          contribution.value -> 'route' ->> 'sourceRecordId', '')
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
  'Private set-based record decision for one page and one action declaration: applies the exact-record target check and the all-record, owner, owner-group and direct-share routes of the eligibility the caller computed once in this invocation to every record in one pass, producing the same decision the exact single-record composition produces; returns null for the page when an eligible alternative has a relationship route or a saved condition or the record type inherits its owner, and null for a record whose evidence is not well formed, so the caller decides those through the exact path.';

create or replace function vortex_access.evaluate_organization_record_access_page_internal(
  p_rows jsonb,
  p_jobs jsonb
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
begin
  if pg_catalog.jsonb_typeof(p_rows) is distinct from 'array'
    or pg_catalog.jsonb_array_length(p_rows) > 200
    or pg_catalog.jsonb_typeof(jobs) is distinct from 'array'
    or pg_catalog.jsonb_array_length(jobs) > 600 then
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
  ) then
    raise exception using errcode = '22023', message = 'Page access jobs are invalid';
  end if;
  if jobs = '[]'::jsonb then
    return jobs;
  end if;
  context_value := vortex_access.validated_human_request_context();
  checked_at := pg_catalog.clock_timestamp();
    -- Each declaration is eligible once for the page. Every record still
    -- receives the exact row-scope, ownership, group and share decision.
    with entries as materialized (
      select (job.value ->> 'rowIndex')::integer as row_index,
        job.value ->> 'actionKind' as action_kind,
        (row_item.value ->> 'recordId')::uuid as record_id,
        (row_item.value -> 'readFacts' -> 'declaration')
          || pg_catalog.jsonb_build_object(
            'operationKey', 'record.' || (job.value ->> 'actionKind'),
            'action', pg_catalog.jsonb_build_object(
              'actionKind', job.value ->> 'actionKind'
            ),
            'requiredPermissions', job.value -> 'requiredPermissions'
          ) as declaration,
        row_item.value -> 'readFacts' -> 'facts' as facts
      from pg_catalog.jsonb_array_elements(jobs) as job(value)
      join pg_catalog.jsonb_array_elements(p_rows)
        with ordinality as row_item(value, ordinality)
        on row_item.ordinality = (job.value ->> 'rowIndex')::integer
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
      select entry.row_index, entry.action_kind, entry.record_id,
        entry.declaration, entry.facts, eligible.value as eligibility,
        target.value as target_record,
        target.value is not null
          and (target.value -> 'recordScope' ->> 'organizationId')::uuid
            = (context_value ->> 'organizationId')::uuid
          and pg_catalog.lower(target.value -> 'recordScope' ->> 'moduleRootId')
            = pg_catalog.lower(entry.facts -> 'binding' ->> 'moduleRootId')
          and pg_catalog.lower(target.value -> 'recordScope' ->> 'recordTypeId')
            = pg_catalog.lower(entry.facts -> 'binding' ->> 'recordTypeId')
          and pg_catalog.lower(target.value -> 'recordScope' ->> 'storageContractId')
            = pg_catalog.lower(entry.facts -> 'binding' ->> 'storageContractId')
          and target.value -> 'recordScope' ->> 'storageScope'
            = entry.facts -> 'binding' ->> 'storageScope'
          and (
            entry.facts -> 'binding' ->> 'storageScope' = 'organization_shared'
            or (target.value -> 'recordScope' ->> 'applicationRootId')::uuid
              = (entry.declaration -> 'target' ->> 'applicationRootId')::uuid
          )
          and target.value ->> 'lifecycleState' = 'active' as target_ok
      from entries as entry
      join eligible on eligible.declaration = entry.declaration
      left join lateral (
        select item.value
        from pg_catalog.jsonb_array_elements(entry.facts -> 'records') as item(value)
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
        (pg_catalog.array_agg(assessed.facts -> 'recordTypes'))[1] as record_types,
        pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(assessed.row_index, assessed.action_kind)
          order by assessed.row_index, assessed.action_kind) as keys,
        pg_catalog.jsonb_agg(coalesce(assessed.target_record, 'null'::jsonb)
          order by assessed.row_index, assessed.action_kind) as records
      from assessed
      group by assessed.declaration, ((assessed.facts -> 'recordTypes')::text)
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
                assessed.facts,
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

alter function vortex_access.evaluate_organization_record_access_page_internal(jsonb,jsonb)
  owner to vortex_owner;

revoke all on function vortex_access.evaluate_organization_record_access_page_internal(jsonb,jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_access.evaluate_organization_record_access_page_internal(jsonb,jsonb)
  to vortex_record_adapter;

comment on function vortex_access.evaluate_organization_record_access_page_internal(jsonb,jsonb) is
  'Private page access decision over already validated read facts: shares eligibility by action declaration, decides every record whose routes have an exact set form in one set pass per declaration, and keeps the exact row-scope composition for every other record.';

create or replace function vortex_record.read_record_projection_with_validated_types_internal(
  p_record_type_id uuid,
  p_record_id uuid,
  p_page_declaration jsonb,
  p_page_eligibility jsonb,
  p_validated_record_types jsonb,
  p_projection_row jsonb,
  p_loaded jsonb,
  p_decision jsonb,
  p_bounds jsonb
)
returns table (projection jsonb, read_facts jsonb, read_bounds jsonb)
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  loaded jsonb;
  decision jsonb;
  bounds jsonb;
  columns_value jsonb;
  values_value jsonb := '{}'::jsonb;
  field_id text;
  read_time_fields jsonb;
  read_time_clock jsonb;
  read_time_expression jsonb;
  read_time_value jsonb;
  preview_meta jsonb;
  preview_bounds jsonb;
  due_key text;
  status_key text;
  due_value jsonb;
  status_value jsonb;
  batched boolean := false;
begin
  if p_record_type_id is null or p_record_id is null
    or p_record_type_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_record_id = '00000000-0000-0000-0000-000000000000'::uuid then
    projection := pg_catalog.jsonb_build_object('outcome', 'refused');
    return next;
    return;
  end if;
  loaded := p_loaded;
  if loaded is null then
    loaded := vortex_record.load_record_access_facts_internal(
      p_record_type_id, 'read', p_record_id, null, p_projection_row
    );
  end if;
  if p_loaded is not null and loaded ->> 'outcome' = 'loaded' and (
    loaded -> 'facts' -> 'binding' ->> 'recordTypeId' is distinct from
      pg_catalog.lower(p_record_type_id::text)
    or not exists (
      select 1 from pg_catalog.jsonb_array_elements(loaded -> 'facts' -> 'records') as item(value)
      where item.value -> 'recordScope' ->> 'recordId' = pg_catalog.lower(p_record_id::text)
    )
  ) then
    raise exception using errcode = '22023', message = 'Page record facts are invalid';
  end if;
  if loaded ->> 'outcome' <> 'loaded'
    or pg_catalog.jsonb_typeof(loaded -> 'declaration') <> 'object' then
    projection := pg_catalog.jsonb_build_object('outcome', 'refused');
    return next;
    return;
  end if;
  if loaded ? 'previewInstallationId' then
    preview_meta := vortex_record.resolve_record_action_context_internal(
      p_record_type_id, 'read'
    );
    preview_bounds := vortex_record.preview_record_field_bounds_internal(
      p_record_type_id, (preview_meta ->> 'storageContractId')::uuid,
      preview_meta -> 'recordType'
    );
    if preview_bounds is null then
      projection := pg_catalog.jsonb_build_object('outcome', 'refused');
      return next;
      return;
    end if;
    bounds := preview_bounds;
  else
    if p_decision is not null then
      -- The page's set pass decided this exact record in this invocation from
      -- these facts; only the fixed record adapter can pass it.
      if p_loaded is null
        or p_decision ->> 'recordId' is distinct from pg_catalog.lower(p_record_id::text) then
        raise exception using errcode = '22023', message = 'Page record decision is invalid';
      end if;
      -- It is used only while it is still current now: an allowed decision
      -- whose own deadline (every matched permission path, share and group
      -- membership) and the page eligibility are both still in the future.
      -- Anything else is decided again exactly, at this row's own time.
      batched := coalesce(p_decision ->> 'outcome' = 'allowed'
        and (p_decision ->> 'validUntil')::timestamptz > pg_catalog.clock_timestamp()
        and p_page_eligibility ->> 'outcome' = 'eligible'
        and (p_page_eligibility ->> 'validUntil')::timestamptz > pg_catalog.clock_timestamp(), false);
    end if;
    if batched then
      decision := p_decision;
    elsif p_page_eligibility ->> 'outcome' = 'eligible'
      and loaded -> 'declaration' = p_page_declaration
      and (p_page_eligibility ->> 'validUntil')::timestamptz > pg_catalog.clock_timestamp() then
      decision := vortex_access.evaluate_record_access_with_validated_types_internal(
        loaded -> 'declaration', p_record_id, loaded -> 'facts', p_page_eligibility,
        p_validated_record_types
      );
    else
      decision := vortex_access.evaluate_organization_record_access_internal(
        loaded -> 'declaration', p_record_id, loaded -> 'facts'
      );
    end if;
    if decision ->> 'outcome' <> 'allowed' then
      projection := pg_catalog.jsonb_build_object('outcome', 'refused');
      -- A decision, even a refusal, means the record types passed validation;
      -- the page reuses them. Callers read read_facts only for allowed rows.
      read_facts := pg_catalog.jsonb_build_object(
        'validatedRecordTypes', loaded -> 'facts' -> 'recordTypes'
      );
      return next;
      return;
    end if;
    bounds := coalesce(case when batched then p_bounds end,
      vortex_access.resolve_record_field_bounds_internal(decision));
  end if;
  if batched and bounds ? 'projectedReadableFieldIds' then
    -- The page pass derived these once for the record type and these bounds.
    bounds := (bounds - 'projectedReadableFieldIds')
      || pg_catalog.jsonb_build_object('readableFieldIds', bounds -> 'projectedReadableFieldIds');
  else
    bounds := bounds || pg_catalog.jsonb_build_object('readableFieldIds',
      vortex_record.project_derived_readable_field_ids_internal(
        loaded, p_record_type_id, p_record_id, bounds -> 'readableFieldIds',
        bounds -> 'readableFieldIds', '[]'::jsonb
      )
    );
  end if;
  columns_value := loaded -> 'columns';
  -- Read-time calculations are worked out here, at one statement timestamp in
  -- the organisation's time zone, from the record's stored values. They are
  -- never read from storage.
  select coalesce(pg_catalog.jsonb_object_agg(pg_catalog.lower(field.value ->> 'fieldId'), field.value), '{}'::jsonb)
  into read_time_fields
  from pg_catalog.jsonb_array_elements(loaded -> 'facts' -> 'recordTypes') as record_type(value)
  cross join lateral pg_catalog.jsonb_array_elements(record_type.value -> 'fields') as field(value)
  where pg_catalog.lower(record_type.value ->> 'recordTypeId') = pg_catalog.lower(p_record_type_id::text)
    and field.value ->> 'type' = 'calculation'
    and (field.value #>> '{settings,evaluation}' = 'read_time'
      or field.value #>> '{settings,expression,kind}' = 'deadline_passed');
  if read_time_fields <> '{}'::jsonb then
    read_time_clock := vortex_record.read_time_clock_internal();
  end if;
  for field_id in
    select item.value #>> '{}' from pg_catalog.jsonb_array_elements(bounds -> 'readableFieldIds') as item(value)
  loop
    if not (columns_value ? field_id) then
      continue;
    end if;
    if read_time_fields ? pg_catalog.lower(field_id) then
      read_time_expression := read_time_fields -> pg_catalog.lower(field_id) #> '{settings,expression}';
      -- Only the deadline-passed form is defined; another read-time form is
      -- withheld rather than disclosed from a stored column.
      if read_time_expression ->> 'kind' is distinct from 'deadline_passed' then
        continue;
      end if;
      due_key := pg_catalog.lower(read_time_expression ->> 'dueFieldId');
      status_key := pg_catalog.lower(read_time_expression ->> 'statusFieldId');
      due_value := loaded -> 'fieldValues' -> due_key;
      status_value := case when status_key is null then null else loaded -> 'fieldValues' -> status_key end;
      if status_value is not null and status_value <> 'null'::jsonb and exists (
        select 1
        from pg_catalog.jsonb_array_elements(coalesce(read_time_expression -> 'terminalStatusValues', '[]'::jsonb))
          as terminal(value)
        where terminal.value = status_value
      ) then
        read_time_value := 'false'::jsonb;
      elsif pg_catalog.jsonb_typeof(due_value) = 'string'
        and loaded -> 'columns' -> due_key ->> 'databaseValueType' = 'date' then
        -- Without the organisation's time zone the local date is unknown.
        if read_time_clock ->> 'organizationLocalDate' is null then
          continue;
        end if;
        read_time_value := pg_catalog.to_jsonb((read_time_clock ->> 'organizationLocalDate') > (due_value #>> '{}'));
      elsif pg_catalog.jsonb_typeof(due_value) = 'string'
        and loaded -> 'columns' -> due_key ->> 'databaseValueType' = 'timestamp_with_time_zone' then
        read_time_value := pg_catalog.to_jsonb(
          (read_time_clock ->> 'instant')::timestamp with time zone
            >= (due_value #>> '{}')::timestamp with time zone
        );
      else
        read_time_value := 'null'::jsonb;
      end if;
      values_value := values_value || pg_catalog.jsonb_build_object(field_id, read_time_value);
    else
      values_value := values_value || pg_catalog.jsonb_build_object(field_id, loaded -> 'fieldValues' -> field_id);
    end if;
  end loop;
  projection := pg_catalog.jsonb_build_object('outcome', 'allowed', 'recordId', p_record_id,
    'concurrencyNumber', loaded -> 'concurrencyNumber', 'values', values_value);
  read_facts := loaded;
  read_bounds := bounds;
  return next;
end
$function$;

create or replace function vortex_record.read_record_projection_with_validated_types_internal(
  p_record_type_id uuid,
  p_record_id uuid,
  p_page_declaration jsonb,
  p_page_eligibility jsonb,
  p_validated_record_types jsonb,
  p_projection_row jsonb,
  p_loaded jsonb
)
returns table (projection jsonb, read_facts jsonb, read_bounds jsonb)
language sql volatile security invoker set search_path = ''
as $function$
  select * from vortex_record.read_record_projection_with_validated_types_internal(
    p_record_type_id, p_record_id, p_page_declaration, p_page_eligibility,
    p_validated_record_types, p_projection_row, p_loaded, null::jsonb, null::jsonb
  )
$function$;

create or replace function vortex_record.read_record_projection_with_validated_types_internal(
  p_record_type_id uuid,
  p_record_id uuid,
  p_page_declaration jsonb,
  p_page_eligibility jsonb,
  p_validated_record_types jsonb,
  p_projection_row jsonb
)
returns table (projection jsonb, read_facts jsonb, read_bounds jsonb)
language sql volatile security invoker set search_path = ''
as $function$
  select * from vortex_record.read_record_projection_with_validated_types_internal(
    p_record_type_id, p_record_id, p_page_declaration, p_page_eligibility,
    p_validated_record_types, p_projection_row, null::jsonb
  )
$function$;

create or replace function vortex_record.read_record_projection_with_validated_types_internal(
  p_record_type_id uuid,
  p_record_id uuid,
  p_page_declaration jsonb,
  p_page_eligibility jsonb,
  p_validated_record_types jsonb
)
returns table (projection jsonb, read_facts jsonb, read_bounds jsonb)
language sql volatile security invoker set search_path = ''
as $function$
  select * from vortex_record.read_record_projection_with_validated_types_internal(
    p_record_type_id, p_record_id, p_page_declaration, p_page_eligibility,
    p_validated_record_types, null::jsonb
  )
$function$;

alter function vortex_record.read_record_projection_with_validated_types_internal(uuid,uuid,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb) owner to vortex_owner;
alter function vortex_record.read_record_projection_with_validated_types_internal(uuid,uuid,jsonb,jsonb,jsonb,jsonb,jsonb) owner to vortex_owner;
alter function vortex_record.read_record_projection_with_validated_types_internal(uuid,uuid,jsonb,jsonb,jsonb,jsonb) owner to vortex_owner;
alter function vortex_record.read_record_projection_with_validated_types_internal(uuid,uuid,jsonb,jsonb,jsonb) owner to vortex_owner;
revoke all on function vortex_record.read_record_projection_with_validated_types_internal(uuid,uuid,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_record.read_record_projection_with_validated_types_internal(uuid,uuid,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb)
  to vortex_record_adapter;
revoke all on function vortex_record.read_record_projection_with_validated_types_internal(uuid,uuid,jsonb,jsonb,jsonb,jsonb,jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_record.read_record_projection_with_validated_types_internal(uuid,uuid,jsonb,jsonb,jsonb,jsonb,jsonb)
  to vortex_record_adapter;
revoke all on function vortex_record.read_record_projection_with_validated_types_internal(uuid,uuid,jsonb,jsonb,jsonb,jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_record.read_record_projection_with_validated_types_internal(uuid,uuid,jsonb,jsonb,jsonb,jsonb)
  to vortex_record_adapter;
revoke all on function vortex_record.read_record_projection_with_validated_types_internal(uuid,uuid,jsonb,jsonb,jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_record.read_record_projection_with_validated_types_internal(uuid,uuid,jsonb,jsonb,jsonb)
  to vortex_record_adapter;
comment on function vortex_record.read_record_projection_with_validated_types_internal(uuid,uuid,jsonb,jsonb,jsonb) is
  'Private page read projection that reuses eligibility only for an identical declaration before its expiry; each record retains its own facts, scope and field bounds.';

set local role vortex_record_adapter;

create or replace function vortex_record.read_record_page_decisions_internal(
  p_record_type_id uuid,
  p_first_loaded jsonb,
  p_page_declaration jsonb,
  p_page_eligibility jsonb,
  p_record_ids uuid[]
)
returns table (record_id uuid, loaded jsonb, decision jsonb, bounds jsonb)
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  context_value jsonb;
  checked_at timestamptz;
  type_meta jsonb := p_first_loaded -> 'recordTypeMeta';
  load_sql text;
  page_records jsonb;
  page_record_ids uuid[];
  page_concurrency bigint[];
  page_definition_revisions bigint[];
  narrowed boolean := false;
  decisions jsonb;
  decision_item jsonb;
  facts_item jsonb;
  bounds_by_route jsonb := '{}'::jsonb;
  bounds_key text;
  row_position integer;
  envelope jsonb := p_first_loaded;
begin
  -- The page's read decisions in one pass. The first record's facts, loaded by
  -- the exact loader in this invocation, supply the installation-wide part of
  -- every record's facts; each record contributes only its own stored row. A
  -- record type whose read facts can reach other records (an inherited owner
  -- or a relationship route) is not decided here at all, and neither is a
  -- preview, a protected projection or an expired page eligibility.
  if p_record_type_id is null
    or pg_catalog.cardinality(p_record_ids) is null
    or pg_catalog.cardinality(p_record_ids) > 201
    or p_first_loaded ->> 'outcome' is distinct from 'loaded'
    or p_first_loaded ? 'previewInstallationId'
    or (p_first_loaded ->> 'isSystemProjection')::boolean is distinct from false
    or p_first_loaded -> 'declaration' is distinct from p_page_declaration
    or pg_catalog.lower(p_first_loaded #>> '{facts,binding,recordTypeId}')
      is distinct from pg_catalog.lower(p_record_type_id::text)
    or pg_catalog.jsonb_typeof(type_meta) is distinct from 'object'
    or pg_catalog.lower(type_meta ->> 'recordTypeId') is distinct from pg_catalog.lower(p_record_type_id::text)
    or coalesce(type_meta ->> 'ownershipMode', '') = 'inherited'
    or pg_catalog.jsonb_array_length(p_first_loaded #> '{facts,records}') is distinct from 1
    or p_first_loaded #> '{facts,edges}' is distinct from '[]'::jsonb
    or p_page_eligibility ->> 'outcome' is distinct from 'eligible'
    or (p_page_eligibility ->> 'validUntil')::timestamptz <= pg_catalog.clock_timestamp()
    or exists (
      select 1
      from pg_catalog.jsonb_array_elements(p_page_declaration -> 'requiredPermissions') as required(value)
      cross join lateral pg_catalog.jsonb_array_elements(
        case when pg_catalog.jsonb_typeof(p_first_loaded -> 'accessPermissions'
            -> pg_catalog.lower(required.value ->> 'permissionId') -> 'recordScope' -> 'routes') = 'array'
          then p_first_loaded -> 'accessPermissions'
            -> pg_catalog.lower(required.value ->> 'permissionId') -> 'recordScope' -> 'routes'
          else '[{"kind": "relationship"}]'::jsonb end
      ) as route(value)
      where route.value ->> 'kind' = 'relationship'
    ) then
    return;
  end if;

  context_value := vortex_access.validated_human_request_context();
  if p_first_loaded -> 'context' is distinct from context_value then
    return;
  end if;

  -- The same record fact the exact loader builds, for every page record.
  load_sql := pg_catalog.format(
    'select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
       ''recordScope'', pg_catalog.jsonb_build_object(
         ''storageScope'', %L,
         ''organizationId'', stored.organisation_id,
         ''moduleRootId'', %L::uuid,
         ''recordTypeId'', %L::uuid,
         ''storageContractId'', %L::uuid,
         ''recordId'', stored.record_id
       ) || case when %L = ''application_contained''
         then pg_catalog.jsonb_build_object(''applicationRootId'', stored.application_root_id)
         else ''{}''::jsonb end,
       ''lifecycleState'', stored.lifecycle_state,
       ''fieldValues'', pg_catalog.jsonb_build_object(%s)
     ) || case
       when stored.owner_organisation_account_id is not null
         then pg_catalog.jsonb_build_object(
           ''ownerOrganizationAccountId'', stored.owner_organisation_account_id)
       when stored.owner_group_id is not null
         then pg_catalog.jsonb_build_object(''ownerGroupId'', stored.owner_group_id)
       else ''{}''::jsonb end order by requested.ordinality),
     pg_catalog.array_agg(stored.record_id order by requested.ordinality),
     pg_catalog.array_agg(stored.concurrency_number order by requested.ordinality),
     pg_catalog.array_agg(stored.definition_revision order by requested.ordinality)
     from pg_catalog.unnest($2) with ordinality as requested(id, ordinality)
     join record_data.%I as stored
       on stored.organisation_id = $1 and stored.record_id = requested.id',
    type_meta ->> 'storageScope', (type_meta ->> 'moduleRootId')::uuid, p_record_type_id,
    (type_meta ->> 'storageContractId')::uuid, type_meta ->> 'storageScope',
    type_meta ->> 'valueExpression', type_meta ->> 'table'
  );
  execute load_sql
    into page_records, page_record_ids, page_concurrency, page_definition_revisions
    using (context_value ->> 'organizationId')::uuid, p_record_ids;
  if page_records is null then
    return;
  end if;

  -- When nothing about this record type can reach another record or another
  -- record type (no total field, and every route of every permission on it is
  -- an all-record, owner or direct-share route), each record's facts carry
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
        and (pg_catalog.jsonb_typeof(declared.value #> '{recordScope,routes}') is distinct from 'array'
          or exists (
            select 1
            from pg_catalog.jsonb_array_elements(
              case when pg_catalog.jsonb_typeof(declared.value #> '{recordScope,routes}') = 'array'
                then declared.value #> '{recordScope,routes}' else '[]'::jsonb end
            ) as route(value)
            where coalesce(route.value ->> 'kind', '') not in ('all_records', 'ownership', 'direct_share')
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

  checked_at := pg_catalog.clock_timestamp();
  decisions := vortex_access.decide_record_page_scope_internal(
    context_value, checked_at, p_page_declaration, p_page_eligibility,
    p_first_loaded #> '{facts,recordTypes}', page_records, true
  );
  if decisions is null then
    return;
  end if;

  for decision_item, facts_item, row_position in
    select decided.value, page_records -> (decided.ordinality::integer - 1), decided.ordinality::integer
    from pg_catalog.jsonb_array_elements(decisions) with ordinality as decided(value, ordinality)
  loop
    if decision_item = 'null'::jsonb then
      continue;
    end if;
    record_id := (decision_item ->> 'recordId')::uuid;
    if record_id is distinct from page_record_ids[row_position]
      or record_id is distinct from (facts_item #>> '{recordScope,recordId}')::uuid then
      raise exception using errcode = '55000', message = 'Page record decisions are misaligned';
    end if;
    decision := decision_item;
    bounds := null;
    loaded := pg_catalog.jsonb_set(envelope, '{facts,records}',
        pg_catalog.jsonb_build_array(facts_item))
      || pg_catalog.jsonb_build_object(
        'concurrencyNumber', page_concurrency[row_position],
        'definitionRevision', page_definition_revisions[row_position],
        'fieldValues', facts_item -> 'fieldValues');
    if decision_item ->> 'outcome' = 'allowed' then
      -- The same contributions have the same field policy: resolve each
      -- distinct contribution set once for the page.
      bounds_key := pg_catalog.jsonb_build_array(
        decision_item -> 'organizationId', decision_item -> 'matchedContributions')::text;
      bounds := bounds_by_route -> bounds_key;
      if bounds is null then
        bounds := vortex_access.resolve_record_field_bounds_internal(decision_item);
        if narrowed then
          -- Without a total field the derived readable set depends only on the
          -- record type and these bounds, not on the record.
          bounds := bounds || pg_catalog.jsonb_build_object('projectedReadableFieldIds',
            vortex_record.project_derived_readable_field_ids_internal(
              loaded, p_record_type_id, record_id, bounds -> 'readableFieldIds',
              bounds -> 'readableFieldIds', '[]'::jsonb));
        end if;
        bounds_by_route := bounds_by_route || pg_catalog.jsonb_build_object(bounds_key, bounds);
      end if;
    end if;
    return next;
  end loop;
end
$function$;

alter function vortex_record.read_record_page_decisions_internal(uuid,jsonb,jsonb,jsonb,uuid[])
  owner to vortex_record_adapter;
revoke all on function vortex_record.read_record_page_decisions_internal(uuid,jsonb,jsonb,jsonb,uuid[])
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

comment on function vortex_record.read_record_page_decisions_internal(uuid,jsonb,jsonb,jsonb,uuid[]) is
  'Private page read pass for the fixed record adapter: loads the stored facts of every candidate record of one page in one statement, decides them together through the set-based exact decision with the page eligibility computed once in this invocation, and resolves field bounds once per distinct contribution set; each decided record carries the facts the exact loader would give it, narrowed to its own record type and permissions when nothing about that type reaches another record or type; returns only records it decided, so every other record keeps the exact single-record path.';

create or replace function vortex_record.read_record_capabilities_page_internal(
  p_record_type_id uuid,
  p_rows jsonb
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
  jobs jsonb := '[]'::jsonb;
  decisions jsonb := '[]'::jsonb;
  bounds_by_route jsonb := '{}'::jsonb;
  bounds_key text;
  update_bounds jsonb;
  results jsonb := '[]'::jsonb;
  row_result jsonb;
  decision_item jsonb;
  action_decision jsonb;
  changeable_field_ids jsonb;
  actions text[];
  same_jobs jsonb;
  decisions_by_row jsonb := '{}'::jsonb;
  same_permission_by_id jsonb;
  same_target_meta jsonb;
  same_context_root jsonb;
begin
  if p_record_type_id is null or pg_catalog.jsonb_typeof(p_rows) is distinct from 'array'
    or pg_catalog.jsonb_array_length(p_rows) > 200 then
    raise exception using errcode = '22023', message = 'Page capability input is invalid';
  end if;

  for row_item in
    select item.value from pg_catalog.jsonb_array_elements(p_rows) as item(value)
  loop
    row_index := row_index + 1;
    if pg_catalog.jsonb_typeof(row_item) is distinct from 'object'
      or not (row_item ?& array['recordId', 'readFacts', 'readBounds'])
      or not vortex_platform.is_non_nil_uuid(row_item ->> 'recordId')
      or pg_catalog.jsonb_typeof(row_item -> 'readFacts') is distinct from 'object'
      or pg_catalog.jsonb_typeof(row_item -> 'readBounds') is distinct from 'object' then
      raise exception using errcode = '22023', message = 'Page capability input is invalid';
    end if;
    record_id := (row_item ->> 'recordId')::uuid;
    read_facts := row_item -> 'readFacts';
    read_bounds := row_item -> 'readBounds';
    readable_field_ids := read_bounds -> 'readableFieldIds';
    if pg_catalog.jsonb_typeof(readable_field_ids) is distinct from 'array' then
      raise exception using errcode = '22023', message = 'Page capability bounds are invalid';
    end if;

    -- The read projection already made the exact record decision over these
    -- facts. Reuse that validated closure only for simple action routes.
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
    if not use_exact_row and same_jobs is not null
      and permission_by_id = same_permission_by_id and target_meta = same_target_meta
      and read_facts -> 'context' -> 'applicationRootId' = same_context_root then
      -- Same permissions, record type and Application as an earlier row of the
      -- page: the same simple action jobs.
      jobs := jobs || (
        select coalesce(pg_catalog.jsonb_agg(
          job.value || pg_catalog.jsonb_build_object('rowIndex', row_index)
          order by job.ordinality), '[]'::jsonb)
        from pg_catalog.jsonb_array_elements(same_jobs) with ordinality as job(value, ordinality)
      );
    elsif not use_exact_row then
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
                ('all_records', 'ownership', 'direct_share')
            )
        ) into simple_action;
        if not simple_action then
          use_exact_row := true;
          exit;
        end if;
        if required_permissions is not null then
          jobs := jobs || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
            'rowIndex', row_index,
            'actionKind', action_kind,
            'requiredPermissions', required_permissions
          ));
        end if;
      end loop;
      if not use_exact_row then
        same_permission_by_id := permission_by_id;
        same_target_meta := target_meta;
        same_context_root := read_facts -> 'context' -> 'applicationRootId';
        select coalesce(pg_catalog.jsonb_agg(job.value - 'rowIndex' order by job.ordinality), '[]'::jsonb)
        into same_jobs
        from pg_catalog.jsonb_array_elements(jobs) with ordinality as job(value, ordinality)
        where (job.value ->> 'rowIndex')::integer = row_index;
      end if;
    end if;
    if use_exact_row then
      -- Discard any simple jobs accumulated before a complex route was found.
      jobs := (
        select coalesce(pg_catalog.jsonb_agg(job.value order by job.ordinality), '[]'::jsonb)
        from pg_catalog.jsonb_array_elements(jobs) with ordinality as job(value, ordinality)
        where (job.value ->> 'rowIndex')::integer <> row_index
      );
      row_result := vortex_record.read_record_capabilities_internal(
        p_record_type_id, record_id, read_facts, read_bounds
      );
      if row_result is null then
        raise exception using errcode = '55000', message = 'Record capabilities are unavailable';
      end if;
      results := results || pg_catalog.jsonb_build_array(row_result);
    else
      results := results || pg_catalog.jsonb_build_array('null'::jsonb);
    end if;
  end loop;

  if jobs <> '[]'::jsonb then
    decisions := vortex_access.evaluate_organization_record_access_page_internal(p_rows, jobs);
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
    if results -> (row_index - 1) <> 'null'::jsonb then
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
    end loop;
    if pg_catalog.jsonb_array_length(changeable_field_ids) = 0 then
      actions := pg_catalog.array_remove(actions, 'update');
    end if;
    results := pg_catalog.jsonb_set(results, array[(row_index - 1)::text],
      pg_catalog.jsonb_build_object(
        'changeableFieldIds', changeable_field_ids,
        'actions', pg_catalog.to_jsonb(actions)
      ));
  end loop;
  return results;
end
$function$;

alter function vortex_record.read_record_capabilities_page_internal(uuid,jsonb)
  owner to vortex_record_adapter;

revoke all on function vortex_record.read_record_capabilities_page_internal(uuid,jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

comment on function vortex_record.read_record_capabilities_page_internal(uuid,jsonb) is
  'Private list capability pass: evaluates simple action declarations across readable page rows together, while complex routes use their exact single-record path.';

create or replace function vortex_record.run_module_query(
  p_module_root_id uuid,
  p_query_id uuid,
  p_expected_release_revision bigint,
  p_input_values jsonb,
  p_requested_field_ids jsonb,
  p_page_size integer,
  p_after jsonb,
  p_requested_system_field_keys jsonb,
  p_user_inputs jsonb,
  p_direction text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  -- The most candidate rows one request examines. A page that the budget ends
  -- early still returns a position, so a later request resumes exactly there.
  scan_limit constant integer := 500;
  uuid_pattern constant text :=
    '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
  prepared_plan jsonb;
  storage_plan jsonb;
  context_organization_id uuid;
  context_application_root_id uuid;
  resolved jsonb;
  query_item jsonb;
  record_type_item jsonb;
  record_type_id_value uuid;
  v_storage_contract_id uuid;
  mapping_row vortex_record.field_storage_mappings%rowtype;
  field_item jsonb;
  fields_by_id jsonb := '{}'::jsonb;
  field_key text;
  selected_ids text[];
  requested_ids text[] := array[]::text[];
  sort_item jsonb;
  sort_ids text[] := array[]::text[];
  declared_sort_ids text[] := array[]::text[];
  cursor_sort jsonb := '[]'::jsonb;
  sort_directions text[] := array[]::text[];
  scan_directions text[] := array[]::text[];
  sort_value_sql text[] := array[]::text[];
  sort_sql_types text[] := array[]::text[];
  filter_condition jsonb;
  filter_ids text[] := array[]::text[];
  filter_types jsonb := '{}'::jsonb;
  filter_nulls jsonb := '{}'::jsonb;
  filter_expressions text[] := array[]::text[];
  filter_predicate text;
  filter_exact boolean;
  filter_parameters jsonb := '[]'::jsonb;
  parameter_types jsonb := '{}'::jsonb;
  parameter_values jsonb := '{}'::jsonb;
  after_sort_key text[];
  after_phase text;
  after_record_id uuid;
  sort_index integer;
  column_sql text;
  value_sql text;
  pushed boolean;
  after_terms text[] := array[]::text[];
  equal_prefix text := '';
  keyset_sql text := '';
  segment_predicates text[];
  segment_sql text;
  segment_prefix text;
  prefix_index integer;
  composite_sort jsonb;
  composite_index_ready boolean := false;
  record_id_direction text := 'ascending';
  scan_record_id_direction text := 'ascending';
  -- Whether each sort key has the aligned field index (stored and sortable or unique).
  sort_index_backed boolean[] := array[]::boolean[];
  sort_stored boolean[] := array[]::boolean[];
  order_terms text[] := array[]::text[];
  sort_key_terms text[] := array[]::text[];
  order_by_sql text;
  scan_sql text;
  read_row record;
  page_access_loaded jsonb;
  page_declaration jsonb;
  page_eligibility jsonb;
  page_eligibility_checked boolean := false;
  validated_record_types jsonb;
  readable_field_ids text[] := array[]::text[];
  access_sql text;
  access_parameters jsonb := '[]'::jsonb;
  access_owner_account_id uuid;
  access_owner_group_ids uuid[] := array[]::uuid[];
  access_shared_record_ids uuid[] := array[]::uuid[];
  physical_table_token text;
  storage_scope text;
  scan_source_sql text;
  scan_projection_sql text := 'null::jsonb';
  projection_page_scan boolean := false;
  projection_sort_key text;
  projection_batch jsonb;
  projection_batch_exhausted boolean := false;
  projection_last_record_id uuid;
  projection_last_sort_key text[];
  scan_record record;
  scan_cursor refcursor;
  cursor_position integer;
  lookahead_record record;
  lookahead_ids uuid[];
  page_first_loaded jsonb;
  decided_ids uuid[] := array[]::uuid[];
  decided_loaded jsonb[];
  decided_decisions jsonb[];
  decided_bounds jsonb[];
  decided_index integer;
  page_batching boolean := true;
  examined integer := 0;
  budget_exhausted boolean := false;
  more_rows boolean := false;
  passes boolean;
  needs_refusal_check boolean;
  projection jsonb;
  readable_values jsonb;
  row_capabilities jsonb;
  capability_rows jsonb[] := array[]::jsonb[];
  page_capabilities jsonb;
  capability_index integer;
  rows_value jsonb := '[]'::jsonb;
  row_count integer := 0;
  last_examined_sort_key text[];
  last_examined_record_id uuid;
  last_returned_sort_key text[];
  last_returned_record_id uuid;
  first_returned_sort_key text[];
  first_returned_record_id uuid;
  next_value jsonb := null;
  opposite_value jsonb := null;
  system_field_keys text[] := array[]::text[];
  system_key text;
  system_expressions text[] := array[]::text[];
  system_columns_sql text;
  read_time_field boolean;
  read_time_clock jsonb;
  read_time_sql text;
  list_key text;
  declared_list jsonb;
  parsed_ids text[];
  declared_lists jsonb := '{}'::jsonb;
  declared_sortable_ids text[] := array[]::text[];
  declared_searchable_ids text[] := array[]::text[];
  user_sort jsonb;
  user_search text;
  user_search_folded text;
  effective_sort jsonb;
  effective_sort_is_user boolean := false;
  search_candidate_ids text[] := array[]::text[];
  search_field_ids text[] := array[]::text[];
  search_matches boolean;
  board_member_mode boolean := false;
  group_member_mode boolean := false;
  board_member jsonb;
  board_choice_field_id text;
  board_column_kind text;
  board_column_value text;
  board_options jsonb;
  board_option_values text[] := array[]::text[];
  board_option jsonb;
  board_member_matches boolean;
  group_member jsonb;
  group_selector jsonb;
  group_selector_item jsonb;
  group_selector_value jsonb;
  group_selector_values jsonb := '{}'::jsonb;
  group_selector_types jsonb := '{}'::jsonb;
  group_candidate_values jsonb;
  group_by_ids text[] := array[]::text[];
  group_key text;
  group_field_type text;
  group_value_valid boolean;
  group_member_matches boolean;
  preview_mode boolean := false;
begin
  -- Request shape. Nothing here is authority; it only bounds the work.
  if p_direction not in ('forward', 'backward') or p_direction is null then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'request_invalid');
  end if;
  if p_requested_field_ids is null
    or pg_catalog.jsonb_typeof(p_requested_field_ids) <> 'array'
    or pg_catalog.jsonb_array_length(p_requested_field_ids) not between 1 and 200
    or p_page_size is null or p_page_size not between 1 and 200 then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'request_invalid');
  end if;
  for field_item in select item.value from pg_catalog.jsonb_array_elements(p_requested_field_ids) as item(value) loop
    if pg_catalog.jsonb_typeof(field_item) <> 'string'
      or pg_catalog.lower(field_item #>> '{}') !~ uuid_pattern
      or pg_catalog.lower(field_item #>> '{}') = any (requested_ids) then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'request_invalid');
    end if;
    requested_ids := pg_catalog.array_append(requested_ids, pg_catalog.lower(field_item #>> '{}'));
  end loop;

  -- Declared system values: a closed set, each named at most once.
  if p_requested_system_field_keys is null then
    p_requested_system_field_keys := '[]'::jsonb;
  end if;
  if pg_catalog.jsonb_typeof(p_requested_system_field_keys) <> 'array'
    or pg_catalog.jsonb_array_length(p_requested_system_field_keys) > 5 then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'request_invalid');
  end if;
  for field_item in
    select item.value from pg_catalog.jsonb_array_elements(p_requested_system_field_keys) as item(value)
  loop
    if pg_catalog.jsonb_typeof(field_item) <> 'string'
      or (field_item #>> '{}') not in ('created_at', 'created_by', 'updated_at', 'updated_by', 'owner')
      or (field_item #>> '{}') = any (system_field_keys) then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'request_invalid');
    end if;
    system_field_keys := pg_catalog.array_append(system_field_keys, field_item #>> '{}');
  end loop;

  -- User-facing sort and search, plus the user filter passed to shared
  -- preparation. The component's declared field sets only narrow user input;
  -- they never supply authority or replace the published query contract.
  if p_user_inputs is null then
    p_user_inputs := '{}'::jsonb;
  end if;
  if pg_catalog.jsonb_typeof(p_user_inputs) <> 'object' then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'request_invalid');
  end if;
  board_member_mode := p_user_inputs ? 'boardMember';
  group_member_mode := p_user_inputs ? 'groupMember';
  if board_member_mode and group_member_mode then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'request_invalid');
  end if;
  if exists (
    select 1 from pg_catalog.jsonb_object_keys(p_user_inputs) as supplied(key)
    where supplied.key not in (
      'sort', 'filter', 'search', 'sortableFieldIds', 'filterableFieldIds', 'searchableFieldIds',
      'boardMember', 'groupMember'
    )
  ) then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'request_invalid');
  end if;
  if group_member_mode then
    group_member := p_user_inputs -> 'groupMember';
    if pg_catalog.jsonb_typeof(group_member) is distinct from 'object' then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'request_invalid');
    end if;
    if group_member - array['values']::text[] <> '{}'::jsonb
      or not (group_member ? 'values')
      or pg_catalog.jsonb_typeof(group_member -> 'values') is distinct from 'array' then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'request_invalid');
    end if;
    if pg_catalog.jsonb_array_length(group_member -> 'values') not between 1 and 10 then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'request_invalid');
    end if;
    group_selector := group_member -> 'values';
    for group_selector_item in
      select item.value from pg_catalog.jsonb_array_elements(group_selector) as item(value)
    loop
      if pg_catalog.jsonb_typeof(group_selector_item) is distinct from 'object' then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'request_invalid');
      end if;
      if group_selector_item - array['fieldId', 'fieldType', 'value']::text[] <> '{}'::jsonb
        or not (group_selector_item ? 'fieldId')
        or not (group_selector_item ? 'fieldType')
        or not (group_selector_item ? 'value')
        or pg_catalog.jsonb_typeof(group_selector_item -> 'fieldId') is distinct from 'string'
        or pg_catalog.lower(group_selector_item ->> 'fieldId') !~ uuid_pattern
        or pg_catalog.lower(group_selector_item ->> 'fieldId') = '00000000-0000-0000-0000-000000000000'
        or pg_catalog.jsonb_typeof(group_selector_item -> 'fieldType') is distinct from 'string'
        or group_selector_item ->> 'fieldType' not in (
          'text', 'whole_number', 'decimal_number', 'yes_no', 'date', 'date_time',
          'choice', 'reference_number', 'email_address', 'phone_number', 'web_address',
          'link', 'link_to_one_of_several', 'link_to_person'
        ) then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'request_invalid');
      end if;
      group_key := pg_catalog.lower(group_selector_item ->> 'fieldId');
      if group_selector_types ? group_key then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'request_invalid');
      end if;
      group_field_type := group_selector_item ->> 'fieldType';
      group_selector_value := group_selector_item -> 'value';
      group_value_valid := group_selector_value = 'null'::jsonb;
      if not group_value_valid then
        case group_field_type
          when 'text', 'reference_number', 'email_address', 'phone_number', 'web_address' then
            group_value_valid := pg_catalog.jsonb_typeof(group_selector_value) = 'string';
          when 'choice' then
            group_value_valid := pg_catalog.jsonb_typeof(group_selector_value) = 'string'
              and pg_catalog.length(group_selector_value #>> '{}') between 1 and 120;
          when 'whole_number' then
            group_value_valid := pg_catalog.jsonb_typeof(group_selector_value) = 'number'
              and case when pg_catalog.pg_input_is_valid(group_selector_value #>> '{}', 'numeric') then
                (group_selector_value #>> '{}')::numeric = pg_catalog.trunc((group_selector_value #>> '{}')::numeric)
                and pg_catalog.abs((group_selector_value #>> '{}')::numeric) <= 9007199254740991
              else false end;
          when 'decimal_number' then
            group_value_valid := pg_catalog.jsonb_typeof(group_selector_value) = 'string'
              and group_selector_value #>> '{}' ~ '^-?(0|[1-9][0-9]*)(\.[0-9]+)?$';
          when 'yes_no' then
            group_value_valid := pg_catalog.jsonb_typeof(group_selector_value) = 'boolean';
          when 'date' then
            group_value_valid := pg_catalog.jsonb_typeof(group_selector_value) = 'string'
              and group_selector_value #>> '{}' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
              and pg_catalog.pg_input_is_valid(group_selector_value #>> '{}', 'date');
          when 'date_time' then
            group_value_valid := pg_catalog.jsonb_typeof(group_selector_value) = 'string'
              and group_selector_value #>> '{}' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}(:[0-9]{2}(\.[0-9]+)?)?(Z|[+-][0-9]{2}:[0-9]{2})$'
              and pg_catalog.substr(group_selector_value #>> '{}', 12, 2) between '00' and '23'
              and pg_catalog.substr(group_selector_value #>> '{}', 15, 2) between '00' and '59'
              and (pg_catalog.substr(group_selector_value #>> '{}', 17, 1) <> ':'
                or pg_catalog.substr(group_selector_value #>> '{}', 18, 2) between '00' and '59')
              and pg_catalog.pg_input_is_valid(group_selector_value #>> '{}', 'timestamp with time zone');
          when 'link', 'link_to_one_of_several' then
            group_value_valid := case when pg_catalog.jsonb_typeof(group_selector_value) = 'object' then
              group_selector_value - array['recordTypeId', 'recordId']::text[] = '{}'::jsonb
              and group_selector_value ? 'recordTypeId' and group_selector_value ? 'recordId'
              and pg_catalog.jsonb_typeof(group_selector_value -> 'recordTypeId') = 'string'
              and pg_catalog.lower(group_selector_value ->> 'recordTypeId') ~ uuid_pattern
              and pg_catalog.lower(group_selector_value ->> 'recordTypeId') <> '00000000-0000-0000-0000-000000000000'
              and pg_catalog.jsonb_typeof(group_selector_value -> 'recordId') = 'string'
              and pg_catalog.lower(group_selector_value ->> 'recordId') ~ uuid_pattern
              and pg_catalog.lower(group_selector_value ->> 'recordId') <> '00000000-0000-0000-0000-000000000000'
            else false end;
          when 'link_to_person' then
            group_value_valid := case when pg_catalog.jsonb_typeof(group_selector_value) = 'object' then
              group_selector_value - array['organizationAccountId']::text[] = '{}'::jsonb
              and group_selector_value ? 'organizationAccountId'
              and pg_catalog.jsonb_typeof(group_selector_value -> 'organizationAccountId') = 'string'
              and pg_catalog.lower(group_selector_value ->> 'organizationAccountId') ~ uuid_pattern
              and pg_catalog.lower(group_selector_value ->> 'organizationAccountId') <> '00000000-0000-0000-0000-000000000000'
            else false end;
          else
            group_value_valid := false;
        end case;
      end if;
      if not group_value_valid then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'request_invalid');
      end if;
      group_selector_types := group_selector_types || pg_catalog.jsonb_build_object(group_key, group_field_type);
      group_selector_values := group_selector_values || pg_catalog.jsonb_build_object(group_key, group_selector_value);
    end loop;
  end if;
  if board_member_mode then
    board_member := p_user_inputs -> 'boardMember';
    if pg_catalog.jsonb_typeof(board_member) is distinct from 'object'
      or board_member - array['choiceFieldId', 'column']::text[] <> '{}'::jsonb
      or not (board_member ? 'choiceFieldId') or not (board_member ? 'column')
      or pg_catalog.jsonb_typeof(board_member -> 'choiceFieldId') is distinct from 'string'
      or pg_catalog.lower(board_member ->> 'choiceFieldId') !~ uuid_pattern then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
    end if;
    board_choice_field_id := pg_catalog.lower(board_member ->> 'choiceFieldId');
    if pg_catalog.jsonb_typeof(board_member -> 'column') is distinct from 'object'
      or pg_catalog.jsonb_typeof(board_member #> '{column,kind}') is distinct from 'string' then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
    end if;
    board_column_kind := board_member #>> '{column,kind}';
    if board_column_kind = 'option' then
      if (board_member #> '{column}') - array['kind', 'value']::text[] <> '{}'::jsonb
        or not ((board_member #> '{column}') ? 'value')
        or pg_catalog.jsonb_typeof(board_member #> '{column,value}') is distinct from 'string'
        or coalesce(pg_catalog.length(board_member #>> '{column,value}'), 0) not between 1 and 120 then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
      end if;
      board_column_value := board_member #>> '{column,value}';
    elsif board_column_kind = 'unassigned' then
      if (board_member #> '{column}') - array['kind']::text[] <> '{}'::jsonb then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
      end if;
      board_column_value := null;
    else
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
    end if;
  end if;

  -- The list-only sortable and searchable allow-lists contain distinct field
  -- identities. Query preparation validates the filterable allow-list.
  for list_key in
    select pg_catalog.unnest(array['sortableFieldIds', 'searchableFieldIds'])
  loop
    declared_list := coalesce(p_user_inputs -> list_key, '[]'::jsonb);
    if pg_catalog.jsonb_typeof(declared_list) <> 'array' then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'request_invalid');
    end if;
    if pg_catalog.jsonb_array_length(declared_list) > 200 then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'request_invalid');
    end if;
    parsed_ids := array[]::text[];
    for field_item in
      select item.value from pg_catalog.jsonb_array_elements(declared_list) as item(value)
    loop
      if pg_catalog.jsonb_typeof(field_item) <> 'string'
        or pg_catalog.lower(field_item #>> '{}') !~ uuid_pattern
        or pg_catalog.lower(field_item #>> '{}') = any (parsed_ids) then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'request_invalid');
      end if;
      parsed_ids := pg_catalog.array_append(parsed_ids, pg_catalog.lower(field_item #>> '{}'));
    end loop;
    declared_lists := declared_lists || pg_catalog.jsonb_build_object(list_key, pg_catalog.to_jsonb(parsed_ids));
  end loop;
  select coalesce(pg_catalog.array_agg(item.value), array[]::text[]) into declared_sortable_ids
  from pg_catalog.jsonb_array_elements_text(declared_lists -> 'sortableFieldIds') as item(value);
  select coalesce(pg_catalog.array_agg(item.value), array[]::text[]) into declared_searchable_ids
  from pg_catalog.jsonb_array_elements_text(declared_lists -> 'searchableFieldIds') as item(value);

  -- The user's sort: the same pair shape as the published sort, bounded and each
  -- direction valid. It replaces the published order only when it is non-empty.
  user_sort := coalesce(p_user_inputs -> 'sort', '[]'::jsonb);
  if pg_catalog.jsonb_typeof(user_sort) <> 'array' then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'request_invalid');
  end if;
  if pg_catalog.jsonb_array_length(user_sort) > 20 then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'request_invalid');
  end if;

  -- The user's search: one bounded, non-blank text term; a blank term is absent.
  if p_user_inputs ? 'search'
    and pg_catalog.jsonb_typeof(p_user_inputs -> 'search') not in ('string', 'null') then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'request_invalid');
  end if;
  user_search := pg_catalog.btrim(p_user_inputs ->> 'search');
  if user_search = '' then
    user_search := null;
  end if;
  if user_search is not null and pg_catalog.length(user_search) > 200 then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'request_invalid');
  end if;
  user_search_folded := pg_catalog.lower(user_search);
  if (board_member_mode or group_member_mode) and (
    pg_catalog.jsonb_array_length(user_sort) <> 0
    or user_search is not null
    or pg_catalog.cardinality(declared_sortable_ids) <> 0
    or pg_catalog.cardinality(declared_searchable_ids) <> 0
    or (group_member_mode and p_user_inputs ? 'search'
      and pg_catalog.jsonb_typeof(p_user_inputs -> 'search') is distinct from 'null')
  ) then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'request_invalid');
  end if;

  foreach system_key in array system_field_keys loop
    system_expressions := pg_catalog.array_append(system_expressions, pg_catalog.format('%L, %s', system_key,
      case system_key
        when 'created_at' then
          'pg_catalog.to_jsonb(vortex_platform.format_timestamp_utc(stored.created_at))'
        when 'updated_at' then
          'pg_catalog.to_jsonb(vortex_platform.format_timestamp_utc(stored.updated_at))'
        when 'created_by' then 'pg_catalog.to_jsonb(stored.created_by)'
        when 'updated_by' then 'pg_catalog.to_jsonb(stored.updated_by)'
        else
          'case when stored.owner_organisation_account_id is not null then pg_catalog.jsonb_build_object(''kind'', ''organization_account'', ''organizationAccountId'', stored.owner_organisation_account_id) when stored.owner_group_id is not null then pg_catalog.jsonb_build_object(''kind'', ''group'', ''groupId'', stored.owner_group_id) else ''null''::jsonb end'
      end));
  end loop;
  system_columns_sql := pg_catalog.array_to_string(system_expressions, ', ');

  prepared_plan := vortex_record.prepare_module_query_internal(
    p_module_root_id, p_query_id, p_expected_release_revision, p_input_values,
    p_user_inputs -> 'filter', coalesce(p_user_inputs -> 'filterableFieldIds', '[]'::jsonb),
    'resolution', null
  );
  if prepared_plan ->> 'outcome' is distinct from 'prepared' then
    return prepared_plan;
  end if;

  resolved := prepared_plan -> 'resolved';
  query_item := prepared_plan -> 'query';
  record_type_item := prepared_plan -> 'recordType';
  record_type_id_value := (prepared_plan ->> 'recordTypeId')::uuid;
  context_organization_id := (prepared_plan #>> '{scope,organizationId}')::uuid;
  context_application_root_id := (prepared_plan #>> '{scope,applicationRootId}')::uuid;
  preview_mode := prepared_plan ? 'preview';
  if preview_mode and (
    board_member_mode or group_member_mode or pg_catalog.cardinality(system_field_keys) > 0
  ) then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
  end if;

  for field_item in
    select item.value from pg_catalog.jsonb_array_elements(record_type_item -> 'fields') as item(value)
  loop
    fields_by_id := fields_by_id || pg_catalog.jsonb_build_object(
      pg_catalog.lower(field_item ->> 'fieldId'), field_item
    );
  end loop;

  -- Grouped and totalled shapes are not plain rows. Only separately validated
  -- board and generic group member modes may read members from those Queries.
  if pg_catalog.jsonb_typeof(coalesce(query_item -> 'groupByFieldIds', '[]'::jsonb)) is distinct from 'array'
    or pg_catalog.jsonb_typeof(coalesce(query_item -> 'aggregates', '[]'::jsonb)) is distinct from 'array' then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
  end if;
  if pg_catalog.jsonb_array_length(coalesce(query_item -> 'aggregates', '[]'::jsonb)) > 20 then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
  end if;
  if group_member_mode then
    if pg_catalog.jsonb_array_length(query_item -> 'groupByFieldIds') not between 1 and 10 then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
    end if;
    for field_item in
      select item.value from pg_catalog.jsonb_array_elements(query_item -> 'groupByFieldIds') as item(value)
    loop
      if pg_catalog.jsonb_typeof(field_item) is distinct from 'string'
        or pg_catalog.lower(field_item #>> '{}') !~ uuid_pattern
        or pg_catalog.lower(field_item #>> '{}') = '00000000-0000-0000-0000-000000000000' then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
      end if;
      group_key := pg_catalog.lower(field_item #>> '{}');
      group_field_type := coalesce(fields_by_id -> group_key ->> 'type', '');
      if group_key = any (group_by_ids)
        or group_field_type not in (
          'text', 'whole_number', 'decimal_number', 'yes_no', 'date', 'date_time',
          'choice', 'reference_number', 'email_address', 'phone_number', 'web_address',
          'link', 'link_to_one_of_several', 'link_to_person'
        ) then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
      end if;
      group_by_ids := pg_catalog.array_append(group_by_ids, group_key);
    end loop;
    if pg_catalog.jsonb_array_length(group_selector) <> pg_catalog.cardinality(group_by_ids)
      or exists (
        select 1 from pg_catalog.jsonb_object_keys(group_selector_types) as supplied(key)
        where supplied.key <> all (group_by_ids)
      ) then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
    end if;
    foreach group_key in array group_by_ids loop
      if group_selector_types ->> group_key is distinct from fields_by_id -> group_key ->> 'type' then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
      end if;
    end loop;
  elsif board_member_mode then
    if pg_catalog.jsonb_array_length(coalesce(query_item -> 'groupByFieldIds', '[]'::jsonb)) <> 1 then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
    end if;
  elsif pg_catalog.jsonb_array_length(coalesce(query_item -> 'groupByFieldIds', '[]'::jsonb)) > 0
    or pg_catalog.jsonb_array_length(coalesce(query_item -> 'aggregates', '[]'::jsonb)) > 0 then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
  end if;
  if coalesce((query_item ->> 'relationshipHops')::integer, 0) <> 0 then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'relationship_invalid');
  end if;
  if p_page_size > coalesce((query_item ->> 'pageSize')::integer, 0) then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'page_size_invalid');
  end if;

  prepared_plan := vortex_record.prepare_module_query_internal(
    p_module_root_id, p_query_id, p_expected_release_revision, p_input_values,
    p_user_inputs -> 'filter', coalesce(p_user_inputs -> 'filterableFieldIds', '[]'::jsonb),
    'storage', prepared_plan
  );
  if prepared_plan ->> 'outcome' is distinct from 'prepared' then
    return prepared_plan;
  end if;
  storage_plan := prepared_plan;
  v_storage_contract_id := (prepared_plan #>> '{storage,storageContractId}')::uuid;
  preview_mode := prepared_plan ? 'preview';
  physical_table_token := prepared_plan #>> '{storage,physicalTableToken}';
  storage_scope := prepared_plan #>> '{storage,storageScope}';
  access_sql := prepared_plan #>> '{access,predicate}';
  if access_sql is null then
    raise exception using errcode = '55000',
      message = 'Prepared record query has no access predicate';
  end if;
  access_parameters := coalesce(prepared_plan #> '{access,parameters}', '[]'::jsonb);
  access_owner_account_id := nullif(prepared_plan #>> '{access,ownerAccountId}', '')::uuid;
  select coalesce(pg_catalog.array_agg(item.value::uuid), array[]::uuid[])
  into access_owner_group_ids
  from pg_catalog.jsonb_array_elements_text(prepared_plan #> '{access,ownerGroupIds}') as item(value);
  select coalesce(pg_catalog.array_agg(item.value::uuid), array[]::uuid[])
  into access_shared_record_ids
  from pg_catalog.jsonb_array_elements_text(prepared_plan #> '{access,sharedRecordIds}') as item(value);
  select coalesce(pg_catalog.array_agg(item.value), array[]::text[])
  into readable_field_ids
  from pg_catalog.jsonb_array_elements_text(prepared_plan -> 'readableFieldIds') as item(value);

  -- Search authority: the record type's own declared search priority. A component
  -- with only a search box declares no per-field list, so an empty declared set
  -- searches every field the record type marks searchable; a declared set narrows
  -- it. A row matches only through a field the reader can see on that row, so a
  -- hidden searchable value never decides a match.
  if pg_catalog.cardinality(declared_searchable_ids) > 0 then
    search_candidate_ids := declared_searchable_ids;
  else
    select coalesce(pg_catalog.array_agg(item.key), array[]::text[])
    into search_candidate_ids
    from pg_catalog.jsonb_object_keys(fields_by_id) as item(key);
  end if;
  foreach field_key in array search_candidate_ids loop
    if (fields_by_id ? field_key)
      and (fields_by_id -> field_key ->> 'searchPriority') in ('first', 'normal', 'last') then
      search_field_ids := pg_catalog.array_append(search_field_ids, field_key);
    end if;
  end loop;

  -- Projection: only fields the published query selects.
  select coalesce(pg_catalog.array_agg(pg_catalog.lower(item.value #>> '{}')), array[]::text[])
  into selected_ids
  from pg_catalog.jsonb_array_elements(query_item -> 'selectedFieldIds') as item(value);
  if exists (select 1 from pg_catalog.unnest(requested_ids) as requested(id) where requested.id <> all (selected_ids)) then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'field_unbounded');
  end if;
  if board_member_mode then
    if pg_catalog.lower(query_item #>> '{groupByFieldIds,0}') is distinct from board_choice_field_id
      or not (board_choice_field_id = any (selected_ids))
      or not (fields_by_id ? board_choice_field_id)
      or fields_by_id -> board_choice_field_id ->> 'type' is distinct from 'choice'
      or coalesce((fields_by_id -> board_choice_field_id ->> 'filterable')::boolean, false) is not true then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
    end if;
    board_options := fields_by_id #> array[board_choice_field_id, 'settings', 'options'];
    if pg_catalog.jsonb_typeof(board_options) is distinct from 'array'
      or pg_catalog.jsonb_array_length(board_options) not between 1 and 12 then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
    end if;
    for board_option in select item.value from pg_catalog.jsonb_array_elements(board_options) as item(value) loop
      if pg_catalog.jsonb_typeof(board_option) is distinct from 'object'
        or board_option - array['value', 'label', 'requiredPermissionId']::text[] <> '{}'::jsonb
        or not (board_option ? 'value') or not (board_option ? 'label')
        or pg_catalog.jsonb_typeof(board_option -> 'value') is distinct from 'string'
        or coalesce(pg_catalog.length(board_option ->> 'value'), 0) not between 1 and 120
        or pg_catalog.jsonb_typeof(board_option -> 'label') is distinct from 'string'
        or coalesce(pg_catalog.length(pg_catalog.btrim(board_option ->> 'label')), 0) not between 1 and 60
        or (board_option ? 'requiredPermissionId' and (
          pg_catalog.jsonb_typeof(board_option -> 'requiredPermissionId') is distinct from 'string'
          or pg_catalog.lower(board_option ->> 'requiredPermissionId') !~ uuid_pattern
          or pg_catalog.lower(board_option ->> 'requiredPermissionId') = '00000000-0000-0000-0000-000000000000'
        ))
        or (board_option ->> 'value') collate "C" = any (board_option_values) then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
      end if;
      board_option_values := pg_catalog.array_append(board_option_values, board_option ->> 'value');
    end loop;
    if board_column_kind = 'option'
      and not (board_column_value collate "C" = any (board_option_values)) then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
    end if;
  end if;

  -- Order: the published sort, or the user's chosen sort when one is supplied,
  -- over orderable typed columns, then the record id. A published sort field the
  -- reader is not guaranteed to see is validated but never pushed, so the scan
  -- order never depends on a value it may withhold. A user sort must instead be a
  -- field the component declares sortable, the record type declares sortable and
  -- the reader is guaranteed to see: silently ordering by something else would be
  -- wrong, so it is refused rather than pushed away.
  if board_member_mode or group_member_mode then
    effective_sort := '[]'::jsonb;
    effective_sort_is_user := false;
  elsif pg_catalog.jsonb_array_length(user_sort) > 0 then
    effective_sort := user_sort;
    effective_sort_is_user := true;
  else
    effective_sort := query_item -> 'sort';
    effective_sort_is_user := false;
  end if;
  for sort_item in
    select item.value from pg_catalog.jsonb_array_elements(effective_sort) as item(value)
  loop
    field_key := pg_catalog.lower(sort_item ->> 'fieldId');
    if field_key is null or not (fields_by_id ? field_key)
      or sort_item ->> 'direction' not in ('ascending', 'descending')
      or field_key = any (declared_sort_ids) then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'sort_invalid');
    end if;
    if effective_sort_is_user
      and (not (field_key = any (declared_sortable_ids))
        or coalesce((fields_by_id -> field_key ->> 'sortable')::boolean, false) is not true) then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'sort_invalid');
    end if;
    select mapping.* into mapping_row
    from vortex_record.field_storage_mappings as mapping
    where mapping.storage_contract_id = v_storage_contract_id
      and mapping.field_id = field_key::uuid;
    if not found or mapping_row.state is distinct from 'active' then
      if preview_mode then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'query_unavailable');
      end if;
      raise exception using errcode = '55000',
        message = 'Record storage disagrees with the installed definition';
    end if;
    declared_sort_ids := pg_catalog.array_append(declared_sort_ids, field_key);
    pushed := field_key = any (readable_field_ids);
    cursor_sort := cursor_sort || pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'fieldId', field_key, 'direction', sort_item ->> 'direction',
        'pushed', pushed
      )
    );
    if effective_sort_is_user and not pushed then
      -- The user's order must actually be the scan order.
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'sort_invalid');
    end if;
    -- A read-time field is worked out inside this statement, from the
    -- record's own stored values and one statement timestamp; it is never a
    -- stored column here.
    read_time_field := fields_by_id -> field_key ->> 'type' = 'calculation'
      and (fields_by_id -> field_key #>> '{settings,evaluation}' = 'read_time'
        or fields_by_id -> field_key #>> '{settings,expression,kind}' = 'deadline_passed');
    if read_time_field then
      read_time_clock := coalesce(read_time_clock, vortex_record.read_time_clock_internal());
      read_time_sql := vortex_record.read_time_deadline_expression_internal(
        v_storage_contract_id, fields_by_id -> field_key #> '{settings,expression}',
        read_time_clock
      );
      if read_time_sql is null then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'sort_invalid');
      end if;
      if not pushed then
        continue;
      end if;
      sort_ids := pg_catalog.array_append(sort_ids, field_key);
      sort_directions := pg_catalog.array_append(sort_directions, sort_item ->> 'direction');
      sort_value_sql := pg_catalog.array_append(sort_value_sql, read_time_sql);
      sort_sql_types := pg_catalog.array_append(sort_sql_types, 'boolean');
      sort_index_backed := pg_catalog.array_append(sort_index_backed, false);
      sort_stored := pg_catalog.array_append(sort_stored, false);
      continue;
    end if;
    -- JSON-valued fields (money, links, choice sets, documents) have no total
    -- order here; money in particular is never ordered across currencies.
    if mapping_row.database_value_type not in (
      'integer', 'decimal', 'boolean', 'date', 'timestamp_with_time_zone', 'text', 'uuid'
    ) then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'sort_invalid');
    end if;
    if not pushed then
      continue;
    end if;
    sort_ids := pg_catalog.array_append(sort_ids, field_key);
    sort_directions := pg_catalog.array_append(sort_directions, sort_item ->> 'direction');
    sort_value_sql := pg_catalog.array_append(
      sort_value_sql, pg_catalog.format('stored.%I', mapping_row.physical_column_token)
    );
    sort_index_backed := pg_catalog.array_append(sort_index_backed,
      coalesce((fields_by_id -> field_key ->> 'sortable')::boolean, false)
        or coalesce((fields_by_id -> field_key ->> 'unique')::boolean, false));
    sort_stored := pg_catalog.array_append(sort_stored, true);
    sort_sql_types := pg_catalog.array_append(sort_sql_types, case mapping_row.database_value_type
      when 'integer' then 'bigint'
      when 'decimal' then 'numeric'
      when 'boolean' then 'boolean'
      when 'date' then 'date'
      when 'timestamp_with_time_zone' then 'timestamp with time zone'
      when 'uuid' then 'uuid'
      else 'text' end);
  end loop;
  if pg_catalog.cardinality(declared_sort_ids) = 0
    and not board_member_mode and not group_member_mode then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'sort_invalid');
  end if;

  -- The tie-break direction is a property of the declared order, independent
  -- of whether its asynchronous physical index has finished building.
  if pg_catalog.cardinality(sort_ids) > 1 then
    record_id_direction := sort_directions[pg_catalog.cardinality(sort_ids)];
  end if;

  if pg_catalog.cardinality(sort_ids) > 1
    and pg_catalog.cardinality(sort_ids) = pg_catalog.cardinality(declared_sort_ids)
    and not (false = any (sort_stored)) then
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'fieldId', sort_ids[item.position],
      'direction', sort_directions[item.position]) order by item.position)
    into composite_sort
    from pg_catalog.generate_series(1, pg_catalog.cardinality(sort_ids)) as item(position);
    select coalesce(index_value.indisvalid, false) into composite_index_ready
    from pg_catalog.pg_index as index_value
    where index_value.indexrelid = pg_catalog.to_regclass(pg_catalog.format(
      'record_data.%I', 'is_' || pg_catalog.md5(
        v_storage_contract_id::text || ':' || composite_sort::text)));
    composite_index_ready := coalesce(composite_index_ready, false);
  end if;

  prepared_plan := vortex_record.prepare_module_query_internal(
    p_module_root_id, p_query_id, p_expected_release_revision, p_input_values,
    p_user_inputs -> 'filter', coalesce(p_user_inputs -> 'filterableFieldIds', '[]'::jsonb),
    'complete', prepared_plan
  );
  if prepared_plan ->> 'outcome' is distinct from 'prepared' then
    return prepared_plan;
  end if;
  if preview_mode and (
    prepared_plan -> 'storage' is distinct from storage_plan -> 'storage'
    or prepared_plan -> 'fieldMappings' is distinct from storage_plan -> 'fieldMappings'
    or prepared_plan -> 'readableFieldIds' is distinct from storage_plan -> 'readableFieldIds'
    or prepared_plan -> 'access' is distinct from storage_plan -> 'access'
  ) then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'query_unavailable');
  end if;
  filter_condition := prepared_plan #> '{filter,residualCondition}';
  if filter_condition = 'null'::jsonb then
    filter_condition := null;
  end if;
  filter_types := coalesce(prepared_plan #> '{filter,residualFieldTypes}', '{}'::jsonb);
  filter_nulls := coalesce(prepared_plan #> '{filter,residualNullValues}', '{}'::jsonb);
  parameter_types := coalesce(prepared_plan #> '{filter,residualInputTypes}', '{}'::jsonb);
  parameter_values := coalesce(prepared_plan #> '{filter,residualInputs}', '{}'::jsonb);
  filter_predicate := coalesce(prepared_plan #>> '{filter,pushedPredicate}', 'true');
  filter_exact := (prepared_plan #>> '{filter,pushedExact}')::boolean is true;
  filter_parameters := coalesce(prepared_plan #> '{filter,pushedParameters}', '[]'::jsonb);
  select coalesce(pg_catalog.array_agg(item.value), array[]::text[])
  into filter_ids
  from pg_catalog.jsonb_array_elements_text(prepared_plan -> 'filterFieldIds') as item(value);
  select coalesce(pg_catalog.array_agg(item.value), array[]::text[])
  into filter_expressions
  from pg_catalog.jsonb_array_elements_text(prepared_plan #> '{filter,expressions}') as item(value);

  -- The keyset position must fit this exact order. The cursor binds every
  -- declared sort field, direction and whether it was pushed, but carries
  -- values only for readable sort fields. A changed readable subset cannot
  -- reinterpret an old key or put a hidden field value in a cursor.
  if p_after is not null and p_after <> 'null'::jsonb then
    if pg_catalog.jsonb_typeof(p_after) <> 'object'
      or p_after - array['sortKey', 'phase', 'recordId', 'sort']::text[] <> '{}'::jsonb
      or p_after -> 'sort' is distinct from cursor_sort
      or pg_catalog.jsonb_typeof(p_after -> 'sortKey') is distinct from 'array'
      or pg_catalog.jsonb_array_length(p_after -> 'sortKey') <> pg_catalog.cardinality(sort_ids)
      or pg_catalog.jsonb_typeof(p_after -> 'recordId') is distinct from 'string'
      or p_after ->> 'phase' not in ('null', 'value')
      or pg_catalog.lower(p_after ->> 'recordId') !~ uuid_pattern
      or exists (
        select 1 from pg_catalog.jsonb_array_elements(p_after -> 'sortKey') as item(value)
        where pg_catalog.jsonb_typeof(item.value) not in ('string', 'null')
      ) then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'cursor_invalid');
    end if;
    select pg_catalog.array_agg(item.value #>> '{}' order by item.ordinality)
    into after_sort_key
    from pg_catalog.jsonb_array_elements(p_after -> 'sortKey') with ordinality as item(value, ordinality);
    after_record_id := (p_after ->> 'recordId')::uuid;
    after_phase := p_after ->> 'phase';
    if after_phase is distinct from (case
      when pg_catalog.cardinality(sort_ids) > 0 and after_sort_key[1] is null then 'null'
      else 'value' end) then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'cursor_invalid');
    end if;
    for sort_index in 1 .. pg_catalog.cardinality(sort_ids) loop
      if after_sort_key[sort_index] is not null
        and not pg_catalog.pg_input_is_valid(after_sort_key[sort_index], sort_sql_types[sort_index]) then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'cursor_invalid');
      end if;
    end loop;
  end if;

  for sort_index in 1 .. pg_catalog.cardinality(sort_directions) loop
    scan_directions := pg_catalog.array_append(scan_directions,
      case when p_direction = 'forward' then sort_directions[sort_index]
        when sort_directions[sort_index] = 'ascending' then 'descending'
        else 'ascending' end);
  end loop;
  scan_record_id_direction := case when p_direction = 'forward' then record_id_direction
    when record_id_direction = 'ascending' then 'descending' else 'ascending' end;

  scan_source_sql := pg_catalog.format('record_data.%I as stored', physical_table_token);
  projection_page_scan := not preview_mode and record_type_item ? 'systemProjection'
    and pg_catalog.cardinality(sort_ids) = 1
    and pg_catalog.cardinality(declared_sort_ids) = 1
    and exists (
      select 1
      from pg_catalog.jsonb_array_elements_text(
        record_type_item #> '{systemProjection,sortableFieldIds}'
      ) as sortable(id)
      where pg_catalog.lower(sortable.id) = sort_ids[1]
    ) and (
      (record_type_item #>> '{systemProjection,protectedView}' = 'organization_accounts'
        and fields_by_id -> sort_ids[1] ->> 'key' in ('display_name', 'state'))
      or (record_type_item #>> '{systemProjection,protectedView}' = 'activity_entry'
        and fields_by_id -> sort_ids[1] ->> 'key' = 'occurred_at')
    );
  if projection_page_scan then
      projection_sort_key := fields_by_id -> sort_ids[1] ->> 'key';
      if projection_sort_key is null then
        raise exception using errcode = '55000',
          message = 'Protected projection sort field is unavailable';
      end if;
      select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(projected) order by projected.ordinality), '[]'::jsonb)
      into projection_batch
      from vortex_record.read_system_projection_rows_internal(
        v_storage_contract_id, null::uuid[], projection_sort_key,
        scan_directions[1], p_after, scan_limit + 1
      ) with ordinality as projected(organization_id, record_id, revision, attribute_values, ordinality);
      projection_batch_exhausted := pg_catalog.jsonb_array_length(projection_batch) > scan_limit;
      if projection_batch_exhausted then
        projection_last_record_id := (projection_batch -> (scan_limit - 1) ->> 'record_id')::uuid;
        projection_last_sort_key := array[
          projection_batch -> (scan_limit - 1) -> 'attribute_values' ->> projection_sort_key
        ];
      end if;
      -- The registered view contributes its row type only. The bounded reader
      -- supplies every candidate, including rows later rejected by the query.
      scan_source_sql := pg_catalog.format($source$
        pg_catalog.jsonb_to_recordset($11) as projection(
          organization_id uuid, record_id uuid, revision bigint, attribute_values jsonb
        )
        cross join lateral pg_catalog.jsonb_populate_record(
          null::record_data.%I,
          pg_catalog.jsonb_build_object(
            'organisation_id', projection.organization_id,
            'module_root_id', %L::uuid,
            'record_type_id', %L::uuid,
            'storage_contract_id', %L::uuid,
            'record_id', projection.record_id,
            'definition_revision', %L::bigint,
            'lifecycle_state', 'active',
            'concurrency_number', projection.revision
          ) || coalesce((
            select pg_catalog.jsonb_object_agg(
              'f_' || pg_catalog.replace(pg_catalog.lower(field.value ->> 'fieldId'), '-', ''),
              case
                when field.value ->> 'fieldId' = %L
                  then pg_catalog.to_jsonb(projection.organization_id::text)
                when field.value ->> 'fieldId' = %L
                  then pg_catalog.to_jsonb(projection.revision)
                else projection.attribute_values -> (field.value ->> 'key')
              end
            )
            from pg_catalog.jsonb_array_elements(%L::jsonb -> 'fields') as field(value)
          ), '{}'::jsonb)
        ) as stored$source$,
        physical_table_token, p_module_root_id, record_type_id_value,
        v_storage_contract_id, (resolved ->> 'moduleReleaseRevision')::bigint,
        record_type_item #>> '{systemProjection,organizationFieldId}',
        record_type_item #>> '{systemProjection,revisionFieldId}',
        record_type_item
      );
      scan_projection_sql := 'pg_catalog.to_jsonb(projection)';
  end if;

  -- The scan. Identifiers come only from the storage catalogue; every value is
  -- a bound parameter. Nulls order first ascending and last descending. The
  -- order always ends with the record id, so the keyset stays total even when
  -- no readable sort field may be pushed.
  for sort_index in 1 .. pg_catalog.cardinality(sort_ids) loop
    column_sql := case when sort_sql_types[sort_index] = 'text'
      then sort_value_sql[sort_index] || ' collate "C"'
      else sort_value_sql[sort_index] end;
    order_terms := pg_catalog.array_append(order_terms, column_sql || case
      when scan_directions[sort_index] = 'ascending' then ' asc nulls first'
      else ' desc nulls last' end);
    sort_key_terms := pg_catalog.array_append(sort_key_terms, case sort_sql_types[sort_index]
      when 'timestamp with time zone' then pg_catalog.format(
        'vortex_platform.format_timestamp_utc(%s)',
        sort_value_sql[sort_index])
      when 'date' then pg_catalog.format(
        'pg_catalog.to_char(%s, ''YYYY-MM-DD'')', sort_value_sql[sort_index])
      else pg_catalog.format('(%s)::text', sort_value_sql[sort_index]) end);

    if after_record_id is not null then
      value_sql := case when sort_sql_types[sort_index] = 'text'
        then pg_catalog.format('$3[%s] collate "C"', sort_index)
        else pg_catalog.format('($3[%s])::%s', sort_index, sort_sql_types[sort_index]) end;
      if after_sort_key[sort_index] is null then
        after_terms := pg_catalog.array_append(after_terms, equal_prefix || case
          when scan_directions[sort_index] = 'ascending'
            then pg_catalog.format('(%s) is not null', sort_value_sql[sort_index])
          else 'false' end);
        equal_prefix := equal_prefix
          || pg_catalog.format('(%s) is null and ', sort_value_sql[sort_index]);
      else
        after_terms := pg_catalog.array_append(after_terms, equal_prefix || case
          when scan_directions[sort_index] = 'ascending'
            then pg_catalog.format('coalesce(%s > %s, false)', column_sql, value_sql)
          else pg_catalog.format('((%s) is null or coalesce(%s < %s, false))',
            sort_value_sql[sort_index], column_sql, value_sql) end);
        equal_prefix := equal_prefix
          || pg_catalog.format('coalesce(%s = %s, false) and ', column_sql, value_sql);
      end if;
    end if;
  end loop;
  if after_record_id is not null then
    after_terms := pg_catalog.array_append(after_terms, equal_prefix ||
      'stored.record_id ' || case when scan_record_id_direction = 'ascending' then '>' else '<' end || ' $4');
    keyset_sql := ' and ((' || pg_catalog.array_to_string(after_terms, ') or (') || '))';
  end if;
  order_by_sql := pg_catalog.array_to_string(order_terms, ', ');
  if order_by_sql = '' then
    order_by_sql := 'stored.record_id ' ||
      case when scan_record_id_direction = 'ascending' then 'asc' else 'desc' end;
  else
    order_by_sql := order_by_sql || ', stored.record_id ' ||
      case when scan_record_id_direction = 'ascending' then 'asc' else 'desc' end;
  end if;

  if composite_index_ready then
    segment_predicates := array[]::text[];
    if after_record_id is null then
      segment_predicates := array[''];
    else
      -- A mixed-direction lexicographic comparison is one seek per first
      -- differing key. Each scan has an equality prefix and one B-tree range,
      -- including the NULL region in its own segment.
      segment_prefix := '';
      for prefix_index in 1 .. pg_catalog.cardinality(sort_ids) loop
        column_sql := case when sort_sql_types[prefix_index] = 'text'
          then sort_value_sql[prefix_index] || ' collate "C"'
          else sort_value_sql[prefix_index] end;
        if after_sort_key[prefix_index] is null then
          segment_prefix := segment_prefix || pg_catalog.format(
            ' and %s is null', sort_value_sql[prefix_index]);
        else
          value_sql := case when sort_sql_types[prefix_index] = 'text'
            then pg_catalog.format('$3[%s] collate "C"', prefix_index)
            else pg_catalog.format('($3[%s])::%s', prefix_index, sort_sql_types[prefix_index]) end;
          segment_prefix := segment_prefix || pg_catalog.format(
            ' and %s = %s', column_sql, value_sql);
        end if;
      end loop;
      segment_predicates := pg_catalog.array_append(segment_predicates,
        segment_prefix || ' and stored.record_id ' ||
        case when scan_record_id_direction = 'ascending' then '>' else '<' end || ' $4');
      for sort_index in reverse pg_catalog.cardinality(sort_ids) .. 1 loop
        segment_prefix := '';
        for prefix_index in 1 .. sort_index - 1 loop
          column_sql := case when sort_sql_types[prefix_index] = 'text'
            then sort_value_sql[prefix_index] || ' collate "C"'
            else sort_value_sql[prefix_index] end;
          if after_sort_key[prefix_index] is null then
            segment_prefix := segment_prefix || pg_catalog.format(
              ' and %s is null', sort_value_sql[prefix_index]);
          else
            value_sql := case when sort_sql_types[prefix_index] = 'text'
              then pg_catalog.format('$3[%s] collate "C"', prefix_index)
              else pg_catalog.format('($3[%s])::%s', prefix_index, sort_sql_types[prefix_index]) end;
            segment_prefix := segment_prefix || pg_catalog.format(
              ' and %s = %s', column_sql, value_sql);
          end if;
        end loop;
        column_sql := case when sort_sql_types[sort_index] = 'text'
          then sort_value_sql[sort_index] || ' collate "C"'
          else sort_value_sql[sort_index] end;
        if after_sort_key[sort_index] is null then
          if scan_directions[sort_index] = 'ascending' then
            segment_predicates := pg_catalog.array_append(segment_predicates,
              segment_prefix || pg_catalog.format(' and %s is not null', sort_value_sql[sort_index]));
          end if;
        else
          value_sql := case when sort_sql_types[sort_index] = 'text'
            then pg_catalog.format('$3[%s] collate "C"', sort_index)
            else pg_catalog.format('($3[%s])::%s', sort_index, sort_sql_types[sort_index]) end;
          segment_predicates := pg_catalog.array_append(segment_predicates,
            segment_prefix || pg_catalog.format(' and %s %s %s', column_sql,
              case when scan_directions[sort_index] = 'ascending' then '>' else '<' end,
              value_sql));
          if scan_directions[sort_index] = 'descending' then
            segment_predicates := pg_catalog.array_append(segment_predicates,
              segment_prefix || pg_catalog.format(' and %s is null', sort_value_sql[sort_index]));
          end if;
        end if;
      end loop;
    end if;
  elsif pg_catalog.cardinality(sort_ids) = 1 and sort_index_backed[1] then
    -- Each segment has one contiguous range in the aligned index. A NULL
    -- cursor finishes its record-id range before the value range begins.
    if scan_directions[1] = 'ascending' then
      if after_record_id is null or after_phase = 'null' then
        segment_predicates := array[
          pg_catalog.format(' and %s is null%s', sort_value_sql[1],
            case when after_record_id is null then '' else ' and stored.record_id > $4' end),
          pg_catalog.format(' and %s is not null', sort_value_sql[1])
        ];
      else
        segment_predicates := array[pg_catalog.format(
          ' and %s is not null and (%s, stored.record_id) > (%s, $4)',
          sort_value_sql[1], column_sql, value_sql
        )];
      end if;
    elsif after_record_id is null then
      segment_predicates := array[
        pg_catalog.format(' and %s is not null', sort_value_sql[1]),
        pg_catalog.format(' and %s is null', sort_value_sql[1])
      ];
    elsif after_phase = 'value' then
      segment_predicates := array[
        pg_catalog.format(' and %s is not null and (%s, stored.record_id) < (%s, $4)',
          sort_value_sql[1], column_sql, value_sql),
        pg_catalog.format(' and %s is null', sort_value_sql[1])
      ];
    else
      segment_predicates := array[pg_catalog.format(
        ' and %s is null and stored.record_id < $4', sort_value_sql[1])];
    end if;
  else
    segment_predicates := array[keyset_sql];
  end if;

  if projection_page_scan then
    -- The bounded reader has already applied the sealed keyset and order.
    segment_predicates := array[''];
  end if;

  foreach segment_sql in array segment_predicates loop
  scan_sql := pg_catalog.format(
    'select stored.record_id,
       array[%s]::text[] as sort_key,
       pg_catalog.jsonb_build_object(%s) as filter_values,
       pg_catalog.jsonb_build_object(%s) as system_values,
       %s as projection_row
     from %s
     where stored.organisation_id = $1
       and stored.lifecycle_state = ''active''
       and %s
       and (%s)
        and (case when (%s) then true else false end)%s
     order by %s
     limit $5',
    pg_catalog.array_to_string(sort_key_terms, ', '),
    (select pg_catalog.string_agg(
       filter_chunk.pairs_text,
       ') || pg_catalog.jsonb_build_object(' order by filter_chunk.chunk_index
     )
     from (
       select (filter_pair.pair_number - 1) / 50 as chunk_index,
         pg_catalog.string_agg(
           filter_pair.pair_text, ', ' order by filter_pair.pair_number
         ) as pairs_text
       from pg_catalog.unnest(filter_expressions)
         with ordinality as filter_pair(pair_text, pair_number)
       group by (filter_pair.pair_number - 1) / 50
     ) as filter_chunk),
    system_columns_sql,
    scan_projection_sql,
    scan_source_sql,
    case when storage_scope = 'application_contained'
      then 'stored.application_root_id = $2' else 'stored.application_root_id is null' end,
    access_sql,
    filter_predicate,
    segment_sql,
    order_by_sql
  );

  -- A validated type set stays local to this invocation and is passed only to
  -- the fixed record adapter's private evaluator.
  open scan_cursor scroll for execute scan_sql
    using context_organization_id, context_application_root_id, after_sort_key,
      after_record_id, scan_limit + 1, access_owner_account_id,
      access_owner_group_ids, access_shared_record_ids,
      filter_parameters, access_parameters, projection_batch;
  cursor_position := 0;
  loop
    fetch scan_cursor into scan_record;
    exit when not found;
    cursor_position := cursor_position + 1;
    examined := examined + 1;
    if examined > scan_limit then
      budget_exhausted := true;
      exit;
    end if;

    -- The filter is evaluated on stored values first only to avoid reading
    -- rows it rejects; a row it admits is still read through the protected
    -- projection, and every filtered and sorted field must be readable there.
    -- A value the condition engine refuses decides nothing until the row is
    -- known to be readable, so an unreadable row can never cause a refusal.
    needs_refusal_check := false;
    -- Preparation has already validated the inputs. An exact SQL predicate
    -- has decided this condition over fields every candidate reader can see.
    if filter_condition is null or filter_exact then
      passes := true;
    else
      begin
        passes := vortex_access.evaluate_query_condition_internal(
          filter_condition, filter_types, scan_record.filter_values,
          parameter_types, parameter_values, false
        );
      exception when invalid_parameter_value then
        passes := true;
        needs_refusal_check := true;
      end;
    end if;

    if passes then
      page_access_loaded := null;
      if not preview_mode and not page_eligibility_checked then
        -- Keep the reusable decision in this invocation; the request role cannot
        -- write it or pass it to the owner-only exact-record evaluator.
        page_eligibility_checked := true;
        page_access_loaded := vortex_record.load_record_access_facts_internal(
          record_type_id_value, 'read', scan_record.record_id, null,
          scan_record.projection_row
        );
        if page_access_loaded ->> 'outcome' = 'loaded'
          and pg_catalog.jsonb_typeof(page_access_loaded -> 'declaration') = 'object' then
          page_declaration := page_access_loaded -> 'declaration';
          page_eligibility := vortex_access.evaluate_organization_record_permission_eligibility_internal(
            page_declaration, vortex_access.validated_human_request_context(),
            pg_catalog.clock_timestamp()
          );
          page_first_loaded := page_access_loaded;
        end if;
      end if;
      -- Decide this candidate and the page's next ones together in one set
      -- pass; the cursor returns to this row, so the scan order, budget and
      -- every later check stay those of the row-by-row walk.
      if page_batching and page_first_loaded is not null
        and not (scan_record.record_id = any (decided_ids)) then
        lookahead_ids := array[scan_record.record_id];
        while pg_catalog.cardinality(lookahead_ids) <= p_page_size loop
          fetch scan_cursor into lookahead_record;
          exit when not found;
          lookahead_ids := pg_catalog.array_append(lookahead_ids, lookahead_record.record_id);
        end loop;
        move absolute cursor_position from scan_cursor;
        select coalesce(pg_catalog.array_agg(decided.record_id), array[]::uuid[]),
          pg_catalog.array_agg(decided.loaded), pg_catalog.array_agg(decided.decision),
          pg_catalog.array_agg(decided.bounds)
        into decided_ids, decided_loaded, decided_decisions, decided_bounds
        from vortex_record.read_record_page_decisions_internal(
          record_type_id_value, page_first_loaded, page_declaration, page_eligibility,
          lookahead_ids
        ) as decided;
        page_batching := pg_catalog.cardinality(decided_ids) > 0;
      end if;
      -- The page's first record keeps the exact decision, which also validates
      -- the installation-wide facts every decided record shares.
      decided_index := case when page_access_loaded is null
        then pg_catalog.array_position(decided_ids, scan_record.record_id) end;
      select row_read.* into read_row
      from vortex_record.read_record_projection_with_validated_types_internal(
        record_type_id_value, scan_record.record_id, page_declaration, page_eligibility,
        validated_record_types, scan_record.projection_row,
        coalesce(decided_loaded[decided_index], page_access_loaded),
        decided_decisions[decided_index], decided_bounds[decided_index]
      ) as row_read;
      projection := read_row.projection;
      -- Only the exact evaluator validates record types for reuse.
      if validated_record_types is null and decided_index is null then
        validated_record_types := coalesce(
          read_row.read_facts -> 'validatedRecordTypes',
          case when projection ->> 'outcome' = 'allowed'
            then read_row.read_facts #> '{facts,recordTypes}' end
        );
      end if;
      if projection ->> 'outcome' = 'allowed' then
        readable_values := projection -> 'values';
        if not exists (
          select 1 from pg_catalog.unnest(declared_sort_ids || filter_ids) as referenced(id)
          where not (readable_values ? referenced.id)
        ) then
          if needs_refusal_check then
            return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'filter_invalid');
          end if;
          -- A search term matches only through a searchable field this row exposes
          -- to the reader; a field the reader cannot see never decides a match, so
          -- a hidden value can neither satisfy a search nor be inferred from one.
          -- Only a text or number value, or the text members of a list value, is
          -- searched; a structured value's JSON keys and identifiers never match.
          if board_member_mode then
            if board_column_kind = 'option' then
              board_member_matches := (readable_values ? board_choice_field_id)
                and pg_catalog.jsonb_typeof(readable_values -> board_choice_field_id) = 'string'
                and (readable_values ->> board_choice_field_id) collate "C"
                  = board_column_value collate "C";
            else
              board_member_matches := not (
                (readable_values ? board_choice_field_id)
                and pg_catalog.jsonb_typeof(readable_values -> board_choice_field_id) = 'string'
                and (readable_values ->> board_choice_field_id) collate "C"
                  = any (board_option_values)
              );
            end if;
            if not board_member_matches then
              last_examined_sort_key := scan_record.sort_key;
              last_examined_record_id := scan_record.record_id;
              continue;
            end if;
          end if;
          if group_member_mode then
            group_member_matches := not exists (
              select 1 from pg_catalog.unnest(group_by_ids) as grouped(id)
              where not (readable_values ? grouped.id)
            );
            if group_member_matches then
              select pg_catalog.jsonb_object_agg(grouped.id, readable_values -> grouped.id)
              into group_candidate_values
              from pg_catalog.unnest(group_by_ids) as grouped(id);
              group_member_matches := group_candidate_values = group_selector_values;
            end if;
            if not group_member_matches then
              last_examined_sort_key := scan_record.sort_key;
              last_examined_record_id := scan_record.record_id;
              continue;
            end if;
          end if;
          if user_search is not null then
            search_matches := false;
            foreach field_key in array search_field_ids loop
              if readable_values ? field_key and (
                (pg_catalog.jsonb_typeof(readable_values -> field_key) in ('string', 'number')
                  and pg_catalog.strpos(
                    pg_catalog.lower(readable_values ->> field_key), user_search_folded
                  ) > 0)
                or (pg_catalog.jsonb_typeof(readable_values -> field_key) = 'array'
                  and exists (
                    select 1
                    from pg_catalog.jsonb_array_elements(readable_values -> field_key) as member(value)
                    where pg_catalog.jsonb_typeof(member.value) = 'string'
                      and pg_catalog.strpos(
                        pg_catalog.lower(member.value #>> '{}'), user_search_folded
                      ) > 0
                  ))
              ) then
                search_matches := true;
                exit;
              end if;
            end loop;
            if not search_matches then
              last_examined_sort_key := scan_record.sort_key;
              last_examined_record_id := scan_record.record_id;
              continue;
            end if;
          end if;
          if row_count = p_page_size then
            more_rows := true;
            exit;
          end if;
          if row_count = 0 then
            first_returned_sort_key := scan_record.sort_key;
            first_returned_record_id := scan_record.record_id;
          end if;
          -- Keep the read facts and field bounds for one page-level capability
          -- decision after the readable page has been selected.
          capability_rows := pg_catalog.array_append(
            capability_rows,
            pg_catalog.jsonb_build_object(
              'recordId', scan_record.record_id,
              -- The page pass's facts for this record when it has them, also
              -- for the first record: the same facts every other row carries.
              'readFacts', coalesce(decided_loaded[pg_catalog.array_position(
                decided_ids, scan_record.record_id)], read_row.read_facts),
              'readBounds', read_row.read_bounds
            )
          );
          rows_value := rows_value || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
            'recordId', scan_record.record_id,
            'revision', projection -> 'concurrencyNumber',
            'values', coalesce((
              select pg_catalog.jsonb_object_agg(requested.id, readable_values -> requested.id)
              from pg_catalog.unnest(requested_ids) as requested(id)
              where readable_values ? requested.id
            ), '{}'::jsonb)
          ));
          row_count := row_count + 1;
          if pg_catalog.cardinality(system_field_keys) > 0 then
            rows_value := pg_catalog.jsonb_set(
              rows_value, array[(row_count - 1)::text, 'systemValues'], scan_record.system_values
            );
          end if;
          last_returned_sort_key := scan_record.sort_key;
          last_returned_record_id := scan_record.record_id;
        end if;
      end if;
    end if;

    last_examined_sort_key := scan_record.sort_key;
    last_examined_record_id := scan_record.record_id;
  end loop;
  close scan_cursor;
  exit when more_rows or budget_exhausted;
  end loop;
  if projection_batch_exhausted and not more_rows then
    budget_exhausted := true;
    last_examined_sort_key := projection_last_sort_key;
    last_examined_record_id := projection_last_record_id;
  end if;
  if row_count > 0 then
    page_capabilities := vortex_record.read_record_capabilities_page_internal(
      record_type_id_value, pg_catalog.to_jsonb(capability_rows)
    );
    if pg_catalog.jsonb_typeof(page_capabilities) is distinct from 'array'
      or pg_catalog.jsonb_array_length(page_capabilities) <> row_count then
      raise exception using errcode = '55000', message = 'Page capabilities are unavailable';
    end if;
    for capability_index in 0..row_count - 1 loop
      row_capabilities := page_capabilities -> capability_index;
      if pg_catalog.jsonb_typeof(row_capabilities) is distinct from 'object' then
        raise exception using errcode = '55000', message = 'Record capabilities are unavailable';
      end if;
      rows_value := pg_catalog.jsonb_set(
        rows_value, array[capability_index::text, 'capabilities'], row_capabilities
      );
    end loop;
  end if;

  if more_rows then
    next_value := pg_catalog.jsonb_build_object(
      'sort', cursor_sort,
      'sortKey', pg_catalog.to_jsonb(last_returned_sort_key),
      'phase', case when pg_catalog.cardinality(last_returned_sort_key) > 0
        and last_returned_sort_key[1] is null then 'null' else 'value' end,
      'recordId', last_returned_record_id
    );
  elsif budget_exhausted then
    next_value := pg_catalog.jsonb_build_object(
      'sort', cursor_sort,
      'sortKey', pg_catalog.to_jsonb(last_examined_sort_key),
      'phase', case when pg_catalog.cardinality(last_examined_sort_key) > 0
        and last_examined_sort_key[1] is null then 'null' else 'value' end,
      'recordId', last_examined_record_id
    );
  end if;

  if first_returned_record_id is not null then
    opposite_value := pg_catalog.jsonb_build_object(
      'sort', cursor_sort,
      'sortKey', pg_catalog.to_jsonb(first_returned_sort_key),
      'phase', case when pg_catalog.cardinality(first_returned_sort_key) > 0
        and first_returned_sort_key[1] is null then 'null' else 'value' end,
      'recordId', first_returned_record_id
    );
  end if;
  if p_direction = 'backward' and row_count > 1 then
    select pg_catalog.jsonb_agg(item.value order by item.ordinality desc)
    into rows_value
    from pg_catalog.jsonb_array_elements(rows_value) with ordinality as item(value, ordinality);
  end if;

  if group_member_mode then
    return pg_catalog.jsonb_build_object(
      'outcome', 'completed',
      'moduleReleaseRevision', resolved -> 'moduleReleaseRevision',
      'moduleReleaseVersion', resolved -> 'moduleReleaseVersion',
      'groupByFieldIds', pg_catalog.to_jsonb(group_by_ids),
      'groupValues', group_selector_values,
      'rows', rows_value,
      'next', next_value
    );
  end if;

  return pg_catalog.jsonb_build_object(
    'outcome', 'completed',
    'moduleReleaseRevision', resolved -> 'moduleReleaseRevision',
    'moduleReleaseVersion', resolved -> 'moduleReleaseVersion',
    'rows', rows_value,
    'next', next_value,
    'opposite', opposite_value
  );
end
$function$;

create or replace function vortex_record.run_module_query(
  p_module_root_id uuid,
  p_query_id uuid,
  p_expected_release_revision bigint,
  p_input_values jsonb,
  p_requested_field_ids jsonb,
  p_page_size integer,
  p_after jsonb,
  p_requested_system_field_keys jsonb,
  p_user_inputs jsonb
)
returns jsonb
language sql
volatile
security definer
set search_path = ''
as $function$
  select vortex_record.run_module_query(
    p_module_root_id, p_query_id, p_expected_release_revision, p_input_values,
    p_requested_field_ids, p_page_size, p_after, p_requested_system_field_keys,
    p_user_inputs - 'pageDirection', coalesce(p_user_inputs ->> 'pageDirection', 'forward')
  );
$function$;

alter function vortex_record.run_module_query(uuid,uuid,bigint,jsonb,jsonb,integer,jsonb,jsonb,jsonb,text) owner to vortex_record_adapter;
alter function vortex_record.run_module_query(uuid,uuid,bigint,jsonb,jsonb,integer,jsonb,jsonb,jsonb) owner to vortex_record_adapter;

revoke all on function vortex_record.run_module_query(uuid, uuid, bigint, jsonb, jsonb, integer, jsonb, jsonb, jsonb, text)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
revoke all on function vortex_record.run_module_query(uuid, uuid, bigint, jsonb, jsonb, integer, jsonb, jsonb, jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_record.run_module_query(uuid, uuid, bigint, jsonb, jsonb, integer, jsonb, jsonb, jsonb)
  to vortex_request;

comment on function vortex_record.run_module_query(uuid, uuid, bigint, jsonb, jsonb, integer, jsonb, jsonb, jsonb) is
  'One bounded keyset page of rows readable through read_record for one installed Module query, or one exact current human-owned preview query over isolated preview storage, each carrying the record''s concurrency number and the per-row capabilities from read_record_capabilities, each action decided exactly as its own writer decides it, with only the declared Record system values, or one refusal before any row is exposed; accepts a bound list component''s declared sortable, filterable and searchable field sets together with the viewer''s chosen sort, typed filter and search term, refuses a sort or filter outside the declared sets, keeps a user sort only over a field the record type declares sortable and the reader is guaranteed to see, ANDs the user filter with the published filter so it can only narrow, and matches a search only through searchable fields the returned row exposes to the reader; requires every filtered field to be declared filterable; pushes a filter or a sort into the candidate scan only for fields the reader is guaranteed to see for the whole record type, evaluates a filter on a possibly-withheld field per row, and keeps the keyset cursor over readable sort values and a record identity so no cursor carries a hidden field value and the scan order and budget never depend on one; narrows an installed scan with one predicate that OR-s every eligible alternative''s exact owner, owner-group and direct-share route test with its saved condition compiled over the record''s own catalogue columns where that condition can be expressed as a superset of the per-row decision, leaves the installed scan unrestricted where a route or condition has no exact stored form, and still decides every returned row through read_record; validates every preview stage against the current human, candidate revision and exact release and storage pins, uses only active preview catalogue mappings and preview field bounds, and never falls through to installed resolution; works out read-time fields, such as a deadline-passed calculation, inside an installed query at one statement timestamp in the organisation time zone, so no installed query is refused for freshness; admits board members only through a separately validated board selector over the sole filterable choice grouping key, classifies those columns from current readable values, and admits generic grouped members only when every installed grouping value is present in the current readable projection and JSONB-equal to the closed typed selector; missing or withheld values belong to no generic group while JSON null is a value, and generic group membership never uses hidden stored values or affects scan order or budget; orders board and generic group pages by record identity, returns generic group identity even for empty pages, and binds each member operation, selector and projection in its own uncached continuation; refuses preview member, grouped, aggregate and system projection modes.';

reset role;
