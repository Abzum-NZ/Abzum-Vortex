create or replace function vortex_platform.event_dispatch_backlog_status()
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  -- Matches the window refuse_event_outbox_change allows retention to delete after.
  retention_window constant interval := interval '30 days';
  maximum_trim constant integer := 500;
  trimmed uuid[];
  result jsonb;
begin
  -- Retention runs once per dispatcher wake-up, before the status read. An occurrence goes once
  -- it is older than the window, every consumer that claimed it acknowledged it (a terminally
  -- failed claim stays as operator evidence), and a later occurrence of the same record or
  -- installation exists, so the newest one keeps that subject's sequence. The batch is bounded
  -- and skips rows a concurrent claim holds; the rest goes on later wake-ups.
  select coalesce(pg_catalog.array_agg(candidate.occurrence_id), array[]::uuid[])
  into trimmed
  from (
    select occurrence.occurrence_id
    from vortex_platform.event_outbox as occurrence
    where occurrence.occurred_at < pg_catalog.statement_timestamp() - retention_window
      and exists (
        select 1 from vortex_platform.consumer_occurrence_progress as progress
        where progress.occurrence_id = occurrence.occurrence_id
      )
      and not exists (
        select 1 from vortex_platform.consumer_occurrence_progress as progress
        where progress.occurrence_id = occurrence.occurrence_id
          and progress.acknowledged_at is null
      )
      and exists (
        select 1 from vortex_platform.event_outbox as newer
        where newer.organization_id = occurrence.organization_id
          and newer.occurrence_kind = occurrence.occurrence_kind
          and newer.storage_contract_id is not distinct from occurrence.storage_contract_id
          and newer.sequence_application_root_id is not distinct from
            occurrence.sequence_application_root_id
          and newer.record_id is not distinct from occurrence.record_id
          and newer.record_sequence > occurrence.record_sequence
      )
    order by occurrence.occurred_at, occurrence.occurrence_id
    limit maximum_trim
    for update of occurrence skip locked
  ) as candidate;

  if pg_catalog.cardinality(trimmed) > 0 then
    delete from vortex_platform.consumer_occurrence_progress as progress
    where progress.occurrence_id = any (trimmed);
    delete from vortex_platform.event_outbox as occurrence
    where occurrence.occurrence_id = any (trimmed);
  end if;

  with pending as (
    select pg_catalog.min(occurrence.occurred_at) as oldest_occurred_at
    from vortex_platform.consumer_occurrence_progress as progress
    join vortex_platform.event_outbox as occurrence
      on occurrence.occurrence_id = progress.occurrence_id
    where progress.acknowledged_at is null
      and progress.terminally_failed_at is null
  ), failed as (
    select pg_catalog.count(*) as failure_count
    from (
      select 1
      from vortex_platform.consumer_occurrence_progress as progress
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
  into result
  from pending, failed;
  return result;
end
$function$;

alter function vortex_platform.event_dispatch_backlog_status() owner to vortex_owner;

revoke all on function vortex_platform.event_dispatch_backlog_status()
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;

grant execute on function vortex_platform.event_dispatch_backlog_status() to vortex_runtime;

comment on function vortex_platform.event_dispatch_backlog_status() is
  'Called once per dispatcher wake-up: first deletes a bounded batch of delivered Event occurrences older than 30 days (every claim acknowledged, a later occurrence of the same subject kept), then returns the bounded, content-free delivery backlog: age in seconds of the oldest claimed occurrence not yet acknowledged or terminally failed, and the terminal failure count. Reveals no occurrence identity, consumer identity or payload.';
