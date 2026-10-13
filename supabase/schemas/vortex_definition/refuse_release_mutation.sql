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

alter function vortex_definition.refuse_release_mutation() owner to vortex_owner;

REVOKE ALL ON FUNCTION vortex_definition.refuse_release_mutation() FROM PUBLIC;

grant execute on function vortex_definition.refuse_release_mutation() to postgres;
