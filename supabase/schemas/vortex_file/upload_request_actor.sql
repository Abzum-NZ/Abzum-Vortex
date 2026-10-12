CREATE FUNCTION vortex_file.upload_request_actor(p_context jsonb) RETURNS jsonb
    LANGUAGE sql IMMUTABLE
    SET search_path TO ''
    AS $$
  select case p_context ->> 'callerKind'
    when 'human' then pg_catalog.jsonb_build_object(
      'kind', 'human',
      'organizationAccountId', p_context ->> 'organizationAccountId',
      'identityId', p_context ->> 'identityId'
    )
    when 'system' then pg_catalog.jsonb_build_object(
      'kind', 'system',
      'systemActorId', p_context ->> 'systemActorId'
    )
  end
$$;


ALTER FUNCTION vortex_file.upload_request_actor(p_context jsonb) OWNER TO postgres;

REVOKE ALL ON FUNCTION vortex_file.upload_request_actor(p_context jsonb) FROM PUBLIC;
GRANT ALL ON FUNCTION vortex_file.upload_request_actor(p_context jsonb) TO vortex_file_owner;
