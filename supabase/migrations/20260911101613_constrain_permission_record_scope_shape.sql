-- Validate the permission record-scope shape once, where it is stored, so
-- every SQL consumer can rely on it without restating it (#387). Every
-- structural rule below is copied from `permissionRecordScopeSchema` and its
-- route and saved-condition schemas (contracts/src/permissions.ts:56-146):
-- routes are unique and in canonical order; `all_records` is the sole route
-- when present; the scope has exactly the keys `routes` and an optional
-- `savedCondition`; each route kind has its own exact shape; `savedCondition`
-- has its own exact shape. Modelled on the neighbouring
-- `vortex_access.permission_field_policy_is_valid`
-- (20260907223932_preserve_permission_field_policy.sql:21-95): pure,
-- immutable, invoker-rights, empty search path, boolean-returning, never
-- raising.
create function vortex_access.permission_record_scope_is_valid(p_record_scope jsonb)
returns boolean
language plpgsql
immutable
security invoker
set search_path = ''
as $function$
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
    elsif route_kind = 'direct_share' then
      if route_value - array['kind']::text[] <> '{}'::jsonb then
        return false;
      end if;
      route_identity := '2:';
    elsif route_kind = 'relationship' then
      if route_value - array['kind', 'relationshipId', 'sourcePermissionId']::text[]
          <> '{}'::jsonb
        or not (route_value ?& array['relationshipId', 'sourcePermissionId'])
        or pg_catalog.jsonb_typeof(route_value -> 'relationshipId') <> 'string'
        or pg_catalog.jsonb_typeof(route_value -> 'sourcePermissionId') <> 'string'
        or not vortex_context.is_non_nil_uuid(route_value ->> 'relationshipId')
        or not vortex_context.is_non_nil_uuid(route_value ->> 'sourcePermissionId') then
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
      or not vortex_context.is_non_nil_uuid(saved_condition ->> 'conditionId')
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
$function$;

revoke execute on function vortex_access.permission_record_scope_is_valid(jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

comment on function vortex_access.permission_record_scope_is_valid(jsonb) is
  'Private strict validator for canonical unique record-scope routes, the sole all-record route rule and the saved-condition envelope shape.';

-- The store now establishes what every SQL consumer of `record_scope` used to
-- assume or re-derive. Mirrors how the neighbouring `field_policy` column
-- carries both its original loose object-shape check
-- (permission_catalogue_entries_record_scope_shape,
-- 20260906113848_preserve_permission_record_scope.sql:7-15) and a later,
-- stricter value check; this is that stricter check for record_scope.
alter table vortex_access.permission_catalogue_entries
  add constraint permission_catalogue_entries_record_scope_value check (
    record_scope is null
    or vortex_access.permission_record_scope_is_valid(record_scope)
  );

-- Remove only the route/savedCondition-key shape re-validation this function
-- used to perform on `p_permission_record_scope`
-- (20260906144015_evaluate_current_record_ownership_visibility.sql:52-166).
-- That shape is now guaranteed by the store for every real caller:
--   * `evaluate_record_permission_row_scope_internal` passes
--     `candidate.recordScope`, which is always either
--     `eligiblePermissions[].recordScope` from
--     `evaluate_organization_record_permission_eligibility_internal` (built
--     directly from `(evaluated.permission_entry).record_scope`, i.e. a
--     `permission_catalogue_entries` row returned by
--     `evaluate_permission_role_path_internal`,
--     20260910031411_extract_shared_permission_eligibility_core.sql:19,43,
--     1331), or the same field on a relationship-chase `source_candidate`
--     built from that identical row type
--     (20260910040755_compose_exact_record_access_decision.sql:342,353) --
--     column-sourced either way.
--   * The one caller that is not column-sourced is the fixed literal
--     `{"routes":[{"kind":"ownership"}]}` used by the inherited-ownership
--     chase (20260910040755_compose_exact_record_access_decision.sql:218).
--     It is a compile-time constant, never a variable, and is trivially
--     valid by inspection (one legal route, no savedCondition, no extra
--     keys), so removing the runtime check changes nothing it can reach.
-- The revocation filter never called this function at all; it reads
-- `entry.record_scope` directly off the column
-- (20260910114716_coordinate_protected_record_share.sql:781-786).
-- Row-dependent logic (ownership evidence, record identity, binding
-- match, Group membership) is unchanged below; only the two route kinds
-- this function's own row-dependent logic consumes are still read, now
-- without re-validating the routes array's shape.
create or replace function vortex_access.evaluate_current_record_ownership_visibility(
  p_permission_record_scope jsonb,
  p_ownership_mode text,
  p_binding_organization_id uuid,
  p_binding_application_root_id uuid,
  p_binding_module_root_id uuid,
  p_binding_record_type_id uuid,
  p_binding_storage_contract_id uuid,
  p_binding_storage_scope text,
  p_record_scope jsonb,
  p_owner_organization_account_id uuid,
  p_owner_group_id uuid,
  p_current_organization_id uuid,
  p_current_application_root_id uuid,
  p_current_organization_account_id uuid,
  p_checked_at timestamptz
)
returns table (
  admitted boolean,
  valid_until timestamptz
)
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  nil_id constant uuid := '00000000-0000-0000-0000-000000000000'::uuid;
  scope_key_count integer;
  has_all_records boolean;
  has_ownership boolean;
  record_storage_scope text;
  record_organization_id uuid;
  record_application_root_id uuid;
  record_module_root_id uuid;
  record_type_id uuid;
  record_storage_contract_id uuid;
  record_id uuid;
  membership_deadline timestamptz;
begin
  has_all_records := exists (
    select 1
    from pg_catalog.jsonb_array_elements(
      p_permission_record_scope -> 'routes'
    ) as route(value)
    where route.value ->> 'kind' = 'all_records'
  );
  has_ownership := exists (
    select 1
    from pg_catalog.jsonb_array_elements(
      p_permission_record_scope -> 'routes'
    ) as route(value)
    where route.value ->> 'kind' = 'ownership'
  );

  if p_binding_organization_id is null or p_binding_organization_id = nil_id
    or p_binding_application_root_id is null
    or p_binding_application_root_id = nil_id
    or p_binding_module_root_id is null or p_binding_module_root_id = nil_id
    or p_binding_record_type_id is null or p_binding_record_type_id = nil_id
    or p_binding_storage_contract_id is null
    or p_binding_storage_contract_id = nil_id
    or p_current_organization_id is null or p_current_organization_id = nil_id
    or p_current_application_root_id is null
    or p_current_application_root_id = nil_id
    or p_current_organization_account_id is null
    or p_current_organization_account_id = nil_id
    or p_checked_at is null
    or p_checked_at in ('-infinity'::timestamptz, 'infinity'::timestamptz)
    or p_binding_storage_scope is null
    or p_binding_storage_scope not in ('organization_shared', 'application_contained')
    or p_ownership_mode is null
    or p_ownership_mode not in ('none', 'organization_account', 'team', 'inherited') then
    raise exception using errcode = '22023',
      message = 'Record visibility context is invalid';
  end if;

  if (p_ownership_mode in ('none', 'inherited')
      and (p_owner_organization_account_id is not null or p_owner_group_id is not null))
    or (p_ownership_mode = 'organization_account'
      and (p_owner_organization_account_id is null
        or p_owner_organization_account_id = nil_id
        or p_owner_group_id is not null))
    or (p_ownership_mode = 'team'
      and (p_owner_group_id is null or p_owner_group_id = nil_id
        or p_owner_organization_account_id is not null)) then
    raise exception using errcode = '22023',
      message = 'Record ownership evidence is invalid';
  end if;

  if p_record_scope is null
    or pg_catalog.jsonb_typeof(p_record_scope) is distinct from 'object' then
    raise exception using errcode = '22023',
      message = 'Record identity is invalid';
  end if;
  record_storage_scope := p_record_scope ->> 'storageScope';
  select pg_catalog.count(*) into scope_key_count
  from pg_catalog.jsonb_object_keys(p_record_scope) as record_key;
  if record_storage_scope = 'organization_shared' then
    if scope_key_count <> 6 or p_record_scope ? 'applicationRootId' then
      raise exception using errcode = '22023', message = 'Record identity is invalid';
    end if;
  elsif record_storage_scope = 'application_contained' then
    if scope_key_count <> 7 or not (p_record_scope ? 'applicationRootId') then
      raise exception using errcode = '22023', message = 'Record identity is invalid';
    end if;
  else
    raise exception using errcode = '22023', message = 'Record identity is invalid';
  end if;

  if not (p_record_scope ?& array[
    'organizationId', 'moduleRootId', 'recordTypeId',
    'storageContractId', 'recordId'
  ]) then
    raise exception using errcode = '22023', message = 'Record identity is invalid';
  end if;
  if not vortex_context.is_non_nil_uuid(p_record_scope ->> 'organizationId')
    or not vortex_context.is_non_nil_uuid(p_record_scope ->> 'moduleRootId')
    or not vortex_context.is_non_nil_uuid(p_record_scope ->> 'recordTypeId')
    or not vortex_context.is_non_nil_uuid(p_record_scope ->> 'storageContractId')
    or not vortex_context.is_non_nil_uuid(p_record_scope ->> 'recordId')
    or (record_storage_scope = 'application_contained'
      and not vortex_context.is_non_nil_uuid(
        p_record_scope ->> 'applicationRootId'
      )) then
    raise exception using errcode = '22023', message = 'Record identity is invalid';
  end if;
  begin
    record_organization_id := (p_record_scope ->> 'organizationId')::uuid;
    record_module_root_id := (p_record_scope ->> 'moduleRootId')::uuid;
    record_type_id := (p_record_scope ->> 'recordTypeId')::uuid;
    record_storage_contract_id := (p_record_scope ->> 'storageContractId')::uuid;
    record_id := (p_record_scope ->> 'recordId')::uuid;
    if record_storage_scope = 'application_contained' then
      record_application_root_id := (p_record_scope ->> 'applicationRootId')::uuid;
    end if;
  exception
    when invalid_text_representation then
      raise exception using errcode = '22023', message = 'Record identity is invalid';
  end;
  if record_organization_id is null or record_organization_id = nil_id
    or record_module_root_id is null or record_module_root_id = nil_id
    or record_type_id is null or record_type_id = nil_id
    or record_storage_contract_id is null or record_storage_contract_id = nil_id
    or record_id is null or record_id = nil_id
    or (record_storage_scope = 'application_contained'
      and (record_application_root_id is null or record_application_root_id = nil_id)) then
    raise exception using errcode = '22023', message = 'Record identity is invalid';
  end if;

  if p_binding_organization_id <> p_current_organization_id
    or p_binding_application_root_id <> p_current_application_root_id
    or record_organization_id <> p_current_organization_id
    or record_module_root_id <> p_binding_module_root_id
    or record_type_id <> p_binding_record_type_id
    or record_storage_contract_id <> p_binding_storage_contract_id
    or record_storage_scope <> p_binding_storage_scope
    or (record_storage_scope = 'application_contained'
      and record_application_root_id <> p_current_application_root_id) then
    return query select false, null::timestamptz;
    return;
  end if;

  if has_all_records then
    return query select true, null::timestamptz;
    return;
  end if;

  if has_ownership and p_ownership_mode = 'organization_account'
    and p_owner_organization_account_id = p_current_organization_account_id then
    return query select true, null::timestamptz;
    return;
  end if;

  if has_ownership and p_ownership_mode = 'team' then
    select membership.expires_at into membership_deadline
    from vortex_access.organization_group_memberships as membership
    join vortex_access.organization_groups as organization_group
      on organization_group.organization_id = membership.organization_id
      and organization_group.group_id = membership.group_id
      and organization_group.state = 'active'
    where membership.organization_id = p_current_organization_id
      and membership.group_id = p_owner_group_id
      and membership.organization_account_id = p_current_organization_account_id
      and membership.state = 'live'
      and membership.starts_at <= p_checked_at
      and (membership.expires_at is null or membership.expires_at > p_checked_at);
    if found then
      return query select true, membership_deadline;
      return;
    end if;
  end if;

  return query select false, null::timestamptz;
end
$function$;

revoke execute on function vortex_access.evaluate_current_record_ownership_visibility(
  jsonb, text, uuid, uuid, uuid, uuid, uuid, text, jsonb, uuid, uuid,
  uuid, uuid, uuid, timestamptz
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

comment on function vortex_access.evaluate_current_record_ownership_visibility(
  jsonb, text, uuid, uuid, uuid, uuid, uuid, text, jsonb, uuid, uuid,
  uuid, uuid, uuid, timestamptz
) is
  'Evaluates all-record and direct account/current-Group ownership routes over one trusted current record projection; unsupported valid routes add no authority.';
