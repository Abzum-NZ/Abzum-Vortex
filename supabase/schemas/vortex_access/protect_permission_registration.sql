CREATE FUNCTION vortex_access.protect_permission_registration() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
begin
  if tg_op = 'DELETE' then
    raise exception using errcode = '23514', message = 'Permission registrations cannot be deleted';
  end if;
  if new.organization_id is distinct from old.organization_id
    or new.registration_kind is distinct from old.registration_kind
    or new.registration_owner_id is distinct from old.registration_owner_id
    or new.revision <> old.revision + 1
    or new.changed_at < old.changed_at then
    raise exception using errcode = '23514', message = 'Permission registration updates require one permanent-scope revision';
  end if;
  return new;
end
$$;


ALTER FUNCTION vortex_access.protect_permission_registration() OWNER TO postgres;

REVOKE ALL ON FUNCTION vortex_access.protect_permission_registration() FROM PUBLIC;
