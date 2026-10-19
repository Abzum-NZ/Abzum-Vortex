create or replace function vortex_platform.enqueue_installation_backfill_internal(
  p_organization_id uuid, p_application_root_id uuid, p_release_revision bigint
)
returns void
language plpgsql volatile security definer set search_path = ''
as $function$
declare
  occurrence_id_value uuid := pg_catalog.gen_random_uuid();
  occurred_at_value timestamptz := pg_catalog.statement_timestamp();
begin
  -- Called only by the atomic activation writer, never by a request role. The unique
  -- installation release key makes a repeated activation a no-op, including after a retry.
  insert into vortex_platform.event_outbox (
    occurrence_id, organization_id, sequence_application_root_id,
    record_sequence, occurred_at, occurrence_kind, envelope
  ) values (
    occurrence_id_value, p_organization_id, p_application_root_id,
    p_release_revision, occurred_at_value, 'installation_activated',
    pg_catalog.jsonb_build_object(
      'kind', 'installation_activated', 'occurrenceId', occurrence_id_value,
      'organizationId', p_organization_id, 'applicationRootId', p_application_root_id,
      'applicationReleaseRevision', p_release_revision,
      'occurredAt', pg_catalog.to_char(pg_catalog.timezone('UTC', occurred_at_value),
        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
    )
  ) on conflict do nothing;
end
$function$;
alter function vortex_platform.enqueue_installation_backfill_internal(uuid, uuid, bigint) owner to vortex_owner;
revoke all on function vortex_platform.enqueue_installation_backfill_internal(uuid, uuid, bigint)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;
grant execute on function vortex_platform.enqueue_installation_backfill_internal(uuid, uuid, bigint)
  to vortex_owner, postgres;
