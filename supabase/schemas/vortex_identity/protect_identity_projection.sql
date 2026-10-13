CREATE FUNCTION vortex_identity.protect_identity_projection() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
begin
  if new.identity_id is distinct from old.identity_id
    or new.created_at is distinct from old.created_at then
    raise exception using errcode = '23514', message = 'Identity projection identity is permanent';
  end if;

  if old.state = 'closed' and new.state <> 'closed' then
    raise exception using errcode = '23514', message = 'A closed identity projection cannot be reactivated';
  end if;

  if new.state = 'active' and old.state <> 'active'
    and vortex_identity.identity_is_disabled(new.identity_id) then
    raise exception using errcode = '23514', message = 'A disabled identity projection cannot be reactivated';
  end if;

  if new.revision <> old.revision + 1
    or new.revision > 9007199254740991
    or new.state_changed_at < old.state_changed_at then
    raise exception using errcode = '40001', message = 'Identity projection revision is stale or invalid';
  end if;

  return new;
end
$$;

ALTER FUNCTION vortex_identity.protect_identity_projection() OWNER TO postgres;

REVOKE ALL ON FUNCTION vortex_identity.protect_identity_projection() FROM PUBLIC;
