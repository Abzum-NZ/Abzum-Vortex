create or replace function vortex_file.read_file_upload(p_file_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  established jsonb := vortex_file.upload_validated_context();
  reservation vortex_file.upload_reservations%rowtype;
  uploaded vortex_file.file_records%rowtype;
  current_grant_id uuid;
begin
  select stored.* into reservation
  from vortex_file.upload_reservations as stored
  where stored.file_id = p_file_id
    and stored.organization_id = (established ->> 'organizationId')::uuid;
  if not found then
    return null;
  end if;

  select stored.* into strict uploaded
  from vortex_file.file_records as stored
  where stored.file_id = p_file_id;

  select current_grant.one_time_id into current_grant_id
  from vortex_file.upload_grants as current_grant
  where current_grant.file_id = p_file_id
    and current_grant.superseded_at is null;

  return pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
    'fileRecord', vortex_file.upload_file_record(uploaded),
    'uploader', reservation.uploaded_by,
    'maximumBytes', reservation.maximum_bytes,
    'uploadExpiresAt', vortex_context.format_timestamp_utc(reservation.upload_expires_at),
    'replacingFileId', reservation.replacing_file_id,
    'currentGrantId', current_grant_id,
    'correlationId', reservation.correlation_id,
    'revision', reservation.revision
  ));
end
$function$;

revoke execute on function vortex_file.read_file_upload(uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner, vortex_record_adapter, vortex_module_owner;
grant execute on function vortex_file.read_file_upload(uuid) to vortex_request;

comment on function vortex_file.read_file_upload(uuid) is
  'Reads one upload of the request organisation with its current grant and revision.';
