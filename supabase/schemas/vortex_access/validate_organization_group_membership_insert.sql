CREATE FUNCTION vortex_access.validate_organization_group_membership_insert() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
begin
  if new.revision <> 1
    or new.state <> 'live'
    or (new.expires_at is not null
      and new.expires_at <= pg_catalog.statement_timestamp()) then
    raise exception using errcode = '23514',
      message = 'A new Group membership requires a current live revision-one window';
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
      message = 'A new Group membership requires active same-organization sources';
  end if;

  return new;
end
$$;


ALTER FUNCTION vortex_access.validate_organization_group_membership_insert() OWNER TO postgres;

REVOKE ALL ON FUNCTION vortex_access.validate_organization_group_membership_insert() FROM PUBLIC;
