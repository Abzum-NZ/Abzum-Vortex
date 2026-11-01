CREATE FUNCTION vortex_access.refuse_organization_role_history_mutation() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
begin
  -- The one application purge function deletes this table's rows; nothing else may.
  if tg_op = 'DELETE' and current_user = 'vortex_owner'
    and pg_catalog.current_setting('vortex.application_purge', true) = 'on' then
    return old;
  end if;
  raise exception using errcode = '23514', message = 'Organization role history is immutable';
end;
$$;

alter function vortex_access.refuse_organization_role_history_mutation() owner to vortex_owner;

REVOKE ALL ON FUNCTION vortex_access.refuse_organization_role_history_mutation() FROM PUBLIC;

grant execute on function vortex_access.refuse_organization_role_history_mutation() to postgres;
