create or replace function vortex_platform.complete_flow_continuation(
  p_token_hash text, p_command_id uuid, p_child_token_hash text, p_child_state jsonb,
  p_elapsed_milliseconds integer, p_lifetime_seconds integer, p_replay_payload text
)
returns jsonb
language plpgsql volatile security definer set search_path = ''
as $function$
declare
  context_value jsonb := vortex_access.validated_human_request_context();
  parent record;
  expiry timestamptz;
begin
  if p_token_hash is null or p_token_hash !~ '^[a-f0-9]{64}$'
    or p_child_token_hash is null or p_child_token_hash !~ '^[a-f0-9]{64}$'
    or not vortex_platform.is_non_nil_uuid(p_command_id::text)
    or p_replay_payload is null or pg_catalog.length(p_replay_payload) not between 1 and 1000000 then
    raise exception using errcode = '22023', message = 'Flow continuation replay is invalid';
  end if;
  select continuation.* into parent
  from vortex_platform.flow_continuations as continuation
  where continuation.token_hash = p_token_hash
    and continuation.organization_id = (context_value ->> 'organizationId')::uuid
    and continuation.application_root_id = (context_value ->> 'applicationRootId')::uuid
    and continuation.identity_id = (context_value ->> 'identityId')::uuid
    and continuation.consumed_command_id = p_command_id
    and continuation.consumed_at is not null
    and continuation.expires_at > pg_catalog.statement_timestamp()
  for update;
  if not found then return pg_catalog.jsonb_build_object('status', 'unavailable'); end if;
  if parent.replay_payload is not null then
    return pg_catalog.jsonb_build_object(
      'status', 'replay', 'payload', parent.replay_payload,
      'expiresAt', (select child.expires_at from vortex_platform.flow_continuations as child
        where child.token_hash = parent.child_token_hash)
    );
  end if;
  expiry := vortex_platform.issue_flow_continuation(
    p_child_token_hash, parent.run_id, parent.organization_id, parent.application_root_id, parent.identity_id,
    parent.flow_id, parent.release_key, p_child_state, p_elapsed_milliseconds, p_lifetime_seconds
  );
  update vortex_platform.flow_continuations as continuation
  set replay_payload = p_replay_payload, child_token_hash = p_child_token_hash
  where continuation.token_hash = p_token_hash;
  return pg_catalog.jsonb_build_object('status', 'recorded', 'expiresAt', expiry);
end
$function$;

alter function vortex_platform.complete_flow_continuation(text, uuid, text, jsonb, integer, integer, text) owner to vortex_owner;
revoke all on function vortex_platform.complete_flow_continuation(text, uuid, text, jsonb, integer, integer, text)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_platform.complete_flow_continuation(text, uuid, text, jsonb, integer, integer, text)
  to vortex_request, postgres;
comment on function vortex_platform.complete_flow_continuation(text, uuid, text, jsonb, integer, integer, text) is
  'Issues one child continuation and records its sealed reply atomically on the consumed parent.';
