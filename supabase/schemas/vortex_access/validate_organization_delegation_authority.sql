CREATE FUNCTION vortex_access.validate_organization_delegation_authority() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
begin
  if tg_op = 'INSERT' and (
    new.revision <> 1
    or new.state <> 'live'
    or (new.expires_at is not null
      and new.expires_at <= pg_catalog.statement_timestamp())
  ) then
    raise exception using errcode = '23514',
      message = 'A new delegation requires a current live revision-one window';
  end if;

  if tg_op = 'UPDATE' and new.state = 'revoked' then
    return new;
  end if;

  if new.expires_at is not null
    and new.expires_at <= pg_catalog.statement_timestamp() then
    raise exception using errcode = '23514',
      message = 'An expired delegation cannot receive replacement scope';
  end if;

  if new.holder_kind = 'organization_account' then
    if not exists (
      select 1
      from vortex_identity.organization_accounts as account
      where account.organization_id = new.organization_id
        and account.organization_account_id = new.organization_account_id
        and account.state = 'active'
    ) then
      raise exception using errcode = '23514',
        message = 'A delegation requires an active same-organization account';
    end if;
  elsif new.holder_kind = 'group' then
    if not exists (
      select 1
      from vortex_access.organization_groups as organization_group
      where organization_group.organization_id = new.organization_id
        and organization_group.group_id = new.group_id
        and organization_group.state = 'active'
    ) then
      raise exception using errcode = '23514',
        message = 'A delegation requires an active same-organization Group';
    end if;
  end if;

  if new.scope_kind = 'bounded' then
    perform vortex_access.validate_organization_delegation_bounded_permissions(
      new.organization_id,
      new.bounded_permissions
    );
  end if;

  return new;
end
$$;

ALTER FUNCTION vortex_access.validate_organization_delegation_authority() OWNER TO postgres;

REVOKE ALL ON FUNCTION vortex_access.validate_organization_delegation_authority() FROM PUBLIC;
