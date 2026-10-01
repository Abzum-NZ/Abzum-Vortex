create or replace function vortex_operations.record_alert_signal(
  p_code text,
  p_severity text,
  p_affected_service text,
  p_deduplication_key text,
  p_owning_role text,
  p_runbook_reference text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  observed_at timestamptz := pg_catalog.clock_timestamp();
  stored vortex_operations.alert_signals%rowtype;
begin
  if p_code is null or not vortex_operations.alert_signal_namespaced_key_is_valid(p_code)
    or p_severity is null
    or p_severity not in ('warning', 'error', 'critical')
    or p_affected_service is null
    or not vortex_operations.alert_signal_builder_key_is_valid(p_affected_service)
    or p_deduplication_key is null
    or pg_catalog.length(p_deduplication_key) not between 16 and 200
    or p_deduplication_key !~ '^[a-z0-9][a-z0-9._:-]*$'
    or p_owning_role is null
    or not vortex_operations.alert_signal_builder_key_is_valid(p_owning_role)
    or p_runbook_reference is null
    or not vortex_operations.alert_signal_namespaced_key_is_valid(p_runbook_reference) then
    raise exception using errcode = '22023',
      message = 'Operations alert signal is invalid';
  end if;

  insert into vortex_operations.alert_signals (
    signal_id, code, severity, affected_service, deduplication_key,
    owning_role, runbook_reference, occurrence_count, first_seen_at, last_seen_at, state
  ) values (
    pg_catalog.gen_random_uuid(), p_code, p_severity, p_affected_service,
    p_deduplication_key, p_owning_role, p_runbook_reference, 1, observed_at, observed_at,
    'open'
  )
  on conflict (deduplication_key) do update set
    code = excluded.code,
    severity = excluded.severity,
    affected_service = excluded.affected_service,
    owning_role = excluded.owning_role,
    runbook_reference = excluded.runbook_reference,
    occurrence_count = least(
      vortex_operations.alert_signals.occurrence_count + 1, 9007199254740991
    ),
    last_seen_at = greatest(
      vortex_operations.alert_signals.last_seen_at, excluded.last_seen_at
    ),
    state = 'open'
  returning * into stored;

  return pg_catalog.jsonb_build_object(
    'signalId', stored.signal_id,
    'code', stored.code,
    'severity', stored.severity,
    'affectedService', stored.affected_service,
    'deduplicationKey', stored.deduplication_key,
    'owningRole', stored.owning_role,
    'runbookReference', stored.runbook_reference,
    'occurrenceCount', stored.occurrence_count,
    'firstSeenAt', pg_catalog.to_char(stored.first_seen_at at time zone 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'lastSeenAt', pg_catalog.to_char(stored.last_seen_at at time zone 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'state', stored.state
  );
end
$function$;
revoke all on function vortex_operations.record_alert_signal(
  text, text, text, text, text, text
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_record_adapter, vortex_module_owner;

grant execute on function vortex_operations.record_alert_signal(
  text, text, text, text, text, text
) to vortex_runtime;

comment on function vortex_operations.record_alert_signal(
  text, text, text, text, text, text
) is
  'Validates one contract alert record and upserts it by deduplication key, incrementing the occurrence count, refreshing last-seen and reopening a resolved signal.';

alter function vortex_operations.record_alert_signal(text, text, text, text, text, text)
  owner to vortex_operations_owner;
