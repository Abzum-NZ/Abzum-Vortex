create or replace function vortex_event.event_dispatch_backlog_status()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $function$
  with pending as (
    select pg_catalog.min(occurrence.occurred_at) as oldest_occurred_at
    from vortex_event.consumer_occurrence_progress as progress
    join vortex_event.event_outbox as occurrence
      on occurrence.occurrence_id = progress.occurrence_id
    where progress.acknowledged_at is null
      and progress.terminally_failed_at is null
  ), failed as (
    select pg_catalog.count(*) as failure_count
    from (
      select 1
      from vortex_event.consumer_occurrence_progress as progress
      where progress.terminally_failed_at is not null
      limit 1000000
    ) as bounded
  )
  select pg_catalog.jsonb_build_object(
    'oldestPendingAgeSeconds',
      case
        when pending.oldest_occurred_at is null then null
        else least(
          2592000,
          greatest(
            0,
            -- EXTRACT is SQL syntax, not a schema-qualifiable call; it always
            -- resolves from pg_catalog even under the empty search_path.
            pg_catalog.floor(
              extract(
                epoch from (pg_catalog.statement_timestamp() - pending.oldest_occurred_at)
              )
            )
          )
        )::integer
      end,
    'terminalFailureCount', failed.failure_count::integer
  )
  from pending, failed;
$function$;

alter function vortex_event.event_dispatch_backlog_status() owner to vortex_event_owner;

revoke all on function vortex_event.event_dispatch_backlog_status()
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_adapter;

grant execute on function vortex_event.event_dispatch_backlog_status() to vortex_runtime;

comment on function vortex_event.event_dispatch_backlog_status() is
  'Bounded, content-free event delivery backlog: age in seconds of the oldest claimed occurrence not yet acknowledged or terminally failed, and the terminal failure count. Reveals no occurrence identity, consumer identity or payload.';
