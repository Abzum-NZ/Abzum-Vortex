CREATE FUNCTION vortex_identity.protect_organization_invitation() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
begin
  if new.invitation_id is distinct from old.invitation_id
    or new.organization_id is distinct from old.organization_id
    or new.invited_email is distinct from old.invited_email
    or new.token_fingerprint is distinct from old.token_fingerprint
    or new.invited_by_organization_account_id is distinct from old.invited_by_organization_account_id
    or new.created_at is distinct from old.created_at
    or new.invited_at is distinct from old.invited_at
    or new.expires_at is distinct from old.expires_at then
    raise exception using errcode = '23514', message = 'Invitation identity and scope are permanent';
  end if;

  if old.accepted_at is not null or old.revoked_at is not null then
    raise exception using errcode = '23514', message = 'A completed invitation cannot change';
  end if;

  if new.revision <> old.revision + 1
    or new.revision > 9007199254740991
    or new.changed_at < old.changed_at then
    raise exception using errcode = '40001', message = 'Invitation revision is stale or invalid';
  end if;

  return new;
end
$$;

ALTER FUNCTION vortex_identity.protect_organization_invitation() OWNER TO postgres;

REVOKE ALL ON FUNCTION vortex_identity.protect_organization_invitation() FROM PUBLIC;
