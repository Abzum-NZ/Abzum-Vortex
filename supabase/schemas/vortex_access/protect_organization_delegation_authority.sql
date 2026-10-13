CREATE OR REPLACE FUNCTION vortex_access.protect_organization_delegation_authority() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
declare
  permissions_changed boolean;
begin
  if tg_op = 'DELETE' then
    raise exception using errcode = '23514',
      message = 'Organization delegation authorities cannot be deleted';
  end if;

  if old.revision = 9007199254740991 then
    raise exception using errcode = '22003',
      message = 'Organization delegation authority revision is exhausted';
  end if;

  if old.state = 'revoked'
    or new.organization_id is distinct from old.organization_id
    or new.delegation_authority_id is distinct from
      old.delegation_authority_id
    or new.holder_kind is distinct from old.holder_kind
    or new.organization_account_id is distinct from old.organization_account_id
    or new.group_id is distinct from old.group_id
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
      message = 'Organization delegation authority identity or evidence is immutable';
  end if;

  permissions_changed := new.bounded_permissions is distinct from
    old.bounded_permissions;

  if new.state = 'revoked' then
    if new.revoked_at is null
      or new.revoked_at < old.changed_at
      or new.scope_kind is distinct from old.scope_kind
      or permissions_changed then
      raise exception using errcode = '23514',
        message = 'Delegation revocation cannot alter scope or predate current evidence';
    end if;
    return new;
  end if;

  if new.state <> 'live'
    or (
      new.scope_kind is not distinct from old.scope_kind
      and not permissions_changed
    ) then
    raise exception using errcode = '23514',
      message = 'Delegation scope replacement must replace one exact whole scope';
  end if;

  return new;
end
$$;

ALTER FUNCTION vortex_access.protect_organization_delegation_authority() OWNER TO postgres;

REVOKE ALL ON FUNCTION vortex_access.protect_organization_delegation_authority() FROM PUBLIC;
