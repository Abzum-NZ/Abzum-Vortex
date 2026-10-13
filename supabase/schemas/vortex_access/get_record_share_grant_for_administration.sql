CREATE FUNCTION vortex_access.get_record_share_grant_for_administration(p_grant_id uuid) RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  context_value jsonb;
  context_organization_id uuid;
begin
  if p_grant_id is null or p_grant_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using errcode = '22023',
      message = 'Record-share grant read is invalid';
  end if;
  context_value := vortex_access.validated_human_request_context();
  context_organization_id := (context_value ->> 'organizationId')::uuid;
  if not exists (
    select 1
    from vortex_access.record_share_grants as grants
    where grants.grant_id = p_grant_id
      and (grants.source_organization_id = context_organization_id
        or grants.recipient_organization_id = context_organization_id)
  ) then
    raise exception using errcode = '42501',
      message = 'Record-share grant read is unavailable';
  end if;
  return vortex_access.record_share_grant_json_internal(p_grant_id);
end
$$;

alter function vortex_access.get_record_share_grant_for_administration(p_grant_id uuid) owner to vortex_owner;

COMMENT ON FUNCTION vortex_access.get_record_share_grant_for_administration(p_grant_id uuid) IS 'Fixed protected read of one record-share grant proposal for its source or recipient organisation.';

REVOKE ALL ON FUNCTION vortex_access.get_record_share_grant_for_administration(p_grant_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION vortex_access.get_record_share_grant_for_administration(p_grant_id uuid) TO vortex_request;

grant execute on function vortex_access.get_record_share_grant_for_administration(p_grant_id uuid) to postgres;
