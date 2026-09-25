create or replace function vortex_access.resolve_record_read_scan_routes_internal(
  p_declaration jsonb,
  p_ownership_mode text
)
returns table (
  restricted boolean,
  owner_account_id uuid,
  owner_group_ids uuid[],
  shared_record_ids uuid[]
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
  account_id uuid;
  member_group_ids uuid[];
  wants_owner boolean := false;
  wants_share boolean := false;
  shared uuid[] := array[]::uuid[];
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

  -- An ineligible caller is refused for every record by that decision.
  if eligibility ->> 'outcome' <> 'eligible' then
    return query select true, null::uuid, array[]::uuid[], array[]::uuid[];
    return;
  end if;

  -- Only a route whose per-record test has an exact table form is pushed down.
  -- An all-records route, an inherited-ownership chase, a relationship route or
  -- any route this function does not know leaves the scan unrestricted, so the
  -- per-row decision alone narrows it.
  for candidate in
    select item.value
    from pg_catalog.jsonb_array_elements(eligibility -> 'eligiblePermissions') as item(value)
  loop
    routes := candidate -> 'recordScope' -> 'routes';
    if pg_catalog.jsonb_typeof(routes) is distinct from 'array' then
      return query select false, null::uuid, array[]::uuid[], array[]::uuid[];
      return;
    end if;
    for route in
      select item.value from pg_catalog.jsonb_array_elements(routes) as item(value)
    loop
      case route ->> 'kind'
        when 'ownership' then
          if p_ownership_mode = 'inherited' then
            return query select false, null::uuid, array[]::uuid[], array[]::uuid[];
            return;
          end if;
          wants_owner := true;
        when 'direct_share' then
          wants_share := true;
        else
          return query select false, null::uuid, array[]::uuid[], array[]::uuid[];
          return;
      end case;
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
    -- reader, over every record of this type instead of one.
    select coalesce(pg_catalog.array_agg(listed.record_id), array[]::uuid[])
    into shared
    from (
      select distinct share.record_id
      from vortex_access.organization_direct_record_shares as share
      where share.organization_id = (ctx ->> 'organizationId')::uuid
        and share.storage_scope = binding ->> 'storageScope'
        and share.application_root_id is not distinct from case
          when binding ->> 'storageScope' = 'application_contained'
            then (p_declaration -> 'target' ->> 'applicationRootId')::uuid
          else null::uuid
        end
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
      return query select false, null::uuid, array[]::uuid[], array[]::uuid[];
      return;
    end if;
  end if;

  return query select
    true,
    case when wants_owner and p_ownership_mode = 'organization_account'
      then account_id else null::uuid end,
    case when wants_owner and p_ownership_mode = 'group'
      then member_group_ids else array[]::uuid[] end,
    shared;
end
$function$;

revoke all on function vortex_access.resolve_record_read_scan_routes_internal(jsonb, text)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner, vortex_module_owner;
grant execute on function vortex_access.resolve_record_read_scan_routes_internal(jsonb, text)
  to vortex_record_adapter;

comment on function vortex_access.resolve_record_read_scan_routes_internal(jsonb, text) is
  'Private read-scan narrowing for the fixed record adapter: from the caller''s own current eligible read alternatives it returns the owner account, owner groups and directly shared record identifiers that can be admitted, or unrestricted when any route has no exact table form; it only narrows candidates and never replaces the exact-record decision.';
