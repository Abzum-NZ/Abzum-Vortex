create or replace function vortex_platform.peek_flow_continuation(
  p_token_hash text, p_organization_id uuid, p_identity_id uuid, p_flow_id uuid, p_release_key text
)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $function$
declare
  held record;
begin
  if p_token_hash is null or p_token_hash !~ '^[a-f0-9]{64}$'
    or not vortex_platform.is_non_nil_uuid(p_organization_id::text)
    or not vortex_platform.is_non_nil_uuid(p_identity_id::text)
    or not vortex_platform.is_non_nil_uuid(p_flow_id::text)
    or p_release_key is null then
    return pg_catalog.jsonb_build_object('kind', 'unavailable');
  end if;
  select continuation.run_id, continuation.state, continuation.elapsed_milliseconds into held
  from vortex_platform.flow_continuations as continuation
  where continuation.token_hash = p_token_hash
    and continuation.organization_id = p_organization_id
    and continuation.identity_id = p_identity_id
    and continuation.flow_id = p_flow_id
    and continuation.release_key = p_release_key
    and continuation.expires_at > pg_catalog.statement_timestamp();
  if not found then return pg_catalog.jsonb_build_object('kind', 'unavailable'); end if;
  return pg_catalog.jsonb_build_object(
    'kind', 'available', 'runId', held.run_id, 'state', held.state,
    'elapsedMilliseconds', held.elapsed_milliseconds
  );
end
$function$;

alter function vortex_platform.peek_flow_continuation(text, uuid, uuid, uuid, text) owner to vortex_owner;
revoke all on function vortex_platform.peek_flow_continuation(text, uuid, uuid, uuid, text)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_platform.peek_flow_continuation(text, uuid, uuid, uuid, text)
  to vortex_runtime, postgres;
comment on function vortex_platform.peek_flow_continuation(text, uuid, uuid, uuid, text) is
  'Reads the caller-bound continuation for path selection without consuming it.';
