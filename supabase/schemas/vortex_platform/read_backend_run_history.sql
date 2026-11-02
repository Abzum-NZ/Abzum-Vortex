create or replace function vortex_platform.read_backend_run_history(
  p_application_root_id uuid,
  p_page_size integer,
  p_cursor_created_at timestamptz,
  p_cursor_run_id uuid,
  p_direction text
)
returns table (
  backend_run_id uuid,
  flow_id uuid,
  origin_kind text,
  source_key text,
  state text,
  failure_code text,
  created_at timestamptz,
  finished_at timestamptz,
  created_at_cursor text
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  checked_context jsonb;
begin
  -- The caller must be a human whose organisation grants definition-draft management, the
  -- authority Studio uses to open an application; the organisation comes from that context.
  checked_context := vortex_definition.validated_builder_read_context_internal();
  if checked_context ->> 'callerKind' is distinct from 'human' then
    raise exception using errcode = '42501', message = 'Back-end run history is unavailable';
  end if;
  if p_application_root_id is null
    or not vortex_platform.is_non_nil_uuid(p_application_root_id::text)
    or p_page_size is null or p_page_size not between 1 and 200
    or p_direction is null or p_direction not in ('older', 'newer')
    or (p_cursor_created_at is null) is distinct from (p_cursor_run_id is null)
    or (p_direction = 'newer' and p_cursor_created_at is null) then
    raise exception using errcode = '22023', message = 'Back-end run history request is invalid';
  end if;
  -- Newest first, keyset on (created_at, backend_run_id). One row more than the page is read so
  -- the caller knows whether a further page exists; the caller drops it. Outputs can hold record
  -- values, so the history never returns them. The cursor text keeps the microseconds a client
  -- timestamp would lose.
  if p_direction = 'newer' then
    return query
    select page.backend_run_id, page.flow_id, page.origin_kind, page.source_key, page.state,
      page.failure_code, page.created_at, page.finished_at, page.created_at::text
    from (
      select run.backend_run_id, run.flow_id, run.origin_kind, run.source_key, run.state,
        run.failure_code, run.created_at, run.finished_at
      from vortex_platform.backend_runs as run
      where run.organization_id = (checked_context ->> 'organizationId')::uuid
        and run.application_root_id = p_application_root_id
        and (run.created_at, run.backend_run_id) > (p_cursor_created_at, p_cursor_run_id)
      order by run.created_at asc, run.backend_run_id asc
      limit p_page_size + 1
    ) as page
    order by page.created_at desc, page.backend_run_id desc;
  elsif p_cursor_created_at is null then
    return query
    select run.backend_run_id, run.flow_id, run.origin_kind, run.source_key, run.state,
      run.failure_code, run.created_at, run.finished_at, run.created_at::text
    from vortex_platform.backend_runs as run
    where run.organization_id = (checked_context ->> 'organizationId')::uuid
      and run.application_root_id = p_application_root_id
    order by run.created_at desc, run.backend_run_id desc
    limit p_page_size + 1;
  else
    return query
    select run.backend_run_id, run.flow_id, run.origin_kind, run.source_key, run.state,
      run.failure_code, run.created_at, run.finished_at, run.created_at::text
    from vortex_platform.backend_runs as run
    where run.organization_id = (checked_context ->> 'organizationId')::uuid
      and run.application_root_id = p_application_root_id
      and (run.created_at, run.backend_run_id) < (p_cursor_created_at, p_cursor_run_id)
    order by run.created_at desc, run.backend_run_id desc
    limit p_page_size + 1;
  end if;
end
$function$;
alter function vortex_platform.read_backend_run_history(uuid, integer, timestamptz, uuid, text) owner to vortex_owner;

revoke all on function vortex_platform.read_backend_run_history(uuid, integer, timestamptz, uuid, text)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_platform.read_backend_run_history(uuid, integer, timestamptz, uuid, text)
  to vortex_request;

comment on function vortex_platform.read_backend_run_history(uuid, integer, timestamptz, uuid, text) is
  'Lists one keyset page, newest first, of the back-end runs of one application (flow, origin, source, state, failure code, times) without their outputs, with one row more than the page size so the caller sees whether a further page exists; it requires definition-draft management in the own request context of the caller.';
