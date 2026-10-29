create or replace function vortex_platform.peek_flow_continuation(
  p_token_hash text, p_organization_id uuid, p_application_root_id uuid,
  p_identity_id uuid, p_flow_id uuid
)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $function$
declare
  held record;
begin
  if p_token_hash is null or p_token_hash !~ '^[a-f0-9]{64}$'
    or not vortex_platform.is_non_nil_uuid(p_organization_id::text)
    or not vortex_platform.is_non_nil_uuid(p_application_root_id::text)
    or not vortex_platform.is_non_nil_uuid(p_identity_id::text)
    or not vortex_platform.is_non_nil_uuid(p_flow_id::text) then
    return pg_catalog.jsonb_build_object('kind', 'unavailable');
  end if;
  select continuation.run_id, continuation.state, continuation.elapsed_milliseconds, continuation.release_key into held
  from vortex_platform.flow_continuations as continuation
  where continuation.token_hash = p_token_hash
    and continuation.organization_id = p_organization_id
    and continuation.application_root_id = p_application_root_id
    and continuation.identity_id = p_identity_id
    and continuation.flow_id = p_flow_id
    and continuation.expires_at > pg_catalog.statement_timestamp();
  if not found then return pg_catalog.jsonb_build_object('kind', 'unavailable'); end if;
  return pg_catalog.jsonb_build_object(
    'kind', 'available', 'runId', held.run_id, 'state', held.state,
    'elapsedMilliseconds', held.elapsed_milliseconds, 'releaseKey', held.release_key
  );
end
$function$;

alter function vortex_platform.peek_flow_continuation(text, uuid, uuid, uuid, uuid) owner to vortex_owner;
revoke all on function vortex_platform.peek_flow_continuation(text, uuid, uuid, uuid, uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_platform.peek_flow_continuation(text, uuid, uuid, uuid, uuid)
  to vortex_runtime, postgres;
comment on function vortex_platform.peek_flow_continuation(text, uuid, uuid, uuid, uuid) is
  'Reads the caller-bound continuation for path selection without consuming it.';
