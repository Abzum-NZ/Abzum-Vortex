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
  page_record_ids uuid[];
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
    -- The page's record identities, once; then a superset of the records any
    -- current share of this binding can reach, through the active share scope
    -- index. The exact share reader still decides each of them.
    select coalesce(pg_catalog.array_agg((item.value #>> '{recordScope,recordId}')::uuid), array[]::uuid[])
    into page_record_ids
    from pg_catalog.jsonb_array_elements(p_records) as item(value)
    where pg_catalog.jsonb_typeof(item.value) = 'object'
      and vortex_platform.is_non_nil_uuid(item.value #>> '{recordScope,recordId}');
    select coalesce(pg_catalog.array_agg(distinct share.record_id), array[]::uuid[])
    into share_candidates
    from vortex_access.organization_direct_record_shares as share
    where share.organization_id = v_organization_id
      and share.storage_scope = binding ->> 'storageScope'
      and share.application_scope_id = coalesce(case
        when binding ->> 'storageScope' = 'application_contained' then v_application_root_id
        else null::uuid end, '00000000-0000-0000-0000-000000000000'::uuid)
      and share.module_root_id = (binding ->> 'moduleRootId')::uuid
      and share.record_type_id = (binding ->> 'recordTypeId')::uuid
      and share.storage_contract_id = (binding ->> 'storageContractId')::uuid
      and share.record_id = any (page_record_ids)
      and share.state = 'active';
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
  -- Each shared record's current shares, read once by the exact share reader
  -- whatever the number of alternatives.
  shares as materialized (
    select assessed.row_index, share.*
    from assessed
    cross join lateral vortex_access.read_current_direct_record_share_contributions(
      v_organization_id, v_application_root_id,
      (target_type ->> 'moduleRootId')::uuid, (target_type ->> 'recordTypeId')::uuid,
      (target_type ->> 'storageContractId')::uuid, target_type ->> 'storageScope',
      assessed.record_id, v_organization_id, v_application_root_id, v_account_id, p_checked_at
    ) as share
    where wants_share and assessed.record_id = any (share_candidates)
      and assessed.target_ok and assessed.evidence_ok
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
    from shares as share
    join assessed on assessed.row_index = share.row_index
    cross join alternatives
    where alternatives.has_share
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
