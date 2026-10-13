CREATE FUNCTION vortex_access.list_organization_accounts_for_administration(p_after_organization_account_id uuid, p_page_size integer) RETURNS TABLE(organization_id uuid, accounts jsonb, next_after_organization_account_id uuid, access_version bigint)
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
  from vortex_identity.list_organization_accounts_for_administration_internal(
    scope.organization_id, p_after_organization_account_id, p_page_size
  ) as result;
  return query select scope.organization_id, projected.accounts,
    projected.next_after_organization_account_id, scope.access_version;
end
$$;

alter function vortex_access.list_organization_accounts_for_administration(p_after_organization_account_id uuid, p_page_size integer) owner to vortex_owner;

COMMENT ON FUNCTION vortex_access.list_organization_accounts_for_administration(p_after_organization_account_id uuid, p_page_size integer) IS 'Protected bounded local-ID account page under the fixed accounts.read decision.';

REVOKE ALL ON FUNCTION vortex_access.list_organization_accounts_for_administration(p_after_organization_account_id uuid, p_page_size integer) FROM PUBLIC;
GRANT ALL ON FUNCTION vortex_access.list_organization_accounts_for_administration(p_after_organization_account_id uuid, p_page_size integer) TO vortex_request;

grant execute on function vortex_access.list_organization_accounts_for_administration(p_after_organization_account_id uuid, p_page_size integer) to postgres;
