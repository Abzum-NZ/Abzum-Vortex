CREATE FUNCTION vortex_access.list_organization_invitations_for_administration(p_after_invitation_id uuid, p_page_size integer) RETURNS TABLE(organization_id uuid, invitations jsonb, next_after_invitation_id uuid, access_version bigint)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  scope record;
  projected record;
begin
  select authorized.* into strict scope
  from vortex_access.organization_invitations_administration_scope() as authorized;
  select result.* into strict projected
  from vortex_identity.list_organization_invitations_for_administration_internal(
    scope.organization_id, p_after_invitation_id, p_page_size
  ) as result;
  return query select scope.organization_id, projected.invitations,
    projected.next_after_invitation_id, scope.access_version;
end
$$;

alter function vortex_access.list_organization_invitations_for_administration(p_after_invitation_id uuid, p_page_size integer) owner to vortex_owner;

COMMENT ON FUNCTION vortex_access.list_organization_invitations_for_administration(p_after_invitation_id uuid, p_page_size integer) IS 'Protected bounded local-ID invitation page under the fixed invitations.read decision.';

REVOKE ALL ON FUNCTION vortex_access.list_organization_invitations_for_administration(p_after_invitation_id uuid, p_page_size integer) FROM PUBLIC;
GRANT ALL ON FUNCTION vortex_access.list_organization_invitations_for_administration(p_after_invitation_id uuid, p_page_size integer) TO vortex_request;

grant execute on function vortex_access.list_organization_invitations_for_administration(p_after_invitation_id uuid, p_page_size integer) to postgres;
