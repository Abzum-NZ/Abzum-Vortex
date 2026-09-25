create or replace function vortex_workflow.consume_flow_continuation(
  p_token_hash text,
  p_organization_id uuid,
  p_identity_id uuid,
  p_flow_id uuid,
  p_release_key text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  claimed record;
begin
  if p_token_hash is null or p_token_hash !~ '^[a-f0-9]{64}$'
    or not vortex_context.is_non_nil_uuid(p_organization_id::text)
    or not vortex_context.is_non_nil_uuid(p_identity_id::text)
    or not vortex_context.is_non_nil_uuid(p_flow_id::text)
    or p_release_key is null then
    return pg_catalog.jsonb_build_object('kind', 'unavailable');
  end if;

  -- One statement both checks every binding and marks the row used, so two concurrent resumes can
  -- never both succeed, and an unknown, expired, replayed, foreign or wrong-release token is one
  -- neutral result.
  update vortex_workflow.flow_continuations as continuation
  set consumed_at = pg_catalog.statement_timestamp()
  where continuation.token_hash = p_token_hash
    and continuation.organization_id = p_organization_id
    and continuation.identity_id = p_identity_id
    and continuation.flow_id = p_flow_id
    and continuation.release_key = p_release_key
    and continuation.consumed_at is null
    and continuation.expires_at > pg_catalog.statement_timestamp()
  returning continuation.run_id, continuation.state, continuation.elapsed_milliseconds
  into claimed;

  if not found then
    return pg_catalog.jsonb_build_object('kind', 'unavailable');
  end if;

  return pg_catalog.jsonb_build_object(
    'kind', 'available',
    'runId', claimed.run_id,
    'state', claimed.state,
    'elapsedMilliseconds', claimed.elapsed_milliseconds
  );
end
$function$;

revoke all on function vortex_workflow.consume_flow_continuation(
  text, uuid, uuid, uuid, text
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_workflow.consume_flow_continuation(
  text, uuid, uuid, uuid, text
) to vortex_runtime;

comment on function vortex_workflow.consume_flow_continuation(
  text, uuid, uuid, uuid, text
) is
  'Private flow-continuation consume: returns the stored run state once, and only to the exact initiator, organisation and flow release it was issued for while it has not expired; every other case is one neutral unavailable result.';
