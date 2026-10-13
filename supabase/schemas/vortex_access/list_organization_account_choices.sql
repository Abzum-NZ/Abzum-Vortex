CREATE FUNCTION vortex_access.list_organization_account_choices(p_search text, p_page_size integer, p_after_sort_key text, p_after_organization_account_id uuid) RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  context_value jsonb;
begin
  context_value := vortex_access.validated_human_request_context();
  return vortex_identity.list_organization_account_choices_internal(
    (context_value ->> 'tenantId')::uuid,
    (context_value ->> 'organizationId')::uuid,
    p_search,
    p_page_size,
    p_after_sort_key,
    p_after_organization_account_id
  );
end
$$;

alter function vortex_access.list_organization_account_choices(p_search text, p_page_size integer, p_after_sort_key text, p_after_organization_account_id uuid) owner to vortex_owner;

COMMENT ON FUNCTION vortex_access.list_organization_account_choices(p_search text, p_page_size integer, p_after_sort_key text, p_after_organization_account_id uuid) IS 'Active accounts in the validated current organisation for an account-reference choice; scope comes only from the validated human request.';

REVOKE ALL ON FUNCTION vortex_access.list_organization_account_choices(p_search text, p_page_size integer, p_after_sort_key text, p_after_organization_account_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION vortex_access.list_organization_account_choices(p_search text, p_page_size integer, p_after_sort_key text, p_after_organization_account_id uuid) TO vortex_request;

grant execute on function vortex_access.list_organization_account_choices(p_search text, p_page_size integer, p_after_sort_key text, p_after_organization_account_id uuid) to postgres;
