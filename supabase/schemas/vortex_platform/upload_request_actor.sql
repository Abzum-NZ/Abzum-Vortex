CREATE OR REPLACE FUNCTION vortex_platform.upload_request_actor(p_context jsonb) RETURNS jsonb
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

alter function vortex_platform.upload_request_actor(p_context jsonb) owner to vortex_owner;

REVOKE ALL ON FUNCTION vortex_platform.upload_request_actor(p_context jsonb) FROM PUBLIC;
GRANT ALL ON FUNCTION vortex_platform.upload_request_actor(p_context jsonb) TO vortex_owner;

grant execute on function vortex_platform.upload_request_actor(p_context jsonb) to postgres;
