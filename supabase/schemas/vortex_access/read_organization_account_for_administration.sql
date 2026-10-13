CREATE FUNCTION vortex_access.read_organization_account_for_administration(p_organization_account_id uuid) RETURNS TABLE(organization_id uuid, outcome text, account_summary jsonb, access_version bigint)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  scope record;
  projected record;
begin
  select authorized.* into strict scope
  from vortex_access.organization_accounts_administration_scope() as authorized;
  select result.* into strict projected
  from vortex_identity.read_organization_account_for_administration_internal(
    scope.organization_id, p_organization_account_id
  ) as result;
  return query select scope.organization_id, projected.outcome,
    projected.account_summary, scope.access_version;
end
$$;

ALTER FUNCTION vortex_access.read_organization_account_for_administration(p_organization_account_id uuid) OWNER TO postgres;

COMMENT ON FUNCTION vortex_access.read_organization_account_for_administration(p_organization_account_id uuid) IS 'Protected exact account detail under the fixed accounts.read decision.';

REVOKE ALL ON FUNCTION vortex_access.read_organization_account_for_administration(p_organization_account_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION vortex_access.read_organization_account_for_administration(p_organization_account_id uuid) TO vortex_request;
