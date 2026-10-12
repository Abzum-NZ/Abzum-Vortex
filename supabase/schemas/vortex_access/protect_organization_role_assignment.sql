CREATE FUNCTION vortex_access.protect_organization_role_assignment() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
begin
  if tg_op = 'DELETE' then
    raise exception using errcode = '23514',
      message = 'Organization role assignments cannot be deleted';
  end if;

  if old.revision = 9007199254740991 then
    raise exception using errcode = '22003',
      message = 'Organization role assignment revision is exhausted';
  end if;

  if old.state = 'revoked'
    or new.state <> 'revoked'
    or new.revoked_at is null
    or new.revoked_at < old.changed_at
    or new.organization_id is distinct from old.organization_id
    or new.role_assignment_id is distinct from old.role_assignment_id
    or new.role_id is distinct from old.role_id
    or new.assignee_kind is distinct from old.assignee_kind
    or new.organization_account_id is distinct from old.organization_account_id
    or new.group_id is distinct from old.group_id
    or new.assignment_kind is distinct from old.assignment_kind
    or new.starts_at is distinct from old.starts_at
    or new.expires_at is distinct from old.expires_at
    or new.granted_by is distinct from old.granted_by
    or new.granted_at is distinct from old.granted_at
    or new.grant_correlation_id is distinct from old.grant_correlation_id
    or new.revision <> old.revision + 1
    or new.changed_at < old.changed_at
    or (new.changed_by, new.changed_at, new.change_correlation_id)
      is not distinct from
      (old.changed_by, old.changed_at, old.change_correlation_id) then
    raise exception using errcode = '23514',
      message = 'Organization role assignment transition is invalid';
  end if;

  return new;
end
$$;


ALTER FUNCTION vortex_access.protect_organization_role_assignment() OWNER TO postgres;

REVOKE ALL ON FUNCTION vortex_access.protect_organization_role_assignment() FROM PUBLIC;
