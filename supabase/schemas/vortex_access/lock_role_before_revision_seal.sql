CREATE FUNCTION vortex_access.lock_role_before_revision_seal() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
begin
  perform 1
  from vortex_access.organization_roles as role
  where role.organization_id = new.organization_id
    and role.role_id = new.role_id
  for update;
  if not found then
    raise exception using errcode = '23503',
      message = 'Organization role revisions require a permanent role';
  end if;
  return new;
end
$$;

alter function vortex_access.lock_role_before_revision_seal() owner to vortex_owner;

REVOKE ALL ON FUNCTION vortex_access.lock_role_before_revision_seal() FROM PUBLIC;

grant execute on function vortex_access.lock_role_before_revision_seal() to postgres;
