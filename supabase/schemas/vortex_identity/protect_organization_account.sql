CREATE FUNCTION vortex_identity.protect_organization_account() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
begin
  if new.organization_account_id is distinct from old.organization_account_id
    or new.organization_id is distinct from old.organization_id
    or new.identity_id is distinct from old.identity_id
    or new.activated_at < old.activated_at then
    raise exception using errcode = '23514', message = 'Organisation-account identity and scope are permanent';
  end if;

  if old.state = 'deleted' then
    raise exception using errcode = '23514', message = 'A deleted organisation account is permanent';
  end if;

  if old.state = 'closing' and new.state not in ('closing', 'deleted') then
    raise exception using errcode = '23514', message = 'A closing organisation account can only be deleted';
  end if;

  if (old.closing_at is not null and new.closing_at is distinct from old.closing_at)
    or (old.deleted_at is not null and new.deleted_at is distinct from old.deleted_at) then
    raise exception using errcode = '23514', message = 'Organisation-account closing evidence is permanent';
  end if;

  if new.revision <> old.revision + 1
    or new.revision > 9007199254740991
    or new.changed_at < old.changed_at
    or new.state_changed_at < old.state_changed_at then
    raise exception using errcode = '40001', message = 'Organisation-account revision is stale or invalid';
  end if;

  return new;
end
$$;

ALTER FUNCTION vortex_identity.protect_organization_account() OWNER TO postgres;

REVOKE ALL ON FUNCTION vortex_identity.protect_organization_account() FROM PUBLIC;
