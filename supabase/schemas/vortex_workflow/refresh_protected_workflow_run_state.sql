create or replace function vortex_workflow.refresh_protected_workflow_run_state(
  p_run_id uuid,
  p_state text,
  p_refreshed_at timestamptz
)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $function$
begin
  if not vortex_context.is_non_nil_uuid(p_run_id::text)
    or p_state is null
    or p_state not in ('queued', 'running', 'waiting', 'completed', 'cancelled', 'failed')
    or p_refreshed_at is null then
    return false;
  end if;

  update vortex_workflow.protected_workflow_runs as stored
  set run_record = pg_catalog.jsonb_set(
      pg_catalog.jsonb_set(
        pg_catalog.jsonb_set(
          stored.run_record,
          '{executionReference,lastKnownState}',
          pg_catalog.to_jsonb(p_state),
          false
        ),
        '{executionReference,lastRefreshedAt}',
        pg_catalog.to_jsonb(
          pg_catalog.to_char(
            p_refreshed_at at time zone 'UTC',
            'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
          )
        ),
        false
      ),
      '{authority,state}',
      pg_catalog.to_jsonb(case p_state
        when 'completed' then 'completed'
        when 'cancelled' then 'cancelled'
        when 'failed' then 'refused'
        when 'waiting' then 'waiting'
        else 'running'
      end),
      false
    ),
    updated_at = pg_catalog.statement_timestamp()
  where stored.run_id = p_run_id
    and (stored.run_record #>> '{executionReference,lastRefreshedAt}')::timestamptz <= p_refreshed_at;

  return found;
end
$function$;

revoke all on function vortex_workflow.refresh_protected_workflow_run_state(uuid, text, timestamptz)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_workflow.refresh_protected_workflow_run_state(uuid, text, timestamptz)
  to vortex_runtime;
comment on function vortex_workflow.refresh_protected_workflow_run_state(uuid, text, timestamptz) is
  'Private protected workflow run refresh: caches a safe Kestra state and closes callback authority after a terminal state.';
