CREATE FUNCTION vortex_access.change_organization_account_state(p_organization_account_id uuid, p_expected_revision bigint, p_state text) RETURNS TABLE(organization_account_id uuid, organization_id uuid, identity_id uuid, display_name text, state text, language text, time_zone text, invitation_id uuid, activated_at timestamp with time zone, suspended_at timestamp with time zone, closed_at timestamp with time zone, changed_at timestamp with time zone, state_changed_at timestamp with time zone, state_changed_by uuid, state_change_correlation_id uuid, revision bigint, access_version bigint)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  changed record;
  checked jsonb;
  target_organization_id uuid;
begin
  checked := vortex_identity.validated_human_account_context();

  select account.organization_id into target_organization_id
  from vortex_identity.organization_accounts as account
  where account.organization_account_id = p_organization_account_id
    and account.organization_id = (checked ->> 'organizationId')::uuid;

  if found then
    -- Access owns the composition and governance lock. The lower-level
    -- Identity writer remains unchanged and has no dependency on Access.
    perform 1
    from vortex_access.organization_access_versions as version
    where version.organization_id = target_organization_id
    for update;
  end if;

  select result.* into strict changed
  from vortex_access.change_account_state_without_stewardship_v1_internal(
      p_organization_account_id, p_expected_revision, p_state
    ) as result;

  perform vortex_access.assert_organization_has_permanent_steward(
    changed.organization_id
  );

  return query select changed.organization_account_id,
    changed.organization_id, changed.identity_id, changed.display_name,
    changed.state, changed.language, changed.time_zone,
    changed.invitation_id, changed.activated_at, changed.suspended_at,
    changed.closed_at, changed.changed_at, changed.state_changed_at,
    changed.state_changed_by, changed.state_change_correlation_id,
    changed.revision, changed.access_version;
end
$$;

alter function vortex_access.change_organization_account_state(p_organization_account_id uuid, p_expected_revision bigint, p_state text) owner to vortex_owner;

COMMENT ON FUNCTION vortex_access.change_organization_account_state(p_organization_account_id uuid, p_expected_revision bigint, p_state text) IS 'Owner-only account lifecycle mutation guarded by the adopted organisation stewardship invariant.';

REVOKE ALL ON FUNCTION vortex_access.change_organization_account_state(p_organization_account_id uuid, p_expected_revision bigint, p_state text) FROM PUBLIC;

grant execute on function vortex_access.change_organization_account_state(p_organization_account_id uuid, p_expected_revision bigint, p_state text) to postgres;
