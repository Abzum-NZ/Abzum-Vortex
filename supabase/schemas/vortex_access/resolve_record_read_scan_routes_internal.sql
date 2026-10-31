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
