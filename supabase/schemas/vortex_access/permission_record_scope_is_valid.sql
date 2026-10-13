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

ALTER FUNCTION vortex_access.permission_record_scope_is_valid(p_record_scope jsonb) OWNER TO postgres;

COMMENT ON FUNCTION vortex_access.permission_record_scope_is_valid(p_record_scope jsonb) IS 'Private strict validator for canonical unique record-scope routes, the sole all-record route rule and the saved-condition envelope shape.';

SET default_tablespace = '';

SET default_table_access_method = heap;

REVOKE ALL ON FUNCTION vortex_access.permission_record_scope_is_valid(p_record_scope jsonb) FROM PUBLIC;
