create or replace function vortex_file.record_file_upload_outcome(
  p_file_id uuid,
  p_expected_revision bigint,
  p_detected_media_type text,
  p_size_bytes bigint,
  p_checksum text,
  p_scanner_name text,
  p_scanner_version text,
  p_scanner_result text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  evaluated_at timestamptz := pg_catalog.statement_timestamp();
  established jsonb := vortex_file.upload_validated_context();
  request_actor jsonb := vortex_file.upload_request_actor(established);
  reservation vortex_file.upload_reservations%rowtype;
  uploaded vortex_file.file_records%rowtype;
begin
  select stored.* into reservation
  from vortex_file.upload_reservations as stored
  where stored.file_id = p_file_id
    and stored.organization_id = (established ->> 'organizationId')::uuid
  for update;
  if not found then
    return vortex_file.upload_refusal('file_not_found');
  end if;
  if request_actor is null or reservation.uploaded_by is distinct from request_actor then
    return vortex_file.upload_refusal('caller_not_authorized');
  end if;

  select stored.* into strict uploaded
  from vortex_file.file_records as stored
  where stored.file_id = p_file_id
  for update;
  if uploaded.lifecycle_state <> 'pending' then
    return vortex_file.upload_refusal('invalid_lifecycle_state');
  end if;
  if reservation.upload_expires_at <= evaluated_at then
    return vortex_file.upload_refusal('upload_expired');
  end if;
  if reservation.revision is distinct from p_expected_revision then
    return vortex_file.upload_refusal('revision_conflict');
  end if;

  -- Bytes beyond the admitted reservation are never accepted as clean.
  if p_scanner_result is null
    or p_scanner_result not in ('clean', 'quarantined', 'refused')
    or p_size_bytes is null or p_size_bytes < 0
    or (p_scanner_result = 'clean' and p_size_bytes > reservation.maximum_bytes)
    or p_scanner_name is null
    or p_scanner_version is null then
    raise exception using errcode = '22023', message = 'File upload outcome is invalid';
  end if;

  update vortex_file.file_records
  set
    detected_media_type = p_detected_media_type,
    size_bytes = p_size_bytes,
    checksum = p_checksum,
    scanner_name = p_scanner_name,
    scanner_version = p_scanner_version,
    scanner_result = p_scanner_result,
    lifecycle_state = case when p_scanner_result = 'clean' then 'scanning' else 'quarantined' end
  where file_id = p_file_id
  returning * into uploaded;

  update vortex_file.upload_grants
  set superseded_at = evaluated_at
  where file_id = p_file_id
    and superseded_at is null;

  update vortex_file.upload_reservations
  set revision = revision + 1, updated_at = evaluated_at
  where file_id = p_file_id;

  return pg_catalog.jsonb_build_object(
    'outcome', 'recorded',
    'fileRecord', vortex_file.upload_file_record(uploaded)
  );
end
$function$;

comment on function vortex_file.record_file_upload_outcome(
  uuid, bigint, text, bigint, text, text, text, text
) is
  'Records trusted inspection and the safety result of a pending upload, leaving it scanning or quarantined.';

revoke execute on function
  vortex_file.record_file_upload_outcome(uuid, bigint, text, bigint, text, text, text, text) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_record_adapter, vortex_module_owner;

grant execute on function
  vortex_file.record_file_upload_outcome(uuid, bigint, text, bigint, text, text, text, text) to vortex_request;

alter function vortex_file.record_file_upload_outcome(
  uuid, bigint, text, bigint, text, text, text, text
) owner to vortex_file_owner;
