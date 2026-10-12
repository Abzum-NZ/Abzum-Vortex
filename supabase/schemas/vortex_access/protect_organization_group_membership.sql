CREATE FUNCTION vortex_access.protect_organization_group_membership() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
begin
  if tg_op = 'DELETE' then
    raise exception using errcode = '23514',
      message = 'Organization Group memberships cannot be deleted';
  end if;

  if old.revision = 9007199254740991 then
    raise exception using errcode = '22003',
      message = 'Organization Group membership revision is exhausted';
  end if;

  if new.organization_id is distinct from old.organization_id
    or new.membership_id is distinct from old.membership_id
    or new.group_id is distinct from old.group_id
    or new.organization_account_id is distinct from old.organization_account_id
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
      message = 'Organization Group membership identity or evidence is immutable';
  end if;

  if old.state = 'live' and new.state = 'revoked' then
    if new.revoked_at is null or new.revoked_at < old.changed_at then
      raise exception using errcode = '23514',
        message = 'Group membership revocation cannot predate current evidence';
    end if;
    return new;
  end if;

  if old.state = 'revoked' and new.state = 'live' then
    if new.expires_at is not null
      and new.expires_at <= pg_catalog.statement_timestamp() then
      raise exception using errcode = '23514',
        message = 'An expired Group membership requires a new identity';
    end if;

    if not exists (
      select 1
      from vortex_access.organization_groups as organization_group
      where organization_group.organization_id = new.organization_id
        and organization_group.group_id = new.group_id
        and organization_group.state = 'active'
    ) or not exists (
      select 1
      from vortex_identity.organization_accounts as account
      where account.organization_id = new.organization_id
        and account.organization_account_id = new.organization_account_id
        and account.state = 'active'
    ) then
      raise exception using errcode = '23514',
        message = 'Group membership restoration requires active same-organization sources';
    end if;

    return new;
  end if;

  raise exception using errcode = '23514',
    message = 'Organization Group membership transition is invalid';
end
$$;


ALTER FUNCTION vortex_access.protect_organization_group_membership() OWNER TO postgres;

REVOKE ALL ON FUNCTION vortex_access.protect_organization_group_membership() FROM PUBLIC;
