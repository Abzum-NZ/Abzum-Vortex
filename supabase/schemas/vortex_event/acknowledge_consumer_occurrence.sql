create or replace function vortex_event.acknowledge_consumer_occurrence(
  p_consumer_key text,
  p_ack_cursor uuid,
  p_occurrence_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  nil_uuid constant uuid := '00000000-0000-0000-0000-000000000000'::uuid;
  acknowledgement_time timestamptz := pg_catalog.statement_timestamp();
  already_acknowledged timestamptz;
begin
  if p_consumer_key is null
    or pg_catalog.octet_length(p_consumer_key) not between 1 and 128
    or p_consumer_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
    or p_ack_cursor is null or p_ack_cursor = nil_uuid
    or p_occurrence_id is null or p_occurrence_id = nil_uuid then
    raise exception using errcode = '22023', message = 'Event consumer acknowledgement input is invalid';
  end if;

  update vortex_event.consumer_occurrence_progress
  set acknowledged_at = acknowledgement_time
  where consumer_key = p_consumer_key
    and occurrence_id = p_occurrence_id
    and claim_cursor = p_ack_cursor
    and acknowledged_at is null
    and terminally_failed_at is null
    and lease_expires_at > acknowledgement_time;
  if found then
    return pg_catalog.jsonb_build_object('outcome', 'acknowledged');
  end if;

  select progress.acknowledged_at into already_acknowledged
  from vortex_event.consumer_occurrence_progress as progress
  where progress.consumer_key = p_consumer_key
    and progress.occurrence_id = p_occurrence_id
    and progress.claim_cursor = p_ack_cursor
  for update;
  if already_acknowledged is not null then
    return pg_catalog.jsonb_build_object('outcome', 'already_acknowledged');
  end if;
  return pg_catalog.jsonb_build_object('outcome', 'claim_unavailable');
end
$function$;

alter function vortex_event.acknowledge_consumer_occurrence(text, uuid, uuid) owner to vortex_event_owner;

revoke all on function vortex_event.acknowledge_consumer_occurrence(text, uuid, uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_adapter;

grant execute on function vortex_event.acknowledge_consumer_occurrence(text, uuid, uuid)
  to vortex_runtime;

comment on function vortex_event.acknowledge_consumer_occurrence(text, uuid, uuid) is
  'Completes one live consumer Event occurrence claim; repeated acknowledgement with the same cursor is safe.';
