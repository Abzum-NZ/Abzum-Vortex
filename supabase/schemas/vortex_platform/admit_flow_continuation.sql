create or replace function vortex_platform.admit_flow_continuation(
  p_token_hash text, p_run_id uuid, p_flow_id uuid, p_release_key text, p_command_id uuid
)
returns jsonb
language plpgsql volatile security definer set search_path = ''
as $function$
declare
  context_value jsonb := vortex_access.validated_human_request_context();
  held record;
begin
  if p_token_hash is null or p_token_hash !~ '^[a-f0-9]{64}$'
    or not vortex_platform.is_non_nil_uuid(p_flow_id::text)
    or not vortex_platform.is_non_nil_uuid(p_run_id::text)
    or not vortex_platform.is_non_nil_uuid(p_command_id::text)
    or p_release_key is null then
    return pg_catalog.jsonb_build_object('status', 'unavailable');
  end if;
  select continuation.consumed_at, continuation.consumed_command_id, continuation.replay_payload,
    continuation.child_token_hash into held
  from vortex_platform.flow_continuations as continuation
  where continuation.token_hash = p_token_hash
    and continuation.run_id = p_run_id
    and continuation.organization_id = (context_value ->> 'organizationId')::uuid
    and continuation.application_root_id = (context_value ->> 'applicationRootId')::uuid
    and continuation.identity_id = (context_value ->> 'identityId')::uuid
    and continuation.flow_id = p_flow_id
    and continuation.release_key = p_release_key
    and continuation.expires_at > pg_catalog.statement_timestamp()
  for update;
  if not found then return pg_catalog.jsonb_build_object('status', 'unavailable'); end if;
  if held.consumed_at is not null then
    return case when held.consumed_command_id = p_command_id
      then pg_catalog.jsonb_build_object(
        'status', 'replay', 'payload', held.replay_payload,
        'expiresAt', (select child.expires_at from vortex_platform.flow_continuations as child
          where child.token_hash = held.child_token_hash)
      )
      else pg_catalog.jsonb_build_object('status', 'already_answered') end;
  end if;
  update vortex_platform.flow_continuations as continuation
  set consumed_at = pg_catalog.statement_timestamp(), consumed_command_id = p_command_id
  where continuation.token_hash = p_token_hash;
  return pg_catalog.jsonb_build_object('status', 'admitted');
end
$function$;

alter function vortex_platform.admit_flow_continuation(text, uuid, uuid, text, uuid) owner to vortex_owner;
revoke all on function vortex_platform.admit_flow_continuation(text, uuid, uuid, text, uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_platform.admit_flow_continuation(text, uuid, uuid, text, uuid)
  to vortex_request, postgres;
comment on function vortex_platform.admit_flow_continuation(text, uuid, uuid, text, uuid) is
  'Consumes an admitted continuation once and permits replay by the same command under current human scope.';
