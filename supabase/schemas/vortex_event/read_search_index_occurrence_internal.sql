create or replace function vortex_event.read_search_index_occurrence_internal(p_occurrence_id uuid, p_claim_cursor uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  source_row record;
begin
  if p_occurrence_id is null or p_occurrence_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_claim_cursor is null or p_claim_cursor = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using errcode = '22023', message = 'Search claim selector is invalid';
  end if;
  select occurrence.envelope, occurrence.organization_id, occurrence.storage_contract_id,
    occurrence.storage_scope, occurrence.sequence_application_root_id,
    occurrence.record_id, progress.lease_expires_at
  into source_row
  from vortex_event.event_outbox as occurrence
  join vortex_event.consumer_occurrence_progress as progress
    on progress.occurrence_id = occurrence.occurrence_id
  where occurrence.occurrence_id = p_occurrence_id
    and progress.consumer_key = 'search.documents'
    and progress.claim_cursor = p_claim_cursor
    and progress.acknowledged_at is null
    and progress.terminally_failed_at is null
    and progress.lease_expires_at > pg_catalog.clock_timestamp();
  if not found or source_row.storage_scope is distinct from 'application_contained'
    or source_row.sequence_application_root_id is null
    or source_row.envelope ->> 'occurrenceId' is distinct from p_occurrence_id::text
    or source_row.envelope ->> 'organizationId' is distinct from source_row.organization_id::text
    or source_row.envelope ->> 'recordId' is distinct from source_row.record_id::text
    or source_row.envelope #>> '{installation,applicationRootId}'
      is distinct from source_row.sequence_application_root_id::text then
    raise exception using errcode = '42501', message = 'Search claim is unavailable';
  end if;
  return pg_catalog.jsonb_build_object(
    'occurrence', source_row.envelope,
    'storageScope', source_row.storage_scope,
    'sourceOrganizationId', source_row.organization_id,
    'storageContractId', source_row.storage_contract_id,
    'sequenceApplicationRootId', source_row.sequence_application_root_id,
    'leaseExpiresAt', pg_catalog.to_char(pg_catalog.timezone('UTC',source_row.lease_expires_at),
      'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
  );
end
$function$;
alter function vortex_event.read_search_index_occurrence_internal(uuid,uuid) owner to vortex_event_owner;
revoke all on function vortex_event.read_search_index_occurrence_internal(uuid,uuid) from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_owner, vortex_record_adapter, vortex_module_owner, vortex_definition_owner, vortex_event_owner, vortex_search_owner, vortex_access_owner, vortex_identity_owner;
grant execute on function vortex_event.read_search_index_occurrence_internal(uuid,uuid) to vortex_access_owner, vortex_identity_owner;
comment on function vortex_event.read_search_index_occurrence_internal(uuid,uuid) is 'Owner-only fixed search.documents retained source reader; no mutable lock before Access authority, no caller actor or scope selector.';
