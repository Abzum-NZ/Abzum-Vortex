CREATE FUNCTION vortex_file.upload_maximum_bytes_limit() RETURNS bigint
    LANGUAGE sql IMMUTABLE
    SET search_path TO ''
    AS $$
  select 5000::bigint * 1024 * 1024
$$;


ALTER FUNCTION vortex_file.upload_maximum_bytes_limit() OWNER TO postgres;

COMMENT ON FUNCTION vortex_file.upload_maximum_bytes_limit() IS 'The platform ceiling for one uploaded file, matching the 5000 MB field maximum.';

REVOKE ALL ON FUNCTION vortex_file.upload_maximum_bytes_limit() FROM PUBLIC;
