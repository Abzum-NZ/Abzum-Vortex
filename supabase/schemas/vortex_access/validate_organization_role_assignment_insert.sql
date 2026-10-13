CREATE FUNCTION vortex_access.validate_organization_role_assignment_insert() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
begin
  if new.revision <> 1
    or new.state <> 'live'
    or (new.expires_at is not null
      and new.expires_at <= pg_catalog.statement_timestamp()) then
    raise exception using errcode = '23514',
      message = 'A new role assignment requires a current live revision-one window';
  end if;

  if not exists (
    select 1
    from vortex_access.organization_roles as role
    join vortex_access.organization_role_revisions as revision
      on revision.organization_id = role.organization_id
      and revision.role_id = role.role_id
      and revision.revision = role.live_revision
    where role.organization_id = new.organization_id
      and role.role_id = new.role_id
      and revision.lifecycle = 'active'
      and (
        (new.assignment_kind = 'standing' and revision.assignment_policy = 'standing')
        or (
          new.assignment_kind = 'eligible'
          and revision.assignment_policy = 'activation_required'
        )
      )
  ) then
    raise exception using errcode = '23514',
      message = 'A new role assignment requires a compatible active role';
  end if;

  if new.assignee_kind = 'organization_account' then
    if not exists (
      select 1
      from vortex_identity.organization_accounts as account
      where account.organization_id = new.organization_id
        and account.organization_account_id = new.organization_account_id
        and account.state = 'active'
    ) then
      raise exception using errcode = '23514',
        message = 'A new role assignment requires an active same-organization account';
    end if;
  elsif new.assignee_kind = 'group' then
    if not exists (
      select 1
      from vortex_access.organization_groups as organization_group
      where organization_group.organization_id = new.organization_id
        and organization_group.group_id = new.group_id
        and organization_group.state = 'active'
    ) then
      raise exception using errcode = '23514',
        message = 'A new role assignment requires an active same-organization Group';
    end if;
  end if;

  return new;
end
$$;

alter function vortex_access.validate_organization_role_assignment_insert() owner to vortex_owner;

REVOKE ALL ON FUNCTION vortex_access.validate_organization_role_assignment_insert() FROM PUBLIC;

grant execute on function vortex_access.validate_organization_role_assignment_insert() to postgres;
