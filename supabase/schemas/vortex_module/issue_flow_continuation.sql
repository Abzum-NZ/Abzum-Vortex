create or replace function vortex_module.issue_flow_continuation(
  p_token_hash text,
  p_run_id uuid,
  p_organization_id uuid,
  p_identity_id uuid,
  p_flow_id uuid,
  p_release_key text,
  p_state jsonb,
  p_elapsed_milliseconds integer,
  p_lifetime_seconds integer
)
returns timestamptz
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  expiry timestamptz;
begin
  if p_token_hash is null or p_token_hash !~ '^[a-f0-9]{64}$'
    or not vortex_context.is_non_nil_uuid(p_run_id::text)
    or not vortex_context.is_non_nil_uuid(p_organization_id::text)
    or not vortex_context.is_non_nil_uuid(p_identity_id::text)
    or not vortex_context.is_non_nil_uuid(p_flow_id::text)
    or p_release_key is null
    or pg_catalog.length(p_release_key) not between 1 and 200
    or p_state is null
    or pg_catalog.jsonb_typeof(p_state) <> 'object'
    or pg_catalog.pg_column_size(p_state) > 262144
    or p_elapsed_milliseconds is null
    or p_elapsed_milliseconds not between 0 and 3600000
    or p_lifetime_seconds is null
    or p_lifetime_seconds not between 60 and 3600 then
    raise exception using errcode = '22023', message = 'Flow continuation is invalid';
  end if;

  -- Expired continuations are useless; remove a bounded few on every issue so the table never
  -- needs a separate sweeper.
  delete from vortex_module.flow_continuations as stale
  where stale.ctid in (
    select candidate.ctid
    from vortex_module.flow_continuations as candidate
    where candidate.expires_at < pg_catalog.statement_timestamp() - interval '1 day'
    limit 100
  );

  expiry := pg_catalog.statement_timestamp() + pg_catalog.make_interval(secs => p_lifetime_seconds);

  insert into vortex_module.flow_continuations (
    token_hash, run_id, organization_id, identity_id, flow_id, release_key, state,
    elapsed_milliseconds, created_at, expires_at
  ) values (
    p_token_hash, p_run_id, p_organization_id, p_identity_id, p_flow_id, p_release_key, p_state,
    p_elapsed_milliseconds, pg_catalog.statement_timestamp(), expiry
  );

  return expiry;
end
$function$;

revoke all on function vortex_module.issue_flow_continuation(
  text, uuid, uuid, uuid, uuid, text, jsonb, integer, integer
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_module_owner, vortex_record_adapter;
grant execute on function vortex_module.issue_flow_continuation(
  text, uuid, uuid, uuid, uuid, text, jsonb, integer, integer
) to vortex_runtime;

comment on function vortex_module.issue_flow_continuation(
  text, uuid, uuid, uuid, uuid, text, jsonb, integer, integer
) is
  'Private flow-continuation issue: stores the suspended state of one server-driven flow run bound to its run, initiator, organisation and exact flow release, expiring, under the hash of a server-generated token.';
