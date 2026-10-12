CREATE FUNCTION vortex_access.lock_role_and_refuse_sealed_permission_append() RETURNS trigger
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
      message = 'Organization role permission entries require a permanent role';
  end if;

  if exists (
    select 1
    from vortex_access.organization_role_revisions as revision
    where revision.organization_id = new.organization_id
      and revision.role_id = new.role_id
      and revision.revision = new.role_revision
  ) then
    raise exception using errcode = '23514',
      message = 'Organization role permission set is already sealed';
  end if;

  return new;
end
$$;


ALTER FUNCTION vortex_access.lock_role_and_refuse_sealed_permission_append() OWNER TO postgres;

REVOKE ALL ON FUNCTION vortex_access.lock_role_and_refuse_sealed_permission_append() FROM PUBLIC;
