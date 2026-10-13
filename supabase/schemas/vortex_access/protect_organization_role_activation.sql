CREATE OR REPLACE FUNCTION vortex_access.protect_organization_role_activation() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
begin
  if tg_op = 'DELETE' then
    raise exception using errcode = '23514',
      message = 'Organization role activations cannot be deleted';
  end if;

  if old.revision = 9007199254740991 then
    raise exception using errcode = '22003',
      message = 'Organization role activation revision is exhausted';
  end if;

  if old.state = 'revoked'
    or new.state <> 'revoked'
    or new.revoked_at is null
    or new.revoked_at < old.changed_at
    or new.organization_id is distinct from old.organization_id
    or new.role_activation_id is distinct from old.role_activation_id
    or new.organization_account_id is distinct from old.organization_account_id
    or new.role_id is distinct from old.role_id
    or new.historical_role_revision is distinct from old.historical_role_revision
    or new.authority_continuity_revision is distinct from
      old.authority_continuity_revision
    or new.policy_continuity_revision is distinct from
      old.policy_continuity_revision
    or new.activation_policy_id is distinct from old.activation_policy_id
    or new.activation_policy_revision is distinct from old.activation_policy_revision
    or new.eligibility_source_kind is distinct from old.eligibility_source_kind
    or new.role_assignment_id is distinct from old.role_assignment_id
    or new.role_assignment_revision is distinct from old.role_assignment_revision
    or new.membership_id is distinct from old.membership_id
    or new.membership_revision is distinct from old.membership_revision
    or new.activated_by is distinct from old.activated_by
    or new.activated_at is distinct from old.activated_at
    or new.expires_at is distinct from old.expires_at
    or new.activation_correlation_id is distinct from old.activation_correlation_id
    or new.revision <> old.revision + 1
    or new.changed_at < old.changed_at
    or (new.changed_by, new.changed_at, new.change_correlation_id)
      is not distinct from
      (old.changed_by, old.changed_at, old.change_correlation_id) then
    raise exception using errcode = '23514',
      message = 'Organization role activation transition is invalid';
  end if;

  return new;
end
$$;

ALTER FUNCTION vortex_access.protect_organization_role_activation() OWNER TO postgres;

REVOKE ALL ON FUNCTION vortex_access.protect_organization_role_activation() FROM PUBLIC;
