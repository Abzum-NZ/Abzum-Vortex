CREATE OR REPLACE FUNCTION vortex_access.permission_field_policy_is_valid(p_policy jsonb) RETURNS boolean
    LANGUAGE plpgsql IMMUTABLE
    SET search_path TO ''
    AS $$
declare
  field_value jsonb;
  field_id text;
  previous_field_id text;
begin
  if p_policy is null
    or pg_catalog.jsonb_typeof(p_policy) <> 'object'
    or p_policy - array['readableFieldIds', 'changeableFieldIds']::text[] <> '{}'::jsonb
    or not (p_policy ?& array['readableFieldIds', 'changeableFieldIds'])
    or pg_catalog.jsonb_typeof(p_policy -> 'readableFieldIds') <> 'array'
    or pg_catalog.jsonb_typeof(p_policy -> 'changeableFieldIds') <> 'array' then
    return false;
  end if;

  previous_field_id := null;
  for field_value in
    select item.value from pg_catalog.jsonb_array_elements(
      p_policy -> 'readableFieldIds'
    ) as item(value)
  loop
    if pg_catalog.jsonb_typeof(field_value) <> 'string' then return false; end if;
    field_id := field_value #>> '{}';
    if not vortex_platform.is_non_nil_uuid(field_id)
      or (
        previous_field_id is not null
        and previous_field_id >= pg_catalog.lower(field_id)
      ) then
      return false;
    end if;
    previous_field_id := pg_catalog.lower(field_id);
  end loop;

  previous_field_id := null;
  for field_value in
    select item.value from pg_catalog.jsonb_array_elements(
      p_policy -> 'changeableFieldIds'
    ) as item(value)
  loop
    if pg_catalog.jsonb_typeof(field_value) <> 'string' then return false; end if;
    field_id := field_value #>> '{}';
    if not vortex_platform.is_non_nil_uuid(field_id)
      or (
        previous_field_id is not null
        and previous_field_id >= pg_catalog.lower(field_id)
      )
      or not exists (
        select 1
        from pg_catalog.jsonb_array_elements_text(
          p_policy -> 'readableFieldIds'
        ) as readable(value)
        where pg_catalog.lower(readable.value) = pg_catalog.lower(field_id)
      ) then
      return false;
    end if;
    previous_field_id := pg_catalog.lower(field_id);
  end loop;
  return true;
end
$$;

ALTER FUNCTION vortex_access.permission_field_policy_is_valid(p_policy jsonb) OWNER TO postgres;

COMMENT ON FUNCTION vortex_access.permission_field_policy_is_valid(p_policy jsonb) IS 'Private strict validator for canonical unique field-policy UUID arrays and their subset rule.';

REVOKE ALL ON FUNCTION vortex_access.permission_field_policy_is_valid(p_policy jsonb) FROM PUBLIC;
