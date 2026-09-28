create or replace function vortex_event.list_terminally_failed_consumer_occurrences(
  p_consumer_key text,
  p_limit integer
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  maximum_limit constant integer := 100;
  results jsonb;
begin
  if p_consumer_key is null
    or pg_catalog.octet_length(p_consumer_key) not between 1 and 128
    or p_consumer_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
    or p_limit is null or p_limit not between 1 and maximum_limit then
    raise exception using errcode = '22023',
      message = 'Event delivery recovery listing input is invalid';
  end if;

  select coalesce(pg_catalog.jsonb_agg(
    pg_catalog.jsonb_build_object(
      'occurrenceId', bounded.occurrence_id,
      'attemptCount', bounded.attempt_count,
      'failureCount', bounded.failure_count,
      'lastFailureCode', bounded.last_failure_code,
      'lastFailedAt', pg_catalog.to_char(
        pg_catalog.timezone('UTC', bounded.last_failed_at), 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
      ),
      'terminallyFailedAt', pg_catalog.to_char(
        pg_catalog.timezone('UTC', bounded.terminally_failed_at), 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
      ),
      'claimedAt', pg_catalog.to_char(
        pg_catalog.timezone('UTC', bounded.claimed_at), 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
      )
    ) order by bounded.terminally_failed_at, bounded.occurrence_id
  ), '[]'::jsonb) into results
  from (
    select progress.occurrence_id, progress.attempt_count, progress.failure_count,
      progress.last_failure_code, progress.last_failed_at, progress.terminally_failed_at,
      progress.claimed_at
    from vortex_event.consumer_occurrence_progress as progress
    where progress.consumer_key = p_consumer_key
      and progress.terminally_failed_at is not null
    order by progress.terminally_failed_at, progress.occurrence_id
    limit p_limit
  ) as bounded;

  return results;
end
$function$;

alter function vortex_event.list_terminally_failed_consumer_occurrences(text, integer) owner to vortex_event_owner;

revoke all on function vortex_event.list_terminally_failed_consumer_occurrences(text, integer)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_adapter;

grant execute on function vortex_event.list_terminally_failed_consumer_occurrences(text, integer)
  to vortex_runtime;

comment on function vortex_event.list_terminally_failed_consumer_occurrences(text, integer) is
  'Bounded inspection of currently exhausted, replayable claims for one consumer.';
