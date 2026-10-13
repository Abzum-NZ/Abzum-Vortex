CREATE FUNCTION vortex_access.project_organization_role_activation_summary(p_organization_id uuid, p_role_activation_id uuid) RETURNS jsonb
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO ''
    AS $$
  select pg_catalog.jsonb_build_object(
    'roleActivationId', activation.role_activation_id,
    'beneficiary', pg_catalog.jsonb_build_object(
      'organizationAccountId', activation.organization_account_id,
      'displayName', account.display_name),
    'role', pg_catalog.jsonb_build_object(
      'roleId', activation.role_id, 'key', revision.role_key,
      'label', revision.label, 'lifecycle', revision.lifecycle),
    'revision', activation.revision,
    'historicalRoleRevision', activation.historical_role_revision,
    'eligibilitySourceKind', activation.eligibility_source_kind,
    'activatedAt', activation.activated_at, 'expiresAt', activation.expires_at,
    'state', activation.state,
    'temporalState', case when activation.state = 'revoked' then 'revoked'
      when activation.expires_at <= pg_catalog.clock_timestamp() then 'expired'
      else 'active' end)
  from vortex_access.organization_role_activations as activation
  join vortex_identity.organization_accounts as account
    on account.organization_id = activation.organization_id
    and account.organization_account_id = activation.organization_account_id
  join vortex_access.organization_roles as role
    on role.organization_id = activation.organization_id
    and role.role_id = activation.role_id
  join vortex_access.organization_role_revisions as revision
    on revision.organization_id = role.organization_id
    and revision.role_id = role.role_id and revision.revision = role.live_revision
  where activation.organization_id = p_organization_id
    and activation.role_activation_id = p_role_activation_id
$$;

ALTER FUNCTION vortex_access.project_organization_role_activation_summary(p_organization_id uuid, p_role_activation_id uuid) OWNER TO postgres;

REVOKE ALL ON FUNCTION vortex_access.project_organization_role_activation_summary(p_organization_id uuid, p_role_activation_id uuid) FROM PUBLIC;
