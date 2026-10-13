CREATE FUNCTION vortex_definition.refuse_release_mutation() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
begin
  raise exception using
    errcode = '23514',
    message = 'Definition releases and dependency manifests are append-only';
end
$$;

ALTER FUNCTION vortex_definition.refuse_release_mutation() OWNER TO postgres;

REVOKE ALL ON FUNCTION vortex_definition.refuse_release_mutation() FROM PUBLIC;
