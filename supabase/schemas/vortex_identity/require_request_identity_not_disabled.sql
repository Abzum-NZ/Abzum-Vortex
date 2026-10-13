CREATE OR REPLACE FUNCTION vortex_identity.require_request_identity_not_disabled() RETURNS void
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  checked jsonb;
begin
  checked := vortex_platform.current_context();
  if checked ->> 'callerKind' is null
    or checked ->> 'callerKind' not in ('human', 'federated')
    or not vortex_platform.is_non_nil_uuid(checked ->> 'identityId')
  then
    raise exception using errcode = '42501', message = 'Identity is unavailable';
  end if;

  perform vortex_identity.require_identity_not_disabled(
    (checked ->> 'identityId')::uuid
  );
end
$$;

alter function vortex_identity.require_request_identity_not_disabled() owner to vortex_owner;

COMMENT ON FUNCTION vortex_identity.require_request_identity_not_disabled() IS 'Request live check: refuses (42501) unless the current context names a human or federated person whose disablement has not completed.';

REVOKE ALL ON FUNCTION vortex_identity.require_request_identity_not_disabled() FROM PUBLIC;
GRANT ALL ON FUNCTION vortex_identity.require_request_identity_not_disabled() TO vortex_request;

grant execute on function vortex_identity.require_request_identity_not_disabled() to postgres;
