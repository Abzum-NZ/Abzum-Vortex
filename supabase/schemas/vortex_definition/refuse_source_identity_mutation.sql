CREATE OR REPLACE FUNCTION vortex_definition.refuse_source_identity_mutation() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
begin
  -- The one application purge function deletes this table's rows; nothing else may.
  if tg_op = 'DELETE' and current_user = 'vortex_owner'
    and pg_catalog.current_setting('vortex.application_purge', true) = 'on' then
    return old;
  end if;
  raise exception using
    errcode = '23514',
    message = 'Definition source identities and aliases are append-only';
end
$$;

alter function vortex_definition.refuse_source_identity_mutation() owner to vortex_owner;

REVOKE ALL ON FUNCTION vortex_definition.refuse_source_identity_mutation() FROM PUBLIC;

grant execute on function vortex_definition.refuse_source_identity_mutation() to postgres;
