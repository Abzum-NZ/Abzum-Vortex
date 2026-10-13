CREATE OR REPLACE FUNCTION vortex_platform.upload_refusal(p_reason text) RETURNS jsonb
    LANGUAGE sql IMMUTABLE
    SET search_path TO ''
    AS $$
  select pg_catalog.jsonb_build_object('outcome', 'refused', 'reason', p_reason)
$$;

alter function vortex_platform.upload_refusal(p_reason text) owner to vortex_owner;

REVOKE ALL ON FUNCTION vortex_platform.upload_refusal(p_reason text) FROM PUBLIC;
GRANT ALL ON FUNCTION vortex_platform.upload_refusal(p_reason text) TO vortex_owner;

grant execute on function vortex_platform.upload_refusal(p_reason text) to postgres;
