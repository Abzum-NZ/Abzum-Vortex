CREATE FUNCTION vortex_access.validated_human_request_context() RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  checked jsonb;
begin
  checked := vortex_identity.validated_human_account_context();

  if not exists (
    select 1
    from vortex_access.organization_access_versions as version
    where version.organization_id = (checked ->> 'organizationId')::uuid
      and version.current_version = (checked ->> 'accessVersion')::bigint
  ) then
    raise exception using errcode = '42501', message = 'Request access version is stale or unavailable';
  end if;

  return checked;
end
$$;

ALTER FUNCTION vortex_access.validated_human_request_context() OWNER TO postgres;

COMMENT ON FUNCTION vortex_access.validated_human_request_context() IS 'Fails closed unless the current human account and Access version are still live.';

REVOKE ALL ON FUNCTION vortex_access.validated_human_request_context() FROM PUBLIC;
GRANT ALL ON FUNCTION vortex_access.validated_human_request_context() TO vortex_request;
GRANT ALL ON FUNCTION vortex_access.validated_human_request_context() TO vortex_owner;
GRANT ALL ON FUNCTION vortex_access.validated_human_request_context() TO vortex_record_adapter;
GRANT ALL ON FUNCTION vortex_access.validated_human_request_context() TO vortex_owner;
GRANT ALL ON FUNCTION vortex_access.validated_human_request_context() TO vortex_owner;
GRANT ALL ON FUNCTION vortex_access.validated_human_request_context() TO vortex_owner;
GRANT ALL ON FUNCTION vortex_access.validated_human_request_context() TO vortex_owner;
GRANT ALL ON FUNCTION vortex_access.validated_human_request_context() TO vortex_owner;
