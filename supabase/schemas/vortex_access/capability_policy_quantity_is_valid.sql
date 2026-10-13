CREATE FUNCTION vortex_access.capability_policy_quantity_is_valid(p_quantity numeric) RETURNS boolean
    LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
    SET search_path TO ''
    AS $$
  select p_quantity <> 'NaN'::numeric
    and p_quantity > 0
    and p_quantity <= 9007199254740991::numeric
    -- A stored limit must survive the double-precision contract quantity
    -- exactly, so no reader ever silently rounds a limit it cannot represent.
    and p_quantity = (p_quantity::float8)::numeric;
$$;

alter function vortex_access.capability_policy_quantity_is_valid(p_quantity numeric) owner to vortex_owner;

REVOKE ALL ON FUNCTION vortex_access.capability_policy_quantity_is_valid(p_quantity numeric) FROM PUBLIC;

grant execute on function vortex_access.capability_policy_quantity_is_valid(p_quantity numeric) to postgres;
