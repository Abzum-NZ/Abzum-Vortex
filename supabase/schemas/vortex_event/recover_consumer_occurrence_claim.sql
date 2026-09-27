create or replace function vortex_event.recover_consumer_occurrence_claim(
  p_consumer_key text,
  p_occurrence_id uuid,
  p_expected_failure_count integer,
  p_system_actor_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  nil_uuid constant uuid := '00000000-0000-0000-0000-000000000000'::uuid;
  recovery_time timestamptz := pg_catalog.statement_timestamp();
  grant_state text;
  progress_row vortex_event.consumer_occurrence_progress%rowtype;
begin
  if p_consumer_key is null
    or pg_catalog.octet_length(p_consumer_key) not between 1 and 128
    or p_consumer_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
    or p_occurrence_id is null or p_occurrence_id = nil_uuid
    or p_expected_failure_count is null or p_expected_failure_count < 0
    or p_system_actor_id is null or p_system_actor_id = nil_uuid then
    raise exception using errcode = '22023',
      message = 'Event delivery recovery input is invalid';
  end if;

  grant_state := vortex_access.resolve_system_actor_grant_internal(
    p_system_actor_id, 'recover_consumer_occurrence_claim', null, null, p_consumer_key
  );
  if grant_state is null then
    return pg_catalog.jsonb_build_object(
      'outcome', 'unauthorised', 'reason', 'authority_not_configured'
    );
  end if;
  if grant_state <> 'active' then
    return pg_catalog.jsonb_build_object(
      'outcome', 'unauthorised', 'reason', 'authority_revoked'
    );
  end if;

  select progress.* into progress_row
  from vortex_event.consumer_occurrence_progress as progress
  where progress.consumer_key = p_consumer_key
    and progress.occurrence_id = p_occurrence_id
  for update;

  if not found then
    return pg_catalog.jsonb_build_object('outcome', 'claim_unavailable');
  end if;
  if progress_row.acknowledged_at is not null then
    return pg_catalog.jsonb_build_object('outcome', 'already_acknowledged');
  end if;
  if progress_row.terminally_failed_at is null then
    if progress_row.lease_expires_at > recovery_time then
      return pg_catalog.jsonb_build_object('outcome', 'active');
    end if;
    -- Lapsed but never exhausted: ordinary reclaim already covers it, so the
    -- privileged override is not the right path for this claim.
    return pg_catalog.jsonb_build_object('outcome', 'not_exhausted');
  end if;
  if progress_row.failure_count <> p_expected_failure_count then
    return pg_catalog.jsonb_build_object(
      'outcome', 'stale',
      'failureCount', progress_row.failure_count
    );
  end if;

  -- Clearing the terminal hold and both budgets hands the claim back to
  -- #639's ordinary reclaim for exactly this consumer and occurrence. Failure
  -- evidence and the recovery attribution stay on the row.
  update vortex_event.consumer_occurrence_progress
  set terminally_failed_at = null,
      failure_count = 0,
      attempt_count = 0,
      recovered_at = recovery_time,
      recovered_by = p_system_actor_id,
      recovery_count = recovery_count + 1,
      lease_expires_at = recovery_time
  where consumer_key = p_consumer_key and occurrence_id = p_occurrence_id;

  return pg_catalog.jsonb_build_object(
    'outcome', 'recovered',
    'recoveredBy', p_system_actor_id,
    'leaseExpiresAt', pg_catalog.to_char(
      pg_catalog.timezone('UTC', recovery_time), 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
    )
  );
end
$function$;

revoke all on function vortex_event.recover_consumer_occurrence_claim(text, uuid, integer, uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_adapter;
grant execute on function vortex_event.recover_consumer_occurrence_claim(text, uuid, integer, uuid)
  to vortex_runtime;

comment on function vortex_event.recover_consumer_occurrence_claim(text, uuid, integer, uuid) is
  'Recovery of one exhausted claim for the same consumer and occurrence identity, authorised by the system actor grant scoped to that consumer and attributed to the granted system actor.';
