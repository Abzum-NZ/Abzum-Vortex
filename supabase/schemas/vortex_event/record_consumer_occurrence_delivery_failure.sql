create or replace function vortex_event.record_consumer_occurrence_delivery_failure(
  p_consumer_key text,
  p_occurrence_id uuid,
  p_claim_cursor uuid,
  p_failure_code text,
  p_max_attempts integer,
  p_retry_backoff_seconds integer
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  nil_uuid constant uuid := '00000000-0000-0000-0000-000000000000'::uuid;
  maximum_retry_attempts constant integer := 20;
  maximum_retry_backoff_seconds constant integer := 86400;
  failure_time timestamptz := pg_catalog.statement_timestamp();
  progress_row vortex_event.consumer_occurrence_progress%rowtype;
  next_failure_count integer;
  next_lease_expires_at timestamptz;
begin
  if p_consumer_key is null
    or pg_catalog.octet_length(p_consumer_key) not between 1 and 128
    or p_consumer_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
    or p_occurrence_id is null or p_occurrence_id = nil_uuid
    or p_claim_cursor is null or p_claim_cursor = nil_uuid
    or p_failure_code is null
    or p_failure_code not in (
      'transient_dependency_unavailable', 'transient_timeout', 'validation_rejected',
      'authorization_denied', 'conflict_or_duplicate', 'unclassified'
    )
    or p_max_attempts is null or p_max_attempts not between 1 and maximum_retry_attempts
    or p_retry_backoff_seconds is null
      or p_retry_backoff_seconds not between 1 and maximum_retry_backoff_seconds then
    raise exception using errcode = '22023',
      message = 'Event delivery failure input is invalid';
  end if;

  select progress.* into progress_row
  from vortex_event.consumer_occurrence_progress as progress
  where progress.consumer_key = p_consumer_key
    and progress.occurrence_id = p_occurrence_id
  for update;

  if not found then
    return pg_catalog.jsonb_build_object('outcome', 'claim_unavailable');
  end if;
  if progress_row.claim_cursor <> p_claim_cursor then
    return pg_catalog.jsonb_build_object('outcome', 'mismatched');
  end if;
  if progress_row.acknowledged_at is not null then
    return pg_catalog.jsonb_build_object('outcome', 'already_acknowledged');
  end if;
  if progress_row.terminally_failed_at is not null then
    return pg_catalog.jsonb_build_object(
      'outcome', 'terminal_failure',
      'failureCount', progress_row.failure_count,
      'failureCode', progress_row.last_failure_code
    );
  end if;

  next_failure_count := progress_row.failure_count + 1;

  if next_failure_count >= p_max_attempts then
    update vortex_event.consumer_occurrence_progress
    set failure_count = next_failure_count,
        last_failure_code = p_failure_code,
        last_failed_at = failure_time,
        terminally_failed_at = failure_time
    where consumer_key = p_consumer_key and occurrence_id = p_occurrence_id;

    return pg_catalog.jsonb_build_object(
      'outcome', 'terminal_failure',
      'failureCount', next_failure_count,
      'failureCode', p_failure_code
    );
  end if;

  -- Releasing the lease at the backoff instant is what schedules the retry:
  -- #639's claim reclaims exactly this consumer/occurrence row once the lease
  -- has lapsed, so no fresh work is claimed and no ordering is skipped.
  next_lease_expires_at := failure_time + pg_catalog.make_interval(secs => p_retry_backoff_seconds);
  update vortex_event.consumer_occurrence_progress
  set failure_count = next_failure_count,
      last_failure_code = p_failure_code,
      last_failed_at = failure_time,
      lease_expires_at = next_lease_expires_at
  where consumer_key = p_consumer_key and occurrence_id = p_occurrence_id;

  return pg_catalog.jsonb_build_object(
    'outcome', 'retry_scheduled',
    'failureCount', next_failure_count,
    'retryNotBefore', pg_catalog.to_char(
      pg_catalog.timezone('UTC', next_lease_expires_at), 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
    )
  );
end
$function$;

alter function vortex_event.record_consumer_occurrence_delivery_failure(text, uuid, uuid, text, integer, integer) owner to vortex_event_owner;

revoke all on function vortex_event.record_consumer_occurrence_delivery_failure(
  text, uuid, uuid, text, integer, integer
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_adapter;

grant execute on function vortex_event.record_consumer_occurrence_delivery_failure(
  text, uuid, uuid, text, integer, integer
) to vortex_runtime;

comment on function vortex_event.record_consumer_occurrence_delivery_failure(
  text, uuid, uuid, text, integer, integer
) is
  'Records one failed delivery attempt against an existing claim, scheduling a bounded retry or marking it terminally failed.';
