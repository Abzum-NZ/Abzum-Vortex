create or replace function vortex_event.validate_search_index_claim_internal(p_occurrence_id uuid, p_claim_cursor uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  claim_row record;
begin
  if p_occurrence_id is null or p_occurrence_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_claim_cursor is null or p_claim_cursor = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using errcode = '22023', message = 'Search claim selector is invalid';
  end if;
  select progress.claim_cursor, progress.acknowledged_at, progress.terminally_failed_at,
    progress.lease_expires_at into claim_row
  from vortex_event.consumer_occurrence_progress as progress
  where progress.consumer_key = 'search.documents' and progress.occurrence_id = p_occurrence_id
  for update of progress;
  if not found or claim_row.claim_cursor is distinct from p_claim_cursor
    or claim_row.acknowledged_at is not null or claim_row.terminally_failed_at is not null
    or claim_row.lease_expires_at <= pg_catalog.clock_timestamp() then
    raise exception using errcode = '42501', message = 'Search claim is unavailable';
  end if;
  return vortex_event.read_search_index_occurrence_internal(p_occurrence_id,p_claim_cursor);
end
$function$;
alter function vortex_event.validate_search_index_claim_internal(uuid,uuid) owner to vortex_event_owner;
revoke all on function vortex_event.validate_search_index_claim_internal(uuid,uuid) from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_owner, vortex_record_adapter, vortex_module_owner, vortex_definition_owner, vortex_event_owner, vortex_search_owner, vortex_access_owner, vortex_identity_owner;
grant execute on function vortex_event.validate_search_index_claim_internal(uuid,uuid) to vortex_access_owner;
comment on function vortex_event.validate_search_index_claim_internal(uuid,uuid) is 'Owner-only fixed search.documents live claim check and progress lock using the retained cursor and current database time.';
