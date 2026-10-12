CREATE FUNCTION vortex_identity.require_identity_not_disabled(p_identity_id uuid) RETURNS void
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
begin
  if p_identity_id is null
    or not vortex_context.is_non_nil_uuid(p_identity_id::text)
    or vortex_identity.identity_is_disabled(p_identity_id)
  then
    raise exception using errcode = '42501', message = 'Identity is unavailable';
  end if;
end
$$;


ALTER FUNCTION vortex_identity.require_identity_not_disabled(p_identity_id uuid) OWNER TO postgres;

COMMENT ON FUNCTION vortex_identity.require_identity_not_disabled(p_identity_id uuid) IS 'Runtime live check at named sensitive operations: refuses (42501) an identity whose disablement completed.';

REVOKE ALL ON FUNCTION vortex_identity.require_identity_not_disabled(p_identity_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION vortex_identity.require_identity_not_disabled(p_identity_id uuid) TO vortex_runtime;
