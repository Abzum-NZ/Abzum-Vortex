begin;

grant usage on schema vortex_access, vortex_context
  to vortex_event_owner;

set local role vortex_module_owner;
grant usage on schema vortex_module to vortex_event_owner;
grant execute on function vortex_module.read_current_detached_installation_for_transfer_internal()
  to vortex_event_owner;
reset role;

grant execute on function vortex_access.resolve_system_actor_grant_internal(
  uuid, text, uuid, uuid, text
) to vortex_event_owner;
grant execute on function vortex_context.format_timestamp_utc(timestamptz)
  to vortex_event_owner;
grant execute on function vortex_event.append_record_occurrences_for_resolved_installation_internal(
  uuid, uuid, jsonb, jsonb
) to vortex_event_owner;

revoke all privileges on table
  vortex_event.event_outbox,
  vortex_event.consumer_occurrence_progress
from vortex_event_owner;

grant select (
  occurrence_id,
  organization_id,
  storage_contract_id,
  storage_scope,
  sequence_application_root_id,
  record_id,
  record_sequence,
  occurred_at,
  envelope
)
on table vortex_event.event_outbox to vortex_event_owner;

grant select (
  consumer_key,
  occurrence_id,
  claim_cursor,
  claimed_at,
  lease_expires_at,
  acknowledged_at,
  attempt_count,
  failure_count,
  last_failure_code,
  last_failed_at,
  terminally_failed_at,
  recovered_at,
  recovered_by,
  recovery_count
)
on table vortex_event.consumer_occurrence_progress to vortex_event_owner;

grant insert (
  consumer_key,
  occurrence_id,
  claim_cursor,
  claimed_at,
  lease_expires_at,
  attempt_count
)
on table vortex_event.consumer_occurrence_progress to vortex_event_owner;

grant update (
  claim_cursor,
  claimed_at,
  lease_expires_at,
  acknowledged_at,
  attempt_count,
  failure_count,
  last_failure_code,
  last_failed_at,
  terminally_failed_at,
  recovered_at,
  recovered_by,
  recovery_count
)
on table vortex_event.consumer_occurrence_progress to vortex_event_owner;

create policy event_outbox_event_owner_select
  on vortex_event.event_outbox
  for select to vortex_event_owner using (true);

create policy consumer_occurrence_progress_event_owner_select
  on vortex_event.consumer_occurrence_progress
  for select to vortex_event_owner using (true);
create policy consumer_occurrence_progress_event_owner_insert
  on vortex_event.consumer_occurrence_progress
  for insert to vortex_event_owner with check (true);
create policy consumer_occurrence_progress_event_owner_update
  on vortex_event.consumer_occurrence_progress
  for update to vortex_event_owner using (true) with check (true);

comment on function vortex_event.append_detached_offboarding_reassignment_internal(
  uuid, uuid, uuid, uuid
) is
  'Appends exactly one content-free record reassignment Event occurrence for a detached installation during protected offboarding.';

alter function vortex_event.acknowledge_consumer_occurrence(text, uuid, uuid)
  owner to vortex_event_owner;
alter function vortex_event.append_detached_offboarding_reassignment_internal(
  uuid, uuid, uuid, uuid
) owner to vortex_event_owner;
alter function vortex_event.append_record_occurrences(uuid, uuid, jsonb)
  owner to vortex_event_owner;
alter function vortex_event.claim_consumer_occurrences(text, integer, integer)
  owner to vortex_event_owner;
alter function vortex_event.event_dispatch_backlog_status()
  owner to vortex_event_owner;
alter function vortex_event.list_terminally_failed_consumer_occurrences(text, integer)
  owner to vortex_event_owner;
alter function vortex_event.record_consumer_occurrence_delivery_failure(
  text, uuid, uuid, text, integer, integer
) owner to vortex_event_owner;
alter function vortex_event.recover_consumer_occurrence_claim(
  text, uuid, integer, uuid
) owner to vortex_event_owner;
alter function vortex_event.renew_consumer_occurrence_lease(text, uuid, uuid, integer)
  owner to vortex_event_owner;

commit;
