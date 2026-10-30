create or replace function vortex_platform.record_refused_backend_run(
  p_organization_id uuid,
  p_application_root_id uuid,
  p_actor_id uuid,
  p_origin_kind text,
  p_source_key text,
  p_failure_code text
)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $function$
begin
  if p_organization_id is null or not vortex_platform.is_non_nil_uuid(p_organization_id::text)
    or p_application_root_id is null
    or not vortex_platform.is_non_nil_uuid(p_application_root_id::text)
    or p_actor_id is null or not vortex_platform.is_non_nil_uuid(p_actor_id::text)
    or p_origin_kind is null or p_origin_kind not in ('backend_run', 'event')
    or p_source_key is null or pg_catalog.length(p_source_key) not between 1 and 200
    or p_failure_code is null or pg_catalog.length(p_failure_code) not between 1 and 100 then
    raise exception using errcode = '22023', message = 'Back-end run refusal is invalid';
  end if;
  insert into vortex_platform.backend_runs (
    organization_id, application_root_id, flow_id, actor_id, origin_kind, source_key, mode,
    inputs, state, failure_code, finished_at
  ) values (
    p_organization_id, p_application_root_id, null, p_actor_id, p_origin_kind, p_source_key,
    'start', '{}'::jsonb, 'refused', p_failure_code, pg_catalog.statement_timestamp()
  )
  on conflict (organization_id, origin_kind, source_key, flow_id) do nothing;
  return found;
end
$function$;
alter function vortex_platform.record_refused_backend_run(uuid, uuid, uuid, text, text, text) owner to vortex_owner;

revoke all on function vortex_platform.record_refused_backend_run(uuid, uuid, uuid, text, text, text)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_platform.record_refused_backend_run(uuid, uuid, uuid, text, text, text)
  to vortex_runtime;

comment on function vortex_platform.record_refused_backend_run(uuid, uuid, uuid, text, text, text) is
  'Records, once per origin and source, that an occurrence ran nothing because its account could not act, with the named reason; no flow is named because the account''s scope is what lists them.';
