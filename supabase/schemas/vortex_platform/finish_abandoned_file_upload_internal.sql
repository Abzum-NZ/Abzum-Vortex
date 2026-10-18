create or replace function vortex_platform.finish_abandoned_file_upload_internal(p_file_id uuid, p_claim_id uuid)
returns boolean language plpgsql volatile security definer set search_path = ''
as $function$
declare
  file_value vortex_platform.file_records%rowtype;
begin
  select * into file_value from vortex_platform.file_records where file_id = p_file_id for update;
  if not found or file_value.lifecycle_state <> 'abandoned' or file_value.activated_at is not null
    or pg_catalog.cardinality(file_value.owning_attachment_references) <> 0
    or file_value.preview_references <> '[]'::jsonb or file_value.legal_hold then return false; end if;
  -- The caller reaches this boundary only after the exact-object Storage API delete succeeds.
  delete from vortex_platform.file_uploads where file_id = p_file_id and cleanup_claim_id = p_claim_id;
  if not found then return false; end if;
  update vortex_platform.file_records set lifecycle_state = 'removed', removed_at = pg_catalog.clock_timestamp()
  where file_id = p_file_id;
  return true;
end
$function$;
alter function vortex_platform.finish_abandoned_file_upload_internal(uuid,uuid) owner to vortex_owner;
revoke all on function vortex_platform.finish_abandoned_file_upload_internal(uuid,uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;
grant execute on function vortex_platform.finish_abandoned_file_upload_internal(uuid,uuid) to vortex_runtime;
comment on function vortex_platform.finish_abandoned_file_upload_internal(uuid,uuid) is
  'Finalizes only the matching abandoned-upload cleanup claim after confirmed Storage deletion; leaves terminal file metadata and removes upload state.';
