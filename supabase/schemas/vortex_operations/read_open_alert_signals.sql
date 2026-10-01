create or replace function vortex_operations.read_open_alert_signals(
  p_limit integer default 100
)
returns table (
  signal_id uuid,
  code text,
  severity text,
  affected_service text,
  deduplication_key text,
  owning_role text,
  runbook_reference text,
  occurrence_count bigint,
  first_seen_at timestamptz,
  last_seen_at timestamptz,
  state text
)
language plpgsql
stable
security definer
set search_path = ''
as $function$
begin
  if p_limit is null or p_limit not between 1 and 500 then
    raise exception using errcode = '22023',
      message = 'Operations alert signal read is invalid';
  end if;

  return query
    select signal.signal_id, signal.code, signal.severity, signal.affected_service,
      signal.deduplication_key, signal.owning_role, signal.runbook_reference,
      signal.occurrence_count, signal.first_seen_at, signal.last_seen_at, signal.state
    from vortex_operations.alert_signals as signal
    where signal.state = 'open'
    order by signal.last_seen_at desc, signal.signal_id
    limit p_limit;
end
$function$;
revoke all on function vortex_operations.read_open_alert_signals(integer)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner, vortex_record_adapter, vortex_module_owner;

grant execute on function vortex_operations.read_open_alert_signals(integer)
  to vortex_runtime;

comment on function vortex_operations.read_open_alert_signals(integer) is
  'Returns one bounded page of open Operations alert signals, most recently seen first.';

alter function vortex_operations.read_open_alert_signals(integer)
  owner to vortex_operations_owner;
