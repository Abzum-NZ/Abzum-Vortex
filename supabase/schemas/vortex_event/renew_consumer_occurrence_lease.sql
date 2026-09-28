create or replace function vortex_event.renew_consumer_occurrence_lease(
  p_consumer_key text,
  p_ack_cursor uuid,
  p_occurrence_id uuid,
  p_lease_seconds integer
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  nil_uuid constant uuid := '00000000-0000-0000-0000-000000000000'::uuid;
  maximum_lease_seconds constant integer := 300;
  renewal_time timestamptz := pg_catalog.statement_timestamp();
  renewed_until timestamptz;
begin
  if p_consumer_key is null
    or pg_catalog.octet_length(p_consumer_key) not between 1 and 128
    or p_consumer_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
    or p_ack_cursor is null or p_ack_cursor = nil_uuid
    or p_occurrence_id is null or p_occurrence_id = nil_uuid
    or p_lease_seconds is null
    or p_lease_seconds not between 1 and maximum_lease_seconds then
    raise exception using errcode = '22023', message = 'Event consumer lease renewal input is invalid';
  end if;

  update vortex_event.consumer_occurrence_progress
  set lease_expires_at = renewal_time + pg_catalog.make_interval(secs => p_lease_seconds)
  where consumer_key = p_consumer_key
    and occurrence_id = p_occurrence_id
    and claim_cursor = p_ack_cursor
    and acknowledged_at is null
    and terminally_failed_at is null
    and lease_expires_at > renewal_time
  returning lease_expires_at into renewed_until;

  if renewed_until is null then
    return pg_catalog.jsonb_build_object('outcome', 'claim_unavailable');
  end if;
  return pg_catalog.jsonb_build_object(
    'outcome', 'renewed',
    'leaseExpiresAt', pg_catalog.to_char(
      pg_catalog.timezone('UTC', renewed_until), 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
    )
  );
end
$function$;

alter function vortex_event.renew_consumer_occurrence_lease(text, uuid, uuid, integer) owner to vortex_event_owner;

revoke all on function vortex_event.renew_consumer_occurrence_lease(text, uuid, uuid, integer)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_adapter;

grant execute on function vortex_event.renew_consumer_occurrence_lease(text, uuid, uuid, integer)
  to vortex_runtime;

comment on function vortex_event.renew_consumer_occurrence_lease(text, uuid, uuid, integer) is
  'Renews one still-live consumer Event occurrence claim without changing immutable occurrence evidence.';
