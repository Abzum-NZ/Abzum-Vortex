CREATE FUNCTION vortex_context.identity_authority_id(required boolean DEFAULT false) RETURNS uuid
    LANGUAGE plpgsql STABLE
    SET search_path TO ''
    AS $$
declare
  value text;
begin
  value := vortex_context.current_context() ->> 'identityAuthorityId';
  if required and value is null then
    raise exception using errcode = '55000', message = 'Vortex Identity Authority context is required';
  end if;
  return value::uuid;
end
$$;


ALTER FUNCTION vortex_context.identity_authority_id(required boolean) OWNER TO postgres;

COMMENT ON FUNCTION vortex_context.identity_authority_id(required boolean) IS 'Returns the trusted Identity Authority for human/federated context, or fails when required and absent.';

REVOKE ALL ON FUNCTION vortex_context.identity_authority_id(required boolean) FROM PUBLIC;
GRANT ALL ON FUNCTION vortex_context.identity_authority_id(required boolean) TO vortex_request;
