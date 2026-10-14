set local role vortex_owner;

alter table vortex_access.organization_direct_record_shares
  add column application_scope_id uuid generated always as
    (coalesce(application_root_id, '00000000-0000-0000-0000-000000000000'::uuid)) stored not null;

create index organization_direct_record_shares_active_scope_idx
  on vortex_access.organization_direct_record_shares
    (organization_id, storage_scope, application_scope_id, module_root_id,
     record_type_id, storage_contract_id, record_id)
  where state = 'active';
CREATE OR REPLACE FUNCTION vortex_access.read_current_direct_record_share_contributions(p_binding_organization_id uuid, p_binding_application_root_id uuid, p_binding_module_root_id uuid, p_binding_record_type_id uuid, p_binding_storage_contract_id uuid, p_binding_storage_scope text, p_record_id uuid, p_current_organization_id uuid, p_current_application_root_id uuid, p_current_organization_account_id uuid, p_checked_at timestamp with time zone) RETURNS TABLE(direct_share_id uuid, direct_share_revision bigint, recipient_kind text, organization_account_id uuid, group_id uuid, readable_field_ids uuid[], changeable_field_ids uuid[], valid_until timestamp with time zone)
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
begin
  if not vortex_platform.is_non_nil_uuid(p_binding_organization_id::text)
    or not vortex_platform.is_non_nil_uuid(p_binding_application_root_id::text)
    or not vortex_platform.is_non_nil_uuid(p_binding_module_root_id::text)
    or not vortex_platform.is_non_nil_uuid(p_binding_record_type_id::text)
    or not vortex_platform.is_non_nil_uuid(p_binding_storage_contract_id::text)
    or not vortex_platform.is_non_nil_uuid(p_record_id::text)
    or not vortex_platform.is_non_nil_uuid(p_current_organization_id::text)
    or not vortex_platform.is_non_nil_uuid(p_current_application_root_id::text)
    or not vortex_platform.is_non_nil_uuid(p_current_organization_account_id::text)
    or p_binding_storage_scope is null
    or p_binding_storage_scope not in ('organization_shared', 'application_contained')
    or p_checked_at is null
    or p_checked_at in ('-infinity'::timestamptz, 'infinity'::timestamptz)
    or p_binding_organization_id <> p_current_organization_id
    or p_binding_application_root_id <> p_current_application_root_id then
    raise exception using errcode = '22023',
      message = 'Direct record-share contribution evidence is invalid';
  end if;

  return query
  select
    share.direct_share_id,
    share.revision,
    share.recipient_kind,
    share.organization_account_id,
    share.group_id,
    share.readable_field_ids,
    share.changeable_field_ids,
    case
      when share.recipient_kind = 'organization_account' then share.expires_at
      when share.expires_at is null then membership.expires_at
      when membership.expires_at is null then share.expires_at
      else least(share.expires_at, membership.expires_at)
    end
  from vortex_access.organization_direct_record_shares as share
  left join vortex_access.organization_groups as recipient_group
    on share.recipient_kind = 'group'
    and recipient_group.organization_id = share.organization_id
    and recipient_group.group_id = share.group_id
    and recipient_group.state = 'active'
  left join vortex_access.organization_group_memberships as membership
    on recipient_group.organization_id is not null
    and membership.organization_id = share.organization_id
    and membership.group_id = share.group_id
    and membership.organization_account_id = p_current_organization_account_id
    and membership.state = 'live'
    and membership.starts_at <= p_checked_at
    and (membership.expires_at is null or membership.expires_at > p_checked_at)
  where share.organization_id = p_binding_organization_id
    and share.storage_scope = p_binding_storage_scope
    and share.application_scope_id = coalesce(case
      when p_binding_storage_scope = 'application_contained'
        then p_binding_application_root_id
      else null::uuid
    end, '00000000-0000-0000-0000-000000000000'::uuid)
    and share.module_root_id = p_binding_module_root_id
    and share.record_type_id = p_binding_record_type_id
    and share.storage_contract_id = p_binding_storage_contract_id
    and share.record_id = p_record_id
    and share.state = 'active'
    and share.starts_at <= p_checked_at
    and (share.expires_at is null or share.expires_at > p_checked_at)
    and (
      (
        share.recipient_kind = 'organization_account'
        and share.organization_account_id = p_current_organization_account_id
      ) or (
        share.recipient_kind = 'group'
        and membership.membership_id is not null
      )
    )
  order by share.direct_share_id;
end
$$;

alter function vortex_access.read_current_direct_record_share_contributions(p_binding_organization_id uuid, p_binding_application_root_id uuid, p_binding_module_root_id uuid, p_binding_record_type_id uuid, p_binding_storage_contract_id uuid, p_binding_storage_scope text, p_record_id uuid, p_current_organization_id uuid, p_current_application_root_id uuid, p_current_organization_account_id uuid, p_checked_at timestamp with time zone) owner to vortex_owner;

COMMENT ON FUNCTION vortex_access.read_current_direct_record_share_contributions(p_binding_organization_id uuid, p_binding_application_root_id uuid, p_binding_module_root_id uuid, p_binding_record_type_id uuid, p_binding_storage_contract_id uuid, p_binding_storage_scope text, p_record_id uuid, p_current_organization_id uuid, p_current_application_root_id uuid, p_current_organization_account_id uuid, p_checked_at timestamp with time zone) IS 'Returns independent current account or Group direct-share field contributions for one exact trusted record binding; it does not union fields or grant permission.';

REVOKE ALL ON FUNCTION vortex_access.read_current_direct_record_share_contributions(p_binding_organization_id uuid, p_binding_application_root_id uuid, p_binding_module_root_id uuid, p_binding_record_type_id uuid, p_binding_storage_contract_id uuid, p_binding_storage_scope text, p_record_id uuid, p_current_organization_id uuid, p_current_application_root_id uuid, p_current_organization_account_id uuid, p_checked_at timestamp with time zone) FROM PUBLIC;

grant execute on function vortex_access.read_current_direct_record_share_contributions(p_binding_organization_id uuid, p_binding_application_root_id uuid, p_binding_module_root_id uuid, p_binding_record_type_id uuid, p_binding_storage_contract_id uuid, p_binding_storage_scope text, p_record_id uuid, p_current_organization_id uuid, p_current_application_root_id uuid, p_current_organization_account_id uuid, p_checked_at timestamp with time zone) to postgres;

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
  first_route boolean := true;
  covers_all_records boolean := false;
  condition_free boolean := true;
  wants_share boolean := false;
  member_group_ids uuid[];
  share_row record;
  share_intersection text[];
  share_seen boolean := false;
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

  -- A direct-share route narrows its permission to the individual share's own
  -- readable fields, which are current rows rather than a static declaration.
  -- When any eligible alternative can match through such a route, take the
  -- intersection of every current share's own bounds once, so a field that a
  -- share withholds is never treated as visible.
  select exists (
    select 1
    from pg_catalog.jsonb_array_elements(
      coalesce(eligibility -> 'eligiblePermissions', '[]'::jsonb)
    ) as listed(value)
    cross join lateral pg_catalog.jsonb_array_elements(
      coalesce(listed.value -> 'recordScope' -> 'routes', '[]'::jsonb)
    ) as listed_route(value)
    where listed_route.value ->> 'kind' = 'direct_share'
  ) into wants_share;

  if wants_share then
    -- The groups the caller belongs to now: an active group and a live,
    -- started, unexpired membership, exactly as the share tests require.
    select coalesce(pg_catalog.array_agg(distinct membership.group_id), array[]::uuid[])
    into member_group_ids
    from vortex_access.organization_group_memberships as membership
    join vortex_access.organization_groups as organization_group
      on organization_group.organization_id = membership.organization_id
      and organization_group.group_id = membership.group_id
      and organization_group.state = 'active'
    where membership.organization_id = decision_organization_id
      and membership.organization_account_id = account_id
      and membership.state = 'live'
      and membership.starts_at <= checked_at
      and (membership.expires_at is null or membership.expires_at > checked_at);

    for share_row in
      select share.readable_field_ids
      from vortex_access.organization_direct_record_shares as share
      where share.organization_id = decision_organization_id
        and share.storage_scope = binding ->> 'storageScope'
        and share.application_scope_id = coalesce(case
          when binding ->> 'storageScope' = 'application_contained'
            then (p_declaration -> 'target' ->> 'applicationRootId')::uuid
          else null::uuid
        end, '00000000-0000-0000-0000-000000000000'::uuid)
        and share.module_root_id = (binding ->> 'moduleRootId')::uuid
        and share.record_type_id = (binding ->> 'recordTypeId')::uuid
        and share.storage_contract_id = (binding ->> 'storageContractId')::uuid
        and share.state = 'active'
        and share.starts_at <= checked_at
        and (share.expires_at is null or share.expires_at > checked_at)
        and (
          (share.recipient_kind = 'organization_account'
            and share.organization_account_id = account_id)
          or (share.recipient_kind = 'group'
            and share.group_id = any (member_group_ids))
        )
    loop
      if not share_seen then
        share_intersection := array(
          select pg_catalog.lower(field.value)
          from pg_catalog.unnest(share_row.readable_field_ids::text[]) as field(value)
        );
        share_seen := true;
      else
        share_intersection := array(
          select field.value
          from pg_catalog.unnest(share_intersection) as field(value)
          where field.value = any (
            select pg_catalog.lower(shared.value)
            from pg_catalog.unnest(share_row.readable_field_ids::text[]) as shared(value)
          )
        );
      end if;
    end loop;
  end if;

  -- Each record is admitted by at least one (alternative, route) pair, and the
  -- exact decision exposes the union of the fields of the pairs that admit it.
  -- A field is therefore guaranteed on every admitted record only when every
  -- pair that can admit a record exposes it: the intersection over every pair,
  -- never a union within one alternative. An ownership, all-records or
  -- relationship pair exposes its permission's policy; a direct-share pair
  -- exposes that policy narrowed by the share, bounded here by the common
  -- bounds of every current share, and with no current share it admits no
  -- record and constrains nothing. Any unknown route fails closed.
  for candidate in
    select listed.value
    from pg_catalog.jsonb_array_elements(
      coalesce(eligibility -> 'eligiblePermissions', '[]'::jsonb)
    ) as listed(value)
  loop
    permission_value := candidate -> 'permission';
    source_value := candidate -> 'source';

    select entry.*
    into catalogue_entry
    from vortex_access.permission_catalogue_entries as entry
    join vortex_access.permission_registrations as registration
      on registration.organization_id = entry.organization_id
      and registration.registration_kind = entry.registration_kind
      and registration.registration_owner_id = entry.registration_owner_id
      and registration.revision = entry.registration_revision
      and registration.state = 'active'
    where entry.organization_id = decision_organization_id
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
    end if;

    for route in
      select listed_route.value
      from pg_catalog.jsonb_array_elements(routes) as listed_route(value)
    loop
      case route ->> 'kind'
        when 'all_records', 'ownership', 'relationship' then
          route_readable := policy_readable;
        when 'direct_share' then
          if not share_seen then
            continue;
          end if;
          route_readable := array(
            select shared.value
            from pg_catalog.unnest(policy_readable) as shared(value)
            where shared.value = any (share_intersection)
          );
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
      if pg_catalog.cardinality(guaranteed) = 0 then
        return nothing;
      end if;
    end loop;
  end loop;

  guaranteed := array(
    select field.value from pg_catalog.unnest(guaranteed) as field(value)
    order by field.value
  );

  return pg_catalog.jsonb_build_object(
    'readableFieldIds', pg_catalog.to_jsonb(guaranteed),
    'coversAllRecords', covers_all_records,
    'conditionFree', condition_free
  );
end
$function$;
alter function vortex_access.resolve_record_read_field_bounds_internal(jsonb) owner to vortex_owner;


revoke all on function vortex_access.resolve_record_read_field_bounds_internal(jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_access.resolve_record_read_field_bounds_internal(jsonb)
  to vortex_record_adapter;

comment on function vortex_access.resolve_record_read_field_bounds_internal(jsonb) is
  'Private whole-record-type field bounds for the fixed record query: from the caller''s own current eligible read alternatives it returns the fields every alternative route is guaranteed to expose on every record it can admit (the intersection over every alternative and route, each direct-share route narrowed by every current share''s own bounds), whether an unconditioned all-records alternative admits every active record, and whether no alternative carries a saved condition; any unknown route or missing policy yields no fields. It only decides which fields a scan may order or filter by and never decides access.';

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
  -- The most directly shared record identifiers one query carries. A caller
  -- with more is not narrowed by this route at all.
  shared_limit constant integer := 10000;
  ctx jsonb;
  checked_at timestamptz;
  binding jsonb;
  routes jsonb;
  eligibility jsonb;
  candidate jsonb;
  route jsonb;
  route_kind text;
  account_id uuid;
  member_group_ids uuid[];
  wants_owner boolean := false;
  wants_share boolean := false;
  -- Every route of every eligible alternative has an exact stored predicate, so
  -- a condition-free scan examines only rows the exact decision admits. When
  -- any route does not, that route's term is left true in the scan plan and no
  -- field is taken as readable for every scanned row.
  pushable boolean := true;
  shared_overflow boolean := false;
  shared uuid[] := array[]::uuid[];
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
  binding := p_declaration -> 'recordBinding';
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
      elsif route_kind = 'direct_share' then
        wants_share := true;
      else
        -- all_records admits every record; a relationship route is a
        -- relationship chase. Neither is a fixed stored predicate, so the scan
        -- is left unrestricted and the exact decision alone narrows it.
        pushable := false;
      end if;
    end loop;
  end loop;

  -- The groups the caller belongs to now: an active group and a live,
  -- started, unexpired membership, as the ownership and share tests require.
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

  if wants_share then
    -- The same current-share conditions as the exact-record contribution
    -- reader, over every record of this type instead of one. A caller with more
    -- shares than one query carries gets a null array: that route is not
    -- narrowed, rather than truncated.
    select coalesce(pg_catalog.array_agg(listed.record_id), array[]::uuid[])
    into shared
    from (
      select distinct share.record_id
      from vortex_access.organization_direct_record_shares as share
      where share.organization_id = (ctx ->> 'organizationId')::uuid
        and share.storage_scope = binding ->> 'storageScope'
        and share.application_scope_id = coalesce(case
          when binding ->> 'storageScope' = 'application_contained'
            then (p_declaration -> 'target' ->> 'applicationRootId')::uuid
          else null::uuid
        end, '00000000-0000-0000-0000-000000000000'::uuid)
        and share.module_root_id = (binding ->> 'moduleRootId')::uuid
        and share.record_type_id = (binding ->> 'recordTypeId')::uuid
        and share.storage_contract_id = (binding ->> 'storageContractId')::uuid
        and share.state = 'active'
        and share.starts_at <= checked_at
        and (share.expires_at is null or share.expires_at > checked_at)
        and (
          (share.recipient_kind = 'organization_account'
            and share.organization_account_id = account_id)
          or (share.recipient_kind = 'group'
            and share.group_id = any (member_group_ids))
        )
      limit shared_limit + 1
    ) as listed;
    if pg_catalog.cardinality(shared) > shared_limit then
      shared_overflow := true;
    end if;
  end if;

  if shared_overflow then
    -- That route is not narrowed, so no scanned row is guaranteed admitted.
    pushable := false;
  end if;

  return query select
    pushable,
    case when wants_owner and p_ownership_mode = 'organization_account'
      then account_id else null::uuid end,
    case when wants_owner and p_ownership_mode = 'group'
      then member_group_ids else array[]::uuid[] end,
    case when wants_share and not shared_overflow
      then shared else null::uuid[] end,
    alternatives;
end
$function$;
alter function vortex_access.resolve_record_read_scan_routes_internal(jsonb,text) owner to vortex_owner;


revoke all on function vortex_access.resolve_record_read_scan_routes_internal(jsonb, text)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_access.resolve_record_read_scan_routes_internal(jsonb, text)
  to vortex_record_adapter;

comment on function vortex_access.resolve_record_read_scan_routes_internal(jsonb, text) is
  'Private read-scan narrowing for the fixed record adapter: from the caller''s own current eligible read alternatives it returns the owner account, owner groups and directly shared record identifiers, the eligible alternatives reduced to their route lists and saved-condition envelopes, and whether every route has an exact stored predicate; it only narrows candidates and never replaces the exact-record decision.';

alter function vortex_access.resolve_record_read_scan_routes_internal(jsonb, text)
  owner to vortex_owner;

reset role;
