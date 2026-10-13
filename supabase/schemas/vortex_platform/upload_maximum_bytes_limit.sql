CREATE OR REPLACE FUNCTION vortex_platform.upload_maximum_bytes_limit() RETURNS bigint
    LANGUAGE sql IMMUTABLE
    SET search_path TO ''
    AS $$
  select 5000::bigint * 1024 * 1024
$$;

alter function vortex_platform.upload_maximum_bytes_limit() owner to vortex_owner;

COMMENT ON FUNCTION vortex_platform.upload_maximum_bytes_limit() IS 'The platform ceiling for one uploaded file, matching the 5000 MB field maximum.';

REVOKE ALL ON FUNCTION vortex_platform.upload_maximum_bytes_limit() FROM PUBLIC;

grant execute on function vortex_platform.upload_maximum_bytes_limit() to postgres;
